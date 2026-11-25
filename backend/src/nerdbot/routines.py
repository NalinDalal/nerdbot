"""Proactive routines/triggers for Grok-bot-like teammates.

Opt-in sweeper: set NERDBOT_ROUTINES=1. Routines create visible tasks for the
owning teammate; they do not silently take external actions.
"""

from __future__ import annotations

import os
import sqlite3
import threading
import time
from datetime import UTC, datetime, timedelta
from typing import Any

from . import store

_ROUTINE_RATE: dict[str, list[float]] = {}
_TRIGGER_CYCLES: dict[tuple[str, str, str], float] = {}  # (src, dst, kind) -> ts


def _rate_limited(teammate_id: str, now: datetime, limit_per_hour: int = 6) -> bool:
    """Return True if teammate routine/trigger fires exceeded hourly limit.

    Args:
        teammate_id: Teammate id.
        now: Current UTC time.
        limit_per_hour: Max fires per rolling hour.

    Returns:
        True when rate-limited.
    """
    bucket = _ROUTINE_RATE.setdefault(teammate_id, [])
    cutoff = now.timestamp() - 3600
    bucket[:] = [t for t in bucket if t >= cutoff]
    if len(bucket) >= limit_per_hour:
        return True
    bucket.append(now.timestamp())
    return False


def _cycle_blocked(src: str, dst: str, kind: str, now: datetime) -> bool:
    """Prevent self-trigger and A->B->A cycles within an hour.

    Args:
        src: Source actor/teammate id.
        dst: Target teammate id.
        kind: Trigger kind.
        now: Current UTC time.

    Returns:
        True if trigger should be blocked.
    """
    if not src or not dst:
        return False
    if src == dst:
        return True
    cutoff = now.timestamp() - 3600
    # cleanup
    for k, ts in list(_TRIGGER_CYCLES.items()):
        if ts < cutoff:
            _TRIGGER_CYCLES.pop(k, None)
    # A->B then B->A blocked
    if _TRIGGER_CYCLES.get((dst, src, kind), 0) >= cutoff:
        return True
    _TRIGGER_CYCLES[(src, dst, kind)] = now.timestamp()
    return False


def _cron_due(cron: str, now: datetime) -> bool:
    """Minimal 5-field cron matcher (min hour dom month dow). Supports * and numbers.

    Args:
        cron: Cron expression.
        now: UTC datetime.

    Returns:
        True if cron matches current minute.
    """
    parts = [p.strip() for p in str(cron or "").split()]
    if len(parts) != 5:
        return False
    vals = [now.minute, now.hour, now.day, now.month, (now.weekday() + 1) % 7]  # dow 0=Sun
    for part, val in zip(parts, vals):
        if part == "*":
            continue
        ok = False
        for token in part.split(","):
            token = token.strip()
            if token.isdigit() and int(token) == int(val):
                ok = True
                break
            if "-" in token:
                a, b = token.split("-", 1)
                if a.isdigit() and b.isdigit() and int(a) <= int(val) <= int(b):
                    ok = True
                    break
            if token.startswith("*/") and token[2:].isdigit():
                step = int(token[2:])
                if step > 0 and int(val) % step == 0:
                    ok = True
                    break
        if not ok:
            return False
    return True


def _due(routine: Any, now: datetime) -> bool:
    """Return True if an interval/cron routine should fire now.

    Args:
        routine: Routine row.
        now: Current UTC time.

    Returns:
        True when due.
    """
    if not routine.enabled:
        return False
    kind = str(getattr(routine, "kind", "watch") or "watch")
    if kind in {"on_task_done", "on_mention"}:
        return False
    cron = str(getattr(routine, "cron", "") or "").strip()
    if cron:
        if not _cron_due(cron, now):
            return False
        # fire at most once per minute
        if routine.last_run_at:
            try:
                last = datetime.fromisoformat(routine.last_run_at)
                if last.tzinfo is None:
                    last = last.replace(tzinfo=UTC)
                if (now - last).total_seconds() < 55:
                    return False
            except Exception:
                pass
        return True
    if not routine.last_run_at:
        return True
    try:
        last = datetime.fromisoformat(routine.last_run_at)
        if last.tzinfo is None:
            last = last.replace(tzinfo=UTC)
    except Exception:
        return True
    return last + timedelta(seconds=max(60, int(routine.interval_s or 3600))) <= now


