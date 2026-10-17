"""S2 scheduler autonomy: `nerdbot fire-due` CLI fires scheduled tasks
cron-heartbeats outside the server process (schedule-firing is no longer
trigger-only). Mock-only suite. Error rows surface with exit code 1."""

from __future__ import annotations

from click.testing import CliRunner

from nerdbot import orchestrator, store
from nerdbot.cli.main import cli


def _backdate(conn, schedule_id) -> None:  # type: ignore[no-untyped-def]
    """Force a schedule due (create_scheduled seeds next_run_at one tick out)."""
    conn.execute("UPDATE schedules SET next_run_at = '2020-01-01T00:00:00+00:00' WHERE id = ?",
                 (schedule_id,))
    conn.commit()


def test_fire_due_cli_ignores_empty_queue(tmp_path, monkeypatch) -> None:  # type: ignore[no-untyped-def]
    monkeypatch.setenv("NERDBOT_DB", str(tmp_path / "fire.db"))
    result = CliRunner().invoke(cli, ["fire-due"])
    assert result.exit_code == 0, result.output
    assert "fire-due: 0 fired, 0 errored" in result.output


def test_fire_due_cli_fires_due_schedule(tmp_path, monkeypatch) -> None:  # type: ignore[no-untyped-def]
    db = tmp_path / "fire.db"
    monkeypatch.setenv("NERDBOT_DB", str(db))
    monkeypatch.setenv("NERDBOT_DATA", str(tmp_path / "data"))
    conn = store.connect(str(db))
    project = store.create_project(conn, owner="local-owner")
    schedule = orchestrator.create_scheduled(
        conn,
        project.id,
        "nightly",
        "* * * * *",  # every minute: always due on check
        {"description": "tick", "command": "echo tick"},
    )
    _backdate(conn, schedule.id)
    conn.close()
    result = CliRunner().invoke(cli, ["fire-due"])
    assert result.exit_code == 0, result.output
    assert "fire-due: 1 fired, 0 errored" in result.output
    assert str(schedule.id) in result.output

    # the run really happened in the CLI-owned DB, recorded and unlocked
    conn = store.connect(str(db))
    updated = store.get_schedule(conn, schedule.id)
    assert updated is not None
    assert updated.fire_count == 1
    tasks = store.list_tasks_for_project(conn, project.id)
    assert len(tasks) == 1
    notes = store.list_notifications(conn, project.id)
    assert any(n.kind == "schedule.fired" for n in notes)
    conn.close()


def test_fire_due_error_rows_reported(tmp_path, monkeypatch) -> None:  # type: ignore[no-untyped-def]
    monkeypatch.setenv("NERDBOT_DB", str(tmp_path / "err.db"))
    monkeypatch.setenv("NERDBOT_DATA", str(tmp_path / "errdata"))
    db = str(tmp_path / "err.db")
    conn = store.connect(db)
    project = store.create_project(conn, owner="o")
    schedule = orchestrator.create_scheduled(
        conn, project.id, "s", "* * * * *", {"description": "d", "command": "echo x"}
    )
    _backdate(conn, schedule.id)
    conn.close()

    # inject a firing-time failure: schedule_run resolves no provider here and
    # the mock workspace path aborts — force it instead
    import nerdbot.orchestrator as orch

    def boom(_conn, _task_id, **_kw):  # type: ignore[no-untyped-def]
        raise RuntimeError("injected firing failure")

    monkeypatch.setattr(orch, "schedule_run", boom)
    result = CliRunner().invoke(cli, ["fire-due"])
    assert result.exit_code == 1, result.output
    assert "fire-due: 1 fired, 1 errored" in result.output
    assert "injected firing failure" in result.output

    # the schedule is unlocked so the next heartbeat can retry
    conn = store.connect(db)
    rows = conn.execute("SELECT locked FROM schedules").fetchall()
    assert rows and rows[0][0] == 0
    conn.close()


def test_fire_due_overlap_locked_schedule_skipped(tmp_path, monkeypatch) -> None:  # type: ignore[no-untyped-def]
    db = str(tmp_path / "lock.db")
    monkeypatch.setenv("NERDBOT_DB", db)
    monkeypatch.setenv("NERDBOT_DATA", str(tmp_path / "lockdata"))
    conn = store.connect(db)
    project = store.create_project(conn, owner="o")
    schedule = orchestrator.create_scheduled(
        conn, project.id, "s", "* * * * *", {"description": "d", "command": "echo x"}
    )
    assert store.lock_schedule(conn, schedule.id) is True  # a "previous firing" holds the lock
    conn.close()
    result = CliRunner().invoke(cli, ["fire-due"])
    assert result.exit_code == 0, result.output
    assert "fire-due: 0 fired, 0 errored" in result.output
