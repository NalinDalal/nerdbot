"""Minimal proactive routine runner for Grok-bot-like teammates.

Opt-in: set NERDBOT_ROUTINES=1. Routines create visible tasks for the owning
teammate; they do not silently take external actions.
"""

from __future__ import annotations

import os
import sqlite3
import threading
import time
from datetime import UTC, datetime, timedelta

from . import store


def _due(routine, now: datetime) -> bool:
    if not routine.enabled:
        return False
    if not routine.last_run_at:
        return True
    try:
        last = datetime.fromisoformat(routine.last_run_at)
        if last.tzinfo is None:
            last = last.replace(tzinfo=UTC)
    except Exception:
        return True
    return last + timedelta(seconds=max(60, int(routine.interval_s or 3600))) <= now


_ROUTINE_RATE: dict[str, list[float]] = {}


def _rate_limited(teammate_id: str, now: datetime, limit_per_hour: int = 6) -> bool:
    """Return True if teammate routine/trigger fires exceeded hourly limit."""
    bucket = _ROUTINE_RATE.setdefault(teammate_id, [])
    cutoff = now.timestamp() - 3600
    bucket[:] = [t for t in bucket if t >= cutoff]
    if len(bucket) >= limit_per_hour:
        return True
    bucket.append(now.timestamp())
    return False


def sweep_once(conn: sqlite3.Connection) -> int:
    """Fire due routines once. Respects pause and per-teammate hourly rate limit.

    Args:
        conn: SQLite connection.

    Returns:
        Number of routines fired.
    """
    now = datetime.now(UTC)
    rows = conn.execute("SELECT id FROM teammate_routines WHERE enabled=1").fetchall()
    fired = 0
    for row in rows:
        routine = store.get_routine(conn, row["id"])
        if routine is None or not _due(routine, now):
            continue
        mate = store.get_teammate(conn, routine.teammate_id)
        if mate is None or bool(getattr(mate, "paused", False)):
            continue
        if _rate_limited(mate.id, now):
            continue
        prompt = routine.prompt.strip() or f"Routine check: {routine.name}"
        title = f"[Routine] {routine.name}"
        desc = f"{prompt}\n\n(routine {routine.id} for teammate {mate.name or mate.id})"
        try:
            store.create_task(conn, routine.project_id, desc, owner_teammate_id=routine.teammate_id, title=title)
            store.update_routine(conn, routine.id, last_run_at=now.isoformat())
            fired += 1
        except Exception:
            continue
    return fired


def sweep_loop(*, interval_s: float = 30.0, db_path: str | None = None, stop_event: threading.Event | None = None) -> None:
    db = db_path or os.environ.get("NERDBOT_DB", "nerdbot.db")
    while stop_event is None or not stop_event.is_set():
        try:
            conn = store.connect(db)
            try:
                sweep_once(conn)
            finally:
                conn.close()
        except Exception:
            pass
        if stop_event is None:
            time.sleep(interval_s)
        else:
            stop_event.wait(interval_s)
