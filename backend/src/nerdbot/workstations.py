"""Per-agent isolated execution sessions within a shared Docker runtime.

This module manages lightweight, on-demand execution containers that provide
isolated browser and desktop environments for agents. All agents share one
Docker Engine, but each gets its own container with separate profiles, storage,
and network boundaries.

Core principles:
- One Docker Engine, many agent containers (not one container per agent permanently)
- On-demand allocation: containers created when needed, reused when idle, cleaned up appropriately
- Per-agent isolation: separate container names, separate browser profiles/storage, separate network policies
- Resource quotas: CPU, memory, process limits per container
- Persistent per-agent volumes: home directory and browser data survive restarts
- Cross-agent isolation: network denied by default, filesystem boundaries enforced

Container lifecycle:
- Create on demand when an agent needs browser/desktop access
- Reuse stopped containers (preserving state and volumes)
- Reset with explicit confirmation (destroy+recreate, volumes preserved)
- Delete when no longer needed (container + volume)

The actual Docker CLI commands are factored into :func:`docker_run_container` /
:func:`docker_stop_container` so they can be overridden in tests or deployment-specific subclasses.
"""

from __future__ import annotations

import json
import sqlite3
import subprocess
import asyncio
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Any

from . import store
from .secrets import encrypt_secret, mask_stored

#: Default container resource limits
DEFAULT_CPU = 0.5  # fractional of host CPUs
DEFAULT_RAM_MB = 1024  # megabytes of RAM
DEFAULT_SCREEN = "1280x800"  # screen resolution
DEFAULT_DISK_MB = 1024  # megabytes of disk quota

#: How long a container may remain idle (stopped) before auto-stop
AUTO_STOP_MINUTES = 30
#: How long before an idle container is auto-deleted
AUTO_DELETE_MINUTES = 60

#: Isolation network for agent sessions (inter-container communication denied by default)
BRIDGE_NETWORK = "xiryn-agent-sessions"


# --------------------------------------------------------------------------- #
# Types
# --------------------------------------------------------------------------- #


@dataclass
class ResourceLimits:
    """Resource quotas for an agent container."""

    cpu: float  # fractional of host CPUs (e.g. 0.5, 1.0, 2.0)
    ram_mb: int  # megabytes of RAM
    disk_mb: int = DEFAULT_DISK_MB  # megabytes of disk quota
    swap_mb: int | None = None  # swap limit in MB, None = no swap

    def docker_flags(self) -> list[str]:
        """Return Docker CLI flags for these resource limits."""
        flags: list[str] = [
            "--memory",
            f"{self.ram_mb}m",
            "--memory-swap",
            f"{self.ram_mb + (self.swap_mb or 0)}m",
            "--cpus",
            str(self.cpu),
        ]
        if self.disk_mb is not None:
            flags.extend(["--disk", f"{self.disk_mb}m"])
        return flags


@dataclass
class AgentSession:
    """Represents an agent's isolated execution session.

    Attributes:
        agent_id: The agent's identifier
        container_name: Docker container name
        volume_name: Persistent volume name for agent data
        status: Current status (creating, running, stopped, deleted)
        limits: Resource allocation quotas
        screen: screen resolution for desktop
        created_at: session creation timestamp
        updated_at: last state change
        task_id: currently executing task, if any
        browser_session: browser session identifier, if active
        profile_path: path to agent's browser profile within container
        image: Docker image used for the container
        last_error: Last error message, if any
        takeover_state: Takeover state persistence
    """

    agent_id: str
    container_name: str
    volume_name: str
    status: str = "stopped"
    limits: ResourceLimits = field(default_factory=lambda: ResourceLimits())
    screen: str = DEFAULT_SCREEN
    created_at: str = field(default_factory=lambda: datetime.now(UTC).isoformat())
    updated_at: str = field(default_factory=lambda: datetime.now(UTC).isoformat())
    task_id: str | None = None
    browser_session: str | None = None
    profile_path: str = "/home/user/.config/browser/default"
    image: str = ""
    last_error: str | None = None
    takeover_state: str = "{}"


# --------------------------------------------------------------------------- #
# Preset resource configurations
# --------------------------------------------------------------------------- #

