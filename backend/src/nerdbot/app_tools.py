"""App-level agent tools: permission-checked workspace operations.

These tools give a model-driven teammate real capabilities inside the
workspace: inspect files, list/create/assign tasks, delegate to other bots
(with bounded nesting and cycle prevention), read and send messages on the
response channel, search knowledge, and manage fleet (teammates/teams/boards)
when permitted.

Every mutating tool runs through :mod:`nerdbot.gates` server-side — the
model's prompt never grants anything. Admin operations (teammate/team/board
management) are default-deny and digest-bound-approval gated unless the
teammate's tool_policy sets them to ``"auto"``. Gate outcomes are returned as
plain tool results so the model can report them; only unknown tools and bad
arguments raise.
"""

from __future__ import annotations

import json
import sqlite3
from pathlib import Path
from typing import Any

from fastapi import HTTPException

from . import agent_context as agent_context_mod
from . import boards, fleet, gates, orchestrator, store
from . import decomposition as decomposition_mod
from . import delegation as delegation_mod
from .agent_context import AgentContext
from .agent_tools import truncate_output
from .models import (
    Delegation,
    DelegationStatus,
    Provider,
    ProviderKind,
    ProviderStatus,
    Task,
    TaskStatus,
    Teammate,
    TeammateStatus,
)


def _run_budget_s(data_dir: str) -> float:
    """Agent-run wall-clock budget shared with the API/executor knob.

    Same semantics as ``api._run_wall_clock_s`` (duplicated locally because
    ``api`` imports this module — importing upward would be circular).
    """
    del data_dir
    import os as _os

    raw = _os.environ.get("NERDBOT_RUN_TIMEOUT_S", "60")
    try:
        value = float(raw)
    except ValueError as exc:
        raise ValueError("NERDBOT_RUN_TIMEOUT_S must be a number of seconds") from exc
    if value <= 0:
        raise ValueError("NERDBOT_RUN_TIMEOUT_S must be positive")
    return value


MAX_AWAIT_CHILDREN = 10
CHILD_RESULT_MAX_CHARS = 4000


def _schemas(name: str, description: str, properties: dict[str, Any], required: list[str]) -> dict[str, Any]:
    return {
        "type": "function",
        "function": {
            "name": name,
            "description": description,
            "parameters": {
                "type": "object",
                "properties": properties,
                "required": required,
            },
        },
    }


# Ambient tools need an acting identity but no explicit permission: they only
# read what the identity itself is entitled to (own inbox, own memory), or
# they act on work addressed to the identity itself (``respond_to_delegation``
# — only the delegatee may decide, so it needs no permission beyond being the
# recipient).
AMBIENT_TOOLS = frozenset(
    {
        "inspect_workspace",
        "list_tasks",
        "get_task",
        "read_messages",
        "read_memory",
        "respond_to_delegation",
        "list_providers",
    }
)

# tool name -> required permission (ambient tools are absent from this map).
TOOL_PERMISSIONS: dict[str, str] = {
    "create_task": "task.create",
    "propose_plan": "task.create",
    "apply_plan": "task.create",
    "assign_task": "task.assign",
    "delegate_task": "task.delegate",
    "await_delegations": "task.delegate",
    "check_delegations": "task.delegate",
    "cancel_delegation": "task.delegate",
    "retry_delegation": "task.delegate",
    "list_teammates": "task.delegate",
    "send_message": "message.send",
    "read_knowledge": "knowledge.read",
    "write_memory": "memory.write",
    "create_board": "board.create",
    "read_board": "board.read",
    "delete_board": "board.delete",
    "create_teammate": "teammate.create",
    "update_teammate": "teammate.update",
    "archive_teammate": "teammate.delete",
    "create_team": "team.create",
    "add_teammate_to_team": "team.membership",
}

APP_TOOL_NAMES = frozenset(
    AMBIENT_TOOLS
    | set(TOOL_PERMISSIONS)
)


