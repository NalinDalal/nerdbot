"""Delegation lifecycle: delegate, accept/decline, await, retry.

Delegation is a real hand-off, not an auto-accept. The rules:

- a delegation starts ``pending``; only the delegatee (or the human owner)
  may accept or decline it — ``declined`` is a first-class outcome;
- a delegation resolves to ``completed``/``failed`` only from the delegatee's
  actual run result. The delegator never writes that outcome itself;
- ``declined``, ``cancelled`` and ``timed_out`` are terminal and are never
  reported as success;
- a child run that finishes while its delegation is still ``pending`` means
  the delegatee did the work without accepting it: that is a failure, not a
  success;
- depth, fan-out and attempts are bounded, so a delegation loop cannot run
  away.

Every function here operates on the same store rows the API and the executor
use, so the agent tools and the dashboard see one lifecycle.
"""

from __future__ import annotations

import sqlite3
from datetime import UTC, datetime, timedelta
from typing import Any

from . import gates, store
from .models import Delegation, DelegationStatus, Task, TaskStatus, Teammate, TeammateStatus

MAX_DELEGATION_DEPTH = 5
MAX_DELEGATIONS_PER_TASK = 10
MAX_DELEGATION_ATTEMPTS = 3
DEFAULT_DELEGATION_TIMEOUT_S = 900.0
MAX_DELEGATION_TIMEOUT_S = 24 * 3600.0

TERMINAL_DELEGATION_STATUSES = frozenset(
    {
        DelegationStatus.COMPLETED,
        DelegationStatus.FAILED,
        DelegationStatus.CANCELLED,
        DelegationStatus.DECLINED,
        DelegationStatus.TIMED_OUT,
    }
)


class DelegationError(ValueError):
    """A delegation request that the server refuses (never a false success)."""


# -- selection ----------------------------------------------------------------


def eligible_delegatees(
    conn: sqlite3.Connection, project_id: str, requester: Teammate
) -> list[dict[str, Any]]:
    """Candidates this identity may delegate to, with the facts needed to
    choose: role, capabilities, permissions, workload and model attachment.

    Scoped to the requester's own project — a bot never sees the fleet of
    another workspace.
    """
    out: list[dict[str, Any]] = []
    for mate in store.list_teammates(conn, project_id):
        if mate.id == requester.id:
            continue
        if mate.status != TeammateStatus.ACTIVE:
            continue
        busy = conn.execute(
            "SELECT COUNT(*) FROM tasks WHERE owner_teammate_id = ?"
            " AND status IN (?, ?, ?)",
            (mate.id, TaskStatus.RUNNING.value, TaskStatus.READY.value,
             TaskStatus.PENDING.value),
        ).fetchone()[0]
        inbound = conn.execute(
            "SELECT COUNT(*) FROM delegations WHERE to_teammate_id = ?"
            " AND status = ?",
            (mate.id, DelegationStatus.PENDING.value),
        ).fetchone()[0]
        out.append(
            {
                "id": mate.id,
                "persona": mate.persona,
                "capabilities": list(mate.capabilities),
                "permissions": list(mate.permissions),
                "memory_scope": mate.memory_scope,
                "has_model": bool(mate.provider_id),
                "open_tasks": int(busy),
                "pending_delegations": int(inbound),
                "available": int(busy) == 0 and int(inbound) == 0,
            }
        )
    out.sort(key=lambda m: (not m["available"], not m["has_model"], m["persona"]))
    return out


# -- creation -----------------------------------------------------------------


