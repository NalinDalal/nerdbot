"""The workbench slice: live workspace roots, file I/O, live runs, terminal.

These tests exercise the real route layer and the same local runtime the
product uses. The isolated-checkout tests elsewhere remain the regression
suite for default task execution.
"""

from __future__ import annotations

import time
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from nerdbot import store, terminal, workspace
from nerdbot.api import create_app

TOKEN = "workspace-os-token"
AUTH = {"Authorization": f"Bearer {TOKEN}"}


@pytest.fixture()
def client(tmp_path, monkeypatch):
    monkeypatch.setenv("NERDBOT_TOKEN", TOKEN)
    monkeypatch.setenv("NERDBOT_DB", str(tmp_path / "os.db"))
    monkeypatch.setenv("NERDBOT_DATA", str(tmp_path / "data"))
    return TestClient(create_app())


def _project(client: TestClient, **body) -> str:
    r = client.post("/projects", json={"repository": "workspace-os", **body}, headers=AUTH)
    assert r.status_code == 200, r.text
    return r.json()["id"]


def test_workspace_meta_tree_file_round_trip_and_escape(client: TestClient) -> None:
    pid = _project(client)
    meta = client.get(f"/projects/{pid}/workspace", headers=AUTH)
    assert meta.status_code == 200, meta.text
    root = Path(meta.json()["root"])
    assert root.is_dir()
    assert meta.json()["git"] is True  # the default tree is baseline-committed

    write = client.put(
        f"/projects/{pid}/workspace/file",
        json={"path": "src/greeting.txt", "content": "hello workbench\n"},
        headers=AUTH,
    )
    assert write.status_code == 200, write.text
    assert (root / "src" / "greeting.txt").read_text() == "hello workbench\n"

    tree = client.get(f"/projects/{pid}/workspace/tree", headers=AUTH)
    assert tree.status_code == 200, tree.text
    assert "src/greeting.txt" in {f["path"] for f in tree.json()["files"]}

    read = client.get(
        f"/projects/{pid}/workspace/file",
        params={"path": "src/greeting.txt"},
        headers=AUTH,
    )
    assert read.status_code == 200, read.text
    assert read.json()["content"] == "hello workbench\n"

    diff = client.get(f"/projects/{pid}/workspace/diff", headers=AUTH)
    assert diff.status_code == 200, diff.text
    assert "+hello workbench" in diff.json()["diff"]

    for bad in ("../outside.txt", "/etc/passwd", ".git/config"):
        escaped = client.get(
            f"/projects/{pid}/workspace/file", params={"path": bad}, headers=AUTH
        )
        assert escaped.status_code == 400, (bad, escaped.text)
        refused = client.put(
            f"/projects/{pid}/workspace/file",
            json={"path": bad, "content": "x"},
            headers=AUTH,
        )
        assert refused.status_code == 400, (bad, refused.text)


def test_attach_existing_folder_and_refuse_bad_paths(client: TestClient, tmp_path: Path) -> None:
    folder = tmp_path / "imported"
    folder.mkdir()
    (folder / "README.md").write_text("# imported\n")
    pid = _project(client)

    r = client.post(
        f"/projects/{pid}/workspace/attach",
        json={"path": str(folder), "initialize_git": False},
        headers=AUTH,
    )
    assert r.status_code == 200, r.text
    assert r.json()["attached"] is True
    assert r.json()["root"] == str(folder.resolve())

    # The folder is adopted, not silently rewritten into a repository.
    assert not (folder / ".git").exists()

    tree = client.get(f"/projects/{pid}/workspace/tree", headers=AUTH).json()
    assert "README.md" in {f["path"] for f in tree["files"]}

    for bad in ("relative/path", "/", str(tmp_path / "missing")):
        refused = client.post(
            f"/projects/{pid}/workspace/attach", json={"path": bad}, headers=AUTH
        )
        assert refused.status_code == 400, (bad, refused.text)


def test_live_task_runs_in_project_root_and_protects_workspace(client: TestClient) -> None:
    pid = _project(client)
    root = Path(client.get(f"/projects/{pid}/workspace", headers=AUTH).json()["root"])

    task = client.post(
        f"/projects/{pid}/tasks",
        json={
            "description": "write the live marker",
            "command": "pwd && echo live-marker > marker.txt",
            "workspace_mode": "workspace",
        },
        headers=AUTH,
    )
    assert task.status_code == 200, task.text
    body = task.json()
    assert body["workspace_mode"] == "workspace"
    tid = body["id"]

    run = client.post(f"/tasks/{tid}/runs", headers=AUTH)
    assert run.status_code == 200, run.text
    assert run.json()["exit_code"] == 0
    assert (root / "marker.txt").read_text().strip() == "live-marker"
    # The task path is the live root, not a per-task checkout.
    refreshed = client.get(f"/tasks/{tid}", headers=AUTH).json()["task"]
    assert refreshed["workspace_path"] == str(root)
    assert refreshed["workspace_mode"] == "workspace"

    events = client.get(f"/runs/{run.json()['run']['id']}/events", headers=AUTH)
    assert events.status_code == 200, events.text
    kinds = {e["kind"] for e in events.json()["events"]}
    assert {"run", "result"} <= kinds

    # A live workspace is project state, never a task scratch directory.
    refused_delete = client.delete(f"/tasks/{tid}/workspace", headers=AUTH)
    assert refused_delete.status_code == 400
    refused_seed = client.post(f"/tasks/{tid}/workspace", json={}, headers=AUTH)
    assert refused_seed.status_code == 400
    assert (root / "marker.txt").exists()