def app_tool_schemas(permissions: frozenset[str] | set[str]) -> list[dict[str, Any]]:
    """Schemas for the tools this identity may call (fail-closed filter)."""
    granted = set(permissions)
    schemas: list[dict[str, Any]] = [
        _schemas(
            "inspect_workspace",
            "List files and git status of your task workspace.",
            {},
            [],
        ),
        _schemas(
            "list_tasks",
            "List tasks in this workspace, optionally filtered by status.",
            {
                "status": {"type": "string", "description": "pending|running|done|failed|blocked|ready"},
            },
            [],
        ),
        _schemas(
            "get_task",
            "Fetch one task by id, including its child tasks and delegations.",
            {"task_id": {"type": "string"}},
            ["task_id"],
        ),
        _schemas(
            "read_messages",
            "Read messages addressed to you on this task's board.",
            {"limit": {"type": "integer"}},
            [],
        ),
        _schemas(
            "read_memory",
            "Read your own memory scopes (personal and, if shared, project).",
            {"limit": {"type": "integer"}},
            [],
        ),
        _schemas(
            "respond_to_delegation",
            "Decide whether you accept work that was delegated to you. Call this"
            " before starting a delegated task: 'accepted' takes the work,"
            " 'declined' (with a reason) refuses it. Only work addressed to you"
            " can be decided.",
            {
                "delegation_id": {
                    "type": "string",
                    "description": "defaults to the delegation that handed you this task",
                },
                "decision": {"type": "string", "description": "accepted or declined"},
                "reason": {"type": "string", "description": "why you decline"},
            },
            ["decision"],
        ),
        _schemas(
            "list_providers",
            "List the model providers configured in this workspace (id, name, kind,"
            " model). Use it to find the provider_id to attach to a bot you"
            " create. Secrets are never returned.",
            {},
            [],
        ),
    ]
    if "task.create" in granted:
        schemas.append(
            _schemas(
                "create_task",
                "Create a new task in this workspace.",
                {
                    "description": {"type": "string"},
                    "command": {"type": "string"},
                    "owner_teammate_id": {"type": "string"},
                },
                ["description"],
            )
        )
        schemas.append(
            _schemas(
                "propose_plan",
                "Ask the planner model to split your objective into an ordered"
                " plan of subtasks with dependencies, then validate it. No work"
                " is created yet. Read the returned plan, correct it if needed,"
                " and hand it to apply_plan to create the real tasks.",
                {"objective": {"type": "string"}},
                ["objective"],
            )
        )
        schemas.append(
            _schemas(
                "apply_plan",
                "Create the real subtasks for a plan (from propose_plan, or one"
                " you wrote). The server re-validates every rule before creating"
                " anything: an invalid plan is rejected whole, never partially"
                " executed. By default the tasks are created on your task's"
                " board.",
                {
                    "plan": {
                        "type": "object",
                        "description": (
                            'plan object like {"tasks": [{"description": ...,'
                            ' "command": ..., "depends_on": [indices],'
                            ' "owner_teammate_id": ...}]}'
                        ),
                    },
                    "objective": {"type": "string"},
                    "create_board": {
                        "type": "boolean",
                        "description": (
                            "true to create a dedicated board (needs"
                            " board.create); omit to hang the tasks on your"
                            " task's board, or false for no board"
                        ),
                    },
                    "board_name": {"type": "string"},
                },
                ["plan"],
            )
        )
    if "task.assign" in granted:
        schemas.append(
            _schemas(
                "assign_task",
                "Assign a task to a teammate (or unassign with empty id).",
                {
                    "task_id": {"type": "string"},
                    "teammate_id": {"type": "string"},
                },
                ["task_id", "teammate_id"],
            )
        )
    if "task.delegate" in granted:
        schemas.append(
            _schemas(
                "delegate_task",
                "Delegate work on your task (or a subtask) to another bot. Creates"
                " a child task owned by the delegatee and a delegation the"
                " delegatee must accept or decline. It is not assumed to be"
                " accepted: use await_delegations or check_delegations to learn"
                " the real outcome.",
                {
                    "to_teammate_id": {"type": "string"},
                    "description": {
                        "type": "string",
                        "description": "the objective the delegatee must achieve",
                    },
                    "scope": {
                        "type": "string",
                        "description": "the bounded scope of the delegated work",
                    },
                    "context": {
                        "type": "string",
                        "description": "context the delegatee needs (facts, files, constraints)",
                    },
                    "command": {"type": "string", "description": "optional command for the child's run"},
                    "reason": {"type": "string"},
                    "task_id": {"type": "string", "description": "defaults to your current task"},
                    "timeout_s": {
                        "type": "number",
                        "description": "how long the delegatee may take before the delegation times out",
                    },
                },
                ["to_teammate_id", "description"],
            )
        )
        schemas.append(
            _schemas(
                "list_teammates",
                "List the bots you may delegate to, with their role, capabilities,"
                " permissions, whether a model is attached, and whether they are"
                " currently busy. Use it to pick a delegatee before delegating.",
                {},
                [],
            )
        )
        schemas.append(
            _schemas(
                "await_delegations",
                "Run your pending delegated child tasks NOW (blocking) and collect"
                " their real results. Prefer check_delegations for already-finished work.",
                {},
                [],
            )
        )
        schemas.append(
            _schemas(
                "check_delegations",
                "Non-blocking: read status and results of your delegated child"
                " tasks without running anything. Use after the executor has run"
                " children asynchronously.",
                {},
                [],
            )
        )
        schemas.append(
            _schemas(
                "cancel_delegation",
                "Cancel a delegated child task before it runs. Pass delegation_id,"
                " or omit it to cancel the delegation that created this task"
                " (how a delegatee withdraws from work it was handed).",
                {"delegation_id": {"type": "string"}},
                [],
            )
        )
        schemas.append(
            _schemas(
                "retry_delegation",
                "Re-delegate work that failed, was declined, or timed out. Creates a"
                " fresh child task and delegation with the same objective. Bounded"
                " by a retry limit.",
                {
                    "delegation_id": {"type": "string"},
                    "to_teammate_id": {
                        "type": "string",
                        "description": "optional different delegatee for the retry",
                    },
                },
                ["delegation_id"],
            )
        )
    if "message.send" in granted:
        schemas.append(
            _schemas(
                "send_message",
                "Send a message on this task's board to a teammate or board.",
                {
                    "content": {"type": "string"},
                    "to_teammate_id": {"type": "string"},
                    "to_board_id": {"type": "string"},
                },
                ["content"],
            )
        )
    if "knowledge.read" in granted:
        schemas.append(
            _schemas(
                "read_knowledge",
                "Search workspace knowledge sources for relevant citations.",
                {
                    "query": {"type": "string"},
                    "top_k": {"type": "integer"},
                },
                ["query"],
            )
        )
    if "memory.write" in granted:
        schemas.append(
            _schemas(
                "write_memory",
                "Write one entry to your own memory scope.",
                {
                    "content": {"type": "string"},
                    "confidence": {"type": "number"},
                },
                ["content"],
            )
        )
    if "board.create" in granted:
        schemas.append(
            _schemas(
                "create_board",
                "Create a new board (workspace container) in this project.",
                {"name": {"type": "string"}, "description": {"type": "string"}},
                ["name"],
            )
        )
    if "board.read" in granted:
        schemas.append(
            _schemas(
                "read_board",
                "Read a board you are a member of: its description, member bots,"
                " and message feed.",
                {"board_id": {"type": "string"}},
                ["board_id"],
            )
        )
    if "board.delete" in granted:
        schemas.append(
            _schemas(
                "delete_board",
                "Delete a board by id. Requires owner approval.",
                {"board_id": {"type": "string"}},
                ["board_id"],
            )
        )
    if "teammate.create" in granted:
        schemas.append(
            _schemas(
                "create_teammate",
                "Create a teammate (bot) in this workspace. Requires owner approval."
                " Permissions granted cannot exceed your own. Attach a model with"
                " provider_id so the new bot can run tasks; otherwise the owner must"
                " attach one before it can work.",
                {
                    "persona": {"type": "string", "description": "short role label, e.g. 'engineering specialist'"},
                    "instructions": {"type": "string"},
                    "permissions": {"type": "array", "items": {"type": "string"}},
                    "memory_scope": {
                        "type": "string",
                        "description": "project (share workspace memory) or private",
                    },
                    "provider_id": {
                        "type": "string",
                        "description": "model provider id from this workspace (optional)",
                    },
                },
                ["persona"],
            )
        )
    if "teammate.update" in granted:
        schemas.append(
            _schemas(
                "update_teammate",
                "Update a teammate's persona, instructions, or provider."
                " Requires owner approval.",
                {
                    "teammate_id": {"type": "string"},
                    "persona": {"type": "string"},
                    "instructions": {"type": "string"},
                    "provider_id": {
                        "type": "string",
                        "description": "model provider id from this workspace",
                    },
                },
                ["teammate_id"],
            )
        )
    if "teammate.delete" in granted:
        schemas.append(
            _schemas(
                "archive_teammate",
                "Archive a teammate (removes it from the active fleet)."
                " Requires owner approval.",
                {"teammate_id": {"type": "string"}},
                ["teammate_id"],
            )
        )
    if "team.create" in granted:
        schemas.append(
            _schemas(
                "create_team",
                "Create a team grouping bots (and/or workspaces). Requires owner"
                " approval. Pass bot ids in member_ids.",
                {
                    "name": {"type": "string"},
                    "description": {"type": "string"},
                    "member_ids": {
                        "type": "array",
                        "items": {"type": "string"},
                        "description": "teammate (bot) ids to include",
                    },
                },
                ["name"],
            )
        )
    if "team.membership" in granted:
        schemas.append(
            _schemas(
                "add_teammate_to_team",
                "Add an existing bot to an existing team. Requires owner approval.",
                {
                    "team_id": {"type": "string"},
                    "teammate_id": {"type": "string"},
                },
                ["team_id", "teammate_id"],
            )
        )
    return schemas


