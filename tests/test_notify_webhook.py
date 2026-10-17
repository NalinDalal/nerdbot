"""Webhook-out delivery: mock transport only, no live network."""

from __future__ import annotations

import json
import os
from datetime import UTC, datetime, timedelta

import httpx
import pytest
from fastapi.testclient import TestClient

from nerdbot import notify as notify_mod
from nerdbot import store
from nerdbot.api import create_app

TOKEN = "webhook-token"
AUTH = {"Authorization": f"Bearer {TOKEN}"}
TARGET = "http://93.184.216.34/hook"


@pytest.fixture()
def app_client(tmp_path, monkeypatch):
    monkeypatch.setenv("NERDBOT_TOKEN", TOKEN)
    monkeypatch.setenv("NERDBOT_DB", str(tmp_path / "wh.db"))
    monkeypatch.setenv("NERDBOT_DATA", str(tmp_path / "data"))
    return TestClient(create_app())


def _project(client: TestClient) -> str:
    r = client.post("/projects", json={"repository": "w"}, headers=AUTH)
    assert r.status_code == 200, r.text
    return r.json()["id"]


def _transport(handler) -> httpx.MockTransport:  # type: ignore[no-untyped-def]
    return httpx.MockTransport(handler)


def test_target_crud_validation(app_client: TestClient) -> None:
    pid = _project(app_client)
    r = app_client.post(f"/projects/{pid}/webhook-targets", json={"url": TARGET}, headers=AUTH)
    assert r.status_code == 200, r.text
    assert r.json()["url"] == TARGET
    for bad in ("http://169.254.169.254/", "http://localhost:9/", "ftp://x/y", "", "notaurl"):
        r = app_client.post(f"/projects/{pid}/webhook-targets", json={"url": bad}, headers=AUTH)
        assert r.status_code == 400, bad
    r = app_client.get(f"/projects/{pid}/webhook-targets", headers=AUTH)
    assert len(r.json()["targets"]) == 1
    tid = r.json()["targets"][0]["id"]
    assert app_client.delete(f"/webhook-targets/{tid}", headers=AUTH).status_code == 200
    assert app_client.delete("/webhook-targets/wht_nope", headers=AUTH).status_code == 404
    bad = {"Authorization": "Bearer wrong"}
    assert app_client.post(f"/projects/{pid}/webhook-targets", json={"url": TARGET},
                           headers=bad).status_code == 403


def test_send_success_records_attempt(app_client: TestClient) -> None:
    pid = _project(app_client)
    app_client.post(f"/projects/{pid}/webhook-targets", json={"url": TARGET}, headers=AUTH)
    # Swap in a mock transport via direct deliver path asserted below; the API
    # path needs a reachable target, so exercise row creation here and delivery
    # through store-level deliver with mock transport.
    conn = store.connect(os.environ["NERDBOT_DB"])
    note = store.create_notification(conn, pid, "webhook-out", "ping",
                                     {"token": "SECRET", "msg": "hi"})
    assert note.payload == {"token": "[redacted]", "msg": "hi"}

    seen: dict = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen["auth"] = "Authorization" in request.headers
        seen["idem"] = request.headers.get("X-Idempotency-Key")
        seen["body"] = json.loads(request.content.decode())
        return httpx.Response(200, text="ok")

    delivered = notify_mod.deliver_webhook(conn, note.id, transport=_transport(handler))
    assert delivered.status == "delivered" and delivered.attempts == 1
    assert seen["auth"] is False
    assert seen["idem"] == note.id
    assert seen["body"] == {"id": note.id, "kind": "ping",
                            "payload": {"token": "[redacted]", "msg": "hi"}}
    conn.close()


def test_no_targets_configured(app_client: TestClient) -> None:
    pid = _project(app_client)
    r = app_client.post(f"/projects/{pid}/notify",
                        json={"channel": "webhook-out", "kind": "x"}, headers=AUTH)
    assert r.status_code == 400 and "no webhook targets" in r.json()["detail"]


