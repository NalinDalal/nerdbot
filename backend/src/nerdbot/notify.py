"""Notifications: outbox persistence plus real webhook-out delivery.

``outbox`` persists records only. ``webhook-out`` delivers behind the
outbox: each attempt is recorded, retries are bounded, re-sending a
delivered notification performs no new HTTP request. Email and Slack
remain documented stubs. Payloads are redacted before storage.
"""

from __future__ import annotations

import json
import sqlite3
from collections.abc import Callable
from datetime import UTC, datetime, timedelta
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
# A held lock leaks only if the process dies mid-send (the ``finally``
# release covers every in-process path). Size the lease from the real
# worst-case attempt bound — one attempt is up to
# (DEFAULT_MAX_REDIRECTS + 1) pinned exchanges, each REQUEST_TIMEOUT_S,
# plus unbudgeted per-hop DNS — not from a single exchange.
LOCK_LEASE_S = REQUEST_TIMEOUT_S * (fetch_mod.DEFAULT_MAX_REDIRECTS + 1) + 30.0


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


class WebhookLockedError(RuntimeError):
    """A delivery attempt is already in progress for this notification."""


def _utcnow() -> datetime:
    return datetime.now(UTC)


_MAX_ERROR_TEXT = 500


def _err_text(exc: BaseException) -> str:
    """Bounded diagnostic text for the notifications row; secrets never
    enter delivery error paths, but the bound keeps corrupted upstreams
    from parking megabytes of post-mortem in SQLite."""
    text = f"{type(exc).__name__}: {exc}".strip()
    return text[:_MAX_ERROR_TEXT]


def _backoff_delay(attempts: int) -> float:
    """Delay after a failed attempt (1-based count). Capped schedule."""
    return BACKOFF_SECONDS[min(max(attempts - 1, 0), len(BACKOFF_SECONDS) - 1)]


def deliver_webhook(
    conn: sqlite3.Connection,
    notification_id: str,
    transport: httpx.BaseTransport | None = None,
    resolver: Callable[[str], list[str]] | None = None,
    now: datetime | None = None,
) -> Notification:
    """Perform one delivery attempt. Idempotent on delivered rows.

    Success → ``delivered``. Transient failure → ``queued`` with
    ``next_attempt_at`` set (a later sweep retries). Terminal failure
    (blocked/upstream rejection) → ``failed``. Exhausting the final
    attempt raises ``WebhookDeliveryError`` after persisting ``failed``.
    Never sleeps: delayed retries belong to the sweep path.
    """
    moment = now or _utcnow()
    note = store.get_notification(conn, notification_id)
    if note is None:
        raise KeyError(f"unknown notification {notification_id}")
    if note.channel != WEBHOOK_CHANNEL:
        raise ValueError(f"notification {notification_id} is not a webhook delivery")
    if note.status == "delivered":
        return note
    target = resolve_target(conn, note.project_id, note.target_url)
    if not store.claim_delivery_lock(conn, notification_id, now=moment):
        raise WebhookLockedError(f"delivery already in progress for {notification_id}")
    try:
        body = json.dumps({"id": note.id, "kind": note.kind, "payload": note.payload})
        attempts = note.attempts + 1
        store.set_notification_delivery(conn, note.id, "sending", attempts)
        if transport is None:
            transport = fetch_mod.PinnedTransport(
                resolver=resolver, timeout_s=REQUEST_TIMEOUT_S, max_bytes=RESPONSE_MAX_BYTES
            )
        client = httpx.Client(
            follow_redirects=False, timeout=REQUEST_TIMEOUT_S, transport=transport
        )
        try:
            _post_once(client, target, body, note.id)
        finally:
            client.close()
    except (WebhookNotConfiguredError, WebhookBlockedError, ValueError,
            fetch_mod.FetchBlockedError, fetch_mod.FetchProtocolError) as exc:
        current = store.get_notification(conn, notification_id)
        made = current.attempts if current else note.attempts
        reason = _err_text(exc)
        store.set_notification_delivery(conn, notification_id, "failed", made, reason)
        store.record_event(conn, note.project_id, "notification", notification_id,
                           "notification.failed")
        raise WebhookDeliveryError(f"delivery refused: {reason}") from exc
    except (fetch_mod.FetchTimeoutError, WebhookDeliveryError) as exc:
        if attempts >= MAX_DELIVERY_ATTEMPTS:
            store.set_notification_delivery(conn, notification_id, "failed", attempts,
                                            _err_text(exc))
            store.record_event(conn, note.project_id, "notification", notification_id,
                               "notification.failed")
            raise WebhookDeliveryError(
                f"delivery failed after {attempts} attempts: {exc}"
            ) from exc
        # Transient: keep the reason visible while the row waits for a sweep.
        store.set_notification_delivery(conn, notification_id, "queued", attempts,
                                        _err_text(exc))
        next_at = moment + timedelta(seconds=_backoff_delay(attempts))
        store.set_notification_next_attempt(conn, notification_id, next_at)
        refreshed = store.get_notification(conn, notification_id)
        assert refreshed is not None
        return refreshed
    finally:
        # Lease CAS: only clear the lock we ourselves claimed (moment is
        # the stamp deliver_webhook passed to claim_delivery_lock).
        store.release_delivery_lock(conn, notification_id, locked_at=moment)
    store.set_notification_delivery(conn, notification_id, "delivered", attempts, "")
    store.record_event(conn, note.project_id, "notification", notification_id,
                       "notification.delivered")
    refreshed = store.get_notification(conn, notification_id)
    assert refreshed is not None
    return refreshed


