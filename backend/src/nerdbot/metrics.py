"""Owner-scoped lightweight metrics for debugging failed runs."""

from __future__ import annotations

import sqlite3
from typing import Any

from . import store


def project_metrics(conn: sqlite3.Connection, project_id: str) -> dict[str, Any]:
    if store.get_project(conn, project_id) is None:
        raise KeyError(f"unknown project {project_id}")
    runs = store.list_runs_for_project(conn, project_id)
    runs_by_status: dict[str, int] = {}
    failed_commands = 0
    for run in runs:
        runs_by_status[run.status.value] = runs_by_status.get(run.status.value, 0) + 1
        if run.exit_code not in (None, 0):
            failed_commands += 1
    approvals_by_decision: dict[str, int] = {}
    for task in store.list_tasks_for_project(conn, project_id):
        for approval in store.list_approvals_for_task(conn, task.id):
            approvals_by_decision[approval.decision.value] = (
                approvals_by_decision.get(approval.decision.value, 0) + 1
            )
    schedules = store.list_schedules(conn, project_id)
    sources = store.list_knowledge_sources(conn, project_id)
    return {
        "project_id": project_id,
        "runs_total": len(runs),
        "runs_by_status": runs_by_status,
        "failed_commands": failed_commands,
        "approvals_by_decision": approvals_by_decision,
        "restarts": int(store.meta_get(conn, "restart_count", "0") or 0),
        "schedules": {
            "total": len(schedules),
            "enabled": sum(1 for s in schedules if s.enabled),
            "fired": sum(s.fire_count for s in schedules),
        },
        "knowledge": {
            "sources": len(sources),
            "chunks": len(store.list_knowledge_chunks(conn, project_id)),
        },
        "notifications": len(store.list_notifications(conn, project_id)),
    }
