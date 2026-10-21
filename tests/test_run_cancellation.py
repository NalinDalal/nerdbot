"""A run must be stoppable while it is in flight.

The local runtime used to run commands through ``subprocess.run``: one
blocking call with no way to interrupt it. A long command kept the run
busy until it finished on its own, and its children (a dev server, a
``sleep``) outlived it. Now the command runs in its own process group, the
runtime polls it, and a cancel request kills the whole group.

These tests pin the behaviour end to end: the runtime kills promptly, the
grandchildren die with it, the orchestrator records the run as cancelled
(not succeeded, not failed), and the API exposes a cancel endpoint that
refuses to pretend it stopped a run that had already finished.
"""

from __future__ import annotations

import os
import threading
import time
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from nerdbot import orchestrator, runtime, store
from nerdbot.api import create_app
from nerdbot.runtime import CancelToken, ExecutionError, LocalRuntimeAdapter, RunCancelled

TOKEN = "cancel-token"
AUTH = {"Authorization": f"Bearer {TOKEN}"}


@pytest.fixture()
def client(tmp_path, monkeypatch):
    monkeypatch.setenv("NERDBOT_TOKEN", TOKEN)
    monkeypatch.setenv("NERDBOT_DB", str(tmp_path / "cancel.db"))
    monkeypatch.setenv("NERDBOT_DATA", str(tmp_path / "data"))
    return TestClient(create_app())


def _project(client: TestClient) -> str:
    return client.post("/projects", json={"repository": "r"}, headers=AUTH).json()["id"]


def _task(client: TestClient, pid: str, command: str) -> str:
    return client.post(
        f"/projects/{pid}/tasks",
        json={"description": "long job", "command": command},
        headers=AUTH,
    ).json()["id"]


# -- Runtime: the command stops when it is told to ---------------------------


def test_local_runtime_cancels_a_running_command(tmp_path) -> None:
    """A cancelled command raises RunCancelled instead of running to completion."""
    adapter = LocalRuntimeAdapter()
    token = CancelToken()
    ws = tmp_path / "ws"
    ws.mkdir()

    outcome = _run_in_thread(adapter, "sleep 30", ws, token)
    time.sleep(0.3)
    token.cancel()
    outcome["thread"].join(timeout=10.0)

    assert not outcome["thread"].is_alive(), "the cancelled command never stopped"
    assert outcome.get("result") == "cancelled", outcome


def test_local_runtime_kills_the_whole_process_group(tmp_path) -> None:
    """Cancelling kills grandchildren too, not just the shell that spawned them."""
    marker = tmp_path / "grandchild.pid"
    adapter = LocalRuntimeAdapter()
    token = CancelToken()
    ws = tmp_path / "ws"
    ws.mkdir()
    # The shell backgrounds a long sleep, records its pid, then waits.
    command = f"sleep 45 & echo $! > {marker}; wait"

    outcome = _run_in_thread(adapter, command, ws, token)
    deadline = time.monotonic() + 5.0
    while time.monotonic() < deadline and not marker.exists():
        time.sleep(0.05)
    assert marker.exists(), "the grandchild never started"
    grandchild_pid = int(marker.read_text().strip())

    token.cancel()
    outcome["thread"].join(timeout=10.0)
    assert not outcome["thread"].is_alive(), "the cancelled command never stopped"

    # The grandchild must be gone: a cancelled run leaves no orphan behind.
    assert not _pid_alive(grandchild_pid), "the grandchild outlived the cancel"


def _run_in_thread(
    adapter: LocalRuntimeAdapter, command: str, ws: Path, token: CancelToken
) -> dict[str, object]:
    """Start a command in a thread and capture how it ended."""
    outcome: dict[str, object] = {}

    def run() -> None:
        try:
            adapter.start_run(command, ws, timeout_s=60.0, cancel=token)
            outcome["result"] = "completed"
        except RunCancelled as exc:
            outcome["result"] = "cancelled"
            outcome["message"] = str(exc)
        except Exception as exc:  # pragma: no cover - surfaced by the assert
            outcome["result"] = "error"
            outcome["error"] = f"{type(exc).__name__}: {exc}"

    thread = threading.Thread(target=run, daemon=True)
    thread.start()
    outcome["thread"] = thread
    return outcome


