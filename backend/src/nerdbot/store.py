"""SQLite persistence: schema init + repositories for all domain entities.

Default to SQLite (WAL) for local development; allow PostgreSQL later
behind the same repository surface. All access goes through repositories.
"""

from __future__ import annotations

import json
import sqlite3
import uuid
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

from .models import (
    Approval,
    Artifact,
    Decision,
    Event,
    Issue,
    KnowledgeChunk,
    KnowledgeSource,
    MemoryEntry,
    Notification,
    Project,
    Provider,
    ProviderKind,
    ProviderStatus,
    PRPackage,
    Review,
    ReviewVerdict,
    Run,
    RunStatus,
    Schedule,
    Task,
    TaskStatus,
    Teammate,
    TeammateStatus,
    VerificationStatus,
)

SCHEMA = """
PRAGMA journal_mode=WAL;
CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY, owner TEXT NOT NULL, repository TEXT NOT NULL DEFAULT '',
  config TEXT NOT NULL DEFAULT '{}'
);
CREATE TABLE IF NOT EXISTS teammates (
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id),
  persona TEXT NOT NULL DEFAULT '', instructions TEXT NOT NULL DEFAULT '',
  capabilities TEXT NOT NULL DEFAULT '[]', memory_scope TEXT NOT NULL DEFAULT 'project',
  permissions TEXT NOT NULL DEFAULT '[]', status TEXT NOT NULL DEFAULT 'active',
  tool_policy TEXT NOT NULL DEFAULT '{}'
);
CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id),
  description TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending',
  owner_teammate_id TEXT, dependencies TEXT NOT NULL DEFAULT '[]', command TEXT NOT NULL DEFAULT '',
  issue_id TEXT, branch TEXT NOT NULL DEFAULT '', workspace_path TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id),
  runtime TEXT NOT NULL DEFAULT 'local', session TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'queued', started_at TEXT NOT NULL,
  finished_at TEXT, exit_code INTEGER, output_excerpt TEXT NOT NULL DEFAULT '',
  command TEXT NOT NULL DEFAULT '', stdout TEXT NOT NULL DEFAULT '',
  stderr TEXT NOT NULL DEFAULT '', duration_s REAL NOT NULL DEFAULT 0.0
);
CREATE TABLE IF NOT EXISTS memories (
  id TEXT PRIMARY KEY, scope TEXT NOT NULL, content TEXT NOT NULL, source TEXT NOT NULL,
  confidence REAL NOT NULL DEFAULT 0.5, timestamp TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS artifacts (
  id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id), run_id TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'patch', location TEXT NOT NULL DEFAULT '',
  verification_status TEXT NOT NULL DEFAULT 'unverified', summary TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS approvals (
  id TEXT PRIMARY KEY, run_id TEXT NOT NULL, action TEXT NOT NULL, requester TEXT NOT NULL,
  decision TEXT NOT NULL DEFAULT 'pending', decided_at TEXT, expires_at TEXT, consumed_at TEXT,
  task_id TEXT, digest TEXT
);
CREATE TABLE IF NOT EXISTS issues (
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id),
  source TEXT NOT NULL DEFAULT 'manual', external_id TEXT NOT NULL DEFAULT '',
  title TEXT NOT NULL DEFAULT '', body TEXT NOT NULL DEFAULT '',
  acceptance_criteria TEXT NOT NULL DEFAULT '[]', repository_url TEXT NOT NULL DEFAULT '',
  base_branch TEXT NOT NULL DEFAULT 'main', labels TEXT NOT NULL DEFAULT '[]',
  owner_teammate_id TEXT, priority TEXT NOT NULL DEFAULT 'medium',
  status TEXT NOT NULL DEFAULT 'open', created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS reviews (
  id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id), run_id TEXT NOT NULL DEFAULT '',
  reviewer_teammate_id TEXT NOT NULL DEFAULT '', verdict TEXT NOT NULL DEFAULT 'needs_work',
  notes TEXT NOT NULL DEFAULT '', risks TEXT NOT NULL DEFAULT '[]', created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS pr_packages (
  id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id), title TEXT NOT NULL DEFAULT '',
  body TEXT NOT NULL DEFAULT '', base_branch TEXT NOT NULL DEFAULT 'main',
  head_branch TEXT NOT NULL DEFAULT '', labels TEXT NOT NULL DEFAULT '[]',
  patch_summary TEXT NOT NULL DEFAULT '', test_evidence TEXT NOT NULL DEFAULT '[]',
  review_evidence TEXT NOT NULL DEFAULT '{}', patch_artifact_id TEXT NOT NULL DEFAULT '',
  digest TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL, entity TEXT NOT NULL, entity_id TEXT NOT NULL,
  event_type TEXT NOT NULL, timestamp TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS providers (
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id),
  kind TEXT NOT NULL DEFAULT 'local', name TEXT NOT NULL DEFAULT '',
  config TEXT NOT NULL DEFAULT '{}', capabilities TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'active', created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS knowledge_sources (
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id),
  kind TEXT NOT NULL DEFAULT 'text', title TEXT NOT NULL DEFAULT '',
  content TEXT NOT NULL DEFAULT '', source TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS knowledge_chunks (
  id TEXT PRIMARY KEY, source_id TEXT NOT NULL REFERENCES knowledge_sources(id),
  project_id TEXT NOT NULL, idx INTEGER NOT NULL DEFAULT 0, text TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS schedules (
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id),
  name TEXT NOT NULL DEFAULT '', cron TEXT NOT NULL DEFAULT '* * * * *',
  task_template TEXT NOT NULL DEFAULT '{}', enabled INTEGER NOT NULL DEFAULT 1,
  next_run_at TEXT, last_fired_at TEXT, locked INTEGER NOT NULL DEFAULT 0,
  fire_count INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS notifications (
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id),
  channel TEXT NOT NULL DEFAULT 'outbox', kind TEXT NOT NULL DEFAULT '',
  payload TEXT NOT NULL DEFAULT '{}', status TEXT NOT NULL DEFAULT 'queued',
  target_url TEXT NOT NULL DEFAULT '', attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT, locked INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS webhook_targets (
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id),
  url TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY, value TEXT NOT NULL DEFAULT ''
);
"""


def new_id(prefix: str) -> str:
    return f"{prefix}_{uuid.uuid4().hex[:12]}"


def _now_iso() -> str:
    return datetime.now(UTC).isoformat()


TASK_TRANSITIONS: dict[TaskStatus, frozenset[TaskStatus]] = {
    TaskStatus.PENDING: frozenset({TaskStatus.READY, TaskStatus.RUNNING, TaskStatus.BLOCKED}),
    TaskStatus.READY: frozenset({TaskStatus.RUNNING, TaskStatus.BLOCKED, TaskStatus.PENDING}),
    TaskStatus.RUNNING: frozenset(
        {TaskStatus.DONE, TaskStatus.FAILED, TaskStatus.BLOCKED, TaskStatus.PENDING}
    ),
    TaskStatus.BLOCKED: frozenset({TaskStatus.PENDING}),
    TaskStatus.FAILED: frozenset({TaskStatus.PENDING}),
    TaskStatus.DONE: frozenset({TaskStatus.PENDING}),
}

RUN_TRANSITIONS: dict[RunStatus, frozenset[RunStatus]] = {
    RunStatus.QUEUED: frozenset(
        {RunStatus.RUNNING, RunStatus.BLOCKED, RunStatus.FAILED, RunStatus.STOPPED}
    ),
    RunStatus.RUNNING: frozenset(
        {RunStatus.SUCCEEDED, RunStatus.FAILED, RunStatus.BLOCKED, RunStatus.STOPPED}
    ),
    RunStatus.SUCCEEDED: frozenset(),
    RunStatus.FAILED: frozenset(),
    RunStatus.BLOCKED: frozenset(),
    RunStatus.STOPPED: frozenset(),
}

TERMINAL_RUN_STATUSES = frozenset(
    {RunStatus.SUCCEEDED, RunStatus.FAILED, RunStatus.BLOCKED, RunStatus.STOPPED}
)
TERMINAL_TASK_STATUSES = frozenset({TaskStatus.DONE, TaskStatus.FAILED, TaskStatus.BLOCKED})


class InvalidTransitionError(ValueError):
    """A state transition is not allowed by the deterministic state machine."""


