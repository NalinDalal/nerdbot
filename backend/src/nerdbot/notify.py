"""Notifications: one real outbox channel, explicit stubs for the rest.

Only ``outbox`` persists records. External channels (email, slack,
webhook-out) raise ``ChannelNotConfiguredError`` — they are capability
flags, not working integrations. Payloads are redacted before storage.
"""

from __future__ import annotations

import sqlite3
from typing import Any

from . import store
from .models import Notification

OUTBOX_CHANNEL = "outbox"
STUB_CHANNELS = ("email", "slack", "webhook-out")


class ChannelNotConfiguredError(RuntimeError):
    """An unimplemented notification channel was requested."""


def send_notification(
    conn: sqlite3.Connection,
    project_id: str,
    channel: str,
    kind: str,
    payload: dict[str, Any] | None = None,
) -> Notification:
    if channel != OUTBOX_CHANNEL:
        raise ChannelNotConfiguredError(
            f"channel {channel!r} is a documented stub; use {OUTBOX_CHANNEL!r}"
        )
    return store.create_notification(conn, project_id, channel, kind, payload, status="stored")