def test_redirect_to_private_blocked(app_client: TestClient) -> None:
    pid = _project(app_client)
    app_client.post(f"/projects/{pid}/webhook-targets", json={"url": TARGET}, headers=AUTH)
    conn = store.connect(os.environ["NERDBOT_DB"])
    note = store.create_notification(conn, pid, "webhook-out", "x")

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(302, headers={"location": "http://169.254.169.254/"})

    with pytest.raises(notify_mod.WebhookDeliveryError):
        notify_mod.deliver_webhook(conn, note.id, transport=_transport(handler))
    assert store.get_notification(conn, note.id).status == "failed"  # type: ignore[union-attr]
    conn.close()


def test_retry_then_success_and_exhaustion(app_client: TestClient) -> None:

    pid = _project(app_client)
    app_client.post(f"/projects/{pid}/webhook-targets", json={"url": TARGET}, headers=AUTH)
    conn = store.connect(os.environ["NERDBOT_DB"])
    calls = {"n": 0}

    def flaky(request: httpx.Request) -> httpx.Response:
        calls["n"] += 1
        return httpx.Response(500 if calls["n"] < 3 else 200, text="x")

    transport = _transport(flaky)
    note = store.create_notification(conn, pid, "webhook-out", "x")
    # First inline attempt fails transiently: queued with a future retry time.
    first = notify_mod.deliver_webhook(conn, note.id, transport=transport)
    assert first.status == "queued" and first.attempts == 1
    assert first.next_attempt_at is not None
    assert first.next_attempt_at > datetime.now(UTC) - timedelta(seconds=1)
    # Sweep before due: nothing fires, no new HTTP hit.
    assert notify_mod.sweep_due_deliveries(conn, transport=transport) == []
    assert calls["n"] == 1
    # Sweep after due: second attempt fails, re-queued with a later time.
    second = notify_mod.sweep_due_deliveries(
        conn, now=first.next_attempt_at + timedelta(seconds=1), transport=transport)
    assert len(second) == 1 and second[0]["status"] == "queued"
    assert calls["n"] == 2
    # Third attempt succeeds; total HTTP hits == attempts.
    third = notify_mod.sweep_due_deliveries(
        conn, now=datetime.now(UTC) + timedelta(hours=1), transport=transport)
    assert third[0]["status"] == "delivered" and third[0]["attempts"] == 3
    assert calls["n"] == 3

    def down(request: httpx.Request) -> httpx.Response:
        return httpx.Response(503, text="x")

    note2 = store.create_notification(conn, pid, "webhook-out", "y")
    far = datetime.now(UTC)
    for _ in range(2):
        result = notify_mod.deliver_webhook(conn, note2.id, transport=_transport(down), now=far)
        assert result.status == "queued"
        far = result.next_attempt_at + timedelta(seconds=1)  # type: ignore[operator]
    with pytest.raises(notify_mod.WebhookDeliveryError):
        notify_mod.deliver_webhook(conn, note2.id, transport=_transport(down), now=far)
    stored = store.get_notification(conn, note2.id)
    assert stored is not None and stored.status == "failed" and stored.attempts == 3
    conn.close()


def test_sweep_skips_locked_future_and_terminal(app_client: TestClient) -> None:

    pid = _project(app_client)
    app_client.post(f"/projects/{pid}/webhook-targets", json={"url": TARGET}, headers=AUTH)
    conn = store.connect(os.environ["NERDBOT_DB"])
    calls = {"n": 0}

    def handler(request: httpx.Request) -> httpx.Response:
        calls["n"] += 1
        return httpx.Response(200, text="ok")

    transport = _transport(handler)
    due = store.create_notification(conn, pid, "webhook-out", "due")
    store.set_notification_next_attempt(conn, due.id, datetime.now(UTC) - timedelta(seconds=1))
    future = store.create_notification(conn, pid, "webhook-out", "future")
    store.set_notification_next_attempt(conn, future.id, datetime.now(UTC) + timedelta(days=1))
    locked = store.create_notification(conn, pid, "webhook-out", "locked")
    assert store.claim_delivery_lock(conn, locked.id) is True
    done = store.create_notification(conn, pid, "webhook-out", "done")
    notify_mod.deliver_webhook(conn, done.id, transport=transport)
    failed = store.create_notification(conn, pid, "webhook-out", "gone")
    store.set_notification_delivery(conn, failed.id, "failed", 3)

    results = notify_mod.sweep_due_deliveries(conn, transport=transport)
    assert [r["id"] for r in results] == [due.id]
    assert calls["n"] == 2  # one for done's inline delivery, one for due's sweep
    # Locked row untouched; explicit unlock then fires via retry endpoint path.
    assert store.get_notification(conn, locked.id).status == "queued"  # type: ignore[union-attr]
    store.set_notification_next_attempt(conn, locked.id, datetime.now(UTC) - timedelta(seconds=1))
    store.release_delivery_lock(conn, locked.id)
    results = notify_mod.sweep_due_deliveries(conn, transport=transport)
    assert [r["id"] for r in results] == [locked.id]
    conn.close()