def execute_app_tool(
    ctx: AgentContext,
    name: str,
    arguments: dict[str, Any],
    *,
    data_dir: str = ".",
    run_id: str = "",
    workspace_path: str | None = None,
) -> str:
    """Execute one app tool call for the acting identity in ``ctx``.

    Returns bounded, human/model-readable text. Gate denials and required
    approvals are returned as normal results (never exceptions) so the model
    can report them to the user.
    """
    try:
        return _dispatch(ctx, name, arguments, data_dir, run_id, workspace_path)
    except HTTPException as exc:
        return f"tool error (HTTP {exc.status_code}): {exc.detail}"
    except gates.GateDenied as exc:
        # Gate denials are results, not crashes: the model must be able to
        # report them to the user instead of failing the whole run.
        return f"permission denied: {exc}"
    except gates.GateApprovalRequired as exc:
        return _approval_result(exc)


def _resolve_actor(ctx: AgentContext) -> Teammate:
    """Resolve the acting teammate from authoritative state (fail closed).

    The identity carried on the context is only a claim. It is re-read from
    the store and must still exist, still be active, still belong to the
    task's project, and still be the task's owner. Anything else is denied
    rather than trusted, so a stale or forged context cannot act.
    """
    claimed = ctx.teammate
    if claimed is None:
        raise gates.GateDenied("app tools require an acting teammate identity")
    mate = store.get_teammate(ctx.conn, claimed.id)
    if mate is None:
        raise gates.GateDenied(f"acting teammate {claimed.id} does not exist")
    if mate.status != TeammateStatus.ACTIVE:
        raise gates.GateDenied(f"acting teammate {mate.id} is not active")
    if mate.project_id != ctx.task.project_id:
        raise gates.GateDenied(
            f"acting teammate {mate.id} belongs to another project"
        )
    owner_id = ctx.task.owner_teammate_id
    if owner_id and owner_id != mate.id:
        raise gates.GateDenied(
            f"acting teammate {mate.id} does not own task {ctx.task.id}"
        )
    return mate