class TerminalRunError(InvalidTransitionError):
    """A run in a terminal state was asked to transition again."""


class ApprovalExpiredError(ValueError):
    """An approval was decided after its expiry."""


class ApprovalDecidedError(ValueError):
    """An approval was decided more than once (approvals are one-use)."""


def connect(db_path: str | Path) -> sqlite3.Connection:
    """Open the SQLite database, creating parent dirs and schema."""
    path = Path(db_path)
    if str(path) != ":memory:":
        path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(str(path))
    conn.row_factory = sqlite3.Row
    conn.executescript(SCHEMA)
    _migrate(conn)
    return conn


_PHASE2_COLUMNS: dict[str, list[tuple[str, str]]] = {
    "teammates": [
        ("status", "TEXT NOT NULL DEFAULT 'active'"),
        ("tool_policy", "TEXT NOT NULL DEFAULT '{}'"),
    ],
    "approvals": [("expires_at", "TEXT"), ("consumed_at", "TEXT")],
}

_PHASE3_COLUMNS: dict[str, list[tuple[str, str]]] = {
    "tasks": [
        ("issue_id", "TEXT"),
        ("branch", "TEXT NOT NULL DEFAULT ''"),
        ("workspace_path", "TEXT NOT NULL DEFAULT ''"),
    ],
    "runs": [
        ("command", "TEXT NOT NULL DEFAULT ''"),
        ("stdout", "TEXT NOT NULL DEFAULT ''"),
        ("stderr", "TEXT NOT NULL DEFAULT ''"),
        ("duration_s", "REAL NOT NULL DEFAULT 0.0"),
    ],
    "approvals": [("task_id", "TEXT"), ("digest", "TEXT")],
}


_PHASE4_COLUMNS: dict[str, list[tuple[str, str]]] = {
    "teammates": [("provider_id", "TEXT")],
    "runs": [("provider_id", "TEXT")],
}

_PHASE5_COLUMNS: dict[str, list[tuple[str, str]]] = {
    "notifications": [
        ("target_url", "TEXT NOT NULL DEFAULT ''"),
        ("attempts", "INTEGER NOT NULL DEFAULT 0"),
    ],
}

_PHASE6_COLUMNS: dict[str, list[tuple[str, str]]] = {
    "notifications": [
        ("next_attempt_at", "TEXT"),
        ("locked", "INTEGER NOT NULL DEFAULT 0"),
    ],
}


def _migrate(conn: sqlite3.Connection) -> None:
    """Idempotent migrations for databases created by older schemas."""
    phases = {
        **_PHASE2_COLUMNS,
        **_PHASE3_COLUMNS,
        **_PHASE4_COLUMNS,
        **_PHASE5_COLUMNS,
        **_PHASE6_COLUMNS,
    }
    for table, columns in phases.items():
        existing = {row["name"] for row in conn.execute(f"PRAGMA table_info({table})").fetchall()}
        for name, ddl in columns:
            if name not in existing:
                conn.execute(f"ALTER TABLE {table} ADD COLUMN {name} {ddl}")
    conn.commit()
    _encrypt_legacy_provider_secrets(conn)


def _encrypt_legacy_provider_secrets(conn: sqlite3.Connection) -> None:
    """One-way upgrade: encrypt plaintext provider secrets in place.

    Only runs when a runtime key is configured; otherwise legacy rows are
    left untouched (resolution refuses them fail-closed while a key exists).
    """
    from . import secrets as secrets_mod

    if not secrets_mod.keyring():
        return
    rows = conn.execute("SELECT id, config FROM providers").fetchall()
    for row in rows:
        try:
            config = json.loads(row["config"] or "{}")
        except ValueError:
            continue
        if not isinstance(config, dict):
            continue
        needs = {
            k: v
            for k, v in config.items()
            if secrets_mod.is_secret_key(k)
            and isinstance(v, str)
            and v
            and not secrets_mod.is_encrypted(v)
        }
        if not needs:
            continue
        for key, value in needs.items():
            config[key] = secrets_mod.encrypt_secret(value)
        conn.execute(
            "UPDATE providers SET config = ? WHERE id = ?", (json.dumps(config), row["id"])
        )
    conn.commit()


def record_event(
    conn: sqlite3.Connection, project_id: str, entity: str, entity_id: str, event_type: str
) -> Event:
    event = Event(
        id=new_id("evt"),
        project_id=project_id,
        entity=entity,
        entity_id=entity_id,
        event_type=event_type,
    )
    conn.execute(
        "INSERT INTO events (id, project_id, entity, entity_id, event_type, timestamp)"
        " VALUES (?, ?, ?, ?, ?, ?)",
        (event.id, project_id, entity, entity_id, event_type, event.timestamp.isoformat()),
    )
    conn.commit()
    return event


# -- Projects ---------------------------------------------------------------


def create_project(
    conn: sqlite3.Connection, owner: str, repository: str = "", config: dict[str, Any] | None = None
) -> Project:
    project = Project(id=new_id("prj"), owner=owner, repository=repository, config=config or {})
    conn.execute(
        "INSERT INTO projects (id, owner, repository, config) VALUES (?, ?, ?, ?)",
        (project.id, project.owner, project.repository, json.dumps(project.config)),
    )
    conn.commit()
    record_event(conn, project.id, "project", project.id, "project.created")
    return project


def get_project(conn: sqlite3.Connection, project_id: str) -> Project | None:
    row = conn.execute("SELECT * FROM projects WHERE id = ?", (project_id,)).fetchone()
    if row is None:
        return None
    return Project(
        id=row["id"],
        owner=row["owner"],
        repository=row["repository"],
        config=json.loads(row["config"]),
    )


# -- Teammates --------------------------------------------------------------


def create_teammate(
    conn: sqlite3.Connection,
    project_id: str,
    persona: str = "",
    instructions: str = "",
    capabilities: list[str] | None = None,
    memory_scope: str = "project",
    permissions: list[str] | None = None,
) -> Teammate:
    if get_project(conn, project_id) is None:
        raise KeyError(f"unknown project {project_id}")
    mate = Teammate(
        id=new_id("tm"),
        project_id=project_id,
        persona=persona,
        instructions=instructions,
        capabilities=capabilities or [],
        memory_scope=memory_scope,
        permissions=permissions or [],
    )
    conn.execute(
        "INSERT INTO teammates (id, project_id, persona, instructions, capabilities,"
        " memory_scope, permissions) VALUES (?, ?, ?, ?, ?, ?, ?)",
        (
            mate.id,
            mate.project_id,
            mate.persona,
            mate.instructions,
            json.dumps(mate.capabilities),
            mate.memory_scope,
            json.dumps(mate.permissions),
        ),
    )
    conn.commit()
    record_event(conn, project_id, "teammate", mate.id, "teammate.created")
    return mate


def _teammate_from_row(row: sqlite3.Row) -> Teammate:
    keys = row.keys()
    return Teammate(
        id=row["id"],
        project_id=row["project_id"],
        persona=row["persona"],
        instructions=row["instructions"],
        capabilities=json.loads(row["capabilities"]),
        memory_scope=row["memory_scope"],
        permissions=json.loads(row["permissions"]),
        status=TeammateStatus(row["status"] if "status" in keys and row["status"] else "active"),
        tool_policy=json.loads(row["tool_policy"])
        if "tool_policy" in keys and row["tool_policy"]
        else {},
        provider_id=row["provider_id"] if "provider_id" in keys else None,
    )


def get_teammate(conn: sqlite3.Connection, teammate_id: str) -> Teammate | None:
    row = conn.execute("SELECT * FROM teammates WHERE id = ?", (teammate_id,)).fetchone()
    if row is None:
        return None
    return _teammate_from_row(row)


def list_teammates(conn: sqlite3.Connection, project_id: str) -> list[Teammate]:
    rows = conn.execute(
        "SELECT * FROM teammates WHERE project_id = ? ORDER BY rowid", (project_id,)
    ).fetchall()
    return [_teammate_from_row(r) for r in rows]


