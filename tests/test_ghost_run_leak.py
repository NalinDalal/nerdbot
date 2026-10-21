"""A terminal (done) task must refuse a new run without leaking run rows.

Acceptance evidence (2026-10-21): ``POST /tasks/{id}/runs`` on a done task
created the run row (marked ``running``) and only then failed the task
status transition — the HTTP response was a clean 400 but a ghost
``running`` run stayed in the database forever, polluting the run history.
"""

from __future__ import annotations

import sqlite3

import pytest

from nerdbot import orchestrator, store
from nerdbot.models import TaskStatus


@pytest.fixture()
def conn() -> sqlite3.Connection:
    conn = store.connect(":memory:")
    yield conn
    conn.close()


def test_schedule_run_refuses_done_task_without_creating_a_row(conn) -> None:
    project = store.create_project(conn, owner="local-owner").id
    task = store.create_task(conn, project, "objective", command="echo hi")
    store.set_task_status(conn, task.id, TaskStatus.RUNNING)
    store.set_task_status(conn, task.id, TaskStatus.DONE)

    with pytest.raises(ValueError, match="use retry to run it again"):
        orchestrator.schedule_run(conn, task.id, data_dir=".")

    runs = conn.execute("SELECT * FROM runs WHERE task_id = ?", (task.id,)).fetchall()
    assert runs == [], "a refused run must not leave a ghost run row"
    assert store.get_task(conn, task.id).status == TaskStatus.DONE


def test_run_endpoint_maps_the_refusal_to_400(tmp_path) -> None:
    from fastapi.testclient import TestClient

    from nerdbot.api import create_app

    TOKEN = "ghost-run-token"
    AUTH = {"Authorization": f"Bearer {TOKEN}"}
    import os as _os

    _os.environ["NERDBOT_TOKEN"] = TOKEN
    _os.environ["NERDBOT_DB"] = str(tmp_path / "ghost.db")
    _os.environ["NERDBOT_DATA"] = str(tmp_path / "data")
    with TestClient(create_app()) as c:
        r = c.post("/projects", json={"repository": "r"}, headers=AUTH)
        project_id = r.json()["id"]
        r = c.post(f"/projects/{project_id}/tasks", json={"description": "d", "command": "echo hi"}, headers=AUTH)
        task_id = r.json()["id"]
        r = c.post(f"/tasks/{task_id}/runs", headers=AUTH)
        assert r.status_code == 200, r.text
        r2 = c.post(f"/tasks/{task_id}/runs", headers=AUTH)
        assert r2.status_code == 400, r2.text
        assert "use retry" in r2.json()["detail"]
        r3 = c.get(f"/tasks/{task_id}", headers=AUTH)
        assert len(r3.json()["runs"]) == 1, "no ghost run row"