def _dispatch(
    ctx: AgentContext,
    name: str,
    args: dict[str, Any],
    data_dir: str,
    run_id: str,
    workspace_path: str | None,
) -> str:
    # Every tool acts as a validated teammate: the identity is re-checked
    # against the store before any handler runs.
    mate = _resolve_actor(ctx)
    conn = ctx.conn
    task = ctx.task

    # -- Ambient reads -------------------------------------------------------
    if name == "inspect_workspace":
        from . import workspace as workspace_mod

        ws: Path | None = None
        if workspace_path:
            # Inside a run this is the adapter's own workspace: authoritative
            # for this run, wherever the runtime mounted it.
            ws = Path(workspace_path)
        elif task.workspace_path:
            # Standalone fallback (outside a run). A DB-stored path is only a
            # claim, so it is accepted only when it *is* the canonical
            # per-task workspace under this deployment's data dir. A stale or
            # poisoned path is refused, never read.
            canonical = workspace_mod.workspace_path_for_task(data_dir, task.id)
            if Path(task.workspace_path).resolve() == canonical.resolve():
                ws = canonical
        if ws is None or not ws.exists():
            return "no workspace directory exists for this task yet"
        lines: list[str] = []
        for path in sorted(ws.rglob("*")):
            if ".git" in path.parts:
                continue
            if path.is_file():
                rel = path.relative_to(ws)
                lines.append(f"{path.stat().st_size:>10} {rel}")
            if len(lines) >= 200:
                lines.append("... [listing truncated]")
                break
        try:
            import subprocess

            status = subprocess.run(
                ["git", "status", "--short"],
                cwd=str(ws),
                capture_output=True,
                text=True,
                timeout=10.0,
            )
            if status.stdout.strip():
                lines.append("")
                lines.append("git status:")
                lines.append(status.stdout.strip())
        except Exception:
            pass
        return truncate_output("\n".join(lines) or "(empty workspace)")

    if name == "list_tasks":
        status_filter = args.get("status")
        tasks = store.list_tasks_for_project(conn, task.project_id)
        if status_filter:
            tasks = [t for t in tasks if t.status.value == str(status_filter)]
        lines = [
            f"{t.id} [{t.status.value}] owner={t.owner_teammate_id or '-'} {t.description[:120]}"
            for t in tasks[:100]
        ]
        return truncate_output("\n".join(lines) or "(no tasks)")

    if name == "get_task":
        target = store.get_task(conn, str(args.get("task_id", "")))
        if target is None or target.project_id != task.project_id:
            return "tool error: task not found in this project"
        children = store.list_child_tasks(conn, target.id)
        delegations = store.list_delegations_for_task(conn, target.id)
        lines = [
            f"task {target.id} [{target.status.value}]",
            f"description: {target.description}",
            f"owner: {target.owner_teammate_id or '-'}",
            f"parent: {target.parent_task_id or '-'}",
        ]
        for d in delegations:
            line = f"delegation {d.id} to {d.to_teammate_id}: {d.status.value}"
            if d.result:
                line += f" result: {d.result[:CHILD_RESULT_MAX_CHARS]}"
            lines.append(line)
        for c in children:
            lines.append(f"child {c.id} [{c.status.value}]: {c.description[:200]}")
        return truncate_output("\n".join(lines))

    if name == "read_messages":
        limit = min(int(args.get("limit", 20) or 20), 50)
        messages = store.list_messages_for_teammate(
            conn, mate.id, board_id=task.board_id or None, limit=limit
        )
        if not messages:
            return "(no messages for you)"
        lines = [
            f"[{m.created_at.isoformat()}] {m.kind} from={m.from_teammate_id or 'owner'}: {m.content}"
            for m in messages
        ]
        return truncate_output("\n".join(lines))

    if name == "read_memory":
        limit = min(int(args.get("limit", 10) or 10), 20)
        lines = []
        # Recompute the scopes from the validated identity: the shared project
        # scope is only readable when the teammate's own memory_scope grants it.
        for mem_scope in agent_context_mod.memory_scopes_for(conn, task, mate):
            for entry in store.recall_memory(conn, mem_scope, limit=limit):
                lines.append(f"[{mem_scope} · {entry.source}] {entry.content}")
        return truncate_output("\n".join(lines) or "(your memory is empty)")

    if name == "list_providers":
        lines = []
        for provider in store.list_providers(conn, task.project_id):
            if provider.status != ProviderStatus.ACTIVE:
                continue
            model = provider.config.get("model", "") if isinstance(provider.config, dict) else ""
            lines.append(
                f"{provider.id} name={provider.name!r} kind={provider.kind.value}"
                f" model={model or '-'}"
            )
        return truncate_output("\n".join(lines) or "(no active providers in this workspace)")

    # -- Permission-gated tools ---------------------------------------------
    permission = TOOL_PERMISSIONS.get(name)
    if permission is not None:
        gates.check_permission(mate, permission)

    if name == "create_task":
        try:
            child = store.create_task(
                conn,
                task.project_id,
                description=str(args.get("description", "")),
                command=str(args.get("command", "")),
                owner_teammate_id=_opt_str(args.get("owner_teammate_id")),
                board_id=task.board_id,
            )
        except (KeyError, ValueError) as exc:
            return f"tool error: {exc}"
        return f"created task {child.id}: {child.description[:200]}"

    if name == "propose_plan":
        return _propose_plan(ctx, args)

    if name == "apply_plan":
        return _apply_plan(ctx, args)

    if name == "assign_task":
        target_id = str(args.get("task_id", ""))
        target = store.get_task(conn, target_id)
        if target is None or target.project_id != task.project_id:
            return "tool error: task not found in this project"
        teammate_id = _opt_str(args.get("teammate_id"))
        if teammate_id is not None:
            assignee = store.get_teammate(conn, teammate_id)
            if assignee is None or assignee.project_id != task.project_id:
                return "tool error: teammate not found in this project"
        try:
            updated = store.assign_task_owner(conn, target_id, teammate_id)
        except (KeyError, ValueError) as exc:
            return f"tool error: {exc}"
        return f"task {updated.id} owner is now {updated.owner_teammate_id or 'none'}"

    if name == "delegate_task":
        return _delegate_task(ctx, args, data_dir)

    if name == "list_teammates":
        return _list_teammates(ctx)

    if name == "respond_to_delegation":
        return _respond_to_delegation(ctx, args)

    if name == "await_delegations":
        return _await_delegations(ctx, data_dir)

    if name == "check_delegations":
        return _check_delegations(ctx)

    if name == "cancel_delegation":
        return _cancel_delegation(ctx, args)

    if name == "retry_delegation":
        return _retry_delegation(ctx, args)

    if name == "send_message":
        if not task.board_id:
            return "tool error: this task is not attached to a board"
        try:
            message = boards.create_board_message_service(
                conn,
                task.board_id,
                str(args.get("content", "")),
                to_board_id=_opt_str(args.get("to_board_id")),
                to_teammate_id=_opt_str(args.get("to_teammate_id")),
                from_teammate_id=mate.id,
                acting=mate,
                permission="message.send",
            )
        except HTTPException as exc:
            return _gate_result(exc)
        return f"sent message {message.id}"

    if name == "read_board":
        board_id = str(args.get("board_id", ""))
        try:
            detail = boards.read_board_service(conn, board_id, acting=mate)
        except HTTPException as exc:
            return _gate_result(exc)
        board = detail["board"]
        lines = [
            f"board {board['id']} name={board['name']!r}"
            f" project={board.get('project_id', '')}",
        ]
        if board.get("description"):
            lines.append(f"description: {board['description']}")
        members = detail.get("members", [])
        if members:
            lines.append(
                "members: "
                + ", ".join(
                    f"{m['teammate_id']} ({m.get('role', 'member')})" for m in members
                )
            )
        for message in detail.get("messages", [])[-20:]:
            lines.append(
                f"[{message.get('kind', 'message')}]"
                f" from={message.get('from_teammate_id') or 'owner'}:"
                f" {message.get('content', '')}"
            )
        return truncate_output("\n".join(lines))

    if name == "read_knowledge":
        from . import knowledge as knowledge_mod

        citations = knowledge_mod.retrieve(
            conn, task.project_id, str(args.get("query", "")),
            top_k=min(int(args.get("top_k", 3) or 3), 10),
        )
        if not citations:
            return "(no citations found)"
        lines = [
            f"[{c['source_title']}] ({c['source']}) confidence={c['confidence']}: "
            f"{c['excerpt'][:200]}"
            for c in citations
        ]
        return truncate_output("\n".join(lines))

    if name == "write_memory":
        content = str(args.get("content", "")).strip()
        if not content:
            return "tool error: empty memory content"
        scopes = agent_context_mod.memory_scopes_for(conn, task, mate)
        scope = next((s for s in scopes if s.startswith("teammate:")), None)
        if scope is None:
            return "tool error: no personal memory scope for this identity"
        confidence = float(args.get("confidence", 0.5) or 0.5)
        entry = store.write_memory(
            conn, scope, content, source=f"teammate:{mate.id}:{run_id or 'adhoc'}",
            confidence=max(0.0, min(confidence, 1.0)),
        )
        return f"stored memory {entry.id} in {scope}"

    if name == "create_board":
        try:
            board = boards.create_board_service(
                conn,
                owner=mate.id,
                name=str(args.get("name", "")),
                description=str(args.get("description", "")),
                project_id=task.project_id,
                acting=mate,
            )
        except HTTPException as exc:
            return _gate_result(exc)
        return f"created board {board.id}: {board.name}"

    if name == "delete_board":
        board_id = str(args.get("board_id", ""))
        # Scope first: a bot may not even ask for approval to delete a board
        # outside its own workspace.
        try:
            boards.authorize_board(conn, board_id, mate, "board.delete")
        except HTTPException as exc:
            return _gate_result(exc)
        try:
            gates.require(
                conn, mate, "board.delete",
                payload={"board_id": board_id}, run_id=run_id, task_id=task.id,
            )
        except gates.GateDenied as exc:
            return f"permission denied: {exc}"
        except gates.GateApprovalRequired as exc:
            return _approval_result(exc)
        try:
            boards.delete_board_service(conn, board_id, acting=mate)
        except HTTPException as exc:
            return _gate_result(exc)
        return f"deleted board {board_id}"

    if name == "create_teammate":
        memory_scope = str(args.get("memory_scope", "") or "").strip()
        try:
            new_mate = fleet.create_teammate_service(
                conn,
                task.project_id,
                persona=str(args.get("persona", "")),
                instructions=str(args.get("instructions", "")),
                permissions=[str(p) for p in args.get("permissions", []) or []],
                memory_scope=memory_scope if memory_scope in ("project", "private") else "project",
                provider_id=_opt_str(args.get("provider_id")),
                acting=mate,
            )
        except HTTPException as exc:
            return _gate_result(exc)
        provider_note = (
            f" provider={new_mate.provider_id}"
            if new_mate.provider_id
            else " The owner must attach a model provider before it can run tasks."
        )
        return (
            f"created teammate {new_mate.id} persona={new_mate.persona!r}"
            f" permissions={new_mate.permissions} memory_scope={new_mate.memory_scope}."
            f"{provider_note}"
        )

    if name == "update_teammate":
        updates: dict[str, Any] = {}
        for field in ("persona", "instructions"):
            if isinstance(args.get(field), str):
                updates[field] = args[field]
        provider_id = _opt_str(args.get("provider_id"))
        if provider_id is not None:
            updates["provider_id"] = provider_id
        if not updates:
            return "tool error: nothing to update"
        try:
            updated_mate = fleet.update_teammate_service(
                conn, str(args.get("teammate_id", "")), updates, acting=mate
            )
        except HTTPException as exc:
            return _gate_result(exc)
        return f"updated teammate {updated_mate.id}"

    if name == "archive_teammate":
        teammate_id = str(args.get("teammate_id", ""))
        if teammate_id == mate.id:
            return "tool error: cannot archive yourself"
        try:
            archived = fleet.set_teammate_status_service(
                conn, teammate_id, TeammateStatus.ARCHIVED, acting=mate
            )
        except HTTPException as exc:
            return _gate_result(exc)
        return f"archived teammate {archived.id}"

    if name == "create_team":
        try:
            team = fleet.create_team_service(
                conn,
                owner=mate.id,
                name=str(args.get("name", "")),
                description=str(args.get("description", "")),
                project_id=task.project_id,
                member_ids=[str(m) for m in args.get("member_ids", []) or []],
                acting=mate,
            )
        except HTTPException as exc:
            return _gate_result(exc)
        return f"created team {team.id}: {team.name}"

    if name == "add_teammate_to_team":
        try:
            member = fleet.add_teammate_to_team_service(
                conn,
                str(args.get("team_id", "")),
                str(args.get("teammate_id", "")),
                acting=mate,
            )
        except HTTPException as exc:
            return _gate_result(exc)
        return f"added teammate {member.teammate_id} to team {member.team_id}"

    raise ValueError(f"unknown app tool: {name!r}")


