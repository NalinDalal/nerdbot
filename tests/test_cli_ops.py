"""CLI operations: deliveries sweep, mock transport only, no live network."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

import httpx
import pytest
from click.testing import CliRunner

import nerdbot.cli.main as cli_main
from nerdbot import store
from nerdbot.cli.main import cli


@pytest.fixture()
def db_path(tmp_path, monkeypatch) -> str:
    path = str(tmp_path / "ops.db")
    monkeypatch.setenv("NERDBOT_DB", path)
    return path


@pytest.fixture(autouse=True)
def clean_test_transport(monkeypatch) -> None:  # type: ignore[no-untyped-def]
    monkeypatch.setattr(cli_main, "_test_transport", None)


def _project(conn, pid: str) -> None:  # type: ignore[no-untyped-def]
    conn.execute(
        "INSERT INTO projects (id, owner, repository) VALUES (?, 'local-owner', 'w')",
        (pid,),
    )
    conn.commit()


def _seed_note(conn, note_id: str, *, attempts: int = 0, status: str = "queued",
               due: bool = True) -> None:  # type: ignore[no-untyped-def]
    conn.execute(
        "INSERT INTO webhook_targets (id, project_id, url, created_at)"
        " VALUES ('wht_1', 'prj_1', 'http://93.184.216.34/hook', '2026-01-01')"
    )
    next_at = "2026-01-01T00:00:00+00:00" if due else "2027-01-01T00:00:00+00:00"
    conn.execute(
        "INSERT INTO notifications (id, project_id, channel, kind, payload, status,"
        " target_url, attempts, next_attempt_at, created_at)"
        " VALUES (?, 'prj_1', 'webhook-out', 'ping', '{}', ?, '', ?, ?, '2026-01-01')",
        (note_id, status, attempts, next_at),
    )
    conn.commit()


def test_sweep_delivers_due_webhook(db_path: str) -> None:
    conn = store.connect(db_path)
    _project(conn, "prj_1")
    _seed_note(conn, "ntf_1")
    conn.close()

    seen: list[str] = []

    def ok(request: httpx.Request) -> httpx.Response:
        seen.append(str(request.url))
        return httpx.Response(200, text="accepted")

    cli_main._test_transport = httpx.MockTransport(ok)  # type: ignore[attr-defined]
    result = CliRunner().invoke(cli, ["deliveries-sweep"])
    assert result.exit_code == 0, result.output
    assert "ntf_1 status=delivered attempts=1" in result.output
    assert "sweep: 1 deliveries, 0 failed" in result.output
    assert seen == ["http://93.184.216.34/hook"]


def test_sweep_exit_code_on_terminal_failure(db_path: str) -> None:
    conn = store.connect(db_path)
    _project(conn, "prj_1")
    _seed_note(conn, "ntf_2", attempts=2)
    conn.close()

    def down(request: httpx.Request) -> httpx.Response:
        return httpx.Response(503, text="busy")

    cli_main._test_transport = httpx.MockTransport(down)  # type: ignore[attr-defined]
    result = CliRunner().invoke(cli, ["deliveries-sweep"])
    assert result.exit_code == 1, result.output
    assert "ntf_2 status=failed attempts=3" in result.output
    stored = store.get_notification(store.connect(db_path), "ntf_2")
    assert stored is not None and stored.status == "failed" and stored.attempts == 3


def test_sweep_empty_database_is_success(db_path: str) -> None:
    result = CliRunner().invoke(cli, ["deliveries-sweep"])
    assert result.exit_code == 0, result.output
    assert "sweep: 0 deliveries, 0 failed" in result.output


def test_sweep_reclaims_leased_row_before_redelivering(db_path: str) -> None:
    conn = store.connect(db_path)
    _project(conn, "prj_1")
    conn.execute(
        "INSERT INTO notifications (id, project_id, channel, kind, payload, status,"
        " target_url, attempts, next_attempt_at, locked, created_at)"
        " VALUES ('ntf_3', 'prj_1', 'webhook-out', 'ping', '{}', 'sending', '', 1,"
        " NULL, 1, '2026-01-01')"
    )
    stale = (datetime.now(UTC) - timedelta(hours=1)).isoformat()
    conn.execute("UPDATE notifications SET locked_at = ? WHERE id = 'ntf_3'", (stale,))
    conn.commit()
    conn.close()

    def no_send(request: httpx.Request) -> httpx.Response:
        raise AssertionError("no redelivery on the reclaim run")

    cli_main._test_transport = httpx.MockTransport(no_send)  # type: ignore[attr-defined]
    result = CliRunner().invoke(cli, ["deliveries-sweep"])
    assert result.exit_code == 0, result.output
    assert "ntf_3 status=queued attempts=1 reclaimed" in result.output
    row = store.get_notification(store.connect(db_path), "ntf_3")
    assert row is not None and row.locked is False and row.status == "queued"
    assert row.next_attempt_at is not None  # backoff scheduled for a later sweep