def test_async_run_reports_progress_and_finishes(client: TestClient) -> None:
    pid = _project(client)
    tid = client.post(
        f"/projects/{pid}/tasks",
        json={
            "description": "async marker",
            "command": "echo async > async.txt",
            "workspace_mode": "workspace",
        },
        headers=AUTH,
    ).json()["id"]

    started = client.post(f"/tasks/{tid}/runs/async", headers=AUTH)
    assert started.status_code == 200, started.text
    assert started.json()["started"] is True

    deadline = time.monotonic() + 10
    runs: list[dict] = []
    while time.monotonic() < deadline:
        view = client.get(f"/tasks/{tid}", headers=AUTH).json()
        runs = view["runs"]
        if runs and runs[-1]["status"] not in {"queued", "running"}:
            break
        time.sleep(0.1)
    assert runs, runs
    assert runs[-1]["status"] == "succeeded", runs[-1]
    events = client.get(f"/runs/{runs[-1]['id']}/events", headers=AUTH).json()["events"]
    assert any(e["kind"] == "result" for e in events)


def test_live_run_lock_blocks_a_second_agent(client: TestClient) -> None:
    pid = _project(client)
    tid = client.post(
        f"/projects/{pid}/tasks",
        json={"description": "locked", "command": "echo nope", "workspace_mode": "workspace"},
        headers=AUTH,
    ).json()["id"]
    assert workspace.acquire_workspace_lock(pid) is True
    try:
        r = client.post(f"/tasks/{tid}/runs", headers=AUTH)
        assert r.status_code == 200, r.text
        assert r.json()["run"]["status"] == "blocked"
        assert "busy" in r.json()["run"]["output_excerpt"]
    finally:
        workspace.release_workspace_lock(pid)


def test_checkout_mode_still_deletes_only_its_own_workspace(client: TestClient) -> None:
    pid = _project(client)
    tid = client.post(
        f"/projects/{pid}/tasks",
        json={"description": "isolated", "command": "echo checkout > checkout.txt"},
        headers=AUTH,
    ).json()["id"]
    run = client.post(f"/tasks/{tid}/runs", headers=AUTH)
    assert run.status_code == 200, run.text
    assert run.json()["exit_code"] == 0
    task = client.get(f"/tasks/{tid}", headers=AUTH).json()["task"]
    checkout = Path(task["workspace_path"])
    assert checkout.name == tid
    assert (checkout / "checkout.txt").exists()
    removed = client.delete(f"/tasks/{tid}/workspace", headers=AUTH)
    assert removed.status_code == 200
    assert removed.json()["removed"] is True
    assert not checkout.exists()


def test_terminal_manager_owns_a_real_pty(tmp_path: Path) -> None:
    session = terminal.create_session("prj_test", tmp_path, cols=90, rows=20)
    try:
        time.sleep(0.4)
        _snapshot, subscriber = session.subscribe()
        session.write("echo TERM_SLICE_OK\n")
        collected = ""
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline and "TERM_SLICE_OK" not in collected:
            try:
                chunk = subscriber.get(timeout=0.2)
            except Exception:
                continue
            if chunk is None:
                break
            collected += chunk
        assert "TERM_SLICE_OK" in collected, collected
        session.resize(100, 30)
        assert (session.cols, session.rows) == (100, 30)
    finally:
        session.close()


def test_terminal_routes_require_ownership_and_close_cleanly(client: TestClient) -> None:
    pid = _project(client)
    created = client.post(f"/projects/{pid}/terminal", json={"cols": 80, "rows": 24}, headers=AUTH)
    assert created.status_code == 200, created.text
    sid = created.json()["session_id"]
    wrote = client.post(
        f"/projects/{pid}/terminal/{sid}/input",
        json={"data": "echo ROUTE_OK\n"},
        headers=AUTH,
    )
    assert wrote.status_code == 200, wrote.text
    resized = client.post(
        f"/projects/{pid}/terminal/{sid}/resize", json={"cols": 100, "rows": 30}, headers=AUTH
    )
    assert resized.status_code == 200, resized.text
    closed = client.delete(f"/projects/{pid}/terminal/{sid}", headers=AUTH)
    assert closed.status_code == 200 and closed.json()["closed"] is True
    # A session id cannot be reused after it is closed.
    missing = client.post(
        f"/projects/{pid}/terminal/{sid}/input", json={"data": "x"}, headers=AUTH
    )
    assert missing.status_code == 404


def test_task_model_defaults_to_checkout_for_legacy_rows() -> None:
    conn = store.connect(":memory:")
    try:
        project = store.create_project(conn, owner="local-owner")
        task = store.create_task(conn, project.id, "legacy")
        assert task.workspace_mode == "checkout"
        assert store.get_task(conn, task.id).workspace_mode == "checkout"  # type: ignore[union-attr]
    finally:
        conn.close()