def test_locked_deliver_conflicts_and_unlock(app_client: TestClient) -> None:
    pid = _project(app_client)
    app_client.post(f"/projects/{pid}/webhook-targets", json={"url": TARGET}, headers=AUTH)
    conn = store.connect(os.environ["NERDBOT_DB"])
    note = store.create_notification(conn, pid, "webhook-out", "x")
    conn.close()
    # Simulate a crashed worker holding the lock (direct row update).
    conn2 = store.connect(os.environ["NERDBOT_DB"])
    assert store.claim_delivery_lock(conn2, note.id) is True
    conn2.close()
    r = app_client.post(f"/notifications/{note.id}/deliver", headers=AUTH)
    assert r.status_code == 409
    r = app_client.post(f"/notifications/{note.id}/unlock", headers=AUTH)
    assert r.status_code == 200 and r.json() == {"id": note.id, "locked": False}
    bad = {"Authorization": "Bearer wrong"}
    assert app_client.post(f"/notifications/{note.id}/unlock", headers=bad).status_code == 403


def test_sweep_endpoint_empty(app_client: TestClient) -> None:
    _project(app_client)  # no due rows anywhere: sweep performs no HTTP
    r = app_client.post("/webhooks/sweep", headers=AUTH)
    assert r.status_code == 200 and r.json() == {"fired": []}
    bad = {"Authorization": "Bearer wrong"}
    assert app_client.post("/webhooks/sweep", headers=bad).status_code == 403


def test_idempotent_resend(app_client: TestClient) -> None:
    pid = _project(app_client)
    app_client.post(f"/projects/{pid}/webhook-targets", json={"url": TARGET}, headers=AUTH)
    conn = store.connect(os.environ["NERDBOT_DB"])
    note = store.create_notification(conn, pid, "webhook-out", "x")
    calls = {"n": 0}

    def handler(request: httpx.Request) -> httpx.Response:
        calls["n"] += 1
        return httpx.Response(200, text="ok")

    transport = _transport(handler)
    assert notify_mod.deliver_webhook(conn, note.id, transport=transport).status == "delivered"
    assert notify_mod.deliver_webhook(conn, note.id, transport=transport).status == "delivered"
    assert calls["n"] == 1  # second send performed no HTTP request
    conn.close()


def test_explicit_target_and_email_stub(app_client: TestClient) -> None:
    pid = _project(app_client)
    # Explicit private target must be rejected before any HTTP attempt
    # (no live network in tests).
    r = app_client.post(f"/projects/{pid}/notify",
                        json={"channel": "webhook-out", "kind": "x",
                              "target_url": "http://169.254.169.254/"},
                        headers=AUTH)
    assert r.status_code == 400 and "rejected" in r.json()["detail"]
    r = app_client.post(f"/projects/{pid}/notify",
                        json={"channel": "email", "kind": "x"}, headers=AUTH)
    assert r.status_code == 400 and "stub" in r.json()["detail"]


def _crash_mid_send(conn, note_id: str, attempts: int, crashed_at: datetime) -> None:
    """Simulate a worker death right after claiming + sending. No finally."""
    assert store.claim_delivery_lock(conn, note_id, now=crashed_at) is True
    store.set_notification_delivery(conn, note_id, "sending", attempts)


