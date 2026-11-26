import sqlite3
import threading
from datetime import UTC, datetime, timedelta

import pytest

from nerdbot import orchestrator, store
from nerdbot.models import RunStatus, TaskStatus


def _seed(db_path: str):
    conn = store.connect(db_path)
    try:
        project = store.create_project(conn, owner="local", repository="", config={"name": "p"})
        mate = store.create_teammate(conn, project.id, name="Bot")
        task = store.create_task(conn, project.id, "do work", command="echo hi")
        return project, mate, task
    finally:
        conn.close()


def test_running_run_has_durable_lease(tmp_path):
    db = str(tmp_path / "t.db")
    _p, _m, task = _seed(db)
    conn = store.connect(db)
    try:
        run = store.create_run(conn, task.id)
        run = store.mark_run_running(conn, run.id, owner="worker-1", lease_s=30)
        fresh = store.get_run(conn, run.id)
        assert fresh is not None
        assert fresh.status == RunStatus.RUNNING
        assert fresh.lease_owner == "worker-1"
        assert fresh.lease_expires_at is not None
        assert fresh.heartbeat_at is not None
    finally:
        conn.close()


def test_heartbeat_extends_run_lease(tmp_path):
    db = str(tmp_path / "t.db")
    _p, _m, task = _seed(db)
    conn = store.connect(db)
    try:
        run = store.create_run(conn, task.id)
        run = store.mark_run_running(conn, run.id, owner="worker-1", lease_s=30)
        before = store.get_run(conn, run.id).lease_expires_at
        ok = store.renew_run_lease(conn, run.id, owner="worker-1", lease_s=60)
        after = store.get_run(conn, run.id)
        assert ok is True
        assert after.lease_expires_at > before
        assert after.heartbeat_at is not None
    finally:
        conn.close()


def test_recovery_does_not_reclaim_valid_lease(tmp_path):
    db = str(tmp_path / "t.db")
    _p, _m, task = _seed(db)
    conn = store.connect(db)
    try:
        run = store.create_run(conn, task.id)
        store.mark_run_running(conn, run.id, owner="worker-1", lease_s=300)
        store.set_task_status(conn, task.id, TaskStatus.RUNNING)
        recovered = orchestrator.recover_incomplete_runs(conn)
        fresh = store.get_run(conn, run.id)
        assert run.id not in recovered
        assert fresh.status == RunStatus.RUNNING
    finally:
        conn.close()


def test_recovery_reclaims_expired_run_lease(tmp_path):
    db = str(tmp_path / "t.db")
    _p, _m, task = _seed(db)
    conn = store.connect(db)
    try:
        run = store.create_run(conn, task.id)
        store.mark_run_running(conn, run.id, owner="worker-1", lease_s=1)
        store.set_task_status(conn, task.id, TaskStatus.RUNNING)
        conn.execute(
            "UPDATE runs SET lease_expires_at=? WHERE id=?",
            ((datetime.now(UTC) - timedelta(seconds=5)).isoformat(), run.id),
        )
        conn.commit()
        recovered = orchestrator.recover_incomplete_runs(conn)
        fresh = store.get_run(conn, run.id)
        task_fresh = store.get_task(conn, task.id)
        assert run.id in recovered
        assert fresh.status == RunStatus.STOPPED
        assert task_fresh.status == TaskStatus.PENDING
    finally:
        conn.close()


def test_worker_cannot_renew_lease_it_no_longer_owns(tmp_path):
    db = str(tmp_path / "t.db")
    _p, _m, task = _seed(db)
    conn = store.connect(db)
    try:
        run = store.create_run(conn, task.id)
        store.mark_run_running(conn, run.id, owner="worker-1", lease_s=30)
        ok = store.renew_run_lease(conn, run.id, owner="worker-2", lease_s=60)
        assert ok is False
    finally:
        conn.close()


def test_worker_cannot_complete_after_losing_ownership(tmp_path):
    db = str(tmp_path / "t.db")
    _p, _m, task = _seed(db)
    conn = store.connect(db)
    try:
        run = store.create_run(conn, task.id)
        store.mark_run_running(conn, run.id, owner="worker-1", lease_s=30)
        # simulate recovery/ownership loss
        conn.execute("UPDATE runs SET lease_owner=?, lease_expires_at=? WHERE id=?",
                     ("worker-2", (datetime.now(UTC) + timedelta(seconds=30)).isoformat(), run.id))
        conn.commit()
        with pytest.raises(store.InvalidTransitionError):
            store.finish_run(conn, run.id, RunStatus.SUCCEEDED, 0, "ok", owner="worker-1")
        fresh = store.get_run(conn, run.id)
        assert fresh.status == RunStatus.RUNNING
    finally:
        conn.close()


def test_two_recovery_workers_cannot_recover_same_expired_run(tmp_path):
    db = str(tmp_path / "t.db")
    _p, _m, task = _seed(db)
    conn = store.connect(db)
    try:
        run = store.create_run(conn, task.id)
        store.mark_run_running(conn, run.id, owner="worker-1", lease_s=1)
        store.set_task_status(conn, task.id, TaskStatus.RUNNING)
        conn.execute("UPDATE runs SET lease_expires_at=? WHERE id=?",
                     ((datetime.now(UTC) - timedelta(seconds=5)).isoformat(), run.id))
        conn.commit()
    finally:
        conn.close()

    results = []

    def recover():
        c = store.connect(db)
        try:
            results.append(orchestrator.recover_incomplete_runs(c))
        finally:
            c.close()

    t1 = threading.Thread(target=recover)
    t2 = threading.Thread(target=recover)
    t1.start(); t2.start(); t1.join(); t2.join()
    flat = [r for sub in results for r in sub]
    assert flat.count(run.id) == 1
    conn = store.connect(db)
    try:
        assert store.get_run(conn, run.id).status == RunStatus.STOPPED
    finally:
        conn.close()


