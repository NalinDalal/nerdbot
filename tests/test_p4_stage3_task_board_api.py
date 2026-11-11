"""P4 Stage 3 Item 2: task-board attach/detach/move API and service contracts."""

from __future__ import annotations

import os
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
    resp = client.post("/projects", json={"repository": "p"}, headers=AUTH)
    assert resp.status_code == 200, resp.text
    return resp.json()["id"]


def _board(client: TestClient, project_id: str, name: str = "b") -> str:
    resp = client.post("/boards", json={"name": name, "project_id": project_id}, headers=AUTH)
    assert resp.status_code == 200, resp.text
    return resp.json()["id"]


def _task(client: TestClient, project_id: str, **body) -> dict:
    resp = client.post(f"/projects/{project_id}/tasks", json={"description": "t", **body}, headers=AUTH)
    assert resp.status_code == 200
    return resp.json()


def test_create_task_with_board_id_same_project(client: TestClient):
    p = _project(client)
    b = _board(client, p)
    task = _task(client, p, board_id=b)
    assert task["board_id"] == b
    # visible in task detail
    got = client.get(f"/tasks/{task['id']}", headers=AUTH)
    assert got.status_code == 200
    assert got.json()["task"]["board_id"] == b


def test_create_task_with_cross_project_board_rejected(client: TestClient):
    p1 = _project(client)
    p2 = _project(client)
    b2 = _board(client, p2)
    resp = client.post(f"/projects/{p1}/tasks", json={"description": "t", "board_id": b2}, headers=AUTH)
    assert resp.status_code == 400


def test_patch_task_attach_detach_move_and_idempotent(client: TestClient):
    p = _project(client)
    b1 = _board(client, p, "b1")
    b2 = _board(client, p, "b2")
    task = _task(client, p)
    assert task["board_id"] == ""

    # attach
    r = client.patch(f"/tasks/{task['id']}", json={"board_id": b1}, headers=AUTH)
    assert r.status_code == 200
    assert r.json()["board_id"] == b1
    # move
    r = client.patch(f"/tasks/{task['id']}", json={"board_id": b2}, headers=AUTH)
    assert r.status_code == 200
    assert r.json()["board_id"] == b2
    # detach
    r = client.patch(f"/tasks/{task['id']}", json={"board_id": ""}, headers=AUTH)
    assert r.status_code == 200
    assert r.json()["board_id"] == ""
    # idempotent detach
    r = client.patch(f"/tasks/{task['id']}", json={"board_id": ""}, headers=AUTH)
    assert r.status_code == 200
    assert r.json()["board_id"] == ""


def test_patch_task_rejects_cross_project_and_unknown_board(client: TestClient):
    p1 = _project(client)
    p2 = _project(client)
    b2 = _board(client, p2)
    task = _task(client, p1)
    r = client.patch(f"/tasks/{task['id']}", json={"board_id": b2}, headers=AUTH)
    assert r.status_code == 400
    r = client.patch(f"/tasks/{task['id']}", json={"board_id": "brd_missing"}, headers=AUTH)
    assert r.status_code == 404


def test_patch_task_rejects_inflight_reassignment_preserves_state(client: TestClient, tmp_path: Path):
    p = _project(client)
    b1 = _board(client, p, "b1")
    b2 = _board(client, p, "b2")
    task = _task(client, p, board_id=b1)
    # force RUNNING via store (API doesn't expose direct status set)
    db = str(tmp_path / "nerdbot.db")
    conn = store.connect(db)
    try:
        store.set_task_status(conn, task["id"], TaskStatus.RUNNING)
    finally:
        conn.close()

    r = client.patch(f"/tasks/{task['id']}", json={"board_id": b2}, headers=AUTH)
    assert r.status_code == 400
    got = client.get(f"/tasks/{task['id']}", headers=AUTH).json()["task"]
    assert got["board_id"] == b1
    assert got["status"] == TaskStatus.RUNNING.value

    # detach also rejected
    r = client.patch(f"/tasks/{task['id']}", json={"board_id": ""}, headers=AUTH)
    assert r.status_code == 400


def test_patch_task_board_preserves_dependencies_runs_artifacts(client: TestClient, tmp_path: Path):
    p = _project(client)
    b1 = _board(client, p, "b1")
    b2 = _board(client, p, "b2")
    dep = _task(client, p, description="dep")
    task = _task(client, p, description="main", dependencies=[dep["id"]], command="echo hi", board_id=b1)
    db = str(tmp_path / "nerdbot.db")
    conn = store.connect(db)
    try:
        run = store.create_run(conn, task["id"])
        conn.execute("UPDATE runs SET status = ? WHERE id = ?", (RunStatus.RUNNING.value, run.id))
        conn.commit()
        store.finish_run(conn, run.id, RunStatus.SUCCEEDED, exit_code=0, output_excerpt="ok")
        store.create_artifact(conn, task["id"], run.id, "log", "/tmp/x", VerificationStatus.UNVERIFIED, summary="s")
        # move while not active (DONE is allowed)
        store.set_task_status(conn, task["id"], TaskStatus.RUNNING)
        store.set_task_status(conn, task["id"], TaskStatus.DONE)
    finally:
        conn.close()

    r = client.patch(f"/tasks/{task['id']}", json={"board_id": b2}, headers=AUTH)
    assert r.status_code == 200
    detail = client.get(f"/tasks/{task['id']}", headers=AUTH).json()
    assert detail["task"]["board_id"] == b2
    assert detail["task"]["dependencies"] == [dep["id"]]
    assert detail["task"]["command"] == "echo hi"
    assert len(detail["runs"]) == 1
    assert len(detail["artifacts"]) == 1


def test_task_without_board_backward_compatible(client: TestClient):
    p = _project(client)
    task = _task(client, p)
    assert task["board_id"] == ""
    r = client.patch(f"/tasks/{task['id']}", json={"description": "updated"}, headers=AUTH)
    assert r.status_code == 200
    assert r.json()["board_id"] == ""
    assert r.json()["description"] == "updated"