def delegate(
    conn: sqlite3.Connection,
    *,
    parent_task: Task,
    requester: Teammate,
    to_teammate_id: str,
    objective: str,
    scope: str = "",
    context: str = "",
    command: str = "",
    timeout_s: float = DEFAULT_DELEGATION_TIMEOUT_S,
    now: datetime | None = None,
) -> Delegation:
    """Create a delegation: a child task for the delegatee plus a pending
    delegation record the delegatee must accept or decline.

    The delegatee is *not* assumed to accept. The record starts ``pending``
    and only the delegatee (or the owner) resolves it.
    """
    if requester.project_id != parent_task.project_id:
        raise DelegationError("you may only delegate tasks in your own project")
    if requester.status != TeammateStatus.ACTIVE:
        raise DelegationError("you are not active")
    objective = objective.strip()
    if not objective:
        raise DelegationError("a delegation needs an objective")
    if to_teammate_id == requester.id:
        raise DelegationError("you cannot delegate to yourself")

    target = store.get_teammate(conn, to_teammate_id)
    if target is None:
        raise DelegationError(f"teammate {to_teammate_id} does not exist")
    if target.project_id != parent_task.project_id:
        raise DelegationError("that teammate belongs to another project")
    if target.status != TeammateStatus.ACTIVE:
        raise DelegationError(f"teammate {to_teammate_id} is {target.status.value}")

    existing = store.list_delegations_for_task(conn, parent_task.id)
    if len(existing) >= MAX_DELEGATIONS_PER_TASK:
        raise DelegationError(
            f"delegation budget exhausted for this task ({MAX_DELEGATIONS_PER_TASK})"
        )
    if any(d.to_teammate_id == to_teammate_id and d.status == DelegationStatus.PENDING
           for d in existing):
        raise DelegationError(f"{to_teammate_id} already has a pending delegation here")

    depth = _depth_of(conn, parent_task)
    if depth >= MAX_DELEGATION_DEPTH:
        raise DelegationError(
            f"delegation depth limit ({MAX_DELEGATION_DEPTH}) reached"
        )
    # Cycle prevention: never hand work to a bot that owns an ancestor task.
    if _owns_ancestor(conn, parent_task, to_teammate_id):
        raise DelegationError(
            "delegation cycle detected (target owns an ancestor task)"
        )

    bounded_timeout = max(1.0, min(float(timeout_s or DEFAULT_DELEGATION_TIMEOUT_S),
                                   MAX_DELEGATION_TIMEOUT_S))
    moment = now or datetime.now(UTC)
    deadline = moment + timedelta(seconds=bounded_timeout)

    child = store.create_task(
        conn,
        parent_task.project_id,
        description=objective,
        command=command,
        owner_teammate_id=to_teammate_id,
        board_id=parent_task.board_id,
        parent_task_id=parent_task.id,
    )
    reason_parts = [p for p in (context.strip(), scope.strip()) if p]
    reason = " | ".join(reason_parts)
    delegation = store.create_delegation(
        conn,
        parent_task.id,
        requester.id,
        to_teammate_id,
        reason=reason,
        depth=depth,
        child_task_id=child.id,
        auto_accept=False,
        deadline_at=deadline,
        scope=scope,
        attempts=1,
    )
    return delegation


def _depth_of(conn: sqlite3.Connection, task: Task) -> int:
    """How deep in the delegation chain this task sits (1 = top level)."""
    depth = 1
    seen: set[str] = {task.id}
    current = task
    while current.parent_task_id:
        parent = store.get_task(conn, current.parent_task_id)
        if parent is None or parent.id in seen:
            break
        seen.add(parent.id)
        depth += 1
        current = parent
    return depth


def _owns_ancestor(conn: sqlite3.Connection, task: Task, teammate_id: str) -> bool:
    seen: set[str] = set()
    current: Task | None = task
    while current is not None and current.id not in seen:
        seen.add(current.id)
        if current.owner_teammate_id == teammate_id:
            return True
        if not current.parent_task_id:
            return False
        current = store.get_task(conn, current.parent_task_id)
    return False


# -- the delegatee's decision -------------------------------------------------


def respond(
    conn: sqlite3.Connection,
    delegation: Delegation,
    *,
    actor: Teammate | None,
    decision: str,
    reason: str = "",
) -> Delegation:
    """Accept or decline a delegation.

    ``actor`` is the bot deciding. It must be the delegatee: a bot may not
    accept work on somebody else's behalf. ``actor is None`` is the human
    owner path, which may act for either side.
    """
    decision = decision.strip().lower()
    if decision not in ("accepted", "declined"):
        raise DelegationError("decision must be 'accepted' or 'declined'")
    if delegation.status != DelegationStatus.PENDING:
        raise DelegationError(
            f"delegation is already {delegation.status.value}; it cannot be re-decided"
        )
    if actor is not None:
        if actor.id != delegation.to_teammate_id:
            raise DelegationError(
                "only the delegatee may accept or decline this delegation"
            )
        if actor.status != TeammateStatus.ACTIVE:
            raise DelegationError("you are not active")
    updated = store.decide_delegation(conn, delegation.id, decision, reason=reason)
    if decision == "accepted" and updated.child_task_id:
        # Accepted: the child task becomes runnable again (it was blocked when
        # the delegation was created as pending-and-unclaimed).
        child = store.get_task(conn, updated.child_task_id)
        if child is not None and child.status == TaskStatus.BLOCKED:
            store.set_task_status(conn, child.id, TaskStatus.PENDING)
    return updated


# -- deadlines ----------------------------------------------------------------


def expire_overdue(
    conn: sqlite3.Connection,
    delegations: list[Delegation],
    *,
    now: datetime | None = None,
) -> list[Delegation]:
    """Time out every pending delegation whose deadline has passed."""
    moment = now or datetime.now(UTC)
    expired: list[Delegation] = []
    for delegation in delegations:
        if delegation.status in TERMINAL_DELEGATION_STATUSES:
            continue
        if delegation.deadline_at is None:
            continue
        if delegation.deadline_at > moment:
            continue
        expired.append(
            store.expire_delegation(
                conn,
                delegation.id,
                reason=f"deadline {delegation.deadline_at.isoformat()} passed",
            )
        )
    return expired


