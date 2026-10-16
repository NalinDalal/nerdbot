"""Product API: REST endpoints for projects, teammates, tasks, runs, artifacts."""

from __future__ import annotations

import os
import sqlite3
import uuid
from collections.abc import AsyncIterator, Iterator
from contextlib import asynccontextmanager
from typing import Any

from fastapi import Depends, FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from . import backup as backup_mod
from . import capabilities as capabilities_mod
from . import knowledge as knowledge_mod
from . import metrics as metrics_mod
from . import notify as notify_mod
from . import orchestrator, store
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
    Decision,
    Provider,
    ProviderKind,
    ProviderStatus,
    ReviewVerdict,
    TeammateStatus,
)


def _db_path() -> str:
    return os.environ.get("NERDBOT_DB", "nerdbot.db")


def _data_dir() -> str:
    return os.environ.get("NERDBOT_DATA", ".nerdbot-data")


def get_conn() -> Iterator[sqlite3.Connection]:
    conn = store.connect(_db_path())
    try:
        yield conn
    finally:
        conn.close()


class MemoryBody(BaseModel):
    scope: str
    content: str
    source: str
    confidence: float = 0.5


def create_app() -> FastAPI:
    @asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        conn = store.connect(_db_path())
        try:
            app.state.recovered_runs = orchestrator.recover_incomplete_runs(conn)
            app.state.restart_count = store.meta_incr(conn, "restart_count")
        finally:
            conn.close()
        yield

    app = FastAPI(title="NerdBot Workspace", lifespan=lifespan)

    import logging as _logging

    _logger = _logging.getLogger("nerdbot.api")

    @app.middleware("http")
    async def request_tracing(request: Request, call_next: Any) -> Any:
        request_id = request.headers.get("X-Request-ID") or uuid.uuid4().hex[:12]
        principal = "anonymous"
        auth = request.headers.get("Authorization", "")
        if auth.startswith("Bearer ") and auth[len("Bearer ") :] == expected_token():
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
        return {
            "status": "ok",
            "version": "0.1.0",
            "db": "ok" if db_ok else "error",
            "restarts": restarts,
        }

    @app.post("/projects")
    def create_project(
        body: dict[str, Any],
        conn: sqlite3.Connection = Depends(get_conn),
        principal: str = Depends(principal_from_header),
    ) -> dict[str, Any]:
        project = store.create_project(
            conn,
            owner=principal,
            repository=str(body.get("repository", "")),
            config=dict(body.get("config", {})),
        )
        return project.model_dump(mode="json")

    @app.post("/projects/{project_id}/teammates")
    def create_teammate(
        project_id: str,
        body: dict[str, Any],
        conn: sqlite3.Connection = Depends(get_conn),
        principal: str = Depends(principal_from_header),
    ) -> dict[str, Any]:
        require_project_owner(conn, project_id, principal)
        mate = store.create_teammate(
            conn,
            project_id,
            persona=str(body.get("persona", "")),
            instructions=str(body.get("instructions", "")),
            capabilities=list(body.get("capabilities", [])),
            memory_scope=str(body.get("memory_scope", "project")),
            permissions=list(body.get("permissions", [])),
        )
        return mate.model_dump(mode="json")

    def _mate_project(conn: sqlite3.Connection, teammate_id: str) -> str:
        mate = store.get_teammate(conn, teammate_id)
        if mate is None:
            raise HTTPException(status_code=404, detail="teammate not found")
        return mate.project_id

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
    ) -> dict[str, Any]:
        require_project_owner(conn, _mate_project(conn, teammate_id), principal)
        try:
            mate = store.update_teammate(
                conn,
                teammate_id,
                persona=body.get("persona"),
                instructions=body.get("instructions"),
                capabilities=body.get("capabilities"),
                memory_scope=body.get("memory_scope"),
                permissions=body.get("permissions"),
                tool_policy=body.get("tool_policy"),
                provider_id=body.get("provider_id"),
            )
        except KeyError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        return mate.model_dump(mode="json")

    @app.post("/teammates/{teammate_id}/disable")
    def disable_teammate(
        teammate_id: str,
        conn: sqlite3.Connection = Depends(get_conn),
        principal: str = Depends(principal_from_header),
    ) -> dict[str, Any]:
        require_project_owner(conn, _mate_project(conn, teammate_id), principal)
        try:
            mate = store.set_teammate_status(conn, teammate_id, TeammateStatus.DISABLED)
        except (KeyError, ValueError) as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        return mate.model_dump(mode="json")

    @app.post("/teammates/{teammate_id}/archive")
    def archive_teammate(
        teammate_id: str,
        conn: sqlite3.Connection = Depends(get_conn),
        principal: str = Depends(principal_from_header),
    ) -> dict[str, Any]:
        require_project_owner(conn, _mate_project(conn, teammate_id), principal)
        try:
            mate = store.set_teammate_status(conn, teammate_id, TeammateStatus.ARCHIVED)
        except (KeyError, ValueError) as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        return mate.model_dump(mode="json")

    @app.post("/projects/{project_id}/tasks")
    def create_task(
        project_id: str,
        body: dict[str, Any],
        conn: sqlite3.Connection = Depends(get_conn),
        principal: str = Depends(principal_from_header),
    ) -> dict[str, Any]:
        require_project_owner(conn, project_id, principal)
        try:
            task = store.create_task(
                conn,
                project_id,
                description=str(body.get("description", "")),
                owner_teammate_id=body.get("owner_teammate_id"),
                dependencies=list(body.get("dependencies", [])),
                command=str(body.get("command", "")),
                issue_id=body.get("issue_id"),
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
                conn, task_id, data_dir=_data_dir()
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
            run, result, artifact_id = orchestrator.retry_task(conn, task_id, data_dir=_data_dir())
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
        return {
            "task": task.model_dump(mode="json"),
            "runs": runs,
            "artifacts": artifacts,
            "issue": issue.model_dump(mode="json") if issue else None,
            "reviews": reviews,
            "pr_packages": packages,
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
    ) -> dict[str, Any]:
        _ = principal
        entry = store.write_memory(conn, body.scope, body.content, body.source, body.confidence)
        return entry.model_dump(mode="json")

    @app.get("/memory")
    def recall_memory(
        scope: str,
        conn: sqlite3.Connection = Depends(get_conn),
        principal: str = Depends(principal_from_header),
    ) -> dict[str, Any]:
        _ = principal
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
    ) -> dict[str, Any]:
        require_project_owner(conn, project_id, principal)
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
    ) -> dict[str, Any]:
        require_project_owner(conn, project_id, principal)
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
                run_id,
                str(body.get("action", "")),
                PRINCIPAL,
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
        body: dict[str, Any],
        conn: sqlite3.Connection = Depends(get_conn),
        principal: str = Depends(principal_from_header),
    ) -> dict[str, Any]:
        try:
            decision = Decision(str(body.get("decision", "pending")))
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
        dumped["config"] = backup_mod.redact_provider_config(provider.config)
        return dumped

    @app.post("/projects/{project_id}/providers")
    def create_provider(
        project_id: str,
        body: dict[str, Any],
        conn: sqlite3.Connection = Depends(get_conn),
        principal: str = Depends(principal_from_header),
    ) -> dict[str, Any]:
        require_project_owner(conn, project_id, principal)
        try:
            kind = ProviderKind(str(body.get("kind", "local")))
        except ValueError as exc:
            raise HTTPException(status_code=400, detail="invalid provider kind") from exc
        try:
            provider = store.create_provider(
                conn,
                project_id,
                kind=kind,
                name=str(body.get("name", "")),
                config=dict(body.get("config", {})),
                capabilities=list(body.get("capabilities", [])),
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

    @app.get("/capabilities")
    def list_capabilities(
        principal: str = Depends(principal_from_header),
    ) -> dict[str, Any]:
        _ = principal
        return {"capabilities": capabilities_mod.CAPABILITIES}

    return app


app = create_app()
