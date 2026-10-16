"""Notifications: outbox persistence plus real webhook-out delivery.

``outbox`` persists records only. ``webhook-out`` delivers behind the
outbox: each attempt is recorded, retries are bounded, re-sending a
delivered notification performs no new HTTP request. Email and Slack
remain documented stubs. Payloads are redacted before storage.
"""

from __future__ import annotations

import json
import sqlite3
import time
from collections.abc import Callable
from typing import Any
from urllib.parse import urljoin

import httpx

from . import fetch as fetch_mod
from . import store
from .models import Notification

OUTBOX_CHANNEL = "outbox"
WEBHOOK_CHANNEL = "webhook-out"
STUB_CHANNELS = ("email", "slack")

MAX_DELIVERY_ATTEMPTS = 3
BACKOFF_SECONDS = (1.0, 2.0)
RESPONSE_MAX_BYTES = 262_144
REQUEST_TIMEOUT_S = 15.0


class ChannelNotConfiguredError(RuntimeError):
    """An unimplemented notification channel was requested."""


class WebhookNotConfiguredError(RuntimeError):
    """No allowlisted webhook target available for delivery."""


class WebhookBlockedError(ValueError):
    """Webhook target rejected by SSRF policy."""


class WebhookDeliveryError(RuntimeError):
    """Delivery failed after exhausting bounded retries."""


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
            " or deliver via webhook targets"
        )
    return store.create_notification(conn, project_id, channel, kind, payload, status="stored")


def add_webhook_target(conn: sqlite3.Connection, project_id: str, url: str) -> dict[str, str]:
    """Allowlist one outbound target URL (validated public-only at add time)."""
    if not isinstance(url, str) or not url.strip():
        raise ValueError("target url is required")
    try:
        fetch_mod.check_url(url)
    except (fetch_mod.FetchBlockedError, fetch_mod.FetchProtocolError) as exc:
        raise WebhookBlockedError(f"target rejected: {exc}") from exc
    return store.create_webhook_target(conn, project_id, url.strip())


def resolve_target(conn: sqlite3.Connection, project_id: str, target_url: str = "") -> str:
    if target_url:
        try:
            fetch_mod.check_url(target_url)
        except (fetch_mod.FetchBlockedError, fetch_mod.FetchProtocolError) as exc:
            raise WebhookBlockedError(f"target rejected: {exc}") from exc
        return target_url
    targets = store.list_webhook_targets(conn, project_id)
    if not targets:
        raise WebhookNotConfiguredError("no webhook targets configured for project")
    return targets[0]["url"]


def deliver_webhook(
    conn: sqlite3.Connection,
    notification_id: str,
    transport: httpx.BaseTransport | None = None,
    sleep: Callable[[float], None] = time.sleep,
    resolver: Callable[[str], list[str]] | None = None,
) -> Notification:
    """Deliver one webhook notification. Idempotent on delivered rows."""
    note = store.get_notification(conn, notification_id)
    if note is None:
        raise KeyError(f"unknown notification {notification_id}")
    if note.channel != WEBHOOK_CHANNEL:
        raise ValueError(f"notification {notification_id} is not a webhook delivery")
    if note.status == "delivered":
        return note
    target = resolve_target(conn, note.project_id, note.target_url)
    body = json.dumps({"id": note.id, "kind": note.kind, "payload": note.payload})
    attempts = note.attempts
    last_error = "no attempts made"
    if transport is None:
        transport = fetch_mod.PinnedTransport(
            resolver=resolver, timeout_s=REQUEST_TIMEOUT_S, max_bytes=RESPONSE_MAX_BYTES
        )
    client = httpx.Client(
        follow_redirects=False, timeout=REQUEST_TIMEOUT_S, transport=transport
    )
    try:
        while attempts < MAX_DELIVERY_ATTEMPTS:
            attempts += 1
            store.set_notification_delivery(conn, note.id, "sending", attempts)
            try:
                _post_once(client, target, body, note.id)
            except (fetch_mod.FetchBlockedError, fetch_mod.FetchProtocolError) as exc:
                last_error = f"blocked: {exc}"
                break
            except (fetch_mod.FetchTimeoutError, WebhookDeliveryError) as exc:
                last_error = str(exc)
                if attempts < MAX_DELIVERY_ATTEMPTS:
                    sleep(BACKOFF_SECONDS[min(attempts - 1, len(BACKOFF_SECONDS) - 1)])
                continue
            store.set_notification_delivery(conn, note.id, "delivered", attempts)
            refreshed = store.get_notification(conn, note.id)
            assert refreshed is not None
            return refreshed
    finally:
        client.close()
    store.set_notification_delivery(conn, note.id, "failed", attempts)
    raise WebhookDeliveryError(f"delivery failed after {attempts} attempts: {last_error}")


def _post_once(client: httpx.Client, target: str, body: str, idempotency_key: str) -> None:
    """Single POST with manual redirect handling. Raises on retryable failure."""
    url = fetch_mod.check_url(target)
    method, payload = "POST", body
    for _ in range(fetch_mod.DEFAULT_MAX_REDIRECTS + 1):
        try:
            if method == "POST":
                response = client.post(
                    url,
                    content=payload.encode("utf-8"),
                    headers={
                        "Content-Type": "application/json",
                        "X-Idempotency-Key": idempotency_key,
                    },
                )
            else:
                response = client.get(url, headers={"X-Idempotency-Key": idempotency_key})
        except httpx.TimeoutException as exc:
            raise fetch_mod.FetchTimeoutError(f"webhook timed out: {exc}") from exc
        except httpx.TransportError as exc:
            raise WebhookDeliveryError(f"webhook transport failed: {exc}") from exc
        if response.status_code in (301, 302, 303, 307, 308):
            location = response.headers.get("location", "")
            if not location:
                raise WebhookDeliveryError("redirect without location")
            url = fetch_mod.check_url(urljoin(url, location))
            if response.status_code in (301, 302, 303):
                method, payload = "GET", ""
            continue
        if 200 <= response.status_code < 300:
            _drain_capped(response)
            return
        if response.status_code == 429 or response.status_code >= 500:
            raise WebhookDeliveryError(f"transient upstream status {response.status_code}")
        raise WebhookDeliveryError(f"upstream rejected delivery: HTTP {response.status_code}")
    raise WebhookDeliveryError("too many redirects")


def _drain_capped(response: httpx.Response) -> None:
    total = 0
    for chunk in response.iter_bytes(chunk_size=65536):
        total += len(chunk)
        if total > RESPONSE_MAX_BYTES:
            raise WebhookDeliveryError("upstream response exceeds cap")