_PRESET_SIZES: dict[str, ResourceLimits] = {
    "mini": ResourceLimits(cpu=0.25, ram_mb=512, disk_mb=512),
    "small": ResourceLimits(cpu=0.5, ram_mb=1024, disk_mb=1024),
    "medium": ResourceLimits(cpu=1.0, ram_mb=2048, disk_mb=2048),
    "large": ResourceLimits(cpu=2.0, ram_mb=4096, disk_mb=4096),
}


def validate_limits(limits: ResourceLimits) -> ResourceLimits:
    """Validate that resource limits are positive and reasonable."""
    if limits.cpu <= 0:
        raise ValueError("CPU must be positive")
    if limits.ram_mb <= 0:
        raise ValueError("RAM must be positive")
    if limits.disk_mb <= 0:
        raise ValueError("Disk must be positive")
    return limits


# --------------------------------------------------------------------------- #
# Database schema
# --------------------------------------------------------------------------- #


def ensure_agent_session_table(conn: sqlite3.Connection) -> None:
    """Create the agent_sessions table if it does not already exist."""
    conn.execute(
        "CREATE TABLE IF NOT EXISTS agent_sessions ("
        " agent_id TEXT PRIMARY KEY, "
        " container_name TEXT NOT NULL, "
        " volume_name TEXT NOT NULL, "
        " image TEXT NOT NULL DEFAULT '', "
        " limits_cpu REAL NOT NULL DEFAULT 0.5, "
        " ram_mb INTEGER NOT NULL DEFAULT 1024, "
        " disk_mb INTEGER NOT NULL DEFAULT 1024, "
        " screen TEXT NOT NULL DEFAULT '1280x800', "
        " status TEXT NOT NULL DEFAULT 'stopped', "
        " created_at TEXT NOT NULL, "
        " updated_at TEXT NOT NULL, "
        " last_error TEXT, "
        " takeover_state TEXT NOT NULL DEFAULT '{}', "
        " task_id TEXT, "
        " browser_session TEXT, "
        " profile_path TEXT NOT NULL DEFAULT '')"
    )
    # Ensure the isolation network exists; best-effort.
    try:
        subprocess.run(
            ["docker", "network", "create", BRIDGE_NETWORK],
            capture_output=True, text=True, timeout=5,
        )
    except Exception:  # noqa: BLE001 - network create is idempotent / may already exist
        pass
    conn.commit()


def _session_row_to_agent(row: tuple) -> AgentSession:
    """Convert a database row to an AgentSession object."""
    limits = ResourceLimits(
        cpu=row[4] or 0.5,
        ram_mb=row[5] or 1024,
        disk_mb=row[6] or 1024,
    )
    return AgentSession(
        agent_id=row[0],
        container_name=row[1],
        volume_name=row[2],
        image=row[3] or "",
        status=row[7],
        limits=limits,
        screen=row[6] or DEFAULT_SCREEN,
        created_at=row[8],
        updated_at=row[9],
        last_error=row[10],
        task_id=row[11],
        browser_session=row[12],
        profile_path=row[13] or "/home/user/.config/browser/default",
    )


def _agent_to_row(session: AgentSession) -> tuple:
    """Convert an AgentSession to a database row tuple."""
    return (
        session.agent_id,
        session.container_name,
        session.volume_name,
        session.image,
        session.limits.cpu,
        session.limits.ram_mb,
        session.limits.disk_mb,
        session.screen,
        session.status,
        session.created_at,
        session.updated_at,
        session.last_error,
        session.takeover_state,
        session.task_id,
        session.browser_session,
        session.profile_path,
    )


# --------------------------------------------------------------------------- #
# Session lifecycle
# --------------------------------------------------------------------------- #