def update_teammate(
    conn: sqlite3.Connection,
    teammate_id: str,
    persona: str | None = None,
    instructions: str | None = None,
    capabilities: list[str] | None = None,
    memory_scope: str | None = None,
    permissions: list[str] | None = None,
    tool_policy: dict[str, Any] | None = None,
    provider_id: str | None = None,
) -> Teammate:
    mate = get_teammate(conn, teammate_id)
    if mate is None:
        raise KeyError(f"unknown teammate {teammate_id}")
    if persona is not None:
        mate.persona = persona
    if instructions is not None:
        mate.instructions = instructions
    if capabilities is not None:
        mate.capabilities = capabilities
    if memory_scope is not None:
        mate.memory_scope = memory_scope
    if permissions is not None:
        mate.permissions = permissions
    if tool_policy is not None:
        mate.tool_policy = tool_policy
    if provider_id is not None:
        provider = get_provider(conn, provider_id)
        if provider is None or provider.project_id != mate.project_id:
            raise ValueError("provider must belong to the same project")
        if provider.status != ProviderStatus.ACTIVE:
            raise ValueError(f"provider {provider_id} is not active")
        mate.provider_id = provider_id
    conn.execute(
        "UPDATE teammates SET persona = ?, instructions = ?, capabilities = ?,"
        " memory_scope = ?, permissions = ?, tool_policy = ?, provider_id = ? WHERE id = ?",
        (
            mate.persona,
            mate.instructions,
            json.dumps(mate.capabilities),
            mate.memory_scope,
            json.dumps(mate.permissions),
            json.dumps(mate.tool_policy),
            mate.provider_id,
            mate.id,
        ),
    )
    conn.commit()
    record_event(conn, mate.project_id, "teammate", mate.id, "teammate.updated")
    return mate


def set_teammate_status(
    conn: sqlite3.Connection, teammate_id: str, status: TeammateStatus
) -> Teammate:
    mate = get_teammate(conn, teammate_id)
    if mate is None:
        raise KeyError(f"unknown teammate {teammate_id}")
    if mate.status == TeammateStatus.ARCHIVED and status != TeammateStatus.ARCHIVED:
        raise ValueError("archived teammates cannot be reactivated")
    mate.status = status
    conn.execute("UPDATE teammates SET status = ? WHERE id = ?", (status.value, mate.id))
    conn.commit()
    record_event(conn, mate.project_id, "teammate", mate.id, f"teammate.{status.value}")
    return mate


# -- Tasks ------------------------------------------------------------------


def create_task(
    conn: sqlite3.Connection,
    project_id: str,
    description: str,
    owner_teammate_id: str | None = None,
    dependencies: list[str] | None = None,
    command: str = "",
    issue_id: str | None = None,
) -> Task:
    if get_project(conn, project_id) is None:
        raise KeyError(f"unknown project {project_id}")
    deps = dependencies or []
    for dep in deps:
        drow = conn.execute("SELECT project_id FROM tasks WHERE id = ?", (dep,)).fetchone()
        if drow is None:
            raise KeyError(f"unknown dependency task {dep}")
        if drow["project_id"] != project_id:
            raise ValueError("dependency belongs to another project")
    if owner_teammate_id is not None:
        mate = get_teammate(conn, owner_teammate_id)
        if mate is None or mate.project_id != project_id:
            raise ValueError("owner teammate must belong to the same project")
    if issue_id is not None:
        issue = get_issue(conn, issue_id)
        if issue is None or issue.project_id != project_id:
            raise ValueError("issue must belong to the same project")
    task = Task(
        id=new_id("tsk"),
        project_id=project_id,
        description=description,
        status=TaskStatus.PENDING,
        owner_teammate_id=owner_teammate_id,
        dependencies=deps,
        command=command,
        issue_id=issue_id,
    )
    conn.execute(
        "INSERT INTO tasks (id, project_id, description, status, owner_teammate_id,"
        " dependencies, command, issue_id, branch, workspace_path)"
        " VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        (
            task.id,
            task.project_id,
            task.description,
            task.status.value,
            task.owner_teammate_id,
            json.dumps(task.dependencies),
            task.command,
            task.issue_id,
            task.branch,
            task.workspace_path,
        ),
    )
    conn.commit()
    record_event(conn, project_id, "task", task.id, "task.created")
    return task


def _task_from_row(row: sqlite3.Row) -> Task:
    keys = row.keys()
    return Task(
        id=row["id"],
        project_id=row["project_id"],
        description=row["description"],
        status=TaskStatus(row["status"]),
        owner_teammate_id=row["owner_teammate_id"],
        dependencies=json.loads(row["dependencies"]),
        command=row["command"] or "",
        issue_id=row["issue_id"] if "issue_id" in keys else None,
        branch=row["branch"] if "branch" in keys and row["branch"] else "",
        workspace_path=row["workspace_path"]
        if "workspace_path" in keys and row["workspace_path"]
        else "",
    )


def get_task(conn: sqlite3.Connection, task_id: str) -> Task | None:
    row = conn.execute("SELECT * FROM tasks WHERE id = ?", (task_id,)).fetchone()
    if row is None:
        return None
    return _task_from_row(row)


def list_tasks_for_project(conn: sqlite3.Connection, project_id: str) -> list[Task]:
    rows = conn.execute(
        "SELECT * FROM tasks WHERE project_id = ? ORDER BY rowid", (project_id,)
    ).fetchall()
    return [_task_from_row(r) for r in rows]


def set_task_workspace(
    conn: sqlite3.Connection, task_id: str, branch: str, workspace_path: str
) -> Task:
    task = get_task(conn, task_id)
    if task is None:
        raise KeyError(f"unknown task {task_id}")
    conn.execute(
        "UPDATE tasks SET branch = ?, workspace_path = ? WHERE id = ?",
        (branch, workspace_path, task_id),
    )
    conn.commit()
    record_event(conn, task.project_id, "workspace", task_id, "workspace.created")
    task.branch = branch
    task.workspace_path = workspace_path
    return task


def set_task_status(conn: sqlite3.Connection, task_id: str, status: TaskStatus) -> None:
    task = get_task(conn, task_id)
    if task is None:
        raise KeyError(f"unknown task {task_id}")
    if status != task.status and status not in TASK_TRANSITIONS[task.status]:
        raise InvalidTransitionError(f"task {task_id}: {task.status.value} -> {status.value}")
    conn.execute("UPDATE tasks SET status = ? WHERE id = ?", (status.value, task_id))
    conn.commit()
    if status != task.status:
        record_event(conn, task.project_id, "task", task_id, f"task.status.{status.value}")


def check_dependencies_acyclic(
    conn: sqlite3.Connection, project_id: str, task_id: str, dependencies: list[str]
) -> None:
    """Reject dependency sets that would create a cycle involving ``task_id``."""
    graph: dict[str, list[str]] = {task_id: list(dependencies)}
    rows = conn.execute(
        "SELECT id, dependencies FROM tasks WHERE project_id = ?", (project_id,)
    ).fetchall()
    for row in rows:
        if row["id"] != task_id:
            graph[row["id"]] = json.loads(row["dependencies"])
    visiting: set[str] = set()
    visited: set[str] = set()

    def visit(node: str) -> bool:
        if node in visiting:
            return True
        if node in visited:
            return False
        visiting.add(node)
        for dep in graph.get(node, []):
            if visit(dep):
                return True
        visiting.remove(node)
        visited.add(node)
        return False

    if visit(task_id):
        raise ValueError(f"dependencies would create a cycle for task {task_id}")


def update_task_dependencies(
    conn: sqlite3.Connection, task_id: str, dependencies: list[str]
) -> Task:
    task = get_task(conn, task_id)
    if task is None:
        raise KeyError(f"unknown task {task_id}")
    for dep in dependencies:
        drow = conn.execute("SELECT project_id FROM tasks WHERE id = ?", (dep,)).fetchone()
        if drow is None:
            raise KeyError(f"unknown dependency task {dep}")
        if drow["project_id"] != task.project_id:
            raise ValueError("dependency belongs to another project")
    check_dependencies_acyclic(conn, task.project_id, task_id, dependencies)
    conn.execute(
        "UPDATE tasks SET dependencies = ? WHERE id = ?", (json.dumps(dependencies), task_id)
    )
    conn.commit()
    record_event(conn, task.project_id, "task", task_id, "task.dependencies_updated")
    task.dependencies = dependencies
    return task


