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

Cancellation: a run is stoppable while it is in flight. The local adapter
starts the command in its own process group and polls it, so a cancel
request kills the whole group (not just the shell) instead of waiting for
the command to finish on its own.
"""

from __future__ import annotations

import contextlib
import os
import re
import signal
import subprocess
import tempfile
import threading
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any, BinaryIO, Protocol

# Environment variables that must never reach child processes or stored output.
_NEVER_EXPORT = ("NERDBOT_SECRET_KEY", "NERDBOT_SECRET_KEY_PREVIOUS", "NERDBOT_TOKEN")
_ENC_BLOB = re.compile(r"enc:[A-Za-z0-9]+:[A-Za-z0-9_\-=]+")


def child_env() -> dict[str, str]:
    """Subprocess environment: inherited except server secrets."""
    import os as _os

    return {k: v for k, v in _os.environ.items() if k not in _NEVER_EXPORT}


def scrub_secrets(text: str) -> str:
    """Redact server secrets and ciphertext blobs from stored output."""
    import os as _os

    scrubbed = text
    for name in _NEVER_EXPORT:
        value = _os.environ.get(name, "")
        if len(value) >= 8:
            scrubbed = scrubbed.replace(value, "[redacted]")
    return _ENC_BLOB.sub("[redacted]", scrubbed)


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


class RunCancelled(RuntimeError):
    """A run was cancelled by an explicit request while it was in flight.

    Carries whatever the command produced before the kill, so the cancelled
    run still shows its partial output instead of an empty record.
    """

    def __init__(self, message: str, stdout: str = "", stderr: str = "") -> None:
        super().__init__(message)
        self.stdout = stdout
        self.stderr = stderr


class CancelToken:
    """Cooperative cancellation signal shared by a run and its canceller.

    The runtime polls the token between poll intervals; the API sets it
    from another request. ``threading.Event`` is the primitive: set is
    visible across threads immediately.
    """

    def __init__(self) -> None:
        self._event = threading.Event()

    def cancel(self) -> None:
        self._event.set()

    @property
    def cancelled(self) -> bool:
        return self._event.is_set()


# Live runs, keyed by run id. The API's cancel endpoint looks the run up
# here; the orchestrator registers on start and unregisters on completion.
_ACTIVE_RUNS: dict[str, CancelToken] = {}
_ACTIVE_RUNS_LOCK = threading.Lock()


def register_run(run_id: str, token: CancelToken) -> None:
    with _ACTIVE_RUNS_LOCK:
        _ACTIVE_RUNS[run_id] = token


def unregister_run(run_id: str) -> None:
    with _ACTIVE_RUNS_LOCK:
        _ACTIVE_RUNS.pop(run_id, None)


def request_run_cancel(run_id: str) -> bool:
    """Ask a live run to stop. False when that run is not in flight.

    A run that is not live (queued, finished, or owned by another process)
    cannot be signalled here; the caller records the request instead.
    """
    with _ACTIVE_RUNS_LOCK:
        token = _ACTIVE_RUNS.get(run_id)
    if token is None:
        return False
    token.cancel()
    return True


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
        self,
        command: str,
        workspace: Path,
        timeout_s: float = 60.0,
        context: Any | None = None,
        *,
        cancel: CancelToken | None = None,
    ) -> RunResult: ...  # pragma: no cover


# How often the runtime checks for a cancel request or a timeout.
POLL_INTERVAL_S = 0.05
# Grace period between SIGTERM and SIGKILL for a cancelled process group.
KILL_GRACE_S = 2.0


def _terminate_process_group(proc: subprocess.Popen[Any]) -> None:
    """Kill the child's whole process group: SIGTERM, grace, then SIGKILL.

    The child runs in its own session, so its process group holds the shell
    *and* everything the shell spawned. Killing only the shell would leave
    grandchildren (a long ``sleep``, a dev server) running after the run
    was cancelled.
    """
    try:
        pgid = os.getpgid(proc.pid)
    except (ProcessLookupError, PermissionError, OSError):
        pgid = None
    if pgid is None:
        proc.kill()
        with contextlib.suppress(subprocess.TimeoutExpired):
            proc.wait(timeout=KILL_GRACE_S)
        return
    with contextlib.suppress(ProcessLookupError, PermissionError, OSError):
        os.killpg(pgid, signal.SIGTERM)
    with contextlib.suppress(subprocess.TimeoutExpired):
        proc.wait(timeout=KILL_GRACE_S)
    # SIGKILL the group unconditionally: the shell may have exited on
    # SIGTERM while its children ignored it.
    with contextlib.suppress(ProcessLookupError, PermissionError, OSError):
        os.killpg(pgid, signal.SIGKILL)
    try:
        proc.wait(timeout=KILL_GRACE_S)
    except subprocess.TimeoutExpired:
        proc.kill()


def _read_output(handle: BinaryIO) -> str:
    handle.seek(0)
    return handle.read().decode("utf-8", errors="replace")


class LocalRuntimeAdapter:
    """Execute the task command inside its isolated workspace via ``sh``."""

    name = "local"

    def start_run(
        self,
        command: str,
        workspace: Path,
        timeout_s: float = 60.0,
        context: Any | None = None,
        *,
        cancel: CancelToken | None = None,
    ) -> RunResult:
        del context  # shell execution is context-free
        if not command.strip():
            raise ExecutionError("empty command")
        check_command(command)
        if cancel is not None and cancel.cancelled:
            # Cancelled before the command ever started: do not spawn it.
            raise RunCancelled("run cancelled before it started")
        started = time.monotonic()
        deadline = started + timeout_s
        with tempfile.TemporaryFile() as out_file, tempfile.TemporaryFile() as err_file:
            # start_new_session=True puts the child in its own process group,
            # so a cancel can kill the whole tree instead of just the shell.
            proc = subprocess.Popen(
                ["sh", "-c", command],
                cwd=str(workspace),
                stdout=out_file,
                stderr=err_file,
                env=child_env(),
                start_new_session=True,
            )
            while True:
                try:
                    proc.wait(timeout=POLL_INTERVAL_S)
                    break
                except subprocess.TimeoutExpired:
                    pass
                if cancel is not None and cancel.cancelled:
                    _terminate_process_group(proc)
                    elapsed = time.monotonic() - started
                    raise RunCancelled(
                        f"run cancelled after {elapsed:.1f}s",
                        stdout=_read_output(out_file),
                        stderr=_read_output(err_file),
                    ) from None
                if time.monotonic() >= deadline:
                    _terminate_process_group(proc)
                    raise ExecutionError(
                        f"command timed out after {timeout_s:g}s"
                    ) from None
            stdout = scrub_secrets(_read_output(out_file))
            stderr = scrub_secrets(_read_output(err_file))
        output = stdout + (("\n" if stdout else "") + stderr if stderr else "")
        return RunResult(
            exit_code=proc.returncode, output=output[-8000:], stdout=stdout, stderr=stderr
        )


def frame_untrusted(output: str) -> str:
    """Mark run output as untrusted data so downstream prompts never treat
    it as instructions."""
    return "<<<UNTRUSTED_RUN_OUTPUT>>>\n" + output + "\n<<<END_UNTRUSTED_RUN_OUTPUT>>>"
