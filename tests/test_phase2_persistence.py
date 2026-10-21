"""Phase 2: persistent teammates, deterministic orchestration, restart recovery."""

from __future__ import annotations

import time

import pytest
from fastapi.testclient import TestClient

from nerdbot import orchestrator, store
from nerdbot.api import create_app
from nerdbot.models import RunStatus, TaskStatus

TOKEN = "phase2-token"
AUTH = {"Authorization": f"Bearer {TOKEN}"}


@pytest.fixture()
def app_client(tmp_path, monkeypatch):
    monkeypatch.setenv("NERDBOT_TOKEN", TOKEN)
    monkeypatch.setenv("NERDBOT_DB", str(tmp_path / "p2.db"))
    monkeypatch.setenv("NERDBOT_DATA", str(tmp_path / "data"))
    return TestClient(create_app())


def _project(client: TestClient, repo: str = "r") -> str:
    r = client.post("/projects", json={"repository": repo}, headers=AUTH)
    assert r.status_code == 200, r.text
    return r.json()["id"]


def _teammate(client: TestClient, project_id: str, persona: str = "coder") -> str:
    r = client.post(
        f"/projects/{project_id}/teammates",
        json={"persona": persona, "instructions": "i", "capabilities": ["code"]},
        headers=AUTH,
    )
    assert r.status_code == 200, r.text
    return r.json()["id"]


def _task(client: TestClient, project_id: str, **kw) -> str:
    body = {"description": "t", "command": "echo ok"}
    body.update(kw)
    r = client.post(f"/projects/{project_id}/tasks", json=body, headers=AUTH)
    assert r.status_code == 200, r.text
    return r.json()["id"]


# -- Teammate lifecycle -------------------------------------------------------


def test_teammate_lifecycle(app_client: TestClient) -> None:
    pid = _project(app_client)
    t1 = _teammate(app_client, pid, "coder")
    t2 = _teammate(app_client, pid, "reviewer")

    r = app_client.get(f"/projects/{pid}/teammates", headers=AUTH)
    assert r.status_code == 200, r.text
    ids = [m["id"] for m in r.json()["teammates"]]
    assert ids == [t1, t2]  # stable ownership order

    r = app_client.get(f"/teammates/{t1}", headers=AUTH)
    assert r.status_code == 200 and r.json()["status"] == "active"

    r = app_client.patch(
        f"/teammates/{t1}",
        json={"persona": "senior-coder", "tool_policy": {"board.delete": "ask"}},
        headers=AUTH,
    )
    assert r.status_code == 200, r.text
    assert r.json()["persona"] == "senior-coder"
    assert r.json()["tool_policy"] == {"board.delete": "ask"}

    r = app_client.post(f"/teammates/{t2}/disable", headers=AUTH)
    assert r.status_code == 200 and r.json()["status"] == "disabled"

    # Disabled teammates cannot take new ownership.
    tid = _task(app_client, pid)
    r = app_client.post(f"/tasks/{tid}/assign", json={"owner_teammate_id": t2}, headers=AUTH)
    assert r.status_code == 400, r.text

    r = app_client.post(f"/teammates/{t2}/archive", headers=AUTH)
    assert r.status_code == 200 and r.json()["status"] == "archived"

    # Archived teammates cannot be reactivated.
    r = app_client.post(f"/teammates/{t2}/disable", headers=AUTH)
    assert r.status_code == 400, r.text


def test_assign_owner_and_cross_project_rejected(app_client: TestClient) -> None:
    p1 = _project(app_client, "one")
    p2 = _project(app_client, "two")
    mate = _teammate(app_client, p1)
    foreign = _teammate(app_client, p2)
    tid = _task(app_client, p1)

    r = app_client.post(f"/tasks/{tid}/assign", json={"owner_teammate_id": mate}, headers=AUTH)
    assert r.status_code == 200 and r.json()["owner_teammate_id"] == mate

    r = app_client.post(f"/tasks/{tid}/assign", json={"owner_teammate_id": foreign}, headers=AUTH)
    assert r.status_code == 400, r.text


# -- Dependencies and cycles --------------------------------------------------