def _active_teammate_ids(conn: sqlite3.Connection, project_id: str) -> set[str]:
    return {
        m.id
        for m in store.list_all_teammates(conn)
        if m.project_id == project_id and m.status == TeammateStatus.ACTIVE
    }


def _validate_plan_for(plan: decomposition_mod.Plan, *, project_id: str, acting_id: str,
                       known: set[str]) -> list[str]:
    return decomposition_mod.validate_plan(
        plan,
        project_id=project_id,
        acting_teammate_id=acting_id,
        known_teammate_ids=known,
    )


def _chat_provider_for(
    conn: sqlite3.Connection, project_id: str, mate: Teammate
) -> Provider | None:
    """The planner model for this bot: its own attached model when it can
    chat, else the project's planner provider (fail closed to None)."""
    if mate.provider_id:
        provider = store.get_provider(conn, mate.provider_id)
        if provider is not None and provider.kind != ProviderKind.LOCAL:
            return provider
    return decomposition_mod.resolve_provider(conn, project_id)


def _propose_plan(ctx: AgentContext, args: dict[str, Any]) -> str:
    """Plan leg: the planner model drafts the plan, the server validates it.

    Side-effect free: nothing is created. The model reads the returned plan,
    may edit it, and decides whether (and how) to apply it.
    """
    mate = _resolve_actor(ctx)
    conn = ctx.conn
    task = ctx.task
    objective = str(args.get("objective", "")).strip()
    if not objective:
        return "tool error: propose_plan needs an objective"
    provider = _chat_provider_for(conn, task.project_id, mate)
    if provider is None:
        return "tool error: no provider available for planning"
    try:
        plan = decomposition_mod.plan_objective(conn, task.project_id, objective, provider)
    except Exception as exc:
        return f"tool error: plan generation failed: {exc}"
    problems = _validate_plan_for(
        plan,
        project_id=task.project_id,
        acting_id=ctx.teammate.id if ctx.teammate else "",
        known=_active_teammate_ids(conn, task.project_id),
    )
    store.record_event(conn, task.project_id, "plan", task.id, "plan.proposed")
    payload = json.dumps(plan.model_dump(), indent=2)
    if problems:
        return (
            "plan proposed but REJECTED by validation (edit it, then apply the"
            " corrected version):\n- "
            + "\n- ".join(problems)
            + "\nplan:\n"
            + payload
        )
    return (
        "plan proposed and validated (NOTHING created yet). Review it; call"
        " apply_plan with this plan (or your corrected version of it):\n"
        + payload
    )


