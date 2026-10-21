"""Canonical permission catalogue.

One source of truth for every permission a teammate can hold, what it means,
and whether it is a plain permission or an admin permission that additionally
requires a human, digest-bound approval.

This module has no dependencies on the rest of the package on purpose:
:mod:`nerdbot.store` needs it to reject unknown permission names, and
:mod:`nerdbot.gates` needs it to check them, so it must sit below both.

The dashboard reads the same catalogue through ``GET /permissions`` instead of
hard-coding a list, so a permission that exists in the backend can never be
missing from the permission editor (and vice versa).
"""

from __future__ import annotations

from collections.abc import Iterable
from typing import Any

# Admin permissions: default-deny. Holding one is not enough — the action
# also needs a digest-bound, one-use human approval unless the teammate's
# ``tool_policy`` sets that permission to "auto".
ADMIN_PERMISSIONS: frozenset[str] = frozenset(
    {
        "teammate.create",
        "teammate.update",
        "teammate.delete",
        "team.create",
        "team.membership",
        "board.delete",
        "permission.change",
    }
)

# Agent permissions: holding the permission is sufficient to use the matching
# tool. Absent means deny.
AGENT_PERMISSIONS: frozenset[str] = frozenset(
    {
        "task.create",
        "task.assign",
        "task.delegate",
        "board.create",
        "board.message",
        "board.read",
        "memory.write",
        "knowledge.read",
        "message.send",
    }
)

ALL_PERMISSIONS: frozenset[str] = ADMIN_PERMISSIONS | AGENT_PERMISSIONS

# permission -> {kind, summary}. "kind" is "admin" or "agent".
PERMISSION_INFO: dict[str, dict[str, str]] = {
    "task.create": {
        "kind": "agent",
        "summary": "Create tasks inside the workspace.",
    },
    "task.assign": {
        "kind": "agent",
        "summary": "Assign an existing task to a teammate.",
    },
    "task.delegate": {
        "kind": "agent",
        "summary": "Delegate work to another bot and collect its result.",
    },
    "board.create": {
        "kind": "agent",
        "summary": "Create boards in the workspace.",
    },
    "board.message": {
        "kind": "agent",
        "summary": "Post messages on a board the bot belongs to.",
    },
    "board.read": {
        "kind": "agent",
        "summary": "Read boards the bot owns or is a member of.",
    },
    "memory.write": {
        "kind": "agent",
        "summary": "Write to the bot's own memory scope.",
    },
    "knowledge.read": {
        "kind": "agent",
        "summary": "Search workspace knowledge sources.",
    },
    "message.send": {
        "kind": "agent",
        "summary": "Send messages on a task board to a teammate.",
    },
    "teammate.create": {
        "kind": "admin",
        "summary": "Create bots. Requires the owner's exact-action approval.",
    },
    "teammate.update": {
        "kind": "admin",
        "summary": "Edit a bot's persona, instructions, or model. Approval-gated.",
    },
    "teammate.delete": {
        "kind": "admin",
        "summary": "Archive a bot. Approval-gated.",
    },
    "team.create": {
        "kind": "admin",
        "summary": "Create teams that group bots. Approval-gated.",
    },
    "team.membership": {
        "kind": "admin",
        "summary": "Add or remove bots on a team. Approval-gated.",
    },
    "board.delete": {
        "kind": "admin",
        "summary": "Delete a board. Approval-gated.",
    },
    "permission.change": {
        "kind": "admin",
        "summary": "Change what a bot is allowed to do. Approval-gated.",
    },
}


def is_known(permission: str) -> bool:
    return permission in ALL_PERMISSIONS


def unknown_permissions(permissions: object) -> list[str]:
    """The permission names in ``permissions`` the catalogue does not know.

    Accepts any iterable of names (list, set, ``dict_keys``); a non-iterable
    yields no unknown names rather than raising, so a malformed payload is
    rejected by the caller's own validation, not here.
    """
    if isinstance(permissions, (str, bytes)) or permissions is None:
        return []
    if not isinstance(permissions, Iterable):
        return []
    names = {str(p) for p in permissions}
    return sorted(name for name in names if name not in ALL_PERMISSIONS)


def catalog() -> list[dict[str, Any]]:
    """The full catalogue, admin permissions first, for the UI."""
    entries: list[dict[str, Any]] = []
    for name in sorted(ALL_PERMISSIONS):
        info = PERMISSION_INFO.get(name, {"kind": "agent", "summary": ""})
        entries.append(
            {
                "name": name,
                "kind": info["kind"],
                "summary": info["summary"],
                "requires_approval": info["kind"] == "admin",
            }
        )
    entries.sort(key=lambda e: (e["kind"] != "admin", e["name"]))
    return entries
