"""Versioned backup manifests: metadata export with secret redaction.

The manifest contains every domain row needed for reconstruction plus
workspace refs (task branch/path). Provider configs are redacted.
Restore is a validated-manifest + API-replay procedure (see
docs/backup-restore.md): this module validates manifests but performs no
blind row import.
"""

from __future__ import annotations

import sqlite3
from datetime import UTC, datetime
from typing import Any

from . import secrets as secrets_mod
from . import store

BACKUP_VERSION = 1

EXPORT_TABLES = (
    "projects",
    "teammates",
    "tasks",
    "runs",
    "memories",
    "artifacts",
    "approvals",
    "issues",
    "reviews",
    "pr_packages",
    "providers",
    "knowledge_sources",
    "knowledge_chunks",
    "schedules",
    "notifications",
    "events",
)

def redact_provider_config(config: dict[str, Any]) -> dict[str, Any]:
    return {
        key: ("[redacted]" if secrets_mod.is_secret_key(key) else value)
        for key, value in config.items()
    }


def build_manifest(conn: sqlite3.Connection, project_id: str) -> dict[str, Any]:
    project = store.get_project(conn, project_id)
    if project is None:
        raise KeyError(f"unknown project {project_id}")
    tables: dict[str, list[dict[str, Any]]] = {}
    for table in EXPORT_TABLES:
        if table in (
            "tasks",
            "runs",
            "teammates",
            "providers",
            "issues",
            "schedules",
            "notifications",
            "knowledge_sources",
            "events",
        ):
            if table == "runs":
                rows = conn.execute(
                    "SELECT runs.* FROM runs JOIN tasks ON runs.task_id = tasks.id"
                    " WHERE tasks.project_id = ?",
                    (project_id,),
                ).fetchall()
            else:
                rows = conn.execute(
                    f"SELECT * FROM {table} WHERE project_id = ?", (project_id,)
                ).fetchall()
        elif table == "memories":
            # Memories are scope-keyed; only the project scope is attributable.
            rows = conn.execute(
                "SELECT * FROM memories WHERE scope = ?", (f"project:{project_id}",)
            ).fetchall()
        elif table == "knowledge_chunks":
            rows = conn.execute(
                "SELECT * FROM knowledge_chunks WHERE project_id = ?", (project_id,)
            ).fetchall()
        elif table == "approvals":
            rows = conn.execute(
                "SELECT approvals.* FROM approvals JOIN runs ON approvals.run_id = runs.id"
                " JOIN tasks ON runs.task_id = tasks.id WHERE tasks.project_id = ?",
                (project_id,),
            ).fetchall()
        elif table == "projects":
            rows = conn.execute("SELECT * FROM projects WHERE id = ?", (project_id,)).fetchall()
        else:
            rows = conn.execute(
                f"SELECT * FROM {table} WHERE task_id IN"
                " (SELECT id FROM tasks WHERE project_id = ?)",
                (project_id,),
            ).fetchall()
        tables[table] = [dict(row) for row in rows]
    for row in tables["providers"]:
        try:
            import json as _json

            row["config"] = redact_provider_config(_json.loads(row.get("config") or "{}"))
        except ValueError:
            row["config"] = "[unparseable]"
    workspaces = [
        {"task_id": t.id, "branch": t.branch, "path": t.workspace_path}
        for t in store.list_tasks_for_project(conn, project_id)
        if t.workspace_path
    ]
    return {
        "version": BACKUP_VERSION,
        "exported_at": datetime.now(UTC).isoformat(),
        "project_id": project_id,
        "tables": tables,
        "workspaces": workspaces,
    }


def validate_manifest(manifest: dict[str, Any]) -> list[str]:
    """Structural validation only. Returns a list of errors (empty = valid)."""
    errors: list[str] = []
    if not isinstance(manifest, dict):
        return ["manifest must be an object"]
    version = manifest.get("version")
    if version != BACKUP_VERSION:
        errors.append(f"unsupported version {version!r}; expected {BACKUP_VERSION}")
    for key in ("project_id", "tables", "workspaces", "exported_at"):
        if key not in manifest:
            errors.append(f"missing key {key!r}")
    tables = manifest.get("tables")
    if isinstance(tables, dict):
        for table in EXPORT_TABLES:
            if table not in tables:
                errors.append(f"missing table {table!r}")
            elif not isinstance(tables[table], list):
                errors.append(f"table {table!r} must be a list")
    else:
        errors.append("tables must be an object")
    for row in manifest.get("tables", {}).get("providers", []) or []:
        config = row.get("config", {}) if isinstance(row, dict) else {}
        if isinstance(config, dict):
            for key, value in config.items():
                if secrets_mod.is_secret_key(key) and value != "[redacted]":
                    errors.append(f"provider {row.get('id')}: secret {key!r} not redacted")
    return errors
    return errors


HISTORY_TABLES = frozenset(
    {"runs", "artifacts", "reviews", "pr_packages", "approvals", "events"}
)

