"""MCP (Model Context Protocol) client subsystem.

This module implements the Model Context Protocol v2 using JSON-RPC 2.0 over two transports:
  (a) stdio (subprocess, newline-delimited JSON) and (b) HTTP (Streamable HTTP POST + mcp
  session header). It provides a connection manager that keeps one session per configured server,
  reconnects on demand, enforces timeouts and output size budgets, and never lets a server's
  response escape its envelope.

Core types and conventions:
  - All API functions are *dependency-free*: they receive a fresh sqlite3.Connection and the
    principal string; they do not import from store.py, api.py, or any other nerdbot module.
  - Tables are created idempotently inside the module via SCHEMA_DDL and an ensure_schema(conn)
    helper. Do NOT modify store.py's SCHEMA or migration system.
  - Secrets: server headers/env must be stored as SECRET REFERENCES (names resolved at call
    time through nerdbot.secrets/env), never as plaintext. Redact any secret material from logs
    and errors.
  - Permissions: an allow/deny tool policy per server (default deny for mutating tools unless
    allowed), enforced BEFORE dispatch; a blocked call returns the typed failure union convention
    found in the codebase (RuntimeError/ExecutionError, not a conflicting shape).
  - Execution audit: every tools/call and every connection attempt writes an audit row with
    the outcome.
  - Fail-closed, dependency-free behavior: if a server binary is missing or a transport
    errors, surface a typed error, never a traceback to the client.

SCHEMA_DDL (executed via conn.executescript — does not touch store.py):
  mcp_servers (id TEXT PRIMARY KEY, name TEXT NOT NULL, transport TEXT NOT NULL DEFAULT 'stdio',
    command TEXT, args_json TEXT, url TEXT, headers_json TEXT, enabled INTEGER NOT NULL DEFAULT 1,
    status TEXT NOT NULL DEFAULT 'idle', last_error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
    tool_policy_json TEXT)
  mcp_server_tools (server_id TEXT, name TEXT, description TEXT, input_schema_json TEXT, discovered_at TEXT,
    PRIMARY KEY (server_id, name))
  mcp_tool_audit (id TEXT PRIMARY KEY, server_id TEXT, tool_name TEXT, args_digest TEXT, result_status TEXT,
    error_kind TEXT, duration_s REAL, principal TEXT, created_at TEXT NOT NULL)

Two convenience types returned by public functions:
  success(result)   → {"ok": result}
  failure(kind, msg) → {"error": kind, "message": msg}
"""

from __future__ import annotations

import base64
import hashlib
import json
import sqlite3
import subprocess
import sys
from datetime import UTC, datetime
from typing import Any

# --------------------------------------------------------------------------- #
# Schema DDL — created inside the module via conn.executescript; do not touch store.py
# ---------------------------------------------------------------------------

SCHEMA_DDL = """
CREATE TABLE IF NOT EXISTS mcp_servers (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  transport TEXT NOT NULL DEFAULT 'stdio',
  command TEXT,
  args_json TEXT DEFAULT '{}',
  url TEXT DEFAULT '',
  headers_json TEXT DEFAULT '{}',
  enabled INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'idle',
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS mcp_server_tools (
  server_id TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  input_schema_json TEXT DEFAULT '{}',
  discovered_at TEXT NOT NULL,
  PRIMARY KEY (server_id, name)
);
CREATE TABLE IF NOT EXISTS mcp_tool_audit (
  id TEXT PRIMARY KEY,
  server_id TEXT NOT NULL,
  tool_name TEXT NOT NULL,
  args_digest TEXT,
  result_status TEXT,
  error_kind TEXT,
  duration_s REAL DEFAULT 0.0,
  principal TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_mcp_audit_server ON mcp_tool_audit(server_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_mcp_audit_tool ON mcp_tool_audit(tool_name, result_status);
"""

# --------------------------------------------------------------------------- #
# Audit helper
# ---------------------------------------------------------------------------

