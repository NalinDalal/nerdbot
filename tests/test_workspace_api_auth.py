"""Workspace/file/git/command/terminal endpoints must reject non-owner principals."""

from __future__ import annotations

from fastapi.testclient import TestClient

from nerdbot import store
from nerdbot.api import create_app


def _client(tmp_path, monkeypatch):
    """Build an isolated API client backed by a throwaway database."""
    db = tmp_path / "test.db"
    data = tmp_path / "data"
    data.mkdir()
    monkeypatch.setenv("NERDBOT_DB", str(db))
    monkeypatch.setenv("NERDBOT_DATA", str(data))
    app = create_app()
    return app, TestClient(app)


def test_teammate_principal_cannot_call_workspace_endpoints(tmp_path, monkeypatch):
    """Every workspace-touching endpoint denies a non-owner principal."""
    app, client = _client(tmp_path, monkeypatch)
    _ = app
    conn = store.connect(tmp_path / "test.db")
    try:
        project = store.create_project(conn, owner="owner1", repository="repo")
        root = tmp_path / "ws"
        root.mkdir()
        store.update_project_config(conn, project.id, {"workspace_root": str(root)})
        task = store.create_task(conn, project.id, "do work", title="task")
    finally:
        conn.close()

    pid = project.id
    tid = task.id
    headers = {"X-Nerdbot-Principal": "not-owner"}
    calls = [
        ("get", f"/projects/{pid}/workspace", None),
        ("get", f"/projects/{pid}/workspace/tree", None),
        ("get", f"/projects/{pid}/workspace/file", {"path": "x.txt"}),
        ("put", f"/projects/{pid}/workspace/file", {"path": "x.txt", "content": "hi"}),
        ("post", f"/projects/{pid}/workspace/mkdir", {"path": "d"}),
        ("delete", f"/projects/{pid}/workspace/path", {"path": "x.txt"}),
        ("post", f"/projects/{pid}/workspace/rename", {"from_path": "a", "to_path": "b"}),
        ("get", f"/projects/{pid}/workspace/git/status", None),
        ("get", f"/projects/{pid}/workspace/git/log", None),
        ("post", f"/projects/{pid}/workspace/git/commit", {"message": "m"}),
        ("post", f"/projects/{pid}/workspace/git/rollback-uncommitted", None),
        ("post", f"/projects/{pid}/workspace/command", {"command": "echo hi"}),
        ("get", f"/projects/{pid}/workspace/diff", None),
        ("post", f"/projects/{pid}/workspace/revert", {"path": "x.txt", "snapshot_ref": "refs/nerdbot/snapshots/x"}),
        ("get", f"/projects/{pid}/workspace/files", None),
        ("get", f"/tasks/{tid}/workspace/files", None),
        ("get", f"/tasks/{tid}/workspace/file", {"path": "x.txt"}),
        ("get", f"/tasks/{tid}/workspace/diff", None),
        ("post", f"/projects/{pid}/terminal", {"cols": 80, "rows": 24}),
        ("get", f"/projects/{pid}/terminal/s1/stream", None),
        ("post", f"/projects/{pid}/terminal/s1/input", {"data": "x"}),
        ("post", f"/projects/{pid}/terminal/s1/resize", {"cols": 80, "rows": 24}),
        ("delete", f"/projects/{pid}/terminal/s1", None),
    ]
    for method, url, payload in calls:
        kwargs = {"headers": headers}
        if method == "get" and payload is not None:
            kwargs["params"] = payload
        elif payload is not None:
            kwargs["json"] = payload
        if method == "delete" and payload is not None:
            response = client.request("DELETE", url, **kwargs)
        else:
            response = getattr(client, method)(url, **kwargs)
        assert response.status_code in (401, 403, 404), f"{method.upper()} {url}: {response.status_code}"
