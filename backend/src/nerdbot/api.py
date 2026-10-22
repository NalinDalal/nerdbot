"""Product API: REST endpoints for projects, teammates, tasks, runs, artifacts."""

from __future__ import annotations

import os
import sqlite3
import threading
import uuid
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any

from fastapi import Depends, FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel
from starlette.responses import Response

from . import backup as backup_mod
from . import boards as boards_mod
from . import capabilities as capabilities_mod
from . import chat as chat_mod
from . import decomposition as decomposition_mod
from . import delegation as delegation_mod
from . import executor as executor_mod
from . import fleet as fleet_mod
from . import gates as gates_mod
from . import knowledge as knowledge_mod
from . import metrics as metrics_mod
from . import notify as notify_mod
from . import orchestrator, schemas, store
from . import permissions as permissions_mod
from . import providers as providers_impl
from . import runtime as runtime_mod
from . import secrets as secrets_mod
from . import workspace as workspace_mgr
from .auth import PRINCIPAL, expected_token, principal_from_header, require_project_owner
from .integrations.github import (
    GitHubAuthError,
    GitHubConfigurationError,
    GitHubNotFoundError,
    GitHubProtocolError,
    GitHubRateLimitError,
    fetch_github_issue,
    github_status,
)
from .models import (
    BOARD_MEMBER_ROLES,
    BoardMemberRole,
    Decision,
    Provider,
    ProviderKind,
    ProviderStatus,
    ReviewVerdict,
    TaskStatus,
    Teammate,
    TeammateStatus,
)
from .providers import (
    ProviderAuthenticationError,
    ProviderConfigurationError,
    ProviderNetworkError,
    ProviderProtocolError,
    ProviderRateLimitError,
    ProviderTimeoutError,
    ProviderToolError,
)
from .store import get_conn


def _db_path() -> str:
    return os.environ.get("NERDBOT_DB", "nerdbot.db")


def _data_dir() -> str:
    return os.environ.get("NERDBOT_DATA", ".nerdbot-data")


def _run_wall_clock_s() -> float:
    """Agent-run wall-clock budget, seconds (default 60).

    A slow provider (e.g. a local model serving one request per turn) needs a
    bigger budget; without this knob every such run hit the fixed 60s deadline
    and failed with ``provider timed out`` before it could finish.
    """
    raw = os.environ.get("NERDBOT_RUN_TIMEOUT_S", "60")
    try:
        value = float(raw)
    except ValueError as exc:
        raise ValueError("NERDBOT_RUN_TIMEOUT_S must be a number of seconds") from exc
    if value <= 0:
        raise ValueError("NERDBOT_RUN_TIMEOUT_S must be positive")
    return value


def _provider_error_to_http(exc: Exception) -> HTTPException | None:
    """Map typed model/provider failures to actionable HTTP statuses.

    Model calls (chat, decomposition) can fail for reasons the caller must be
    able to act on: missing configuration, bad credentials, rate limits,
    timeouts, or an unreachable upstream. Without this mapping they escape as a
    bare 500. Returns ``None`` for anything unrecognized so callers can let a
    genuine bug surface as a 500 instead of disguising it as a provider fault.
    """
    if isinstance(exc, ProviderConfigurationError):
        return HTTPException(status_code=400, detail=str(exc))
    if isinstance(exc, ProviderAuthenticationError):
        return HTTPException(status_code=401, detail=str(exc))
    if isinstance(exc, ProviderRateLimitError):
        return HTTPException(status_code=429, detail=str(exc))
    if isinstance(
        exc,
        (
            ProviderTimeoutError,
            ProviderProtocolError,
            ProviderNetworkError,
            ProviderToolError,
        ),
    ):
        return HTTPException(status_code=502, detail=str(exc))
    return None


class MemoryBody(BaseModel):
    scope: str
    content: str
    source: str
    confidence: float = 0.5


def _enforce_memory_scope(
    conn: sqlite3.Connection, acting: Teammate | None, scope: str
) -> None:
    """Fail-closed memory isolation by teammate identity.

    A teammate may always touch its own ``teammate:<id>`` scope, and the
    shared ``project:<id>`` scope only when its ``memory_scope`` is
    ``"project"``. Any other scope (another teammate's identity scope, or a
    foreign project) is denied. The human owner (acting=None) is unrestricted.
    """
    del conn
    if acting is None:
        return
    allowed = {f"teammate:{acting.id}"}
    if acting.memory_scope == "project":
        allowed.add(f"project:{acting.project_id}")
    if scope not in allowed:
        raise HTTPException(
            status_code=403,
            detail=f"teammate may not access memory scope {scope!r}",
        )


def _project_counts(conn: sqlite3.Connection, project_id: str) -> dict[str, int]:
    """What a workspace holds, in one pass.

    Counts the fleet, the work in flight and the decisions waiting, so a
    workspace can be described without opening it.
    """
    tasks = store.list_tasks_for_project(conn, project_id)
    runs = store.list_runs_for_project(conn, project_id)
    approvals = store.list_approvals_for_project(conn, project_id)
    teammates = store.list_teammates(conn, project_id)
    boards = store.list_boards(conn, project_id)
    return {
        "bots": len(teammates),
        "tasks": len(tasks),
        "running": sum(1 for t in tasks if t.status == TaskStatus.RUNNING),
        "blocked": sum(1 for t in tasks if t.status == TaskStatus.BLOCKED),
        "done": sum(1 for t in tasks if t.status == TaskStatus.DONE),
        "boards": len(boards),
        "runs": len(runs),
        "approvals": sum(1 for a in approvals if store.approval_is_pending(a)),
    }


def _team_counts(conn: sqlite3.Connection, team_id: str) -> dict[str, int]:
    """How many bots and workspaces a team holds.

    A team member row is a (team, workspace) pair. When it carries a
    teammate id it is a bot in the team, otherwise it is the workspace
    itself attached to the team.
    """
    members = store.list_team_members(conn, team_id)
    bots = sum(1 for m in members if m.teammate_id)
    workspaces = sum(1 for m in members if not m.teammate_id)
    return {"bots": bots, "workspaces": workspaces}