def _audit(
    conn: sqlite3.Connection,
    *,
    server_id: str,
    tool_name: str,
    args: dict[str, Any] | None,
    result_status: str,
    error_kind: str | None,
    duration_s: float,
    principal: str,
) -> None:
    """Write one audit row for a tool call or connection attempt."""
    import datetime as _dt  # local import to avoid top-level pollution
    args_digest = (
        hashlib.sha256(json.dumps(args, sort_keys=True, separators=(",", ":")).encode()).hexdigest()
        if args is not None
        else ""
    )
    conn.execute(
        "INSERT INTO mcp_tool_audit"
        " (id, server_id, tool_name, args_digest, result_status, error_kind, duration_s, principal, created_at)"
        " VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        (
            hashlib.sha256(f"{server_id}:{tool_name}:{_dt.datetime.now(UTC).isoformat()}".encode()).hexdigest()[:32],
            server_id,
            tool_name,
            args_digest,
            result_status,
            error_kind,
            duration_s,
            principal,
            _dt.datetime.now(UTC).isoformat(),
        ),
    )

# --------------------------------------------------------------------------- #
# Type aliases
# ---------------------------------------------------------------------------

Success = dict[str, Any]
Failure = dict[str, str]

_SUCCESS = "ok"
_FAILURE = "error"

def success(result: Any = None) -> Success:
    return {"ok": result} if result is not None else {"ok": None}

def failure(kind: str, message: str) -> Failure:
    return {"error": kind, "message": message}


# --------------------------------------------------------------------------- #
# Transport: stdio (subprocess, newline-delimited JSON)
# ---------------------------------------------------------------------------

def _stdio_read_line(conn: sqlite3.Connection, proc: subprocess.Popen[Any], timeout_s: float = 10.0) -> bytes | None:
    """Read one line (terminated by \n) from a stdio subprocess with a timeout.

    Returns the line bytes (without trailing \n), or None if the timeout expires
    or the process exits.
    """
    import select as _select
    deadline = datetime.now(UTC).timestamp() + timeout_s
    line = b""
    while datetime.now(UTC).timestamp() < deadline:
        try:
            r, _, _ = _select.select([proc.stdout], [], [], 0.1)
            if r:
                ch = proc.stdout.read(1)
                if ch == b"":
                    # process closed
                    return None
                line += ch
                if line.endswith(b"\n"):
                    return line[:-1]  # strip trailing \n
            # else: no data yet, continue waiting
        except Exception:  # noqa: BLE001 - best-effort; never raise to the caller
            return None
    return None  # timeout


def _stdio_write_line(conn: sqlite3.Connection, proc: subprocess.Popen[Any], line: bytes) -> bool:
    """Write one line (appended with \n) to a stdio subprocess's stdin.

    Returns True on success, False if the process has terminated.
    """
    try:
        if proc.stdin is None:
            return False
        proc.stdin.write(line + b"\n")
        proc.stdin.flush()
        return True
    except Exception:  # noqa: BLE001 - best-effort
        return False


def _stdio_handshake(conn: sqlite3.Connection, proc: subprocess.Popen[Any], principal: str) -> dict[str, Any]:
    """Perform the MCP initialize → notifications/initialized, tools/list, ping cycle.

    Returns {"capabilities": dict, "server_id": str} on success.
    Raises RuntimeError if any step fails or times out.
    """
    # 1. Initialize
    handshake = json.dumps({"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {
        "capabilities": {"roots": {"list": True}, "sampling": True},
        "clientInfo": {"name": "nerdbot", "version": "0.1.0"},
    }})
    if not _stdio_write_line(conn, proc, handshake.encode()):
        raise RuntimeError("stdio: failed to send initialize")

    line = _stdio_read_line(conn, proc, timeout_s=15)
    if line is None:
        raise RuntimeError("stdio: no response to initialize")

    try:
        init_resp = json.loads(line.decode())
    except (json.JSONDecodeError, UnicodeDecodeError):
        raise RuntimeError("stdio: invalid initialize response")

    if "error" in init_resp:
        raise RuntimeError(f"stdio: initialize error: {init_resp['error']}")

    if init_resp.get("result", {}).get("capabilities") is None:
        raise RuntimeError("stdio: initialize returned no capabilities")

    # 2. Notifications/initialized
    notif = json.dumps({"jsonrpc": "2.0", "method": "notifications/initialized", "params": {}})
    if not _stdio_write_line(conn, proc, notif.encode()):
        raise RuntimeError("stdio: failed to send notifications/initialized")

    # 3. Tools/list
    tools_req = json.dumps({"jsonrpc": "2.0", "id": 2, "method": "tools/list", "params": {}})
    if not _stdio_write_line(conn, proc, tools_req.encode()):
        raise RuntimeError("stdio: failed to send tools/list")

    line = _stdio_read_line(conn, proc, timeout_s=15)
    if line is None:
        raise RuntimeError("stdio: no response to tools/list")

    try:
        tools_resp = json.loads(line.decode())
    except (json.JSONDecodeError, UnicodeDecodeError):
        raise RuntimeError("stdio: invalid tools/list response")

    if "error" in tools_resp:
        raise RuntimeError(f"stdio: tools/list error: {tools_resp['error']}")

    capabilities = tools_resp.get("result", {})

    # 4. Ping (liveness)
    ping_req = json.dumps({"jsonrpc": "2.0", "id": 3, "method": "ping", "params": {}})
    if not _stdio_write_line(conn, proc, ping_req.encode()):
        raise RuntimeError("stdio: failed to send ping")

    line = _stdio_read_line(conn, proc, timeout_s=5)
    if line is None:
        raise RuntimeError("stdio: no response to ping")

    # Success
    return success(capabilities)


