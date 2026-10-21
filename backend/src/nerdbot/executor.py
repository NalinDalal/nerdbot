"""Autonomous executor: claims pending tasks to available bots and runs them.

A sweep claims each pending, unowned task to an active teammate in the same
project who has a model provider attached and is not already busy, then
executes it through the orchestrator (isolated workspace, bounded tool loop).

NerdBot itself never loops by default: a sweep runs once when invoked via the
CLI (`nerdbot executor-sweep`) or the HTTP endpoint (`POST /executor/sweep`).
Set ``NERDBOT_EXECUTOR=1`` to run sweeps continuously in the API process.
"""

from __future__ import annotations

import os
import sqlite3
from typing import Any

from . import orchestrator, store
from . import providers as providers_mod
from .models import TaskStatus, Teammate, TeammateStatus

DEFAULT_INTERVAL_S = 10.0
DEFAULT_TIMEOUT_S = 60.0
DEFAULT_MAX_TASKS = 10


def _busy_bot_ids(conn: sqlite3.Connection) -> set[str]:
    """Teammate ids that already own a running or ready (claimed, not executed) task."""
    rows = conn.execute(
        "SELECT DISTINCT owner_teammate_id FROM tasks"
        " WHERE owner_teammate_id IS NOT NULL"
        " AND status IN (?, ?)",
        (TaskStatus.RUNNING.value, TaskStatus.READY.value),
    ).fetchall()
    return {row["owner_teammate_id"] for row in rows}


def _available_bot(
    conn: sqlite3.Connection,
    project_id: str,
    busy: set[str],
) -> Teammate | None:
    """An active teammate with a provider that can serve, in the project, not busy.

    A provider with no working key cannot serve, so a bot holding one is not
    available: claiming work for it would run the task straight into a
    block. The task stays pending until the key is configured.
    """
    for mate in store.list_all_teammates(conn):
        if mate.project_id != project_id:
            continue
        if mate.status != TeammateStatus.ACTIVE:
            continue
        if mate.provider_id is None:
            continue
        provider = store.get_provider(conn, mate.provider_id)
        if providers_mod.provider_block_reason(provider) is not None:
            continue
        if mate.id in busy:
            continue
        return mate
    return None


def _provider_block_reason(conn: sqlite3.Connection, project_id: str) -> str | None:
    """The reason the project cannot be worked on, when a provider is the blocker.

    A sweep that skips a task because the model key is missing has to say so.
    Otherwise the task simply stays pending and the owner sees nothing.
    """
    for mate in store.list_all_teammates(conn):
        if mate.project_id != project_id:
            continue
        if mate.status != TeammateStatus.ACTIVE:
            continue
        if mate.provider_id is None:
            continue
        reason = providers_mod.provider_block_reason(store.get_provider(conn, mate.provider_id))
        if reason is not None:
            return reason
    return None


def _run_timeout_s(override: float | None = None) -> float:
    """Run wall-clock budget: the sweep argument, else NERDBOT_RUN_TIMEOUT_S,
    else 60s. Shares the knob with POST /tasks/{id}/runs so a slow provider
    (e.g. a local model) gets the bigger budget on every execution path."""
    if override is not None:
        return override
    raw = os.environ.get("NERDBOT_RUN_TIMEOUT_S", "60")
    try:
        value = float(raw)
    except ValueError as exc:
        raise ValueError("NERDBOT_RUN_TIMEOUT_S must be a number of seconds") from exc
    if value <= 0:
        raise ValueError("NERDBOT_RUN_TIMEOUT_S must be positive")
    return value


