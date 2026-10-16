"""Webhook-out delivery: mock transport only, no live network."""

from __future__ import annotations

import json
import os

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
    sleeps: list[float] = []
    calls = {"n": 0}

    def flaky(request: httpx.Request) -> httpx.Response:
        calls["n"] += 1
        return httpx.Response(500 if calls["n"] < 3 else 200, text="x")

    note = store.create_notification(conn, pid, "webhook-out", "x")
    done = notify_mod.deliver_webhook(conn, note.id, transport=_transport(flaky),
                                      sleep=sleeps.append)
    assert done.status == "delivered" and done.attempts == 3
    assert sleeps == [1.0, 2.0]

    def down(request: httpx.Request) -> httpx.Response:
        return httpx.Response(503, text="x")

    note2 = store.create_notification(conn, pid, "webhook-out", "y")
    with pytest.raises(notify_mod.WebhookDeliveryError):
        notify_mod.deliver_webhook(conn, note2.id, transport=_transport(down),
                                   sleep=lambda s: None)
    stored = store.get_notification(conn, note2.id)
    assert stored is not None and stored.status == "failed" and stored.attempts == 3
    conn.close()


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