def assign_task_owner(conn: sqlite3.Connection, task_id: str, teammate_id: str | None) -> Task:
    task = get_task(conn, task_id)
    if task is None:
        raise KeyError(f"unknown task {task_id}")
    if teammate_id is not None:
        mate = get_teammate(conn, teammate_id)
        if mate is None or mate.project_id != task.project_id:
            raise ValueError("owner teammate must belong to the same project")
        if mate.status != TeammateStatus.ACTIVE:
            raise ValueError(f"teammate {teammate_id} is {mate.status.value}, not active")
    conn.execute("UPDATE tasks SET owner_teammate_id = ? WHERE id = ?", (teammate_id, task_id))
    conn.commit()
    record_event(conn, task.project_id, "task", task_id, "task.assigned")
    task.owner_teammate_id = teammate_id
    return task


# -- Runs -------------------------------------------------------------------


def create_run(
    conn: sqlite3.Connection,
    task_id: str,
    runtime: str = "local",
    session: str = "",
    command: str = "",
    provider_id: str | None = None,
) -> Run:
    task = get_task(conn, task_id)
    if task is None:
        raise KeyError(f"unknown task {task_id}")
    run = Run(
        id=new_id("run"),
        task_id=task_id,
        runtime=runtime,
        session=session,
        status=RunStatus.QUEUED,
        started_at=datetime.now(UTC),
        command=command or task.command,
        provider_id=provider_id,
    )
    conn.execute(
        "INSERT INTO runs (id, task_id, runtime, session, status, started_at, finished_at,"
        " exit_code, output_excerpt, command, stdout, stderr, duration_s, provider_id)"
        " VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        (
            run.id,
            run.task_id,
            run.runtime,
            run.session,
            run.status.value,
            run.started_at.isoformat(),
            None,
            None,
            "",
            run.command,
            "",
            "",
            0.0,
            run.provider_id,
        ),
    )
    conn.commit()
    record_event(conn, task.project_id, "run", run.id, "run.created")
    return run


def _run_from_row(r: sqlite3.Row) -> Run:
    keys = r.keys()
    return Run(
        id=r["id"],
        task_id=r["task_id"],
        runtime=r["runtime"],
        session=r["session"],
        status=RunStatus(r["status"]),
        started_at=datetime.fromisoformat(r["started_at"]),
        finished_at=datetime.fromisoformat(r["finished_at"]) if r["finished_at"] else None,
        exit_code=r["exit_code"],
        output_excerpt=r["output_excerpt"] or "",
        command=r["command"] if "command" in keys and r["command"] else "",
        stdout=r["stdout"] if "stdout" in keys and r["stdout"] else "",
        stderr=r["stderr"] if "stderr" in keys and r["stderr"] else "",
        duration_s=r["duration_s"] if "duration_s" in keys and r["duration_s"] else 0.0,
        provider_id=r["provider_id"] if "provider_id" in keys else None,
    )


def get_run(conn: sqlite3.Connection, run_id: str) -> Run | None:
    row = conn.execute("SELECT * FROM runs WHERE id = ?", (run_id,)).fetchone()
    if row is None:
        return None
    return _run_from_row(row)


def list_runs_for_task(conn: sqlite3.Connection, task_id: str) -> list[Run]:
    rows = conn.execute(
        "SELECT * FROM runs WHERE task_id = ? ORDER BY started_at", (task_id,)
    ).fetchall()
    return [_run_from_row(r) for r in rows]


def list_runs_for_project(conn: sqlite3.Connection, project_id: str) -> list[Run]:
    rows = conn.execute(
        "SELECT runs.* FROM runs JOIN tasks ON runs.task_id = tasks.id"
        " WHERE tasks.project_id = ? ORDER BY runs.started_at",
        (project_id,),
    ).fetchall()
    return [_run_from_row(r) for r in rows]


def mark_run_running(conn: sqlite3.Connection, run_id: str) -> Run:
    run = get_run(conn, run_id)
    if run is None:
        raise KeyError(f"unknown run {run_id}")
    if run.status != RunStatus.QUEUED:
        raise InvalidTransitionError(f"run {run_id}: {run.status.value} -> running")
    conn.execute("UPDATE runs SET status = ? WHERE id = ?", (RunStatus.RUNNING.value, run_id))
    conn.commit()
    run.status = RunStatus.RUNNING
    task = get_task(conn, run.task_id)
    if task is not None:
        record_event(conn, task.project_id, "run", run_id, "run.status.running")
    return run


def finish_run(
    conn: sqlite3.Connection,
    run_id: str,
    status: RunStatus,
    exit_code: int | None,
    output_excerpt: str,
    stdout: str = "",
    stderr: str = "",
    duration_s: float = 0.0,
) -> None:
    run = get_run(conn, run_id)
    if run is None:
        raise KeyError(f"unknown run {run_id}")
    if run.status in TERMINAL_RUN_STATUSES:
        raise TerminalRunError(f"run {run_id} is already terminal ({run.status.value})")
    if status not in RUN_TRANSITIONS[run.status]:
        raise InvalidTransitionError(f"run {run_id}: {run.status.value} -> {status.value}")
    conn.execute(
        "UPDATE runs SET status = ?, finished_at = ?, exit_code = ?, output_excerpt = ?,"
        " stdout = ?, stderr = ?, duration_s = ? WHERE id = ?",
        (
            status.value,
            _now_iso(),
            exit_code,
            output_excerpt[:4000],
            stdout[-8000:],
            stderr[-8000:],
            duration_s,
            run_id,
        ),
    )
    conn.commit()
    task = get_task(conn, run.task_id)
    if task is not None:
        record_event(conn, task.project_id, "run", run_id, f"run.status.{status.value}")


# -- Memory (fail-closed reads) ----------------------------------------------


def write_memory(
    conn: sqlite3.Connection, scope: str, content: str, source: str, confidence: float = 0.5
) -> MemoryEntry:
    if not source:
        raise ValueError("memory write requires a provenance source")
    entry = MemoryEntry(
        id=new_id("mem"), scope=scope, content=content, source=source, confidence=confidence
    )
    conn.execute(
        "INSERT INTO memories (id, scope, content, source, confidence, timestamp)"
        " VALUES (?, ?, ?, ?, ?, ?)",
        (
            entry.id,
            entry.scope,
            entry.content,
            entry.source,
            entry.confidence,
            entry.timestamp.isoformat(),
        ),
    )
    conn.commit()
    return entry


class MemoryReadError(RuntimeError):
    """Raised when a memory read fails. Callers must treat this as an error,
    never as an empty result (fail-closed)."""


def recall_memory(conn: sqlite3.Connection, scope: str, limit: int = 20) -> list[MemoryEntry]:
    try:
        rows = conn.execute(
            "SELECT * FROM memories WHERE scope = ? ORDER BY timestamp DESC LIMIT ?",
            (scope, limit),
        ).fetchall()
    except Exception as exc:
        raise MemoryReadError(f"memory recall failed for scope {scope!r}: {exc}") from exc
    return [
        MemoryEntry(
            id=r["id"],
            scope=r["scope"],
            content=r["content"],
            source=r["source"],
            confidence=r["confidence"],
            timestamp=datetime.fromisoformat(r["timestamp"]),
        )
        for r in rows
    ]


# -- Artifacts / approvals / events ------------------------------------------


def create_artifact(
    conn: sqlite3.Connection,
    task_id: str,
    run_id: str,
    type: str,
    location: str,
    verification_status: VerificationStatus,
    summary: str = "",
) -> Artifact:
    artifact = Artifact(
        id=new_id("art"),
        task_id=task_id,
        run_id=run_id,
        type=type,
        location=location,
        verification_status=verification_status,
        summary=summary,
    )
    conn.execute(
        "INSERT INTO artifacts (id, task_id, run_id, type, location,"
        " verification_status, summary) VALUES (?, ?, ?, ?, ?, ?, ?)",
        (
            artifact.id,
            artifact.task_id,
            artifact.run_id,
            artifact.type,
            artifact.location,
            artifact.verification_status.value,
            artifact.summary,
        ),
    )
    conn.commit()
    task = get_task(conn, task_id)
    if task is not None:
        record_event(conn, task.project_id, "artifact", artifact.id, "artifact.created")
    return artifact