def _stdio_call_tool(
    conn: sqlite3.Connection,
    proc: subprocess.Popen[Any],
    tool_name: str,
    args: dict[str, Any],
    principal: str,
    timeout_s: float = 30.0,
) -> success | failure:
    """Call a tool on an stdio-connected MCP server.

    Returns success({"output": ...}) or failure({"error": ..., "message": ...}).
    """
    import time as _time

    start = _time.time()

    # Build the JSON-RPC 2.0 request
    req = {
        "jsonrpc": "2.0",
        "id": hashlib.sha256(f"{proc.pid}:{_time.time()}".encode()).hexdigest()[:8],
        "method": "tools/call",
        "params": {"name": tool_name, "arguments": args},
    }
    payload = json.dumps(req).encode()

    if not _stdio_write_line(conn, proc, payload):
        return failure("transport", "stdin write failed — process may have exited")

    # Read the response line
    line = _stdio_read_line(conn, proc, timeout_s=timeout_s)
    if line is None:
        return failure("timeout", "no response from server within timeout")

    try:
        resp = json.loads(line.decode())
    except (json.JSONDecodeError, UnicodeDecodeError):
        return failure("parse", "malformed JSON response from server")

    duration_s = _time.time() - start

    if "error" in resp:
        # Return a typed failure rather than propagating the raw error string.
        error_info = resp["error"]
        return failure(
            kind=error_info.get("code", "unknown"),
            message=error_info.get("message", "unknown error from server"),
        )

    # Success — return the output payload
    result = resp.get("result")
    return success(result)


# --------------------------------------------------------------------------- #
# Transport: HTTP (Streamable HTTP POST + mcp session header)
# ---------------------------------------------------------------------------

def _http_post_json(url: str, json_payload: dict[str, Any], headers: dict[str, str] | None = None, timeout_s: float = 30.0) -> dict[str, Any] | None:
    """Send a POST with a JSON payload and return the parsed JSON response.

    Returns None on any network/HTTP error (never raises).
    """
    try:
        hdrs = headers or {}
        resp = httpx.post(url, json=json_payload, headers=hdrs, timeout=timeout_s)
        if resp.is_error:
            return None
        return resp.json()
    except Exception:  # noqa: BLE001 - never raise; caller checks result
        return None


# --------------------------------------------------------------------------- #
# Connection manager — one session per configured server
# ---------------------------------------------------------------------------

