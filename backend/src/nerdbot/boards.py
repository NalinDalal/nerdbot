"""Board service: workspace containers for bots and tasks, plus the
board-to-board response channel and bot-scoped execution path.

A board belongs to one project (workspace) and holds member teammates
(bots). Bots can create/manage/delete boards and exchange messages over
the response channel when their ``tool_policy`` grants the matching
permission (``board.create``, ``board.delete``, ``board.message``,
``team.create``, ``teammate.create``).

Board-impacting mutations (create/delete/teammate-create) can be gated
behind a one-use approval so a CEO bot cannot act unilaterally unless
the owner approves.
"""

from __future__ import annotations

import sqlite3
from typing import Any

from fastapi import Depends, Header, HTTPException

from . import gates, store
from .models import (
    Approval,
    Board,
    BoardMember,
    BoardMemberRole,
    BoardMessage,
    Decision,
    Teammate,
    TeammateStatus,
)
from .store import get_conn

BOARD_PERMISSIONS = frozenset(
    {
        "board.create",
        "board.delete",
        "board.message",
        "board.read",
        "team.create",
        "teammate.create",
    }
)


def acting_teammate_from_header(
    conn: sqlite3.Connection = Depends(get_conn),
    x_acting_teammate: str | None = Header(default=None, alias="X-Acting-Teammate"),
) -> Teammate | None:
    """Resolve the bot acting on behalf of the caller, if any.

    Returns ``None`` when no header is present (normal owner path).
    Raises 401/404 when the header names an unknown or inactive teammate.
    """
    if not x_acting_teammate:
        return None
    mate = store.get_teammate(conn, x_acting_teammate)
    if mate is None:
        raise HTTPException(status_code=404, detail="acting teammate not found")
    if mate.status != TeammateStatus.ACTIVE:
        raise HTTPException(status_code=403, detail="acting teammate is not active")
    return mate


def _require_board_permission(mate: Teammate, permission: str) -> None:
    """Central permission check for an acting teammate (HTTP-flavoured).

    Delegates the "does this teammate hold it" question to
    :func:`nerdbot.gates.has_permission` so the board services and the
    agent tool layer share one source of truth for granted permissions.
    """
    if permission not in gates.ALL_PERMISSIONS:
        raise HTTPException(status_code=400, detail=f"unknown board permission {permission!r}")
    if not gates.has_permission(mate, permission):
        raise HTTPException(
            status_code=403, detail=f"teammate {mate.id} lacks permission {permission!r}"
        )


def authorize_board(
    conn: sqlite3.Connection,
    board_id: str,
    acting: Teammate,
    permission: str,
    *,
    require_membership: bool = False,
) -> Board:
    """Authorize an acting teammate against one board.

    This is the single authorization rule for every board surface an agent
    can reach. Three checks, in order:

    1. the teammate holds ``permission`` (deny by default);
    2. the board lives in the teammate's own project — workspace isolation,
       so a bot can never touch another workspace's board;
    3. with ``require_membership`` the teammate must own the board or be a
       member of it — resource scope, so holding the permission is not
       enough to read a board you are not part of.

    Raises HTTPException 403 when a check fails. An unknown board id is
    reported as 404 by the callers before authorization, so a probe can
    never surface another resource's data.
    """
    _require_board_permission(acting, permission)
    board = store.get_board(conn, board_id)
    if board is None:
        raise HTTPException(status_code=404, detail="board not found")
    if board.project_id and acting.project_id != board.project_id:
        raise HTTPException(
            status_code=403, detail="acting teammate belongs to another project"
        )
    if require_membership and not store.actor_can_access_board(conn, board_id, acting.id):
        raise HTTPException(
            status_code=403, detail="teammate is not a member of this board"
        )
    return board


def create_board_service(
    conn: sqlite3.Connection,
    owner: str,
    name: str,
    description: str = "",
    project_id: str = "",
    team_id: str | None = None,
    acting: Teammate | None = None,
) -> Board:
    if acting is not None:
        _require_board_permission(acting, "board.create")
        if acting.project_id and project_id and acting.project_id != project_id:
            raise HTTPException(
                status_code=403, detail="acting teammate belongs to another project"
            )
        if not project_id:
            project_id = acting.project_id
        # A bot creates the board on behalf of its workspace owner, so the
        # owner stays the human principal — otherwise the board would vanish
        # from the owner's board list. The creating bot joins as a member so
        # it keeps read access to what it made.
        project = store.get_project(conn, project_id)
        owner = (project.owner if project is not None else "") or owner or acting.id
    board = store.create_board(
        conn,
        owner=owner,
        name=name,
        description=description,
        project_id=project_id,
        team_id=team_id,
    )
    if acting is not None:
        store.create_board_member(
            conn,
            board_id=board.id,
            teammate_id=acting.id,
            role=BoardMemberRole.MEMBER.value,
        )
    return board


def delete_board_service(
    conn: sqlite3.Connection,
    board_id: str,
    acting: Teammate | None = None,
    require_approval: bool = False,
    approved_approval_id: str | None = None,
) -> Board:
    board = store.get_board(conn, board_id)
    if board is None:
        raise HTTPException(status_code=404, detail="board not found")
    if acting is not None:
        # Project isolation is part of the delete, not just the permission:
        # a bot may not delete a board outside its own workspace.
        authorize_board(conn, board_id, acting, "board.delete")
    if require_approval:
        if not approved_approval_id:
            raise HTTPException(
                status_code=409,
                detail="board deletion requires approval; request one first",
            )
        approval = store.get_approval(conn, approved_approval_id)
        if approval is None:
            raise HTTPException(status_code=404, detail="approval not found")
        if approval.board_id != board_id:
            raise HTTPException(status_code=400, detail="approval is not for this board")
        if approval.decision != Decision.APPROVED:
            raise HTTPException(
                status_code=409, detail="board deletion approval not granted"
            )
    return store.delete_board(conn, board_id)


