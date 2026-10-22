"""Carrying out approved actions, and closing the requests that asked for them.

An approval in NerdBot used to be a record: the owner said yes, the row
flipped, and the run that had asked had long since ended. The owner's answer
changed nothing about the work.

This module makes the answer do the work. A gated tool call writes the exact
action on the approval row — which tool, which arguments, which bot asked, on
which run and task — and the owner's decision carries that action out.

TWO THINGS ARE NOT REPLAYED, and both are deliberate:

* **The model's conversation.** The provider adapter does not keep it: the
  message list is local to the run and the transcript keeps only the text,
  not the tool calls. Reconstructing it would mean re-posting the whole
  conversation to the provider, which costs a call, can land differently,
  and would let the model issue MORE privileged work than the owner
  approved. So the owner's approval covers exactly what the owner
  approved.

* **The side effects that already happened.** They are not repeated: the
  run stops at the gated call, and the resume replays only that call.

Exactly-once: a checkpoint is marked as being carried out BEFORE the action
runs, so a crash cannot repeat it. For a privileged action that is the right
way round — at-most-once on crash, exactly-once on the normal path.
"""

from __future__ import annotations

import json
import sqlite3
from dataclasses import dataclass, field
from typing import Any

from . import agent_context as agent_context_mod
from . import app_tools, gates, store
from .models import Approval, Decision, RunStatus, TaskStatus


@dataclass
class ResumeOutcome:
    """What happened when a run's approved actions were carried out."""

    run_id: str = ""
    task_id: str = ""
    #: ``carried_out`` — every approved action ran. ``waiting`` — some
    #: request is still undecided. ``refused`` — an action could not be
    #: performed. ``skipped`` — there was nothing to carry out.
    outcome: str = "skipped"
    output: str = ""
    run_status: str = ""
    task_status: str = ""
    #: The checkpoints that were carried out.
    performed: list[str] = field(default_factory=list)


def _parse_arguments(raw: str) -> dict[str, Any] | None:
    if not raw:
        return None
    try:
        parsed = json.loads(raw)
    except ValueError:
        return None
    return parsed if isinstance(parsed, dict) else None


def _execute_checkpoint(
    conn: sqlite3.Connection,
    approval: Approval,
    data_dir: str,
) -> tuple[str, str]:
    """Carry out one approved action. Returns (outcome, text).

    ``outcome`` is ``carried_out``, ``refused`` or ``waiting``.
    """
    arguments = _parse_arguments(approval.tool_arguments)
    if arguments is None:
        return "refused", "the checkpointed action could not be read; it was not performed"

    mate = store.get_teammate(conn, approval.teammate_id) if approval.teammate_id else None
    if mate is None:
        return "refused", "the bot that asked for this approval is gone; it was not performed"

    task = store.get_task(conn, approval.task_id) if approval.task_id else None
    if task is None:
        return "refused", "the work that asked for this approval is gone"

    ctx = agent_context_mod.build(conn, task, mate)
    ctx.data_dir = data_dir
    ctx.run_id = approval.run_id
    ctx.teammate = mate

    # The checkpoint is marked BEFORE the action runs: a crash between here
    # and the action must not let the action be attempted twice.
    store.mark_approval_resumed(conn, approval.id)

    try:
        result = app_tools.execute_app_tool(
            ctx,
            approval.tool_name,
            arguments,
            data_dir=data_dir,
            run_id=approval.run_id,
            workspace_path=task.workspace_path or None,
            raise_on_denial=True,
        )
    except gates.GateDenied as exc:
        return "refused", f"the approved action was refused: {exc}"
    except Exception as exc:  # explicit failure, never silent success
        return "refused", f"the approved action failed: {type(exc).__name__}: {exc}"

    if ctx.pending_approvals:
        # The action is still gated: a second permission is missing. The
        # request that was just approved is one of several, so the run waits
        # again and the new request is what the owner sees next.
        return "waiting", _waiting_text(ctx.pending_approvals)
    return "carried_out", result


def _waiting_text(approvals: list[Approval]) -> str:
    action = approvals[0].action if approvals else "an action"
    return f"waiting for your approval of {action}"


