"""Workspace chat binding contract tests (Odysseus-parity Stage A)."""

from __future__ import annotations

import json

import httpx
from cryptography.fernet import Fernet
from fastapi.testclient import TestClient

from nerdbot import store
from nerdbot.api import create_app
from nerdbot.models import ProviderKind


class _MockTransport(httpx.BaseTransport):
    def __init__(self, responses):
        self.responses = list(responses)
        self.calls = []

    def handle_request(self, request):
        self.calls.append(request)
        self.last_body = json.loads(request.content.decode()) if request.content else {}
        return httpx.Response(200, json=self.responses.pop(0))


def _client(tmp_path, monkeypatch):
    db = tmp_path / "test.db"
    data = tmp_path / "data"
    data.mkdir()
    monkeypatch.setenv("NERDBOT_DB", str(db))
    monkeypatch.setenv("NERDBOT_DATA", str(data))
    monkeypatch.setenv("NERDBOT_SECRET_KEY", Fernet.generate_key().decode())
    monkeypatch.setenv("NERDBOT_TOKEN", "test-token")
    return TestClient(create_app())


def _headers():
    return {"Authorization": "Bearer test-token"}


def _mk_provider(conn, project_id):
    return store.create_provider(
        conn,
        project_id,
        kind=ProviderKind.OPENAI_COMPATIBLE,
        name="mock",
        config={"base_url": "https://mock.local/v1", "api_key": "x", "model": "gpt-mock"},
    )


def test_workspace_browse_contract(tmp_path, monkeypatch):
    client = _client(tmp_path, monkeypatch)
    root = tmp_path / "wsroot"
    (root / "alpha").mkdir(parents=True)
    (root / "beta").mkdir()
    (root / ".hidden").mkdir()
    (root / "file.txt").write_text("x")
    r = client.get("/workspace/browse", params={"path": str(root)}, headers=_headers())
    assert r.status_code == 200
    data = r.json()
    assert data["path"] == str(root.resolve())
    assert "parent" in data
    assert [d["name"] for d in data["dirs"]] == ["alpha", "beta"]
    assert all("path" in d and "name" in d for d in data["dirs"])
    assert data["truncated"] is False
    assert data["selectable"] is True


def test_workspace_vet_contract(tmp_path, monkeypatch):
    client = _client(tmp_path, monkeypatch)
    root = tmp_path / "wsroot"
    root.mkdir()
    ok = client.get("/workspace/vet", params={"path": str(root)}, headers=_headers())
    assert ok.status_code == 200
    assert ok.json() == {"ok": True, "path": str(root.resolve())}
    bad = client.get("/workspace/vet", params={"path": str(tmp_path / "missing")}, headers=_headers())
    assert bad.status_code == 200
    assert bad.json() == {"ok": False, "path": None}


def test_workspace_default_contract(tmp_path, monkeypatch):
    default = tmp_path / "defaultws"
    default.mkdir()
    monkeypatch.setenv("NERDBOT_WORKSPACE_DEFAULT", str(default))
    client = _client(tmp_path, monkeypatch)
    r = client.get("/workspace/default", headers=_headers())
    assert r.status_code == 200
    assert r.json() == {"ok": True, "path": str(default.resolve())}


def test_chat_stream_rejects_invalid_workspace(tmp_path, monkeypatch):
    client = _client(tmp_path, monkeypatch)
    conn = store.connect(tmp_path / "test.db")
    try:
        project = store.create_project(conn, owner="local-owner", repository="repo")
        _mk_provider(conn, project.id)
        thread = store.create_thread(conn, project.id, title="t")
        thread_id = thread.id
    finally:
        conn.close()

    from nerdbot import chat as chat_mod

    def should_not_run(*args, **kwargs):
        raise AssertionError("chat should not run for invalid workspace")

    monkeypatch.setattr(chat_mod, "chat_stream_with_tools", should_not_run)

    bad = str(tmp_path / "missing-workspace")
    with client.stream(
        "POST",
        f"/threads/{thread_id}/chat/stream",
        headers=_headers(),
        json={"content": "hi", "workspace": bad},
    ) as r:
        body = "".join(r.iter_text())
    assert r.status_code == 200
    assert '"kind": "workspace_rejected"' in body
    assert "missing-workspace" in body


def test_chat_complete_rejects_invalid_workspace(tmp_path, monkeypatch):
    client = _client(tmp_path, monkeypatch)
    conn = store.connect(tmp_path / "test.db")
    try:
        project = store.create_project(conn, owner="local-owner", repository="repo")
        _mk_provider(conn, project.id)
        thread = store.create_thread(conn, project.id, title="t")
        thread_id = thread.id
    finally:
        conn.close()

    from nerdbot import chat as chat_mod

    def should_not_run(*args, **kwargs):
        raise AssertionError("chat should not run for invalid workspace")

    monkeypatch.setattr(chat_mod, "chat_complete_with_tools", should_not_run)

    bad = str(tmp_path / "missing-workspace")
    r = client.post(
        f"/threads/{thread_id}/chat",
        headers=_headers(),
        json={"content": "hi", "workspace": bad},
    )
    assert r.status_code == 400
    assert r.json()["detail"]["code"] == "workspace_rejected"
    assert r.json()["detail"]["workspace"] == bad