# -- results ------------------------------------------------------------------


def outcome_of(delegation: Delegation) -> str:
    """A delegation's outcome as the model should read it.

    Only ``completed`` is a success. Everything else is spelled out so a
    delegator can never report a rejection or a timeout as if the work had
    been done.
    """
    if delegation.status == DelegationStatus.COMPLETED:
        return "completed"
    if delegation.status == DelegationStatus.DECLINED:
        return "declined by the delegatee"
    if delegation.status == DelegationStatus.FAILED:
        return "failed"
    if delegation.status == DelegationStatus.TIMED_OUT:
        return "timed out"
    if delegation.status == DelegationStatus.CANCELLED:
        return "cancelled"
    if delegation.status == DelegationStatus.ACCEPTED:
        return "accepted, still running"
    return "waiting for the delegatee to accept"


def can_await(delegation: Delegation) -> bool:
    """True when the delegation's child task may be executed right now."""
    return delegation.status in (DelegationStatus.PENDING, DelegationStatus.ACCEPTED)


def delegatee_is_busy(conn: sqlite3.Connection, teammate_id: str) -> bool:
    """True when the delegatee is already executing something.

    The delegator must not start a second run on a bot that is mid-run: the
    two runs would share one identity and one workspace.
    """
    row = conn.execute(
        "SELECT COUNT(*) FROM tasks WHERE owner_teammate_id = ?"
        " AND status IN (?, ?)",
        (teammate_id, TaskStatus.RUNNING.value, TaskStatus.READY.value),
    ).fetchone()
    return int(row[0]) > 0


def describe(delegation: Delegation) -> str:
    """One line about a delegation, safe to show to a model."""
    parts = [
        f"delegation {delegation.id} to {delegation.to_teammate_id}:"
        f" {outcome_of(delegation)}"
    ]
    if delegation.child_task_id:
        parts.append(f"(child task {delegation.child_task_id})")
    if delegation.scope:
        parts.append(f"scope: {delegation.scope}")
    if delegation.deadline_at:
        parts.append(f"deadline: {delegation.deadline_at.isoformat()}")
    return " ".join(parts)


# -- retry --------------------------------------------------------------------


def retry(
    conn: sqlite3.Connection,
    delegation: Delegation,
    *,
    actor: Teammate,
    to_teammate_id: str | None = None,
    timeout_s: float = DEFAULT_DELEGATION_TIMEOUT_S,
    now: datetime | None = None,
) -> Delegation:
    """Re-delegate a delegation that did not succeed.

    Only the delegator may retry, only a terminal delegation may be retried,
    and the number of attempts is bounded.
    """
    if actor.id != delegation.from_teammate_id:
        raise DelegationError("only the delegator may retry a delegation")
    if delegation.status not in TERMINAL_DELEGATION_STATUSES:
        raise DelegationError(
            f"delegation is {delegation.status.value}; only a finished one can be retried"
        )
    if delegation.status == DelegationStatus.COMPLETED:
        raise DelegationError("this delegation already succeeded")
    if delegation.attempts >= MAX_DELEGATION_ATTEMPTS:
        raise DelegationError(
            f"retry limit reached ({MAX_DELEGATION_ATTEMPTS} attempts)"
        )
    parent = store.get_task(conn, delegation.task_id)
    if parent is None:
        raise DelegationError("the parent task no longer exists")
    child = store.get_task(conn, delegation.child_task_id) if delegation.child_task_id else None
    objective = child.description if child is not None else delegation.reason
    target = to_teammate_id or delegation.to_teammate_id
    new_delegation = delegate(
        conn,
        parent_task=parent,
        requester=actor,
        to_teammate_id=target,
        objective=objective,
        scope=delegation.scope,
        context=f"retry of delegation {delegation.id} ({delegation.status.value})",
        command=child.command if child is not None else "",
        timeout_s=timeout_s,
        now=now,
    )
    # Carry the attempt counter forward so the budget spans the whole chain.
    conn.execute(
        "UPDATE delegations SET attempts = ? WHERE id = ?",
        (delegation.attempts + 1, new_delegation.id),
    )
    conn.commit()
    new_delegation.attempts = delegation.attempts + 1
    return new_delegation


# -- the delegator's side -----------------------------------------------------


def delegations_for(conn: sqlite3.Connection, task_id: str) -> list[Delegation]:
    return store.list_delegations_for_task(conn, task_id)


def check_permission(mate: Teammate, permission: str = "task.delegate") -> None:
    """Delegation is gated exactly like every other agent action."""
    gates.check_permission(mate, permission)
