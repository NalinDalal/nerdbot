"""Token budgets for the org (policy.spawn_policy.budgets in the v3 spec).

Defaults match the spec: 60k per task, 200k per persona per day, 800k per
organization per day. Exceeding a cap is a hard stop recorded as such (never
silent success), and the owner is notified via the outbox. Caps are
overridable through NERDBOT_BUDGET_* environment variables so small
deployments and tests can tighten them.
"""

from __future__ import annotations

import os
import sqlite3
from typing import Any

from . import notify, store


def _env_int(name: str, default: int) -> int:
    raw = os.environ.get(name, "")
    try:
        value = int(raw)
    except (TypeError, ValueError):
        return default
    return value if value > 0 else default


def caps() -> dict[str, int]:
    """The active budget caps (tokens)."""
    return {
        "per_task_max_tokens": _env_int("NERDBOT_BUDGET_TASK_TOKENS", 60_000),
        "per_persona_daily_max_tokens": _env_int(
            "NERDBOT_BUDGET_PERSONA_DAILY_TOKENS", 200_000
        ),
        "org_daily_max_tokens": _env_int("NERDBOT_BUDGET_ORG_DAILY_TOKENS", 800_000),
    }


class BudgetExceeded(Exception):
    """A budget cap is exhausted; the run must stop and report honestly."""

    def __init__(self, reason: str) -> None:
        super().__init__(reason)
        self.reason = reason


def usage_snapshot(
    conn: sqlite3.Connection,
    *,
    task_id: str = "",
    teammate_id: str = "",
) -> dict[str, int]:
    """Current usage against each cap (tokens)."""
    return {
        "task_used": store.token_usage_for_task(conn, task_id) if task_id else 0,
        "persona_today_used": (
            store.token_usage_for_teammate_today(conn, teammate_id) if teammate_id else 0
        ),
        "org_today_used": store.token_usage_for_org_today(conn),
    }


def check_and_record(
    conn: sqlite3.Connection,
    *,
    run_id: str,
    task_id: str,
    teammate_id: str,
    project_id: str,
    prompt_tokens: int,
    completion_tokens: int,
    context: Any = None,
) -> dict[str, Any]:
    """Record one model call's usage, then enforce every cap.

    Raises BudgetExceeded when a cap is now over. The owner is notified once
    per raise through the outbox (pause_and_notify_owner in the spec).
    """
    store.record_token_usage(
        conn,
        run_id=run_id,
        task_id=task_id,
        teammate_id=teammate_id,
        project_id=project_id,
        prompt_tokens=prompt_tokens,
        completion_tokens=completion_tokens,
    )
    caps_now = caps()
    used = usage_snapshot(conn, task_id=task_id, teammate_id=teammate_id)
    checks = [
        ("task", used["task_used"], caps_now["per_task_max_tokens"]),
        ("persona-day", used["persona_today_used"], caps_now["per_persona_daily_max_tokens"]),
        ("org-day", used["org_today_used"], caps_now["org_daily_max_tokens"]),
    ]
    for scope, used_tokens, cap in checks:
        if used_tokens > cap:
            reason = (
                f"budget exceeded ({scope}): {used_tokens} tokens used, cap {cap}"
            )
            _notify_owner(conn, project_id, teammate_id, task_id, reason)
            raise BudgetExceeded(reason)
    return {"caps": caps_now, "usage": used}


def _notify_owner(
    conn: sqlite3.Connection,
    project_id: str,
    teammate_id: str,
    task_id: str,
    reason: str,
) -> None:
    try:
        notify.send_notification(
            conn,
            project_id,
            notify.OUTBOX_CHANNEL,
            "budget.exceeded",
            {
                "reason": reason,
                "teammate_id": teammate_id,
                "task_id": task_id,
            },
        )
    except Exception:  # pragma: no cover - notification must never mask the stop
        pass


def budget_report(conn: sqlite3.Connection, project_id: str, teammate_id: str = "") -> dict[str, Any]:
    """Honest caps-versus-usage report for one workspace."""
    used = usage_snapshot(conn)
    return {"caps": caps(), "usage": used}