def _pid_alive(pid: int) -> bool:
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:  # pragma: no cover - not ours, but alive
        return True
    return True


def test_local_runtime_still_times_out(tmp_path) -> None:
    """The wall-clock budget still applies when nobody cancels."""
    adapter = LocalRuntimeAdapter()
    ws = tmp_path / "ws"
    ws.mkdir()
    started = time.monotonic()
    with pytest.raises(ExecutionError) as excinfo:
        adapter.start_run("sleep 30", ws, timeout_s=0.5)
    assert "timed out" in str(excinfo.value)
    assert time.monotonic() - started < 15.0


# -- Store: the cancel request is recorded -----------------------------------


def test_store_records_the_cancel_request(tmp_path) -> None:
    """The request is durable, and a finished run refuses it."""
    conn = store.connect(str(tmp_path / "cancel.db"))
    try:
        project = store.create_project(conn, owner="owner", repository="repo")
        task = store.create_task(conn, project.id, description="job", command="sleep 5")
        run = store.create_run(conn, task.id)
        store.mark_run_running(conn, run.id)

        assert store.run_cancel_requested(conn, run.id) is False
        store.request_run_cancel(conn, run.id)
        assert store.run_cancel_requested(conn, run.id) is True

        store.finish_run(conn, run.id, store.RunStatus.CANCELLED, None, "cancelled")
        with pytest.raises(store.TerminalRunError):
            store.request_run_cancel(conn, run.id)
    finally:
        conn.close()


# -- API: the owner can stop a run that is in flight -------------------------


def test_api_cancels_a_live_run(client) -> None:
    """POST /runs/{id}/cancel stops the run that is executing right now."""
    pid = _project(client)
    task_id = _task(client, pid, "sleep 30")

    run_holder: dict[str, object] = {}

    def start() -> None:
        run_holder["response"] = client.post(f"/tasks/{task_id}/runs", headers=AUTH)

    runner = threading.Thread(target=start, daemon=True)
    runner.start()

    run_id = _wait_for_running_run(client, task_id)
    cancel = client.post(f"/runs/{run_id}/cancel", headers=AUTH)
    assert cancel.status_code == 200, cancel.text
    assert cancel.json()["cancel_requested"] is True

    runner.join(timeout=20.0)
    assert not runner.is_alive(), "the run never stopped"

    view = client.get(f"/tasks/{task_id}", headers=AUTH).json()
    run = next(r for r in view["runs"] if r["id"] == run_id)
    assert run["status"] == "cancelled", run
    assert view["task"]["status"] == "cancelled", view["task"]
    # The partial output the command produced is kept, not thrown away.
    assert "cancelled" in run["output_excerpt"].lower()


def test_api_refuses_to_cancel_a_finished_run(client) -> None:
    """A run that already ended cannot be cancelled: 409, not a fake stop."""
    pid = _project(client)
    task_id = _task(client, pid, "echo done")
    done = client.post(f"/tasks/{task_id}/runs", headers=AUTH)
    assert done.status_code == 200, done.text
    run_id = done.json()["run"]["id"]

    cancel = client.post(f"/runs/{run_id}/cancel", headers=AUTH)
    assert cancel.status_code == 409, cancel.text
    assert "terminal" in cancel.json()["detail"].lower()


def test_api_cancel_unknown_run_is_404(client) -> None:
    assert client.post("/runs/run_missing/cancel", headers=AUTH).status_code == 404


