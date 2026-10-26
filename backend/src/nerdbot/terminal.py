"""Owner terminal sessions, one PTY per workspace project.

This is the human's shell, not an agent tool. It starts in the project's live
workspace root, inherits the process environment minus server secrets, and is
kept in memory only. The API enforces project ownership and a session is bound
to the project that created it, so a session id alone cannot reach another
workspace.

Output is streamed to the browser with SSE. A small ring buffer makes
reconnecting useful; the full transcript is deliberately not persisted.
"""

from __future__ import annotations

import fcntl
import os
import pty
import queue
import secrets
import select
import signal
import struct
import subprocess
import termios
import threading
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from .runtime import child_env, scrub_secrets

MAX_BUFFER = 256 * 1024
MAX_SESSIONS = 12
DEFAULT_COLS = 120
DEFAULT_ROWS = 32

_SESSIONS: dict[str, TerminalSession] = {}
_SESSIONS_LOCK = threading.Lock()


@dataclass
class TerminalSession:
    id: str
    project_id: str
    root: Path
    shell: str
    pid: int
    master_fd: int
    cols: int = DEFAULT_COLS
    rows: int = DEFAULT_ROWS
    buffer: bytearray = field(default_factory=bytearray)
    subscribers: set[queue.Queue[str | None]] = field(default_factory=set)
    alive: bool = True
    created_at: float = field(default_factory=time.time)
    lock: threading.Lock = field(default_factory=threading.Lock)
    pump_thread: threading.Thread | None = None

    def _pump(self) -> None:
        while self.alive:
            try:
                ready, _, _ = select.select([self.master_fd], [], [], 0.25)
            except (OSError, ValueError):
                break
            if not ready:
                continue
            try:
                chunk = os.read(self.master_fd, 65536)
            except BlockingIOError:
                continue
            except OSError:
                break
            if not chunk:
                break
            text = scrub_secrets(chunk.decode("utf-8", errors="replace"))
            with self.lock:
                self.buffer.extend(text.encode("utf-8"))
                if len(self.buffer) > MAX_BUFFER:
                    del self.buffer[: len(self.buffer) - MAX_BUFFER]
                for subscriber in list(self.subscribers):
                    try:
                        subscriber.put_nowait(text)
                    except queue.Full:
                        pass
        with self.lock:
            self.alive = False
            for subscriber in list(self.subscribers):
                try:
                    subscriber.put_nowait(None)
                except queue.Full:
                    pass
            self.subscribers.clear()
        try:
            os.close(self.master_fd)
        except OSError:
            pass

    def write(self, data: str) -> int:
        if not self.alive:
            raise ValueError("terminal session is closed")
        payload = data.encode("utf-8")
        if len(payload) > 64 * 1024:
            raise ValueError("input chunk too large")
        return os.write(self.master_fd, payload)

    def resize(self, cols: int, rows: int) -> None:
        cols = max(20, min(int(cols), 400))
        rows = max(5, min(int(rows), 200))
        self.cols, self.rows = cols, rows
        winsize = struct.pack("HHHH", rows, cols, 0, 0)
        fcntl.ioctl(self.master_fd, termios.TIOCSWINSZ, winsize)

    def subscribe(self) -> tuple[str, queue.Queue[str | None]]:
        subscriber: queue.Queue[str | None] = queue.Queue(maxsize=256)
        with self.lock:
            snapshot = self.buffer.decode("utf-8", errors="replace")
            self.subscribers.add(subscriber)
            if not self.alive:
                subscriber.put_nowait(None)
        return snapshot, subscriber

    def unsubscribe(self, subscriber: queue.Queue[str | None]) -> None:
        with self.lock:
            self.subscribers.discard(subscriber)

    def close(self) -> None:
        if not self.alive:
            return
        self.alive = False
        try:
            os.killpg(self.pid, signal.SIGTERM)
        except (ProcessLookupError, PermissionError, OSError):
            pass
        # The pump thread owns the read end. Closing the fd from this thread
        # while a read is in flight can block on macOS, so signal it and let
        # the thread close the descriptor on its way out.
        thread = self.pump_thread
        if thread is not None and thread is not threading.current_thread():
            thread.join(timeout=2.0)
        with self.lock:
            for subscriber in list(self.subscribers):
                try:
                    subscriber.put_nowait(None)
                except queue.Full:
                    pass
            self.subscribers.clear()


