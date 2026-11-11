from __future__ import annotations

import time
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
    r = client.post("/projects", json={"repository": "p5"}, headers=AUTH)
    assert r.status_code == 200, r.text
    return r.json()["id"]


def test_workspace_mkdir_rename_delete_and_conflict(client: TestClient):
    pid = _project(client)
    # create file
    w = client.put(f"/projects/{pid}/workspace/file", json={"path": "a/b.txt", "content": "one"}, headers=AUTH)
    assert w.status_code == 200, w.text
    meta = w.json()
    # mkdir
    m = client.post(f"/projects/{pid}/workspace/mkdir", json={"path": "docs"}, headers=AUTH)
    assert m.status_code == 200, m.text
    # rename/move
    r = client.post(f"/projects/{pid}/workspace/rename", json={"from_path": "a/b.txt", "to_path": "docs/b.txt"}, headers=AUTH)
    assert r.status_code == 200, r.text
    read = client.get(f"/projects/{pid}/workspace/file", params={"path": "docs/b.txt"}, headers=AUTH)
    assert read.status_code == 200
    assert read.json()["content"] == "one"
    # conflict on stale expected_mtime
    stale = read.json().get("modified", meta.get("modified"))
    # modify
    client.put(f"/projects/{pid}/workspace/file", json={"path": "docs/b.txt", "content": "two"}, headers=AUTH)
    time.sleep(0.01)
    conflict = client.put(
        f"/projects/{pid}/workspace/file",
        json={"path": "docs/b.txt", "content": "three", "expected_mtime": stale},
        headers=AUTH,
    )
    assert conflict.status_code == 409, conflict.text
    # delete file and dir
    d = client.request("DELETE", f"/projects/{pid}/workspace/path", json={"path": "docs/b.txt"}, headers=AUTH)
    assert d.status_code == 200, d.text
    d2 = client.request("DELETE", f"/projects/{pid}/workspace/path", json={"path": "docs"}, headers=AUTH)
    assert d2.status_code == 200, d2.text
    missing = client.get(f"/projects/{pid}/workspace/file", params={"path": "docs/b.txt"}, headers=AUTH)
    assert missing.status_code == 404