def test_abandoned_lock_reclaimed_and_redelivered(app_client: TestClient) -> None:

    pid = _project(app_client)
    app_client.post(f"/projects/{pid}/webhook-targets", json={"url": TARGET}, headers=AUTH)
    conn = store.connect(os.environ["NERDBOT_DB"])
    note = store.create_notification(conn, pid, "webhook-out", "crashed")
    crashed_at = datetime(2026, 1, 1, tzinfo=UTC)
    _crash_mid_send(conn, note.id, attempts=1, crashed_at=crashed_at)

    seen: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request.headers.get("X-Idempotency-Key") or "")
        return httpx.Response(200, text="ok")

    transport = _transport(handler)
    # Within the lease: left alone (still flagged sending, still locked).
    early = notify_mod.sweep_due_deliveries(
        conn, now=crashed_at + timedelta(seconds=notify_mod.LOCK_LEASE_S - 1),
        transport=transport)
    assert early == []
    live = store.get_notification(conn, note.id)
    assert live is not None and live.status == "sending" and live.locked is True
    # Past the lease: reclaimed to queued with backoff, exactly one audit event.
    late = crashed_at + timedelta(seconds=notify_mod.LOCK_LEASE_S + 1)
    results = notify_mod.sweep_due_deliveries(conn, now=late, transport=transport)
    assert results == [{"id": note.id, "status": "queued", "attempts": 1,
                        "reclaimed": True}]
    recovered = store.get_notification(conn, note.id)
    assert recovered is not None and recovered.status == "queued"
    assert recovered.locked is False and recovered.attempts == 1
    assert recovered.next_attempt_at == late + timedelta(seconds=1.0)
    events = [e.event_type for e in store.list_events(conn, pid)]
    assert events.count("notification.reclaimed") == 1
    # The next due sweep redelivers exactly once, same idempotency key.
    assert recovered.next_attempt_at is not None
    results = notify_mod.sweep_due_deliveries(
        conn, now=recovered.next_attempt_at + timedelta(seconds=1), transport=transport)
    assert results == [{"id": note.id, "status": "delivered", "attempts": 2}]
    assert seen == [note.id]
    conn.close()


def test_abandoned_lock_at_max_attempts_fails(app_client: TestClient) -> None:

    pid = _project(app_client)
    app_client.post(f"/projects/{pid}/webhook-targets", json={"url": TARGET}, headers=AUTH)
    conn = store.connect(os.environ["NERDBOT_DB"])
    note = store.create_notification(conn, pid, "webhook-out", "maxed")
    crashed_at = datetime(2026, 1, 1, tzinfo=UTC)
    _crash_mid_send(conn, note.id, attempts=notify_mod.MAX_DELIVERY_ATTEMPTS,
                    crashed_at=crashed_at)
    calls = {"n": 0}

    def never(request: httpx.Request) -> httpx.Response:
        calls["n"] += 1
        return httpx.Response(200, text="ok")

    results = notify_mod.sweep_due_deliveries(
        conn, now=crashed_at + timedelta(seconds=notify_mod.LOCK_LEASE_S + 1),
        transport=_transport(never))
    assert results == [{"id": note.id, "status": "failed",
                        "attempts": notify_mod.MAX_DELIVERY_ATTEMPTS,
                        "reclaimed": True}]
    stored = store.get_notification(conn, note.id)
    assert stored is not None and stored.status == "failed" and stored.locked is False
    events = [e.event_type for e in store.list_events(conn, pid)]
    assert events.count("notification.failed") == 1
    assert calls["n"] == 0  # terminal rows are never sent again
    conn.close()


def test_claim_crash_window_reclaimed(app_client: TestClient) -> None:
    # Crash between claim and the sending write: row is locked + queued
    # with attempts unincremented. The sweep must still reclaim it.
    from datetime import UTC, datetime, timedelta

    pid = _project(app_client)
    app_client.post(f"/projects/{pid}/webhook-targets", json={"url": TARGET}, headers=AUTH)
    conn = store.connect(os.environ["NERDBOT_DB"])
    note = store.create_notification(conn, pid, "webhook-out", "claim-crash")
    crashed_at = datetime(2026, 1, 1, tzinfo=UTC)
    assert store.claim_delivery_lock(conn, note.id, now=crashed_at) is True
    conn.execute("UPDATE notifications SET status = 'queued' WHERE id = ?", (note.id,))
    conn.commit()

    def never(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, text="ok")

    gone = crashed_at + timedelta(seconds=notify_mod.LOCK_LEASE_S + 1)
    results = notify_mod.sweep_due_deliveries(conn, now=gone, transport=_transport(never))
    assert results == [{"id": note.id, "status": "queued", "attempts": 0,
                        "reclaimed": True}]
    stored = store.get_notification(conn, note.id)
    assert stored is not None and stored.locked is False and stored.attempts == 0
    assert [e.event_type for e in store.list_events(conn, pid)].count(
        "notification.reclaimed") == 1
    conn.close()


