"""Tests for workspace gateway, permissions, audit, and safety rules."""

from __future__ import annotations

import os
import sqlite3
from pathlib import Path

import pytest

from nerdbot import fleet, store, workspace as ws
from nerdbot.gates import GateDenied
from nerdbot.models import Teammate


def _make_project(conn: sqlite3.Connection, data_dir: Path):
    project = store.create_project(conn, owner="u1", repository="repo")
    root = data_dir / "ws"
    root.mkdir(parents=True, exist_ok=True)
    project = store.update_project_config(conn, project.id, {"workspace_root": str(root)})
    return project, root


def _make_teammate(conn: sqlite3.Connection, project_id: str, permissions=None, autonomy_level="ask_first", paused=False):
    return store.create_teammate(
        conn,
        project_id=project_id,
        persona="builder",
        permissions=list(permissions or []),
        autonomy_level=autonomy_level,
        paused=paused,
    )


def test_traversal_denied(conn, data_dir):
    project, root = _make_project(conn, data_dir)
    mate = _make_teammate(conn, project.id, permissions=["workspace.read"])
    actor = ws.WorkspaceActor(kind="teammate", id=mate.id, project_id=project.id, teammate=mate)
    res = ws.do(actor, "read", "../secret.txt", conn=conn, data_dir=str(data_dir), project=project)
    assert not res.ok
    assert res.denied or "escape" in res.error.lower() or "outside" in res.error.lower()


def test_symlink_escape_denied(conn, data_dir, tmp_path):
    project, root = _make_project(conn, data_dir)
    outside = tmp_path / "outside.txt"
    outside.write_text("secret", encoding="utf-8")
    link = root / "link.txt"
    try:
        link.symlink_to(outside)
    except OSError:
        pytest.skip("symlinks not supported")
    mate = _make_teammate(conn, project.id, permissions=["workspace.read"])
    actor = ws.WorkspaceActor(kind="teammate", id=mate.id, project_id=project.id, teammate=mate)
    res = ws.do(actor, "read", "link.txt", conn=conn, data_dir=str(data_dir), project=project)
    assert not res.ok


def test_denied_at_no_permission(conn, data_dir):
    project, root = _make_project(conn, data_dir)
    (root / "a.txt").write_text("hi", encoding="utf-8")
    mate = _make_teammate(conn, project.id, permissions=[])
    actor = ws.WorkspaceActor(kind="teammate", id=mate.id, project_id=project.id, teammate=mate)
    res = ws.do(actor, "read", "a.txt", conn=conn, data_dir=str(data_dir), project=project)
    assert not res.ok
    assert res.denied


def test_allowed_read(conn, data_dir):
    project, root = _make_project(conn, data_dir)
    (root / "a.txt").write_text("hello", encoding="utf-8")
    mate = _make_teammate(conn, project.id, permissions=["workspace.read"])
    actor = ws.WorkspaceActor(kind="teammate", id=mate.id, project_id=project.id, teammate=mate)
    res = ws.do(actor, "read", "a.txt", conn=conn, data_dir=str(data_dir), project=project)
    assert res.ok
    assert "hello" in res.output


def test_write_denied_with_read_only(conn, data_dir):
    project, root = _make_project(conn, data_dir)
    mate = _make_teammate(conn, project.id, permissions=["workspace.read"])
    actor = ws.WorkspaceActor(kind="teammate", id=mate.id, project_id=project.id, teammate=mate)
    res = ws.do(actor, "write", "a.txt", conn=conn, data_dir=str(data_dir), project=project, content="x")
    assert not res.ok
    assert res.denied


def test_approval_required_at_ask_first(conn, data_dir):
    project, root = _make_project(conn, data_dir)
    mate = _make_teammate(conn, project.id, permissions=["workspace.read", "workspace.write"], autonomy_level="ask_first")
    actor = ws.WorkspaceActor(kind="teammate", id=mate.id, project_id=project.id, teammate=mate)
    res = ws.do(actor, "write", "a.txt", conn=conn, data_dir=str(data_dir), project=project, content="x")
    assert not res.ok
    assert res.denied
    assert res.data.get("approval_required") is True


