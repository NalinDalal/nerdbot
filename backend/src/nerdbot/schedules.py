"""Minimal validated cron subset for persisted schedules.

Supported fields (minute hour day-of-month month day-of-week):
``*``, ``*/n``, ``a-b``, ``a-b/n``, comma lists, single integers.
Anything else is a validation error. Day-of-month/day-of-week follow the
standard OR rule when both are restricted, AND otherwise.

Phase 2: timezone-aware next-run computation and friendly presets.
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from typing import Any
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

FIELD_RANGES = ((0, 59), (0, 23), (1, 31), (1, 12), (0, 6))

# Friendly presets -> 5-field cron (minute hour dom month dow)
PRESETS: dict[str, str] = {
    "every-minute": "* * * * *",
    "hourly": "0 * * * *",
    "daily": "0 9 * * *",
    "daily-9am": "0 9 * * *",
    "weekdays-9am": "0 9 * * 1-5",
    "weekly-monday": "0 9 * * 1",
    "weekly": "0 9 * * 1",
    "monthly": "0 9 1 * *",
}


def resolve_cron(value: str) -> str:
    """Accept a 5-field cron expression or a friendly preset name."""
    raw = (value or "").strip()
    if not raw:
        raise ValueError("cron expression is required")
    key = raw.lower().replace(" ", "-").replace("_", "-")
    if key in PRESETS:
        return PRESETS[key]
    # also accept "@hourly" style lightly
    if raw.startswith("@"):
        mapped = {
            "@hourly": PRESETS["hourly"],
            "@daily": PRESETS["daily"],
            "@weekly": PRESETS["weekly"],
            "@monthly": PRESETS["monthly"],
        }.get(raw.lower())
        if mapped:
            return mapped
    parse_cron(raw)  # validate
    return raw


def presets() -> list[dict[str, str]]:
    return [{"id": k, "cron": v, "label": k.replace("-", " ")} for k, v in PRESETS.items()]


def parse_field(field: str, lo: int, hi: int) -> frozenset[int]:
    values: set[int] = set()
    for part in field.split(","):
        part = part.strip()
        if not part:
            raise ValueError(f"empty cron part in {field!r}")
        step = 1
        if "/" in part:
            part, step_text = part.split("/", 1)
            step = int(step_text)
            if step <= 0:
                raise ValueError(f"bad cron step in {field!r}")
        if part == "*":
            start, end = lo, hi
        elif "-" in part:
            start_text, end_text = part.split("-", 1)
            start, end = int(start_text), int(end_text)
        else:
            start = end = int(part)
        if not (lo <= start <= hi and lo <= end <= hi and start <= end):
            raise ValueError(f"cron value out of range in {field!r}")
        values.update(range(start, end + 1, step))
    if not values:
        raise ValueError(f"empty cron field {field!r}")
    return frozenset(values)


def parse_cron(expr: str) -> tuple[frozenset[int], ...]:
    parts = expr.split()
    if len(parts) != 5:
        raise ValueError(f"cron needs 5 fields, got {len(parts)}: {expr!r}")
    try:
        return tuple(
            parse_field(part, lo, hi) for part, (lo, hi) in zip(parts, FIELD_RANGES, strict=True)
        )
    except ValueError as exc:
        raise ValueError(f"invalid cron {expr!r}: {exc}") from exc


def _matches(fields: tuple[frozenset[int], ...], moment: datetime) -> bool:
    minute, hour, dom, month, dow = fields
    py_dow = (moment.weekday() + 1) % 7  # datetime Monday=0 -> cron Sunday=0
    if not (moment.minute in minute and moment.hour in hour and moment.month in month):
        return False
    dom_restricted = dom != frozenset(range(1, 32))
    dow_restricted = dow != frozenset(range(0, 7))
    if dom_restricted and dow_restricted:
        return moment.day in dom or py_dow in dow
    return moment.day in dom and py_dow in dow


def normalize_timezone(tz: str | None) -> str:
    name = (tz or "UTC").strip() or "UTC"
    try:
        ZoneInfo(name)
    except (ZoneInfoNotFoundError, KeyError, ValueError) as exc:
        raise ValueError(f"unknown timezone {name!r}") from exc
    return name


def next_after(
    expr: str, after: datetime, limit_minutes: int = 527040, timezone: str | None = None
) -> datetime:
    """Next datetime strictly after ``after`` matching the expression.

    When ``timezone`` is provided, matching is evaluated in that zone and the
    returned value is UTC-aware. Backward compatible: naive/UTC ``after`` with
    no timezone behaves as before (naive minute-grid match).
    """
    fields = parse_cron(resolve_cron(expr) if expr in PRESETS or (expr or "").startswith("@") else expr)
    tz_name = (timezone or "").strip()
    if tz_name:
        tz = ZoneInfo(normalize_timezone(tz_name))
        base = after if after.tzinfo else after.replace(tzinfo=UTC)
        local = base.astimezone(tz).replace(second=0, microsecond=0) + timedelta(minutes=1)
        for _ in range(limit_minutes):
            if _matches(fields, local):
                return local.astimezone(UTC)
            local += timedelta(minutes=1)
        raise ValueError(f"no cron occurrence within a year for {expr!r} in {tz_name}")
    candidate = (after.replace(second=0, microsecond=0) + timedelta(minutes=1)).replace(
        second=0, microsecond=0
    )
    for _ in range(limit_minutes):
        if _matches(fields, candidate):
            return candidate
        candidate += timedelta(minutes=1)
    raise ValueError(f"no cron occurrence within a year for {expr!r}")


def schedule_to_dict(s: Any) -> dict[str, Any]:
    return {
        "id": s.id,
        "project_id": s.project_id,
        "name": s.name,
        "cron": s.cron,
        "timezone": getattr(s, "timezone", "UTC") or "UTC",
        "task_template": s.task_template,
        "teammate_id": getattr(s, "teammate_id", "") or "",
        "target_action": getattr(s, "target_action", "task") or "task",
        "enabled": bool(s.enabled),
        "paused": bool(getattr(s, "paused", False)),
        "overlap_policy": getattr(s, "overlap_policy", "skip") or "skip",
        "next_run_at": s.next_run_at.isoformat() if s.next_run_at else None,
        "last_fired_at": s.last_fired_at.isoformat() if s.last_fired_at else None,
        "last_run_status": getattr(s, "last_run_status", "") or "",
        "last_error": getattr(s, "last_error", "") or "",
        "locked": bool(getattr(s, "locked", False)),
        "fire_count": getattr(s, "fire_count", 0) or 0,
        "created_at": s.created_at.isoformat() if getattr(s, "created_at", None) else None,
    }