def create_app() -> FastAPI:
    @asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        conn = store.connect(_db_path())
        try:
            app.state.recovered_runs = orchestrator.recover_incomplete_runs(conn)
            app.state.restart_count = store.meta_incr(conn, "restart_count")
        finally:
            conn.close()

        # Optional autonomous executor loop: claims pending unowned tasks to
        # available bots and runs them. Only active when NERDBOT_EXECUTOR=1.
        _executor_stop = threading.Event()
        _executor_thread: threading.Thread | None = None
        if os.environ.get("NERDBOT_EXECUTOR", "0") == "1":
            interval_s = float(os.environ.get("NERDBOT_EXECUTOR_INTERVAL_S", "10.0"))
            data_dir = _data_dir()
            timeout_s = float(os.environ.get("NERDBOT_EXECUTOR_TIMEOUT_S", "60.0"))
            max_tasks = int(os.environ.get("NERDBOT_EXECUTOR_MAX_TASKS", "10"))
            _executor_thread = threading.Thread(
                target=executor_mod.sweep_loop,
                kwargs={
                    "interval_s": interval_s,
                    "data_dir": data_dir,
                    "timeout_s": timeout_s,
                    "max_tasks": max_tasks,
                    "stop_event": _executor_stop,
                },
                daemon=True,
                name="nerdbot-executor",
            )
            _executor_thread.start()
        try:
            yield
        finally:
            _executor_stop.set()
            if _executor_thread is not None:
                _executor_thread.join(timeout=5.0)

    app = FastAPI(title="NerdBot Workspace", lifespan=lifespan)

    app.add_middleware(
        CORSMiddleware,
        allow_origins=[
            "http://localhost:8080",
            "http://127.0.0.1:8080",
            "http://localhost:5173",
            "http://127.0.0.1:5173",
        ],
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    import logging as _logging

    _logger = _logging.getLogger("nerdbot.api")

    @app.middleware("http")
    async def request_tracing(request: Request, call_next: Any) -> Any:
        request_id = request.headers.get("X-Request-ID") or uuid.uuid4().hex[:12]
        principal = "anonymous"
        auth = request.headers.get("Authorization", "")
        if (
            expected_token()
            and auth.startswith("Bearer ")
            and auth[len("Bearer ") :] == expected_token()
        ):
            principal = PRINCIPAL
        response = await call_next(request)
        response.headers["X-Request-ID"] = request_id
        _logger.info(
            "request",
            extra={
                "request_id": request_id,
                "principal": principal,
                "method": request.method,
                "path": request.url.path,
                "status": response.status_code,
            },
        )
        return response

    @app.get("/health")
    def health() -> dict[str, Any]:
        conn = store.connect(_db_path())
        try:
            conn.execute("SELECT 1").fetchone()
            db_ok = True
            restarts = int(store.meta_get(conn, "restart_count", "0") or 0)
        except Exception:
            db_ok = False
            restarts = 0
        finally:
            conn.close()
        # A malformed NERDBOT_SECRET_KEY makes keyring() raise; /health must
        # never 500 over it — "absent" is truthful for write purposes.
        try:
            secret_key_state = "configured" if secrets_mod.keyring() else "absent"
        except Exception:
            secret_key_state = "absent"
        return {
            "status": "ok",
            "version": "0.1.0",
            "db": "ok" if db_ok else "error",
            "secret_key": secret_key_state,
            "restarts": restarts,
        }

    @app.post("/projects")
    def create_project(
        body: schemas.ProjectCreate,
        conn: sqlite3.Connection = Depends(get_conn),
        principal: str = Depends(principal_from_header),
    ) -> dict[str, Any]:
        project = store.create_project(
            conn,
            owner=principal,
            repository=body.repository or "",
            config=dict(body.config or {}),
        )
        return project.model_dump(mode="json")

    @app.post("/projects/{project_id}/teammates")
    def create_teammate(
        project_id: str,
        body: schemas.TeammateCreate,
        conn: sqlite3.Connection = Depends(get_conn),
        principal: str = Depends(principal_from_header),
        acting: Teammate | None = Depends(boards_mod.acting_teammate_from_header),
    ) -> dict[str, Any]:
        require_project_owner(conn, project_id, principal)
        mate = fleet_mod.create_teammate_service(
            conn,
            project_id,
            persona=body.persona or "",
            instructions=body.instructions or "",
            capabilities=list(body.capabilities or []),
            memory_scope=body.memory_scope or "project",
            permissions=list(body.permissions or []),
            provider_id=body.provider_id or None,
            acting=acting,
        )
        return mate.model_dump(mode="json")

    def _mate_project(conn: sqlite3.Connection, teammate_id: str) -> str:
        mate = store.get_teammate(conn, teammate_id)
        if mate is None:
            raise HTTPException(status_code=404, detail="teammate not found")
        return mate.project_id

    def _parent_payload(conn: sqlite3.Connection, parent_task_id: str) -> dict[str, Any] | None:
        if not parent_task_id:
            return None
        parent = store.get_task(conn, parent_task_id)
        return parent.model_dump(mode="json") if parent else None

    @app.get("/projects/{project_id}/teammates")
    def list_teammates(
        project_id: str,
        conn: sqlite3.Connection = Depends(get_conn),
        principal: str = Depends(principal_from_header),
    ) -> dict[str, Any]:
        require_project_owner(conn, project_id, principal)
        mates = [m.model_dump(mode="json") for m in store.list_teammates(conn, project_id)]
        return {"teammates": mates}

    @app.get("/teammates/{teammate_id}")
    def get_teammate(
        teammate_id: str,
        conn: sqlite3.Connection = Depends(get_conn),
        principal: str = Depends(principal_from_header),
    ) -> dict[str, Any]:
        require_project_owner(conn, _mate_project(conn, teammate_id), principal)
        mate = store.get_teammate(conn, teammate_id)
        if mate is None:  # pragma: no cover - raced deletion
            raise HTTPException(status_code=404, detail="teammate not found")
        return mate.model_dump(mode="json")

    @app.patch("/teammates/{teammate_id}")
    def update_teammate(
        teammate_id: str,
        body: dict[str, Any],
        conn: sqlite3.Connection = Depends(get_conn),
        principal: str = Depends(principal_from_header),
        acting: Teammate | None = Depends(boards_mod.acting_teammate_from_header),
    ) -> dict[str, Any]:
        require_project_owner(conn, _mate_project(conn, teammate_id), principal)
        updates: dict[str, Any] = {
            "persona": body.get("persona"),
            "instructions": body.get("instructions"),
            "capabilities": body.get("capabilities"),
            "memory_scope": body.get("memory_scope"),
            "permissions": body.get("permissions"),
            "tool_policy": body.get("tool_policy"),
            "provider_id": body.get("provider_id"),
            # provider_id: null is an explicit DETACH (absent = no change)
            "clear_provider": ("provider_id" in body and body["provider_id"] is None),
        }
        mate = fleet_mod.update_teammate_service(
            conn, teammate_id, updates, acting=acting
        )
        return mate.model_dump(mode="json")

    @app.post("/teammates/{teammate_id}/disable")
    def disable_teammate(
        teammate_id: str,
        conn: sqlite3.Connection = Depends(get_conn),
        principal: str = Depends(principal_from_header),
        acting: Teammate | None = Depends(boards_mod.acting_teammate_from_header),
    ) -> dict[str, Any]:
        require_project_owner(conn, _mate_project(conn, teammate_id), principal)
        mate = fleet_mod.set_teammate_status_service(
            conn, teammate_id, TeammateStatus.DISABLED, acting=acting
        )
        return mate.model_dump(mode="json")

    @app.post("/teammates/{teammate_id}/archive")
    def archive_teammate(
        teammate_id: str,
        conn: sqlite3.Connection = Depends(get_conn),
        principal: str = Depends(principal_from_header),
        acting: Teammate | None = Depends(boards_mod.acting_teammate_from_header),
    ) -> dict[str, Any]:
        require_project_owner(conn, _mate_project(conn, teammate_id), principal)
        mate = fleet_mod.set_teammate_status_service(
            conn, teammate_id, TeammateStatus.ARCHIVED, acting=acting
        )
        return mate.model_dump(mode="json")

    # -- Teams -----------------------------------------------------------------

    @app.post("/teams")
    def create_team(
        body: dict[str, Any],
        conn: sqlite3.Connection = Depends(get_conn),
        principal: str = Depends(principal_from_header),
        acting: Teammate | None = Depends(boards_mod.acting_teammate_from_header),
    ) -> dict[str, Any]:
        if acting is not None:
            # Bot path: gated through the fleet service (team.create is
            # default-deny + approval-gated unless tool_policy says "auto").
            team = fleet_mod.create_team_service(
                conn,
                owner=principal,
                name=str(body.get("name", "")),
                description=str(body.get("description", "")),
                project_id=str(body.get("project_id", "")),
                member_ids=[str(m) for m in body.get("member_ids", []) or []],
                project_member_ids=[str(m) for m in body.get("project_member_ids", []) or []],
                acting=acting,
            )
            return team.model_dump(mode="json")
        team = store.create_team(
            conn,
            owner=principal,
            name=str(body.get("name", "")),
            description=str(body.get("description", "")),
        )
        for member_id in body.get("member_ids", []) or []:
            try:
                store.add_teammate_to_team(conn, team.id, str(member_id))
            except (KeyError, ValueError) as exc:
                raise HTTPException(status_code=400, detail=str(exc)) from exc
        for project_member_id in body.get("project_member_ids", []) or []:
            try:
                store.create_team_member(conn, team.id, str(project_member_id))
            except (KeyError, ValueError) as exc:
                raise HTTPException(status_code=400, detail=str(exc)) from exc
        return team.model_dump(mode="json")

    @app.get("/teams")
    def list_teams(
        conn: sqlite3.Connection = Depends(get_conn),
        principal: str = Depends(principal_from_header),
    ) -> dict[str, Any]:
        teams = [t.model_dump(mode="json") for t in store.list_teams(conn, principal)]
        # Membership counts travel beside the list so a team can be described
        # without opening it.
        counts = {team["id"]: _team_counts(conn, team["id"]) for team in teams}
        return {"teams": teams, "counts": counts}

    @app.get("/teams/{team_id}")
    def get_team(
        team_id: str,
        conn: sqlite3.Connection = Depends(get_conn),
        principal: str = Depends(principal_from_header),
    ) -> dict[str, Any]:
        team = store.get_team(conn, team_id)
        if team is None or team.owner != principal:
            raise HTTPException(status_code=404, detail="team not found")
        members = store.list_team_members(conn, team_id)
        projects = store.list_projects_for_team(conn, team_id)
        teammates = store.list_teammates_for_team(conn, team_id)
        return {
            "team": team.model_dump(mode="json"),
            "projects": [p.model_dump(mode="json") for p in projects],
            "teammates": [t.model_dump(mode="json") for t in teammates],
            "members": [m.model_dump(mode="json") for m in members],
        }

    @app.post("/teams/{team_id}/teammates")
    def add_team_teammate(
        team_id: str,
        body: dict[str, Any],
        conn: sqlite3.Connection = Depends(get_conn),
        principal: str = Depends(principal_from_header),
        acting: Teammate | None = Depends(boards_mod.acting_teammate_from_header),
    ) -> dict[str, Any]:
        team = store.get_team(conn, team_id)
        if team is None:
            raise HTTPException(status_code=404, detail="team not found")
        teammate_id = str(body.get("teammate_id", ""))
        if not teammate_id:
            raise HTTPException(status_code=400, detail="teammate_id is required")
        if acting is not None:
            member = fleet_mod.add_teammate_to_team_service(
                conn, team_id, teammate_id, acting=acting
            )
            return member.model_dump(mode="json")
        if team.owner != principal:
            raise HTTPException(status_code=404, detail="team not found")
        try:
            member = store.add_teammate_to_team(conn, team_id, teammate_id)
        except (KeyError, ValueError) as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        return member.model_dump(mode="json")

    @app.delete("/teams/{team_id}/teammates/{teammate_id}")
    def remove_team_teammate(
        team_id: str,
        teammate_id: str,
        conn: sqlite3.Connection = Depends(get_conn),
        principal: str = Depends(principal_from_header),
        acting: Teammate | None = Depends(boards_mod.acting_teammate_from_header),
    ) -> dict[str, Any]:
        team = store.get_team(conn, team_id)
        if team is None:
            raise HTTPException(status_code=404, detail="team not found")
        if acting is not None:
            fleet_mod.remove_teammate_from_team_service(
                conn, team_id, teammate_id, acting=acting
            )
            return {"removed": True}
        if team.owner != principal:
            raise HTTPException(status_code=404, detail="team not found")
        store.remove_teammate_from_team(conn, team_id, teammate_id)
        return {"removed": True}

    @app.post("/teams/{team_id}/projects")
    def add_team_project(
        team_id: str,
        body: dict[str, Any],
        conn: sqlite3.Connection = Depends(get_conn),
        principal: str = Depends(principal_from_header),
    ) -> dict[str, Any]:
        team = store.get_team(conn, team_id)
        if team is None or team.owner != principal:
            raise HTTPException(status_code=404, detail="team not found")
        project_id = str(body.get("project_id", ""))
        if not project_id:
            raise HTTPException(status_code=400, detail="project_id is required")
        try:
            member = store.create_team_member(conn, team_id, project_id)
        except (KeyError, ValueError) as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        return member.model_dump(mode="json")

    @app.delete("/teams/{team_id}/projects/{project_id}")
    def remove_team_project(
        team_id: str,
        project_id: str,
        conn: sqlite3.Connection = Depends(get_conn),
        principal: str = Depends(principal_from_header),
    ) -> dict[str, Any]:
        team = store.get_team(conn, team_id)
        if team is None or team.owner != principal:
            raise HTTPException(status_code=404, detail="team not found")
        store.remove_team_member(conn, team_id, project_id)
        return {"removed": True}

    # -- Boards (agent part) --------------------------------------------------

    @app.post("/boards")
    def create_board_endpoint(
        body: dict[str, Any],
        conn: sqlite3.Connection = Depends(get_conn),
        principal: str = Depends(principal_from_header),
        acting: Any = Depends(boards_mod.acting_teammate_from_header),
    ) -> dict[str, Any]:
        project_id = str(body.get("project_id", ""))
        if project_id:
            require_project_owner(conn, project_id, principal)
        try:
            board = boards_mod.create_board_service(
                conn,
                owner=principal,
                name=str(body.get("name", "")),
                description=str(body.get("description", "")),
                project_id=project_id,
                team_id=body.get("team_id") or None,
                acting=acting,
            )
        except (KeyError, ValueError) as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        return board.model_dump(mode="json")

    @app.get("/boards")
    def list_boards_endpoint(
        project_id: str | None = None,
        conn: sqlite3.Connection = Depends(get_conn),
        principal: str = Depends(principal_from_header),
        acting: Any = Depends(boards_mod.acting_teammate_from_header),
    ) -> dict[str, Any]:
        boards = boards_mod.list_boards_for_actor(
            conn,
            owner=principal,
            project_id=project_id,
            acting=acting,
        )
        return {"boards": [b.model_dump(mode="json") for b in boards]}

    @app.get("/boards/{board_id}")
    def get_board_endpoint(
        board_id: str,
        conn: sqlite3.Connection = Depends(get_conn),
        principal: str = Depends(principal_from_header),
        acting: Any = Depends(boards_mod.acting_teammate_from_header),
    ) -> dict[str, Any]:
        if acting is not None:
            # Bot path: needs the board.read permission AND membership of the
            # board (owner or member). Holding the permission alone is not
            # enough to read a board the bot is not part of.
            return boards_mod.read_board_service(conn, board_id, acting=acting)
        board = store.get_board(conn, board_id)
        if board is None:
            raise HTTPException(status_code=404, detail="board not found")
        require_project_owner(conn, board.project_id, principal)
        return boards_mod.board_detail_with_members(conn, board_id)

    @app.patch("/boards/{board_id}")
    def update_board_endpoint(
        board_id: str,
        body: dict[str, Any],
        conn: sqlite3.Connection = Depends(get_conn),
        principal: str = Depends(principal_from_header),
    ) -> dict[str, Any]:
        board = store.get_board(conn, board_id)
        if board is None:
            raise HTTPException(status_code=404, detail="board not found")
        require_project_owner(conn, board.project_id, principal)
        try:
            updated = store.update_board(
                conn,
                board_id,
                name=body.get("name"),
                description=body.get("description"),
                team_id=body.get("team_id"),
                status=None,
            )
        except (KeyError, ValueError) as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        return updated.model_dump(mode="json")

    @app.delete("/boards/{board_id}")
    def delete_board_endpoint(
        board_id: str,
        conn: sqlite3.Connection = Depends(get_conn),
        principal: str = Depends(principal_from_header),
        acting: Teammate | None = Depends(boards_mod.acting_teammate_from_header),
    ) -> dict[str, Any]:
        board = store.get_board(conn, board_id)
        if board is None:
            raise HTTPException(status_code=404, detail="board not found")
        require_project_owner(conn, board.project_id, principal)
        if acting is not None:
            # Bot path: board.delete is default-deny + digest-bound approval
            # (unless tool_policy sets it to "auto").
            try:
                gates_mod.require(
                    conn, acting, "board.delete", payload={"board_id": board_id}
                )
            except gates_mod.GateDenied as exc:
                raise HTTPException(status_code=403, detail=str(exc)) from exc
            except gates_mod.GateApprovalRequired as exc:
                raise HTTPException(
                    status_code=409,
                    detail={
                        "message": "action requires owner approval",
                        "approval": exc.approval.model_dump(mode="json"),
                    },
                ) from exc
        try:
            removed = boards_mod.delete_board_service(
                conn,
                board_id=board_id,
                acting=acting,
                require_approval=False,
                approved_approval_id=None,
            )
        except (KeyError, ValueError) as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        return removed.model_dump(mode="json")

    @app.post("/boards/{board_id}/members")
    def add_board_member_endpoint(
        board_id: str,
        body: dict[str, Any],
        conn: sqlite3.Connection = Depends(get_conn),
        principal: str = Depends(principal_from_header),
        acting: Any = Depends(boards_mod.acting_teammate_from_header),
    ) -> dict[str, Any]:
        board = store.get_board(conn, board_id)
        if board is None:
            raise HTTPException(status_code=404, detail="board not found")
        require_project_owner(conn, board.project_id, principal)
        teammate_id = str(body.get("teammate_id", ""))
        role = str(body.get("role", BoardMemberRole.MEMBER.value))
        try:
            member = boards_mod.add_board_member_service(
                conn, board_id=board_id, teammate_id=teammate_id, role=role, acting=acting
            )
        except (KeyError, ValueError) as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        return member.model_dump(mode="json")

    @app.delete("/boards/{board_id}/members/{teammate_id}")
    def remove_board_member_endpoint(
        board_id: str,
        teammate_id: str,
        conn: sqlite3.Connection = Depends(get_conn),
        principal: str = Depends(principal_from_header),
        acting: Any = Depends(boards_mod.acting_teammate_from_header),
    ) -> dict[str, Any]:
        board = store.get_board(conn, board_id)
        if board is None:
            raise HTTPException(status_code=404, detail="board not found")
        require_project_owner(conn, board.project_id, principal)
        try:
            boards_mod.remove_board_member_service(
                conn, board_id=board_id, teammate_id=teammate_id, acting=acting
            )
        except (KeyError, ValueError) as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        return {"removed": True}

    @app.get("/boards/{board_id}/members")
    def list_board_members_endpoint(
        board_id: str,
        conn: sqlite3.Connection = Depends(get_conn),
        principal: str = Depends(principal_from_header),
    ) -> dict[str, Any]:
        board = store.get_board(conn, board_id)
        if board is None:
            raise HTTPException(status_code=404, detail="board not found")
        require_project_owner(conn, board.project_id, principal)
        members = store.list_board_members(conn, board_id)
        return {"members": [m.model_dump(mode="json") for m in members]}

    @app.post("/boards/{board_id}/messages")
    def create_board_message_endpoint(
        board_id: str,
        body: dict[str, Any],
        conn: sqlite3.Connection = Depends(get_conn),
        principal: str = Depends(principal_from_header),
        acting: Any = Depends(boards_mod.acting_teammate_from_header),
    ) -> dict[str, Any]:
        board = store.get_board(conn, board_id)
        if board is None:
            raise HTTPException(status_code=404, detail="board not found")
        require_project_owner(conn, board.project_id, principal)
        to_board_id = body.get("to_board_id") or None
        to_teammate_id = body.get("to_teammate_id") or None
        kind = str(body.get("kind", "message"))
        try:
            message = boards_mod.create_board_message_service(
                conn,
                board_id=board_id,
                content=str(body.get("content", "")),
                to_board_id=to_board_id,
                from_teammate_id=acting.id if acting else None,
                to_teammate_id=to_teammate_id,
                kind=kind,
                acting=acting,
            )
        except (KeyError, ValueError) as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        return message.model_dump(mode="json")

    @app.get("/boards/{board_id}/messages")
    def list_board_messages_endpoint(
        board_id: str,
        conn: sqlite3.Connection = Depends(get_conn),
        principal: str = Depends(principal_from_header),
    ) -> dict[str, Any]:
        board = store.get_board(conn, board_id)
        if board is None:
            raise HTTPException(status_code=404, detail="board not found")
        require_project_owner(conn, board.project_id, principal)
        messages = store.list_board_messages(conn, board_id)
        return {"messages": [m.model_dump(mode="json") for m in messages]}

    @app.get("/boards/{board_id}/inbox")
    def list_board_inbox_endpoint(
        board_id: str,
        conn: sqlite3.Connection = Depends(get_conn),
        principal: str = Depends(principal_from_header),
    ) -> dict[str, Any]:
        board = store.get_board(conn, board_id)
        if board is None:
            raise HTTPException(status_code=404, detail="board not found")
        require_project_owner(conn, board.project_id, principal)
        inbox = store.list_board_messages_to(conn, board_id)
        return {"inbox": [m.model_dump(mode="json") for m in inbox]}

    @app.post("/boards/{board_id}/approval-request")
    def request_board_approval_endpoint(
        board_id: str,
        body: dict[str, Any],
        conn: sqlite3.Connection = Depends(get_conn),
        principal: str = Depends(principal_from_header),
    ) -> dict[str, Any]:
        board = store.get_board(conn, board_id)
        if board is None:
            raise HTTPException(status_code=404, detail="board not found")
        require_project_owner(conn, board.project_id, principal)
        try:
            approval = boards_mod.request_board_approval(
                conn,
                board_id=board_id,
                action=str(body.get("action", "board.mutate")),
                requester=principal,
                ttl_s=float(body.get("ttl_s", store.DEFAULT_APPROVAL_TTL_S)),
            )
        except (KeyError, ValueError) as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        return approval.model_dump(mode="json")

    @app.post("/boards/{board_id}/decompose")
    def decompose_board_endpoint(
        board_id: str,
        body: dict[str, Any],
        conn: sqlite3.Connection = Depends(get_conn),
        principal: str = Depends(principal_from_header),
        acting: Any = Depends(boards_mod.acting_teammate_from_header),
    ) -> dict[str, Any]:
        """Plan-review flow: ``preview: true`` returns a side-effect-free plan
        for the human to review; posting the reviewed ``plan`` back
        materializes exactly that plan. The one-shot path (objective only)
        plans and materializes in a single call.

        Bot callers are gated here like every other mutating surface: the
        decompose creates boards and tasks, so acting teammates need the
        matching permissions (no HTTP escape hatch around the tool gates).
        """
        board = store.get_board(conn, board_id)
        if board is None:
            raise HTTPException(status_code=404, detail="board not found")
        require_project_owner(conn, board.project_id, principal)
        project_id = board.project_id
        objective = str(body.get("objective", ""))
        plan_payload = body.get("plan")
        preview = bool(body.get("preview", False))
        create_board = bool(body.get("create_board", True))
        if plan_payload is None and not objective.strip():
            raise HTTPException(status_code=400, detail="objective is required")

        if acting is not None:
            # Bot path: decompose creates a board + tasks — gate both.
            try:
                gates_mod.require(conn, acting, "task.create", payload={"source": "decompose"})
                if create_board and not preview:
                    gates_mod.require(conn, acting, "board.create", payload={"source": "decompose"})
            except gates_mod.GateDenied as exc:
                raise HTTPException(status_code=403, detail=str(exc)) from exc
            except gates_mod.GateApprovalRequired as exc:
                raise HTTPException(
                    status_code=409,
                    detail={
                        "message": "action requires owner approval",
                        "approval": exc.approval.model_dump(mode="json"),
                    },
                ) from exc

        # Review leg: plan only, create nothing.
        if preview:
            provider = decomposition_mod.resolve_provider(conn, project_id)
            if provider is None:
                raise HTTPException(
                    status_code=400, detail="no provider available for decomposition"
                )
            try:
                plan = decomposition_mod.plan_objective(conn, project_id, objective, provider)
            except ValueError as exc:
                raise HTTPException(status_code=400, detail=str(exc)) from exc
            except Exception as exc:
                http_exc = _provider_error_to_http(exc)
                if http_exc is None:
                    raise
                raise http_exc from exc
            return {
                "board": None,
                "tasks": [],
                "plan": plan.model_dump(),
                "objective": objective,
                "preview": True,
            }

        # Materialize leg: the exact plan the human reviewed, no second LLM call.
        if plan_payload is not None:
            try:
                plan = decomposition_mod.Plan.model_validate(plan_payload)
            except Exception as exc:  # pydantic validation
                raise HTTPException(status_code=400, detail=f"invalid plan: {exc}") from exc
            # Bounds, dependency order, and owner facts are re-checked against
            # live state *before* anything is created: a reviewed plan whose
            # facts went stale (a bot was archived) is rejected whole, never
            # partially executed.
            known = {
                m.id
                for m in store.list_all_teammates(conn)
                if m.project_id == project_id and m.status == TeammateStatus.ACTIVE
            }
            problems = decomposition_mod.validate_plan(
                plan,
                project_id=project_id,
                acting_teammate_id=acting.id if acting else "",
                known_teammate_ids=known,
            )
            if problems:
                raise HTTPException(
                    status_code=400, detail=f"plan rejected: {'; '.join(problems)}"
                )
            return decomposition_mod.materialize_plan(
                conn,
                project_id,
                plan,
                objective=objective,
                board_name=str(body.get("board_name", "")) or None,
                create_board=create_board,
                acting_teammate_id=acting.id if acting else None,
            )

        # One-shot: plan and materialize in a single call.
        provider = decomposition_mod.resolve_provider(conn, project_id)
        if provider is None:
            raise HTTPException(
                status_code=400, detail="no provider available for decomposition"
            )
        try:
            result = decomposition_mod.decompose_objective(
                conn,
                project_id=project_id,
                objective=objective,
                provider=provider,
                board_name=str(body.get("board_name", "")) or None,
                create_board=create_board,
                acting_teammate_id=acting.id if acting else None,
            )
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        except Exception as exc:
            http_exc = _provider_error_to_http(exc)
            if http_exc is None:
                raise
            raise http_exc from exc
        return result

    @app.post("/projects/{project_id}/tasks")
    def create_task(
        project_id: str,
        body: schemas.TaskCreate,
        conn: sqlite3.Connection = Depends(get_conn),
        principal: str = Depends(principal_from_header),
    ) -> dict[str, Any]:
        require_project_owner(conn, project_id, principal)
        try:
            task = store.create_task(
                conn,
                project_id,
                description=body.description or "",
                owner_teammate_id=body.owner_teammate_id or None,
                dependencies=list(body.dependencies or []),
                command=body.command or "",
                issue_id=body.issue_id or None,
            )
        except (KeyError, ValueError) as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        return task.model_dump(mode="json")

    @app.post("/tasks/{task_id}/runs")
    def run_task(
        task_id: str,
        conn: sqlite3.Connection = Depends(get_conn),
        principal: str = Depends(principal_from_header),
    ) -> dict[str, Any]:
        task = store.get_task(conn, task_id)
        if task is None:
            raise HTTPException(status_code=404, detail="task not found")
        require_project_owner(conn, task.project_id, principal)
        try:
            run, result, artifact_id = orchestrator.schedule_run(
                conn,
                task_id,
                data_dir=_data_dir(),
                timeout_s=_run_wall_clock_s(),
            )
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        return {
            "run": run.model_dump(mode="json"),
            "exit_code": result.exit_code if result else None,
            "output_excerpt": result.output[-2000:] if result else None,
            "artifact_id": artifact_id,
            "task_status": (store.get_task(conn, task_id) or task).status.value,
        }

    @app.post("/tasks/{task_id}/retry")
    def retry_task(
        task_id: str,
        conn: sqlite3.Connection = Depends(get_conn),
        principal: str = Depends(principal_from_header),
    ) -> dict[str, Any]:
        task = store.get_task(conn, task_id)
        if task is None:
            raise HTTPException(status_code=404, detail="task not found")
        require_project_owner(conn, task.project_id, principal)
        try:
            run, result, artifact_id = orchestrator.retry_task(
                conn, task_id, data_dir=_data_dir(), timeout_s=_run_wall_clock_s()
            )
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        return {
            "run": run.model_dump(mode="json"),
            "exit_code": result.exit_code if result else None,
            "artifact_id": artifact_id,
        }

    @app.get("/tasks/{task_id}")
    def get_task_view(
        task_id: str,
        conn: sqlite3.Connection = Depends(get_conn),
        principal: str = Depends(principal_from_header),
    ) -> dict[str, Any]:
        task = store.get_task(conn, task_id)
        if task is None:
            raise HTTPException(status_code=404, detail="task not found")
        require_project_owner(conn, task.project_id, principal)
        runs = [r.model_dump(mode="json") for r in store.list_runs_for_task(conn, task_id)]
        artifacts = [
            a.model_dump(mode="json") for a in store.list_artifacts_for_task(conn, task_id)
        ]
        issue = store.get_issue(conn, task.issue_id) if task.issue_id else None
        reviews = [rv.model_dump(mode="json") for rv in store.list_reviews_for_task(conn, task_id)]
        packages = [
            p.model_dump(mode="json") for p in store.list_pr_packages_for_task(conn, task_id)
        ]
        # The approvals that belong to this task, so a task waiting on a
        # decision can be decided from the task itself.
        approvals = [
            a.model_dump(mode="json")
            for a in store.list_approvals_for_task(conn, task_id)
        ]
        return {
            "task": task.model_dump(mode="json"),
            "runs": runs,
            "artifacts": artifacts,
            "issue": issue.model_dump(mode="json") if issue else None,
            "reviews": reviews,
            "pr_packages": packages,
            "approvals": approvals,
            "delegations": [
                d.model_dump(mode="json")
                for d in store.list_delegations_for_task(conn, task_id)
            ],
            "children": [
                c.model_dump(mode="json") for c in store.list_child_tasks(conn, task_id)
            ],
            "parent": _parent_payload(conn, task.parent_task_id),
        }

    @app.post("/tasks/{task_id}/assign")
    def assign_task(
        task_id: str,
        body: dict[str, Any],
        conn: sqlite3.Connection = Depends(get_conn),
        principal: str = Depends(principal_from_header),
    ) -> dict[str, Any]:
        task = store.get_task(conn, task_id)
        if task is None:
            raise HTTPException(status_code=404, detail="task not found")
        require_project_owner(conn, task.project_id, principal)
        try:
            updated = store.assign_task_owner(conn, task_id, body.get("owner_teammate_id"))
        except (KeyError, ValueError) as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        return updated.model_dump(mode="json")

    # -- Delegations ------------------------------------------------------------

    @app.post("/tasks/{task_id}/delegate")
    def delegate_task(
        task_id: str,
        body: dict[str, Any],
        conn: sqlite3.Connection = Depends(get_conn),
        principal: str = Depends(principal_from_header),
    ) -> dict[str, Any]:
        task = store.get_task(conn, task_id)
        if task is None:
            raise HTTPException(status_code=404, detail="task not found")
        require_project_owner(conn, task.project_id, principal)
        from_id = str(body.get("from_teammate_id", ""))
        to_id = str(body.get("to_teammate_id", ""))
        reason = str(body.get("reason", ""))
        depth = int(body.get("depth", 1))
        try:
            delegation = store.create_delegation(
                conn, task_id, from_id, to_id, reason=reason, depth=depth
            )
        except (KeyError, ValueError) as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        return delegation.model_dump(mode="json")

    @app.get("/tasks/{task_id}/delegations")
    def list_task_delegations(
        task_id: str,
        conn: sqlite3.Connection = Depends(get_conn),
        principal: str = Depends(principal_from_header),
    ) -> dict[str, Any]:
        task = store.get_task(conn, task_id)
        if task is None:
            raise HTTPException(status_code=404, detail="task not found")
        require_project_owner(conn, task.project_id, principal)
        delegations = [
            d.model_dump(mode="json") for d in store.list_delegations_for_task(conn, task_id)
        ]
        return {"delegations": delegations}

    @app.post("/delegations/{delegation_id}/decide")
    def decide_delegation(
        delegation_id: str,
        body: dict[str, Any],
        conn: sqlite3.Connection = Depends(get_conn),
        principal: str = Depends(principal_from_header),
        acting: Teammate | None = Depends(boards_mod.acting_teammate_from_header),
    ) -> dict[str, Any]:
        """Accept or decline a delegation.

        The delegatee decides for itself. The human owner may act on the
        delegatee's behalf (for example when a bot has no model attached).
        A delegation that already left ``pending`` is never re-decided.
        """
        delegation = store.get_delegation(conn, delegation_id)
        if delegation is None:
            raise HTTPException(status_code=404, detail="delegation not found")
        task = store.get_task(conn, delegation.task_id)
        if task is None:
            raise HTTPException(status_code=404, detail="task not found")
        require_project_owner(conn, task.project_id, principal)
        decision = str(body.get("decision", ""))
        try:
            updated = delegation_mod.respond(
                conn,
                delegation,
                actor=acting,
                decision=decision,
                reason=str(body.get("reason", "")),
            )
        except delegation_mod.DelegationError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        except (KeyError, ValueError) as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        return updated.model_dump(mode="json")

    @app.post("/delegations/{delegation_id}/retry")
    def retry_delegation(
        delegation_id: str,
        body: dict[str, Any],
        conn: sqlite3.Connection = Depends(get_conn),
        principal: str = Depends(principal_from_header),
        acting: Teammate | None = Depends(boards_mod.acting_teammate_from_header),
    ) -> dict[str, Any]:
        """Re-delegate work that failed, was declined, or timed out.

        Only the delegator may retry, and the number of attempts is bounded.
        """
        delegation = store.get_delegation(conn, delegation_id)
        if delegation is None:
            raise HTTPException(status_code=404, detail="delegation not found")
        task = store.get_task(conn, delegation.task_id)
        if task is None:
            raise HTTPException(status_code=404, detail="task not found")
        require_project_owner(conn, task.project_id, principal)
        requester = acting
        if requester is None:
            # Owner path: the delegator is the bot that sent it.
            requester = store.get_teammate(conn, delegation.from_teammate_id)
        if requester is None:
            raise HTTPException(status_code=400, detail="the delegating bot no longer exists")
        try:
            retried = delegation_mod.retry(
                conn,
                delegation,
                actor=requester,
                to_teammate_id=body.get("to_teammate_id") or None,
                timeout_s=float(body.get("timeout_s", delegation_mod.DEFAULT_DELEGATION_TIMEOUT_S) or 0),
            )
        except delegation_mod.DelegationError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        except (KeyError, ValueError) as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        return retried.model_dump(mode="json")

    @app.post("/delegations/{delegation_id}/cancel")
    def cancel_delegation_endpoint(
        delegation_id: str,
        body: dict[str, Any],
        conn: sqlite3.Connection = Depends(get_conn),
        principal: str = Depends(principal_from_header),
        acting: Teammate | None = Depends(boards_mod.acting_teammate_from_header),
    ) -> dict[str, Any]:
        """Cancel an in-flight delegation.

        The human owner may cancel anything. A bot may cancel only the
        delegations it sent or received — never somebody else's.
        """
        delegation = store.get_delegation(conn, delegation_id)
        if delegation is None:
            raise HTTPException(status_code=404, detail="delegation not found")
        task = store.get_task(conn, delegation.task_id)
        if task is None:
            raise HTTPException(status_code=404, detail="task not found")
        require_project_owner(conn, task.project_id, principal)
        try:
            updated = store.cancel_delegation(
                conn,
                delegation_id,
                actor_teammate_id=acting.id if acting else "",
                reason=str(body.get("reason", "")),
            )
        except (KeyError, ValueError) as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        return updated.model_dump(mode="json")

    @app.post("/tasks/{task_id}/cancel")
    def cancel_task_endpoint(
        task_id: str,
        body: dict[str, Any],
        conn: sqlite3.Connection = Depends(get_conn),
        principal: str = Depends(principal_from_header),
        acting: Teammate | None = Depends(boards_mod.acting_teammate_from_header),
    ) -> dict[str, Any]:
        """Cancel a task: it is blocked and its pending delegations are
        cancelled so no bot picks it up afterwards."""
        task = store.get_task(conn, task_id)
        if task is None:
            raise HTTPException(status_code=404, detail="task not found")
        require_project_owner(conn, task.project_id, principal)
        if acting is not None and task.owner_teammate_id != acting.id:
            raise HTTPException(
                status_code=403, detail="only the task owner may cancel this task"
            )
        try:
            updated = store.cancel_task(
                conn,
                task_id,
                actor_teammate_id=acting.id if acting else "",
                reason=str(body.get("reason", "")),
            )
        except (KeyError, ValueError) as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        return updated.model_dump(mode="json")

    # -- Bot claim + teammate scope --------------------------------------------

    @app.post("/tasks/{task_id}/claim")
    def claim_task_endpoint(
        task_id: str,
        body: dict[str, Any],
        conn: sqlite3.Connection = Depends(get_conn),
        principal: str = Depends(principal_from_header),
    ) -> dict[str, Any]:
        task = store.get_task(conn, task_id)
        if task is None:
            raise HTTPException(status_code=404, detail="task not found")
        require_project_owner(conn, task.project_id, principal)
        teammate_id = str(body.get("teammate_id", ""))
        if not teammate_id:
            raise HTTPException(status_code=400, detail="teammate_id is required")
        try:
            updated = store.claim_task(conn, task_id, teammate_id)
        except (KeyError, ValueError) as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        return updated.model_dump(mode="json")

    @app.get("/teammates")
    def list_all_teammates(
        conn: sqlite3.Connection = Depends(get_conn),
        principal: str = Depends(principal_from_header),
    ) -> dict[str, Any]:
        mates = [
            m.model_dump(mode="json") for m in store.list_all_teammates(conn)
        ]
        return {"teammates": mates}

    @app.get("/teammates/{teammate_id}/tasks")
    def list_teammate_tasks(
        teammate_id: str,
        conn: sqlite3.Connection = Depends(get_conn),
        principal: str = Depends(principal_from_header),
    ) -> dict[str, Any]:
        mate = store.get_teammate(conn, teammate_id)
        if mate is None:
            raise HTTPException(status_code=404, detail="teammate not found")
        require_project_owner(conn, mate.project_id, principal)
        tasks = [
            t.model_dump(mode="json") for t in store.list_tasks_for_teammate(conn, teammate_id)
        ]
        return {"tasks": tasks}

    @app.get("/teammates/{teammate_id}/runs")
    def list_teammate_runs(
        teammate_id: str,
        conn: sqlite3.Connection = Depends(get_conn),
        principal: str = Depends(principal_from_header),
    ) -> dict[str, Any]:
        mate = store.get_teammate(conn, teammate_id)
        if mate is None:
            raise HTTPException(status_code=404, detail="teammate not found")
        require_project_owner(conn, mate.project_id, principal)
        runs = [
            r.model_dump(mode="json") for r in store.list_runs_for_teammate(conn, teammate_id)
        ]
        return {"runs": runs}

    @app.get("/teammates/{teammate_id}/teams")
    def list_teammate_teams(
        teammate_id: str,
        conn: sqlite3.Connection = Depends(get_conn),
        principal: str = Depends(principal_from_header),
    ) -> dict[str, Any]:
        """The teams this bot belongs to (membership never grants permissions)."""
        mate = store.get_teammate(conn, teammate_id)
        if mate is None:
            raise HTTPException(status_code=404, detail="teammate not found")
        require_project_owner(conn, mate.project_id, principal)
        teams = [
            t.model_dump(mode="json") for t in store.list_teams_for_teammate(conn, teammate_id)
        ]
        return {"teams": teams}

    @app.get("/teammates/{teammate_id}/delegations")
    def list_teammate_delegations(
        teammate_id: str,
        conn: sqlite3.Connection = Depends(get_conn),
        principal: str = Depends(principal_from_header),
    ) -> dict[str, Any]:
        """Every delegation this bot sent or received, for the chain view."""
        mate = store.get_teammate(conn, teammate_id)
        if mate is None:
            raise HTTPException(status_code=404, detail="teammate not found")
        require_project_owner(conn, mate.project_id, principal)
        delegations = [
            d.model_dump(mode="json")
            for d in store.list_delegations_for_teammate(conn, teammate_id)
        ]
        return {"delegations": delegations}

    # -- Executor -------------------------------------------------------------

    @app.post("/executor/sweep")
    def executor_sweep_endpoint(
        conn: sqlite3.Connection = Depends(get_conn),
        principal: str = Depends(principal_from_header),
    ) -> dict[str, Any]:
        data_dir = _data_dir()
        timeout_s = float(os.environ.get("NERDBOT_EXECUTOR_TIMEOUT_S", "60.0"))
        max_tasks = int(os.environ.get("NERDBOT_EXECUTOR_MAX_TASKS", "10"))
        results = executor_mod.sweep(
            conn, data_dir=data_dir, timeout_s=timeout_s, max_tasks=max_tasks
        )
        return {"processed": len(results), "results": results}

    @app.patch("/tasks/{task_id}")
    def update_task(
        task_id: str,
        body: dict[str, Any],
        conn: sqlite3.Connection = Depends(get_conn),
        principal: str = Depends(principal_from_header),
    ) -> dict[str, Any]:
        task = store.get_task(conn, task_id)
        if task is None:
            raise HTTPException(status_code=404, detail="task not found")
        require_project_owner(conn, task.project_id, principal)
        try:
            if "dependencies" in body:
                task = store.update_task_dependencies(
                    conn, task_id, list(body.get("dependencies", []))
                )
            if "description" in body or "command" in body:
                conn.execute(
                    "UPDATE tasks SET description = ?, command = ? WHERE id = ?",
                    (
                        str(body.get("description", task.description)),
                        str(body.get("command", task.command)),
                        task_id,
                    ),
                )
                conn.commit()
                store.record_event(conn, task.project_id, "task", task_id, "task.updated")
                refreshed = store.get_task(conn, task_id)
                if refreshed is not None:
                    task = refreshed
        except (KeyError, ValueError) as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        return task.model_dump(mode="json")

    @app.get("/projects/{project_id}/runs")
    def list_project_runs(
        project_id: str,
        conn: sqlite3.Connection = Depends(get_conn),
        principal: str = Depends(principal_from_header),
    ) -> dict[str, Any]:
        require_project_owner(conn, project_id, principal)
        runs = [r.model_dump(mode="json") for r in store.list_runs_for_project(conn, project_id)]
        return {"runs": runs}

    @app.get("/runs/{run_id}")
    def get_run(
        run_id: str,
        conn: sqlite3.Connection = Depends(get_conn),
        principal: str = Depends(principal_from_header),
    ) -> dict[str, Any]:
        run = store.get_run(conn, run_id)
        if run is None:
            raise HTTPException(status_code=404, detail="run not found")
        task = store.get_task(conn, run.task_id)
        if task is None:  # pragma: no cover - orphaned run
            raise HTTPException(status_code=404, detail="task not found")
        require_project_owner(conn, task.project_id, principal)
        artifacts = [
            a.model_dump(mode="json")
            for a in store.list_artifacts_for_task(conn, run.task_id)
            if a.run_id == run_id
        ]
        return {"run": run.model_dump(mode="json"), "artifacts": artifacts}

    @app.get("/artifacts/{artifact_id}")
    def get_artifact(
        artifact_id: str,
        conn: sqlite3.Connection = Depends(get_conn),
        principal: str = Depends(principal_from_header),
    ) -> dict[str, Any]:
        artifact = store.get_artifact(conn, artifact_id)
        if artifact is None:
            raise HTTPException(status_code=404, detail="artifact not found")
        task = store.get_task(conn, artifact.task_id)
        if task is None:  # pragma: no cover - orphaned artifact
            raise HTTPException(status_code=404, detail="task not found")
        require_project_owner(conn, task.project_id, principal)
        return artifact.model_dump(mode="json")

    @app.post("/runs/{run_id}/cancel")
    def cancel_run(
        run_id: str,
        conn: sqlite3.Connection = Depends(get_conn),
        principal: str = Depends(principal_from_header),
    ) -> dict[str, Any]:
        """Stop a run that is in flight.

        Two steps, in order: the request is recorded on the run row (so it
        is durable and visible even if the runtime never sees it), then the
        live process is signalled — the local runtime kills the command's
        process group, the provider adapter stops its model loop at the next
        turn boundary.

        ``signalled`` says whether the live process was reached directly. It
        is false when the cancel landed in the short window before the run
        registered itself with the runtime; the recorded request still stops
        that run, because the orchestrator honours it as it starts.

        A run that already finished cannot be cancelled: the endpoint says
        so with 409 rather than pretending the work was stopped.
        """
        run = store.get_run(conn, run_id)
        if run is None:
            raise HTTPException(status_code=404, detail="run not found")
        task = store.get_task(conn, run.task_id)
        if task is None:  # pragma: no cover - orphaned run
            raise HTTPException(status_code=404, detail="task not found")
        require_project_owner(conn, task.project_id, principal)
        try:
            store.request_run_cancel(conn, run_id)
        except store.TerminalRunError as exc:
            raise HTTPException(status_code=409, detail=str(exc)) from exc
        except KeyError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc
        # The runtime holds the live run; it stops the command in flight.
        signalled = runtime_mod.request_run_cancel(run_id)
        refreshed = store.get_run(conn, run_id)
        return {
            "run": (refreshed or run).model_dump(mode="json"),
            "cancel_requested": True,
            "signalled": signalled,
        }

    @app.delete("/tasks/{task_id}/workspace")
    def delete_task_workspace(
        task_id: str,
        conn: sqlite3.Connection = Depends(get_conn),
        principal: str = Depends(principal_from_header),
    ) -> dict[str, Any]:
        task = store.get_task(conn, task_id)
        if task is None:
            raise HTTPException(status_code=404, detail="task not found")
        require_project_owner(conn, task.project_id, principal)
        removed = workspace_mgr.cleanup_workspace(_data_dir(), task_id)
        store.record_event(conn, task.project_id, "workspace", task_id, "workspace.cleaned")
        return {"removed": removed}

    @app.post("/tasks/{task_id}/workspace")
    def ensure_task_workspace(
        task_id: str,
        body: dict[str, Any],
        conn: sqlite3.Connection = Depends(get_conn),
        principal: str = Depends(principal_from_header),
    ) -> dict[str, Any]:
        task = store.get_task(conn, task_id)
        if task is None:
            raise HTTPException(status_code=404, detail="task not found")
        require_project_owner(conn, task.project_id, principal)
        try:
            path, branch = orchestrator.ensure_task_workspace(
                conn,
                task_id,
                data_dir=_data_dir(),
                seed_from=body.get("seed_from"),
                base_branch=body.get("base_branch"),
            )
        except (KeyError, ValueError, RuntimeError) as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        return {"path": path, "branch": branch}

    @app.post("/tasks/{task_id}/reviews")
    def submit_task_review(
        task_id: str,
        body: dict[str, Any],
        conn: sqlite3.Connection = Depends(get_conn),
        principal: str = Depends(principal_from_header),
    ) -> dict[str, Any]:
        task = store.get_task(conn, task_id)
        if task is None:
            raise HTTPException(status_code=404, detail="task not found")
        require_project_owner(conn, task.project_id, principal)
        try:
            verdict = ReviewVerdict(str(body.get("verdict", "needs_work")))
        except ValueError as exc:
            raise HTTPException(status_code=400, detail="invalid verdict") from exc
        try:
            review, artifact_id = orchestrator.submit_review(
                conn,
                task_id,
                str(body.get("reviewer_teammate_id", "")),
                verdict,
                notes=str(body.get("notes", "")),
                risks=list(body.get("risks", [])),
                run_id=str(body.get("run_id", "")),
                data_dir=_data_dir(),
            )
        except (KeyError, ValueError) as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        return {"review": review.model_dump(mode="json"), "artifact_id": artifact_id}

    @app.get("/tasks/{task_id}/reviews")
    def list_task_reviews(
        task_id: str,
        conn: sqlite3.Connection = Depends(get_conn),
        principal: str = Depends(principal_from_header),
    ) -> dict[str, Any]:
        task = store.get_task(conn, task_id)
        if task is None:
            raise HTTPException(status_code=404, detail="task not found")
        require_project_owner(conn, task.project_id, principal)
        reviews = [r.model_dump(mode="json") for r in store.list_reviews_for_task(conn, task_id)]
        return {"reviews": reviews}

    @app.post("/tasks/{task_id}/patch")
    def capture_task_patch(
        task_id: str,
        body: dict[str, Any],
        conn: sqlite3.Connection = Depends(get_conn),
        principal: str = Depends(principal_from_header),
    ) -> dict[str, Any]:
        task = store.get_task(conn, task_id)
        if task is None:
            raise HTTPException(status_code=404, detail="task not found")
        require_project_owner(conn, task.project_id, principal)
        run_id = str(body.get("run_id", ""))
        if not run_id:
            latest = orchestrator.latest_run(conn, task_id)
            if latest is None:
                raise HTTPException(status_code=400, detail="task has no runs to patch from")
            run_id = latest.id
        try:
            artifact_id, diff = orchestrator.capture_patch(
                conn, task_id, run_id, data_dir=_data_dir()
            )
        except (KeyError, ValueError) as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        return {"artifact_id": artifact_id, "diff_chars": len(diff)}

    @app.post("/tasks/{task_id}/pr-package")
    def generate_task_pr_package(
        task_id: str,
        body: dict[str, Any],
        conn: sqlite3.Connection = Depends(get_conn),
        principal: str = Depends(principal_from_header),
    ) -> dict[str, Any]:
        task = store.get_task(conn, task_id)
        if task is None:
            raise HTTPException(status_code=404, detail="task not found")
        require_project_owner(conn, task.project_id, principal)
        try:
            package = orchestrator.generate_pr_package(
                conn,
                task_id,
                title=str(body.get("title", task.description)),
                body=str(body.get("body", "")),
                labels=list(body.get("labels", [])),
                data_dir=_data_dir(),
            )
        except (KeyError, ValueError) as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        return package.model_dump(mode="json")

    @app.get("/tasks/{task_id}/pr-package")
    def get_task_pr_package(
        task_id: str,
        conn: sqlite3.Connection = Depends(get_conn),
        principal: str = Depends(principal_from_header),
    ) -> dict[str, Any]:
        task = store.get_task(conn, task_id)
        if task is None:
            raise HTTPException(status_code=404, detail="task not found")
        require_project_owner(conn, task.project_id, principal)
        package = orchestrator.latest_pr_package(conn, task_id)
        if package is None:
            raise HTTPException(status_code=404, detail="no PR package for task")
        return package.model_dump(mode="json")

    @app.post("/tasks/{task_id}/package-approval")
    def request_task_package_approval(
        task_id: str,
        body: dict[str, Any],
        conn: sqlite3.Connection = Depends(get_conn),
        principal: str = Depends(principal_from_header),
    ) -> dict[str, Any]:
        task = store.get_task(conn, task_id)
        if task is None:
            raise HTTPException(status_code=404, detail="task not found")
        require_project_owner(conn, task.project_id, principal)
        try:
            approval = orchestrator.request_package_approval(
                conn,
                task_id,
                PRINCIPAL,
                ttl_s=float(body.get("ttl_s", store.DEFAULT_APPROVAL_TTL_S)),
            )
        except (KeyError, ValueError) as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        return approval.model_dump(mode="json")

    @app.post("/tasks/{task_id}/rollup")
    def build_task_rollup(
        task_id: str,
        conn: sqlite3.Connection = Depends(get_conn),
        principal: str = Depends(principal_from_header),
    ) -> dict[str, Any]:
        task = store.get_task(conn, task_id)
        if task is None:
            raise HTTPException(status_code=404, detail="task not found")
        require_project_owner(conn, task.project_id, principal)
        try:
            rollup = orchestrator.build_rollup(conn, task_id, data_dir=_data_dir())
        except (KeyError, ValueError) as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        return rollup

    @app.post("/projects/{project_id}/issues")
    def ingest_issue(
        project_id: str,
        body: dict[str, Any],
        conn: sqlite3.Connection = Depends(get_conn),
        principal: str = Depends(principal_from_header),
    ) -> dict[str, Any]:
        require_project_owner(conn, project_id, principal)
        try:
            issue = store.create_issue(
                conn,
                project_id,
                title=str(body.get("title", "")),
                body=str(body.get("body", "")),
                source=str(body.get("source", "manual")),
                external_id=str(body.get("external_id", "")),
                acceptance_criteria=list(body.get("acceptance_criteria", [])),
                repository_url=str(body.get("repository_url", "")),
                base_branch=str(body.get("base_branch", "main")),
                labels=list(body.get("labels", [])),
                owner_teammate_id=body.get("owner_teammate_id"),
                priority=str(body.get("priority", "medium")),
            )
        except (KeyError, ValueError) as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        return issue.model_dump(mode="json")

    @app.get("/projects/{project_id}/issues")
    def list_issues(
        project_id: str,
        conn: sqlite3.Connection = Depends(get_conn),
        principal: str = Depends(principal_from_header),
    ) -> dict[str, Any]:
        require_project_owner(conn, project_id, principal)
        issues = [
            i.model_dump(mode="json") for i in store.list_issues_for_project(conn, project_id)
        ]
        return {"issues": issues}

    @app.get("/issues/{issue_id}")
    def get_issue(
        issue_id: str,
        conn: sqlite3.Connection = Depends(get_conn),
        principal: str = Depends(principal_from_header),
    ) -> dict[str, Any]:
        issue = store.get_issue(conn, issue_id)
        if issue is None:
            raise HTTPException(status_code=404, detail="issue not found")
        require_project_owner(conn, issue.project_id, principal)
        tasks = [
            t.model_dump(mode="json")
            for t in store.list_tasks_for_project(conn, issue.project_id)
            if t.issue_id == issue_id
        ]
        return {"issue": issue.model_dump(mode="json"), "tasks": tasks}

    @app.get("/integrations/github/status")
    def get_github_status(
        principal: str = Depends(principal_from_header),
    ) -> dict[str, Any]:
        _ = principal
        return github_status()

    @app.post("/projects/{project_id}/github/preview")
    def preview_github_issue(
        project_id: str,
        body: dict[str, Any],
        conn: sqlite3.Connection = Depends(get_conn),
        principal: str = Depends(principal_from_header),
    ) -> dict[str, Any]:
        """Preview a GitHub issue as untrusted data. Nothing is ingested;
        POST the returned ``suggested_ingest`` to /issues to confirm."""
        require_project_owner(conn, project_id, principal)
        try:
            number = int(body.get("number", 0))
        except (TypeError, ValueError) as exc:
            raise HTTPException(status_code=400, detail="issue number must be an integer") from exc
        try:
            issue = fetch_github_issue(
                str(body.get("repository", "")),
                number,
                token_env=str(body.get("token_env", "")),
            )
        except GitHubConfigurationError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        except GitHubNotFoundError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc
        except GitHubAuthError as exc:
            raise HTTPException(status_code=401, detail=str(exc)) from exc
        except GitHubRateLimitError as exc:
            raise HTTPException(status_code=429, detail=str(exc)) from exc
        except (GitHubProtocolError, ValueError) as exc:
            raise HTTPException(status_code=502, detail=str(exc)) from exc
        return issue

    @app.post("/memory")
    def write_memory(
        body: MemoryBody,
        conn: sqlite3.Connection = Depends(get_conn),
        principal: str = Depends(principal_from_header),
        acting: Teammate | None = Depends(boards_mod.acting_teammate_from_header),
    ) -> dict[str, Any]:
        _ = principal
        _enforce_memory_scope(conn, acting, body.scope)
        entry = store.write_memory(conn, body.scope, body.content, body.source, body.confidence)
        return entry.model_dump(mode="json")

    @app.get("/memory")
    def recall_memory(
        scope: str,
        conn: sqlite3.Connection = Depends(get_conn),
        principal: str = Depends(principal_from_header),
        acting: Teammate | None = Depends(boards_mod.acting_teammate_from_header),
    ) -> dict[str, Any]:
        _ = principal
        _enforce_memory_scope(conn, acting, scope)
        try:
            entries = store.recall_memory(conn, scope)
        except store.MemoryReadError as exc:
            raise HTTPException(status_code=500, detail=str(exc)) from exc
        return {"entries": [e.model_dump(mode="json") for e in entries]}

    @app.post("/projects/{project_id}/memory")
    def write_project_memory(
        project_id: str,
        body: MemoryBody,
        conn: sqlite3.Connection = Depends(get_conn),
        principal: str = Depends(principal_from_header),
        acting: Teammate | None = Depends(boards_mod.acting_teammate_from_header),
    ) -> dict[str, Any]:
        require_project_owner(conn, project_id, principal)
        if acting is not None and acting.memory_scope != "project":
            raise HTTPException(
                status_code=403,
                detail="acting teammate has no project memory scope",
            )
        entry = store.write_memory(
            conn, f"project:{project_id}", body.content, body.source, body.confidence
        )
        store.record_event(conn, project_id, "memory", entry.id, "memory.stored")
        return entry.model_dump(mode="json")

    @app.get("/projects/{project_id}/memory")
    def recall_project_memory(
        project_id: str,
        conn: sqlite3.Connection = Depends(get_conn),
        principal: str = Depends(principal_from_header),
        acting: Teammate | None = Depends(boards_mod.acting_teammate_from_header),
    ) -> dict[str, Any]:
        require_project_owner(conn, project_id, principal)
        if acting is not None and acting.memory_scope != "project":
            raise HTTPException(
                status_code=403,
                detail="acting teammate has no project memory scope",
            )
        try:
            entries = store.recall_memory(conn, f"project:{project_id}")
        except store.MemoryReadError as exc:
            raise HTTPException(status_code=500, detail=str(exc)) from exc
        return {"entries": [e.model_dump(mode="json") for e in entries]}

    @app.post("/runs/{run_id}/approvals")
    def request_approval(
        run_id: str,
        body: dict[str, Any],
        conn: sqlite3.Connection = Depends(get_conn),
        principal: str = Depends(principal_from_header),
    ) -> dict[str, Any]:
        run = store.get_run(conn, run_id)
        if run is None:
            raise HTTPException(status_code=404, detail="run not found")
        task = store.get_task(conn, run.task_id)
        if task is None:  # pragma: no cover - orphaned run
            raise HTTPException(status_code=404, detail="task not found")
        require_project_owner(conn, task.project_id, principal)
        try:
            approval = store.request_approval(
                conn,
                str(body.get("action", "")),
                PRINCIPAL,
                run_id=run_id,
                ttl_s=float(body.get("ttl_s", store.DEFAULT_APPROVAL_TTL_S)),
            )
        except KeyError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc
        return approval.model_dump(mode="json")

    @app.get("/runs/{run_id}/approvals")
    def list_run_approvals(
        run_id: str,
        conn: sqlite3.Connection = Depends(get_conn),
        principal: str = Depends(principal_from_header),
    ) -> dict[str, Any]:
        run = store.get_run(conn, run_id)
        if run is None:
            raise HTTPException(status_code=404, detail="run not found")
        task = store.get_task(conn, run.task_id)
        if task is None:  # pragma: no cover - orphaned run
            raise HTTPException(status_code=404, detail="task not found")
        require_project_owner(conn, task.project_id, principal)
        approvals = [a.model_dump(mode="json") for a in store.list_approvals_for_run(conn, run_id)]
        return {"approvals": approvals}

    @app.post("/approvals/{approval_id}/decision")
    def decide_approval(
        approval_id: str,
        body: schemas.ApprovalDecision,
        conn: sqlite3.Connection = Depends(get_conn),
        principal: str = Depends(principal_from_header),
    ) -> dict[str, Any]:
        try:
            decision = Decision(body.decision or "pending")
        except ValueError as exc:
            raise HTTPException(status_code=400, detail="invalid decision") from exc
        project_id = store.approval_project(conn, approval_id)
        if project_id is None:
            raise HTTPException(status_code=404, detail="approval not found")
        require_project_owner(conn, project_id, principal)
        try:
            approval = store.decide_approval(conn, approval_id, decision)
        except KeyError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc
        except store.ApprovalDecidedError as exc:
            raise HTTPException(status_code=409, detail=str(exc)) from exc
        except store.ApprovalExpiredError as exc:
            raise HTTPException(status_code=410, detail=str(exc)) from exc
        return approval.model_dump(mode="json")

    @app.post("/projects/{project_id}/approvals/purge")
    def purge_approvals(
        project_id: str,
        conn: sqlite3.Connection = Depends(get_conn),
        principal: str = Depends(principal_from_header),
    ) -> dict[str, Any]:
        require_project_owner(conn, project_id, principal)
        purged = store.purge_expired_approvals(conn, project_id)
        return {"purged": purged}

    @app.post("/projects/{project_id}/backup/import")
    def import_backup(
        project_id: str,
        body: dict[str, Any],
        conn: sqlite3.Connection = Depends(get_conn),
        principal: str = Depends(principal_from_header),
    ) -> dict[str, Any]:
        require_project_owner(conn, project_id, principal)
        manifest = body.get("manifest")
        if not isinstance(manifest, dict):
            raise HTTPException(status_code=400, detail="manifest must be an object")
        try:
            result = backup_mod.import_manifest(
                conn, project_id, manifest, dry_run=bool(body.get("dry_run", False))
            )
        except (KeyError, ValueError) as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        return result

    @app.get("/projects/{project_id}/events")
    def list_events(
        project_id: str,
        entity: str | None = None,
        conn: sqlite3.Connection = Depends(get_conn),
        principal: str = Depends(principal_from_header),
    ) -> dict[str, Any]:
        require_project_owner(conn, project_id, principal)
        events = [e.model_dump(mode="json") for e in store.list_events(conn, project_id)]
        if entity is not None:
            events = [e for e in events if e["entity"] == entity]
        return {"events": events}

    # -- Phase 4: providers ----------------------------------------------------

    def _provider_public(provider: Provider) -> dict[str, Any]:
        dumped = provider.model_dump(mode="json")
        # S1 BYOK: secret-shaped values surface as fingerprints only. Neither
        # the plaintext of a legacy inline key nor cascading ciphertext ever
        # leaves this function.
        masked: dict[str, Any] = {}
        for key, value in provider.config.items():
            if (
                secrets_mod.is_secret_key(key)
                and value is not None
                and value != ""
            ):
                # Legacy rows may hold non-string secrets under secret-shaped
                # keys (pre-guard data): never echo them raw.
                if not isinstance(value, str):
                    masked[key] = "[redacted]"
                else:
                    masked[key] = secrets_mod.mask_stored(value)
            else:
                masked[key] = value
        dumped["config"] = masked
        return dumped

    @app.post("/projects/{project_id}/providers")
    def create_provider(
        project_id: str,
        body: schemas.ProviderCreate,
        conn: sqlite3.Connection = Depends(get_conn),
        principal: str = Depends(principal_from_header),
    ) -> dict[str, Any]:
        require_project_owner(conn, project_id, principal)
        try:
            kind = ProviderKind(body.kind or "local")
        except ValueError as exc:
            raise HTTPException(status_code=400, detail="invalid provider kind") from exc
        try:
            provider = store.create_provider(
                conn,
                project_id,
                kind=kind,
                name=body.name or "",
                config=dict(body.config or {}),
                capabilities=list(body.capabilities or []),
            )
        except (KeyError, ValueError) as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        return _provider_public(provider)

    @app.get("/projects/{project_id}/providers")
    def list_providers(
        project_id: str,
        conn: sqlite3.Connection = Depends(get_conn),
        principal: str = Depends(principal_from_header),
    ) -> dict[str, Any]:
        require_project_owner(conn, project_id, principal)
        return {"providers": [_provider_public(p) for p in store.list_providers(conn, project_id)]}

    @app.get("/providers/{provider_id}")
    def get_provider(
        provider_id: str,
        conn: sqlite3.Connection = Depends(get_conn),
        principal: str = Depends(principal_from_header),
    ) -> dict[str, Any]:
        provider = store.get_provider(conn, provider_id)
        if provider is None:
            raise HTTPException(status_code=404, detail="provider not found")
        require_project_owner(conn, provider.project_id, principal)
        return _provider_public(provider)

    @app.post("/providers/{provider_id}/disable")
    def disable_provider(
        provider_id: str,
        conn: sqlite3.Connection = Depends(get_conn),
        principal: str = Depends(principal_from_header),
    ) -> dict[str, Any]:
        provider = store.get_provider(conn, provider_id)
        if provider is None:
            raise HTTPException(status_code=404, detail="provider not found")
        require_project_owner(conn, provider.project_id, principal)
        provider = store.set_provider_status(conn, provider_id, ProviderStatus.DISABLED)
        return _provider_public(provider)

    # -- S1 BYOK: partial provider update + model catalog ----------------------

    @app.patch("/providers/{provider_id}")
    def update_provider(
        provider_id: str,
        body: dict[str, Any],
        conn: sqlite3.Connection = Depends(get_conn),
        principal: str = Depends(principal_from_header),
    ) -> dict[str, Any]:
        provider = store.get_provider(conn, provider_id)
        if provider is None:
            raise HTTPException(status_code=404, detail="provider not found")
        require_project_owner(conn, provider.project_id, principal)
        name = body.get("name")
        status_raw = body.get("status")
        status: ProviderStatus | None = None
        if status_raw is not None:
            try:
                status = ProviderStatus(str(status_raw))
            except ValueError as exc:
                raise HTTPException(status_code=400, detail="invalid provider status") from exc
        config_raw = body.get("config")
        if config_raw is not None and not isinstance(config_raw, dict):
            raise HTTPException(status_code=400, detail="config must be an object")
        try:
            updated = store.update_provider(
                conn,
                provider_id,
                name=None if name is None else str(name),
                config=None if config_raw is None else dict(config_raw),
                status=status,
            )
        except secrets_mod.SecretKeyMissingError as exc:
            raise HTTPException(
                status_code=400,
                detail=f"{exc} BYOK keys cannot be saved in the clear: start the server with"
                " NERDBOT_SECRET_KEY (a Fernet key) and retry.",
            ) from exc
        except (KeyError, ValueError) as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        return _provider_public(updated)

    @app.get("/providers/{provider_id}/models")
    def provider_models(
        provider_id: str,
        conn: sqlite3.Connection = Depends(get_conn),
        principal: str = Depends(principal_from_header),
    ) -> dict[str, Any]:
        provider = store.get_provider(conn, provider_id)
        if provider is None:
            raise HTTPException(status_code=404, detail="provider not found")
        require_project_owner(conn, provider.project_id, principal)
        try:
            models = providers_impl.list_upstream_models(provider)
        except (providers_impl.ProviderConfigurationError, ValueError) as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        except providers_impl.ProviderNetworkError as exc:
            raise HTTPException(status_code=502, detail=str(exc)) from exc
        # anything else is a real bug: let it 500 instead of disguising itself
        # as an upstream provider failure
        return {"models": models}

    # -- Phase 4: knowledge ----------------------------------------------------
    @app.post("/projects/{project_id}/knowledge")
    def ingest_knowledge(
        project_id: str,
        body: dict[str, Any],
        conn: sqlite3.Connection = Depends(get_conn),
        principal: str = Depends(principal_from_header),
    ) -> dict[str, Any]:
        require_project_owner(conn, project_id, principal)
        try:
            source_id, chunk_count = knowledge_mod.ingest_knowledge(
                conn,
                project_id,
                title=str(body.get("title", "")),
                content=str(body.get("content", "")),
                source=str(body.get("source", "")),
                kind=str(body.get("kind", "text")),
            )
        except (KeyError, ValueError) as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        return {"source_id": source_id, "chunks": chunk_count}

    @app.get("/projects/{project_id}/knowledge")
    def list_knowledge(
        project_id: str,
        conn: sqlite3.Connection = Depends(get_conn),
        principal: str = Depends(principal_from_header),
    ) -> dict[str, Any]:
        require_project_owner(conn, project_id, principal)
        sources = [
            s.model_dump(mode="json") for s in store.list_knowledge_sources(conn, project_id)
        ]
        return {"sources": sources}

    @app.post("/tasks/{task_id}/knowledge/search")
    def search_task_knowledge(
        task_id: str,
        body: dict[str, Any],
        conn: sqlite3.Connection = Depends(get_conn),
        principal: str = Depends(principal_from_header),
    ) -> dict[str, Any]:
        task = store.get_task(conn, task_id)
        if task is None:
            raise HTTPException(status_code=404, detail="task not found")
        require_project_owner(conn, task.project_id, principal)
        citations = knowledge_mod.retrieve(
            conn,
            task.project_id,
            str(body.get("query", "")),
            top_k=int(body.get("top_k", 3)),
        )
        return {"citations": citations}

    @app.post("/tasks/{task_id}/knowledge/attach")
    def attach_task_knowledge(
        task_id: str,
        body: dict[str, Any],
        conn: sqlite3.Connection = Depends(get_conn),
        principal: str = Depends(principal_from_header),
    ) -> dict[str, Any]:
        task = store.get_task(conn, task_id)
        if task is None:
            raise HTTPException(status_code=404, detail="task not found")
        require_project_owner(conn, task.project_id, principal)
        try:
            artifact_id, citations = knowledge_mod.attach_evidence(
                conn,
                task_id,
                str(body.get("query", "")),
                _data_dir(),
                run_id=str(body.get("run_id", "")),
                top_k=int(body.get("top_k", 3)),
            )
        except (KeyError, ValueError) as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        return {"artifact_id": artifact_id, "citations": citations}

    # -- Phase 4: schedules ----------------------------------------------------

    @app.post("/projects/{project_id}/schedules")
    def create_schedule(
        project_id: str,
        body: dict[str, Any],
        conn: sqlite3.Connection = Depends(get_conn),
        principal: str = Depends(principal_from_header),
    ) -> dict[str, Any]:
        require_project_owner(conn, project_id, principal)
        try:
            schedule = orchestrator.create_scheduled(
                conn,
                project_id,
                name=str(body.get("name", "")),
                cron=str(body.get("cron", "")),
                task_template=dict(body.get("task_template", {})),
            )
        except (KeyError, ValueError) as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        created: dict[str, Any] = schedule.model_dump(mode="json")
        return created

    @app.get("/projects/{project_id}/schedules")
    def list_schedules(
        project_id: str,
        conn: sqlite3.Connection = Depends(get_conn),
        principal: str = Depends(principal_from_header),
    ) -> dict[str, Any]:
        require_project_owner(conn, project_id, principal)
        schedules = [s.model_dump(mode="json") for s in store.list_schedules(conn, project_id)]
        return {"schedules": schedules}

    @app.post("/schedules/{schedule_id}/fire")
    def fire_schedule(
        schedule_id: str,
        conn: sqlite3.Connection = Depends(get_conn),
        principal: str = Depends(principal_from_header),
    ) -> dict[str, Any]:
        schedule = store.get_schedule(conn, schedule_id)
        if schedule is None:
            raise HTTPException(status_code=404, detail="schedule not found")
        require_project_owner(conn, schedule.project_id, principal)
        fired = orchestrator.fire_due_schedules(conn, data_dir=_data_dir())
        matches = [f for f in fired if f["schedule_id"] == schedule_id]
        if not matches:
            raise HTTPException(status_code=400, detail="schedule not due or locked")
        return matches[0]

    # -- Phase 4: ingress and notifications ------------------------------------

    @app.post("/projects/{project_id}/ingress")
    def ingress_payload(
        project_id: str,
        body: dict[str, Any],
        conn: sqlite3.Connection = Depends(get_conn),
        principal: str = Depends(principal_from_header),
    ) -> dict[str, Any]:
        require_project_owner(conn, project_id, principal)
        try:
            issue, task = orchestrator.ingest_inbound(
                conn,
                project_id,
                title=str(body.get("title", "")),
                body=str(body.get("body", "")),
                labels=list(body.get("labels", [])),
                source=str(body.get("source", "webhook")),
            )
        except (KeyError, ValueError) as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        return {"issue": issue.model_dump(mode="json"), "task": task.model_dump(mode="json")}

    @app.post("/projects/{project_id}/notify")
    def send_project_notification(
        project_id: str,
        body: dict[str, Any],
        conn: sqlite3.Connection = Depends(get_conn),
        principal: str = Depends(principal_from_header),
    ) -> Any:
        require_project_owner(conn, project_id, principal)
        channel = str(body.get("channel", "outbox"))
        if channel == notify_mod.WEBHOOK_CHANNEL:
            try:
                note = store.create_notification(
                    conn, project_id, channel, str(body.get("kind", "")),
                    dict(body.get("payload", {})),
                    target_url=str(body.get("target_url", "")),
                )
                note = notify_mod.deliver_webhook(conn, note.id)
            except KeyError as exc:
                raise HTTPException(status_code=404, detail=str(exc)) from exc
            except (ValueError, notify_mod.WebhookNotConfiguredError,
                    notify_mod.WebhookBlockedError) as exc:
                raise HTTPException(status_code=400, detail=str(exc)) from exc
            except notify_mod.WebhookLockedError as exc:
                raise HTTPException(status_code=409, detail=str(exc)) from exc
            except notify_mod.WebhookDeliveryError as exc:
                raise HTTPException(status_code=502, detail=str(exc)) from exc
            if note.status == "queued":
                return JSONResponse(status_code=202, content=note.model_dump(mode="json"))
            delivered: dict[str, Any] = note.model_dump(mode="json")
            return delivered
        try:
            note = notify_mod.send_notification(
                conn,
                project_id,
                channel,
                str(body.get("kind", "")),
                dict(body.get("payload", {})),
            )
        except (KeyError, ValueError, notify_mod.ChannelNotConfiguredError) as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        stored: dict[str, Any] = note.model_dump(mode="json")
        return stored

    @app.get("/projects/{project_id}/notifications")
    def list_project_notifications(
        project_id: str,
        conn: sqlite3.Connection = Depends(get_conn),
        principal: str = Depends(principal_from_header),
    ) -> dict[str, Any]:
        require_project_owner(conn, project_id, principal)
        notes = [n.model_dump(mode="json") for n in store.list_notifications(conn, project_id)]
        return {"notifications": notes}

    @app.post("/notifications/{notification_id}/deliver")
    def deliver_notification(
        notification_id: str,
        conn: sqlite3.Connection = Depends(get_conn),
        principal: str = Depends(principal_from_header),
    ) -> Any:
        note = store.get_notification(conn, notification_id)
        if note is None:
            raise HTTPException(status_code=404, detail="notification not found")
        require_project_owner(conn, note.project_id, principal)
        try:
            delivered = notify_mod.deliver_webhook(conn, notification_id)
        except KeyError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc
        except (ValueError, notify_mod.WebhookNotConfiguredError,
                notify_mod.WebhookBlockedError) as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        except notify_mod.WebhookLockedError as exc:
            raise HTTPException(status_code=409, detail=str(exc)) from exc
        except notify_mod.WebhookDeliveryError as exc:
            raise HTTPException(status_code=502, detail=str(exc)) from exc
        if delivered.status == "queued":
            return JSONResponse(status_code=202, content=delivered.model_dump(mode="json"))
        retried: dict[str, Any] = delivered.model_dump(mode="json")
        return retried

    @app.post("/notifications/{notification_id}/unlock")
    def unlock_notification(
        notification_id: str,
        conn: sqlite3.Connection = Depends(get_conn),
        principal: str = Depends(principal_from_header),
    ) -> dict[str, Any]:
        note = store.get_notification(conn, notification_id)
        if note is None:
            raise HTTPException(status_code=404, detail="notification not found")
        require_project_owner(conn, note.project_id, principal)
        store.release_delivery_lock(conn, notification_id)
        return {"id": notification_id, "locked": False}

    @app.post("/webhooks/sweep")
    def sweep_webhooks(
        conn: sqlite3.Connection = Depends(get_conn),
        principal: str = Depends(principal_from_header),
    ) -> dict[str, Any]:
        _ = principal
        return {"fired": notify_mod.sweep_due_deliveries(conn)}

    @app.post("/projects/{project_id}/webhook-targets")
    def add_webhook_target(
        project_id: str,
        body: dict[str, Any],
        conn: sqlite3.Connection = Depends(get_conn),
        principal: str = Depends(principal_from_header),
    ) -> dict[str, Any]:
        require_project_owner(conn, project_id, principal)
        try:
            target = notify_mod.add_webhook_target(conn, project_id, str(body.get("url", "")))
        except (KeyError, ValueError, notify_mod.WebhookBlockedError) as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        return target

    @app.get("/projects/{project_id}/webhook-targets")
    def list_webhook_targets(
        project_id: str,
        conn: sqlite3.Connection = Depends(get_conn),
        principal: str = Depends(principal_from_header),
    ) -> dict[str, Any]:
        require_project_owner(conn, project_id, principal)
        return {"targets": store.list_webhook_targets(conn, project_id)}

    @app.delete("/webhook-targets/{target_id}")
    def delete_webhook_target(
        target_id: str,
        conn: sqlite3.Connection = Depends(get_conn),
        principal: str = Depends(principal_from_header),
    ) -> dict[str, Any]:
        target = store.get_webhook_target(conn, target_id)
        if target is None:
            raise HTTPException(status_code=404, detail="webhook target not found")
        require_project_owner(conn, target["project_id"], principal)
        try:
            return store.delete_webhook_target(conn, target_id)
        except KeyError as exc:  # pragma: no cover - raced deletion
            raise HTTPException(status_code=404, detail=str(exc)) from exc

    # -- Phase 4: backup and observability -------------------------------------

    @app.get("/projects/{project_id}/backup")
    def export_backup(
        project_id: str,
        conn: sqlite3.Connection = Depends(get_conn),
        principal: str = Depends(principal_from_header),
    ) -> dict[str, Any]:
        require_project_owner(conn, project_id, principal)
        try:
            return backup_mod.build_manifest(conn, project_id)
        except KeyError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc

    @app.post("/projects/{project_id}/backup/validate")
    def validate_backup(
        project_id: str,
        body: dict[str, Any],
        conn: sqlite3.Connection = Depends(get_conn),
        principal: str = Depends(principal_from_header),
    ) -> dict[str, Any]:
        require_project_owner(conn, project_id, principal)
        errors = backup_mod.validate_manifest(
            body.get("manifest", {}) if isinstance(body.get("manifest"), dict) else body
        )
        return {"valid": not errors, "errors": errors}

    @app.get("/projects/{project_id}/metrics")
    def project_metrics(
        project_id: str,
        conn: sqlite3.Connection = Depends(get_conn),
        principal: str = Depends(principal_from_header),
    ) -> dict[str, Any]:
        require_project_owner(conn, project_id, principal)
        try:
            return metrics_mod.project_metrics(conn, project_id)
        except KeyError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc

    # -- Home context ---------------------------------------------------------

    @app.get("/home")
    def get_home(
        conn: sqlite3.Connection = Depends(get_conn),
        principal: str = Depends(principal_from_header),
    ) -> dict[str, Any]:
        """Resolve (or create on first access) the default Home project.

        Home is a normal project owned by the principal, used as the default
        context for project-free conversation. Resolving it here keeps
        project-selection out of the UI while preserving server-side ownership
        enforcement on every chat endpoint.
        """
        projects = store.list_projects(conn, principal)
        home = next((p for p in projects if p.repository == "Home"), None)
        if home is None:
            home = store.create_project(
                conn, owner=principal, repository="Home", config={}
            )
        return home.model_dump(mode="json")

    @app.get("/capabilities")
    def list_capabilities(
        principal: str = Depends(principal_from_header),
    ) -> dict[str, Any]:
        _ = principal
        return {"capabilities": capabilities_mod.CAPABILITIES}

    @app.get("/permissions")
    def list_permissions(
        principal: str = Depends(principal_from_header),
    ) -> dict[str, Any]:
        """The canonical permission catalogue.

        The dashboard renders the permission editor from this list instead of
        hard-coding permission names, so a permission the backend enforces can
        never be missing from the UI (and the UI can never offer a name the
        backend would reject). ``board_member_roles`` is the same contract for
        board membership roles: the membership editor renders the server's
        list, so it cannot offer a role the backend would reject.
        """
        _ = principal
        return {
            "permissions": permissions_mod.catalog(),
            "admin_permissions": sorted(permissions_mod.ADMIN_PERMISSIONS),
            "agent_permissions": sorted(permissions_mod.AGENT_PERMISSIONS),
            "board_member_roles": list(BOARD_MEMBER_ROLES),
        }

    # -- Chat threads ----------------------------------------------------------

    def _chat_thread_project(conn: sqlite3.Connection, thread_id: str) -> str:
        thread = store.get_thread(conn, thread_id)
        if thread is None:
            raise HTTPException(status_code=404, detail="thread not found")
        return thread.project_id

    @app.post("/projects/{project_id}/threads")
    def create_thread(
        project_id: str,
        body: schemas.ThreadCreate,
        conn: sqlite3.Connection = Depends(get_conn),
        principal: str = Depends(principal_from_header),
    ) -> dict[str, Any]:
        require_project_owner(conn, project_id, principal)
        try:
            thread = store.create_thread(
                conn, project_id, title=body.title or "", provider_id=body.provider_id,
            )
        except (KeyError, ValueError) as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        return thread.model_dump(mode="json")

    @app.get("/projects/{project_id}/threads")
    def list_threads(
        project_id: str,
        conn: sqlite3.Connection = Depends(get_conn),
        principal: str = Depends(principal_from_header),
    ) -> dict[str, Any]:
        require_project_owner(conn, project_id, principal)
        threads = [t.model_dump(mode="json") for t in store.list_threads(conn, project_id)]
        return {"threads": threads}

    @app.get("/threads")
    def list_recent_threads(
        limit: int = 20,
        conn: sqlite3.Connection = Depends(get_conn),
        principal: str = Depends(principal_from_header),
    ) -> dict[str, Any]:
        """Recent conversations across every project the caller owns.

        The Command Center is cross-workspace, so its resume list cannot be
        scoped to one project. The owner check is the same one every other
        project route uses: a caller only ever sees their own projects.
        """
        capped = max(1, min(limit, 50))
        threads = store.list_threads_for_owner(conn, principal, limit=capped)
        return {"threads": [t.model_dump(mode="json") for t in threads]}

    @app.patch("/threads/{thread_id}")
    def update_thread(
        thread_id: str,
        body: schemas.ThreadUpdate,
        conn: sqlite3.Connection = Depends(get_conn),
        principal: str = Depends(principal_from_header),
    ) -> dict[str, Any]:
        require_project_owner(conn, _chat_thread_project(conn, thread_id), principal)
        thread = store.get_thread(conn, thread_id)
        if thread is None:  # pragma: no cover - raced deletion
            raise HTTPException(status_code=404, detail="thread not found")
        # Only the fields the caller actually sent are applied.
        if "provider_id" in body.model_fields_set:
            try:
                thread = store.set_thread_provider(conn, thread_id, body.provider_id)
            except (KeyError, ValueError) as exc:
                raise HTTPException(status_code=400, detail=str(exc)) from exc
        if "title" in body.model_fields_set:
            conn.execute("UPDATE chat_threads SET title = ? WHERE id = ?",
                         (body.title or "", thread_id))
            conn.commit()
            refreshed = store.get_thread(conn, thread_id)
            if refreshed is not None:
                thread = refreshed
        return thread.model_dump(mode="json")

    @app.get("/threads/{thread_id}")
    def get_thread_view(
        thread_id: str,
        limit: int = 50,
        before: str | None = None,
        conn: sqlite3.Connection = Depends(get_conn),
        principal: str = Depends(principal_from_header),
    ) -> dict[str, Any]:
        require_project_owner(conn, _chat_thread_project(conn, thread_id), principal)
        thread = store.get_thread(conn, thread_id)
        if thread is None:  # pragma: no cover - raced deletion
            raise HTTPException(status_code=404, detail="thread not found")
        try:
            messages = store.list_messages(conn, thread_id, limit=limit, before_id=before)
        except KeyError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc
        return {
            "thread": thread.model_dump(mode="json"),
            "messages": [m.model_dump(mode="json") for m in messages],
        }

    @app.post("/threads/{thread_id}/messages")
    def append_thread_message(
        thread_id: str,
        body: dict[str, Any],
        conn: sqlite3.Connection = Depends(get_conn),
        principal: str = Depends(principal_from_header),
    ) -> dict[str, Any]:
        require_project_owner(conn, _chat_thread_project(conn, thread_id), principal)
        try:
            message = store.append_message(conn, thread_id, str(body.get("role", "user")),
                                           str(body.get("content", "")))
        except KeyError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        return message.model_dump(mode="json")

    def _prepare_chat(
        conn: sqlite3.Connection, thread_id: str
    ) -> tuple[Any, Any, list[dict[str, Any]], list[dict[str, Any]]]:
        thread = store.get_thread(conn, thread_id)
        if thread is None:
            raise HTTPException(status_code=404, detail="thread not found")
        try:
            provider = chat_mod.resolve_chat_provider(conn, thread.project_id, thread)
            messages, provenance = chat_mod.build_messages(conn, thread.project_id, thread)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        except store.MemoryReadError as exc:
            raise HTTPException(status_code=500, detail=str(exc)) from exc
        return thread, provider, messages, provenance

    def _chat_error_to_http(exc: Exception) -> HTTPException:
        # Chat maps every failure to a status: unknowns are an upstream fault
        # from the caller's perspective, not a server bug.
        return _provider_error_to_http(exc) or HTTPException(
            status_code=502, detail=str(exc)
        )

    @app.post("/threads/{thread_id}/summarize")
    def summarize_thread_endpoint(
        thread_id: str,
        conn: sqlite3.Connection = Depends(get_conn),
        principal: str = Depends(principal_from_header),
    ) -> dict[str, Any]:
        require_project_owner(conn, _chat_thread_project(conn, thread_id), principal)
        thread = store.get_thread(conn, thread_id)
        if thread is None:  # pragma: no cover - raced deletion
            raise HTTPException(status_code=404, detail="thread not found")
        try:
            provider = chat_mod.resolve_chat_provider(conn, thread.project_id, thread)
            updated = chat_mod.summarize_thread(conn, thread_id, provider=provider)
        except (KeyError, ValueError) as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        return updated.model_dump(mode="json")

    @app.post("/threads/{thread_id}/chat")
    def chat_complete_endpoint(
        thread_id: str,
        body: dict[str, Any],
        conn: sqlite3.Connection = Depends(get_conn),
        principal: str = Depends(principal_from_header),
    ) -> dict[str, Any]:
        require_project_owner(conn, _chat_thread_project(conn, thread_id), principal)
        content = str(body.get("content", ""))
        if not content.strip():
            raise HTTPException(status_code=400, detail="content is required")
        store.append_message(conn, thread_id, "user", content)
        thread, provider, messages, provenance = _prepare_chat(conn, thread_id)
        _ = thread
        try:
            text = chat_mod.chat_complete(provider, messages)
        except Exception as exc:
            raise _chat_error_to_http(exc) from exc
        message = store.append_message(conn, thread_id, "assistant", text)
        provider_id = provider.id if provider else None
        return {
            "message": message.model_dump(mode="json"),
            "provider_id": provider_id,
            "memory_used": provenance,
        }

    @app.post("/threads/{thread_id}/chat/stream")
    def chat_stream_endpoint(
        thread_id: str,
        body: dict[str, Any],
        conn: sqlite3.Connection = Depends(get_conn),
        principal: str = Depends(principal_from_header),
    ) -> StreamingResponse:
        require_project_owner(conn, _chat_thread_project(conn, thread_id), principal)
        content = str(body.get("content", ""))
        if not content.strip():
            raise HTTPException(status_code=400, detail="content is required")
        store.append_message(conn, thread_id, "user", content)
        thread, provider, messages, provenance = _prepare_chat(conn, thread_id)
        _ = (thread, provenance)

        def generate() -> Any:
            import json as _json

            chunks: list[str] = []
            try:
                for chunk in chat_mod.chat_stream(provider, messages):
                    chunks.append(chunk)
                    yield f"data: {_json.dumps({'text': chunk})}\n\n"
            except Exception as exc:
                http_exc = _chat_error_to_http(exc)
                yield f"data: {_json.dumps({'error': http_exc.detail})}\n\n"
                yield "data: [DONE]\n\n"
                return
            full = "".join(chunks)
            store.append_message(conn, thread_id, "assistant", full or "(empty reply)")
            yield "data: [DONE]\n\n"

        return StreamingResponse(generate(), media_type="text/event-stream")

    # -- Workspace surface (human UI) ------------------------------------------

    @app.get("/projects")
    def list_projects_endpoint(
        conn: sqlite3.Connection = Depends(get_conn),
        principal: str = Depends(principal_from_header),
    ) -> dict[str, Any]:
        projects = [p.model_dump(mode="json") for p in store.list_projects(conn, principal)]
        # Per-project counts travel beside the list, not inside each project
        # object, so the project shape stays exactly what it was. The Workspaces
        # page needs to show what a workspace actually holds, not just its id.
        counts = {
            project["id"]: _project_counts(conn, project["id"]) for project in projects
        }
        return {"projects": projects, "counts": counts}

    @app.get("/projects/{project_id}/tasks")
    def list_project_tasks(
        project_id: str,
        conn: sqlite3.Connection = Depends(get_conn),
        principal: str = Depends(principal_from_header),
    ) -> dict[str, Any]:
        require_project_owner(conn, project_id, principal)
        tasks = [t.model_dump(mode="json") for t in store.list_tasks_for_project(conn, project_id)]
        return {"tasks": tasks}

    @app.get("/projects/{project_id}/messages")
    def list_project_messages(
        project_id: str,
        to_teammate_id: str | None = None,
        conn: sqlite3.Connection = Depends(get_conn),
        principal: str = Depends(principal_from_header),
    ) -> dict[str, Any]:
        """Board feed for a project: every message on every board of the
        project, optionally filtered to messages addressed to one teammate."""
        require_project_owner(conn, project_id, principal)
        messages: list[dict[str, Any]] = []
        for board in store.list_boards(conn, project_id=project_id):
            try:
                rows = store.list_board_messages(conn, board.id)
            except KeyError:
                continue
            for msg in rows:
                if to_teammate_id and msg.to_teammate_id != to_teammate_id:
                    continue
                payload = msg.model_dump(mode="json")
                payload["board_name"] = board.name
                messages.append(payload)
        messages.sort(key=lambda m: m.get("created_at", ""))
        return {"messages": messages}

    @app.get("/projects/{project_id}/approvals")
    def list_project_approvals(
        project_id: str,
        decision: str | None = None,
        conn: sqlite3.Connection = Depends(get_conn),
        principal: str = Depends(principal_from_header),
    ) -> dict[str, Any]:
        require_project_owner(conn, project_id, principal)
        approvals = store.list_approvals_for_project(conn, project_id)
        if decision:
            approvals = [a for a in approvals if a.decision.value == decision]
            if decision == "pending":
                # An expired, undecided approval cannot be decided: the
                # decision endpoint answers 410 for it. Reporting it as
                # pending would offer a decision guaranteed to fail.
                approvals = [a for a in approvals if store.approval_is_pending(a)]
        return {"approvals": [a.model_dump(mode="json") for a in approvals]}

    @app.get("/projects/{project_id}/workspace/files")
    def list_project_workspace_files(
        project_id: str,
        conn: sqlite3.Connection = Depends(get_conn),
        principal: str = Depends(principal_from_header),
    ) -> dict[str, Any]:
        """The files across every task checkout in this workspace.

        A workspace is the unit the owner thinks in: its bots, its tasks and
        the files those tasks produced. The per-task endpoints show one
        checkout; this shows the whole workspace in one place.
        """
        require_project_owner(conn, project_id, principal)
        data_dir = _data_dir()
        checkouts: list[dict[str, Any]] = []
        total_files = 0
        for task in store.list_tasks_for_project(conn, project_id):
            root = workspace_mgr.workspace_path_for_task(data_dir, task.id)
            if not root.is_dir():
                continue
            files: list[dict[str, Any]] = []
            for path in sorted(root.rglob("*")):
                if ".git" in path.parts:
                    continue
                if path.is_file():
                    stat = path.stat()
                    files.append(
                        {
                            "path": str(path.relative_to(root)),
                            "size": stat.st_size,
                            "modified": stat.st_mtime,
                        }
                    )
            if not files:
                continue
            total_files += len(files)
            checkouts.append(
                {
                    "task_id": task.id,
                    "task_description": task.description,
                    "branch": task.branch,
                    "root": str(root),
                    "files": files,
                }
            )
        return {"checkouts": checkouts, "file_count": total_files}

    @app.get("/tasks/{task_id}/workspace/files")
    def list_task_workspace_files(
        task_id: str,
        conn: sqlite3.Connection = Depends(get_conn),
        principal: str = Depends(principal_from_header),
    ) -> dict[str, Any]:
        task = store.get_task(conn, task_id)
        if task is None:
            raise HTTPException(status_code=404, detail="task not found")
        require_project_owner(conn, task.project_id, principal)
        root = workspace_mgr.workspace_path_for_task(_data_dir(), task_id)
        if not root.is_dir():
            return {"files": [], "root": str(root)}
        files: list[dict[str, Any]] = []
        for path in sorted(root.rglob("*")):
            if ".git" in path.parts:
                continue
            if path.is_file():
                stat = path.stat()
                files.append(
                    {
                        "path": str(path.relative_to(root)),
                        "size": stat.st_size,
                        "modified": stat.st_mtime,
                    }
                )
        return {"files": files, "root": str(root)}

    @app.get("/tasks/{task_id}/workspace/file")
    def read_task_workspace_file(
        task_id: str,
        path: str,
        conn: sqlite3.Connection = Depends(get_conn),
        principal: str = Depends(principal_from_header),
    ) -> dict[str, Any]:
        task = store.get_task(conn, task_id)
        if task is None:
            raise HTTPException(status_code=404, detail="task not found")
        require_project_owner(conn, task.project_id, principal)
        root = workspace_mgr.workspace_path_for_task(_data_dir(), task_id)
        target = (root / path).resolve()
        if target != root and root not in target.parents:
            raise HTTPException(status_code=400, detail="path escapes workspace")
        if not target.is_file():
            raise HTTPException(status_code=404, detail="file not found")
        if target.stat().st_size > 1_000_000:
            raise HTTPException(status_code=400, detail="file too large to display")
        try:
            content = target.read_text(encoding="utf-8")
        except UnicodeDecodeError as exc:
            raise HTTPException(status_code=400, detail="file is not text") from exc
        return {"path": path, "content": content}

    @app.get("/tasks/{task_id}/workspace/diff")
    def task_workspace_diff(
        task_id: str,
        conn: sqlite3.Connection = Depends(get_conn),
        principal: str = Depends(principal_from_header),
    ) -> dict[str, Any]:
        task = store.get_task(conn, task_id)
        if task is None:
            raise HTTPException(status_code=404, detail="task not found")
        require_project_owner(conn, task.project_id, principal)
        root = workspace_mgr.workspace_path_for_task(_data_dir(), task_id)
        if not root.is_dir():
            return {"diff": "", "exists": False}
        try:
            diff = workspace_mgr.workspace_diff(root)
        except Exception as exc:  # git may be absent or repo corrupted
            raise HTTPException(status_code=400, detail=f"diff failed: {exc}") from exc
        return {"diff": diff, "exists": True}

    @app.patch("/schedules/{schedule_id}")
    def update_schedule_endpoint(
        schedule_id: str,
        body: dict[str, Any],
        conn: sqlite3.Connection = Depends(get_conn),
        principal: str = Depends(principal_from_header),
    ) -> dict[str, Any]:
        schedule = store.get_schedule(conn, schedule_id)
        if schedule is None:
            raise HTTPException(status_code=404, detail="schedule not found")
        require_project_owner(conn, schedule.project_id, principal)
        if "enabled" not in body:
            raise HTTPException(status_code=400, detail="enabled is required")
        try:
            updated = store.set_schedule_enabled(conn, schedule_id, bool(body["enabled"]))
        except (KeyError, ValueError) as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        return updated.model_dump(mode="json")

    # Serve the built dashboard (SPA). Mounted last so all API routes above
    # take precedence. Hash-routed frontend paths fall through to index.html.
    _dist = Path(__file__).resolve().parents[3] / "dashboard" / "dist"
    if _dist.is_dir():
        app.mount("/", _SPAStaticFiles(directory=str(_dist), html=True), name="spa")

    return app


class _SPAStaticFiles(StaticFiles):
    """Serve the built dashboard with cache headers that cannot pin a stale UI.

    Vite writes content-hashed asset names, so ``/assets/...`` is safe to
    cache forever. The entry document is not: it names the hashed bundles,
    so it has to be revalidated or a browser can keep asking for a bundle
    that no longer exists — or, worse, keep running the old one. Without
    these headers the server sent no ``Cache-Control`` at all, which left
    the freshness to browser heuristics.
    """

    def file_response(self, *args: Any, **kwargs: Any) -> Response:
        response = super().file_response(*args, **kwargs)
        path = str(args[0]) if args else ""
        if "/assets/" in path:
            response.headers["Cache-Control"] = "public, max-age=31536000, immutable"
        else:
            response.headers["Cache-Control"] = "no-cache"
        return response


app = create_app()