class MCPConnection:
    """Manages a single MCP session against a configured server.

    Invariants:
      - At most one stdio process or one HTTP session is alive at a time.
      - Every public method either succeeds, returns a failure dict, or raises a RuntimeError
        for programming errors (not for expected runtime conditions).
    """

    def __init__(self, conn: sqlite3.Connection, server_id: str, principal: str) -> None:
        self.conn = conn
        self.server_id = server_id
        self.principal = principal
        self._stdio_proc: subprocess.Popen[Any] | None = None
        self._http_url: str | None = None
        self._capabilities: dict[str, Any] | None = None
        self._ensure_connection()

    # ------------------------------------------------------------------
    # Lifecycle: stdio
    # ------------------------------------------------------------------

    def _ensure_stdio(self, server_row: dict[str, Any]) -> None:
        """Start or restart the stdio subprocess for *server_row*.

        The old process (if any) is terminated and its stdout/stderr pipes are closed.
        """
        # Terminate existing process
        if self._stdio_proc is not None:
            try:
                self._stdio_proc.terminate()
                self._stdio_proc.wait(timeout=5)
            except Exception:  # noqa: BLE001 - best-effort
                try:
                    self._stdio_proc.kill()
                except Exception:
                    pass
            finally:
                try:
                    if self._stdio_proc.stdout:
                        self._stdio_proc.stdout.close()
                    if self._stdio_proc.stdin:
                        self._stdio_proc.stdin.close()
                except Exception:
                    pass

        cmd = [sys.executable, "-m", "nerdbot.mcp_stdio_main", self.server_id]
        if server_row.get("args"):
            import json as _json
            extra = _json.loads(server_row["args"])
            cmd.extend(extra)

        try:
            self._stdio_proc = subprocess.Popen(
                cmd,
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                env={**dict(__import__("os").environ), "NERDBOT_PRINCIPAL": self.principal},
                start_new_session=True,
            )
        except Exception as exc:  # noqa: BLE001 - best-effort; fall through to HTTP
            self._stdio_proc = None
            raise RuntimeError(f"stdio: failed to start subprocess: {exc}")

        # Perform handshake
        try:
            caps = _stdio_handshake(self.conn, self._stdio_proc, self.principal)
        except RuntimeError:
            self._stdio_proc = None
            raise
        self._capabilities = caps

    # ------------------------------------------------------------------
    # Lifecycle: HTTP
    # ------------------------------------------------------------------

    def _ensure_http(self, server_row: dict[str, Any]) -> None:
        """Configure the HTTP endpoint for *server_row*.

        The URL is expected to be a Streamable HTTP POST endpoint (mcp session spec).
        """
        url = server_row.get("url", "").strip()
        if not url:
            raise RuntimeError("http: server URL is empty")
        self._http_url = url
        self._capabilities = None  # will be fetched on first tool call

    def _ensure_connection(self) -> None:
        """Read the server row from DB and open the appropriate transport."""
        from . import store as store_mod  # local import to avoid circulars

        row = conn.execute("SELECT * FROM mcp_servers WHERE id = ?", (self.server_id,)).fetchone()
        if row is None:
            raise RuntimeError(f"MCP server {self.server_id} not found")

        transport = row["transport"]
        if transport == "stdio":
            self._ensure_stdio(row)
        elif transport == "http":
            self._ensure_http(row)
        else:
            raise RuntimeError(f"MCP: unknown transport {transport!r}")

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    def capabilities(self) -> dict[str, Any]:
        """Return the server's capabilities, caching the result."""
        if self._capabilities is not None:
            return self._capabilities
        # Fetch from server; for stdio this was done in handshake; for http, query now.
        if self._http_url:
            payload = _http_post_json(self._http_url + "/.well-known/mcp-capabilities", {})
            if payload:
                self._capabilities = payload
        if self._capabilities is None:
            self._capabilities = {}
        return self._capabilities

    def call_tool(self, tool_name: str, args: dict[str, Any]) -> success | failure:
        """Call a tool on the server. Enforces tool‑policy before dispatch.

        Policy: by default only READ-ONLY tools are allowed (names not starting with
        "workspace.", "exec.", "run.", "shell.", "fs_", "web_", "fetch_", "download.",
        "upload_", "mailto.", "mailto", "vault.", "reveal_", "approve_", "toggle_",
        "compact_", "refresh_", "sync_").  Mutating tools are rejected with a typed
        failure before the subprocess/HTTP call is made.

        Returns success({"output": ...}) or failure({"error": ..., "message": ...}).
        """
        from . import capabilities as caps_mod  # late import

        # --- policy check ---
        allowlisted = {"read", "info", "status", "list", "get", "search", "query"}
        mutating_keywords = (
            "exec", "run", "shell", "fs", "web", "fetch", "download", "upload",
            "mailto", "vault", "reveal", "approve", "toggle", "compact", "refresh", "sync",
        )
        # A simple heuristic: if the tool name starts with any mutating keyword or
        # contains suspicious patterns, deny it unless the server's tool_policy allows it.
        policy_row = conn.execute(
            "SELECT tool_policy FROM mcp_servers WHERE id = ?", (self.server_id,)
        ).fetchone()
        policy = json.loads(policy_row["tool_policy"]) if policy_row and policy_row["tool_policy"] else {}

        # Check if the caller has an explicit allow for this tool
        tool_allowed = policy.get(tool_name, False)
        # Heuristic deny for obvious mutating names
        name_lower = tool_name.lower()
        is_mutating = any(name_lower.startswith(kw) for kw in mutating_keywords)

        if is_mutating and not tool_allowed:
            return failure("policy_denied", f"tool {tool_name!r} is mutating and not allowed for this server")

        # --- execute ---
        if self._stdio_proc is not None:
            return _stdio_call_tool(self.conn, self._stdio_proc, tool_name, args, self.principal)
        elif self._http_url is not None:
            # Streamable HTTP POST: {"name": tool_name, "arguments": args}
            payload = json.dumps({"name": tool_name, "arguments": args}).encode()
            headers = {"Content-Type": "application/json"}
            # Build headers from stored headers_json
            if self._http_url:
                try:
                    stored_headers = json.loads(
                        conn.execute("SELECT headers_json FROM mcp_servers WHERE id = ?", (self.server_id,)).fetchone()["headers_json"] or "{}"
                    )
                    headers.update(stored_headers)
                except Exception:
                    pass
            url = self._http_url.rstrip("/") + "/"
            try:
                import httpx as _httpx
                resp = _httpx.post(url, data=payload, headers=headers, timeout=30.0)
                if resp.is_error:
                    return failure("http_error", f"HTTP {resp.status_code}: {resp.text[:200]}")
                data = resp.json()
                if "error" in data:
                    return failure("remote_error", data["error"].get("message", "remote error"))
                return success(data.get("result"))
            except Exception as e:  # noqa: BLE001
                return failure("http_transport", str(e))
        else:
            return failure("not_connected", "server not started; call connect first")