def sweep(
    conn: sqlite3.Connection,
    data_dir: str = ".nerdbot-data",
    timeout_s: float | None = None,
    max_tasks: int = DEFAULT_MAX_TASKS,
) -> list[dict[str, Any]]:
    """Claim pending unowned tasks to available bots and run them.

    Processes at most ``max_tasks`` tasks per sweep, oldest first. Returns one
    summary dict per task processed. Tasks with no available bot in their
    project are left pending and skipped.

    Dependency-aware: a task whose dependencies are not yet done is left
    pending (never claimed and blocked prematurely); it becomes claimable on a
    later sweep once its dependencies finish. Tasks that were already blocked
    while waiting for dependencies are re-queued when those dependencies
    complete. Only unowned, parent-less tasks are re-queued: a delegation
    child that its delegatee declined stays blocked.
    """
    requeued = store.requeue_unblocked_tasks(conn)
    requeue_notes = [
        {
            "task_id": task.id,
            "bot_id": None,
            "status": "requeued",
            "reason": "dependencies satisfied",
        }
        for task in requeued
    ]
    results: list[dict[str, Any]] = []
    pending = store.list_pending_unowned_tasks(conn)
    busy = _busy_bot_ids(conn)
    claimed_this_sweep: set[str] = set()
    done_ids = {
        row["id"]
        for row in conn.execute("SELECT id FROM tasks WHERE status = ?", (TaskStatus.DONE.value,))
        .fetchall()
    }

    for task in pending:
        if len(results) >= max_tasks:
            break
        if task.project_id == "":
            continue
        if any(dep not in done_ids for dep in task.dependencies):
            continue  # not yet executable; stays pending for a later sweep
        bot = _available_bot(conn, task.project_id, busy | claimed_this_sweep)
        if bot is None:
            # Say why the task was skipped when the blocker is a missing or
            # unusable model key. The task stays pending, not blocked.
            reason = _provider_block_reason(conn, task.project_id)
            if reason is not None:
                results.append(
                    {
                        "task_id": task.id,
                        "bot_id": None,
                        "status": "skipped",
                        "reason": reason,
                    }
                )
            continue
        try:
            store.claim_task(conn, task.id, bot.id)
        except (KeyError, ValueError) as exc:
            results.append(
                {
                    "task_id": task.id,
                    "bot_id": bot.id,
                    "status": "claim_failed",
                    "reason": str(exc),
                }
            )
            continue
        claimed_this_sweep.add(bot.id)
        busy.add(bot.id)
        try:
            run, _result, artifact_id = orchestrator.schedule_run(
                conn, task.id, data_dir=data_dir, timeout_s=_run_timeout_s(timeout_s)
            )
            results.append(
                {
                    "task_id": task.id,
                    "bot_id": bot.id,
                    "run_id": run.id,
                    "status": run.status.value,
                    "artifact_id": artifact_id,
                    "exit_code": run.exit_code,
                }
            )
        except Exception as exc:  # never let one bad task stop the sweep
            results.append(
                {
                    "task_id": task.id,
                    "bot_id": bot.id,
                    "status": "run_error",
                    "reason": f"{type(exc).__name__}: {exc}",
                }
            )

    # Phase 2: execute accepted, delegated child tasks whose owner has a
    # provider and is not busy. This is the async resume path — results flow
    # back through the delegation record even if nobody called await_delegations.
    busy.update(claimed_this_sweep)
    for task, delegation in store.list_runnable_delegated_tasks(conn):
        if len(results) >= max_tasks:
            break
        if task.owner_teammate_id is None or task.owner_teammate_id in busy:
            continue
        busy.add(task.owner_teammate_id)
        try:
            run, _result, artifact_id = orchestrator.schedule_run(
                conn, task.id, data_dir=data_dir, timeout_s=_run_timeout_s(timeout_s)
            )
            results.append(
                {
                    "task_id": task.id,
                    "bot_id": task.owner_teammate_id,
                    "run_id": run.id,
                    "status": run.status.value,
                    "artifact_id": artifact_id,
                    "exit_code": run.exit_code,
                    "delegation_id": delegation.id,
                    "phase": "delegated",
                }
            )
        except Exception as exc:  # never let one bad child stop the sweep
            results.append(
                {
                    "task_id": task.id,
                    "bot_id": task.owner_teammate_id,
                    "status": "run_error",
                    "reason": f"{type(exc).__name__}: {exc}",
                    "delegation_id": delegation.id,
                    "phase": "delegated",
                }
            )
    return requeue_notes + results


def sweep_loop(
    interval_s: float = DEFAULT_INTERVAL_S,
    data_dir: str = ".nerdbot-data",
    timeout_s: float | None = None,
    max_tasks: int = DEFAULT_MAX_TASKS,
    stop_event: Any = None,
) -> None:
    """Run sweeps repeatedly until ``stop_event`` is set (background executor).

    Intended for the API process when ``NERDBOT_EXECUTOR=1``. Each sweep opens
    its own connection so long-running runs don't hold the request connection.
    """
    import threading

    stop_event = stop_event or threading.Event()
    while not stop_event.is_set():
        conn = store.connect(os.environ.get("NERDBOT_DB", "nerdbot.db"))
        try:
            sweep(conn, data_dir=data_dir, timeout_s=_run_timeout_s(timeout_s), max_tasks=max_tasks)
        finally:
            conn.close()
        stop_event.wait(interval_s)
