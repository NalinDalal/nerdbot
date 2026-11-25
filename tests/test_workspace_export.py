from __future__ import annotations

import io
import os
import zipfile
from pathlib import Path

import pytest
from fastapi.testclient import TestClient


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


def _project(client):
    r = client.post("/projects", json={"repository": "A"}, headers=_headers())
    assert r.status_code == 200
    return r.json()["id"]


def test_workspace_export_skips_symlink_outside(client, tmp_path, monkeypatch):
    pid = _project(client)
    # write a normal file
    r = client.put(f"/projects/{pid}/workspace/file", json={"path":"ok.txt","content":"ok"}, headers=_headers())
    assert r.status_code == 200
    # find workspace root
    ws = client.get(f"/projects/{pid}/workspace", headers=_headers()).json()
    root = Path(ws["root"])
    outside = tmp_path / "outside-secret.txt"
    outside.write_text("secret", encoding="utf-8")
    (root / "leak.txt").symlink_to(outside)
    r = client.get(f"/projects/{pid}/workspace/export", headers=_headers())
    assert r.status_code == 200
    with zipfile.ZipFile(io.BytesIO(r.content)) as zf:
        names = zf.namelist()
        contents = {n: zf.read(n).decode("utf-8", "replace") for n in names}
    assert "ok.txt" in names
    assert "leak.txt" not in names
    assert "secret" not in "\n".join(contents.values())


def test_workspace_export_size_cap(client, monkeypatch):
    pid = _project(client)
    monkeypatch.setenv("NERDBOT_WORKSPACE_EXPORT_MAX_BYTES", "200")
    big = "x" * 1024
    r = client.put(f"/projects/{pid}/workspace/file", json={"path":"big.txt","content":big}, headers=_headers())
    assert r.status_code == 200
    r = client.get(f"/projects/{pid}/workspace/export", headers=_headers())
    assert r.status_code == 413
    assert "size cap" in r.json()["detail"].lower()
