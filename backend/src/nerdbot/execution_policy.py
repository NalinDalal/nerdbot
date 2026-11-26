"""Execution-boundary policy enforcement.

Central fail-closed check immediately before protected tool execution.
LLM/cached planning decisions are ignored; current DB state is authoritative.
"""

from __future__ import annotations

import sqlite3
from dataclasses import dataclass
from typing import Any

from . import permissions as permissions_mod
from . import store
from .models import Decision, RunStatus, TeammateStatus


@dataclass(frozen=True)
class ExecutionDecision:
    allowed: bool
    decision: str  # ALLOW|DENY|REQUIRE_APPROVAL|DEFER
    reason_code: str
    action: str
    approval_id: str = ""


def _audit(
    conn: sqlite3.Connection,
    *,
    project_id: str,
    task_id: str,
    run_id: str,
    teammate_id: str,
    action: str,
    decision: str,
    reason_code: str,
    approval_id: str = "",
) -> None:
    try:
        store.record_execution_policy_decision(
            conn,
            project_id=project_id,
            task_id=task_id,
            run_id=run_id,
            teammate_id=teammate_id,
            action=action,
            decision=decision,
            reason_code=reason_code,
            approval_id=approval_id,
        )
    except Exception as exc:
        # Audit persistence failure must not allow denied/ambiguous action.
        raise PermissionError(f"audit persistence failed: {exc}") from exc


def _deny(project_id, task_id, run_id, teammate_id, action, reason_code, conn, approval_id=""):
    _audit(conn, project_id=project_id, task_id=task_id, run_id=run_id, teammate_id=teammate_id, action=action, decision="DENY", reason_code=reason_code, approval_id=approval_id)
    return ExecutionDecision(False, "DENY", reason_code, action, approval_id)


def _require_approval(project_id, task_id, run_id, teammate_id, action, reason_code, conn, approval_id=""):
    _audit(conn, project_id=project_id, task_id=task_id, run_id=run_id, teammate_id=teammate_id, action=action, decision="REQUIRE_APPROVAL", reason_code=reason_code, approval_id=approval_id)
    return ExecutionDecision(False, "REQUIRE_APPROVAL", reason_code, action, approval_id)


def _defer(project_id, task_id, run_id, teammate_id, action, reason_code, conn, approval_id=""):
    _audit(conn, project_id=project_id, task_id=task_id, run_id=run_id, teammate_id=teammate_id, action=action, decision="DEFER", reason_code=reason_code, approval_id=approval_id)
    return ExecutionDecision(False, "DEFER", reason_code, action, approval_id)


def _allow(project_id, task_id, run_id, teammate_id, action, reason_code, conn, approval_id=""):
    _audit(conn, project_id=project_id, task_id=task_id, run_id=run_id, teammate_id=teammate_id, action=action, decision="ALLOW", reason_code=reason_code, approval_id=approval_id)
    return ExecutionDecision(True, "ALLOW", reason_code, action, approval_id)