def _artifact_from_row(r: sqlite3.Row) -> Artifact:
    return Artifact(
        id=r["id"],
        task_id=r["task_id"],
        run_id=r["run_id"],
        type=r["type"],
        location=r["location"],
        verification_status=VerificationStatus(r["verification_status"]),
        summary=r["summary"] or "",
    )


def get_artifact(conn: sqlite3.Connection, artifact_id: str) -> Artifact | None:
    row = conn.execute("SELECT * FROM artifacts WHERE id = ?", (artifact_id,)).fetchone()
    if row is None:
        return None
    return _artifact_from_row(row)


def list_artifacts_for_task(conn: sqlite3.Connection, task_id: str) -> list[Artifact]:
    rows = conn.execute("SELECT * FROM artifacts WHERE task_id = ?", (task_id,)).fetchall()
    return [_artifact_from_row(r) for r in rows]


def _approval_from_row(row: sqlite3.Row) -> Approval:
    keys = row.keys()
    return Approval(
        id=row["id"],
        run_id=row["run_id"],
        action=row["action"],
        requester=row["requester"],
        decision=Decision(row["decision"]),
        decided_at=datetime.fromisoformat(row["decided_at"]) if row["decided_at"] else None,
        expires_at=datetime.fromisoformat(row["expires_at"])
        if "expires_at" in keys and row["expires_at"]
        else None,
        consumed_at=datetime.fromisoformat(row["consumed_at"])
        if "consumed_at" in keys and row["consumed_at"]
        else None,
        task_id=row["task_id"] if "task_id" in keys else None,
        digest=row["digest"] if "digest" in keys else None,
    )


def _approval_project(conn: sqlite3.Connection, run_id: str) -> str | None:
    row = conn.execute(
        "SELECT tasks.project_id FROM runs JOIN tasks ON runs.task_id = tasks.id WHERE runs.id = ?",
        (run_id,),
    ).fetchone()
    return row["project_id"] if row else None


def approval_project(conn: sqlite3.Connection, approval_id: str) -> str | None:
    """Resolve the owning project of an approval (exactly one, via its run)."""
    approval = get_approval(conn, approval_id)
    if approval is None:
        return None
    return _approval_project(conn, approval.run_id)


def purge_expired_approvals(conn: sqlite3.Connection, project_id: str) -> int:
    """Delete expired, still-undecided approvals for one project.

    Decided approvals are never removed. Returns the purged count.
    """
    now = datetime.now(UTC).isoformat()
    rows = conn.execute(
        "SELECT approvals.id FROM approvals JOIN runs ON approvals.run_id = runs.id"
        " JOIN tasks ON runs.task_id = tasks.id"
        " WHERE tasks.project_id = ? AND approvals.decision = 'pending'"
        " AND approvals.consumed_at IS NULL"
        " AND approvals.expires_at IS NOT NULL AND approvals.expires_at <= ?",
        (project_id, now),
    ).fetchall()
    for row in rows:
        conn.execute("DELETE FROM approvals WHERE id = ?", (row["id"],))
    conn.commit()
    for row in rows:
        record_event(conn, project_id, "approval", row["id"], "approval.purged")
    return len(rows)


DEFAULT_APPROVAL_TTL_S = 600.0


def request_approval(
    conn: sqlite3.Connection,
    run_id: str,
    action: str,
    requester: str,
    ttl_s: float = DEFAULT_APPROVAL_TTL_S,
    task_id: str | None = None,
    digest: str | None = None,
) -> Approval:
    if conn.execute("SELECT id FROM runs WHERE id = ?", (run_id,)).fetchone() is None:
        raise KeyError(f"unknown run {run_id}")
    now = datetime.now(UTC)
    approval = Approval(
        id=new_id("apr"),
        run_id=run_id,
        action=action,
        requester=requester,
        expires_at=now + timedelta(seconds=ttl_s),
        task_id=task_id,
        digest=digest,
    )
    conn.execute(
        "INSERT INTO approvals (id, run_id, action, requester, decision, decided_at,"
        " expires_at, consumed_at, task_id, digest) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        (
            approval.id,
            approval.run_id,
            approval.action,
            approval.requester,
            approval.decision.value,
            None,
            approval.expires_at.isoformat() if approval.expires_at else None,
            None,
            approval.task_id,
            approval.digest,
        ),
    )
    conn.commit()
    project_id = _approval_project(conn, run_id)
    if project_id is not None:
        record_event(conn, project_id, "approval", approval.id, "approval.requested")
    return approval


def list_approvals_for_task(conn: sqlite3.Connection, task_id: str) -> list[Approval]:
    rows = conn.execute(
        "SELECT approvals.* FROM approvals JOIN runs ON approvals.run_id = runs.id"
        " WHERE runs.task_id = ? ORDER BY approvals.rowid",
        (task_id,),
    ).fetchall()
    return [_approval_from_row(r) for r in rows]


def get_approval(conn: sqlite3.Connection, approval_id: str) -> Approval | None:
    row = conn.execute("SELECT * FROM approvals WHERE id = ?", (approval_id,)).fetchone()
    if row is None:
        return None
    return _approval_from_row(row)


def list_approvals_for_run(conn: sqlite3.Connection, run_id: str) -> list[Approval]:
    rows = conn.execute(
        "SELECT * FROM approvals WHERE run_id = ? ORDER BY rowid", (run_id,)
    ).fetchall()
    return [_approval_from_row(r) for r in rows]


def decide_approval(conn: sqlite3.Connection, approval_id: str, decision: Decision) -> Approval:
    approval = get_approval(conn, approval_id)
    if approval is None:
        raise KeyError(f"unknown approval {approval_id}")
    if approval.decision != Decision.PENDING or approval.consumed_at is not None:
        raise ApprovalDecidedError(f"approval {approval_id} already decided (one-use)")
    if approval.expires_at is not None and datetime.now(UTC) > approval.expires_at:
        raise ApprovalExpiredError(f"approval {approval_id} expired at {approval.expires_at}")
    decided_at = _now_iso()
    conn.execute(
        "UPDATE approvals SET decision = ?, decided_at = ?, consumed_at = ? WHERE id = ?",
        (decision.value, decided_at, decided_at, approval_id),
    )
    conn.commit()
    project_id = _approval_project(conn, approval.run_id)
    if project_id is not None:
        record_event(conn, project_id, "approval", approval_id, f"approval.{decision.value}")
    approval.decision = decision
    approval.decided_at = datetime.fromisoformat(decided_at)
    approval.consumed_at = datetime.fromisoformat(decided_at)
    return approval


def list_events(conn: sqlite3.Connection, project_id: str) -> list[Event]:
    rows = conn.execute(
        "SELECT * FROM events WHERE project_id = ? ORDER BY timestamp", (project_id,)
    ).fetchall()
    return [
        Event(
            id=r["id"],
            project_id=r["project_id"],
            entity=r["entity"],
            entity_id=r["entity_id"],
            event_type=r["event_type"],
            timestamp=datetime.fromisoformat(r["timestamp"]),
        )
        for r in rows
    ]


# -- Issues -------------------------------------------------------------------


def _issue_from_row(row: sqlite3.Row) -> Issue:
    return Issue(
        id=row["id"],
        project_id=row["project_id"],
        source=row["source"] or "manual",
        external_id=row["external_id"] or "",
        title=row["title"] or "",
        body=row["body"] or "",
        acceptance_criteria=json.loads(row["acceptance_criteria"]),
        repository_url=row["repository_url"] or "",
        base_branch=row["base_branch"] or "main",
        labels=json.loads(row["labels"]),
        owner_teammate_id=row["owner_teammate_id"],
        priority=row["priority"] or "medium",
        status=row["status"] or "open",
        created_at=datetime.fromisoformat(row["created_at"]),
    )


