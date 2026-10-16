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

SECRET_CONFIG_KEYS = {"api_key", "apikey", "secret", "token", "password", "authorization"}


def redact_provider_config(config: dict[str, Any]) -> dict[str, Any]:
    return {
        key: ("[redacted]" if key.lower() in SECRET_CONFIG_KEYS else value)
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
                if key.lower() in SECRET_CONFIG_KEYS and value != "[redacted]":
                    errors.append(f"provider {row.get('id')}: secret {key!r} not redacted")
    return errors