def test_dependency_cycle_rejected(app_client: TestClient) -> None:
    pid = _project(app_client)
    a = _task(app_client, pid)
    b = _task(app_client, pid, dependencies=[a])

    r = app_client.patch(f"/tasks/{a}/dependencies", json={}, headers=AUTH)  # unknown route shape
    assert r.status_code in (404, 405)

    r = app_client.patch(f"/tasks/{a}", json={"dependencies": [b]}, headers=AUTH)
    assert r.status_code == 400, r.text
    assert "cycle" in r.json()["detail"]

    r = app_client.patch(f"/tasks/{a}", json={"dependencies": [a]}, headers=AUTH)
    assert r.status_code == 400, r.text


# -- State machine ------------------------------------------------------------


def test_illegal_task_transition_rejected(tmp_path) -> None:
    conn = store.connect(":memory:")
    project = store.create_project(conn, owner="local-owner")
    task = store.create_task(conn, project.id, "t", command="echo ok")
    with pytest.raises(store.InvalidTransitionError):
        store.set_task_status(conn, task.id, TaskStatus.DONE)  # pending -> done illegal
    assert store.get_task(conn, task.id).status == TaskStatus.PENDING  # type: ignore[union-attr]
    conn.close()


def test_terminal_run_immutable(tmp_path) -> None:
    conn = store.connect(":memory:")
    project = store.create_project(conn, owner="local-owner")
    task = store.create_task(conn, project.id, "t", command="echo ok")
    run, _, _ = orchestrator.schedule_run(conn, task.id, data_dir=str(tmp_path))
    assert run.status == RunStatus.SUCCEEDED
    with pytest.raises(store.TerminalRunError):
        store.finish_run(conn, run.id, RunStatus.FAILED, 1, "late")
    assert store.get_run(conn, run.id).status == RunStatus.SUCCEEDED  # type: ignore[union-attr]
    conn.close()


def test_retry_non_terminal_rejected(tmp_path) -> None:
    conn = store.connect(":memory:")
    project = store.create_project(conn, owner="local-owner")
    task = store.create_task(conn, project.id, "t", command="echo ok")
    store.set_task_status(conn, task.id, TaskStatus.RUNNING)
    with pytest.raises(ValueError):
        orchestrator.retry_task(conn, task.id, data_dir=str(tmp_path))
    assert len(store.list_runs_for_task(conn, task.id)) == 0
    conn.close()


def test_retry_creates_new_run(app_client: TestClient) -> None:
    pid = _project(app_client)
    tid = _task(app_client, pid, command="exit 1")
    r = app_client.post(f"/tasks/{tid}/runs", headers=AUTH)
    first_run = r.json()["run"]["id"]
    assert r.json()["task_status"] == "failed"
    r = app_client.post(f"/tasks/{tid}/retry", headers=AUTH)
    assert r.status_code == 200, r.text
    assert r.json()["run"]["id"] != first_run
    view = app_client.get(f"/tasks/{tid}", headers=AUTH).json()
    assert len(view["runs"]) == 2


# -- Approvals ----------------------------------------------------------------


def test_approval_expiry_and_one_use(app_client: TestClient) -> None:
    pid = _project(app_client)
    tid = _task(app_client, pid)
    run_id = app_client.post(f"/tasks/{tid}/runs", headers=AUTH).json()["run"]["id"]

    r = app_client.post(
        f"/runs/{run_id}/approvals", json={"action": "x", "ttl_s": 0.05}, headers=AUTH
    )
    assert r.status_code == 200, r.text
    aid = r.json()["id"]
    assert r.json()["expires_at"] is not None
    time.sleep(0.1)
    r = app_client.post(f"/approvals/{aid}/decision", json={"decision": "approved"}, headers=AUTH)
    assert r.status_code == 410, r.text

    r = app_client.post(f"/runs/{run_id}/approvals", json={"action": "y"}, headers=AUTH)
    aid2 = r.json()["id"]
    r = app_client.post(f"/approvals/{aid2}/decision", json={"decision": "denied"}, headers=AUTH)
    assert r.status_code == 200 and r.json()["decision"] == "denied"
    r = app_client.post(f"/approvals/{aid2}/decision", json={"decision": "approved"}, headers=AUTH)
    assert r.status_code == 409, r.text  # one-use: second decision rejected

    r = app_client.get(f"/runs/{run_id}/approvals", headers=AUTH)
    assert r.status_code == 200 and len(r.json()["approvals"]) == 2