def reclaim_abandoned_deliveries(
    conn: sqlite3.Connection,
    now: datetime | None = None,
    lease_s: float = LOCK_LEASE_S,
) -> list[dict[str, Any]]:
    """Recover webhook rows whose delivery lock outlived its lease.

    A row left ``locked=1``/``sending`` means a process died mid-attempt
    (the attempt count was already incremented, so it is not incremented
    again). Reclaims are bounded by the same retry budget: re-queue with
    backoff, or terminal ``failed`` once attempts are exhausted. Every
    reclaim records an audit event — a redelivered webhook is
    at-least-once, dedupable by its ``X-Idempotency-Key``/payload id.
    """
    moment = now or _utcnow()
    cutoff = moment - timedelta(seconds=lease_s)
    results: list[dict[str, Any]] = []
    for note in store.stale_locked_deliveries(conn, cutoff):
        store.release_delivery_lock(conn, note.id)  # also clears the lease stamp
        if note.attempts >= MAX_DELIVERY_ATTEMPTS:
            reason = f"lease expired: reclaimed after {note.attempts} attempts (terminal)"
            store.set_notification_delivery(conn, note.id, "failed", note.attempts, reason)
            store.record_event(conn, note.project_id, "notification", note.id,
                               "notification.failed")
            results.append({"id": note.id, "status": "failed",
                            "attempts": note.attempts, "reclaimed": True})
            continue
        store.set_notification_delivery(
            conn, note.id, "queued", note.attempts,
            "lease expired: crashed attempt reclaimed, requeued",
        )
        store.set_notification_next_attempt(
            conn, note.id, moment + timedelta(seconds=_backoff_delay(note.attempts))
        )
        store.record_event(conn, note.project_id, "notification", note.id,
                           "notification.reclaimed")
        results.append({"id": note.id, "status": "queued",
                        "attempts": note.attempts, "reclaimed": True})
    return results


def sweep_due_deliveries(
    conn: sqlite3.Connection,
    now: datetime | None = None,
    transport: httpx.BaseTransport | None = None,
    resolver: Callable[[str], list[str]] | None = None,
) -> list[dict[str, Any]]:
    """Fire one attempt for each due, unlocked, queued webhook delivery.

    Abandoned (lease-expired) locks are reclaimed first, so a crashed
    delivery is retried without any manual unlock. Never raises on row
    errors: each outcome (delivered/queued/failed/reclaimed) is recorded
    with its attempts count. Deterministic order by next_attempt_at.
    """
    moment = now or _utcnow()
    results: list[dict[str, Any]] = list(reclaim_abandoned_deliveries(conn, moment))
    for note in store.due_deliveries(conn, moment):
        try:
            outcome = deliver_webhook(conn, note.id, transport=transport, resolver=resolver,
                                      now=moment)
            results.append({"id": note.id, "status": outcome.status,
                            "attempts": outcome.attempts})
        except (WebhookDeliveryError, WebhookLockedError) as exc:
            current = store.get_notification(conn, note.id)
            results.append({"id": note.id,
                            "status": current.status if current else "unknown",
                            "attempts": current.attempts if current else 0,
                            "error": str(exc)})
    return results


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
