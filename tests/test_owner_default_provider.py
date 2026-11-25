from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from nerdbot import store
from nerdbot.auth import PRINCIPAL
from nerdbot.models import ProviderKind, ProviderStatus


def _headers():
    return {"Authorization": "Bearer dev-token-change-me"}


@pytest.fixture()
def client(monkeypatch, tmp_path):
    db = tmp_path / "t.db"
    data = tmp_path / "data"
    data.mkdir()
    monkeypatch.setenv("NERDBOT_DB", str(db))
    monkeypatch.setenv("NERDBOT_DATA", str(data))
    monkeypatch.setenv("NERDBOT_INSECURE_DEV_TOKEN", "1")
    from nerdbot.api import create_app
    app = create_app()
    with TestClient(app) as c:
        yield c


def test_new_project_uses_owner_default_provider(client):
    r = client.post("/projects", json={"repository": "A"}, headers=_headers())
    assert r.status_code == 200
    p1 = r.json()["id"]
    r = client.post(f"/projects/{p1}/providers", json={"kind":"mock","name":"m1","config":{}}, headers=_headers())
    assert r.status_code == 200
    prov = r.json()
    r = client.put("/settings/owner-default-provider", json={"provider_id": prov["id"]}, headers=_headers())
    assert r.status_code == 200

    r = client.post("/projects", json={"repository": "B"}, headers=_headers())
    assert r.status_code == 200
    p2 = r.json()["id"]
    r = client.get(f"/projects/{p2}/providers", headers=_headers())
    assert r.status_code == 200
    provs = r.json()["providers"]
    assert len(provs) == 1
    assert provs[0]["name"] == "m1"
    assert provs[0]["kind"] == "mock"


def test_new_project_no_default_has_no_provider_and_chat_fails_clearly(client):
    r = client.post("/projects", json={"repository": "A"}, headers=_headers())
    p1 = r.json()["id"]
    r = client.get(f"/projects/{p1}/providers", headers=_headers())
    assert r.json()["providers"] == []

    # create thread and chat
    r = client.post(f"/projects/{p1}/threads", json={"title":"t"}, headers=_headers())
    tid = r.json()["id"]
    r = client.post(f"/threads/{tid}/chat", json={"content":"hello"}, headers=_headers())
    assert r.status_code == 400
    detail = r.json()["detail"].lower()
    assert "provider" in detail
    assert "default" in detail or "configure" in detail


def test_another_users_provider_cannot_be_default(client, monkeypatch, tmp_path):
    # simulate two owners by direct store calls using same DB
    from nerdbot.api import create_app
    # client uses env db; access through app state is harder, so use store directly.
    db = tmp_path / "t2.db"
    data = tmp_path / "d2"
    data.mkdir()
    monkeypatch.setenv("NERDBOT_DB", str(db))
    monkeypatch.setenv("NERDBOT_DATA", str(data))
    monkeypatch.setenv("NERDBOT_INSECURE_DEV_TOKEN", "1")
    app = create_app()
    with TestClient(app) as c:
        r = c.post("/projects", json={"repository":"mine"}, headers=_headers())
        p = r.json()["id"]
        r = c.post(f"/projects/{p}/providers", json={"kind":"mock","name":"m","config":{}}, headers=_headers())
        prov = r.json()
    # directly insert other owner's project/provider
    conn = store.connect(str(db))
    other_proj = store.create_project(conn, owner="other-user", repository="other")
    other_prov = store.create_provider(conn, other_proj.id, kind=ProviderKind.MOCK, name="other", config={})
    conn.close()

    app2 = create_app()
    with TestClient(app2) as c:
        r = c.put("/settings/owner-default-provider", json={"provider_id": other_prov.id}, headers=_headers())
        assert r.status_code == 404