def _apply_plan(ctx: AgentContext, args: dict[str, Any]) -> str:
    """Apply leg: create the real tasks for a plan, after re-validation.

    The model decides the plan; the server validates every rule against live
    state and enforces the gates. An invalid plan is rejected whole — never
    partially executed.
    """
    mate = _resolve_actor(ctx)
    conn = ctx.conn
    task = ctx.task
    payload = args.get("plan")
    if isinstance(payload, str):
        try:
            payload = json.loads(payload)
        except ValueError:
            payload = None
        if not isinstance(payload, dict):
            return 'tool error: the plan must be a JSON object like {"tasks": [...]}'
    if not isinstance(payload, dict):
        return 'tool error: the plan must be a JSON object like {"tasks": [...]}'
    try:
        plan = decomposition_mod.Plan.model_validate(payload)
    except Exception as exc:
        return f"tool error: invalid plan: {exc}"

    create_board: bool | None = (
        None
        if not isinstance(args.get("create_board"), bool)
        else args["create_board"]
    )
    if create_board is True and not gates.has_permission(mate, "board.create"):
        return (
            "permission denied: board.create is required to create a dedicated"
            " plan board. Call apply_plan again with create_board=false to hang"
            " the tasks on your task's board instead."
        )
    if create_board is None and not task.board_id and not gates.has_permission(
        mate, "board.create"
    ):
        create_board = False  # no home board, no board.create: standalone tasks

    cross = sorted(
        {s.owner_teammate_id.strip() for s in plan.tasks} - {"", mate.id}
    )
    if cross and not gates.has_permission(mate, "task.assign"):
        return (
            "permission denied: the plan assigns steps to other bots ("
            + ", ".join(cross)
            + "), which needs task.assign. Keep the steps yours, or delegate"
            " work with delegate_task instead."
        )

    problems = _validate_plan_for(
        plan,
        project_id=task.project_id,
        acting_id=mate.id,
        known=_active_teammate_ids(conn, task.project_id),
    )
    if problems:
        return (
            "plan rejected — NOTHING was created:\n- "
            + "\n- ".join(problems)
            + "\nCorrect the plan and call apply_plan again."
        )

    attach_board_id: str | None = None
    if create_board is False and task.board_id:
        attach_board_id = task.board_id
    elif create_board is None and task.board_id:
        # Default: hang the plan's tasks on the task's own board.
        attach_board_id = task.board_id
        create_board = False
    elif create_board is None:
        # No home board: create the plan's own board (board.create was
        # already checked above).
        create_board = True
    try:
        result = decomposition_mod.materialize_plan(
            conn,
            task.project_id,
            plan,
            objective=str(args.get("objective", "")),
            board_name=_opt_str(args.get("board_name")),
            create_board=False if attach_board_id is not None else bool(create_board),
            attach_board_id=attach_board_id,
            acting_teammate_id=mate.id,
        )
    except (KeyError, ValueError) as exc:
        return f"tool error: {exc}"
    store.record_event(conn, task.project_id, "plan", task.id, "plan.applied")
    board_info = (result.get("board") or {}).get("id")
    tasks: list[dict[str, Any]] = result.get("tasks", [])
    lines = [
        f"applied plan: created {len(tasks)} tasks"
        + (f" on board {board_info}" if board_info else " (no board)")
    ]
    for t in tasks:
        lines.append(
            f"- task {t['id']} [{t.get('owner_teammate_id') or 'unowned'}]:"
            f" {t['description'][:120]}"
            f" depends_on={t.get('dependencies') or []}"
        )
    lines.append(
        "Ordered tasks run in dependency order once executable (the executor"
        " sweep claims unowned tasks); tasks kept by you wait to be run or"
        " handed off with delegate_task."
    )
    return truncate_output("\n".join(lines))