def _shell() -> str:
    """Pick a predictable interactive shell.

    The owner's login shell can be a highly customized fish/zsh setup that
    probes the terminal and waits for replies. The workspace terminal is a
    tool, not a login session: prefer an explicit override, then the standard
    macOS shells, and only then $SHELL.
    """
    configured = os.environ.get("NERDBOT_TERMINAL_SHELL", "")
    if configured and Path(configured).is_file():
        return configured
    for fallback in ("/bin/zsh", "/bin/bash", "/bin/sh"):
        if Path(fallback).is_file():
            return fallback
    candidate = os.environ.get("SHELL", "")
    if candidate and Path(candidate).is_file():
        return candidate
    return "/bin/sh"


def create_session(
    project_id: str, root: Path, cols: int = DEFAULT_COLS, rows: int = DEFAULT_ROWS
) -> TerminalSession:
    root = Path(root).resolve()
    if not root.is_dir():
        raise ValueError(f"workspace is not a directory: {root}")
    with _SESSIONS_LOCK:
        # Reap closed sessions before enforcing the cap.
        for sid, session in list(_SESSIONS.items()):
            if not session.alive:
                _SESSIONS.pop(sid, None)
        if len([s for s in _SESSIONS.values() if s.project_id == project_id]) >= MAX_SESSIONS:
            raise ValueError("too many open terminals for this workspace")

    master_fd, slave_fd = pty.openpty()
    cols = max(20, min(int(cols), 400))
    rows = max(5, min(int(rows), 200))
    fcntl.ioctl(slave_fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))

    shell = _shell()
    env = child_env()
    env["TERM"] = "xterm-256color"
    env["COLORTERM"] = "truecolor"

    def _child_setup() -> None:
        # A PTY slave alone is not enough: the shell needs a controlling
        # terminal or interactive shells (notably fish) refuse to start.
        os.setsid()
        fcntl.ioctl(0, termios.TIOCSCTTY, 0)

    try:
        proc = subprocess.Popen(
            [shell, "-l"],
            cwd=str(root),
            stdin=slave_fd,
            stdout=slave_fd,
            stderr=slave_fd,
            env=env,
            preexec_fn=_child_setup,
            close_fds=True,
        )
    except Exception:
        os.close(master_fd)
        os.close(slave_fd)
        raise
    os.close(slave_fd)
    os.set_blocking(master_fd, False)

    session = TerminalSession(
        id=f"term_{secrets.token_urlsafe(9)}",
        project_id=project_id,
        root=root,
        shell=shell,
        pid=proc.pid,
        master_fd=master_fd,
        cols=cols,
        rows=rows,
    )
    with _SESSIONS_LOCK:
        _SESSIONS[session.id] = session
    session.pump_thread = threading.Thread(
        target=session._pump, daemon=True, name=f"nerdbot-terminal-{session.id}"
    )
    session.pump_thread.start()
    return session


def get_session(session_id: str, project_id: str) -> TerminalSession:
    with _SESSIONS_LOCK:
        session = _SESSIONS.get(session_id)
    if session is None or session.project_id != project_id:
        raise KeyError("terminal session not found")
    return session


def close_session(session_id: str, project_id: str) -> bool:
    with _SESSIONS_LOCK:
        session = _SESSIONS.pop(session_id, None)
    if session is None or session.project_id != project_id:
        return False
    session.close()
    return True


def close_all() -> None:
    with _SESSIONS_LOCK:
        sessions = list(_SESSIONS.values())
        _SESSIONS.clear()
    for session in sessions:
        session.close()


def shell_info(session: TerminalSession) -> dict[str, Any]:
    return {
        "session_id": session.id,
        "project_id": session.project_id,
        "cwd": str(session.root),
        "shell": Path(session.shell).name,
        "cols": session.cols,
        "rows": session.rows,
        "alive": session.alive,
    }