# -- Restart / recovery -------------------------------------------------------


def test_restart_preserves_state(tmp_path) -> None:
    db = str(tmp_path / "restart.db")
    conn = store.connect(db)
    project = store.create_project(conn, owner="local-owner")
    mate = store.create_teammate(conn, project.id, persona="coder")
    task = store.create_task(
        conn, project.id, "persist me", owner_teammate_id=mate.id, command="echo hi"
    )
    mem = store.write_memory(conn, f"project:{project.id}", "fact", source="run:r", confidence=0.9)
    run, _, art_id = orchestrator.schedule_run(conn, task.id, data_dir=str(tmp_path))
    assert run.status == RunStatus.SUCCEEDED
    conn.close()  # simulate app shutdown

    conn2 = store.connect(db)  # simulate app restart
    assert store.get_task(conn2, task.id).status == TaskStatus.DONE  # type: ignore[union-attr]
    assert store.get_run(conn2, run.id).status == RunStatus.SUCCEEDED  # type: ignore[union-attr]
    assert store.get_teammate(conn2, mate.id).persona == "coder"  # type: ignore[union-attr]
    assert store.get_artifact(conn2, art_id).verification_status.value == "passed"  # type: ignore[union-attr]
    assert [e.id for e in store.recall_memory(conn2, f"project:{project.id}")] == [mem.id]
    assert orchestrator.recover_incomplete_runs(conn2) == []  # nothing to recover
    conn2.close()


def test_crash_recovery_marks_orphaned_running(tmp_path) -> None:
    db = str(tmp_path / "crash.db")
    conn = store.connect(db)
    project = store.create_project(conn, owner="local-owner")
    done_task = store.create_task(conn, project.id, "done", command="echo ok")
    done_run, _, _ = orchestrator.schedule_run(conn, done_task.id, data_dir=str(tmp_path))
    live_task = store.create_task(conn, project.id, "live", command="sleep 60")
    orphan = store.create_run(conn, live_task.id)
    store.mark_run_running(conn, orphan.id)
    store.set_task_status(conn, live_task.id, TaskStatus.RUNNING)
    conn.close()  # process dies mid-run

    conn2 = store.connect(db)
    recovered = orchestrator.recover_incomplete_runs(conn2)
    assert recovered == [orphan.id]
    assert store.get_run(conn2, orphan.id).status == RunStatus.STOPPED  # type: ignore[union-attr]
    assert store.get_task(conn2, live_task.id).status == TaskStatus.PENDING  # type: ignore[union-attr]
    # Completed work untouched: no new runs, terminal run intact.
    assert len(store.list_runs_for_task(conn2, done_task.id)) == 1
    assert store.get_run(conn2, done_run.id).status == RunStatus.SUCCEEDED  # type: ignore[union-attr]
    conn2.close()


def test_lifespan_recovery_on_reload(tmp_path, monkeypatch) -> None:
    db = str(tmp_path / "reload.db")
    monkeypatch.setenv("NERDBOT_TOKEN", TOKEN)
    monkeypatch.setenv("NERDBOT_DB", db)
    monkeypatch.setenv("NERDBOT_DATA", str(tmp_path / "data"))
    conn = store.connect(db)
    project = store.create_project(conn, owner="local-owner")
    task = store.create_task(conn, project.id, "live", command="echo x")
    orphan = store.create_run(conn, task.id)
    store.mark_run_running(conn, orphan.id)
    conn.close()

    with TestClient(create_app()) as client:
        assert orphan.id in client.app.state.recovered_runs
    conn2 = store.connect(db)
    assert store.get_run(conn2, orphan.id).status == RunStatus.STOPPED  # type: ignore[union-attr]
    conn2.close()


# -- History, artifacts, events, workspace ------------------------------------