def test_untrusted_content_rule(conn, data_dir):
    project, root = _make_project(conn, data_dir)
    mate = _make_teammate(conn, project.id, permissions=["workspace.read", "workspace.write", "workspace.exec"], autonomy_level="act_and_report")
    actor = ws.WorkspaceActor(kind="teammate", id=mate.id, project_id=project.id, teammate=mate)
    res = ws.do(actor, "write", "a.txt", conn=conn, data_dir=str(data_dir), project=project, content="x", untrusted=True)
    assert not res.ok
    assert res.data.get("approval_required") is True


def test_pause_stops_routines(conn, data_dir):
    from nerdbot import routines
    project, root = _make_project(conn, data_dir)
    mate = _make_teammate(conn, project.id, permissions=[], paused=True)
    # create routine directly
    store.create_routine(conn, mate.id, project.id, "r", "do it", interval_s=60, enabled=True, kind="task")
    fired = routines.sweep_once(conn)
    assert fired == 0


def test_audit_row_written_allow_and_deny(conn, data_dir):
    project, root = _make_project(conn, data_dir)
    (root / "a.txt").write_text("hello", encoding="utf-8")
    mate = _make_teammate(conn, project.id, permissions=["workspace.read"])
    actor = ws.WorkspaceActor(kind="teammate", id=mate.id, project_id=project.id, teammate=mate)
    ok = ws.do(actor, "read", "a.txt", conn=conn, data_dir=str(data_dir), project=project)
    assert ok.ok
    deny = ws.do(actor, "write", "b.txt", conn=conn, data_dir=str(data_dir), project=project, content="x")
    assert not deny.ok
    rows = store.list_workspace_audit(conn, project.id, limit=10)
    assert any(r["ok"] == 1 and r["action"] == "read" for r in rows)
    assert any(r["denied"] == 1 and r["action"] == "write" for r in rows)


def test_escalation_guard_workspace_permissions(conn, data_dir):
    project, root = _make_project(conn, data_dir)
    actor = _make_teammate(conn, project.id, permissions=["teammate.update", "permission.change"])
    target = _make_teammate(conn, project.id, permissions=[])
    with pytest.raises(Exception) as ei:
        fleet.update_teammate_service(conn, target.id, {"permissions": ["workspace.write"]}, acting=actor)
    msg = str(ei.value)
    assert "workspace.write" in msg or "lacks" in msg.lower() or "403" in msg


def test_workspace_mounts_mapping(tmp_path, monkeypatch):
    host = tmp_path / "host"
    container = tmp_path / "container"
    host.mkdir()
    container.mkdir()
    (container / "f.txt").write_text("ok", encoding="utf-8")
    monkeypatch.setenv("NERDBOT_WORKSPACE_MOUNTS", f"{host}={container}")
    mapped = ws.backend_workspace_path(host / "f.txt")
    assert str(mapped) == str(container / "f.txt")


def test_migration_existing_teammates(db_path, data_dir):
    # Simulate old DB by creating then ensuring migration adds columns.
    conn = store.connect(db_path)
    try:
        project = store.create_project(conn, owner="u1", repository="repo")
        # Insert a minimal teammate row missing new columns would have failed pre-migration; 
        # instead verify new columns exist and defaults apply.
        mate = store.create_teammate(conn, project_id=project.id, persona="old")
        cols = {r["name"] for r in conn.execute("PRAGMA table_info(teammates)").fetchall()}
        assert "autonomy_level" in cols
        assert "paused" in cols
        got = store.get_teammate(conn, mate.id)
        assert got.autonomy_level == "ask_first"
        assert got.paused is False
    finally:
        conn.close()