def test_a_cancelled_task_can_be_run_again(client) -> None:
    """Cancellation ends the run, not the task's life: it can be re-run."""
    pid = _project(client)
    task_id = _task(client, pid, "sleep 30")

    runner = threading.Thread(
        target=lambda: client.post(f"/tasks/{task_id}/runs", headers=AUTH), daemon=True
    )
    runner.start()
    run_id = _wait_for_running_run(client, task_id)
    client.post(f"/runs/{run_id}/cancel", headers=AUTH)
    runner.join(timeout=20.0)
    assert not runner.is_alive(), "the run never stopped"

    view = client.get(f"/tasks/{task_id}", headers=AUTH).json()
    assert view["task"]["status"] == "cancelled", view["task"]

    # Shorten the command so the re-run finishes promptly.
    client.patch(
        f"/tasks/{task_id}", json={"command": "echo again"}, headers=AUTH
    )
    again = client.post(f"/tasks/{task_id}/runs", headers=AUTH)
    assert again.status_code == 200, again.text
    assert again.json()["run"]["status"] == "succeeded", again.text
    assert again.json()["task_status"] == "done", again.text


def _wait_for_running_run(client: TestClient, task_id: str, timeout_s: float = 10.0) -> str:
    """Wait until the task has a running run, and return its id."""
    deadline = time.monotonic() + timeout_s
    while time.monotonic() < deadline:
        view = client.get(f"/tasks/{task_id}", headers=AUTH).json()
        for run in view["runs"]:
            if run["status"] == "running":
                return run["id"]
        time.sleep(0.05)
    raise AssertionError("the run never started")


# -- Orchestrator: a cancelled run is not a success and not a failure --------


def test_orchestrator_records_a_cancelled_run(tmp_path) -> None:
    """The run ends cancelled; the task is not marked done."""
    conn = store.connect(str(tmp_path / "cancel.db"))
    try:
        project = store.create_project(conn, owner="owner", repository="repo")
        task = store.create_task(conn, project.id, description="job", command="sleep 30")
        adapter = _CancellingAdapter()

        run, result, _artifact = orchestrator.schedule_run(
            conn, task.id, adapter=adapter, data_dir=str(tmp_path / "data"), timeout_s=30.0
        )

        assert run.status == store.RunStatus.CANCELLED
        assert result is None
        refreshed = store.get_task(conn, task.id)
        assert refreshed is not None
        assert refreshed.status == store.TaskStatus.CANCELLED
        assert "cancelled" in run.output_excerpt.lower()
        # The cancelled run still leaves evidence: a test-log artifact.
        logs = [a for a in store.list_artifacts_for_task(conn, task.id) if a.type == "test-log"]
        assert len(logs) == 1, logs
    finally:
        conn.close()


class _CancellingAdapter:
    """A local adapter that cancels its own run a moment after it starts."""

    name = "local"

    def start_run(self, command, workspace, timeout_s=60.0, context=None, *, cancel=None):
        timer = threading.Timer(0.3, cancel.cancel if cancel else (lambda: None))
        timer.daemon = True
        timer.start()
        try:
            return LocalRuntimeAdapter().start_run(
                command, workspace, timeout_s=timeout_s, context=context, cancel=cancel
            )
        finally:
            timer.cancel()


def test_cancel_landed_before_registration_still_stops_the_run(tmp_path, monkeypatch) -> None:
    """The race the API can hit: the cancel arrives before the run registers.

    The request is durable, so the orchestrator honours it when the run
    starts instead of losing the stop.
    """
    conn = store.connect(str(tmp_path / "cancel.db"))
    try:
        project = store.create_project(conn, owner="owner", repository="repo")
        task = store.create_task(conn, project.id, description="job", command="sleep 30")
        original = runtime.register_run

        def register(run_id: str, token: CancelToken) -> None:
            # The cancel landed in the window before the run registered.
            store.request_run_cancel(conn, run_id)
            original(run_id, token)

        monkeypatch.setattr(runtime, "register_run", register)
        run, result, _artifact = orchestrator.schedule_run(
            conn,
            task.id,
            adapter=LocalRuntimeAdapter(),
            data_dir=str(tmp_path / "data"),
            timeout_s=30.0,
        )
        assert run.status == store.RunStatus.CANCELLED
        assert result is None
    finally:
        conn.close()