def _delegate_task(ctx: AgentContext, args: dict[str, Any], data_dir: str) -> str:
    """Hand work to another bot. The delegation starts PENDING: the delegatee
    decides whether to take it."""
    mate = _resolve_actor(ctx)
    conn = ctx.conn
    parent_id = str(args.get("task_id") or ctx.task.id)
    parent = store.get_task(conn, parent_id)
    if parent is None or parent.project_id != ctx.task.project_id:
        return "tool error: task not found in this project"
    try:
        delegation = delegation_mod.delegate(
            conn,
            parent_task=parent,
            requester=mate,
            to_teammate_id=str(args.get("to_teammate_id", "")),
            objective=str(args.get("description", "")),
            scope=str(args.get("scope", "")),
            context=str(args.get("context", "") or args.get("reason", "")),
            command=str(args.get("command", "")),
            timeout_s=float(args.get("timeout_s", delegation_mod.DEFAULT_DELEGATION_TIMEOUT_S) or 0),
        )
    except delegation_mod.DelegationError as exc:
        return f"tool error: {exc}"
    except (KeyError, ValueError) as exc:
        return f"tool error: {exc}"
    del data_dir  # child execution happens via sweep/await, not here
    target = store.get_teammate(conn, delegation.to_teammate_id)
    ready = "it has a model attached" if (target and target.provider_id) else (
        "it has NO model attached — the owner must attach one before it can accept"
    )
    return (
        f"delegated: child task {delegation.child_task_id} to {delegation.to_teammate_id};"
        f" delegation {delegation.id} is PENDING acceptance ({ready})."
        " The delegatee must accept it before doing the work."
        " Use await_delegations to run it now, or check_delegations to read the outcome."
    )


def _list_teammates(ctx: AgentContext) -> str:
    """The bots this identity may delegate to, with the facts needed to pick."""
    mate = _resolve_actor(ctx)
    candidates = delegation_mod.eligible_delegatees(ctx.conn, ctx.task.project_id, mate)
    if not candidates:
        return "no other bot in this project can be delegated to"
    lines = []
    for c in candidates:
        lines.append(
            f"{c['id']} persona={c['persona']!r} available={c['available']}"
            f" has_model={c['has_model']} open_tasks={c['open_tasks']}"
            f" capabilities={c['capabilities']} permissions={c['permissions']}"
        )
    return truncate_output("\n".join(lines))


def _respond_to_delegation(ctx: AgentContext, args: dict[str, Any]) -> str:
    """The delegatee accepts or declines the work handed to it."""
    mate = _resolve_actor(ctx)
    conn = ctx.conn
    decision = str(args.get("decision", "")).strip().lower()
    delegation_id = _opt_str(args.get("delegation_id"))
    delegation: Delegation | None
    if delegation_id is None:
        # The delegation that created this task is the one addressed to us.
        created = store.delegations_by_child_task(conn, ctx.task.id)
        if not created:
            return "tool error: no delegation handed you this task"
        delegation = created[0]
    else:
        delegation = store.get_delegation(conn, delegation_id)
        if delegation is None:
            return "tool error: delegation not found"
    if delegation.to_teammate_id != mate.id:
        return "tool error: only the delegatee may decide this delegation"
    try:
        updated = delegation_mod.respond(
            conn,
            delegation,
            actor=mate,
            decision=decision,
            reason=str(args.get("reason", "")),
        )
    except delegation_mod.DelegationError as exc:
        return f"tool error: {exc}"
    if updated.status == DelegationStatus.DECLINED:
        return (
            f"declined delegation {updated.id}. The delegator will be told you"
            " refused the work; no further action is required from you."
        )
    return (
        f"accepted delegation {updated.id}. You may now do the delegated work;"
        " report the result when it is done."
    )


def _retry_delegation(ctx: AgentContext, args: dict[str, Any]) -> str:
    """Re-delegate work that failed, was declined, or timed out."""
    mate = _resolve_actor(ctx)
    conn = ctx.conn
    delegation_id = str(args.get("delegation_id", ""))
    delegation = store.get_delegation(conn, delegation_id)
    if delegation is None:
        return "tool error: delegation not found"
    to_teammate_id = _opt_str(args.get("to_teammate_id"))
    try:
        retried = delegation_mod.retry(
            conn,
            delegation,
            actor=mate,
            to_teammate_id=to_teammate_id,
        )
    except delegation_mod.DelegationError as exc:
        return f"tool error: {exc}"
    return (
        f"retried: new child task {retried.child_task_id}, delegation {retried.id}"
        f" pending acceptance by {retried.to_teammate_id} (attempt {retried.attempts})."
    )


