"""SQLite persistence: schema init + repositories for all domain entities.

Default to SQLite (WAL) for local development; allow PostgreSQL later
behind the same repository surface. All access goes through repositories.
"""

from __future__ import annotations

import contextlib
import hashlib
import json
import os
import sqlite3
import uuid
from collections.abc import Iterator
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

from . import faces as faces_mod
from . import permissions as permissions_mod
from .models import (
    BOARD_MEMBER_ROLES,
    CHAT_ROLES,
    Approval,
    Artifact,
    Board,
    BoardMember,
    BoardMemberRole,
    BoardMessage,
    BoardStatus,
    BotFace,
    ChatMessage,
    ChatThread,
    Decision,
    Delegation,
    DelegationStatus,
    Event,
    Issue,
    KnowledgeChunk,
    KnowledgeSource,
    MemoryEntry,
    MemoryTier,
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
    Team,
    Teammate,
    TeammateStatus,
    TeamMember,
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
  capabilities TEXT NOT NULL DEFAULT '[]', memory_scope TEXT NOT NULL DEFAULT 'teammate',
  permissions TEXT NOT NULL DEFAULT '[]', status TEXT NOT NULL DEFAULT 'active',
  tool_policy TEXT NOT NULL DEFAULT '{}', provider_id TEXT, created_at TEXT NOT NULL DEFAULT '',
  face TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id),
  description TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending',
  owner_teammate_id TEXT, dependencies TEXT NOT NULL DEFAULT '[]', command TEXT NOT NULL DEFAULT '',
  issue_id TEXT, branch TEXT NOT NULL DEFAULT '', workspace_path TEXT NOT NULL DEFAULT '',
  workspace_mode TEXT NOT NULL DEFAULT 'checkout'
);
CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id),
  runtime TEXT NOT NULL DEFAULT 'local', session TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'queued', started_at TEXT NOT NULL,
  finished_at TEXT, exit_code INTEGER, output_excerpt TEXT NOT NULL DEFAULT '',
  command TEXT NOT NULL DEFAULT '', stdout TEXT NOT NULL DEFAULT '',
  stderr TEXT NOT NULL DEFAULT '', duration_s REAL NOT NULL DEFAULT 0.0,
  cancel_requested INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS run_events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'event', content TEXT NOT NULL DEFAULT '',
  timestamp TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_run_events_run ON run_events(run_id, seq);
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
  next_attempt_at TEXT, locked INTEGER NOT NULL DEFAULT 0, locked_at TEXT,
  last_error TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS webhook_targets (
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id),
  url TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY, value TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS chat_threads (
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id),
  title TEXT NOT NULL DEFAULT '', provider_id TEXT, summary TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS chat_messages (
  id TEXT PRIMARY KEY, thread_id TEXT NOT NULL REFERENCES chat_threads(id),
  role TEXT NOT NULL DEFAULT 'user', content TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_chat_messages_thread ON chat_messages(thread_id);
CREATE TABLE IF NOT EXISTS teams (
  id TEXT PRIMARY KEY, owner TEXT NOT NULL, name TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS team_members (
  id TEXT PRIMARY KEY, team_id TEXT NOT NULL REFERENCES teams(id),
  project_id TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL,
  teammate_id TEXT NOT NULL DEFAULT '', UNIQUE(team_id, project_id, teammate_id)
);
CREATE TABLE IF NOT EXISTS delegations (
  id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id),
  from_teammate_id TEXT NOT NULL, to_teammate_id TEXT NOT NULL,
  reason TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'pending',
  depth INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, decided_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_team_members_team ON team_members(team_id);
CREATE INDEX IF NOT EXISTS idx_team_members_project ON team_members(project_id);
CREATE INDEX IF NOT EXISTS idx_delegations_task ON delegations(task_id);
CREATE INDEX IF NOT EXISTS idx_delegations_status ON delegations(status);

CREATE TABLE IF NOT EXISTS boards (
  id TEXT PRIMARY KEY, owner TEXT NOT NULL, name TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '', project_id TEXT NOT NULL DEFAULT '',
  team_id TEXT, status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS board_members (
  id TEXT PRIMARY KEY, board_id TEXT NOT NULL REFERENCES boards(id),
  teammate_id TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'member',
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS board_messages (
  id TEXT PRIMARY KEY, board_id TEXT NOT NULL REFERENCES boards(id),
  to_board_id TEXT, from_teammate_id TEXT,
  content TEXT NOT NULL DEFAULT '', kind TEXT NOT NULL DEFAULT 'message',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_board_members_board ON board_members(board_id);
CREATE INDEX IF NOT EXISTS idx_board_messages_board ON board_messages(board_id);
CREATE INDEX IF NOT EXISTS idx_board_messages_to_board ON board_messages(to_board_id);
"""


def new_id(prefix: str) -> str:
    return f"{prefix}_{uuid.uuid4().hex[:12]}"


def _now_iso() -> str:
    return datetime.now(UTC).isoformat()


TASK_TRANSITIONS: dict[TaskStatus, frozenset[TaskStatus]] = {
    TaskStatus.PENDING: frozenset(
        {TaskStatus.READY, TaskStatus.RUNNING, TaskStatus.BLOCKED, TaskStatus.CANCELLED}
    ),
    TaskStatus.READY: frozenset(
        {TaskStatus.RUNNING, TaskStatus.BLOCKED, TaskStatus.PENDING, TaskStatus.CANCELLED}
    ),
    TaskStatus.RUNNING: frozenset(
        {
            TaskStatus.DONE,
            TaskStatus.FAILED,
            TaskStatus.BLOCKED,
            TaskStatus.PENDING,
            TaskStatus.CANCELLED,
            TaskStatus.AWAITING_APPROVAL,
        }
    ),
    TaskStatus.BLOCKED: frozenset({TaskStatus.PENDING, TaskStatus.CANCELLED}),
    TaskStatus.FAILED: frozenset({TaskStatus.PENDING}),
    TaskStatus.DONE: frozenset({TaskStatus.PENDING}),
    TaskStatus.CANCELLED: frozenset({TaskStatus.PENDING, TaskStatus.RUNNING}),
    # A task waiting on a human decision can go anywhere the work can go:
    # the approval arrives and the run finishes, the owner rejects it, it
    # expires, or the owner cancels it.
    TaskStatus.AWAITING_APPROVAL: frozenset(
        {
            TaskStatus.RUNNING,
            TaskStatus.DONE,
            TaskStatus.FAILED,
            TaskStatus.BLOCKED,
            TaskStatus.PENDING,
            TaskStatus.CANCELLED,
        }
    ),
}

RUN_TRANSITIONS: dict[RunStatus, frozenset[RunStatus]] = {
    RunStatus.QUEUED: frozenset(
        {
            RunStatus.RUNNING,
            RunStatus.BLOCKED,
            RunStatus.FAILED,
            RunStatus.STOPPED,
            RunStatus.CANCELLED,
        }
    ),
    RunStatus.RUNNING: frozenset(
        {
            RunStatus.SUCCEEDED,
            RunStatus.FAILED,
            RunStatus.BLOCKED,
            RunStatus.STOPPED,
            RunStatus.CANCELLED,
            RunStatus.AWAITING_APPROVAL,
        }
    ),
    # A parked run is finished by the owner's decision, or by the expiry of
    # the request. It never resumes mid-flight: the approved action is
    # replayed as its own execution, and that execution ends the run.
    RunStatus.AWAITING_APPROVAL: frozenset(
        {
            RunStatus.SUCCEEDED,
            RunStatus.FAILED,
            RunStatus.BLOCKED,
            RunStatus.CANCELLED,
        }
    ),
    RunStatus.SUCCEEDED: frozenset(),
    RunStatus.FAILED: frozenset(),
    RunStatus.BLOCKED: frozenset(),
    RunStatus.STOPPED: frozenset(),
    RunStatus.CANCELLED: frozenset(),
}

TERMINAL_RUN_STATUSES = frozenset(
    {
        RunStatus.SUCCEEDED,
        RunStatus.FAILED,
        RunStatus.BLOCKED,
        RunStatus.STOPPED,
        RunStatus.CANCELLED,
    }
)
TERMINAL_TASK_STATUSES = frozenset(
    {TaskStatus.DONE, TaskStatus.FAILED, TaskStatus.BLOCKED, TaskStatus.CANCELLED}
)

# A task may be retried a bounded number of times. Without a cap a task that
# keeps failing can be retried forever, burning provider budget in a loop.
MAX_TASK_RETRIES = 10


class InvalidTransitionError(ValueError):
    """A state transition is not allowed by the deterministic state machine."""


class TerminalRunError(InvalidTransitionError):
    """A run in a terminal state was asked to transition again."""


class ApprovalExpiredError(ValueError):
    """An approval was decided after its expiry."""


class ApprovalDecidedError(ValueError):
    """An approval was decided more than once (approvals are one-use)."""


class ApprovalAlreadyResumed(ValueError):
    """A checkpoint is already being carried out, so this caller must not."""


# How long a writer waits for the database lock before giving up. The API,
# the CLI sweeps and the dashboard can all write at once; without this the
# second writer fails immediately with "database is locked".
BUSY_TIMEOUT_MS = 5000


def connect(db_path: str | Path) -> sqlite3.Connection:
    """Open the SQLite database, creating parent dirs and schema.

    ``check_same_thread=False``: FastAPI may run a sync dependency (which
    opens the connection) and the sync endpoint that consumes it in different
    threadpool threads. Each connection is per-request and never shared
    across requests, so cross-thread use of one connection is safe.
    """
    path = Path(db_path)
    if str(path) != ":memory:":
        path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(str(path), check_same_thread=False)
    conn.row_factory = sqlite3.Row
    # The API, the CLI sweeps and the dashboard can all write at once. Without
    # a busy timeout the second writer fails immediately with "database is
    # locked"; with it, the writer waits for the lock instead of erroring.
    conn.execute(f"PRAGMA busy_timeout = {BUSY_TIMEOUT_MS}")
    conn.executescript(SCHEMA)
    _migrate(conn)
    return conn


def _db_path() -> str:
    return os.environ.get("NERDBOT_DB", "nerdbot.db")


def get_conn() -> Iterator[sqlite3.Connection]:
    conn = connect(_db_path())
    try:
        yield conn
    finally:
        conn.close()


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

_PHASE7_COLUMNS: dict[str, list[tuple[str, str]]] = {
    "chat_threads": [("summary", "TEXT NOT NULL DEFAULT ''")],
}

_PHASE8_COLUMNS: dict[str, list[tuple[str, str]]] = {
    "notifications": [("locked_at", "TEXT")],
}

_PHASE9_COLUMNS: dict[str, list[tuple[str, str]]] = {
    "notifications": [("last_error", "TEXT NOT NULL DEFAULT ''")],
}

_PHASE10_COLUMNS: dict[str, list[tuple[str, str]]] = {
    "teammates": [("created_at", "TEXT NOT NULL DEFAULT ''")]
}

_PHASE11_COLUMNS: dict[str, list[tuple[str, str]]] = {
    "tasks": [("board_id", "TEXT NOT NULL DEFAULT ''")],
    "approvals": [("board_id", "TEXT")],
}

_PHASE12_COLUMNS: dict[str, list[tuple[str, str]]] = {
    "tasks": [("parent_task_id", "TEXT NOT NULL DEFAULT ''")],
    "delegations": [
        ("child_task_id", "TEXT NOT NULL DEFAULT ''"),
        ("result", "TEXT NOT NULL DEFAULT ''"),
        ("result_run_id", "TEXT NOT NULL DEFAULT ''"),
        ("finished_at", "TEXT"),
    ],
    "board_messages": [("to_teammate_id", "TEXT")],
    "approvals": [("executed_at", "TEXT")],
}

_PHASE13_COLUMNS: dict[str, list[tuple[str, str]]] = {
    # Gate approvals created outside a run (HTTP acting path) need a direct
    # project link so the owner can find and decide them.
    "approvals": [("project_id", "TEXT NOT NULL DEFAULT ''")],
}

_PHASE14_COLUMNS: dict[str, list[tuple[str, str]]] = {
    # Teams can group bots as well as projects: one membership table, two
    # optional id columns. Legacy rows keep their project_id and gain ''.
    "team_members": [("teammate_id", "TEXT NOT NULL DEFAULT ''")],
}

_PHASE15_COLUMNS: dict[str, list[tuple[str, str]]] = {
    # Agent-driven delegation lifecycle: a deadline the delegator sets, the
    # bounded scope it stated, and how many times the objective was retried.
    "delegations": [
        ("deadline_at", "TEXT"),
        ("scope", "TEXT NOT NULL DEFAULT ''"),
        ("attempts", "INTEGER NOT NULL DEFAULT 0"),
    ],
}

_PHASE16_COLUMNS: dict[str, list[tuple[str, str]]] = {
    # A run can be cancelled while it is in flight. The request is recorded
    # so it survives a restart and so the dashboard can show that a stop was
    # asked for even before the runtime acknowledges it.
    "runs": [("cancel_requested", "INTEGER NOT NULL DEFAULT 0")],
}


_PHASE17_COLUMNS: dict[str, list[tuple[str, str]]] = {
    # A blocked task carries the reason it is blocked, so the UI can say
    # "provider not configured" instead of a bare "blocked".
    "tasks": [("blocked_reason", "TEXT NOT NULL DEFAULT ''")],
}

_PHASE18_COLUMNS: dict[str, list[tuple[str, str]]] = {
    # A bot's face: the body shape, the colour and the resting expression
    # the owner picked when they set the bot up. Empty means "not chosen",
    # which reads back as the default face.
    "teammates": [("face", "TEXT NOT NULL DEFAULT ''")],
}

_PHASE19_COLUMNS: dict[str, list[tuple[str, str]]] = {
    # The exact action an approval is waiting for, so the owner's decision
    # can resume it instead of merely recording it. The three columns carry
    # the whole association: which bot asked (teammate_id), which tool and
    # with which arguments (tool_name, tool_arguments), on top of the
    # action, digest, run and task the row already had.
    "approvals": [
        ("teammate_id", "TEXT NOT NULL DEFAULT ''"),
        ("tool_name", "TEXT NOT NULL DEFAULT ''"),
        ("tool_arguments", "TEXT NOT NULL DEFAULT ''"),
        ("resumed_at", "TEXT"),
        # How the carried-out action ended, written after it ran. Empty means
        # "unknown": the checkpoint was claimed but the record never landed,
        # which is the crash window the recovery has to reason about.
        ("resume_result", "TEXT NOT NULL DEFAULT ''"),
        # The binding of the ACTION, not of the gate payload: a digest over
        # the tool, its canonical arguments, the bot, the run and the task.
        # The gate's own digest is unchanged — it is the request's identity —
        # and this one is what proves the resumed call is the one that was
        # asked for.
        ("tool_digest", "TEXT NOT NULL DEFAULT ''"),
    ],
}

_PHASE21_COLUMNS: dict[str, list[tuple[str, str]]] = {
    # Where a task executes. "checkout" keeps the original isolated per-task
    # Git workspace; "workspace" runs in the project's live root so the owner
    # sees the same files they are editing. Defaulting to checkout preserves
    # every existing task and test.
    "tasks": [("workspace_mode", "TEXT NOT NULL DEFAULT 'checkout'")],
}


_PHASE20_COLUMNS: dict[str, list[tuple[str, str]]] = {
    # Bot persona files (ai-teammates model): a bot's identity, its active
    # objectives, and its accumulated wisdom. These are the durable parts of
    # a bot's persona — they survive runs, and they are what a bot reads at
    # the start of every session so it does not start from zero.
    "teammates": [
        ("soul", "TEXT NOT NULL DEFAULT ''"),
        ("goals", "TEXT NOT NULL DEFAULT ''"),
        ("wisdom", "TEXT NOT NULL DEFAULT ''"),
        ("persona_version", "INTEGER NOT NULL DEFAULT 0"),
    ],
    # Memory tiers: a bot's memory is no longer one flat list. Raw daily
    # logs roll up into typed memories, and typed memories distil into
    # wisdom. The tier column records which tier a row belongs to, so the
    # recall path can scope its search and the compaction path knows what
    # may be rewritten.
    "memories": [("tier", "TEXT NOT NULL DEFAULT 'raw'")],
}


def _migrate(conn: sqlite3.Connection) -> None:
    """Idempotent migrations for databases created by older schemas."""
    # Per-table concat (a plain ** merge would let a later phase's list
    # REPLACE an earlier phase's columns for the same table).
    phases: dict[str, list[tuple[str, str]]] = {}
    for phase in (_PHASE2_COLUMNS, _PHASE3_COLUMNS, _PHASE4_COLUMNS, _PHASE5_COLUMNS,
                  _PHASE6_COLUMNS, _PHASE7_COLUMNS, _PHASE8_COLUMNS, _PHASE9_COLUMNS,
                  _PHASE10_COLUMNS, _PHASE11_COLUMNS, _PHASE12_COLUMNS, _PHASE13_COLUMNS,
                  _PHASE14_COLUMNS, _PHASE15_COLUMNS, _PHASE16_COLUMNS, _PHASE17_COLUMNS,
                  _PHASE18_COLUMNS, _PHASE19_COLUMNS, _PHASE20_COLUMNS,
                  _PHASE21_COLUMNS):
        for table, columns in phase.items():
            phases.setdefault(table, []).extend(columns)
    for table, columns in phases.items():
        existing = {row["name"] for row in conn.execute(f"PRAGMA table_info({table})").fetchall()}
        for name, ddl in columns:
            if name not in existing:
                conn.execute(f"ALTER TABLE {table} ADD COLUMN {name} {ddl}")
    conn.commit()
    _backfill_blocked_reasons(conn)
    _encrypt_legacy_provider_secrets(conn)


def _backfill_blocked_reasons(conn: sqlite3.Connection) -> None:
    """Give tasks that were already blocked a reason.

    The reason was always recorded — on the run that blocked them — but the
    task itself did not carry it. Copy it across so an existing database
    explains itself the same way a new one does.
    """
    rows = conn.execute(
        "SELECT tasks.id, runs.output_excerpt FROM tasks"
        " JOIN runs ON runs.task_id = tasks.id"
        " WHERE tasks.status = 'blocked' AND tasks.blocked_reason = ''"
        " AND runs.output_excerpt <> ''"
        " ORDER BY runs.rowid"
    ).fetchall()
    for row in rows:
        conn.execute(
            "UPDATE tasks SET blocked_reason = ? WHERE id = ?",
            (row["output_excerpt"], row["id"]),
        )
    if rows:
        conn.commit()


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


def _project_from_row(row: sqlite3.Row) -> Project:
    return Project(
        id=row["id"],
        owner=row["owner"],
        repository=row["repository"],
        config=json.loads(row["config"]),
    )


def get_project(conn: sqlite3.Connection, project_id: str) -> Project | None:
    row = conn.execute("SELECT * FROM projects WHERE id = ?", (project_id,)).fetchone()
    if row is None:
        return None
    return _project_from_row(row)


def update_project_config(
    conn: sqlite3.Connection, project_id: str, config: dict[str, Any]
) -> Project:
    """Replace a project's config after validating the project exists.

    Workspace roots live here because the existing projects table already has
    a JSON config and adding a second storage location would split the source
    of truth. Replacement (not merge) keeps callers explicit; the API merges
    before calling when it means to patch.
    """
    project = get_project(conn, project_id)
    if project is None:
        raise KeyError(f"unknown project {project_id}")
    project.config = dict(config)
    conn.execute(
        "UPDATE projects SET config = ? WHERE id = ?",
        (json.dumps(project.config), project_id),
    )
    conn.commit()
    return project


def list_projects(conn: sqlite3.Connection, owner: str | None = None) -> list[Project]:
    if owner is not None:
        rows = conn.execute(
            "SELECT * FROM projects WHERE owner = ? ORDER BY rowid", (owner,)
        ).fetchall()
    else:
        rows = conn.execute("SELECT * FROM projects ORDER BY rowid").fetchall()
    return [_project_from_row(row) for row in rows]


# -- Teammates --------------------------------------------------------------


def create_teammate(
    conn: sqlite3.Connection,
    project_id: str,
    persona: str = "",
    instructions: str = "",
    capabilities: list[str] | None = None,
    memory_scope: str = "project",
    permissions: list[str] | None = None,
    face: dict[str, str] | None = None,
) -> Teammate:
    if get_project(conn, project_id) is None:
        raise KeyError(f"unknown project {project_id}")
    unknown = permissions_mod.unknown_permissions(permissions or [])
    if unknown:
        raise ValueError(f"unknown permission(s): {unknown}")
    mate = Teammate(
        id=new_id("tm"),
        project_id=project_id,
        persona=persona,
        instructions=instructions,
        capabilities=capabilities or [],
        memory_scope=memory_scope,
        permissions=permissions or [],
        face=BotFace(**faces_mod.merge_face(face or {})),
    )
    conn.execute(
        "INSERT INTO teammates (id, project_id, persona, instructions, capabilities,"
        " memory_scope, permissions, face, soul, goals, wisdom, persona_version)"
        " VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        (
            mate.id,
            mate.project_id,
            mate.persona,
            mate.instructions,
            json.dumps(mate.capabilities),
            mate.memory_scope,
            json.dumps(mate.permissions),
            json.dumps(mate.face.model_dump(mode="json")),
            mate.soul,
            mate.goals,
            mate.wisdom,
            mate.persona_version,
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
        face=_face_from_row(row),
        soul=row["soul"] if "soul" in keys else "",
        goals=row["goals"] if "goals" in keys else "",
        wisdom=row["wisdom"] if "wisdom" in keys else "",
        persona_version=int(row["persona_version"]) if "persona_version" in keys and row["persona_version"] else 0,
    )


def _face_from_row(row: sqlite3.Row) -> BotFace:
    """Read a bot's face.

    An empty column means the bot predates the face, or that the owner never
    picked one: either way it reads back as the default face, so the
    dashboard always has a face to draw.
    """
    keys = row.keys()
    raw = row["face"] if "face" in keys else ""
    if not raw:
        return BotFace(**faces_mod.default_face())
    try:
        data = json.loads(raw)
    except (TypeError, ValueError):
        return BotFace(**faces_mod.default_face())
    if not isinstance(data, dict):
        return BotFace(**faces_mod.default_face())
    try:
        return BotFace(**faces_mod.validate_face(data))
    except faces_mod.FaceError:
        # A face the catalogue no longer knows is a face nobody can draw:
        # the default is the honest answer.
        return BotFace(**faces_mod.default_face())


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
    clear_provider: bool = False,
    face: dict[str, str] | None = None,
    soul: str | None = None,
    goals: str | None = None,
    wisdom: str | None = None,
    persona_version: int | None = None,
) -> Teammate:
    """``clear_provider=True`` explicitly detaches the model (PATCH with
    ``provider_id: null``); a param of None alone means "no change"."""
    mate = get_teammate(conn, teammate_id)
    if mate is None:
        raise KeyError(f"unknown teammate {teammate_id}")
    if permissions is not None:
        unknown = permissions_mod.unknown_permissions(permissions)
        if unknown:
            raise ValueError(f"unknown permission(s): {unknown}")
    if tool_policy is not None:
        unknown = permissions_mod.unknown_permissions(tool_policy.keys())
        if unknown:
            raise ValueError(f"unknown permission(s) in tool_policy: {unknown}")
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
    if face is not None:
        mate.face = BotFace(**faces_mod.merge_face(face))
    if soul is not None:
        mate.soul = soul
    if goals is not None:
        mate.goals = goals
    if wisdom is not None:
        mate.wisdom = wisdom
    if persona_version is not None:
        mate.persona_version = persona_version
    if clear_provider:
        mate.provider_id = None
    elif provider_id is not None:
        provider = get_provider(conn, provider_id)
        if provider is None or provider.project_id != mate.project_id:
            raise ValueError("provider must belong to the same project")
        if provider.status != ProviderStatus.ACTIVE:
            raise ValueError(f"provider {provider_id} is not active")
        mate.provider_id = provider_id
    conn.execute(
        "UPDATE teammates SET persona = ?, instructions = ?, capabilities = ?,"
        " memory_scope = ?, permissions = ?, tool_policy = ?, provider_id = ?, face = ?,"
        " soul = ?, goals = ?, wisdom = ?, persona_version = ?"
        " WHERE id = ?",
        (
            mate.persona,
            mate.instructions,
            json.dumps(mate.capabilities),
            mate.memory_scope,
            json.dumps(mate.permissions),
            json.dumps(mate.tool_policy),
            mate.provider_id,
            json.dumps(mate.face.model_dump(mode="json")),
            mate.soul,
            mate.goals,
            mate.wisdom,
            mate.persona_version,
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


# -- Teams --------------------------------------------------------------------


def create_team(
    conn: sqlite3.Connection, owner: str, name: str = "", description: str = ""
) -> Team:
    team_id = new_id("tm_team")
    conn.execute(
        "INSERT INTO teams (id, owner, name, description, created_at)"
        " VALUES (?, ?, ?, ?, ?)",
        (team_id, owner, name, description, _now_iso()),
    )
    conn.commit()
    record_event(conn, "", "team", team_id, "team.created")
    return Team(id=team_id, owner=owner, name=name, description=description)


def list_teams(conn: sqlite3.Connection, owner: str) -> list[Team]:
    rows = conn.execute(
        "SELECT * FROM teams WHERE owner = ? ORDER BY created_at", (owner,)
    ).fetchall()
    return [_team_from_row(r) for r in rows]


def get_team(conn: sqlite3.Connection, team_id: str) -> Team | None:
    row = conn.execute("SELECT * FROM teams WHERE id = ?", (team_id,)).fetchone()
    if row is None:
        return None
    return _team_from_row(row)


def create_team_member(
    conn: sqlite3.Connection, team_id: str, project_id: str
) -> TeamMember:
    """Add a project to a team.

    Retained for backward compatibility. The ``owner`` check is relaxed to
    accept any project the team owner owns; a project may belong to several
    teams of the same owner.
    """
    team = get_team(conn, team_id)
    if team is None:
        raise KeyError(f"unknown team {team_id}")
    project = get_project(conn, project_id)
    if project is None or project.owner != team.owner:
        raise ValueError("project must belong to the team owner")
    member_id = new_id("tm_member")
    conn.execute(
        "INSERT INTO team_members (id, team_id, project_id, teammate_id, created_at)"
        " VALUES (?, ?, ?, '', ?)",
        (member_id, team_id, project_id, _now_iso()),
    )
    conn.commit()
    record_event(conn, project_id, "team_member", member_id, "team_member.created")
    return TeamMember(
        id=member_id, team_id=team_id, project_id=project_id, teammate_id=""
    )


def add_teammate_to_team(
    conn: sqlite3.Connection, team_id: str, teammate_id: str
) -> TeamMember:
    """Add a bot (teammate) to a team.

    The bot must belong to a project owned by the team owner. Idempotent:
    adding the same bot twice returns the existing membership row.
    """
    team = get_team(conn, team_id)
    if team is None:
        raise KeyError(f"unknown team {team_id}")
    mate = get_teammate(conn, teammate_id)
    if mate is None:
        raise ValueError(f"unknown teammate {teammate_id}")
    project = get_project(conn, mate.project_id)
    if project is None or project.owner != team.owner:
        raise ValueError("teammate's project must belong to the team owner")
    existing = conn.execute(
        "SELECT * FROM team_members WHERE team_id = ? AND teammate_id = ?",
        (team_id, teammate_id),
    ).fetchone()
    if existing is not None:
        return _team_member_from_row(existing)
    member_id = new_id("tm_member")
    conn.execute(
        "INSERT INTO team_members (id, team_id, project_id, teammate_id, created_at)"
        " VALUES (?, ?, '', ?, ?)",
        (member_id, team_id, teammate_id, _now_iso()),
    )
    conn.commit()
    record_event(conn, mate.project_id, "team_member", member_id, "team_member.created")
    return TeamMember(
        id=member_id, team_id=team_id, project_id="", teammate_id=teammate_id
    )


def remove_teammate_from_team(
    conn: sqlite3.Connection, team_id: str, teammate_id: str
) -> None:
    conn.execute(
        "DELETE FROM team_members WHERE team_id = ? AND teammate_id = ?",
        (team_id, teammate_id),
    )
    conn.commit()


def list_teammates_for_team(
    conn: sqlite3.Connection, team_id: str
) -> list[Teammate]:
    rows = conn.execute(
        "SELECT t.* FROM teammates t JOIN team_members tm ON tm.teammate_id = t.id"
        " WHERE tm.team_id = ? ORDER BY t.created_at", (team_id,)
    ).fetchall()
    return [_teammate_from_row(r) for r in rows]


def list_teams_for_teammate(
    conn: sqlite3.Connection, teammate_id: str
) -> list[Team]:
    rows = conn.execute(
        "SELECT t.* FROM teams t JOIN team_members tm ON tm.team_id = t.id"
        " WHERE tm.teammate_id = ? ORDER BY t.created_at", (teammate_id,)
    ).fetchall()
    return [_team_from_row(r) for r in rows]


def list_team_members(conn: sqlite3.Connection, team_id: str) -> list[TeamMember]:
    rows = conn.execute(
        "SELECT * FROM team_members WHERE team_id = ? ORDER BY created_at", (team_id,)
    ).fetchall()
    return [_team_member_from_row(r) for r in rows]


def list_projects_for_team(
    conn: sqlite3.Connection, team_id: str
) -> list[Project]:
    rows = conn.execute(
        "SELECT p.* FROM projects p JOIN team_members tm ON tm.project_id = p.id"
        " WHERE tm.team_id = ? AND tm.project_id != '' ORDER BY p.id", (team_id,)
    ).fetchall()
    return [_project_from_row(r) for r in rows]


def list_teams_for_project(
    conn: sqlite3.Connection, project_id: str
) -> list[Team]:
    rows = conn.execute(
        "SELECT t.* FROM teams t JOIN team_members tm ON tm.team_id = t.id"
        " WHERE tm.project_id = ? AND tm.project_id != '' ORDER BY t.created_at", (project_id,)
    ).fetchall()
    return [_team_from_row(r) for r in rows]


def remove_team_member(
    conn: sqlite3.Connection, team_id: str, project_id: str
) -> None:
    conn.execute(
        "DELETE FROM team_members WHERE team_id = ? AND project_id = ?",
        (team_id, project_id),
    )
    conn.commit()


def _team_from_row(row: sqlite3.Row) -> Team:
    return Team(
        id=row["id"], owner=row["owner"], name=row["name"] or "",
        description=row["description"] or "",
        created_at=datetime.fromisoformat(row["created_at"]),
    )


def _team_member_from_row(row: sqlite3.Row) -> TeamMember:
    keys = row.keys()
    return TeamMember(
        id=row["id"], team_id=row["team_id"],
        project_id=row["project_id"] or "",
        teammate_id=(row["teammate_id"] or "") if "teammate_id" in keys else "",
        created_at=datetime.fromisoformat(row["created_at"]),
    )


# -- Tasks ------------------------------------------------------------------


def create_task(
    conn: sqlite3.Connection,
    project_id: str,
    description: str,
    owner_teammate_id: str | None = None,
    dependencies: list[str] | None = None,
    command: str = "",
    issue_id: str | None = None,
    board_id: str = "",
    parent_task_id: str = "",
    workspace_mode: str = "checkout",
) -> Task:
    if get_project(conn, project_id) is None:
        raise KeyError(f"unknown project {project_id}")
    if workspace_mode not in ("checkout", "workspace"):
        raise ValueError("workspace_mode must be 'checkout' or 'workspace'")
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
    if board_id:
        board = get_board(conn, board_id)
        if board is None:
            raise KeyError(f"unknown board {board_id}")
        if board.project_id != project_id:
            raise ValueError("board must belong to the same project")
    if parent_task_id:
        parent = get_task(conn, parent_task_id)
        if parent is None or parent.project_id != project_id:
            raise ValueError("parent task must belong to the same project")
        depth = task_chain_depth(conn, parent_task_id)
        if depth >= MAX_TASK_CHAIN_DEPTH:
            raise ValueError(
                f"delegation depth limit reached (max {MAX_TASK_CHAIN_DEPTH} nested tasks)"
            )
    task = Task(
        id=new_id("tsk"),
        project_id=project_id,
        description=description,
        status=TaskStatus.PENDING,
        owner_teammate_id=owner_teammate_id,
        dependencies=deps,
        command=command,
        issue_id=issue_id,
        board_id=board_id,
        parent_task_id=parent_task_id,
        workspace_mode=workspace_mode,
    )
    conn.execute(
        "INSERT INTO tasks (id, project_id, description, status, owner_teammate_id,"
        " dependencies, command, issue_id, branch, workspace_path, board_id, parent_task_id,"
        " workspace_mode) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
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
            task.board_id,
            task.parent_task_id,
            task.workspace_mode,
        ),
    )
    conn.commit()
    record_event(conn, project_id, "task", task.id, "task.created")
    return task


MAX_TASK_CHAIN_DEPTH = 5


def task_chain_depth(conn: sqlite3.Connection, task_id: str) -> int:
    """Number of ancestors above ``task_id`` (0 for a root task). Cycle-safe."""
    depth = 0
    seen: set[str] = set()
    current = task_id
    while current and current not in seen:
        seen.add(current)
        row = conn.execute(
            "SELECT parent_task_id FROM tasks WHERE id = ?", (current,)
        ).fetchone()
        if row is None or not row["parent_task_id"]:
            break
        depth += 1
        current = row["parent_task_id"]
    return depth


def list_child_tasks(conn: sqlite3.Connection, task_id: str) -> list[Task]:
    rows = conn.execute(
        "SELECT * FROM tasks WHERE parent_task_id = ? ORDER BY rowid", (task_id,)
    ).fetchall()
    return [_task_from_row(r) for r in rows]


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
        workspace_mode=row["workspace_mode"]
        if "workspace_mode" in keys and row["workspace_mode"]
        else "checkout",
        board_id=row["board_id"] if "board_id" in keys else "",
        parent_task_id=row["parent_task_id"] if "parent_task_id" in keys and row["parent_task_id"] else "",
        blocked_reason=row["blocked_reason"] if "blocked_reason" in keys and row["blocked_reason"] else "",
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


def list_pending_unowned_tasks(
    conn: sqlite3.Connection,
) -> list[Task]:
    """All pending tasks with no owner, oldest first — the executor's input."""
    rows = conn.execute(
        "SELECT * FROM tasks WHERE status = ? AND owner_teammate_id IS NULL ORDER BY rowid",
        (TaskStatus.PENDING.value,),
    ).fetchall()
    return [_task_from_row(r) for r in rows]


def requeue_unblocked_tasks(conn: sqlite3.Connection) -> list[Task]:
    """Return dependency-blocked tasks to the executor's queue.

    A task that was blocked *only because its dependencies were not done yet*
    becomes claimable again once those dependencies are done: the BLOCKED →
    PENDING transition is recorded and an audit event notes why. Scope guard:
    only unowned, parent-less tasks are re-queued — a delegation child that
    its delegatee declined stays blocked, and a task an owner holds is never
    taken away from that owner.
    """
    rows = conn.execute(
        "SELECT * FROM tasks WHERE status = ? AND owner_teammate_id IS NULL",
        (TaskStatus.BLOCKED.value,),
    ).fetchall()
    requeued: list[Task] = []
    for row in rows:
        task = _task_from_row(row)
        if task.parent_task_id:
            continue
        if task.dependencies:
            unfinished = [
                dep_id
                for dep_id in task.dependencies
                if (dep := get_task(conn, dep_id)) is None
                or dep.status != TaskStatus.DONE
            ]
            if unfinished:
                continue
        set_task_status(conn, task.id, TaskStatus.PENDING)
        record_event(
            conn, task.project_id, "task", task.id, "task.requeued.dependencies-satisfied"
        )
        refreshed = get_task(conn, task.id)
        if refreshed is not None:
            requeued.append(refreshed)
    return requeued


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


def set_task_status(
    conn: sqlite3.Connection, task_id: str, status: TaskStatus, reason: str = ""
) -> None:
    """Move a task to a new status, recording why it is not progressing.

    ``reason`` is kept only while the task is blocked or waiting on a human
    decision, and is cleared when it leaves those states, so a stale reason
    never lingers on a running task.
    """
    task = get_task(conn, task_id)
    if task is None:
        raise KeyError(f"unknown task {task_id}")
    if status != task.status and status not in TASK_TRANSITIONS[task.status]:
        raise InvalidTransitionError(f"task {task_id}: {task.status.value} -> {status.value}")
    keeps_reason = status in (TaskStatus.BLOCKED, TaskStatus.AWAITING_APPROVAL)
    conn.execute(
        "UPDATE tasks SET status = ?, blocked_reason = ? WHERE id = ?",
        (status.value, reason if keeps_reason else "", task_id),
    )
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


def claim_task(
    conn: sqlite3.Connection, task_id: str, teammate_id: str
) -> Task:
    task = get_task(conn, task_id)
    if task is None:
        raise KeyError(f"unknown task {task_id}")
    if task.status != TaskStatus.PENDING:
        raise ValueError(f"task is {task.status.value}, not pending")
    if task.owner_teammate_id is not None:
        raise ValueError("task already has an owner")
    mate = get_teammate(conn, teammate_id)
    if mate is None or mate.project_id != task.project_id:
        raise ValueError("teammate must belong to the same project")
    if mate.status != TeammateStatus.ACTIVE:
        raise ValueError(f"teammate {teammate_id} is {mate.status.value}, not active")
    conn.execute(
        "UPDATE tasks SET owner_teammate_id = ?, status = ? WHERE id = ?",
        (teammate_id, TaskStatus.READY.value, task_id),
    )
    conn.commit()
    record_event(conn, task.project_id, "task", task_id, "task.claimed")
    task.owner_teammate_id = teammate_id
    task.status = TaskStatus.READY
    return task


def list_all_teammates(conn: sqlite3.Connection) -> list[Teammate]:
    rows = conn.execute("SELECT * FROM teammates ORDER BY created_at").fetchall()
    return [_teammate_from_row(r) for r in rows]


def list_tasks_for_teammate(
    conn: sqlite3.Connection, teammate_id: str
) -> list[Task]:
    rows = conn.execute(
        "SELECT * FROM tasks WHERE owner_teammate_id = ? ORDER BY id",
        (teammate_id,),
    ).fetchall()
    return [_task_from_row(r) for r in rows]


def list_runs_for_teammate(
    conn: sqlite3.Connection, teammate_id: str
) -> list[Run]:
    rows = conn.execute(
        "SELECT r.* FROM runs r JOIN tasks t ON r.task_id = t.id"
        " WHERE t.owner_teammate_id = ? ORDER BY r.started_at DESC",
        (teammate_id,),
    ).fetchall()
    return [_run_from_row(r) for r in rows]


# -- Delegations -------------------------------------------------------------


def create_delegation(
    conn: sqlite3.Connection,
    task_id: str,
    from_teammate_id: str,
    to_teammate_id: str,
    reason: str = "",
    depth: int = 1,
    child_task_id: str = "",
    auto_accept: bool = False,
    deadline_at: datetime | None = None,
    scope: str = "",
    attempts: int = 0,
) -> Delegation:
    task = get_task(conn, task_id)
    if task is None:
        raise KeyError(f"unknown task {task_id}")
    from_mate = get_teammate(conn, from_teammate_id)
    to_mate = get_teammate(conn, to_teammate_id)
    if from_mate is None or from_mate.project_id != task.project_id:
        raise ValueError("from teammate must belong to the same project")
    if to_mate is None or to_mate.project_id != task.project_id:
        raise ValueError("to teammate must belong to the same project")
    if from_mate.status != TeammateStatus.ACTIVE:
        raise ValueError(f"from teammate {from_teammate_id} is not active")
    if to_mate.status != TeammateStatus.ACTIVE:
        raise ValueError(f"to teammate {to_teammate_id} is not active")
    # Bound delegation depth and detect cycles.
    existing = list_delegations_for_task(conn, task_id)
    if depth > 5:
        raise ValueError("delegation depth limit (5) exceeded")
    chain = {d.to_teammate_id for d in existing}
    chain.add(to_teammate_id)
    if from_teammate_id in chain:
        raise ValueError("delegation cycle detected")
    del_id = new_id("del")
    if child_task_id:
        child = get_task(conn, child_task_id)
        if child is None or child.parent_task_id != task_id:
            raise ValueError("child task must reference this task as parent")
    status = DelegationStatus.ACCEPTED if auto_accept else DelegationStatus.PENDING
    conn.execute(
        "INSERT INTO delegations (id, task_id, from_teammate_id, to_teammate_id,"
        " reason, status, depth, created_at, child_task_id, decided_at,"
        " deadline_at, scope, attempts)"
        " VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        (del_id, task_id, from_teammate_id, to_teammate_id, reason,
         status.value, depth, _now_iso(), child_task_id,
         _now_iso() if auto_accept else None,
         deadline_at.isoformat() if deadline_at else None, scope, attempts),
    )
    conn.commit()
    record_event(conn, task.project_id, "delegation", del_id, "delegation.created")
    return Delegation(
        id=del_id, task_id=task_id, from_teammate_id=from_teammate_id,
        to_teammate_id=to_teammate_id, reason=reason, status=status,
        depth=depth, child_task_id=child_task_id,
        decided_at=datetime.now(UTC) if auto_accept else None,
        deadline_at=deadline_at, scope=scope, attempts=attempts,
    )


def list_delegations_for_task(
    conn: sqlite3.Connection, task_id: str
) -> list[Delegation]:
    rows = conn.execute(
        "SELECT * FROM delegations WHERE task_id = ? ORDER BY created_at", (task_id,)
    ).fetchall()
    return [_delegation_from_row(r) for r in rows]


def get_delegation(conn: sqlite3.Connection, delegation_id: str) -> Delegation | None:
    row = conn.execute(
        "SELECT * FROM delegations WHERE id = ?", (delegation_id,)
    ).fetchone()
    if row is None:
        return None
    return _delegation_from_row(row)


def decide_delegation(
    conn: sqlite3.Connection,
    delegation_id: str,
    decision: str,
    reason: str = "",
) -> Delegation:
    """Record the delegatee's decision on a pending delegation.

    ``accepted`` hands the work over; ``declined`` refuses it and blocks the
    child task so no bot picks it up afterwards. A delegation that already
    left the pending state is never re-decided.
    """
    del_ = get_delegation(conn, delegation_id)
    if del_ is None:
        raise KeyError(f"unknown delegation {delegation_id}")
    if del_.status != DelegationStatus.PENDING:
        raise ValueError(f"delegation already {del_.status.value}")
    if decision not in ("accepted", "declined"):
        raise ValueError("decision must be 'accepted' or 'declined'")
    status = DelegationStatus.ACCEPTED if decision == "accepted" else DelegationStatus.DECLINED
    conn.execute(
        "UPDATE delegations SET status = ?, decided_at = ? WHERE id = ?",
        (status.value, _now_iso(), delegation_id),
    )
    conn.commit()
    task = get_task(conn, del_.task_id)
    if status == DelegationStatus.ACCEPTED and task is not None and not del_.child_task_id:
        # Human-facing delegation: reassign the parent task. Agent-driven
        # delegations already created a dedicated child task; the parent stays
        # with the delegator so results can flow back.
        assign_task_owner(conn, del_.task_id, del_.to_teammate_id)
    if status == DelegationStatus.DECLINED and del_.child_task_id:
        # The delegatee refused the work: block the child so no executor picks
        # it up, and record why for the delegator.
        child = get_task(conn, del_.child_task_id)
        if child is not None and child.status in (
            TaskStatus.PENDING, TaskStatus.READY, TaskStatus.RUNNING,
        ):
            set_task_status(conn, child.id, TaskStatus.BLOCKED)
        note = (reason or "").strip()
        if note:
            conn.execute(
                "UPDATE delegations SET reason = ? WHERE id = ?",
                ((del_.reason + f" | declined: {note}").strip(), delegation_id),
            )
            conn.commit()
    record_event(
        conn, task.project_id if task else "", "delegation", delegation_id,
        f"delegation.{decision}",
    )
    del_.status = status
    del_.decided_at = datetime.now(UTC)
    if status == DelegationStatus.DECLINED and reason:
        del_.reason = (del_.reason + f" | declined: {reason}").strip()
    return del_


def list_delegations_to_teammate(
    conn: sqlite3.Connection, teammate_id: str
) -> list[Delegation]:
    """Delegations addressed TO this teammate (work it was handed)."""
    rows = conn.execute(
        "SELECT * FROM delegations WHERE to_teammate_id = ? ORDER BY created_at",
        (teammate_id,),
    ).fetchall()
    return [_delegation_from_row(r) for r in rows]


def list_delegations_for_teammate(
    conn: sqlite3.Connection, teammate_id: str
) -> list[Delegation]:
    """Every delegation this teammate is part of — sent or received.

    The delegation chain view needs both ends: the delegator follows the work
    it handed out, the delegatee follows the work it was handed.
    """
    rows = conn.execute(
        "SELECT * FROM delegations WHERE from_teammate_id = ? OR to_teammate_id = ?"
        " ORDER BY created_at",
        (teammate_id, teammate_id),
    ).fetchall()
    return [_delegation_from_row(r) for r in rows]


def _delegation_from_row(row: sqlite3.Row) -> Delegation:
    keys = row.keys()
    return Delegation(
        id=row["id"], task_id=row["task_id"],
        from_teammate_id=row["from_teammate_id"], to_teammate_id=row["to_teammate_id"],
        reason=row["reason"] or "", status=DelegationStatus(row["status"]),
        depth=row["depth"],
        created_at=datetime.fromisoformat(row["created_at"]),
        decided_at=datetime.fromisoformat(row["decided_at"]) if row["decided_at"] else None,
        child_task_id=row["child_task_id"] if "child_task_id" in keys and row["child_task_id"] else "",
        result=row["result"] if "result" in keys and row["result"] else "",
        result_run_id=row["result_run_id"] if "result_run_id" in keys and row["result_run_id"] else "",
        finished_at=datetime.fromisoformat(row["finished_at"])
        if "finished_at" in keys and row["finished_at"]
        else None,
        deadline_at=datetime.fromisoformat(row["deadline_at"])
        if "deadline_at" in keys and row["deadline_at"]
        else None,
        scope=row["scope"] if "scope" in keys and row["scope"] else "",
        attempts=int(row["attempts"]) if "attempts" in keys and row["attempts"] else 0,
    )


def delegations_by_child_task(
    conn: sqlite3.Connection, child_task_id: str
) -> list[Delegation]:
    """Delegations whose child task is ``child_task_id`` (the response channel)."""
    rows = conn.execute(
        "SELECT * FROM delegations WHERE child_task_id = ? ORDER BY created_at",
        (child_task_id,),
    ).fetchall()
    return [_delegation_from_row(r) for r in rows]


def finalize_delegation_result(
    conn: sqlite3.Connection,
    delegation_id: str,
    result: str,
    result_run_id: str = "",
    failed: bool = False,
) -> Delegation:
    """Write a child task's result back to its delegation (response channel)."""
    del_ = get_delegation(conn, delegation_id)
    if del_ is None:
        raise KeyError(f"unknown delegation {delegation_id}")
    if del_.status in (
        DelegationStatus.COMPLETED,
        DelegationStatus.FAILED,
        DelegationStatus.CANCELLED,
        DelegationStatus.DECLINED,
        DelegationStatus.TIMED_OUT,
    ):
        return del_  # already finalized (idempotent)
    status = DelegationStatus.FAILED if failed else DelegationStatus.COMPLETED
    conn.execute(
        "UPDATE delegations SET status = ?, result = ?, result_run_id = ?,"
        " finished_at = ? WHERE id = ?",
        (status.value, result, result_run_id, _now_iso(), delegation_id),
    )
    conn.commit()
    task = get_task(conn, del_.task_id)
    record_event(
        conn, task.project_id if task else "", "delegation", delegation_id,
        f"delegation.{'failed' if failed else 'completed'}",
    )
    del_.status = status
    del_.result = result
    del_.result_run_id = result_run_id
    del_.finished_at = datetime.now(UTC)
    return del_


def expire_delegation(
    conn: sqlite3.Connection,
    delegation_id: str,
    *,
    reason: str = "",
) -> Delegation:
    """Time out a delegation whose deadline has passed (idempotent).

    A timed-out delegation is terminal and is never reported as a success:
    the child task is blocked so it is not picked up afterwards, and a late
    result cannot overwrite the timeout.
    """
    del_ = get_delegation(conn, delegation_id)
    if del_ is None:
        raise KeyError(f"unknown delegation {delegation_id}")
    if del_.status in (
        DelegationStatus.COMPLETED,
        DelegationStatus.FAILED,
        DelegationStatus.CANCELLED,
        DelegationStatus.DECLINED,
        DelegationStatus.TIMED_OUT,
    ):
        return del_  # already terminal (idempotent)
    note = reason or "deadline passed"
    conn.execute(
        "UPDATE delegations SET status = ?, decided_at = ?, finished_at = ?,"
        " reason = ? WHERE id = ?",
        (
            DelegationStatus.TIMED_OUT.value,
            _now_iso(),
            _now_iso(),
            (del_.reason + f" | timed out: {note}").strip(),
            delegation_id,
        ),
    )
    conn.commit()
    if del_.child_task_id:
        child = get_task(conn, del_.child_task_id)
        if child is not None and child.status in (
            TaskStatus.PENDING, TaskStatus.READY, TaskStatus.RUNNING,
        ):
            set_task_status(conn, child.id, TaskStatus.BLOCKED)
    task = get_task(conn, del_.task_id)
    record_event(
        conn,
        task.project_id if task else "",
        "delegation",
        delegation_id,
        "delegation.timed_out",
    )
    del_.status = DelegationStatus.TIMED_OUT
    del_.decided_at = datetime.now(UTC)
    del_.finished_at = datetime.now(UTC)
    del_.reason = (del_.reason + f" | timed out: {note}").strip()
    return del_


def cancel_delegation(
    conn: sqlite3.Connection,
    delegation_id: str,
    *,
    actor_teammate_id: str = "",
    reason: str = "",
) -> Delegation:
    """Cancel a delegation and stop its child task (idempotent).

    Only the delegator or the delegatee may cancel a delegation. A cancelled
    delegation is terminal: a child task that has not started is blocked so
    the executor never picks it up, and a late result cannot overwrite the
    cancellation.

    Every other terminal outcome (completed, failed, declined, timed out) is
    left exactly as it is: a refusal stays a refusal, a timeout stays a
    timeout, and neither is rewritten into a cancellation.
    """
    del_ = get_delegation(conn, delegation_id)
    if del_ is None:
        raise KeyError(f"unknown delegation {delegation_id}")
    if del_.status in (
        DelegationStatus.COMPLETED,
        DelegationStatus.FAILED,
        DelegationStatus.CANCELLED,
        DelegationStatus.DECLINED,
        DelegationStatus.TIMED_OUT,
    ):
        return del_  # already terminal (idempotent)
    if actor_teammate_id and actor_teammate_id not in (
        del_.from_teammate_id,
        del_.to_teammate_id,
    ):
        raise ValueError(
            "only the delegator or the delegatee may cancel a delegation"
        )
    conn.execute(
        "UPDATE delegations SET status = ?, decided_at = ? WHERE id = ?",
        (DelegationStatus.CANCELLED.value, _now_iso(), delegation_id),
    )
    conn.commit()
    if del_.child_task_id:
        child = get_task(conn, del_.child_task_id)
        if child is not None and child.status in (
            TaskStatus.PENDING, TaskStatus.READY, TaskStatus.RUNNING,
        ):
            set_task_status(conn, child.id, TaskStatus.BLOCKED)
    task = get_task(conn, del_.task_id)
    record_event(
        conn,
        task.project_id if task else "",
        "delegation",
        delegation_id,
        "delegation.cancelled",
    )
    del_.status = DelegationStatus.CANCELLED
    del_.decided_at = datetime.now(UTC)
    del_.reason = (del_.reason + (f" | cancelled: {reason}" if reason else "")).strip()
    return del_


def cancel_task(
    conn: sqlite3.Connection,
    task_id: str,
    *,
    actor_teammate_id: str = "",
    reason: str = "",
) -> Task:
    """Cancel a task: block it and cancel its pending delegations.

    A task that already reached a terminal state (done/failed) is left
    alone — cancellation never rewrites a finished result.
    """
    task = get_task(conn, task_id)
    if task is None:
        raise KeyError(f"unknown task {task_id}")
    if task.status in (TaskStatus.DONE, TaskStatus.FAILED):
        return task
    for delegation in list_delegations_for_task(conn, task_id):
        if delegation.status in (
            DelegationStatus.PENDING,
            DelegationStatus.ACCEPTED,
        ):
            cancel_delegation(
                conn,
                delegation.id,
                actor_teammate_id=actor_teammate_id,
                reason=reason or f"task {task_id} cancelled",
            )
    if task.status in (TaskStatus.PENDING, TaskStatus.READY, TaskStatus.RUNNING):
        set_task_status(
            conn, task_id, TaskStatus.BLOCKED,
            f"delegation {delegation.id} was {reason or 'cancelled'}",
        )
    refreshed = get_task(conn, task_id)
    assert refreshed is not None
    return refreshed


def list_runnable_delegated_tasks(conn: sqlite3.Connection) -> list[tuple[Task, Delegation]]:
    """Pending child tasks owned by an active teammate with a provider, paired
    with the delegation that created them. Executor sweep phase-2.

    Both ``pending`` and ``accepted`` delegations qualify: a ``pending`` one
    is the delegatee's turn to decide (accept or decline), an ``accepted`` one
    is work that is ready to be executed.
    """
    rows = conn.execute(
        """
        SELECT t.id AS task_id, d.id AS delegation_id
        FROM delegations d
        JOIN tasks t ON t.id = d.child_task_id
        JOIN teammates m ON m.id = t.owner_teammate_id
        JOIN providers p ON p.id = m.provider_id
        WHERE d.status IN (?, ?) AND t.status = ? AND m.status = ? AND p.status = ?
        ORDER BY d.created_at
        """,
        (DelegationStatus.ACCEPTED.value, DelegationStatus.PENDING.value,
         TaskStatus.PENDING.value, TeammateStatus.ACTIVE.value,
         ProviderStatus.ACTIVE.value),
    ).fetchall()
    out: list[tuple[Task, Delegation]] = []
    for row in rows:
        task = get_task(conn, row["task_id"])
        delegation = get_delegation(conn, row["delegation_id"])
        if task is not None and delegation is not None:
            out.append((task, delegation))
    return out


# -- Boards --------------------------------------------------------------------


def _board_from_row(row: sqlite3.Row) -> Board:
    keys = row.keys()
    return Board(
        id=row["id"],
        owner=row["owner"],
        name=row["name"] or "",
        description=row["description"] or "",
        project_id=row["project_id"] if "project_id" in keys else "",
        team_id=row["team_id"] if "team_id" in keys else None,
        status=BoardStatus(row["status"] if "status" in keys and row["status"] else "active"),
        created_at=datetime.fromisoformat(row["created_at"]),
    )


def create_board(
    conn: sqlite3.Connection,
    owner: str,
    name: str,
    description: str = "",
    project_id: str = "",
    team_id: str | None = None,
) -> Board:
    if project_id and get_project(conn, project_id) is None:
        raise KeyError(f"unknown project {project_id}")
    if team_id is not None:
        team = get_team(conn, team_id)
        if team is None:
            raise KeyError(f"unknown team {team_id}")
        if project_id and team.owner != owner:
            raise ValueError("team must belong to the board owner")
    board = Board(
        id=new_id("brd"),
        owner=owner,
        name=name or "Unnamed board",
        description=description,
        project_id=project_id,
        team_id=team_id,
    )
    conn.execute(
        "INSERT INTO boards (id, owner, name, description, project_id, team_id, status,"
        " created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        (
            board.id,
            board.owner,
            board.name,
            board.description,
            board.project_id,
            board.team_id,
            board.status.value,
            board.created_at.isoformat(),
        ),
    )
    conn.commit()
    record_event(conn, board.project_id or "", "board", board.id, "board.created")
    return board


def get_board(conn: sqlite3.Connection, board_id: str) -> Board | None:
    row = conn.execute("SELECT * FROM boards WHERE id = ?", (board_id,)).fetchone()
    if row is None:
        return None
    return _board_from_row(row)


def list_boards(
    conn: sqlite3.Connection,
    owner: str | None = None,
    project_id: str | None = None,
) -> list[Board]:
    where = []
    params: list[Any] = []
    if owner is not None:
        where.append("owner = ?")
        params.append(owner)
    if project_id is not None:
        where.append("project_id = ?")
        params.append(project_id)
    sql = "SELECT * FROM boards"
    if where:
        sql += " WHERE " + " AND ".join(where)
    sql += " ORDER BY rowid"
    rows = conn.execute(sql, params).fetchall()
    return [_board_from_row(r) for r in rows]


def update_board(
    conn: sqlite3.Connection,
    board_id: str,
    *,
    name: str | None = None,
    description: str | None = None,
    team_id: str | None = None,
    status: BoardStatus | None = None,
) -> Board:
    board = get_board(conn, board_id)
    if board is None:
        raise KeyError(f"unknown board {board_id}")
    if name is not None:
        board.name = name
    if description is not None:
        board.description = description
    if team_id is not None:
        board.team_id = team_id
    if status is not None:
        board.status = status
    conn.execute(
        "UPDATE boards SET name = ?, description = ?, team_id = ?, status = ? WHERE id = ?",
        (board.name, board.description, board.team_id, board.status.value, board_id),
    )
    conn.commit()
    record_event(conn, board.project_id, "board", board_id, "board.updated")
    return board


def delete_board(conn: sqlite3.Connection, board_id: str) -> Board:
    board = get_board(conn, board_id)
    if board is None:
        raise KeyError(f"unknown board {board_id}")
    conn.execute("DELETE FROM board_members WHERE board_id = ?", (board_id,))
    conn.execute("DELETE FROM board_messages WHERE board_id = ?", (board_id,))
    conn.execute("DELETE FROM boards WHERE id = ?", (board_id,))
    conn.commit()
    record_event(conn, board.project_id, "board", board_id, "board.deleted")
    return board


def create_board_member(
    conn: sqlite3.Connection,
    board_id: str,
    teammate_id: str,
    role: str = BoardMemberRole.MEMBER.value,
) -> BoardMember:
    board = get_board(conn, board_id)
    if board is None:
        raise KeyError(f"unknown board {board_id}")
    mate = get_teammate(conn, teammate_id)
    if mate is None:
        raise KeyError(f"unknown teammate {teammate_id}")
    if mate.project_id != board.project_id:
        raise ValueError("teammate must belong to the board's project")
    if mate.status != TeammateStatus.ACTIVE:
        raise ValueError(f"teammate {teammate_id} is not active")
    if role not in BOARD_MEMBER_ROLES:
        # The dashboard renders the role list from the server, so a role the
        # backend does not know can never be offered — and if one arrives
        # anyway it is rejected instead of stored as dead weight.
        raise ValueError(
            f"role must be one of {', '.join(BOARD_MEMBER_ROLES)}; got {role!r}"
        )
    member = BoardMember(
        id=new_id("brd_mem"),
        board_id=board_id,
        teammate_id=teammate_id,
        role=role,
    )
    conn.execute(
        "INSERT INTO board_members (id, board_id, teammate_id, role, created_at)"
        " VALUES (?, ?, ?, ?, ?)",
        (member.id, member.board_id, member.teammate_id, member.role,
         member.created_at.isoformat()),
    )
    conn.commit()
    record_event(conn, board.project_id, "board_member", member.id, "board_member.created")
    return member


def list_board_members(
    conn: sqlite3.Connection, board_id: str
) -> list[BoardMember]:
    if get_board(conn, board_id) is None:
        raise KeyError(f"unknown board {board_id}")
    rows = conn.execute(
        "SELECT * FROM board_members WHERE board_id = ? ORDER BY rowid", (board_id,)
    ).fetchall()
    return [
        BoardMember(
            id=r["id"], board_id=r["board_id"], teammate_id=r["teammate_id"],
            role=r["role"],
            created_at=datetime.fromisoformat(r["created_at"]),
        )
        for r in rows
    ]


def actor_can_access_board(
    conn: sqlite3.Connection, board_id: str, teammate_id: str
) -> bool:
    """True when ``teammate_id`` may read ``board_id`` (owns it or is a member).

    Single source of truth for bot-side board access, shared by
    ``list_boards_for_actor`` (filtering) and the agent board-read tool
    (enforcement). A board the actor neither owns nor belongs to is invisible:
    both the board row and its messages/members stay out of reach.
    """
    board = get_board(conn, board_id)
    if board is None:
        return False
    if board.owner == teammate_id:
        return True
    return any(
        m.teammate_id == teammate_id for m in list_board_members(conn, board_id)
    )


def remove_board_member(conn: sqlite3.Connection, board_id: str, teammate_id: str) -> None:
    if get_board(conn, board_id) is None:
        raise KeyError(f"unknown board {board_id}")
    conn.execute(
        "DELETE FROM board_members WHERE board_id = ? AND teammate_id = ?",
        (board_id, teammate_id),
    )
    conn.commit()


def _board_message_from_row(row: sqlite3.Row) -> BoardMessage:
    keys = row.keys()
    return BoardMessage(
        id=row["id"],
        board_id=row["board_id"],
        to_board_id=row["to_board_id"],
        from_teammate_id=row["from_teammate_id"],
        to_teammate_id=row["to_teammate_id"]
        if "to_teammate_id" in keys and row["to_teammate_id"]
        else None,
        content=row["content"] or "",
        kind=row["kind"] or "message",
        created_at=datetime.fromisoformat(row["created_at"]),
    )


def create_board_message(
    conn: sqlite3.Connection,
    board_id: str,
    content: str,
    *,
    to_board_id: str | None = None,
    from_teammate_id: str | None = None,
    to_teammate_id: str | None = None,
    kind: str = "message",
) -> BoardMessage:
    board = get_board(conn, board_id)
    if board is None:
        raise KeyError(f"unknown board {board_id}")
    if to_board_id is not None and get_board(conn, to_board_id) is None:
        raise KeyError(f"unknown target board {to_board_id}")
    if from_teammate_id is not None:
        mate = get_teammate(conn, from_teammate_id)
        if mate is None:
            raise KeyError(f"unknown teammate {from_teammate_id}")
    if to_teammate_id is not None:
        mate = get_teammate(conn, to_teammate_id)
        if mate is None:
            raise KeyError(f"unknown teammate {to_teammate_id}")
    message = BoardMessage(
        id=new_id("brd_msg"),
        board_id=board_id,
        to_board_id=to_board_id,
        from_teammate_id=from_teammate_id,
        to_teammate_id=to_teammate_id,
        content=content,
        kind=kind,
    )
    conn.execute(
        "INSERT INTO board_messages (id, board_id, to_board_id, from_teammate_id,"
        " to_teammate_id, content, kind, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        (
            message.id, message.board_id, message.to_board_id,
            message.from_teammate_id, message.to_teammate_id, message.content,
            message.kind, message.created_at.isoformat(),
        ),
    )
    conn.commit()
    record_event(conn, board.project_id, "board_message", message.id, "board_message.created")
    return message


def list_board_messages(
    conn: sqlite3.Connection, board_id: str
) -> list[BoardMessage]:
    if get_board(conn, board_id) is None:
        raise KeyError(f"unknown board {board_id}")
    rows = conn.execute(
        "SELECT * FROM board_messages WHERE board_id = ? ORDER BY rowid", (board_id,)
    ).fetchall()
    return [_board_message_from_row(r) for r in rows]


def list_board_messages_to(
    conn: sqlite3.Connection, to_board_id: str
) -> list[BoardMessage]:
    if get_board(conn, to_board_id) is None:
        raise KeyError(f"unknown board {to_board_id}")
    rows = conn.execute(
        "SELECT * FROM board_messages WHERE to_board_id = ? ORDER BY rowid",
        (to_board_id,),
    ).fetchall()
    return [_board_message_from_row(r) for r in rows]


def list_messages_for_teammate(
    conn: sqlite3.Connection,
    teammate_id: str,
    *,
    board_id: str | None = None,
    limit: int = 50,
) -> list[BoardMessage]:
    """Messages addressed directly to ``teammate_id`` (the agent inbox).

    Restricted to one board when ``board_id`` is given. Returns the newest
    ``limit`` messages, oldest first."""
    if board_id is not None:
        if get_board(conn, board_id) is None:
            raise KeyError(f"unknown board {board_id}")
        rows = conn.execute(
            "SELECT * FROM board_messages WHERE to_teammate_id = ? AND board_id = ?"
            " ORDER BY rowid DESC LIMIT ?",
            (teammate_id, board_id, limit),
        ).fetchall()
    else:
        rows = conn.execute(
            "SELECT * FROM board_messages WHERE to_teammate_id = ?"
            " ORDER BY rowid DESC LIMIT ?",
            (teammate_id, limit),
        ).fetchall()
    return [_board_message_from_row(r) for r in reversed(rows)]


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


def append_run_event(
    conn: sqlite3.Connection, run_id: str, kind: str, content: str
) -> int:
    """Append one durable progress event for a run.

    The provider loop and orchestrator call this while a run is in flight, so
    the dashboard can show what the agent is doing without waiting for the
    final run row to be written. Content is bounded so a model cannot fill the
    database with one tool result.
    """
    text = (content or "").strip()
    if len(text) > 4000:
        text = text[:4000] + "…"
    cursor = conn.execute(
        "INSERT INTO run_events (run_id, kind, content, timestamp) VALUES (?, ?, ?, ?)",
        (run_id, (kind or "event")[:40], text, datetime.now(UTC).isoformat()),
    )
    conn.commit()
    return int(cursor.lastrowid or 0)


def list_run_events(
    conn: sqlite3.Connection, run_id: str, after: int = 0, limit: int = 500
) -> list[dict[str, Any]]:
    rows = conn.execute(
        "SELECT seq, run_id, kind, content, timestamp FROM run_events"
        " WHERE run_id = ? AND seq > ? ORDER BY seq LIMIT ?",
        (run_id, after, max(1, min(limit, 2000))),
    ).fetchall()
    return [dict(row) for row in rows]


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
        cancel_requested=bool(r["cancel_requested"]) if "cancel_requested" in keys else False,
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


def mark_run_awaiting_approval(
    conn: sqlite3.Connection, run_id: str, reason: str
) -> Run:
    """Park a run on a human decision.

    Unlike ``finish_run`` this does NOT stamp ``finished_at``: the run is not
    over, it is waiting, and the owner's answer ends it. The output excerpt
    says what it is waiting for, so the run row explains itself.
    """
    run = get_run(conn, run_id)
    if run is None:
        raise KeyError(f"unknown run {run_id}")
    if run.status in TERMINAL_RUN_STATUSES:
        raise TerminalRunError(f"run {run_id} is already terminal ({run.status.value})")
    if RunStatus.AWAITING_APPROVAL not in RUN_TRANSITIONS[run.status]:
        raise InvalidTransitionError(
            f"run {run_id}: {run.status.value} -> {RunStatus.AWAITING_APPROVAL.value}"
        )
    conn.execute(
        "UPDATE runs SET status = ?, output_excerpt = ? WHERE id = ?",
        (RunStatus.AWAITING_APPROVAL.value, reason[:4000], run_id),
    )
    conn.commit()
    run.status = RunStatus.AWAITING_APPROVAL
    run.output_excerpt = reason[:4000]
    task = get_task(conn, run.task_id)
    if task is not None:
        record_event(
            conn, task.project_id, "run", run_id, "run.status.awaiting_approval"
        )
    return run


def request_run_cancel(conn: sqlite3.Connection, run_id: str) -> Run:
    """Record that the owner asked for this run to stop.

    The request is durable: it is written to the run row before the runtime
    is signalled, so a cancel that arrives while the run is still starting
    (or that the runtime never sees) is still visible afterwards. Recording
    it twice is harmless — the flag is idempotent.
    """
    run = get_run(conn, run_id)
    if run is None:
        raise KeyError(f"unknown run {run_id}")
    if run.status in TERMINAL_RUN_STATUSES:
        raise TerminalRunError(f"run {run_id} is already terminal ({run.status.value})")
    conn.execute("UPDATE runs SET cancel_requested = 1 WHERE id = ?", (run_id,))
    conn.commit()
    task = get_task(conn, run.task_id)
    if task is not None:
        record_event(conn, task.project_id, "run", run_id, "run.cancel.requested")
    refreshed = get_run(conn, run_id)
    assert refreshed is not None
    return refreshed


def run_cancel_requested(conn: sqlite3.Connection, run_id: str) -> bool:
    """True when a cancel was recorded for this run."""
    row = conn.execute(
        "SELECT cancel_requested FROM runs WHERE id = ?", (run_id,)
    ).fetchone()
    if row is None:
        return False
    return bool(row["cancel_requested"])


# -- Memory (fail-closed reads) ----------------------------------------------


def write_memory(
    conn: sqlite3.Connection, scope: str, content: str, source: str, confidence: float = 0.5,
    tier: str = MemoryTier.RAW,
) -> MemoryEntry:
    if not source:
        raise ValueError("memory write requires a provenance source")
    if tier not in (MemoryTier.RAW, MemoryTier.TYPED, MemoryTier.WISDOM):
        raise ValueError(f"unknown memory tier: {tier!r}")
    entry = MemoryEntry(
        id=new_id("mem"), scope=scope, content=content, source=source,
        confidence=confidence, tier=tier,
    )
    conn.execute(
        "INSERT INTO memories (id, scope, content, source, confidence, timestamp, tier)"
        " VALUES (?, ?, ?, ?, ?, ?, ?)",
        (
            entry.id, entry.scope, entry.content, entry.source,
            entry.confidence, entry.timestamp.isoformat(), entry.tier,
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
    return [_memory_from_row(r) for r in rows]


def _memory_from_row(r: sqlite3.Row) -> MemoryEntry:
    keys = r.keys()
    tier = r["tier"] if "tier" in keys and r["tier"] else MemoryTier.RAW
    return MemoryEntry(
        id=r["id"], scope=r["scope"], content=r["content"], source=r["source"],
        confidence=r["confidence"], timestamp=datetime.fromisoformat(r["timestamp"]),
        tier=tier,
    )


def list_memories_by_tier(
    conn: sqlite3.Connection, scope: str, tier: str, limit: int = 50,
) -> list[MemoryEntry]:
    """All memories at one tier for a scope, newest first."""
    try:
        rows = conn.execute(
            "SELECT * FROM memories WHERE scope = ? AND tier = ?"
            " ORDER BY timestamp DESC LIMIT ?",
            (scope, tier, limit),
        ).fetchall()
    except Exception as exc:
        raise MemoryReadError(f"memory recall failed for scope {scope!r}: {exc}") from exc
    return [_memory_from_row(r) for r in rows]


def set_memory_tier(conn: sqlite3.Connection, memory_id: str, tier: str) -> None:
    """Rewrite the tier of a memory row. Used by compaction."""
    if tier not in (MemoryTier.RAW, MemoryTier.TYPED, MemoryTier.WISDOM):
        raise ValueError(f"unknown memory tier: {tier!r}")
    conn.execute(
        "UPDATE memories SET tier = ? WHERE id = ?", (tier, memory_id)
    )
    conn.commit()


def delete_memory(conn: sqlite3.Connection, memory_id: str) -> bool:
    """Delete a memory row. Returns True if a row was deleted."""
    cur = conn.execute("DELETE FROM memories WHERE id = ?", (memory_id,))
    conn.commit()
    return cur.rowcount > 0


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
        project_id=row["project_id"] if "project_id" in keys else "",
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
        executed_at=datetime.fromisoformat(row["executed_at"])
        if "executed_at" in keys and row["executed_at"]
        else None,
        teammate_id=row["teammate_id"] if "teammate_id" in keys else "",
        tool_name=row["tool_name"] if "tool_name" in keys else "",
        tool_arguments=row["tool_arguments"] if "tool_arguments" in keys else "",
        resumed_at=datetime.fromisoformat(row["resumed_at"])
        if "resumed_at" in keys and row["resumed_at"]
        else None,
        resume_result=row["resume_result"] if "resume_result" in keys else "",
        tool_digest=row["tool_digest"] if "tool_digest" in keys else "",
    )


def _approval_project(conn: sqlite3.Connection, run_id: str) -> str | None:
    row = conn.execute(
        "SELECT tasks.project_id FROM runs JOIN tasks ON runs.task_id = tasks.id WHERE runs.id = ?",
        (run_id,),
    ).fetchone()
    return row["project_id"] if row else None


def _approval_project_by_board(conn: sqlite3.Connection, board_id: str) -> str | None:
    row = conn.execute(
        "SELECT project_id FROM boards WHERE id = ?", (board_id,)
    ).fetchone()
    return row["project_id"] if row else None


def approval_project(conn: sqlite3.Connection, approval_id: str) -> str | None:
    """Resolve the owning project of an approval (via its run, board, or
    direct project link)."""
    approval = get_approval(conn, approval_id)
    if approval is None:
        return None
    if approval.run_id:
        project = _approval_project(conn, approval.run_id)
        if project:
            return project
    if approval.board_id:
        return _approval_project_by_board(conn, approval.board_id)
    if approval.project_id:
        return approval.project_id
    return None


def purge_expired_approvals(conn: sqlite3.Connection, project_id: str) -> int:
    """Delete expired, still-undecided approvals for one project.

    Reaches gate approvals (project-linked, no run), board-linked approvals,
    and run-linked approvals of this project's tasks. Decided approvals are
    never removed. Returns the purged count.
    """
    now = datetime.now(UTC).isoformat()
    rows = conn.execute(
        "SELECT DISTINCT approvals.id FROM approvals"
        " LEFT JOIN runs ON approvals.run_id = runs.id"
        " LEFT JOIN tasks ON runs.task_id = tasks.id"
        " LEFT JOIN boards ON approvals.board_id = boards.id"
        " WHERE (tasks.project_id = ? OR boards.project_id = ? OR approvals.project_id = ?)"
        " AND approvals.decision = 'pending'"
        " AND approvals.consumed_at IS NULL"
        " AND approvals.expires_at IS NOT NULL AND approvals.expires_at <= ?",
        (project_id, project_id, project_id, now),
    ).fetchall()
    for row in rows:
        conn.execute("DELETE FROM approvals WHERE id = ?", (row["id"],))
    conn.commit()
    for row in rows:
        record_event(conn, project_id, "approval", row["id"], "approval.purged")
    return len(rows)


DEFAULT_APPROVAL_TTL_S = 600.0

#: How long a decided one-use approval stays usable.
#:
#: The owner's answer is fresh; the request's own deadline is not. Without
#: this, an approval decided one second before it expired would leave no
#: window in which the action could actually be carried out — the decision
#: would be recorded and the work would still not happen.
APPROVAL_RESUME_GRACE_S = 300.0


def request_approval(
    conn: sqlite3.Connection,
    action: str,
    requester: str,
    run_id: str = "",
    board_id: str | None = None,
    ttl_s: float = DEFAULT_APPROVAL_TTL_S,
    task_id: str | None = None,
    digest: str | None = None,
    project_id: str = "",
) -> Approval:
    if run_id and conn.execute("SELECT id FROM runs WHERE id = ?", (run_id,)).fetchone() is None:
        raise KeyError(f"unknown run {run_id}")
    if board_id is not None and conn.execute("SELECT id FROM boards WHERE id = ?", (board_id,)).fetchone() is None:
        raise KeyError(f"unknown board {board_id}")
    now = datetime.now(UTC)
    approval = Approval(
        id=new_id("apr"),
        run_id=run_id,
        board_id=board_id,
        project_id=project_id,
        action=action,
        requester=requester,
        expires_at=now + timedelta(seconds=ttl_s),
        task_id=task_id,
        digest=digest,
    )
    conn.execute(
        "INSERT INTO approvals (id, run_id, board_id, project_id, action, requester, decision,"
        " decided_at, expires_at, consumed_at, task_id, digest)"
        " VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        (
            approval.id,
            approval.run_id,
            approval.board_id,
            approval.project_id,
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
    resolved = approval_project(conn, approval.id)
    if resolved is not None:
        record_event(conn, resolved, "approval", approval.id, "approval.requested")
    return approval


def tool_digest(
    *,
    tool_name: str,
    arguments: str,
    teammate_id: str = "",
    run_id: str = "",
    task_id: str | None = None,
) -> str:
    """The binding of an ACTION, as opposed to the identity of a request.

    The gate's digest covers the gate payload, which is what the owner
    approves *as a permission*. This one covers the call that will actually
    run: the tool, its arguments in canonical form, the bot that asked, and
    the run and task it belongs to.

    Two things fall out of it. The arguments are canonicalised, so
    ``{"a": 1, "b": 2}`` and ``{"b": 2, "a": 1}`` are the same action; and
    the bot is part of it, so one bot's approval cannot carry another bot's
    call.

    It is recorded when the checkpoint is written and checked when the
    action is carried out: a checkpoint whose action no longer matches its
    binding is not performed.
    """
    canonical = json.dumps(
        {
            "tool": tool_name,
            "arguments": _canonical_arguments(arguments),
            "teammate_id": teammate_id,
            "run_id": run_id,
            "task_id": task_id,
        },
        sort_keys=True,
        separators=(",", ":"),
    )
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def _canonical_arguments(arguments: str) -> str:
    """The arguments in a canonical form, so the digest does not depend on
    the order the model happened to write them in."""
    if not arguments:
        return "{}"
    try:
        parsed = json.loads(arguments)
    except ValueError:
        return arguments
    return json.dumps(parsed, sort_keys=True, separators=(",", ":"))


def set_approval_checkpoint(
    conn: sqlite3.Connection,
    approval_id: str,
    teammate_id: str = "",
    tool_name: str = "",
    tool_arguments: str = "",
    run_id: str = "",
    task_id: str = "",
) -> Approval:
    """Record the exact action an approval is waiting for.

    The gate knows the action and its digest; it does not know which tool the
    model asked for, nor with which arguments. The run does, so it writes them
    here — and this is what makes the owner's decision *resumable* instead of
    merely recordable.

    The run and the task are bound here too, when they are not already: a
    gate approval is created without them, and without that binding the
    request cannot be traced back to the work that asked for it.

    The write is idempotent: writing the same checkpoint twice changes
    nothing, which matters because a run can be interrupted and restarted.
    """
    approval = get_approval(conn, approval_id)
    if approval is None:
        raise KeyError(f"unknown approval {approval_id}")
    bound_run = run_id or approval.run_id
    bound_task = task_id or approval.task_id
    conn.execute(
        "UPDATE approvals SET teammate_id = ?, tool_name = ?, tool_arguments = ?,"
        " run_id = ?, task_id = ?, tool_digest = ? WHERE id = ?",
        (
            teammate_id,
            tool_name,
            tool_arguments,
            bound_run,
            bound_task,
            tool_digest(
                tool_name=tool_name,
                arguments=tool_arguments,
                teammate_id=teammate_id,
                run_id=bound_run,
                task_id=bound_task,
            ),
            approval_id,
        ),
    )
    conn.commit()
    approval.teammate_id = teammate_id
    approval.tool_name = tool_name
    approval.tool_arguments = tool_arguments
    approval.run_id = bound_run
    approval.task_id = bound_task
    return approval


def list_approvals_for_task(conn: sqlite3.Connection, task_id: str) -> list[Approval]:
    """Approvals belonging to a task: run-linked (from its runs), directly
    task-linked, or board-linked where the task lives on that board."""
    rows = conn.execute(
        "SELECT DISTINCT approvals.* FROM approvals"
        " LEFT JOIN runs ON approvals.run_id = runs.id"
        " LEFT JOIN tasks ON runs.task_id = tasks.id"
        " WHERE tasks.id = ? OR approvals.task_id = ?"
        " OR (approvals.board_id != '' AND approvals.board_id ="
        " (SELECT board_id FROM tasks WHERE id = ?))"
        " ORDER BY approvals.rowid",
        (task_id, task_id, task_id),
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


def approval_is_pending(approval: Approval, now: datetime | None = None) -> bool:
    """True while the approval still awaits a decision that can actually be given.

    An undecided approval whose ``expires_at`` has passed is dead: deciding it
    raises :class:`ApprovalExpiredError` (HTTP 410). Reporting it as pending
    would offer the owner a decision guaranteed to fail, which is exactly the
    bug this predicate exists to prevent. The dashboard mirrors this rule in
    ``approvalIsPending`` so both sides agree on what "pending" means.
    """
    if approval.decision != Decision.PENDING:
        return False
    if approval.expires_at is None:
        return True
    expires = approval.expires_at
    if expires.tzinfo is None:  # pragma: no cover - stored values are UTC-aware
        expires = expires.replace(tzinfo=UTC)
    return expires > (now or datetime.now(UTC))


def approval_is_expired(approval: Approval, now: datetime | None = None) -> bool:
    """True when an undecided approval has passed its expiry.

    An expired approval is neither pending (it cannot be decided) nor
    resolved (nobody decided it). It is a third thing, and it has to be
    visible: a request that died unanswered is exactly the kind of silence
    that makes a workspace feel stuck.
    """
    if approval.decision != Decision.PENDING:
        return False
    if approval.expires_at is None:
        return False
    expires = approval.expires_at
    if expires.tzinfo is None:  # pragma: no cover - stored values are UTC-aware
        expires = expires.replace(tzinfo=UTC)
    return expires <= (now or datetime.now(UTC))


#: The states an approval can be listed under.
APPROVAL_STATES = ("pending", "expired", "resolved", "all")


def list_approvals_inbox(
    conn: sqlite3.Connection,
    *,
    state: str = "pending",
    project_id: str = "",
    project_ids: list[str] | None = None,
    teammate_id: str = "",
    task_id: str = "",
) -> list[Approval]:
    """The owner's cross-workspace inbox of approvals.

    Every filter is bound as a parameter — the values come from a query
    string, and nothing here is interpolated into SQL.

    ``state`` picks the slice: ``pending`` (decidable now), ``expired`` (dead
    requests nobody answered), ``resolved`` (decided), ``all``.

    ``project_ids`` SCOPES the inbox to the projects the caller owns. The
    scope is the point: an inbox that lists every request on the server
    would hand one owner another's work.

    Deduplication: the gate already reuses a pending row for the same action
    and payload, so two live rows for one digest cannot exist. An expired row
    and a later request for the same action CAN both exist, and the inbox
    shows the newer one, with the older counted as superseded — otherwise
    the owner sees the same action twice and cannot tell which is live.
    """
    if state not in APPROVAL_STATES:
        raise ValueError(f"unknown approval state {state!r}")
    clauses: list[str] = []
    params: list[Any] = []
    now = datetime.now(UTC)
    if state == "pending":
        clauses.append("decision = 'pending'")
        clauses.append("(expires_at IS NULL OR expires_at > ?)")
        params.append(now.isoformat())
    elif state == "expired":
        clauses.append("decision = 'pending'")
        clauses.append("expires_at IS NOT NULL AND expires_at <= ?")
        params.append(now.isoformat())
    elif state == "resolved":
        clauses.append("decision != 'pending'")
    if project_ids is not None:
        if not project_ids:
            # The caller owns nothing: the inbox is empty, and saying so is
            # better than listing everything.
            return []
        marks = ",".join("?" for _ in project_ids)
        clauses.append(
            "(project_id IN (" + marks + ") OR run_id IN ("
            "SELECT r.id FROM runs r JOIN tasks t ON t.id = r.task_id"
            f" WHERE t.project_id IN ({marks})))"
        )
        params.extend(project_ids)
        params.extend(project_ids)
    if project_id:
        # "Reachable from this project": the row names it, or it hangs off a
        # run of one of its tasks.
        clauses.append(
            "(project_id = ? OR run_id IN ("
            "SELECT r.id FROM runs r JOIN tasks t ON t.id = r.task_id"
            " WHERE t.project_id = ?))"
        )
        params.extend([project_id, project_id])
    if teammate_id:
        clauses.append("teammate_id = ?")
        params.append(teammate_id)
    if task_id:
        clauses.append("task_id = ?")
        params.append(task_id)
    where = f"WHERE {' AND '.join(clauses)}" if clauses else ""
    rows = conn.execute(
        f"SELECT * FROM approvals {where} ORDER BY rowid DESC",  # noqa: S608 - bound params
        params,
    ).fetchall()
    approvals = [_approval_from_row(r) for r in rows]
    if state != "all":
        return approvals
    # "all" shows the record; one row per (action, digest), the newest first,
    # so a re-request after an expiry does not appear twice.
    seen: set[tuple[str, str]] = set()
    out: list[Approval] = []
    for approval in approvals:
        key = (approval.action, approval.digest or approval.id)
        if key in seen:
            continue
        seen.add(key)
        out.append(approval)
    return out


def list_approvals_needing_recovery(conn: sqlite3.Connection) -> list[Approval]:
    """The checkpoints a crash left behind.

    Three shapes:

    - **approved, never claimed.** The decision landed and the process died
      before the action was carried out. The action has NOT happened, so it
      is still to be done.
    - **claimed, no result.** The action was claimed, and the process died
      before its outcome was recorded. The action may or may not have run.
      It is never repeated — that is what the claim is for — so the
      recovery closes it rather than trying again.
    - **claimed, performed, run not settled.** The action ran and the
      process died before the run was settled. The checkpoint says so, so
      the recovery settles the run as done.
    """
    rows = conn.execute(
        "SELECT * FROM approvals WHERE run_id != '' AND tool_name != '' AND ("
        " (decision IN ('approved', 'approved_forever') AND resumed_at IS NULL)"
        " OR (resumed_at IS NOT NULL AND resume_result = '')"
        " OR (resumed_at IS NOT NULL AND resume_result LIKE 'performed%')"
        ") ORDER BY rowid"
    ).fetchall()
    return [_approval_from_row(r) for r in rows]


def list_approvals_awaiting_decision(conn: sqlite3.Connection) -> list[Approval]:
    """Every live approval that carries an action waiting to be resumed.

    This is the sweep's input: a request whose time is up must stop holding
    its run, or the run waits for a decision that can no longer be given.
    """
    now = datetime.now(UTC).isoformat()
    rows = conn.execute(
        "SELECT * FROM approvals WHERE decision = 'pending' AND tool_name != ''"
        " AND (expires_at IS NULL OR expires_at <= ?) ORDER BY rowid",
        (now,),
    ).fetchall()
    return [_approval_from_row(r) for r in rows]


def list_run_checkpoints(conn: sqlite3.Connection, run_id: str) -> list[Approval]:
    """The actions a run is waiting on, oldest first.

    A run can ask for more than one privileged action in a turn, and the owner
    sees them as one batch. These are the checkpoints that batch is made of.
    """
    rows = conn.execute(
        "SELECT * FROM approvals WHERE run_id = ? AND tool_name != '' ORDER BY rowid",
        (run_id,),
    ).fetchall()
    return [_approval_from_row(r) for r in rows]


def mark_approval_resumed(conn: sqlite3.Connection, approval_id: str) -> Approval:
    """Claim a checkpoint for carrying out, and record the claim.

    ATOMIC: the write only lands on a row that has not been claimed yet, so
    two workers racing for the same checkpoint cannot both perform it. The
    loser updates zero rows and is told so.

    The claim is written BEFORE the action runs. A crash between here and
    the action means the action is LOST rather than repeated — for a
    privileged action that is the right way round, and the recovery says so
    in as many words.
    """
    resumed_at = _now_iso()
    cursor = conn.execute(
        "UPDATE approvals SET resumed_at = ? WHERE id = ? AND resumed_at IS NULL",
        (resumed_at, approval_id),
    )
    conn.commit()
    approval = get_approval(conn, approval_id)
    if approval is None:  # pragma: no cover - raced deletion
        raise KeyError(f"unknown approval {approval_id}")
    if cursor.rowcount == 0:
        raise ApprovalAlreadyResumed(
            f"approval {approval_id} is already being carried out"
        )
    approval.resumed_at = datetime.fromisoformat(resumed_at)
    return approval


def record_approval_resume_result(
    conn: sqlite3.Connection, approval_id: str, outcome: str, output: str = ""
) -> None:
    """Record how a carried-out action ended.

    Written AFTER the action, so it is the record of what happened rather
    than a claim. The marker comes first, so the recovery can tell "the
    action ran" from "the action was refused", and the output follows it so
    a run settled by the recovery can still say what it did.

    A checkpoint that was claimed but has no result is a checkpoint whose
    action may or may not have run — the recovery treats it as lost, because
    it must not be repeated.
    """
    record = outcome if not output else f"{outcome}\n{output}"
    conn.execute(
        "UPDATE approvals SET resume_result = ? WHERE id = ?", (record[:4000], approval_id)
    )
    conn.commit()


def settle_run_after_resume(
    conn: sqlite3.Connection,
    run_id: str,
    status: RunStatus,
    output_excerpt: str,
    task_id: str = "",
    task_status: TaskStatus | None = None,
    reason: str = "",
) -> bool:
    """Settle a waiting run after a resume. Returns True if this caller won.

    ATOMIC: the write only lands on a run that is still waiting, so two
    workers cannot both settle it, and the loser simply does nothing.
    """
    cursor = conn.execute(
        "UPDATE runs SET status = ?, finished_at = ?, output_excerpt = ?"
        " WHERE id = ? AND status = ?",
        (
            status.value,
            _now_iso(),
            output_excerpt[:4000],
            run_id,
            RunStatus.AWAITING_APPROVAL.value,
        ),
    )
    conn.commit()
    if cursor.rowcount == 0:
        return False
    task = get_task(conn, task_id) if task_id else None
    if task is not None:
        record_event(conn, task.project_id, "run", run_id, f"run.status.{status.value}")
        if task_status is not None:
            # The task's own lifecycle is owned by whoever set it, and two
            # workers finishing the same batch can disagree about where it
            # is. The run's summary is what this call is for; the task keeps
            # the state it has.
            with contextlib.suppress(InvalidTransitionError):
                set_task_status(conn, task.id, task_status, reason)
    return True


def claim_run_for_resume(conn: sqlite3.Connection, run_id: str) -> bool:
    """Take exclusive ownership of a waiting run, or lose the race.

    The compare-and-swap is the whole point: two approvals landing at the
    same moment, or the same approval submitted twice, must not carry the
    actions out twice. Only the writer whose UPDATE changed a row proceeds.
    """
    cursor = conn.execute(
        "UPDATE runs SET status = ? WHERE id = ? AND status = ?",
        (RunStatus.RUNNING.value, run_id, RunStatus.AWAITING_APPROVAL.value),
    )
    conn.commit()
    return cursor.rowcount == 1


def decide_approval(conn: sqlite3.Connection, approval_id: str, decision: Decision) -> Approval:
    """Record a decision on a pending approval.

    The write is ATOMIC: it only lands on a row that is still pending and
    unconsumed. Two requests arriving at the same instant cannot both
    decide — the loser updates zero rows and is told so, rather than
    overwriting the winner's answer.
    """
    approval = get_approval(conn, approval_id)
    if approval is None:
        raise KeyError(f"unknown approval {approval_id}")
    if approval.expires_at is not None and datetime.now(UTC) > approval.expires_at:
        raise ApprovalExpiredError(f"approval {approval_id} expired at {approval.expires_at}")
    decided_at = _now_iso()
    forever = decision == Decision.APPROVED_FOREVER
    # A decided one-use approval keeps a fresh window: the owner's answer is
    # what starts the clock, not the moment the request was made.
    expires_at = (
        None
        if forever
        else (datetime.now(UTC) + timedelta(seconds=APPROVAL_RESUME_GRACE_S)).isoformat()
    )
    cursor = conn.execute(
        "UPDATE approvals SET decision = ?, decided_at = ?, consumed_at = ?, expires_at = ?"
        " WHERE id = ? AND decision = 'pending' AND consumed_at IS NULL",
        (
            decision.value,
            decided_at,
            None if forever else decided_at,
            expires_at,
            approval_id,
        ),
    )
    conn.commit()
    if cursor.rowcount == 0:
        # Somebody else decided it between the read and the write.
        current = get_approval(conn, approval_id)
        if current is None:  # pragma: no cover - raced deletion
            raise KeyError(f"unknown approval {approval_id}")
        if current.decision == decision:
            # The same answer twice is the same answer: the caller gets the
            # state, and the work is not performed again.
            return current
        raise ApprovalDecidedError(
            f"approval {approval_id} already decided ({current.decision.value})"
        )
    project_id = approval_project(conn, approval_id)
    if project_id is not None:
        record_event(
            conn,
            project_id,
            "approval",
            approval_id,
            f"approval.{decision.value}",
        )
    approval.decision = decision
    approval.decided_at = datetime.fromisoformat(decided_at)
    approval.consumed_at = None if forever else datetime.fromisoformat(decided_at)
    approval.expires_at = None if forever else approval.expires_at
    return approval


def list_approvals_for_project(
    conn: sqlite3.Connection, project_id: str
) -> list[Approval]:
    """Every approval reachable from a project: via runs-of-tasks, via boards,
    or via the direct project link (gate approvals outside a run)."""
    rows = conn.execute(
        "SELECT DISTINCT approvals.* FROM approvals"
        " LEFT JOIN runs ON approvals.run_id = runs.id"
        " LEFT JOIN tasks ON runs.task_id = tasks.id"
        " LEFT JOIN boards ON approvals.board_id = boards.id"
        " WHERE tasks.project_id = ? OR boards.project_id = ?"
        " OR approvals.project_id = ?"
        " ORDER BY approvals.rowid",
        (project_id, project_id, project_id),
    ).fetchall()
    return [_approval_from_row(r) for r in rows]


def find_approved_action(
    conn: sqlite3.Connection, action: str, digest: str
) -> Approval | None:
    """An approved, unexecuted, unexpired approval for an exact action digest.

    One-use is bound at execution time (``executed_at``): deciding marks the
    approval decided (``consumed_at``), the gate consumes it exactly once when
    the action actually runs."""
    now = datetime.now(UTC).isoformat()
    rows = conn.execute(
        "SELECT * FROM approvals WHERE action = ? AND digest = ? AND decision IN ('approved', 'approved_forever')"
        " AND executed_at IS NULL AND (expires_at IS NULL OR expires_at > ?)"
        " ORDER BY rowid DESC",
        (action, digest, now),
    ).fetchall()
    return _approval_from_row(rows[0]) if rows else None


def mark_approval_executed(
    conn: sqlite3.Connection, approval_id: str, run_id: str = ""
) -> Approval:
    """Mark an approved action as executed (binds it to the run that used it).

    Forever approvals are not consumed: they remain available for reuse.
    """
    approval = get_approval(conn, approval_id)
    if approval is None:
        raise KeyError(f"unknown approval {approval_id}")
    if approval.decision not in (Decision.APPROVED, Decision.APPROVED_FOREVER):
        raise ApprovalDecidedError(f"approval {approval_id} is not approved")
    if approval.decision == Decision.APPROVED_FOREVER:
        return approval
    conn.execute(
        "UPDATE approvals SET executed_at = ?, run_id = COALESCE(NULLIF(?, ''), run_id)"
        " WHERE id = ?",
        (_now_iso(), run_id, approval_id),
    )
    conn.commit()
    approval.executed_at = datetime.now(UTC)
    if run_id:
        approval.run_id = run_id
    return approval


def set_task_board(conn: sqlite3.Connection, task_id: str, board_id: str) -> Task:
    if get_task(conn, task_id) is None:
        raise KeyError(f"unknown task {task_id}")
    if board_id and get_board(conn, board_id) is None:
        raise KeyError(f"unknown board {board_id}")
    conn.execute("UPDATE tasks SET board_id = ? WHERE id = ?", (board_id, task_id))
    conn.commit()
    task = get_task(conn, task_id)
    assert task is not None
    return task


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
    secrets are present but no runtime key is configured. Secret-shaped keys
    holding non-string values are refused (never stored in the clear), as are
    values that look like mask sentinels (a client round-tripping a
    fingerprint instead of a real key)."""
    from . import secrets as secrets_mod

    stored: dict[str, Any] = {}
    for key, value in config.items():
        if secrets_mod.is_secret_key(key) and value is not None:
            if not isinstance(value, str):
                raise ValueError(
                    f"secret config key {key!r} must be a string"
                    f" (got {type(value).__name__}); refusing to store it in the clear"
                )
            if not value:
                continue  # empty means "not set"
            if value.startswith("****") or (value.startswith("[") and value.endswith("]")):
                raise ValueError(
                    f"config {key!r} looks like a redaction/fingerprint, not a key:"
                    " send the full new key or omit the field to keep the current one"
                )
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


def update_provider(
    conn: sqlite3.Connection,
    provider_id: str,
    *,
    name: str | None = None,
    config: dict[str, Any] | None = None,
    status: ProviderStatus | None = None,
) -> Provider:
    """Partial provider update (BYOK slice S1). ``config`` merges onto the
    stored config, then the merged dict passes through
    ``encrypt_provider_config``: plaintext secret values are failed closed
    without a runtime key (mask-looking values and non-string secrets are
    refused outright), ciphertext envelopes are verified, plain keys
    (base_url, model, api_key_env) pass through untouched. Already-encrypted
    envelopes are VERIFIED but not re-encrypted under the current key; key-version
    rotation is handled at decrypt time via NERDBOT_SECRET_KEY_PREVIOUS."""
    current = get_provider(conn, provider_id)
    if current is None:
        raise KeyError(f"unknown provider {provider_id}")
    new_name = current.name if name is None else name
    new_status = current.status if status is None else status
    if config is None:
        stored_config = current.config
    else:
        merged = dict(current.config)
        merged.update(config)
        stored_config = encrypt_provider_config(merged)
    conn.execute(
        "UPDATE providers SET name = ?, config = ?, status = ? WHERE id = ?",
        (new_name, json.dumps(stored_config), new_status.value, provider_id),
    )
    conn.commit()
    record_event(
        conn, current.project_id, "provider", provider_id, "provider.updated"
    )
    updated = get_provider(conn, provider_id)
    assert updated is not None
    return updated


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
        locked_at=datetime.fromisoformat(r["locked_at"])
        if "locked_at" in keys and r["locked_at"]
        else None,
        last_error=r["last_error"] if "last_error" in keys and r["last_error"] else "",
        created_at=datetime.fromisoformat(r["created_at"]),
    )


def get_notification(conn: sqlite3.Connection, notification_id: str) -> Notification | None:
    row = conn.execute("SELECT * FROM notifications WHERE id = ?", (notification_id,)).fetchone()
    if row is None:
        return None
    return _notification_from_row(row)


def set_notification_delivery(
    conn: sqlite3.Connection,
    notification_id: str,
    status: str,
    attempts: int,
    last_error: str | None = None,
) -> None:
    """Update delivery state. ``last_error``:

    - ``None`` — leave the stored error untouched;
    - ``""`` — clear it (delivered successfully);
    - text — record/replace the failure reason for diagnostics.
    """
    conn.execute(
        "UPDATE notifications SET status = :status, attempts = :attempts,"
        " last_error = CASE WHEN :err IS NULL THEN last_error ELSE :err END"
        " WHERE id = :id",
        {"status": status, "attempts": attempts, "err": last_error, "id": notification_id},
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


def claim_delivery_lock(
    conn: sqlite3.Connection, notification_id: str, now: datetime | None = None
) -> bool:
    """Atomic overlap guard. False when already locked.

    Stamps ``locked_at`` (lease start) so a crashed worker's lock can
    later be reclaimed by lease expiry instead of sticking forever.
    """
    moment = (now or datetime.now(UTC)).isoformat()
    cursor = conn.execute(
        "UPDATE notifications SET locked = 1, locked_at = ? WHERE id = ? AND locked = 0",
        (moment, notification_id),
    )
    conn.commit()
    return cursor.rowcount == 1


def release_delivery_lock(
    conn: sqlite3.Connection, notification_id: str, locked_at: datetime | None = None
) -> None:
    """Clear the delivery lock.

    With ``locked_at`` given, this is a lease compare-and-set: the lock is
    cleared only when it still carries that exact claim stamp. A stale
    worker finishing late can therefore never release a newer claimant's
    lease. The manual/unlock path omits the stamp by design. The CAS keeps
    at-least-once semantics; receivers dedupe on the idempotency key.
    """
    if locked_at is None:
        conn.execute(
            "UPDATE notifications SET locked = 0, locked_at = NULL WHERE id = ?",
            (notification_id,),
        )
    else:
        conn.execute(
            "UPDATE notifications SET locked = 0, locked_at = NULL"
            " WHERE id = ? AND locked_at = ?",
            (notification_id, locked_at.isoformat()),
        )
    conn.commit()


def stale_locked_deliveries(
    conn: sqlite3.Connection, cutoff: datetime
) -> list[Notification]:
    """Locked ``sending`` webhook rows whose lease started before cutoff.

    These are abandoned claims: the claiming process died mid-send and its
    ``finally`` release never ran. Rows claimed before the lease upgrade
    (``locked_at IS NULL``) are treated as already expired, and the
    claim-but-not-yet-sending window is included so no lock can stick.
    """
    rows = conn.execute(
        "SELECT * FROM notifications WHERE channel = 'webhook-out' AND locked = 1"
        " AND status IN ('sending', 'queued')"
        " AND (locked_at IS NULL OR locked_at <= ?)"
        " ORDER BY locked_at, rowid",
        (cutoff.isoformat(),),
    ).fetchall()
    return [_notification_from_row(r) for r in rows]


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


# -- Chat threads and messages --------------------------------------------------


HISTORY_PAGE_MAX = 100


def _thread_from_row(row: sqlite3.Row) -> ChatThread:
    keys = row.keys()
    return ChatThread(
        id=row["id"],
        project_id=row["project_id"],
        title=row["title"] or "",
        provider_id=row["provider_id"],
        summary=row["summary"] if "summary" in keys and row["summary"] else "",
        created_at=datetime.fromisoformat(row["created_at"]),
    )


def _message_from_row(row: sqlite3.Row) -> ChatMessage:
    return ChatMessage(
        id=row["id"],
        thread_id=row["thread_id"],
        role=row["role"] or "user",
        content=row["content"] or "",
        created_at=datetime.fromisoformat(row["created_at"]),
    )


def create_thread(
    conn: sqlite3.Connection, project_id: str, title: str = "",
    provider_id: str | None = None,
) -> ChatThread:
    if get_project(conn, project_id) is None:
        raise KeyError(f"unknown project {project_id}")
    if provider_id is not None:
        provider = get_provider(conn, provider_id)
        if provider is None or provider.project_id != project_id:
            raise ValueError("provider must belong to the same project")
    thread = ChatThread(id=new_id("thr"), project_id=project_id, title=title,
                        provider_id=provider_id)
    conn.execute(
        "INSERT INTO chat_threads (id, project_id, title, provider_id, created_at)"
        " VALUES (?, ?, ?, ?, ?)",
        (thread.id, thread.project_id, thread.title, thread.provider_id,
         thread.created_at.isoformat()),
    )
    conn.commit()
    record_event(conn, project_id, "thread", thread.id, "thread.created")
    return thread


def get_thread(conn: sqlite3.Connection, thread_id: str) -> ChatThread | None:
    row = conn.execute("SELECT * FROM chat_threads WHERE id = ?", (thread_id,)).fetchone()
    if row is None:
        return None
    return _thread_from_row(row)


def list_threads(conn: sqlite3.Connection, project_id: str) -> list[ChatThread]:
    rows = conn.execute(
        "SELECT * FROM chat_threads WHERE project_id = ? ORDER BY rowid", (project_id,)
    ).fetchall()
    return [_thread_from_row(r) for r in rows]


def list_threads_for_owner(
    conn: sqlite3.Connection, owner: str, limit: int = 20
) -> list[ChatThread]:
    """Recent conversations across every project the owner owns.

    The Command Center is a cross-workspace surface: a conversation started
    in one project must still be reachable from it. Ordered newest first, so
    the list is a resume list rather than a project-scoped index.
    """
    rows = conn.execute(
        "SELECT chat_threads.* FROM chat_threads"
        " JOIN projects ON chat_threads.project_id = projects.id"
        " WHERE projects.owner = ?"
        " ORDER BY chat_threads.created_at DESC, chat_threads.rowid DESC"
        " LIMIT ?",
        (owner, limit),
    ).fetchall()
    return [_thread_from_row(r) for r in rows]


def set_thread_provider(
    conn: sqlite3.Connection, thread_id: str, provider_id: str | None
) -> ChatThread:
    thread = get_thread(conn, thread_id)
    if thread is None:
        raise KeyError(f"unknown thread {thread_id}")
    if provider_id is not None:
        provider = get_provider(conn, provider_id)
        if provider is None or provider.project_id != thread.project_id:
            raise ValueError("provider must belong to the same project")
        if provider.status != ProviderStatus.ACTIVE:
            raise ValueError(f"provider {provider_id} is not active")
    conn.execute("UPDATE chat_threads SET provider_id = ? WHERE id = ?",
                 (provider_id, thread_id))
    conn.commit()
    thread.provider_id = provider_id
    record_event(conn, thread.project_id, "thread", thread_id, "thread.provider_switched")
    return thread


def set_thread_summary(conn: sqlite3.Connection, thread_id: str, summary: str) -> ChatThread:
    thread = get_thread(conn, thread_id)
    if thread is None:
        raise KeyError(f"unknown thread {thread_id}")
    conn.execute("UPDATE chat_threads SET summary = ? WHERE id = ?", (summary, thread_id))
    conn.commit()
    thread.summary = summary
    record_event(conn, thread.project_id, "thread", thread_id, "thread.summarized")
    return thread


def list_thread_summaries(
    conn: sqlite3.Connection, project_id: str, exclude_id: str = "", limit: int = 3
) -> list[ChatThread]:
    rows = conn.execute(
        "SELECT * FROM chat_threads WHERE project_id = ? AND id != ? AND summary != ''"
        " ORDER BY rowid DESC LIMIT ?",
        (project_id, exclude_id, limit),
    ).fetchall()
    return [_thread_from_row(r) for r in rows]


def append_message(conn: sqlite3.Connection, thread_id: str, role: str, content: str) -> ChatMessage:
    thread = get_thread(conn, thread_id)
    if thread is None:
        raise KeyError(f"unknown thread {thread_id}")
    if role not in CHAT_ROLES:
        raise ValueError(f"invalid role {role!r}")
    if not content.strip():
        raise ValueError("message content is required")
    message = ChatMessage(id=new_id("msg"), thread_id=thread_id, role=role, content=content)
    conn.execute(
        "INSERT INTO chat_messages (id, thread_id, role, content, created_at)"
        " VALUES (?, ?, ?, ?, ?)",
        (message.id, message.thread_id, message.role, message.content,
         message.created_at.isoformat()),
    )
    conn.commit()
    return message


def list_messages(
    conn: sqlite3.Connection, thread_id: str, limit: int = 50, before_id: str | None = None
) -> list[ChatMessage]:
    """Newest-page-first? No — oldest-first window: returns up to ``limit``
    messages ending before ``before_id`` (or the latest), capped at 100."""
    if get_thread(conn, thread_id) is None:
        raise KeyError(f"unknown thread {thread_id}")
    capped = max(1, min(limit, HISTORY_PAGE_MAX))
    if before_id is not None:
        anchor = conn.execute("SELECT rowid FROM chat_messages WHERE id = ?",
                              (before_id,)).fetchone()
        if anchor is None:
            raise KeyError(f"unknown message {before_id}")
        rows = conn.execute(
            "SELECT * FROM chat_messages WHERE thread_id = ? AND rowid < ?"
            " ORDER BY rowid DESC LIMIT ?",
            (thread_id, anchor["rowid"], capped),
        ).fetchall()
        rows = list(reversed(rows))
    else:
        rows = conn.execute(
            "SELECT * FROM chat_messages WHERE thread_id = ?"
            " ORDER BY rowid DESC LIMIT ?",
            (thread_id, capped),
        ).fetchall()
        rows = list(reversed(rows))
    return [_message_from_row(r) for r in rows]