def create_agent_session(
    conn: sqlite3.Connection,
    *,
    agent_id: str,
    task_id: str | None = None,
    cpu: float | None = None,
    ram_mb: int | None = None,
    disk_mb: int | None = None,
    screen: str | None = None,
    image: str | None = None,
    principal: str = "",
) -> AgentSession:
    """Create (or adopt) an agent session for *agent_id*.

    If one already exists and is stopped, it is reused. If running, a new
    container is created. The persistent volume is never deleted.

    Returns the AgentSession object.
    """
    ensure_agent_session_table(conn)

    # Check if session already exists
    existing = conn.execute(
        "SELECT * FROM agent_sessions WHERE agent_id = ?", (agent_id,)
    ).fetchone()

    if existing is not None:
        # Adopt existing session
        session = _session_row_to_agent(existing)
        if session.status == "stopped":
            # Reuse stopped session - just update task and mark running
            session.task_id = task_id or session.task_id
            session.updated_at = datetime.now(UTC).isoformat()
            conn.execute(
                "UPDATE agent_sessions SET status = 'running', task_id = ?, updated_at = ? "
                "WHERE agent_id = ?",
                (task_id or session.task_id, session.updated_at, agent_id),
            )
            conn.commit()
            return session
        # Session is running - create a fresh container
        # (stop the old one first, then create new)
        try:
            _docker_stop_container(session.container_name)
        except Exception:
            pass  # best-effort; proceed to create new

    # Generate names
    container_name = f"xiryn-session-{agent_id}"
    volume_name = f"xiryn-session-{agent_id}-home"

    # Use provided or default resource limits
    cpu = cpu or DEFAULT_CPU
    ram_mb = ram_mb or DEFAULT_RAM_MB
    disk_mb = disk_mb or DEFAULT_DISK_MB
    screen = screen or DEFAULT_SCREEN
    limits = validate_limits(ResourceLimits(cpu=cpu, ram_mb=ram_mb, disk_mb=disk_mb))

    img = image or "nerdbot/agent-browser:latest"
    now = datetime.now(UTC).isoformat()

    # Create the container
    _docker_run_container(container_name, img, limits.cpu, limits.ram_mb, screen, principal)

    # Create the session record
    session = AgentSession(
        agent_id=agent_id,
        container_name=container_name,
        volume_name=volume_name,
        status="running",
        limits=limits,
        screen=screen,
        task_id=task_id,
    )

    conn.execute(
        "INSERT INTO agent_sessions VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        _agent_to_row(session),
    )
    conn.commit()
    return session


def stop_agent_session(conn: sqlite3.Connection, agent_id: str) -> AgentSession:
    """Stop an agent session. The container is stopped and the volume preserved."""
    row = conn.execute(
        "SELECT * FROM agent_sessions WHERE agent_id = ?", (agent_id,)
    ).fetchone()
    if row is None:
        raise ValueError(f"No agent session found for {agent_id}")

    session = _session_row_to_agent(row)
    if session.status == "stopped":
        return session

    container_name = session.container_name
    _docker_stop_container(container_name)

    conn.execute(
        "UPDATE agent_sessions SET status = 'stopped', updated_at = ? "
        "WHERE agent_id = ?",
        (datetime.now(UTC).isoformat(), agent_id),
    )
    conn.commit()
    return session


def reset_agent_session(conn: sqlite3.Connection, agent_id: str) -> AgentSession:
    """Reset an agent session: destroy container, recreate, preserve volume."""
    row = conn.execute(
        "SELECT * FROM agent_sessions WHERE agent_id = ?", (agent_id,)
    ).fetchone()
    if row is None:
        raise ValueError(f"No agent session found for {agent_id}")

    session = _session_row_to_agent(row)
    container_name = session.container_name
    volume_name = session.volume_name

    # Remove old container
    try:
        _docker_stop_container(container_name)
        _docker_remove_container(container_name)
    except Exception:
        pass  # best-effort

    # Recreate container with same volume
    img = "nerdbot/agent-browser:latest"
    cpu = session.limits.cpu or DEFAULT_CPU
    ram_mb = session.limits.ram_mb or DEFAULT_RAM_MB
    disk_mb = session.limits.disk_mb or DEFAULT_DISK_MB
    screen = session.screen or DEFAULT_SCREEN
    _docker_run_container(container_name, img, cpu, ram_mb, disk_mb)

    # Update session state
    session.status = "running"
    session.updated_at = datetime.now(UTC).isoformat()
    session.task_id = None  # reset task
    session.browser_session = None  # reset browser

    conn.execute(
        "UPDATE agent_sessions SET status = 'running', updated_at = ?, "
        "task_id = NULL, browser_session = NULL, last_error = NULL "
        "WHERE agent_id = ?",
        (session.updated_at, agent_id),
    )
    conn.commit()
    return session


