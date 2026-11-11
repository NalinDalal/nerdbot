"""P4 Stage 3 Item 1: board/task data integrity and association contracts."""

from __future__ import annotations

import os
import sqlite3
from pathlib import Path

import pytest

from nerdbot import store
from nerdbot.models import Decision, RunStatus, TaskStatus, VerificationStatus


def _open_conn(tmp_path: Path) -> sqlite3.Connection:
    db = os.environ.get("NERDBOT_DB") or str(tmp_path / "nerdbot.db")
    return store.connect(db)


@pytest.fixture()
def conn(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setenv("NERDBOT_DB", str(tmp_path / "nerdbot.db"))
    monkeypatch.setenv("NERDBOT_DATA", str(tmp_path / "data"))
    c = _open_conn(tmp_path)
    try:
        yield c
    finally:
        c.close()


def test_set_task_board_attach_detach_move_same_project_preserves_history(conn: sqlite3.Connection):
    p = store.create_project(conn, "local", "p")
    b1 = store.create_board(conn, "local", "b1", project_id=p.id)
    b2 = store.create_board(conn, "local", "b2", project_id=p.id)
    dep = store.create_task(conn, p.id, description="dep")
    task = store.create_task(conn, p.id, description="t", dependencies=[dep.id], command="echo hi")
    run = store.create_run(conn, task.id)
    conn.execute("UPDATE runs SET status = ? WHERE id = ?", (RunStatus.RUNNING.value, run.id))
    conn.commit()
    store.finish_run(conn, run.id, RunStatus.SUCCEEDED, exit_code=0, output_excerpt="ok")
    art = store.create_artifact(conn, task.id, run.id, "log", "/tmp/x", VerificationStatus.UNVERIFIED, summary="s")
    approval = store.request_approval(conn, "task.run", "local", project_id=p.id, task_id=task.id)

    # attach
    t1 = store.set_task_board(conn, task.id, b1.id)
    assert t1.board_id == b1.id
    # move
    t2 = store.set_task_board(conn, task.id, b2.id)
    assert t2.board_id == b2.id
    # detach
    t3 = store.set_task_board(conn, task.id, "")
    assert t3.board_id == ""

    # preserved identity/history/relations
    refreshed = store.get_task(conn, task.id)
    assert refreshed is not None
    assert refreshed.id == task.id
    assert refreshed.dependencies == [dep.id]
    assert refreshed.command == "echo hi"
    runs = store.list_runs_for_task(conn, task.id)
    assert len(runs) == 1 and runs[0].id == run.id
    arts = store.list_artifacts_for_task(conn, task.id)
    assert len(arts) == 1 and arts[0].id == art.id
    appr = store.get_approval(conn, approval.id)
    assert appr is not None and appr.task_id == task.id


def test_set_task_board_rejects_cross_project_and_missing_board(conn: sqlite3.Connection):
    p1 = store.create_project(conn, "local", "p1")
    p2 = store.create_project(conn, "local", "p2")
    b2 = store.create_board(conn, "local", "b2", project_id=p2.id)
    task = store.create_task(conn, p1.id, description="t")

    with pytest.raises(ValueError):
        store.set_task_board(conn, task.id, b2.id)
    with pytest.raises(KeyError):
        store.set_task_board(conn, task.id, "brd_missing")

    assert store.get_task(conn, task.id).board_id == ""


@pytest.mark.parametrize("status", [TaskStatus.RUNNING, TaskStatus.AWAITING_APPROVAL])
def test_set_task_board_rejects_active_or_approval_paused_reassignment(conn: sqlite3.Connection, status: TaskStatus):
    p = store.create_project(conn, "local", "p")
    b1 = store.create_board(conn, "local", "b1", project_id=p.id)
    b2 = store.create_board(conn, "local", "b2", project_id=p.id)
    task = store.create_task(conn, p.id, description="t", board_id=b1.id)
    store.set_task_status(conn, task.id, TaskStatus.RUNNING)
    if status == TaskStatus.AWAITING_APPROVAL:
        store.set_task_status(conn, task.id, TaskStatus.AWAITING_APPROVAL)

    with pytest.raises(ValueError):
        store.set_task_board(conn, task.id, b2.id)
    with pytest.raises(ValueError):
        store.set_task_board(conn, task.id, "")
    # idempotent no-op allowed even if in non-reassignable state
    same = store.set_task_board(conn, task.id, b1.id)
    assert same.board_id == b1.id
    assert store.get_task(conn, task.id).board_id == b1.id


@pytest.mark.parametrize(
    "status",
    [TaskStatus.PENDING, TaskStatus.READY, TaskStatus.BLOCKED, TaskStatus.FAILED, TaskStatus.DONE, TaskStatus.CANCELLED],
)
def test_set_task_board_allows_non_executing_reassignment(conn: sqlite3.Connection, status: TaskStatus):
    p = store.create_project(conn, "local", "p")
    b1 = store.create_board(conn, "local", "b1", project_id=p.id)
    b2 = store.create_board(conn, "local", "b2", project_id=p.id)
    task = store.create_task(conn, p.id, description="t", board_id=b1.id)
    if status == TaskStatus.READY:
        store.set_task_status(conn, task.id, TaskStatus.READY)
    elif status == TaskStatus.BLOCKED:
        store.set_task_status(conn, task.id, TaskStatus.BLOCKED, "waiting")
    elif status == TaskStatus.CANCELLED:
        store.set_task_status(conn, task.id, TaskStatus.CANCELLED)
    elif status in (TaskStatus.FAILED, TaskStatus.DONE):
        store.set_task_status(conn, task.id, TaskStatus.RUNNING)
        store.set_task_status(conn, task.id, status)
    # PENDING is default
    moved = store.set_task_board(conn, task.id, b2.id)
    assert moved.board_id == b2.id
    assert store.get_task(conn, task.id).status == status


def test_delete_board_clears_task_board_refs_transactionally(conn: sqlite3.Connection):
    p = store.create_project(conn, "local", "p")
    b = store.create_board(conn, "local", "b", project_id=p.id)
    b2 = store.create_board(conn, "local", "b2", project_id=p.id)
    t1 = store.create_task(conn, p.id, description="t1", board_id=b.id)
    t2 = store.create_task(conn, p.id, description="t2", board_id=b.id)
    t3 = store.create_task(conn, p.id, description="t3", board_id=b2.id)
    # create a cross-board message targeted to b so inbox cleanup still applies
    store.create_board_message(conn, b2.id, "hi", to_board_id=b.id)

    deleted = store.delete_board(conn, b.id)
    assert deleted.id == b.id
    assert store.get_board(conn, b.id) is None
    assert store.get_task(conn, t1.id).board_id == ""
    assert store.get_task(conn, t2.id).board_id == ""
    assert store.get_task(conn, t3.id).board_id == b2.id
    # messages involving deleted board removed
    rows = conn.execute(
        "SELECT * FROM board_messages WHERE board_id = ? OR to_board_id = ?",
        (b.id, b.id),
    ).fetchall()
    assert rows == []
    # unrelated board intact
    assert store.get_board(conn, b2.id) is not None


def test_set_task_board_idempotent_noop(conn: sqlite3.Connection):
    p = store.create_project(conn, "local", "p")
    b = store.create_board(conn, "local", "b", project_id=p.id)
    task = store.create_task(conn, p.id, description="t", board_id=b.id)
    same = store.set_task_board(conn, task.id, b.id)
    assert same.board_id == b.id
    detached = store.create_task(conn, p.id, description="t2")
    same2 = store.set_task_board(conn, detached.id, "")
    assert same2.board_id == ""