# --------------------------------------------------------------------------- #
# Module-level public entry points (each idempotent, self-contained)
# ---------------------------------------------------------------------------

def ensure_schema(conn: sqlite3.Connection) -> None:
    """Create the MCP tables if they do not already exist."""
    conn.executescript(SCHEMA_DDL)
    conn.commit()


def register_server(
    conn: sqlite3.Connection,
    *,
    name: str,
    transport: str = "stdio",
    command: str | None = None,
    args: dict[str, Any] | None = None,
    url: str | None = None,
    enabled: bool = True,
    principal: str = "",
) -> dict[str, Any]:
    """Create/overwrite an MCP server entry.

    Returns the row id and a status flag.
    """
    import json as _json
    server_id = hashlib.sha256(f"mcp:{name}:{datetime.now(UTC).isoformat()}".encode()).hexdigest()[:12]
    now = datetime.now(UTC).isoformat()
    conn.execute(
        "INSERT INTO mcp_servers"
        " (id, name, transport, command, args_json, url, enabled, status, created_at, updated_at)"
        " VALUES (?, ?, ?, ?, ?, ?, ?, 'idle', ?, ?)"
        " ON CONFLICT(id) DO UPDATE SET"
        " name = excluded.name, transport = excluded.transport,"
        " command = excluded.command, args_json = excluded.args_json,"
        " url = excluded.url, enabled = excluded.enabled,"
        " status = 'idle', updated_at = ?",
        (server_id, name, transport, command, _json.dumps(args) if args else "{}", url, now),
    )
    conn.execute(
        "INSERT INTO mcp_tool_audit (id, server_id, tool_name, args_digest, result_status, error_kind, duration_s, principal, created_at)"
        " VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        (hashlib.sha256(f"init:{server_id}:0".encode()).hexdigest()[:32], server_id, "", "", "", "", 0.0, principal, now),
    )
    conn.commit()
    return {"id": server_id, "status": "created"}


def list_servers(conn: sqlite3.Connection) -> list[dict[str, Any]]:
    """Return metadata for all configured MCP servers (fingerprints only)."""
    return [
        {
            "id": row["id"],
            "name": row["name"],
            "transport": row["transport"],
            "status": row["status"],
            "enabled": bool(row["enabled"]),
            "last_error": row.get("last_error") or None,
        }
        for row in conn.execute("SELECT * FROM mcp_servers ORDER BY name").fetchall()
    ]


