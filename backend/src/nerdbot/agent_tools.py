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

from .runtime import ExecutionError, check_command, frame_untrusted

TOOL_OUTPUT_MAX_CHARS = 4000
TOOL_FILE_MAX_BYTES = 200_000


class ToolPathEscape(ValueError):
    """A tool path escaped the workspace root."""


def resolve_workspace_path(workspace: Path, relpath: str) -> Path:
    """Resolve a model-supplied path strictly inside the workspace."""
    if not relpath or relpath.strip() == "":
        raise ToolPathEscape("empty path")
    base = workspace.resolve()
    target = (base / relpath).resolve()
    if target != base and base not in target.parents:
        raise ToolPathEscape(f"path escapes workspace: {relpath!r}")
    return target


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
    ]


def truncate_output(text: str, limit: int = TOOL_OUTPUT_MAX_CHARS) -> str:
    if len(text) > limit:
        return text[:limit] + f"\n... [truncated {len(text) - limit} chars]"
    return text


def execute_tool(workspace: Path, name: str, arguments: dict[str, Any]) -> str:
    """Execute one tool call. Returns untrusted, bounded result text.

    Raises BlockedError (policy), ExecutionError (command failure),
    ToolPathEscape (workspace escape), or ValueError (bad arguments).
    """
    import subprocess

    if name == "run_command":
        command = arguments.get("command", "")
        if not isinstance(command, str) or not command.strip():
            raise ValueError("run_command requires a non-empty command string")
        check_command(command)
        completed = subprocess.run(
            ["sh", "-c", command],
            cwd=str(workspace),
            capture_output=True,
            text=True,
            timeout=60.0,
        )
        if completed.returncode != 0:
            raise ExecutionError(
                f"exit={completed.returncode} stderr={truncate_output(completed.stderr or '')}"
            )
        return truncate_output(completed.stdout or "")
    if name == "read_file":
        relpath = arguments.get("path", "")
        if not isinstance(relpath, str):
            raise ValueError("read_file requires a path string")
        target = resolve_workspace_path(workspace, relpath)
        if not target.is_file():
            raise ValueError(f"no such file: {relpath!r}")
        if target.stat().st_size > TOOL_FILE_MAX_BYTES:
            raise ValueError(f"file too large: {relpath!r}")
        return truncate_output(target.read_text(encoding="utf-8", errors="replace"))
    if name == "write_file":
        relpath = arguments.get("path", "")
        content = arguments.get("content", "")
        if not isinstance(relpath, str) or not isinstance(content, str):
            raise ValueError("write_file requires path and content strings")
        if len(content.encode("utf-8")) > TOOL_FILE_MAX_BYTES:
            raise ValueError("content too large")
        target = resolve_workspace_path(workspace, relpath)
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(content, encoding="utf-8")
        return f"wrote {len(content.encode('utf-8'))} bytes to {relpath!r}"
    raise ValueError(f"unknown tool: {name!r}")


def frame_tool_result(text: str) -> str:
    """Mark tool output untrusted before returning it to the model."""
    return frame_untrusted(text)