def _parent_of(conn: sqlite3.Connection, task: Task) -> Task | None:
    if not task.parent_task_id:
        return None
    return store.get_task(conn, task.parent_task_id)


def _await_delegations(ctx: AgentContext, data_dir: str) -> str:
    """Run the delegated child tasks that are ready and report the real outcome.

    Every outcome is spelled out. A delegation that is still waiting for the
    delegatee to accept, that was declined, that failed, or that timed out is
    never reported as a success.
    """
    conn = ctx.conn
    task = ctx.task
    delegations = store.list_delegations_for_task(conn, task.id)
    delegation_mod.expire_overdue(conn, delegations)
    delegations = store.list_delegations_for_task(conn, task.id)
    lines: list[str] = []
    for d in delegations:
        if not delegation_mod.can_await(d) or not d.child_task_id:
            lines.append(delegation_mod.describe(d))
            continue
        child = store.get_task(conn, d.child_task_id)
        if child is None or child.status != TaskStatus.PENDING:
            lines.append(delegation_mod.describe(d))
            continue
        if delegation_mod.delegatee_is_busy(conn, d.to_teammate_id):
            lines.append(
                f"{delegation_mod.describe(d)} — the delegatee is busy, so it was"
                " not started; try again later"
            )
            continue
        run, _result, _artifact = orchestrator.schedule_run(
            conn, child.id, data_dir=data_dir, timeout_s=_run_budget_s(data_dir)
        )
        refreshed = store.get_delegation(conn, d.id)
        result_excerpt = (refreshed.result if refreshed else "")[:CHILD_RESULT_MAX_CHARS]
        lines.append(
            f"{delegation_mod.describe(refreshed or d)}"
            f" [run {run.id} status {run.status.value}]"
            f"\n  result: {result_excerpt or run.output_excerpt[:500]}"
        )
    if not lines:
        return "no delegated work recorded for this task"
    return truncate_output("\n".join(lines), 8000)


def _check_delegations(ctx: AgentContext) -> str:
    """Non-blocking status/result read of this task's delegated children."""
    conn = ctx.conn
    task = ctx.task
    delegations = store.list_delegations_for_task(conn, task.id)
    delegation_mod.expire_overdue(conn, delegations)
    delegations = store.list_delegations_for_task(conn, task.id)
    if not delegations:
        return "no delegated work recorded for this task"
    lines: list[str] = []
    for d in delegations:
        line = delegation_mod.describe(d)
        if d.child_task_id:
            child = store.get_task(conn, d.child_task_id)
            if child is not None:
                line += f" child={child.id} [{child.status.value}]"
        if d.result:
            line += f"\n  result: {d.result[:CHILD_RESULT_MAX_CHARS]}"
        lines.append(line)
    return truncate_output("\n".join(lines), 8000)


def _cancel_delegation(ctx: AgentContext, args: dict[str, Any]) -> str:
    """Cancel a delegation this identity sent or received.

    ``delegation_id`` is optional: without it the delegation that created
    the current task is cancelled, which is how a delegatee withdraws from
    work it was handed.
    """
    mate = _resolve_actor(ctx)
    conn = ctx.conn
    delegation_id = _opt_str(args.get("delegation_id"))
    delegation: Delegation | None
    if delegation_id is None:
        created = store.delegations_by_child_task(conn, ctx.task.id)
        if not created:
            return "tool error: no delegation created this task"
        delegation = created[0]
    else:
        delegation = store.get_delegation(conn, delegation_id)
        if delegation is None:
            return "tool error: delegation not found"
    if mate.id not in (delegation.from_teammate_id, delegation.to_teammate_id):
        return "tool error: only the delegator or the delegatee may cancel a delegation"
    try:
        cancelled = store.cancel_delegation(
            conn, delegation.id, actor_teammate_id=mate.id
        )
    except (KeyError, ValueError) as exc:
        return f"tool error: {exc}"
    return f"cancelled delegation {cancelled.id} (status {cancelled.status.value})"


def _gate_result(exc: HTTPException) -> str:
    detail = exc.detail
    if exc.status_code == 409 and isinstance(detail, dict):
        approval = detail.get("approval", {})
        approvals = detail.get("approvals") or [approval]
        extra = ""
        if len(approvals) > 1:
            extra = (
                f" (+{len(approvals) - 1} more approval"
                f"{'s' if len(approvals) > 2 else ''} for this action)"
            )
        return (
            "APPROVAL REQUIRED before this action can run: "
            f"approval_id={approval.get('id')} action={approval.get('action')}"
            f" digest={str(approval.get('digest', ''))[:16]}…{extra}"
            " The owner must approve this exact action; then call this tool again"
            " with the same arguments."
        )
    if exc.status_code == 403:
        return f"permission denied: {detail}"
    return f"tool error (HTTP {exc.status_code}): {detail}"


def _approval_result(exc: gates.GateApprovalRequired) -> str:
    approval = exc.approval
    extra = ""
    if len(exc.approvals) > 1:
        extra = (
            f" (and {len(exc.approvals) - 1} more approval"
            f"{'s' if len(exc.approvals) > 2 else ''} for this action)"
        )
    return (
        "APPROVAL REQUIRED before this action can run: "
        f"approval_id={approval.id} action={approval.action}"
        f" digest={approval.digest[:16] if approval.digest else ''}…{extra}"
        " The owner must approve this exact action; then call this tool again"
        " with the same arguments."
    )


def _opt_str(value: Any) -> str | None:
    if isinstance(value, str) and value.strip():
        return value.strip()
    return None