def add_board_member_service(
    conn: sqlite3.Connection,
    board_id: str,
    teammate_id: str,
    role: str = BoardMemberRole.MEMBER.value,
    acting: Teammate | None = None,
) -> BoardMember:
    board = store.get_board(conn, board_id)
    if board is None:
        raise HTTPException(status_code=404, detail="board not found")
    if acting is not None:
        authorize_board(conn, board_id, acting, "teammate.create")
    return store.create_board_member(
        conn, board_id=board_id, teammate_id=teammate_id, role=role
    )


def remove_board_member_service(
    conn: sqlite3.Connection,
    board_id: str,
    teammate_id: str,
    acting: Teammate | None = None,
) -> None:
    board = store.get_board(conn, board_id)
    if board is None:
        raise HTTPException(status_code=404, detail="board not found")
    if acting is not None:
        authorize_board(conn, board_id, acting, "teammate.create")
    store.remove_board_member(conn, board_id, teammate_id)


def create_board_message_service(
    conn: sqlite3.Connection,
    board_id: str,
    content: str,
    *,
    to_board_id: str | None = None,
    from_teammate_id: str | None = None,
    to_teammate_id: str | None = None,
    kind: str = "message",
    acting: Teammate | None = None,
    permission: str = "board.message",
) -> BoardMessage:
    """Post a message on a board.

    ``acting`` turns this into a bot-scoped call: the teammate must hold
    ``permission`` (the HTTP route uses ``board.message``, the agent tool
    uses its own ``message.send``), the board must be in the teammate's
    project, and every bot-supplied target — ``to_board_id`` and
    ``to_teammate_id`` — is validated against authoritative state instead
    of being trusted, so a bot cannot address another workspace.
    """
    board = store.get_board(conn, board_id)
    if board is None:
        raise HTTPException(status_code=404, detail="board not found")
    if acting is not None:
        authorize_board(conn, board_id, acting, permission)
        if from_teammate_id is None:
            from_teammate_id = acting.id
        if to_teammate_id is not None:
            target = store.get_teammate(conn, to_teammate_id)
            if target is None:
                raise HTTPException(status_code=404, detail="teammate not found")
            if target.project_id != acting.project_id:
                raise HTTPException(
                    status_code=403,
                    detail="target teammate belongs to another project",
                )
        if to_board_id is not None:
            target_board = store.get_board(conn, to_board_id)
            if target_board is None:
                raise HTTPException(status_code=404, detail="target board not found")
            if target_board.project_id != acting.project_id:
                raise HTTPException(
                    status_code=403,
                    detail="target board belongs to another project",
                )
    return store.create_board_message(
        conn,
        board_id=board_id,
        content=content,
        to_board_id=to_board_id,
        from_teammate_id=from_teammate_id,
        to_teammate_id=to_teammate_id,
        kind=kind,
    )


def read_board_service(
    conn: sqlite3.Connection,
    board_id: str,
    acting: Teammate | None = None,
) -> dict[str, Any]:
    """Read one board (row, members, messages, inbox).

    The human owner path (``acting is None``) is never gated. The bot path
    requires the ``board.read`` permission *and* board membership (owner or
    member), so holding the permission is not enough to read a board the
    teammate is not part of.
    """
    if acting is not None:
        authorize_board(
            conn, board_id, acting, "board.read", require_membership=True
        )
    return board_detail_with_members(conn, board_id)


def request_board_approval(
    conn: sqlite3.Connection,
    board_id: str,
    action: str,
    requester: str,
    ttl_s: float = store.DEFAULT_APPROVAL_TTL_S,
) -> Approval:
    board = store.get_board(conn, board_id)
    if board is None:
        raise HTTPException(status_code=404, detail="board not found")
    return store.request_approval(
        conn,
        action=action,
        requester=requester,
        board_id=board_id,
        ttl_s=ttl_s,
    )


def list_boards_for_actor(
    conn: sqlite3.Connection,
    owner: str | None = None,
    project_id: str | None = None,
    acting: Teammate | None = None,
) -> list[Board]:
    if acting is None:
        return store.list_boards(conn, owner=owner, project_id=project_id)
    # Bot path: listing boards is a board read, so it needs the permission.
    _require_board_permission(acting, "board.read")
    boards = store.list_boards(conn, owner=owner, project_id=project_id)
    # Filter to boards the actor owns or is a member of (same rule enforced by
    # the agent board-read tool).
    return [b for b in boards if store.actor_can_access_board(conn, b.id, acting.id)]


def board_detail_with_members(
    conn: sqlite3.Connection, board_id: str
) -> dict[str, Any]:
    board = store.get_board(conn, board_id)
    if board is None:
        raise HTTPException(status_code=404, detail="board not found")
    members = store.list_board_members(conn, board_id)
    member_details: list[dict[str, Any]] = []
    for member in members:
        mate = store.get_teammate(conn, member.teammate_id)
        member_details.append(
            {
                "id": member.id,
                "board_id": member.board_id,
                "teammate_id": member.teammate_id,
                "teammate_persona": mate.persona if mate else "",
                "teammate_id_short": member.teammate_id[:8] if member.teammate_id else "",
                "role": member.role,
                "created_at": member.created_at.isoformat(),
            }
        )
    messages = store.list_board_messages(conn, board_id)
    inbox = store.list_board_messages_to(conn, board_id)
    return {
        "board": board.model_dump(mode="json"),
        "members": member_details,
        "messages": [m.model_dump(mode="json") for m in messages],
        "inbox": [m.model_dump(mode="json") for m in inbox],
    }
