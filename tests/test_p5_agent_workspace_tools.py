from __future__ import annotations

from pathlib import Path

from nerdbot import app_tools, store
from nerdbot.agent_context import AgentContext


def _seed(tmp_path: Path, *, write_permission: bool = True):
    conn = store.connect(str(tmp_path / "db.sqlite3"))
    project = store.create_project(conn, owner="local-owner", repository="p5")
    perms = ["workspace.write"] if write_permission else []
    mate = store.create_teammate(
        conn,
        project.id,
        name="dev",
        persona="Developer",
        permissions=perms,
    )
    ws = tmp_path / "ws"
    ws.mkdir(parents=True, exist_ok=True)
    (ws / "hello.txt").write_text("hello world\nsecond line\n", encoding="utf-8")
    task = store.create_task(
        conn,
        project.id,
        description="workspace task",
        owner_teammate_id=mate.id,
        workspace_mode="workspace",
    )
    task.workspace_path = str(ws)
    conn.execute("UPDATE tasks SET workspace_path=? WHERE id=?", (str(ws), task.id))
    conn.commit()
    task = store.get_task(conn, task.id)
    mate = store.get_teammate(conn, mate.id)
    project = store.get_project(conn, project.id)
    assert task and mate and project
    return conn, project, mate, task, ws


def _ctx(conn, project, mate, task, ws):
    return AgentContext(
        conn=conn,
        task=task,
        project=project,
        teammate=mate,
        system_message="",
        allowed_permissions=frozenset(mate.permissions or []),
        data_dir=str(ws.parent),
    )


def _call(ctx, ws, name, args):
    return app_tools.execute_app_tool(
        ctx, name, args, data_dir=str(ws.parent), workspace_path=str(ws)
    )


def test_workspace_tool_schemas():
    schemas = app_tools.app_tool_schemas({"workspace.write"})
    names = {s["function"]["name"] for s in schemas}
    assert {"list_workspace_files", "read_workspace_file", "search_workspace"} <= names
    assert {
        "write_workspace_file",
        "delete_workspace_path",
        "rename_workspace_path",
        "create_workspace_dir",
    } <= names


def test_agent_workspace_read_search_and_write(tmp_path: Path):
    conn, project, mate, task, ws = _seed(tmp_path, write_permission=True)
    try:
        ctx = _ctx(conn, project, mate, task, ws)
        listing = _call(ctx, ws, "list_workspace_files", {})
        assert "hello.txt" in listing
        read = _call(ctx, ws, "read_workspace_file", {"path": "hello.txt"})
        assert "hello world" in read
        found = _call(ctx, ws, "search_workspace", {"query": "second"})
        assert "hello.txt:" in found and "second line" in found
        out = _call(ctx, ws, "write_workspace_file", {"path": "src/new.txt", "content": "ok"})
        assert "wrote src/new.txt" in out
        assert (ws / "src/new.txt").read_text(encoding="utf-8") == "ok"
        mv = _call(ctx, ws, "rename_workspace_path", {"from_path": "src/new.txt", "to_path": "src/moved.txt"})
        assert "moved" in mv
        assert (ws / "src/moved.txt").exists()
        mkdir = _call(ctx, ws, "create_workspace_dir", {"path": "dirx"})
        assert "created directory" in mkdir
        assert (ws / "dirx").is_dir()
        rm = _call(ctx, ws, "delete_workspace_path", {"path": "src/moved.txt"})
        assert "deleted" in rm
        assert not (ws / "src/moved.txt").exists()
        denied = _call(ctx, ws, "read_workspace_file", {"path": "../etc/passwd"})
        assert "tool error" in denied
    finally:
        conn.close()


def test_workspace_write_requires_permission(tmp_path: Path):
    conn, project, mate, task, ws = _seed(tmp_path, write_permission=False)
    try:
        ctx = _ctx(conn, project, mate, task, ws)
        out = _call(ctx, ws, "write_workspace_file", {"path": "x.txt", "content": "no"})
        assert "permission denied" in out.lower() or "lacks permission" in out.lower()
        assert not (ws / "x.txt").exists()
    finally:
        conn.close()