def _create_trigger_task(conn: sqlite3.Connection, routine: Any, mate: Any, *, title: str, description: str) -> bool:
    """Create a visible task for a trigger fire.

    Args:
        conn: SQLite connection.
        routine: Routine record.
        mate: Teammate record.
        title: Task title.
        description: Task description.

    Returns:
        True if created.
    """
    try:
        store.create_task(conn, routine.project_id, description, owner_teammate_id=routine.teammate_id, title=title)
        store.update_routine(conn, routine.id, last_run_at=datetime.now(UTC).isoformat())
        return True
    except Exception:
        return False


def sweep_once(conn: sqlite3.Connection) -> int:
    """Fire due interval/cron routines once. Respects pause and hourly rate limit.

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
        if _create_trigger_task(conn, routine, mate, title=title, description=desc):
            fired += 1
    return fired


def fire_task_done_triggers(conn: sqlite3.Connection, task: Any, *, actor_teammate_id: str = "") -> int:
    """Fire on_task_done routines for teammates in the project.

    A routine with kind on_task_done creates a follow-up task for the routine owner
    when a task completes. Self-triggers and A->B->A cycles within an hour are blocked.

    Args:
        conn: SQLite connection.
        task: Completed task.
        actor_teammate_id: Teammate who completed/caused completion, if known.

    Returns:
        Number of follow-up tasks created.
    """
    project_id = str(getattr(task, "project_id", "") or "")
    if not project_id:
        return 0
    owner = str(getattr(task, "owner_teammate_id", "") or "")
    src = actor_teammate_id or owner
    now = datetime.now(UTC)
    fired = 0
    for mate in store.list_teammates(conn, project_id=project_id):
        if bool(getattr(mate, "paused", False)):
            continue
        routines = store.list_routines(conn, mate.id)
        for routine in routines:
            if not routine.enabled or str(getattr(routine, "kind", "")) != "on_task_done":
                continue
            if _cycle_blocked(src, mate.id, "on_task_done", now):
                continue
            if _rate_limited(mate.id, now):
                continue
            prompt = routine.prompt.strip() or f"Follow up on completed task: {getattr(task, 'title', '') or getattr(task, 'description', '')[:80]}"
            title = f"[Follow-up] {getattr(task, 'title', '') or routine.name}"
            desc = f"{prompt}\n\n(task {getattr(task, 'id', '')} completed)"
            if _create_trigger_task(conn, routine, mate, title=title[:200], description=desc[:8000]):
                fired += 1
    return fired


def fire_mention_triggers(conn: sqlite3.Connection, *, project_id: str, thread_id: str, message: str, mentioner_id: str = "") -> int:
    """Fire on_mention routines for teammates mentioned in a thread message.

    Args:
        conn: SQLite connection.
        project_id: Project id.
        thread_id: Thread id.
        message: Message content.
        mentioner_id: Teammate/user id who sent the message.

    Returns:
        Number of tasks created.
    """
    if not message:
        return 0
    now = datetime.now(UTC)
    mates = store.list_teammates(conn, project_id=project_id)
    fired = 0
    for mate in mates:
        handle = str(getattr(mate, "handle", "") or "").strip().lower()
        name = str(getattr(mate, "name", "") or "").strip().lower()
        if not handle and not name:
            continue
        msg_l = message.lower()
        mentioned = (handle and f"@{handle}" in msg_l) or (name and f"@{name.replace(' ', '')}" in msg_l)
        if not mentioned:
            continue
        routines = store.list_routines(conn, mate.id)
        for routine in routines:
            if not routine.enabled or str(getattr(routine, "kind", "")) != "on_mention":
                continue
            if bool(getattr(mate, "paused", False)):
                continue
            if _cycle_blocked(mentioner_id, mate.id, "on_mention", now):
                continue
            if _rate_limited(mate.id, now):
                continue
            prompt = routine.prompt.strip() or f"Respond to mention in thread {thread_id}"
            title = f"[Mention] {routine.name}"
            desc = f"{prompt}\n\n(thread {thread_id}, mentioner {mentioner_id})\n\nMessage:\n{message[:2000]}"
            if _create_trigger_task(conn, routine, mate, title=title[:200], description=desc[:8000]):
                fired += 1
    return fired


def sweep_loop(*, interval_s: float = 30.0, db_path: str | None = None, stop_event: threading.Event | None = None) -> None:
    """Run routine sweep loop."""
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
