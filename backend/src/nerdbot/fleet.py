"""Fleet services: teammate and team management scoped to an acting identity.

Every service takes an optional ``acting`` teammate. When set, the action is
permission-checked through :mod:`nerdbot.gates` (admin permissions are
default-deny and approval-gated unless explicitly "auto"). When ``acting``
is None the caller is the human owner, who is never gated here.

Teammates created by a bot inherit no permissions unless explicitly granted:
bots-manage-bots is granted, not implied.
"""

from __future__ import annotations

import sqlite3
from typing import Any

from fastapi import HTTPException

from . import gates, store
from .models import Team, Teammate, TeammateStatus, TeamMember


def _wrap_gate_error(exc: Exception) -> HTTPException:
    if isinstance(exc, gates.GateApprovalRequired):
        return HTTPException(
            status_code=409,
            detail={
                "message": "action requires owner approval",
                "approval": exc.approval.model_dump(mode="json"),
                "approvals": [a.model_dump(mode="json") for a in exc.approvals],
            },
        )
    if isinstance(exc, gates.GateDenied):
        return HTTPException(status_code=403, detail=str(exc))
    return HTTPException(status_code=500, detail=f"{type(exc).__name__}: {exc}")


def create_teammate_service(
    conn: sqlite3.Connection,
    project_id: str,
    persona: str = "",
    instructions: str = "",
    capabilities: list[str] | None = None,
    memory_scope: str = "project",
    permissions: list[str] | None = None,
    provider_id: str | None = None,
    acting: Teammate | None = None,
) -> Teammate:
    if acting is not None:
        if acting.project_id != project_id:
            raise HTTPException(
                status_code=403, detail="acting teammate belongs to another project"
            )
        # A bot may not create a teammate with more power than itself. This
        # runs before the gate: no approval can authorize an escalation, so
        # asking for one would waste a roundtrip on a guaranteed denial.
        requested = set(permissions or [])
        granted = set(acting.permissions)
        if not requested <= granted:
            extras = sorted(requested - granted)
            raise HTTPException(
                status_code=403,
                detail=f"cannot grant permissions the acting teammate lacks: {extras}",
            )
        try:
            gates.require(
                conn,
                acting,
                "teammate.create",
                payload={
                    "project_id": project_id,
                    "persona": persona,
                    "permissions": permissions or [],
                    "provider_id": provider_id or "",
                },
                task_id=None,
            )
        except gates.GateDenied as exc:
            raise _wrap_gate_error(exc) from exc
        except gates.GateApprovalRequired as exc:
            raise _wrap_gate_error(exc) from exc
    try:
        mate = store.create_teammate(
            conn,
            project_id,
            persona=persona,
            instructions=instructions,
            capabilities=capabilities,
            memory_scope=memory_scope,
            permissions=permissions,
        )
    except (KeyError, ValueError) as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    if provider_id is not None:
        try:
            mate = store.update_teammate(conn, mate.id, provider_id=provider_id)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
    return mate


def _approval_payload(teammate_id: str, updates: dict[str, Any]) -> dict[str, Any]:
    """Digest payload that binds an approval to the exact change.

    Binding only the *field names* would let one approval cover any value:
    approving "change the permissions" must not authorize setting arbitrary
    permissions, and approving "attach a provider" must not authorize a
    different provider. ``None`` means "no change" and is excluded.
    """
    changed = {
        key: updates[key]
        for key in sorted(updates)
        if updates[key] is not None
    }
    return {"teammate_id": teammate_id, "changes": changed}


def _requested_permissions(updates: dict[str, Any]) -> set[str]:
    """Permissions a change would grant: the permission list plus every
    ``tool_policy`` key (a policy key counts as holding that permission)."""
    requested = set(updates.get("permissions") or [])
    requested.update(str(k) for k in (updates.get("tool_policy") or {}))
    return requested


def update_teammate_service(
    conn: sqlite3.Connection,
    teammate_id: str,
    updates: dict[str, Any],
    acting: Teammate | None = None,
) -> Teammate:
    mate = store.get_teammate(conn, teammate_id)
    if mate is None:
        raise HTTPException(status_code=404, detail="teammate not found")
    if acting is not None:
        if acting.project_id != mate.project_id:
            raise HTTPException(
                status_code=403, detail="acting teammate belongs to another project"
            )
        # Escalation guard, before any gate: a bot may not hand out (or
        # auto-approve) a permission it does not itself hold. No approval can
        # authorize an escalation, so this runs first.
        requested = _requested_permissions(updates)
        granted = set(acting.permissions)
        if not requested <= granted:
            extras = sorted(requested - granted)
            raise HTTPException(
                status_code=403,
                detail=f"cannot grant permissions the acting teammate lacks: {extras}",
            )
        payload = _approval_payload(teammate_id, updates)
        requirements: list[tuple[str, dict[str, Any] | None]] = [
            ("teammate.update", payload),
        ]
        if updates.get("permissions") is not None or updates.get("tool_policy") is not None:
            # Changing what a bot may do is its own permission, and the same
            # approval decision covers both.
            requirements.append(("permission.change", payload))
        try:
            gates.require_many(conn, acting, requirements, task_id=None)
        except (gates.GateDenied, gates.GateApprovalRequired) as exc:
            raise _wrap_gate_error(exc) from exc
    try:
        return store.update_teammate(conn, teammate_id, **updates)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