_JSON_COLUMNS: dict[str, frozenset[str]] = {
    "teammates": frozenset({"capabilities", "permissions", "tool_policy"}),
    "tasks": frozenset({"dependencies"}),
    "memories": frozenset(),
    "issues": frozenset({"acceptance_criteria", "labels"}),
    "knowledge_sources": frozenset(),
    "knowledge_chunks": frozenset(),
    "schedules": frozenset({"task_template"}),
    "notifications": frozenset({"payload"}),
    "providers": frozenset({"config", "capabilities"}),
    "projects": frozenset({"config"}),
}


def _coerce_row(table: str, row: dict[str, Any]) -> dict[str, Any] | None:
    """Parse JSON-encoded columns back to values. None when unparseable."""
    import json as _json

    coerced = dict(row)
    for key in _JSON_COLUMNS.get(table, frozenset()):
        value = coerced.get(key)
        if isinstance(value, str):
            try:
                coerced[key] = _json.loads(value) if value else (
                    [] if key in {"capabilities", "permissions", "dependencies",
                                  "acceptance_criteria", "labels"} else {}
                )
            except ValueError:
                return None
    return coerced


def _to_db(table: str, key: str, value: object) -> object:
    """Serialize model values back to storage form for direct row inserts."""
    import json as _json

    if key in _JSON_COLUMNS.get(table, frozenset()) and not isinstance(value, str):
        return _json.dumps(value)
    if isinstance(value, bool):
        return 1 if value else 0
    return value


