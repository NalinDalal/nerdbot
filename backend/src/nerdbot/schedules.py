"""Minimal validated cron subset for persisted schedules.

Supported fields (minute hour day-of-month month day-of-week):
``*``, ``*/n``, ``a-b``, ``a-b/n``, comma lists, single integers.
Anything else is a validation error. Day-of-month/day-of-week follow the
standard OR rule when both are restricted, AND otherwise.
"""

from __future__ import annotations

from datetime import datetime, timedelta

FIELD_RANGES = ((0, 59), (0, 23), (1, 31), (1, 12), (0, 6))


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


def next_after(expr: str, after: datetime, limit_minutes: int = 527040) -> datetime:
    """Next datetime strictly after ``after`` matching the expression."""
    fields = parse_cron(expr)
    candidate = (after.replace(second=0, microsecond=0) + timedelta(minutes=1)).replace(
        second=0, microsecond=0
    )
    for _ in range(limit_minutes):
        if _matches(fields, candidate):
            return candidate
        candidate += timedelta(minutes=1)
    raise ValueError(f"no cron occurrence within a year for {expr!r}")
