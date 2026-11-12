from __future__ import annotations

from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from nerdbot.api import create_app

TOKEN = "p5-token"
AUTH = {"Authorization": f"Bearer {TOKEN}"}


@pytest.fixture()
def client(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setenv("NERDBOT_TOKEN", TOKEN)
    monkeypatch.setenv("NERDBOT_DB", str(tmp_path / "os.db"))
    monkeypatch.setenv("NERDBOT_DATA", str(tmp_path / "data"))
    with TestClient(create_app()) as c:
        yield c


def _project(client: TestClient) -> str:
    r = client.post("/projects", json={"repository": "p5git"}, headers=AUTH)
    assert r.status_code == 200, r.text
    return r.json()["id"]


def test_workspace_git_status_commit_and_rollback(client: TestClient):
    pid = _project(client)
    # create change
    w = client.put(f"/projects/{pid}/workspace/file", json={"path": "a.txt", "content": "hi"}, headers=AUTH)
    assert w.status_code == 200, w.text
    st = client.get(f"/projects/{pid}/workspace/git/status", headers=AUTH)
    assert st.status_code == 200, st.text
    assert st.json()["dirty"] is True
    # commit
    c = client.post(f"/projects/{pid}/workspace/git/commit", json={"message": "add a"}, headers=AUTH)
    assert c.status_code == 200, c.text
    assert c.json().get("committed") is True
    st2 = client.get(f"/projects/{pid}/workspace/git/status", headers=AUTH)
    assert st2.json()["dirty"] is False
    log = client.get(f"/projects/{pid}/workspace/git/log", headers=AUTH)
    assert log.status_code == 200
    assert any("add a" in cm.get("subject", "") for cm in log.json().get("commits", []))
    # modify and rollback uncommitted
    client.put(f"/projects/{pid}/workspace/file", json={"path": "a.txt", "content": "bye"}, headers=AUTH)
    rb = client.post(f"/projects/{pid}/workspace/git/rollback-uncommitted", headers=AUTH)
    assert rb.status_code == 200, rb.text
    read = client.get(f"/projects/{pid}/workspace/file", params={"path": "a.txt"}, headers=AUTH)
    assert read.json()["content"] == "hi"