def enforce_tool_execution(
    conn: sqlite3.Connection,
    *,
    action: str,
    teammate_id: str,
    project_id: str,
    task_id: str = "",
    run_id: str = "",
    approval: Any = None,
    run_owner: str | None = None,
) -> ExecutionDecision:
    """Fail-closed execution-boundary check for an app tool action."""
    action = (action or "").strip()
    if not action:
        return _deny(project_id, task_id, run_id, teammate_id, "unknown", "missing_action", conn)
    ambient = action.startswith("ambient.")
    if not ambient and action not in permissions_mod.ALL_PERMISSIONS:
        return _deny(project_id, task_id, run_id, teammate_id, action, "unknown_action", conn)

    mate = store.get_teammate(conn, teammate_id) if teammate_id else None
    if mate is None:
        return _deny(project_id, task_id, run_id, teammate_id, action, "actor_missing", conn)
    if mate.status != TeammateStatus.ACTIVE:
        return _deny(project_id, task_id, run_id, teammate_id, action, "actor_not_active", conn)
    if bool(getattr(mate, "paused", False)):
        return _defer(project_id, task_id, run_id, teammate_id, action, "agent_paused", conn)
    # project authorization
    if project_id and not store.teammate_in_project(conn, mate.id, project_id):
        return _deny(project_id, task_id, run_id, teammate_id, action, "actor_not_in_project", conn)

    # run lease ownership check when run is running
    if run_id:
        run = store.get_run(conn, run_id)
        if run is None:
            return _deny(project_id, task_id, run_id, teammate_id, action, "run_missing", conn)
        if project_id and run.task_id:
            task = store.get_task(conn, run.task_id)
            if task is not None and task.project_id != project_id:
                return _deny(project_id, task_id, run_id, teammate_id, action, "run_project_mismatch", conn)
        if run.status == RunStatus.RUNNING and run.lease_owner:
            if run_owner is not None and run_owner != run.lease_owner:
                return _deny(project_id, task_id, run_id, teammate_id, action, "run_lease_owner_mismatch", conn, getattr(approval, "id", "") if approval else "")
            if run_owner is None:
                return _deny(project_id, task_id, run_id, teammate_id, action, "run_lease_owner_unverified", conn, getattr(approval, "id", "") if approval else "")
        elif run.status == RunStatus.RUNNING and not run.lease_owner:
            return _deny(project_id, task_id, run_id, teammate_id, action, "run_lease_missing", conn, getattr(approval, "id", "") if approval else "")

    # permission check
    has_perm = action in set(mate.permissions) or action in set(getattr(mate, "tool_policy", {}) or {})
    if not has_perm:
        return _deny(project_id, task_id, run_id, teammate_id, action, "missing_permission", conn)

    approval_id = ""
    if approval is not None:
        approval_id = getattr(approval, "id", "") or ""
        if approval.action != action:
            return _deny(project_id, task_id, run_id, teammate_id, action, "approval_action_mismatch", conn, approval_id)
        if approval.decision not in (Decision.APPROVED, Decision.APPROVED_FOREVER):
            return _deny(project_id, task_id, run_id, teammate_id, action, "approval_not_approved", conn, approval_id)
        if approval.executed_at is not None and approval.decision == Decision.APPROVED:
            return _deny(project_id, task_id, run_id, teammate_id, action, "approval_already_executed", conn, approval_id)
        if store.approval_is_expired(approval):
            return _deny(project_id, task_id, run_id, teammate_id, action, "approval_expired", conn, approval_id)
        # scope checks
        if approval.teammate_id and approval.teammate_id != teammate_id:
            return _deny(project_id, task_id, run_id, teammate_id, action, "approval_teammate_mismatch", conn, approval_id)
        if approval.task_id and task_id and approval.task_id != task_id:
            return _deny(project_id, task_id, run_id, teammate_id, action, "approval_task_mismatch", conn, approval_id)
        if approval.run_id and run_id and approval.run_id != run_id:
            return _deny(project_id, task_id, run_id, teammate_id, action, "approval_run_mismatch", conn, approval_id)
        apr_project = store.approval_project(conn, approval.id)
        if project_id and apr_project and apr_project != project_id:
            return _deny(project_id, task_id, run_id, teammate_id, action, "approval_project_mismatch", conn, approval_id)
        return _allow(project_id, task_id, run_id, teammate_id, action, "approved", conn, approval_id)

    if action in permissions_mod.ADMIN_PERMISSIONS or action in permissions_mod.EXTERNAL_PERMISSIONS:
        # admin auto policy is explicit
        if action in permissions_mod.ADMIN_PERMISSIONS:
            policy = getattr(mate, "tool_policy", {}) or {}
            value = policy.get(action)
            if isinstance(value, str) and value.lower() == "auto":
                return _allow(project_id, task_id, run_id, teammate_id, action, "admin_auto", conn)
        return _require_approval(project_id, task_id, run_id, teammate_id, action, "approval_required", conn)

    return _allow(project_id, task_id, run_id, teammate_id, action, "permitted", conn)
