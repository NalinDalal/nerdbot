"""Tests for routine triggers: task-finished, @mention, cron, guards."""

from __future__ import annotations

from datetime import UTC, datetime

from nerdbot import routines, store


def _setup(conn):
    project = store.create_project(conn, owner="u1", repository="repo")
    a = store.create_teammate(conn, project_id=project.id, persona="a", name="Alpha")
    b = store.create_teammate(conn, project_id=project.id, persona="b", name="Beta")
    return project, a, b


def test_task_done_trigger_creates_followup(conn):
    routines._ROUTINE_RATE.clear(); routines._TRIGGER_CYCLES.clear()
    project, a, b = _setup(conn)
    # B's routine fires when any task completes (except B's own)
    store.create_routine(conn, b.id, project.id, "Follow up", "Check result", kind="on_task_done")
    task = store.create_task(conn, project.id, "do work", owner_teammate_id=a.id, title="Work")
    store.set_task_status(conn, task.id, store.TaskStatus.READY)
    store.set_task_status(conn, task.id, store.TaskStatus.RUNNING)
    store.set_task_status(conn, task.id, store.TaskStatus.DONE)
    tasks = store.list_tasks_for_project(conn, project.id)
    followups = [t for t in tasks if "[Follow-up]" in (t.title or "")]
    assert len(followups) == 1
    assert followups[0].owner_teammate_id == b.id


def test_task_done_self_loop_guard(conn):
    routines._ROUTINE_RATE.clear(); routines._TRIGGER_CYCLES.clear()
    project, a, b = _setup(conn)
    # routine on A creates follow-up for A, but completion actor is A -> should be blocked
    store.create_routine(conn, a.id, project.id, "Follow up", "Check", kind="on_task_done")
    task = store.create_task(conn, project.id, "do work", owner_teammate_id=a.id, title="Work")
    # fire directly with same actor
    created = routines.fire_task_done_triggers(conn, task, actor_teammate_id=a.id)
    assert created == 0


def test_mention_trigger_creates_task(conn):
    routines._ROUTINE_RATE.clear(); routines._TRIGGER_CYCLES.clear()
    project, a, b = _setup(conn)
    store.create_routine(conn, b.id, project.id, "On mention", "Help out", kind="on_mention")
    created = routines.fire_mention_triggers(conn, project_id=project.id, thread_id="thr1", message="hey @beta can you check", mentioner_id="user:u1")
    assert created == 1
    tasks = store.list_tasks_for_project(conn, project.id)
    assert any("[Mention]" in (t.title or "") and t.owner_teammate_id == b.id for t in tasks)


def test_mention_self_trigger_blocked(conn):
    routines._ROUTINE_RATE.clear(); routines._TRIGGER_CYCLES.clear()
    project, a, b = _setup(conn)
    store.create_routine(conn, b.id, project.id, "On mention", "Help out", kind="on_mention")
    created = routines.fire_mention_triggers(conn, project_id=project.id, thread_id="thr1", message="@beta hi", mentioner_id=b.id)
    assert created == 0


def test_ab_ba_cycle_blocked(conn):
    routines._ROUTINE_RATE.clear(); routines._TRIGGER_CYCLES.clear()
    project, a, b = _setup(conn)
    store.create_routine(conn, b.id, project.id, "B on task", "x", kind="on_task_done")
    store.create_routine(conn, a.id, project.id, "A on task", "x", kind="on_task_done")
    # A completes -> triggers B
    ta = store.create_task(conn, project.id, "a task", owner_teammate_id=a.id, title="A")
    n1 = routines.fire_task_done_triggers(conn, ta, actor_teammate_id=a.id)
    assert n1 >= 1  # B's routine fires
    # B completes -> would trigger A, but A->B cycle guard should block B->A
    tb = store.create_task(conn, project.id, "b task", owner_teammate_id=b.id, title="B")
    n2 = routines.fire_task_done_triggers(conn, tb, actor_teammate_id=b.id)
    # A's routine should be blocked by cycle guard
    a_followups = [t for t in store.list_tasks_for_project(conn, project.id) if "[Follow-up]" in (t.title or "") and t.owner_teammate_id == a.id and "b task" in (t.description or "").lower()]
    assert len(a_followups) == 0


def test_paused_teammate_not_triggered(conn):
    routines._ROUTINE_RATE.clear(); routines._TRIGGER_CYCLES.clear()
    project, a, b = _setup(conn)
    store.update_teammate(conn, b.id, paused=True)
    store.create_routine(conn, b.id, project.id, "On mention", "Help out", kind="on_mention")
    created = routines.fire_mention_triggers(conn, project_id=project.id, thread_id="thr1", message="hey @beta", mentioner_id="user:u1")
    assert created == 0


def test_cron_due_minimal():
    now = datetime(2026, 11, 25, 9, 0, tzinfo=UTC)  # Wed
    assert routines._cron_due("0 9 * * *", now) is True
    assert routines._cron_due("1 9 * * *", now) is False
    assert routines._cron_due("*/5 * * * *", datetime(2026, 11, 25, 9, 10, tzinfo=UTC)) is True