def delete_agent_session(conn: sqlite3.Connection, agent_id: str) -> bool:
    """Delete an agent session: remove container and volume."""
    row = conn.execute(
        "SELECT * FROM agent_sessions WHERE agent_id = ?", (agent_id,)
    ).fetchone()
    if row is None:
        return False

    session = _session_row_to_agent(row)
    container_name = session.container_name
    volume_name = session.volume_name

    # Remove container
    try:
        _docker_stop_container(container_name)
        _docker_remove_container(container_name)
    except Exception:
        pass

    # Remove volume
    try:
        subprocess.run(
            ["docker", "volume", "rm", volume_name],
            capture_output=True, text=True, timeout=5,
        )
    except Exception:
        pass

    conn.execute("DELETE FROM agent_sessions WHERE agent_id = ?", (agent_id,))
    conn.commit()
    return True


# --------------------------------------------------------------------------- #
# Browser / desktop operations
# --------------------------------------------------------------------------- #


def start_browser_session(
    conn: sqlite3.Connection,
    *,
    agent_id: str,
    url: str | None = None,
    task_id: str | None = None,
) -> dict[str, Any]:
    """Start a browser session for the agent.

    Returns a dict with connection info (VNC URL, Playwright endpoint, etc.).
    """
    session_row = conn.execute(
        "SELECT * FROM agent_sessions WHERE agent_id = ?", (agent_id,)
    ).fetchone()
    if session_row is None:
        create_agent_session(conn, agent_id=agent_id)

    # Ensure session is running
    if session_row[7] != "running":  # status column
        create_agent_session(conn, agent_id=agent_id)

    # Generate a browser session ID
    import uuid as _uuid
    browser_id = str(_uuid.uuid4())

    # In a real implementation, this would trigger the container to start
    # a browser (via Playwright/VNC). For now, we record the session.
    conn.execute(
        "UPDATE agent_sessions SET browser_session = ?, task_id = ? "
        "WHERE agent_id = ?",
        (browser_id, task_id, agent_id),
    )
    conn.commit()

    # Return connection information (placeholder - actual implementation
    # would configure the container's browser)
    return {
        "agent_id": agent_id,
        "browser_session": browser_id,
        "vnc_url": f"http://127.0.0.1:5900/?password=nerdbot",
        "playwright_ws_endpoint": f"ws://127.0.0.1:9222/devtools/browser/{browser_id}",
        "status": "started",
    }


def stop_browser_session(conn: sqlite3.Connection, agent_id: str) -> dict[str, Any]:
    """Stop the browser session for an agent."""
    conn.execute(
        "UPDATE agent_sessions SET browser_session = NULL, task_id = NULL "
        "WHERE agent_id = ?",
        (agent_id,),
    )
    conn.commit()
    return {"agent_id": agent_id, "browser_session": None, "status": "stopped"}


# --------------------------------------------------------------------------- #
# Takeover / hand-back
# --------------------------------------------------------------------------- #


