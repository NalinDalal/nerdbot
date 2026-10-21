"""Permission and approval gates for agent-driven and human-facing actions.

The gate is server-side and fail-closed:

- Non-admin permissions (``task.create``, ``board.message``, ``memory.write``,
  ...) require the permission to be granted; absent = deny.
- Admin permissions (``teammate.create/update/delete``, ``team.create``,
  ``board.delete``, ``permission.change``) default to DENY when absent. When
  granted, they still require a digest-bound, one-use approval — unless the
  teammate's ``tool_policy`` sets the permission to ``"auto"``, which is an
  explicit, audited decision to run without a human gate.
- A human caller (no acting teammate) is never gated here; API routes call
  these helpers only when ``X-Acting-Teammate`` is set.

Approvals are digest-bound: the digest covers the action name plus the exact
payload, so approving one action never approves a different payload.
"""

from __future__ import annotations

import hashlib
import json
import sqlite3
from typing import Any

from . import permissions as permissions_mod
from . import store
from .models import Approval, Decision, Teammate

# The catalogue lives in :mod:`nerdbot.permissions` so the store can validate
# names without importing this module (which imports the store). Re-exported
# here because the gate is the natural entry point for permission questions.
ADMIN_PERMISSIONS = permissions_mod.ADMIN_PERMISSIONS

# Non-admin permissions an agent tool may exercise. Knowledge read and task
# listing are ambient (no permission needed); everything else is checked.
PERMISSION_ONLY = permissions_mod.AGENT_PERMISSIONS

ALL_PERMISSIONS = permissions_mod.ALL_PERMISSIONS


class GateDenied(PermissionError):
    """The acting teammate lacks the permission (or it defaults to deny)."""


class GateApprovalRequired(Exception):
    """The action needs a human approval; carries the pending approval row.

    ``approvals`` holds every pending approval for the action when more than
    one permission needed a human decision (e.g. changing a bot's
    permissions needs both ``teammate.update`` and ``permission.change``).
    """

    def __init__(self, approval: Approval, approvals: list[Approval] | None = None) -> None:
        super().__init__(
            f"action {approval.action!r} requires approval {approval.id}"
        )
        self.approval = approval
        self.approvals = list(approvals) if approvals else [approval]


def action_digest(action: str, payload: dict[str, Any] | None = None) -> str:
    """Canonical digest binding an approval to one exact action + payload."""
    canonical = json.dumps(
        {"action": action, "payload": payload or {}}, sort_keys=True, separators=(",", ":")
    )
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def has_permission(mate: Teammate, permission: str) -> bool:
    return permission in set(mate.tool_policy.keys()) or permission in mate.permissions


def policy_allows_auto(mate: Teammate, permission: str) -> bool:
    """tool_policy[permission] == "auto" skips the approval gate (audited)."""
    value = mate.tool_policy.get(permission)
    return isinstance(value, str) and value.lower() == "auto"


def check_permission(mate: Teammate, permission: str) -> None:
    """Raise GateDenied unless the teammate holds the permission.

    Admin permissions are default-deny: absent from both permissions and
    tool_policy means deny, even to list them is not enough.
    """
    if permission not in ALL_PERMISSIONS:
        raise GateDenied(f"unknown permission {permission!r}")
    if not has_permission(mate, permission):
        raise GateDenied(f"teammate {mate.id} lacks permission {permission!r}")


def require(
    conn: sqlite3.Connection,
    mate: Teammate,
    permission: str,
    *,
    payload: dict[str, Any] | None = None,
    run_id: str = "",
    task_id: str | None = None,
    ttl_s: float = store.DEFAULT_APPROVAL_TTL_S,
) -> Approval | None:
    """Full gate for one action: permission, then approval for admin ops.

    Returns None when the action may proceed now (permission-only action, or
    an admin action explicitly set to "auto"). Raises GateDenied when the
    permission is absent; raises GateApprovalRequired (with a freshly created
    or existing pending approval) when a human decision is needed.

    An already-approved, unconsumed approval with the same digest is consumed
    (marked executed) and the action proceeds.
    """
    check_permission(mate, permission)
    if permission not in ADMIN_PERMISSIONS:
        return None  # permission-only action
    if policy_allows_auto(mate, permission):
        return None
    digest = action_digest(permission, payload)
    existing = store.find_approved_action(conn, permission, digest)
    if existing is not None:
        if existing.decision == Decision.APPROVED:
            store.mark_approval_executed(conn, existing.id, run_id=run_id)
        # APPROVED_FOREVER stays unconsumed: reusable indefinitely.
        return existing
    pending = _find_pending_approval(conn, permission, digest)
    if pending is not None:
        raise GateApprovalRequired(pending)
    approval = store.request_approval(
        conn,
        action=permission,
        requester=mate.id,
        run_id=run_id,
        ttl_s=ttl_s,
        task_id=task_id,
        digest=digest,
        project_id=mate.project_id,
    )
    raise GateApprovalRequired(approval)


def require_many(
    conn: sqlite3.Connection,
    mate: Teammate,
    requirements: list[tuple[str, dict[str, Any] | None]],
    *,
    run_id: str = "",
    task_id: str | None = None,
    ttl_s: float = store.DEFAULT_APPROVAL_TTL_S,
) -> list[Approval] | None:
    """Full gate for several permissions of one action.

    Every permission is checked first — a missing one denies the whole
    action, so no approval can be requested for an action that is not
    allowed. Then one approval is requested per admin permission that still
    needs a human decision, so the owner decides once instead of being
    walked through the same action permission by permission.

    Returns None when the action may proceed now. Raises GateDenied when a
    permission is absent, and GateApprovalRequired (carrying every pending
    approval) when a human decision is still needed.
    """
    for permission, _payload in requirements:
        check_permission(mate, permission)
    pending: list[Approval] = []
    for permission, payload in requirements:
        if permission not in ADMIN_PERMISSIONS:
            continue  # permission-only action
        if policy_allows_auto(mate, permission):
            continue
        digest = action_digest(permission, payload)
        existing = store.find_approved_action(conn, permission, digest)
        if existing is not None:
            if existing.decision == Decision.APPROVED:
                store.mark_approval_executed(conn, existing.id, run_id=run_id)
            # APPROVED_FOREVER stays unconsumed: reusable indefinitely.
            continue
        found = _find_pending_approval(conn, permission, digest)
        if found is not None:
            pending.append(found)
            continue
        pending.append(
            store.request_approval(
                conn,
                action=permission,
                requester=mate.id,
                run_id=run_id,
                ttl_s=ttl_s,
                task_id=task_id,
                digest=digest,
                project_id=mate.project_id,
            )
        )
    if pending:
        raise GateApprovalRequired(pending[0], pending)
    return None


def _find_pending_approval(
    conn: sqlite3.Connection, action: str, digest: str
) -> Approval | None:
    import datetime as _dt

    now = _dt.datetime.now(_dt.UTC).isoformat()
    rows = conn.execute(
        "SELECT * FROM approvals WHERE action = ? AND digest = ? AND decision = 'pending'"
        " AND consumed_at IS NULL AND (expires_at IS NULL OR expires_at > ?)"
        " ORDER BY rowid DESC",
        (action, digest, now),
    ).fetchall()
    if not rows:
        return None
    return store._approval_from_row(rows[0])


def decide_approval(
    conn: sqlite3.Connection, approval_id: str, decision: Decision
) -> Approval:
    """Human decision on a pending approval (thin wrapper for symmetry)."""
    return store.decide_approval(conn, approval_id, decision)