def test_legacy_locked_without_stamp_reclaimed(app_client: TestClient) -> None:
    from datetime import UTC, datetime, timedelta

    pid = _project(app_client)
    app_client.post(f"/projects/{pid}/webhook-targets", json={"url": TARGET}, headers=AUTH)
    conn = store.connect(os.environ["NERDBOT_DB"])
    note = store.create_notification(conn, pid, "webhook-out", "legacy")
    # Pre-upgrade row: locked, sending, but no lease stamp at all.
    conn.execute("UPDATE notifications SET locked = 1, status = 'sending',"
                 " attempts = 1 WHERE id = ?", (note.id,))
    conn.commit()

    def never(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, text="ok")

    gone = datetime.now(UTC) + timedelta(seconds=notify_mod.LOCK_LEASE_S + 1)
    results = notify_mod.sweep_due_deliveries(conn, now=gone, transport=_transport(never))
    assert results == [{"id": note.id, "status": "queued", "attempts": 1,
                        "reclaimed": True}]
    conn.close()


def test_release_is_lease_compare_and_set(app_client: TestClient) -> None:
    from datetime import UTC, datetime

    pid = _project(app_client)
    conn = store.connect(os.environ["NERDBOT_DB"])
    note = store.create_notification(conn, pid, "webhook-out", "cas")
    t1 = datetime(2026, 1, 1, tzinfo=UTC)
    t2 = datetime(2026, 1, 1, 0, 1, tzinfo=UTC)
    assert store.claim_delivery_lock(conn, note.id, now=t1) is True
    # Stale finisher late by one full lease: armed with the OLD stamp.
    store.release_delivery_lock(conn, note.id)          # real reclaim (override)
    assert store.claim_delivery_lock(conn, note.id, now=t2) is True  # new claimant
    store.release_delivery_lock(conn, note.id, locked_at=t1)  # stale finally (CAS)
    still = store.get_notification(conn, note.id)
    assert still is not None and still.locked is True  # newer claim survives
    store.release_delivery_lock(conn, note.id, locked_at=t2)  # correct finisher
    done = store.get_notification(conn, note.id)
    assert done is not None and done.locked is False and done.locked_at is None
    conn.close()


def test_locked_at_migration_on_old_table(tmp_path) -> None:

    import sqlite3 as _sqlite3

    db = str(tmp_path / "oldlock.db")
    raw = _sqlite3.connect(db)
    raw.execute("CREATE TABLE projects (id TEXT PRIMARY KEY, owner TEXT NOT NULL,"
                " repository TEXT NOT NULL DEFAULT '', config TEXT NOT NULL DEFAULT '{}')")
    raw.execute("INSERT INTO projects (id, owner) VALUES ('prj_1', 'o')")
    raw.execute("CREATE TABLE notifications (id TEXT PRIMARY KEY,"
                " project_id TEXT NOT NULL REFERENCES projects(id),"
                " channel TEXT NOT NULL DEFAULT 'outbox', kind TEXT NOT NULL DEFAULT '',"
                " payload TEXT NOT NULL DEFAULT '{}', status TEXT NOT NULL DEFAULT 'queued',"
                " created_at TEXT NOT NULL)")
    raw.execute("INSERT INTO notifications (id, project_id, kind, created_at)"
                " VALUES ('ntf_1', 'prj_1', 'x', '2026-01-01T00:00:00+00:00')")
    raw.commit()
    raw.close()
    conn = store.connect(db)  # migration adds target_url/attempts/locked/locked_at
    try:
        note = store.get_notification(conn, "ntf_1")
        assert note is not None
        assert note.locked is False and note.locked_at is None
        crashed_at = datetime(2026, 1, 1, tzinfo=UTC)
        assert store.claim_delivery_lock(conn, "ntf_1", now=crashed_at) is True
        relocked = store.get_notification(conn, "ntf_1")
        assert relocked is not None
        assert relocked.locked is True and relocked.locked_at == crashed_at
        # Phase 5(c): the last_error column exists on migrated old tables too.
        assert relocked.last_error == ""
    finally:
        conn.close()