def create_issue(
    conn: sqlite3.Connection,
    project_id: str,
    title: str,
    body: str = "",
    source: str = "manual",
    external_id: str = "",
    acceptance_criteria: list[str] | None = None,
    repository_url: str = "",
    base_branch: str = "main",
    labels: list[str] | None = None,
    owner_teammate_id: str | None = None,
    priority: str = "medium",
) -> Issue:
    if get_project(conn, project_id) is None:
        raise KeyError(f"unknown project {project_id}")
    if not title.strip():
        raise ValueError("issue title is required")
    if owner_teammate_id is not None:
        mate = get_teammate(conn, owner_teammate_id)
        if mate is None or mate.project_id != project_id:
            raise ValueError("owner teammate must belong to the same project")
    issue = Issue(
        id=new_id("iss"),
        project_id=project_id,
        source=source,
        external_id=external_id,
        title=title,
        body=body,
        acceptance_criteria=acceptance_criteria or [],
        repository_url=repository_url,
        base_branch=base_branch,
        labels=labels or [],
        owner_teammate_id=owner_teammate_id,
        priority=priority,
    )
    conn.execute(
        "INSERT INTO issues (id, project_id, source, external_id, title, body,"
        " acceptance_criteria, repository_url, base_branch, labels, owner_teammate_id,"
        " priority, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        (
            issue.id,
            issue.project_id,
            issue.source,
            issue.external_id,
            issue.title,
            issue.body,
            json.dumps(issue.acceptance_criteria),
            issue.repository_url,
            issue.base_branch,
            json.dumps(issue.labels),
            issue.owner_teammate_id,
            issue.priority,
            issue.status,
            issue.created_at.isoformat(),
        ),
    )
    conn.commit()
    record_event(conn, project_id, "issue", issue.id, "issue.ingested")
    return issue


def get_issue(conn: sqlite3.Connection, issue_id: str) -> Issue | None:
    row = conn.execute("SELECT * FROM issues WHERE id = ?", (issue_id,)).fetchone()
    if row is None:
        return None
    return _issue_from_row(row)


def list_issues_for_project(conn: sqlite3.Connection, project_id: str) -> list[Issue]:
    rows = conn.execute(
        "SELECT * FROM issues WHERE project_id = ? ORDER BY rowid", (project_id,)
    ).fetchall()
    return [_issue_from_row(r) for r in rows]


# -- Reviews ------------------------------------------------------------------


def create_review(
    conn: sqlite3.Connection,
    task_id: str,
    reviewer_teammate_id: str,
    verdict: ReviewVerdict,
    notes: str = "",
    risks: list[str] | None = None,
    run_id: str = "",
) -> Review:
    task = get_task(conn, task_id)
    if task is None:
        raise KeyError(f"unknown task {task_id}")
    reviewer = get_teammate(conn, reviewer_teammate_id)
    if reviewer is None or reviewer.project_id != task.project_id:
        raise ValueError("reviewer must belong to the same project")
    if reviewer.status != TeammateStatus.ACTIVE:
        raise ValueError(f"reviewer is {reviewer.status.value}, not active")
    if task.owner_teammate_id is not None and reviewer_teammate_id == task.owner_teammate_id:
        raise ValueError("reviewer must differ from the implementing owner")
    review = Review(
        id=new_id("rev"),
        task_id=task_id,
        run_id=run_id,
        reviewer_teammate_id=reviewer_teammate_id,
        verdict=verdict,
        notes=notes,
        risks=risks or [],
    )
    conn.execute(
        "INSERT INTO reviews (id, task_id, run_id, reviewer_teammate_id, verdict, notes,"
        " risks, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        (
            review.id,
            review.task_id,
            review.run_id,
            review.reviewer_teammate_id,
            review.verdict.value,
            review.notes,
            json.dumps(review.risks),
            review.created_at.isoformat(),
        ),
    )
    conn.commit()
    record_event(conn, task.project_id, "review", review.id, "review.completed")
    return review


def list_reviews_for_task(conn: sqlite3.Connection, task_id: str) -> list[Review]:
    rows = conn.execute(
        "SELECT * FROM reviews WHERE task_id = ? ORDER BY rowid", (task_id,)
    ).fetchall()
    return [
        Review(
            id=r["id"],
            task_id=r["task_id"],
            run_id=r["run_id"] or "",
            reviewer_teammate_id=r["reviewer_teammate_id"] or "",
            verdict=ReviewVerdict(r["verdict"]),
            notes=r["notes"] or "",
            risks=json.loads(r["risks"]),
            created_at=datetime.fromisoformat(r["created_at"]),
        )
        for r in rows
    ]


# -- PR packages --------------------------------------------------------------


def create_pr_package(
    conn: sqlite3.Connection,
    task_id: str,
    title: str,
    body: str = "",
    base_branch: str = "main",
    head_branch: str = "",
    labels: list[str] | None = None,
    patch_summary: str = "",
    test_evidence: list[dict[str, Any]] | None = None,
    review_evidence: dict[str, Any] | None = None,
    patch_artifact_id: str = "",
    digest: str = "",
) -> PRPackage:
    task = get_task(conn, task_id)
    if task is None:
        raise KeyError(f"unknown task {task_id}")
    package = PRPackage(
        id=new_id("prp"),
        task_id=task_id,
        title=title,
        body=body,
        base_branch=base_branch,
        head_branch=head_branch,
        labels=labels or [],
        patch_summary=patch_summary,
        test_evidence=test_evidence or [],
        review_evidence=review_evidence or {},
        patch_artifact_id=patch_artifact_id,
        digest=digest,
    )
    conn.execute(
        "INSERT INTO pr_packages (id, task_id, title, body, base_branch, head_branch, labels,"
        " patch_summary, test_evidence, review_evidence, patch_artifact_id, digest, created_at)"
        " VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        (
            package.id,
            package.task_id,
            package.title,
            package.body,
            package.base_branch,
            package.head_branch,
            json.dumps(package.labels),
            package.patch_summary,
            json.dumps(package.test_evidence),
            json.dumps(package.review_evidence),
            package.patch_artifact_id,
            package.digest,
            package.created_at.isoformat(),
        ),
    )
    conn.commit()
    record_event(conn, task.project_id, "pr_package", package.id, "package.generated")
    return package


def _pr_package_from_row(row: sqlite3.Row) -> PRPackage:
    return PRPackage(
        id=row["id"],
        task_id=row["task_id"],
        title=row["title"] or "",
        body=row["body"] or "",
        base_branch=row["base_branch"] or "main",
        head_branch=row["head_branch"] or "",
        labels=json.loads(row["labels"]),
        patch_summary=row["patch_summary"] or "",
        test_evidence=json.loads(row["test_evidence"]),
        review_evidence=json.loads(row["review_evidence"]),
        patch_artifact_id=row["patch_artifact_id"] or "",
        digest=row["digest"] or "",
        created_at=datetime.fromisoformat(row["created_at"]),
    )


def get_pr_package(conn: sqlite3.Connection, package_id: str) -> PRPackage | None:
    row = conn.execute("SELECT * FROM pr_packages WHERE id = ?", (package_id,)).fetchone()
    if row is None:
        return None
    return _pr_package_from_row(row)


def list_pr_packages_for_task(conn: sqlite3.Connection, task_id: str) -> list[PRPackage]:
    rows = conn.execute(
        "SELECT * FROM pr_packages WHERE task_id = ? ORDER BY rowid", (task_id,)
    ).fetchall()
    return [_pr_package_from_row(r) for r in rows]


# -- Providers ---------------------------------------------------------------


def encrypt_provider_config(config: dict[str, Any]) -> dict[str, Any]:
    """Encrypt secret-shaped config values. Raises SecretKeyMissingError when
    secrets are present but no runtime key is configured."""
    from . import secrets as secrets_mod

    stored: dict[str, Any] = {}
    for key, value in config.items():
        if secrets_mod.is_secret_key(key) and isinstance(value, str) and value:
            if secrets_mod.is_encrypted(value):
                stored[key] = secrets_mod.verify_envelope(value)
            else:
                stored[key] = secrets_mod.encrypt_secret(value)
        else:
            stored[key] = value
    return stored


def _provider_from_row(row: sqlite3.Row) -> Provider:
    return Provider(
        id=row["id"],
        project_id=row["project_id"],
        kind=ProviderKind(row["kind"] or "local"),
        name=row["name"] or "",
        config=json.loads(row["config"]),
        capabilities=json.loads(row["capabilities"]),
        status=ProviderStatus(row["status"] or "active"),
        created_at=datetime.fromisoformat(row["created_at"]),
    )