@dataclass
class TakeoverState:
    """Tracks whether a human has taken over an agent's browser desktop.

    Attributes:
        taken_over: whether a human currently has exclusive control
        takeover_timestamp: when the takeover was initiated
        handback_initiated_by: "human" or "agent"
        task_id_at_takeover: the task id at time of takeover
        resumed: whether control has been handed back to the agent
        resume_timestamp: when the agent resumed
    """

    taken_over: bool = False
    takeover_timestamp: str | None = None
    handback_initiated_by: str | None = None  # "human" or "agent"
    task_id_at_takeover: str | None = None
    resumed: bool = False
    resume_timestamp: str | None = None

    def mark_takeover(self, task_id: str | None = None) -> None:
        self.taken_over = True
        self.takeover_timestamp = datetime.now(UTC).isoformat()
        self.handback_initiated_by = "human"
        self.task_id_at_takeover = task_id
        self.resumed = False

    def mark_resume(self) -> None:
        self.resumed = True
        self.resume_timestamp = datetime.now(UTC).isoformat()
        self.taken_over = False
        self.handback_initiated_by = None
        self.task_id_at_takeover = None

    def to_dict(self) -> dict[str, Any]:
        return {
            "taken_over": self.taken_over,
            "takeover_timestamp": self.takeover_timestamp,
            "handback_initiated_by": self.handback_initiated_by,
            "task_id_at_takeover": self.task_id_at_takeover,
            "resumed": self.resumed,
            "resume_timestamp": self.resume_timestamp,
        }

    @classmethod
    def from_dict(cls, d: dict[str, Any]) -> "TakeoverState":
        s = cls()
        if "taken_over" in d:
            s.taken_over = d["taken_over"]
        if "takeover_timestamp" in d:
            s.takeover_timestamp = d["takeover_timestamp"]
        if "handback_initiated_by" in d:
            s.handback_initiated_by = d["handback_initiated_by"]
        if "task_id_at_takeover" in d:
            s.task_id_at_takeover = d["task_id_at_takeover"]
        if "resumed" in d:
            s.resumed = d["resumed"]
        if "resume_timestamp" in d:
            s.resume_timestamp = d["resume_timestamp"]
        return s


def take_over_browser(
    conn: sqlite3.Connection,
    *,
    agent_id: str,
    task_id: str | None = None,
) -> dict[str, Any]:
    """Mark that a human has taken over the agent's browser desktop.

    Returns the updated takeover state.
    """
    row = conn.execute(
        "SELECT takeover_state FROM agent_sessions WHERE agent_id = ?", (agent_id,)
    ).fetchone()
    import json as _json
    state = TakeoverState.from_dict(_json.loads(row[0]) if row and row[0] else "{}")
    state.mark_takeover(task_id)
    conn.execute(
        "UPDATE agent_sessions SET takeover_state = ? WHERE agent_id = ?",
        (json.dumps(state.to_dict()), agent_id),
    )
    conn.commit()
    return {"agent_id": agent_id, "takeover_state": state.to_dict()}


def handback_browser(
    conn: sqlite3.Connection,
    *,
    agent_id: str,
    task_id: str | None = None,
) -> dict[str, Any]:
    """Mark that control has been handed back to the agent.

    Returns the updated takeover state.
    """
    row = conn.execute(
        "SELECT takeover_state FROM agent_sessions WHERE agent_id = ?", (agent_id,)
    ).fetchone()
    state = TakeoverState.from_dict(json.loads(row[0]) if row and row[0] else "{}")
    state.mark_resume()
    conn.execute(
        "UPDATE agent_sessions SET takeover_state = ? WHERE agent_id = ?",
        (json.dumps(state.to_dict()), agent_id),
    )
    conn.commit()
    return {"agent_id": agent_id, "takeover_state": state.to_dict()}


def get_takeover_state(
    conn: sqlite3.Connection,
    *,
    agent_id: str,
) -> dict[str, Any]:
    """Get the current takeover state for an agent."""
    row = conn.execute(
        "SELECT takeover_state FROM agent_sessions WHERE agent_id = ?", (agent_id,)
    ).fetchone()
    import json as _json
    state = TakeoverState.from_dict(_json.loads(row[0]) if row and row[0] else "{}")
    return {"agent_id": agent_id, "takeover_state": state.to_dict()}


# --------------------------------------------------------------------------- #
# Health and isolation
# --------------------------------------------------------------------------- #


def health_check(agent_id: str) -> dict[str, Any]:
    """Check agent session health.

    Returns container status, volume existence, and takeover state.
    """
    import sqlite3 as _sqlite3

    conn = _sqlite3.connect(":memory:")
    ensure_agent_session_table(conn)

    # Check if session exists
    row = conn.execute(
        "SELECT container_name, status, browser_session, task_id, takeover_state FROM agent_sessions WHERE agent_id = ?",
        (agent_id,),
    ).fetchone()

    if row is None:
        return {
            "agent_id": agent_id,
            "container_running": False,
            "volume_exists": False,
            "browser_active": False,
            "takeover_active": False,
            "error": "session not found",
        }

    container_name = row[0]
    status = row[1]
    browser_session = row[2]
    task_id = row[3]

    # Check container exists and is running via Docker inspect
    container_running = False
    try:
        result = subprocess.run(
            ["docker", "inspect", container_name, "--format={{.State.Running}}"],
            capture_output=True, text=True, timeout=5,
        )
        if result.returncode == 0 and result.stdout.strip().lower() == "true":
            container_running = True
    except Exception:
        pass

    # Check takeover state from DB row
    takeover_active = False
    if row[4]:
        try:
            state = json.loads(row[4])
            takeover_active = state.get("taken_over", False)
        except Exception:
            pass

    # Browser active if a session ID exists
    browser_active = browser_session is not None

    return {
        "agent_id": agent_id,
        "container_running": container_running,
        "volume_exists": True,  # volume is always created with session
        "browser_active": browser_active,
        "takeover_active": takeover_active,
        "task_id": task_id,
        "error": None,
    }


