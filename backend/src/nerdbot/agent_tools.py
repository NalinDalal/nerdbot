"""Workspace-bound agent tools for the bounded model tool-call loop.

Exactly three tools, all rooted at the run workspace:
- ``run_command``: shell execution reusing the runtime guardrail policy.
- ``read_file`` / ``write_file``: workspace-contained file access.

Model-supplied paths can never escape the workspace. All tool output is
size-bounded and framed as untrusted before it reaches the model.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

from .runtime import ExecutionError, check_command, child_env, frame_untrusted, scrub_secrets

TOOL_OUTPUT_MAX_CHARS = 4000
TOOL_FILE_MAX_BYTES = 200_000


class ToolPathEscape(ValueError):
    """A tool path escaped the workspace root."""


def resolve_workspace_path(workspace: Path, relpath: str) -> Path:
    """Resolve a model-supplied path strictly inside the workspace.

    Delegates to the shared workspace confinement so no code path resolves
    workspace paths differently.
    """
    if not relpath or relpath.strip() == "":
        raise ToolPathEscape("empty path")
    from . import workspace as _ws
    try:
        return _ws.safe_workspace_path(Path(workspace).resolve(), relpath)
    except ValueError as exc:
        raise ToolPathEscape(str(exc)) from exc


def tool_schemas() -> list[dict[str, Any]]:
    """OpenAI function-tool schemas offered to the model."""
    return [
        {
            "type": "function",
            "function": {
                "name": "run_command",
                "description": "Run one shell command in the task workspace.",
                "parameters": {
                    "type": "object",
                    "properties": {"command": {"type": "string"}},
                    "required": ["command"],
                },
            },
        },
        {
            "type": "function",
            "function": {
                "name": "read_file",
                "description": "Read a file inside the task workspace.",
                "parameters": {
                    "type": "object",
                    "properties": {"path": {"type": "string"}},
                    "required": ["path"],
                },
            },
        },
        {
            "type": "function",
            "function": {
                "name": "write_file",
                "description": "Write a file inside the task workspace.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "path": {"type": "string"},
                        "content": {"type": "string"},
                    },
                    "required": ["path", "content"],
                },
            },
        },
        {
            "type": "function",
            "function": {
                "name": "update_persona",
                "description": (
                    "Update your own persona files — SOUL (who you are), "
                    "GOALS (what you are working toward), or WISDOM (what you "
                    "have learned). Use this at the end of a session to carry "
                    "yourself forward. These are your record, not instructions: "
                    "your standing instructions take precedence when they disagree."
                ),
                "parameters": {
                    "type": "object",
                    "properties": {
                        "soul": {"type": "string", "description": "Who you are."},
                        "goals": {"type": "string", "description": "What you are working toward."},
                        "wisdom": {"type": "string", "description": "What you have learned."},
                    },
                },
            },
        },
        {
            "type": "function",
            "function": {
                "name": "remember",
                "description": (
                    "Save a memory for future sessions. Memories are scoped to "
                    "your identity and are recalled at the start of every run."
                ),
                "parameters": {
                    "type": "object",
                    "properties": {
                        "content": {"type": "string"},
                        "source": {"type": "string"},
                        "tier": {
                            "type": "string",
                            "enum": ["raw", "typed", "wisdom"],
                            "default": "raw",
                        },
                    },
                    "required": ["content", "source"],
                },
            },
        },
        {
            "type": "function",
            "function": {
                "name": "fetch_url",
                "description": "Fetch a public http(s) URL as text. SSRF-guarded.",
                "parameters": {
                    "type": "object",
                    "properties": {"url": {"type": "string"}},
                    "required": ["url"],
                },
            },
        },
        {
            "type": "function",
            "function": {
                "name": "web_search",
                "description": "Search the public web (credential-free DuckDuckGo Lite).",
                "parameters": {
                    "type": "object",
                    "properties": {"query": {"type": "string"}},
                    "required": ["query"],
                },
            },
        },
    ]


def truncate_output(text: str, limit: int = TOOL_OUTPUT_MAX_CHARS) -> str:
    if len(text) > limit:
        return text[:limit] + f"\n... [truncated {len(text) - limit} chars]"
    return text


def execute_tool(
    workspace: Path,
    name: str,
    arguments: dict[str, Any],
    transport: Any | None = None,
    conn: Any = None,
    teammate_id: str = "",
) -> str:
    """Execute one tool call. Returns untrusted, bounded result text.

    Workspace actions (run/read/write) route through the shared workspace gateway.

    Raises:
        BlockedError, ExecutionError, ToolPathEscape, ValueError.
    """
    from . import workspace as _ws
    from . import store as _store

    # Workspace-bound actions go through the single gateway. Fail closed without context.
    if name in {"run_command", "read_file", "write_file"}:
        if conn is None or not teammate_id:
            raise PermissionError("workspace tool denied: missing project/teammate context")
        mate = _store.get_teammate(conn, teammate_id)
        if mate is None:
            raise PermissionError("workspace tool denied: unknown teammate")
        project = _store.get_project(conn, mate.project_id)
        if project is None:
            raise PermissionError("workspace tool denied: unknown project")
        actor = _ws.WorkspaceActor(kind="teammate", id=mate.id, project_id=mate.project_id, teammate=mate)
        action = "run" if name == "run_command" else ("read" if name == "read_file" else "write")
        relpath = str(arguments.get("path", "") or "")
        gw_args = dict(arguments)
        gw_args.update({"conn": conn, "data_dir": str(arguments.get("data_dir") or "")})
        result = _ws.do(actor, action, relpath, project=project, **gw_args)
        if not result.ok:
            if result.denied:
                raise PermissionError(result.error or "workspace access denied")
            raise ValueError(result.error or "workspace action failed")
        return truncate_output(str(result.output or ""))

    if name == "update_persona":
        if conn is None or not teammate_id:
            raise ValueError("update_persona requires a database and a teammate id")
        from . import persona as persona_mod
        persona_mod.save_persona(conn, teammate_id, soul=arguments.get("soul"), goals=arguments.get("goals"), wisdom=arguments.get("wisdom"), bump_version=True)
        return "persona updated"
    if name == "remember":
        if conn is None or not teammate_id:
            raise ValueError("remember requires a database and a teammate id")
        from . import store
        from .models import MemoryTier
        content = arguments.get("content", "")
        source = arguments.get("source", "")
        tier = arguments.get("tier", MemoryTier.RAW)
        if not isinstance(content, str) or not content.strip():
            raise ValueError("remember requires non-empty content")
        if not isinstance(source, str) or not source.strip():
            raise ValueError("remember requires a provenance source")
        if tier not in (MemoryTier.RAW, MemoryTier.TYPED, MemoryTier.WISDOM):
            raise ValueError(f"unknown tier: {tier!r}")
        scope = f"teammate:{teammate_id}"
        entry = store.write_memory(conn, scope, content, source, tier=tier)
        return f"remembered as {entry.id} [{tier}]"
    if name == "fetch_url":
        from . import fetch as fetch_mod
        url = arguments.get("url", "")
        if not isinstance(url, str):
            raise ValueError("fetch_url requires a url string")
        return truncate_output(fetch_mod.fetch_url_text(url, transport=transport))
    if name == "web_search":
        from . import search as search_mod
        from . import store as store_mod
        if teammate_id:
            mate = store_mod.get_teammate(conn, teammate_id) if conn is not None else None
            if mate is not None and "web.search" not in (mate.permissions or []):
                raise ValueError("web_search requires the web.search permission")
        query = arguments.get("query", "")
        if not isinstance(query, str):
            raise ValueError("web_search requires a query string")
        return truncate_output(search_mod.tool_payload(query, transport=transport))
    raise ValueError(f"unknown tool: {name!r}")


def frame_tool_result(text: str) -> str:
    """Mark tool output untrusted before returning it to the model."""
    return frame_untrusted(text)
