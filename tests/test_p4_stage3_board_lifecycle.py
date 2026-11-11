"""P4 Stage 3 Item 5: board lifecycle hardening."""

from __future__ import annotations

from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from nerdbot import store
from nerdbot.api import create_app
from nerdbot.models import RunStatus, TaskStatus, VerificationStatus

TOKEN = "p4-stage3-token"
AUTH = {"Authorization": f"Bearer {TOKEN}"}


@pytest.fixture()
def client(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setenv("NERDBOT_TOKEN", TOKEN)
    monkeypatch.setenv("NERDBOT_DB", str(tmp_path / "nerdbot.db"))
    monkeypatch.setenv("NERDBOT_DATA", str(tmp_path / "data"))
    monkeypatch.delenv("NERDBOT_STATIC_DIR", raising=False)
    with TestClient(create_app()) as c:
        yield c


def _project(client: TestClient) -> str:
    r = client.post("/projects", json={"repository": "p"}, headers=AUTH)
    assert r.status_code == 200, r.text
    return r.json()["id"]


def _board(client: TestClient, project_id: str, name: str = "b") -> str:
    r = client.post("/boards", json={"name": name, "project_id": project_id}, headers=AUTH)
    assert r.status_code == 200, r.text
    return r.json()["id"]


def test_board_delete_detaches_tasks_preserves_history_and_cleans_refs(client: TestClient, tmp_path: Path):
    p = _project(client)
    b = _board(client, p)
    b2 = _board(client, p, "b2")
    t = client.post(f"/projects/{p}/tasks", json={"description": "t", "board_id": b}, headers=AUTH).json()
    assert t["board_id"] == b
    # create message targeted to board so inbox ref cleanup applies
    m = client.post(f"/boards/{b2}/messages", json={"content": "hi", "to_board_id": b}, headers=AUTH)
    assert m.status_code == 200, m.text

    db = str(tmp_path / "nerdbot.db")
    conn = store.connect(db)
    try:
        run = store.create_run(conn, t["id"])
        conn.execute("UPDATE runs SET status = ? WHERE id = ?", (RunStatus.RUNNING.value, run.id))
        conn.commit()
        store.finish_run(conn, run.id, RunStatus.SUCCEEDED, exit_code=0, output_excerpt="ok")
        store.create_artifact(conn, t["id"], run.id, "log", "/tmp/x", VerificationStatus.UNVERIFIED, summary="s")
        store.request_approval(conn, "task.run", "local", project_id=p, task_id=t["id"])
    finally:
        conn.close()

    r = client.delete(f"/boards/{b}", headers=AUTH)
    assert r.status_code == 200, r.text

    detail = client.get(f"/tasks/{t['id']}", headers=AUTH).json()
    assert detail["task"]["board_id"] == ""
    assert len(detail["runs"]) == 1
    assert len(detail["artifacts"]) == 1
    assert len(detail["approvals"]) == 1

    conn = store.connect(db)
    try:
        rows = conn.execute(
            "SELECT * FROM board_messages WHERE board_id = ? OR to_board_id = ?",
            (b, b),
        ).fetchall()
        assert rows == []
    finally:
        conn.close()