def test_history_and_artifact_scoped_to_owner(app_client: TestClient) -> None:
    pid = _project(app_client)
    other = _project(app_client, "other")
    tid = _task(app_client, pid)
    run_id = app_client.post(f"/tasks/{tid}/runs", headers=AUTH).json()["run"]["id"]
    art_id = app_client.get(f"/tasks/{tid}", headers=AUTH).json()["artifacts"][0]["id"]

    r = app_client.get(f"/projects/{pid}/runs", headers=AUTH)
    assert [x["id"] for x in r.json()["runs"]] == [run_id]

    r = app_client.get(f"/projects/{other}/runs", headers=AUTH)
    assert r.json()["runs"] == []

    r = app_client.get(f"/runs/{run_id}", headers=AUTH)
    assert r.status_code == 200 and len(r.json()["artifacts"]) == 1

    r = app_client.get(f"/artifacts/{art_id}", headers=AUTH)
    assert r.status_code == 200 and r.json()["verification_status"] == "passed"

    r = app_client.get("/artifacts/does-not-exist", headers=AUTH)
    assert r.status_code == 404


def test_events_capture_state_changes(app_client: TestClient) -> None:
    pid = _project(app_client)
    mate = _teammate(app_client, pid)
    tid = _task(app_client, pid)
    app_client.post(f"/tasks/{tid}/assign", json={"owner_teammate_id": mate}, headers=AUTH)
    run_id = app_client.post(f"/tasks/{tid}/runs", headers=AUTH).json()["run"]["id"]
    aid = app_client.post(f"/runs/{run_id}/approvals", json={"action": "a"}, headers=AUTH).json()[
        "id"
    ]
    app_client.post(f"/approvals/{aid}/decision", json={"decision": "approved"}, headers=AUTH)
    app_client.delete(f"/tasks/{tid}/workspace", headers=AUTH)

    types = [
        e["event_type"]
        for e in app_client.get(f"/projects/{pid}/events", headers=AUTH).json()["events"]
    ]
    for expected in (
        "project.created",
        "teammate.created",
        "task.created",
        "task.assigned",
        "run.created",
        "run.status.succeeded",
        "task.status.done",
        "artifact.created",
        "approval.requested",
        "approval.approved",
        "workspace.cleaned",
    ):
        assert expected in types, f"missing {expected} in {types}"

    task_events = app_client.get(f"/projects/{pid}/events?entity=task", headers=AUTH).json()[
        "events"
    ]
    assert task_events and all(e["entity"] == "task" for e in task_events)


def test_workspace_cleanup(app_client: TestClient) -> None:
    import os

    pid = _project(app_client)
    tid = _task(app_client, pid, command="echo data > f.txt")
    app_client.post(f"/tasks/{tid}/runs", headers=AUTH)
    data = os.environ["NERDBOT_DATA"]
    ws = os.path.join(data, "workspaces", tid)
    assert os.path.exists(os.path.join(ws, "f.txt"))

    r = app_client.delete(f"/tasks/{tid}/workspace", headers=AUTH)
    assert r.json() == {"removed": True}
    assert not os.path.exists(ws)
    r = app_client.delete(f"/tasks/{tid}/workspace", headers=AUTH)
    assert r.json() == {"removed": False}


def test_project_memory_scoped(app_client: TestClient) -> None:
    pid = _project(app_client)
    r = app_client.post(
        f"/projects/{pid}/memory",
        json={"scope": "ignored", "content": "pref", "source": "note", "confidence": 0.8},
        headers=AUTH,
    )
    assert r.status_code == 200 and r.json()["scope"] == f"project:{pid}"
    r = app_client.get(f"/projects/{pid}/memory", headers=AUTH)
    assert [e["content"] for e in r.json()["entries"]] == ["pref"]


def test_auth_on_new_routes(app_client: TestClient) -> None:
    bad = {"Authorization": "Bearer wrong"}
    assert app_client.get("/projects/x/teammates", headers=bad).status_code == 403
    assert app_client.get("/projects/x/runs").status_code == 401
    assert app_client.get("/runs/x").status_code == 401
    assert app_client.delete("/tasks/x/workspace", headers=bad).status_code == 403