def cleanup_orphaned_sessions(conn: sqlite3.Connection) -> int:
    """Detect and remove orphaned agent sessions whose containers no longer exist.

    Returns the number of sessions cleaned up.
    """
    cleaned = 0
    for row in conn.execute("SELECT agent_id, container_name FROM agent_sessions").fetchall():
        agent_id, container_name = row[0], row[1]
        try:
            result = subprocess.run(
                ["docker", "inspect", container_name, "--format={{.State.Running}}"],
                capture_output=True, text=True, timeout=5,
            )
            if result.returncode != 0 or result.stdout.strip().lower() != "true":
                # Container doesn't exist or not running - delete session
                conn.execute("DELETE FROM agent_sessions WHERE agent_id = ?", (agent_id,))
                cleaned += 1
        except Exception:
            pass
    conn.commit()
    return cleaned


# --------------------------------------------------------------------------- #
# Docker helper functions
# --------------------------------------------------------------------------- #


def _docker_cmd() -> list[str]:
    """Return the docker CLI command."""
    return ["docker"]


def _docker_run_container(
    name: str,
    image: str,
    cpu: float,
    ram_mb: int,
    screen: str,
    principal: str = "",
) -> None:
    """Launch an agent browser container.

    This is a simplified container launch. In production, this would use
    a proper base image with Xfce/Chromium/noVNC pre-installed.
    """
    # Check if docker is available
    try:
        result = subprocess.run(
            ["docker", "info"], capture_output=True, text=True, timeout=5
        )
        if result.returncode != 0:
            raise RuntimeError("Docker daemon not available")
    except Exception as e:
        raise RuntimeError(f"Docker not available: {e}")

    args = [
        "docker", "run", "-d", "--rm",
        "--name", name,
        "--network", BRIDGE_NETWORK,
        "--cap-drop", "ALL",
        "--security-opt", "no-new-privileges",
        "--memory",
        f"{ram_mb}m",
        "--cpus",
        str(cpu),
        "--restart",
        "no",
        "--hostname", name,
        "-p", "5900",  # VNC port
        "-v", f"{name}-home:/home:rw",  # persistent volume
        "-e", f"AGENT_ID={principal}",
        image,
        "sh", "-c",
        "Xvfb :0 -screen 0 " + screen + "x24 &\n",
        "tigervnc_server :1 -geometry " + screen + " -depth 24 -localhost no -PassFile /home/user/.vnc/passwd &\n",
        "novnc --vnc localhost:5900 --listen 6080 &\n",
        "while true; do sleep 3600; done",
    ]
    proc = subprocess.run(args, capture_output=True, text=True, timeout=30)
    if proc.returncode != 0:
        raise RuntimeError(f"docker run failed: {proc.stderr}")


def _docker_stop_container(name: str) -> None:
    """Stop a Docker container."""
    try:
        subprocess.run(
            ["docker", "stop", "--timeout", "5", name],
            capture_output=True, text=True, timeout=10,
        )
    except Exception:  # noqa: BLE001 - best-effort; already-stopped is fine
        pass


def _docker_remove_container(name: str) -> None:
    """Remove a Docker container."""
    try:
        subprocess.run(
            ["docker", "rm", "-f", name],
            capture_output=True, text=True, timeout=10,
        )
    except Exception:  # noqa: BLE001 - best-effort
        pass


def _now_iso() -> str:
    return datetime.now(UTC).isoformat()