def test_transient_failure_keeps_reason_then_success_clears_it(app_client) -> None:
    pid = _project(app_client)
    app_client.post(f"/projects/{pid}/webhook-targets", json={"url": TARGET}, headers=AUTH)
    conn = store.connect(os.environ["NERDBOT_DB"])
    try:
        note = store.create_notification(conn, pid, "webhook-out", "x")
        responses = iter([httpx.Response(503, text="busy"), httpx.Response(200, text="ok")])

        def flaky(request: httpx.Request) -> httpx.Response:
            return next(responses)

        after_fail = notify_mod.deliver_webhook(conn, note.id, transport=_transport(flaky))
        assert after_fail.status == "queued" and after_fail.attempts == 1
        assert "transient upstream status 503" in after_fail.last_error
        assert after_fail.next_attempt_at is not None  # waits for the sweep

        after_ok = notify_mod.deliver_webhook(
            conn, note.id, transport=_transport(lambda r: httpx.Response(200, text="ok"))
        )
        assert after_ok.status == "delivered"
        assert after_ok.last_error == ""  # success clears the diagnostic trail
    finally:
        conn.close()


def test_terminal_refusal_records_reason(app_client) -> None:
    pid = _project(app_client)
    app_client.post(f"/projects/{pid}/webhook-targets", json={"url": TARGET}, headers=AUTH)
    conn = store.connect(os.environ["NERDBOT_DB"])
    try:
        note = store.create_notification(conn, pid, "webhook-out", "x")

        def redirect_private(request: httpx.Request) -> httpx.Response:
            return httpx.Response(302, headers={"location": "http://169.254.169.254/"})

        with pytest.raises(notify_mod.WebhookDeliveryError):
            notify_mod.deliver_webhook(conn, note.id, transport=_transport(redirect_private))
        failed = store.get_notification(conn, note.id)
        assert failed is not None and failed.status == "failed"
        # The blocked reason names the actual refusal and the refused host:
        # that context is what makes a failed delivery diagnosable.
        assert failed.last_error and "blocked" in failed.last_error.lower()
        assert "169.254" in failed.last_error  # the redirect destination is shown
        assert len(failed.last_error) <= 500  # bounded, never megabytes of noise
    finally:
        conn.close()


def test_reclaim_records_reclaim_reason(app_client) -> None:
    pid = _project(app_client)
    app_client.post(f"/projects/{pid}/webhook-targets", json={"url": TARGET}, headers=AUTH)
    conn = store.connect(os.environ["NERDBOT_DB"])
    try:
        note = store.create_notification(conn, pid, "webhook-out", "x")
        stale = datetime.now(UTC) - timedelta(seconds=notify_mod.LOCK_LEASE_S * 4)
        assert store.claim_delivery_lock(conn, note.id, now=stale) is True
        conn.execute("UPDATE notifications SET status = 'sending' WHERE id = ?", (note.id,))
        conn.commit()
        conn.execute("UPDATE notifications SET locked_at = ? WHERE id = ?",
                     (stale.isoformat(), note.id))
        conn.commit()

        outcomes = notify_mod.reclaim_abandoned_deliveries(conn)
        assert len(outcomes) == 1 and outcomes[0]["reclaimed"] is True
        reclaimed = store.get_notification(conn, note.id)
        assert reclaimed is not None
        assert reclaimed.status in ("queued", "failed")
        assert reclaimed.locked is False  # lease released
        assert "lease expired" in reclaimed.last_error

        # Terminal branch: exhausted attempts fail with a reclaim reason too.
        conn.execute("UPDATE notifications SET attempts = ? WHERE id = ?",
                     (notify_mod.MAX_DELIVERY_ATTEMPTS, note.id))
        conn.commit()
        stale2 = datetime.now(UTC) - timedelta(seconds=notify_mod.LOCK_LEASE_S * 4)
        assert store.claim_delivery_lock(conn, note.id, now=stale2) is True
        conn.execute("UPDATE notifications SET status = 'sending' WHERE id = ?", (note.id,))
        conn.commit()
        conn.execute("UPDATE notifications SET locked_at = ? WHERE id = ?",
                     (stale2.isoformat(), note.id))
        conn.commit()
        outcomes = notify_mod.reclaim_abandoned_deliveries(conn)
        assert outcomes[0]["status"] == "failed"
        terminal = store.get_notification(conn, note.id)
        assert terminal is not None and terminal.status == "failed"
        assert "terminal" in terminal.last_error
    finally:
        conn.close()