def set_teammate_status_service(
    conn: sqlite3.Connection,
    teammate_id: str,
    status: TeammateStatus,
    acting: Teammate | None = None,
) -> Teammate:
    mate = store.get_teammate(conn, teammate_id)
    if mate is None:
        raise HTTPException(status_code=404, detail="teammate not found")
    if mate.status == TeammateStatus.ARCHIVED and status != TeammateStatus.ARCHIVED:
        raise HTTPException(status_code=400, detail="archived teammates cannot be reactivated")
    if acting is not None:
        if acting.project_id != mate.project_id:
            raise HTTPException(
                status_code=403, detail="acting teammate belongs to another project"
            )
        perm = "teammate.delete" if status == TeammateStatus.ARCHIVED else "teammate.update"
        try:
            gates.require(
                conn,
                acting,
                perm,
                payload={"teammate_id": teammate_id, "status": status.value},
                task_id=None,
            )
        except (gates.GateDenied, gates.GateApprovalRequired) as exc:
            raise _wrap_gate_error(exc) from exc
    conn.execute("UPDATE teammates SET status = ? WHERE id = ?", (status.value, teammate_id))
    conn.commit()
    store.record_event(
        conn, mate.project_id, "teammate", teammate_id, f"teammate.{status.value}"
    )
    updated = store.get_teammate(conn, teammate_id)
    assert updated is not None
    return updated


def create_team_service(
    conn: sqlite3.Connection,
    owner: str,
    name: str,
    project_id: str = "",
    member_ids: list[str] | None = None,
    project_member_ids: list[str] | None = None,
    description: str = "",
    acting: Teammate | None = None,
) -> Team:
    """Create a team, optionally with bot and/or project members.

    ``member_ids`` are teammate (bot) ids — the fleet-grouping case the agent
    tools use. ``project_member_ids`` are project (workspace) ids. Both are
    validated by the store against the team owner.
    """
    if acting is not None:
        if not project_id:
            project_id = acting.project_id
        if acting.project_id != project_id:
            raise HTTPException(
                status_code=403, detail="acting teammate belongs to another project"
            )
        # A bot creates a team on behalf of its workspace owner, so the team's
        # owner is the human principal (the project owner), not the bot. This
        # keeps membership ownership checks correct: membership is validated
        # against the project owner, and a bot can never own a team.
        project = store.get_project(conn, project_id)
        owner = project.owner if project is not None else acting.id
        try:
            gates.require(
                conn,
                acting,
                "team.create",
                payload={"project_id": project_id, "name": name},
                task_id=None,
            )
        except (gates.GateDenied, gates.GateApprovalRequired) as exc:
            raise _wrap_gate_error(exc) from exc
    try:
        team = store.create_team(conn, owner=owner, name=name, description=description)
    except (KeyError, ValueError) as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    for project_member_id in project_member_ids or []:
        try:
            store.create_team_member(conn, team.id, project_member_id)
        except (KeyError, ValueError) as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
    for member_id in member_ids or []:
        try:
            store.add_teammate_to_team(conn, team.id, member_id)
        except (KeyError, ValueError) as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
    return team


def add_teammate_to_team_service(
    conn: sqlite3.Connection,
    team_id: str,
    teammate_id: str,
    acting: Teammate | None = None,
) -> TeamMember:
    """Add a bot to a team (gated by ``team.membership`` when acting)."""
    team = store.get_team(conn, team_id)
    if team is None:
        raise HTTPException(status_code=404, detail="team not found")
    target = store.get_teammate(conn, teammate_id)
    if target is None:
        raise HTTPException(status_code=404, detail="teammate not found")
    if acting is not None:
        # Workspace isolation: a bot may only regroup bots from its own
        # project, never reach into another workspace's fleet.
        if target.project_id != acting.project_id:
            raise HTTPException(
                status_code=403, detail="teammate belongs to another project"
            )
        try:
            gates.require(
                conn,
                acting,
                "team.membership",
                payload={"team_id": team_id, "teammate_id": teammate_id},
                task_id=None,
            )
        except (gates.GateDenied, gates.GateApprovalRequired) as exc:
            raise _wrap_gate_error(exc) from exc
    try:
        return store.add_teammate_to_team(conn, team_id, teammate_id)
    except (KeyError, ValueError) as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


def remove_teammate_from_team_service(
    conn: sqlite3.Connection,
    team_id: str,
    teammate_id: str,
    acting: Teammate | None = None,
) -> None:
    team = store.get_team(conn, team_id)
    if team is None:
        raise HTTPException(status_code=404, detail="team not found")
    target = store.get_teammate(conn, teammate_id)
    if target is None:
        raise HTTPException(status_code=404, detail="teammate not found")
    if acting is not None:
        if target.project_id != acting.project_id:
            raise HTTPException(
                status_code=403, detail="teammate belongs to another project"
            )
        try:
            gates.require(
                conn,
                acting,
                "team.membership",
                payload={"team_id": team_id, "teammate_id": teammate_id},
                task_id=None,
            )
        except (gates.GateDenied, gates.GateApprovalRequired) as exc:
            raise _wrap_gate_error(exc) from exc
    store.remove_teammate_from_team(conn, team_id, teammate_id)