def test_recovery_does_not_duplicate_completed_run(tmp_path):
    db = str(tmp_path / "t.db")
    _p, _m, task = _seed(db)
    conn = store.connect(db)
    try:
        run = store.create_run(conn, task.id)
        store.mark_run_running(conn, run.id, owner="worker-1", lease_s=30)
        store.finish_run(conn, run.id, RunStatus.SUCCEEDED, 0, "ok", owner="worker-1")
        before = len(store.list_runs_for_task(conn, task.id))
        recovered = orchestrator.recover_incomplete_runs(conn)
        after = len(store.list_runs_for_task(conn, task.id))
        assert run.id not in recovered
        assert before == after
        assert store.get_run(conn, run.id).status == RunStatus.SUCCEEDED
    finally:
        conn.close()


def test_task_and_run_lease_state_consistent_on_terminal_transitions(tmp_path):
    db = str(tmp_path / "t.db")
    project = None
    conn = store.connect(db)
    try:
        project = store.create_project(conn, owner="local", repository="", config={"name": "p2"})
        mate = store.create_teammate(conn, project.id, name="Bot")
        task = store.create_task(conn, project.id, "do work", command="echo hi")
        store.claim_task(conn, task.id, mate.id, lease_s=300)
        run = store.create_run(conn, task.id)
        store.mark_run_running(conn, run.id, owner="worker-1", lease_s=30)
        store.set_task_status(conn, task.id, TaskStatus.RUNNING)
        store.finish_run(conn, run.id, RunStatus.FAILED, 1, "bad", owner="worker-1")
        store.set_task_status(conn, task.id, TaskStatus.FAILED)
        fresh_run = store.get_run(conn, run.id)
        fresh_task = store.get_task(conn, task.id)
        assert fresh_run.lease_owner is None
        assert fresh_run.lease_expires_at is None
        assert fresh_task.claim_lease_expires_at is None or fresh_task.status != TaskStatus.READY
    finally:
        conn.close()


def test_worker_interruption_then_lease_expiry_permits_recovery(tmp_path):
    db = str(tmp_path / "t.db")
    _p, _m, task = _seed(db)
    conn = store.connect(db)
    try:
        run = store.create_run(conn, task.id)
        store.mark_run_running(conn, run.id, owner="worker-1", lease_s=30)
        store.set_task_status(conn, task.id, TaskStatus.RUNNING)
        # simulate worker interruption: no heartbeat, lease expires
        conn.execute("UPDATE runs SET lease_expires_at=? WHERE id=?",
                     ((datetime.now(UTC) - timedelta(seconds=1)).isoformat(), run.id))
        conn.commit()
        recovered = orchestrator.recover_incomplete_runs(conn)
        fresh = store.get_run(conn, run.id)
        assert run.id in recovered
        assert fresh.status == RunStatus.STOPPED
        assert store.get_task(conn, task.id).status == TaskStatus.PENDING
    finally:
        conn.close()


def test_lease_state_cleared_on_cancel(tmp_path):
    db = str(tmp_path / "t.db")
    _p, mate, task = _seed(db)
    conn = store.connect(db)
    try:
        store.claim_task(conn, task.id, mate.id, lease_s=300)
        run = store.create_run(conn, task.id)
        store.mark_run_running(conn, run.id, owner="worker-1", lease_s=30)
        store.set_task_status(conn, task.id, TaskStatus.RUNNING)
        store.finish_run(conn, run.id, RunStatus.CANCELLED, None, "cancelled", owner="worker-1")
        store.set_task_status(conn, task.id, TaskStatus.CANCELLED)
        fresh = store.get_run(conn, run.id)
        assert fresh.lease_owner is None
        assert fresh.lease_expires_at is None
        assert fresh.heartbeat_at is None
    finally:
        conn.close()


def test_valid_run_lease_not_recovered_when_task_claim_lease_expired(tmp_path):
    db = str(tmp_path / "t.db")
    _p, mate, task = _seed(db)
    conn = store.connect(db)
    try:
        store.claim_task(conn, task.id, mate.id, lease_s=1)
        run = store.create_run(conn, task.id)
        store.mark_run_running(conn, run.id, owner="worker-1", lease_s=300)
        store.set_task_status(conn, task.id, TaskStatus.RUNNING)
        conn.execute("UPDATE tasks SET claim_lease_expires_at=? WHERE id=?",
                     ((datetime.now(UTC) - timedelta(seconds=5)).isoformat(), task.id))
        conn.commit()
        recovered = orchestrator.recover_incomplete_runs(conn)
        assert run.id not in recovered
        fresh_run = store.get_run(conn, run.id)
        fresh_task = store.get_task(conn, task.id)
        assert fresh_run.status == RunStatus.RUNNING
        assert fresh_task.status == TaskStatus.RUNNING
    finally:
        conn.close()