def resume_run(
    conn: sqlite3.Connection,
    run_id: str,
    data_dir: str = ".",
) -> ResumeOutcome:
    """Carry out the approved actions of a waiting run, then settle the run.

    Every approved checkpoint of the run is carried out — a turn can ask for
    several privileged actions, and the owner answers them one by one, so the
    run finishes when the last one is done. A checkpoint that is still
    undecided keeps the run waiting; one that was refused fails it.
    """
    outcome = ResumeOutcome(run_id=run_id)
    run = store.get_run(conn, run_id)
    if run is None:
        outcome.output = "the run is gone"
        return outcome
    task = store.get_task(conn, run.task_id)
    if task is None:
        outcome.output = "the work is gone"
        return outcome
    outcome.task_id = task.id

    if not store.claim_run_for_resume(conn, run_id):
        # Another resume owns it, or it is no longer waiting. Either way this
        # one must not act: the action is carried out exactly once.
        outcome.output = "this run is no longer waiting for a decision"
        outcome.run_status = run.status.value
        return outcome

    checkpoints = store.list_run_checkpoints(conn, run_id)
    approved = [
        c
        for c in checkpoints
        if c.decision in (Decision.APPROVED, Decision.APPROVED_FOREVER)
        and c.resumed_at is None
    ]
    performed: list[str] = []
    outputs: list[str] = []
    failures: list[str] = []

    for checkpoint in approved:
        state, text = _execute_checkpoint(conn, checkpoint, data_dir)
        if state == "carried_out":
            performed.append(checkpoint.id)
            outputs.append(text)
        elif state == "waiting":
            continue
        else:
            failures.append(text)

    # What is still outstanding: a request nobody has answered yet.
    still_pending = [
        c for c in checkpoints if c.decision == Decision.PENDING and c.resumed_at is None
    ]

    if still_pending:
        reason = _waiting_text(still_pending)
        store.mark_run_awaiting_approval(conn, run_id, reason)
        store.set_task_status(conn, task.id, TaskStatus.AWAITING_APPROVAL, reason)
        outcome.outcome = "waiting"
        outcome.output = reason
        outcome.run_status = RunStatus.AWAITING_APPROVAL.value
        outcome.task_status = TaskStatus.AWAITING_APPROVAL.value
        outcome.performed = performed
        return outcome

    if failures:
        note = failures[0]
        store.finish_run(conn, run_id, RunStatus.FAILED, None, note)
        store.set_task_status(conn, task.id, TaskStatus.BLOCKED, note)
        outcome.outcome = "refused"
        outcome.output = note
        outcome.run_status = RunStatus.FAILED.value
        outcome.task_status = TaskStatus.BLOCKED.value
        outcome.performed = performed
        return outcome

    summary = "; ".join(outputs) or "the approved action"
    store.finish_run(conn, run_id, RunStatus.SUCCEEDED, 0, summary, stdout=summary)
    store.set_task_status(conn, task.id, TaskStatus.DONE)
    outcome.outcome = "carried_out"
    outcome.output = summary
    outcome.run_status = RunStatus.SUCCEEDED.value
    outcome.task_status = TaskStatus.DONE.value
    outcome.performed = performed
    return outcome


def close_rejected_action(
    conn: sqlite3.Connection, approval: Approval
) -> ResumeOutcome:
    """Close the work that asked for an approval the owner refused.

    The action is NOT performed. The run fails with the refusal as its
    reason, and the task is blocked — recoverable, because the owner can
    retry it.
    """
    outcome = ResumeOutcome(run_id=approval.run_id or "")
    if not approval.tool_name:
        return outcome
    run = store.get_run(conn, approval.run_id) if approval.run_id else None
    task = store.get_task(conn, approval.task_id) if approval.task_id else None
    if task is None and run is not None:
        task = store.get_task(conn, run.task_id)
    if run is None or task is None:
        return outcome
    outcome.task_id = task.id
    if run.status in store.TERMINAL_RUN_STATUSES:
        return outcome
    note = f"the request was refused by the owner ({approval.action}); it was not performed"
    store.finish_run(conn, run.id, RunStatus.FAILED, None, note)
    store.set_task_status(conn, task.id, TaskStatus.BLOCKED, note)
    outcome.outcome = "refused"
    outcome.output = note
    outcome.run_status = RunStatus.FAILED.value
    outcome.task_status = TaskStatus.BLOCKED.value
    return outcome


def expire_waiting_action(
    conn: sqlite3.Connection, approval: Approval
) -> ResumeOutcome:
    """Close the work whose request expired unanswered.

    The action is NOT performed — nobody decided it. The run fails with the
    expiry as its reason, and the task is blocked, so the owner can re-ask
    by retrying the task.
    """
    outcome = ResumeOutcome(run_id=approval.run_id or "")
    if not approval.tool_name:
        return outcome
    run = store.get_run(conn, approval.run_id) if approval.run_id else None
    task = store.get_task(conn, approval.task_id) if approval.task_id else None
    if task is None and run is not None:
        task = store.get_task(conn, run.task_id)
    if run is None or task is None:
        return outcome
    outcome.task_id = task.id
    if run.status in store.TERMINAL_RUN_STATUSES:
        return outcome
    note = (
        f"the request for {approval.tool_name!r} expired unanswered"
        " — it was not performed; retry the task to ask again"
    )
    store.finish_run(conn, run.id, RunStatus.FAILED, None, note)
    store.set_task_status(conn, task.id, TaskStatus.BLOCKED, note)
    outcome.outcome = "expired"
    outcome.output = note
    outcome.run_status = RunStatus.FAILED.value
    outcome.task_status = TaskStatus.BLOCKED.value
    return outcome