def create_provider(
    conn: sqlite3.Connection,
    project_id: str,
    kind: ProviderKind = ProviderKind.LOCAL,
    name: str = "",
    config: dict[str, Any] | None = None,
    capabilities: list[str] | None = None,
) -> Provider:
    if get_project(conn, project_id) is None:
        raise KeyError(f"unknown project {project_id}")
    stored_config = encrypt_provider_config(config or {})
    provider = Provider(
        id=new_id("prv"),
        project_id=project_id,
        kind=kind,
        name=name or kind.value,
        config=stored_config,
        capabilities=capabilities or [],
    )
    conn.execute(
        "INSERT INTO providers (id, project_id, kind, name, config, capabilities, status,"
        " created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        (
            provider.id,
            provider.project_id,
            provider.kind.value,
            provider.name,
            json.dumps(provider.config),
            json.dumps(provider.capabilities),
            provider.status.value,
            provider.created_at.isoformat(),
        ),
    )
    conn.commit()
    record_event(conn, project_id, "provider", provider.id, f"provider.{kind.value}.added")
    return provider


def get_provider(conn: sqlite3.Connection, provider_id: str) -> Provider | None:
    row = conn.execute("SELECT * FROM providers WHERE id = ?", (provider_id,)).fetchone()
    if row is None:
        return None
    return _provider_from_row(row)


def list_providers(conn: sqlite3.Connection, project_id: str) -> list[Provider]:
    rows = conn.execute(
        "SELECT * FROM providers WHERE project_id = ? ORDER BY rowid", (project_id,)
    ).fetchall()
    return [_provider_from_row(r) for r in rows]


def set_provider_status(
    conn: sqlite3.Connection, provider_id: str, status: ProviderStatus
) -> Provider:
    provider = get_provider(conn, provider_id)
    if provider is None:
        raise KeyError(f"unknown provider {provider_id}")
    provider.status = status
    conn.execute("UPDATE providers SET status = ? WHERE id = ?", (status.value, provider_id))
    conn.commit()
    record_event(conn, provider.project_id, "provider", provider_id, f"provider.{status.value}")
    return provider


# -- Knowledge ----------------------------------------------------------------


def create_knowledge_source(
    conn: sqlite3.Connection,
    project_id: str,
    title: str,
    content: str,
    source: str,
    kind: str = "text",
) -> KnowledgeSource:
    if get_project(conn, project_id) is None:
        raise KeyError(f"unknown project {project_id}")
    if not source:
        raise ValueError("knowledge source requires provenance")
    if not content.strip():
        raise ValueError("knowledge source requires content")
    entry = KnowledgeSource(
        id=new_id("kns"),
        project_id=project_id,
        kind=kind,
        title=title,
        content=content,
        source=source,
    )
    conn.execute(
        "INSERT INTO knowledge_sources (id, project_id, kind, title, content, source, created_at)"
        " VALUES (?, ?, ?, ?, ?, ?, ?)",
        (
            entry.id,
            entry.project_id,
            entry.kind,
            entry.title,
            entry.content,
            entry.source,
            entry.created_at.isoformat(),
        ),
    )
    conn.commit()
    record_event(conn, project_id, "knowledge", entry.id, "knowledge.ingested")
    return entry


def get_knowledge_source(conn: sqlite3.Connection, source_id: str) -> KnowledgeSource | None:
    row = conn.execute("SELECT * FROM knowledge_sources WHERE id = ?", (source_id,)).fetchone()
    if row is None:
        return None
    return KnowledgeSource(
        id=row["id"],
        project_id=row["project_id"],
        kind=row["kind"] or "text",
        title=row["title"] or "",
        content=row["content"] or "",
        source=row["source"] or "",
        created_at=datetime.fromisoformat(row["created_at"]),
    )


def list_knowledge_sources(conn: sqlite3.Connection, project_id: str) -> list[KnowledgeSource]:
    rows = conn.execute(
        "SELECT * FROM knowledge_sources WHERE project_id = ? ORDER BY rowid", (project_id,)
    ).fetchall()
    return [
        KnowledgeSource(
            id=r["id"],
            project_id=r["project_id"],
            kind=r["kind"] or "text",
            title=r["title"] or "",
            content=r["content"] or "",
            source=r["source"] or "",
            created_at=datetime.fromisoformat(r["created_at"]),
        )
        for r in rows
    ]


def store_knowledge_chunks(
    conn: sqlite3.Connection, source_id: str, project_id: str, chunks: list[str]
) -> list[KnowledgeChunk]:
    stored: list[KnowledgeChunk] = []
    for idx, text in enumerate(chunks):
        chunk = KnowledgeChunk(
            id=new_id("knc"), source_id=source_id, project_id=project_id, idx=idx, text=text
        )
        conn.execute(
            "INSERT INTO knowledge_chunks (id, source_id, project_id, idx, text, created_at)"
            " VALUES (?, ?, ?, ?, ?, ?)",
            (
                chunk.id,
                chunk.source_id,
                chunk.project_id,
                chunk.idx,
                chunk.text,
                chunk.created_at.isoformat(),
            ),
        )
        stored.append(chunk)
    conn.commit()
    return stored


def list_knowledge_chunks(conn: sqlite3.Connection, project_id: str) -> list[KnowledgeChunk]:
    rows = conn.execute(
        "SELECT * FROM knowledge_chunks WHERE project_id = ? ORDER BY source_id, idx",
        (project_id,),
    ).fetchall()
    return [
        KnowledgeChunk(
            id=r["id"],
            source_id=r["source_id"],
            project_id=r["project_id"],
            idx=r["idx"],
            text=r["text"] or "",
            created_at=datetime.fromisoformat(r["created_at"]),
        )
        for r in rows
    ]


# -- Schedules ----------------------------------------------------------------


def _schedule_from_row(row: sqlite3.Row) -> Schedule:
    return Schedule(
        id=row["id"],
        project_id=row["project_id"],
        name=row["name"] or "",
        cron=row["cron"],
        task_template=json.loads(row["task_template"]),
        enabled=bool(row["enabled"]),
        next_run_at=datetime.fromisoformat(row["next_run_at"]) if row["next_run_at"] else None,
        last_fired_at=datetime.fromisoformat(row["last_fired_at"])
        if row["last_fired_at"]
        else None,
        locked=bool(row["locked"]),
        fire_count=row["fire_count"] or 0,
        created_at=datetime.fromisoformat(row["created_at"]),
    )


def create_schedule(
    conn: sqlite3.Connection,
    project_id: str,
    name: str,
    cron: str,
    task_template: dict[str, Any],
    next_run_at: datetime,
) -> Schedule:
    if get_project(conn, project_id) is None:
        raise KeyError(f"unknown project {project_id}")
    if not task_template.get("description") or not task_template.get("command"):
        raise ValueError("schedule task_template requires description and command")
    schedule = Schedule(
        id=new_id("sch"),
        project_id=project_id,
        name=name,
        cron=cron,
        task_template=task_template,
        next_run_at=next_run_at,
    )
    conn.execute(
        "INSERT INTO schedules (id, project_id, name, cron, task_template, enabled, next_run_at,"
        " last_fired_at, locked, fire_count, created_at)"
        " VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        (
            schedule.id,
            schedule.project_id,
            schedule.name,
            schedule.cron,
            json.dumps(schedule.task_template),
            1,
            schedule.next_run_at.isoformat() if schedule.next_run_at else None,
            None,
            0,
            0,
            schedule.created_at.isoformat(),
        ),
    )
    conn.commit()
    record_event(conn, project_id, "schedule", schedule.id, "schedule.created")
    return schedule


def get_schedule(conn: sqlite3.Connection, schedule_id: str) -> Schedule | None:
    row = conn.execute("SELECT * FROM schedules WHERE id = ?", (schedule_id,)).fetchone()
    if row is None:
        return None
    return _schedule_from_row(row)


def list_schedules(conn: sqlite3.Connection, project_id: str) -> list[Schedule]:
    rows = conn.execute(
        "SELECT * FROM schedules WHERE project_id = ? ORDER BY rowid", (project_id,)
    ).fetchall()
    return [_schedule_from_row(r) for r in rows]


def set_schedule_enabled(conn: sqlite3.Connection, schedule_id: str, enabled: bool) -> Schedule:
    schedule = get_schedule(conn, schedule_id)
    if schedule is None:
        raise KeyError(f"unknown schedule {schedule_id}")
    conn.execute(
        "UPDATE schedules SET enabled = ? WHERE id = ?", (1 if enabled else 0, schedule_id)
    )
    conn.commit()
    schedule.enabled = enabled
    record_event(
        conn,
        schedule.project_id,
        "schedule",
        schedule_id,
        f"schedule.{'enabled' if enabled else 'disabled'}",
    )
    return schedule