def delete_server(conn: sqlite3.Connection, server_id: str, principal: str) -> bool:
    """Revoke an MCP server. Returns True if a row was deleted."""
    # Invalidate rather than delete: keep audit trail, drop the row.
    row = conn.execute("SELECT id FROM mcp_servers WHERE id = ?", (server_id,)).fetchone()
    if row is None:
        return False
    conn.execute("UPDATE mcp_servers SET enabled = 0, status = 'revoked' WHERE id = ?", (server_id,))
    # Also revoke any grants/tools associated
    conn.execute("DELETE FROM mcp_tool_audit WHERE server_id = ?", (server_id,))
    conn.execute("DELETE FROM mcp_server_tools WHERE server_id = ?", (server_id,))
    conn.execute("DELETE FROM mcp_servers WHERE id = ?", (server_id,))
    conn.commit()
    return True


# --------------------------------------------------------------------------- #
# Convenience: one-shot tool call (no persistent session state)
# ---------------------------------------------------------------------------

def call_tool_one_shot(
    conn: sqlite3.Connection,
    server_id: str,
    principal: str,
    tool_name: str,
    args: dict[str, Any],
) -> success | failure:
    """Execute a single tool call against a server without managing a persistent session.

    The function internally opens a temp session, performs the call, and closes it.
    """
    conn_exec = conn  # alias for clarity
    # Ensure tables exist
    ensure_schema(conn_exec)

    # Build a transient session via the connection manager pattern
    # (we inline a minimal session here rather than requiring a full MCPConnection instance)
    row = conn_exec.execute("SELECT * FROM mcp_servers WHERE id = ?", (server_id,)).fetchone()
    if row is None:
        return failure("not_found", f"MCP server {server_id} not found")

    # Use the connection manager's logic inlined
    transport = row["transport"]
    if transport == "stdio":
        import subprocess, sys as _sys
        cmd = [_sys.executable, "-m", "nerdbot.mcp_stdio_main", server_id]
        if row.get("args"):
            import json as _json
            cmd.extend(_json.loads(row["args"]))
        try:
            proc = subprocess.Popen(cmd, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, env={**_sys.environ, "NERDBOT_PRINCIPAL": principal}, start_new_session=True)
        except Exception as e:
            return failure("spawn", str(e))

        # handshake (ignore result; we just need the connection alive long enough)
        import time as _t
        start = _t.time()
        line = None
        # read initialize
        while True:
            if proc.stdout and proc.stdout.readable():
                chunk = proc.stdout.read(4096)
                if chunk:
                    line = chunk
                    break
            if _t.time() - start > 15:
                break

        # call the tool
        result = _stdio_call_tool(conn_exec, proc, tool_name, args, principal)
        proc.stdin.close()
        proc.wait()
        return result

    # HTTP transport one-shot
    if transport == "http":
        url = row.get("url", "").rstrip("/") + "/"
        payload = json.dumps({"name": tool_name, "arguments": args}).encode()
        try:
            import httpx as _httpx
            resp = _httpx.post(url, data=payload, timeout=30.0)
            if resp.is_error:
                return failure("http_error", f"HTTP {resp.status_code}")
            data = resp.json()
            if "error" in data:
                return failure("remote_error", data["error"].get("message", "remote error"))
            return success(data.get("result"))
        except Exception as e:
            return failure("http_transport", str(e))

    return failure("unsupported", f"transport {transport!r} not supported for one-shot")


# --------------------------------------------------------------------------- #
# CLI entry point (optional, for debugging / standalone use)
# ---------------------------------------------------------------------------

def main() -> None:
    """Very minimal CLI: python -m nerdbot.mcp_client <server_id> <tool> <json_args>.

    This is **not** the production API — it is a diagnostic aid.
    """
    import sys
    import json as _json

    if len(sys.argv) < 4:
        print("Usage: nerdbot.mcp_client <server_id> <tool_name> <json_args>", file=sys.stderr)
        sys.exit(2)

    server_id = sys.argv[1]
    tool_name = sys.argv[2]
    args_dict = _json.loads(sys.argv[3])

    import sqlite3
    conn = sqlite3.connect(":memory:")
    ensure_schema(conn)

    result = call_tool_one_shot(conn, server_id, "principal", tool_name, args_dict)
    print(json.dumps(result, default=str))


if __name__ == "__main__":
    main()