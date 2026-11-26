import sqlite3
import threading
from datetime import UTC, datetime, timedelta

from nerdbot import orchestrator, store
from nerdbot.models import TaskStatus, Teammate, TeammateStatus


def _seed(db_path: str) -> tuple[str, str, str]:
    conn = store.connect(db_path)
    try:
        project = store.create_project(conn, owner="local", repository="", config={"name": "p1"})
        mate = store.create_teammate(conn, project.id, name="Bot")
        task = store.create_task(conn, project.id, "do work", command="echo hi")
        return project.id, mate.id, task.id
    finally:
        conn.close()


def test_claim_task_is_atomic(tmp_path):
    db = str(tmp_path / "t.db")
    _p, _m1, t1 = _seed(db)
    conn = store.connect(db)
    try:
        m2 = store.create_teammate(conn, "p1" if False else store.get_task(conn, t1).project_id, name="Bot2")
    finally:
        conn.close()

    results = []
    errors = []

    def claim(mid):
        c = store.connect(db)
        try:
            results.append(store.claim_task(c, t1, mid).owner_teammate_id)
        except Exception as exc:
            errors.append(type(exc).__name__)
        finally:
            c.close()

    threads = [threading.Thread(target=claim, args=( _m1,)), threading.Thread(target=claim, args=(m2.id,))]
    for th in threads:
        th.start()
    for th in threads:
        th.join()

    conn = store.connect(db)
    try:
        task = store.get_task(conn, t1)
        assert task is not None
        assert task.owner_teammate_id in {_m1, m2.id}
        assert task.status == TaskStatus.READY
        assert len(results) == 1
        assert len(errors) == 1
    finally:
        conn.close()


def test_recover_stale_claimed_task(tmp_path):
    db = str(tmp_path / "t.db")
    _p, m1, t1 = _seed(db)
    conn = store.connect(db)
    try:
        store.claim_task(conn, t1, m1, lease_s=1)
        conn.execute(
            "UPDATE tasks SET claim_lease_expires_at=? WHERE id=?",
            ((datetime.now(UTC) - timedelta(seconds=5)).isoformat(), t1),
        )
        conn.commit()
        orchestrator.recover_incomplete_runs(conn)
        task = store.get_task(conn, t1)
        assert task is not None
        assert task.status == TaskStatus.PENDING
        assert task.owner_teammate_id is None
        assert task.claim_lease_expires_at is None
    finally:
        conn.close()


def test_recover_does_not_requeue_active_lease(tmp_path):
    db = str(tmp_path / "t.db")
    _p, m1, t1 = _seed(db)
    conn = store.connect(db)
    try:
        store.claim_task(conn, t1, m1, lease_s=300)
        orchestrator.recover_incomplete_runs(conn)
        task = store.get_task(conn, t1)
        assert task is not None
        assert task.status == TaskStatus.READY
        assert task.owner_teammate_id == m1
        assert task.claim_lease_expires_at is not None
    finally:
        conn.close()