def lock_schedule(conn: sqlite3.Connection, schedule_id: str) -> bool:
    """Overlap protection: claim the firing lease. False if already locked."""
    row = conn.execute("SELECT locked FROM schedules WHERE id = ?", (schedule_id,)).fetchone()
    if row is None:
        raise KeyError(f"unknown schedule {schedule_id}")
    if row["locked"]:
        return False
    conn.execute("UPDATE schedules SET locked = 1 WHERE id = ?", (schedule_id,))
    conn.commit()
    return True


def record_schedule_fired(
    conn: sqlite3.Connection, schedule_id: str, fired_at: datetime, next_run_at: datetime
) -> None:
    conn.execute(
        "UPDATE schedules SET locked = 0, last_fired_at = ?, next_run_at = ?,"
        " fire_count = fire_count + 1 WHERE id = ?",
        (fired_at.isoformat(), next_run_at.isoformat(), schedule_id),
    )
    conn.commit()


def due_schedules(conn: sqlite3.Connection, now: datetime) -> list[Schedule]:
    rows = conn.execute(
        "SELECT * FROM schedules WHERE enabled = 1 AND locked = 0 AND next_run_at <= ?"
        " ORDER BY next_run_at, rowid",
        (now.isoformat(),),
    ).fetchall()
    return [_schedule_from_row(r) for r in rows]


# -- Notifications ---------------------------------------------------------------


SENSITIVE_KEYS = {"secret", "token", "password", "api_key", "apikey", "authorization"}


def redact_payload(payload: dict[str, Any]) -> dict[str, Any]:
    return {
        key: ("[redacted]" if key.lower() in SENSITIVE_KEYS else value)
        for key, value in payload.items()
    }


def create_notification(
    conn: sqlite3.Connection,
    project_id: str,
    channel: str,
    kind: str,
    payload: dict[str, Any] | None = None,
    status: str = "queued",
    target_url: str = "",
) -> Notification:
    if get_project(conn, project_id) is None:
        raise KeyError(f"unknown project {project_id}")
    note = Notification(
        id=new_id("ntf"),
        project_id=project_id,
        channel=channel,
        kind=kind,
        payload=redact_payload(payload or {}),
        status=status,
        target_url=target_url,
    )
    conn.execute(
        "INSERT INTO notifications (id, project_id, channel, kind, payload, status,"
        " target_url, attempts, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        (
            note.id,
            note.project_id,
            note.channel,
            note.kind,
            json.dumps(note.payload),
            note.status,
            note.target_url,
            0,
            note.created_at.isoformat(),
        ),
    )
    conn.commit()
    record_event(conn, project_id, "notification", note.id, f"notification.{kind}")
    return note


def _notification_from_row(r: sqlite3.Row) -> Notification:
    keys = r.keys()
    return Notification(
        id=r["id"],
        project_id=r["project_id"],
        channel=r["channel"] or "outbox",
        kind=r["kind"] or "",
        payload=json.loads(r["payload"]),
        status=r["status"] or "queued",
        target_url=r["target_url"] if "target_url" in keys and r["target_url"] else "",
        attempts=r["attempts"] if "attempts" in keys and r["attempts"] else 0,
        next_attempt_at=datetime.fromisoformat(r["next_attempt_at"])
        if "next_attempt_at" in keys and r["next_attempt_at"]
        else None,
        locked=bool(r["locked"]) if "locked" in keys and r["locked"] else False,
        created_at=datetime.fromisoformat(r["created_at"]),
    )


def get_notification(conn: sqlite3.Connection, notification_id: str) -> Notification | None:
    row = conn.execute("SELECT * FROM notifications WHERE id = ?", (notification_id,)).fetchone()
    if row is None:
        return None
    return _notification_from_row(row)


def set_notification_delivery(
    conn: sqlite3.Connection, notification_id: str, status: str, attempts: int
) -> None:
    conn.execute(
        "UPDATE notifications SET status = ?, attempts = ? WHERE id = ?",
        (status, attempts, notification_id),
    )
    conn.commit()


def set_notification_next_attempt(
    conn: sqlite3.Connection, notification_id: str, next_at: datetime
) -> None:
    conn.execute(
        "UPDATE notifications SET next_attempt_at = ? WHERE id = ?",
        (next_at.isoformat(), notification_id),
    )
    conn.commit()


def claim_delivery_lock(conn: sqlite3.Connection, notification_id: str) -> bool:
    """Atomic overlap guard. False when already locked."""
    cursor = conn.execute(
        "UPDATE notifications SET locked = 1 WHERE id = ? AND locked = 0", (notification_id,)
    )
    conn.commit()
    return cursor.rowcount == 1


def release_delivery_lock(conn: sqlite3.Connection, notification_id: str) -> None:
    conn.execute("UPDATE notifications SET locked = 0 WHERE id = ?", (notification_id,))
    conn.commit()


def due_deliveries(conn: sqlite3.Connection, now: datetime) -> list[Notification]:
    rows = conn.execute(
        "SELECT * FROM notifications WHERE channel = 'webhook-out' AND status = 'queued'"
        " AND locked = 0 AND next_attempt_at IS NOT NULL AND next_attempt_at <= ?"
        " ORDER BY next_attempt_at, rowid",
        (now.isoformat(),),
    ).fetchall()
    return [_notification_from_row(r) for r in rows]


def list_notifications(conn: sqlite3.Connection, project_id: str) -> list[Notification]:
    rows = conn.execute(
        "SELECT * FROM notifications WHERE project_id = ? ORDER BY rowid", (project_id,)
    ).fetchall()
    return [_notification_from_row(r) for r in rows]


def create_webhook_target(conn: sqlite3.Connection, project_id: str, url: str) -> dict[str, str]:
    if get_project(conn, project_id) is None:
        raise KeyError(f"unknown project {project_id}")
    target_id = new_id("wht")
    created_at = datetime.now(UTC).isoformat()
    conn.execute(
        "INSERT INTO webhook_targets (id, project_id, url, created_at) VALUES (?, ?, ?, ?)",
        (target_id, project_id, url, created_at),
    )
    conn.commit()
    record_event(conn, project_id, "webhook_target", target_id, "webhook_target.added")
    return {"id": target_id, "project_id": project_id, "url": url, "created_at": created_at}


def list_webhook_targets(conn: sqlite3.Connection, project_id: str) -> list[dict[str, str]]:
    rows = conn.execute(
        "SELECT * FROM webhook_targets WHERE project_id = ? ORDER BY rowid", (project_id,)
    ).fetchall()
    return [
        {"id": r["id"], "project_id": r["project_id"], "url": r["url"],
         "created_at": r["created_at"]}
        for r in rows
    ]


def get_webhook_target(conn: sqlite3.Connection, target_id: str) -> dict[str, str] | None:
    row = conn.execute("SELECT * FROM webhook_targets WHERE id = ?", (target_id,)).fetchone()
    if row is None:
        return None
    return {"id": row["id"], "project_id": row["project_id"], "url": row["url"],
            "created_at": row["created_at"]}


def delete_webhook_target(conn: sqlite3.Connection, target_id: str) -> dict[str, str]:
    target = get_webhook_target(conn, target_id)
    if target is None:
        raise KeyError(f"unknown webhook target {target_id}")
    conn.execute("DELETE FROM webhook_targets WHERE id = ?", (target_id,))
    conn.commit()
    record_event(conn, target["project_id"], "webhook_target", target_id,
                 "webhook_target.removed")
    return {"id": target_id, "project_id": target["project_id"]}


# -- Meta ---------------------------------------------------------------------


def meta_get(conn: sqlite3.Connection, key: str, default: str = "") -> str:
    row = conn.execute("SELECT value FROM meta WHERE key = ?", (key,)).fetchone()
    return row["value"] if row else default


def meta_incr(conn: sqlite3.Connection, key: str) -> int:
    current = meta_get(conn, key, "0")
    try:
        value = int(current) + 1
    except ValueError:
        value = 1
    conn.execute(
        "INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = ?",
        (key, str(value), str(value)),
    )
    conn.commit()
    return value
