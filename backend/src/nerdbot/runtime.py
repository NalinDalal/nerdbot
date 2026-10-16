"""Runtime adapter contract + local (in-process) adapter.

The orchestrator schedules runs; adapters execute them. Provider and
workspace integration stay behind this contract so the runtime can be
swapped (e.g. Octop-backed) without touching orchestration or the API.

Guardrail patterns re-expressed for nerdbot (no reference code copied):
- Deny-list of destructive shell idioms (``rm -rf /``, fork bombs,
  ``curl|sh`` pipes, cloud-metadata IPs) with typed ``blocked`` failures.
- Untrusted output is framed, never executed.
- ``BlockedError`` vs ``ExecutionError`` keeps policy denials distinct from
  command failures (typed-failure pattern).
"""

from __future__ import annotations

import re
import subprocess
from dataclasses import dataclass
from pathlib import Path
from typing import Protocol

BLOCKED_PATTERNS: list[tuple[str, str]] = [
    (r"rm\s+-rf\s+/", "destructive recursive delete"),
    (r":\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;?\s*:", "fork bomb"),
    (r"curl[^\n]*\|\s*(sh|bash)", "curl-piped-to-shell"),
    (r"wget[^\n]*\|\s*(sh|bash)", "wget-piped-to-shell"),
    (r"169\.254\.169\.254", "cloud metadata endpoint"),
    (r"mkfs|dd\s+[^|]*of=/dev/", "disk destruction"),
]


class BlockedError(RuntimeError):
    """A command was refused by policy (not an execution failure)."""

    def __init__(self, reason: str) -> None:
        super().__init__(f"blocked by policy: {reason}")
        self.reason = reason


class ExecutionError(RuntimeError):
    """A command ran and failed (non-zero exit)."""


def check_command(command: str) -> None:
    """Raise BlockedError if the command matches a deny-list pattern."""
    for pattern, reason in BLOCKED_PATTERNS:
        if re.search(pattern, command):
            raise BlockedError(reason)


@dataclass
class RunResult:
    exit_code: int
    output: str
    stdout: str = ""
    stderr: str = ""


class RuntimeAdapter(Protocol):
    name: str

    def start_run(
        self, command: str, workspace: Path, timeout_s: float = 60.0
    ) -> RunResult: ...  # pragma: no cover


class LocalRuntimeAdapter:
    """Execute the task command inside its isolated workspace via ``sh``."""

    name = "local"

    def start_run(self, command: str, workspace: Path, timeout_s: float = 60.0) -> RunResult:
        if not command.strip():
            raise ExecutionError("empty command")
        check_command(command)
        completed = subprocess.run(
            ["sh", "-c", command],
            cwd=str(workspace),
            capture_output=True,
            text=True,
            timeout=timeout_s,
        )
        stdout = completed.stdout or ""
        stderr = completed.stderr or ""
        output = stdout + (("\n" if stdout else "") + stderr if stderr else "")
        return RunResult(
            exit_code=completed.returncode, output=output[-8000:], stdout=stdout, stderr=stderr
        )


def frame_untrusted(output: str) -> str:
    """Mark run output as untrusted data so downstream prompts never treat
    it as instructions."""
    return "<<<UNTRUSTED_RUN_OUTPUT>>>\n" + output + "\n<<<END_UNTRUSTED_RUN_OUTPUT>>>"