def import_manifest(
    conn: sqlite3.Connection, project_id: str, manifest: dict[str, Any], dry_run: bool = False
) -> dict[str, Any]:
    """Import a validated manifest into an existing project.

    Never replays execution history (runs, artifacts, reviews, packages,
    approvals, events are skipped with reasons). Provider secrets are never
    restored: provider rows import with empty config and each dropped secret
    is counted. Every other row is validated through its domain model and
    foreign-key checks; failures are rejected with reasons, never imported.
    Nothing is written when ``dry_run`` is true.
    """
    from pydantic import ValidationError

    from . import schedules as schedules_mod
    from .models import (
        Issue,
        KnowledgeChunk,
        KnowledgeSource,
        MemoryEntry,
        Notification,
        Provider,
        ProviderKind,
        Schedule,
        Task,
        TaskStatus,
        Teammate,
    )

    errors = validate_manifest(manifest)
    if errors:
        raise ValueError(f"invalid manifest: {errors[0]}")
    if manifest.get("project_id") != project_id:
        raise ValueError("manifest project_id does not match target project")
    if store.get_project(conn, project_id) is None:
        raise KeyError(f"unknown project {project_id}")

    imported: dict[str, int] = {}
    skipped: list[dict[str, str]] = []
    rejected: list[dict[str, str]] = []
    secrets_stripped = 0
    tables = manifest["tables"]
    pending: dict[str, set[str]] = {}

    def _exists(table: str, row_id: str) -> bool:
        if row_id in pending.get(table, set()):
            return True
        exists_map = {
            "teammates": store.get_teammate,
            "tasks": store.get_task,
            "issues": store.get_issue,
            "knowledge_sources": store.get_knowledge_source,
            "schedules": store.get_schedule,
            "providers": store.get_provider,
        }
        getter = exists_map.get(table)
        return getter is not None and getter(conn, row_id) is not None

    def _note(table: str, row_id: str) -> None:
        pending.setdefault(table, set()).add(row_id)
        imported[table] = imported.get(table, 0) + 1

    def _insert(table: str, row: dict[str, Any]) -> None:
        cols = ", ".join(row.keys())
        placeholders = ", ".join("?" for _ in row)
        conn.execute(f"INSERT INTO {table} ({cols}) VALUES ({placeholders})",
                     tuple(_to_db(table, k, v) for k, v in row.items()))

    for table in ("projects",):
        for raw in tables.get(table, []):
            row_id = raw.get("id", "")
            if row_id != project_id:
                rejected.append({"table": table, "id": row_id, "reason": "project mismatch"})
            else:
                skipped.append({"table": table, "id": row_id, "reason": "project already exists"})

    for table, model in (
        ("teammates", Teammate),
        ("issues", Issue),
        ("knowledge_sources", KnowledgeSource),
        ("schedules", Schedule),
        ("notifications", Notification),
        ("memories", MemoryEntry),
        ("providers", Provider),
    ):
        for raw in tables.get(table, []):
            if not isinstance(raw, dict):
                rejected.append({"table": table, "id": "", "reason": "row is not an object"})
                continue
            row_id = str(raw.get("id", ""))
            coerced = _coerce_row(table, raw)
            if coerced is None:
                rejected.append({"table": table, "id": row_id, "reason": "unparseable columns"})
                continue
            if coerced.get("project_id") != project_id:
                rejected.append({"table": table, "id": row_id, "reason": "wrong project"})
                continue
            if table == "schedules":
                try:
                    schedules_mod.parse_cron(str(coerced.get("cron", "")))
                except ValueError as exc:
                    rejected.append({"table": table, "id": row_id, "reason": str(exc)})
                    continue
                template = coerced.get("task_template")
                if not isinstance(template, dict) or not template.get("description") \
                        or not template.get("command"):
                    rejected.append({"table": table, "id": row_id,
                                     "reason": "template needs description and command"})
                    continue
            if table == "providers":
                stripped = [k for k, v in dict(coerced.get("config") or {}).items()
                            if secrets_mod.is_secret_key(k)]
                secrets_stripped += len(stripped)
                coerced["config"] = {}
                try:
                    ProviderKind(coerced.get("kind") or "local")
                except ValueError:
                    rejected.append({"table": table, "id": row_id, "reason": "invalid kind"})
                    continue
            try:
                model(**{k: v for k, v in coerced.items()
                         if k in model.model_fields})
            except ValidationError as exc:
                rejected.append({"table": table, "id": row_id,
                                 "reason": f"schema: {exc.errors()[0]['msg']}"})
                continue
            if _exists(table, row_id):
                skipped.append({"table": table, "id": row_id, "reason": "already exists"})
                continue
            if not dry_run:
                _insert(table, {k: v for k, v in raw.items() if k != "config"} |
                        ({"config": "{}"} if table == "providers" else {}))
            _note(table, row_id)

    for raw in tables.get("knowledge_chunks", []):
        row_id = str(raw.get("id", "")) if isinstance(raw, dict) else ""
        if not isinstance(raw, dict) or raw.get("project_id") != project_id:
            rejected.append({"table": "knowledge_chunks", "id": row_id,
                             "reason": "wrong project"})
            continue
        if not _exists("knowledge_sources", str(raw.get("source_id", ""))):
            rejected.append({"table": "knowledge_chunks", "id": row_id,
                             "reason": "unknown source"})
            continue
        try:
            KnowledgeChunk(**{k: v for k, v in raw.items()
                              if k in KnowledgeChunk.model_fields})
        except ValidationError as exc:
            rejected.append({"table": "knowledge_chunks", "id": row_id,
                             "reason": f"schema: {exc.errors()[0]['msg']}"})
            continue
        if store.list_knowledge_chunks(conn, project_id) and any(
            c.id == row_id for c in store.list_knowledge_chunks(conn, project_id)
        ):
            skipped.append({"table": "knowledge_chunks", "id": row_id,
                            "reason": "already exists"})
            continue
        if not dry_run:
            _insert("knowledge_chunks", raw)
        _note("knowledge_chunks", row_id)

    for raw in tables.get("tasks", []):
        row_id = str(raw.get("id", "")) if isinstance(raw, dict) else ""
        if not isinstance(raw, dict) or raw.get("project_id") != project_id:
            rejected.append({"table": "tasks", "id": row_id, "reason": "wrong project"})
            continue
        coerced = _coerce_row("tasks", raw)
        if coerced is None:
            rejected.append({"table": "tasks", "id": row_id, "reason": "unparseable columns"})
            continue
        owner = coerced.get("owner_teammate_id")
        if owner is not None and not _exists("teammates", str(owner)):
            rejected.append({"table": "tasks", "id": row_id, "reason": "unknown owner"})
            continue
        missing_dep = next(
            (d for d in (coerced.get("dependencies") or []) if not _exists("tasks", str(d))),
            None,
        )
        if missing_dep is not None:
            rejected.append({"table": "tasks", "id": row_id,
                             "reason": f"unknown dependency {missing_dep}"})
            continue
        if coerced.get("issue_id") is not None and not _exists(
            "issues", str(coerced["issue_id"])
        ):
            rejected.append({"table": "tasks", "id": row_id, "reason": "unknown issue"})
            continue
        status = str(coerced.get("status") or "pending")
        if status not in {s.value for s in TaskStatus}:
            rejected.append({"table": "tasks", "id": row_id, "reason": "invalid status"})
            continue
        try:
            Task(**{k: v for k, v in coerced.items() if k in Task.model_fields})
        except ValidationError as exc:
            rejected.append({"table": "tasks", "id": row_id,
                             "reason": f"schema: {exc.errors()[0]['msg']}"})
            continue
        if _exists("tasks", row_id):
            skipped.append({"table": "tasks", "id": row_id, "reason": "already exists"})
            continue
        if not dry_run:
            _insert("tasks", raw)
        _note("tasks", row_id)

    for table in sorted(HISTORY_TABLES):
        for raw in tables.get(table, []):
            row_id = str(raw.get("id", "")) if isinstance(raw, dict) else ""
            skipped.append({"table": table, "id": row_id, "reason": "history not replayed"})

    if not dry_run:
        conn.commit()
    return {
        "imported": imported,
        "skipped": skipped,
        "rejected": rejected,
        "secrets_stripped": secrets_stripped,
        "dry_run": dry_run,
    }
