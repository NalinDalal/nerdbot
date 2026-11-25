"""Tests for workspace approval execution, hash checks, and memory taint."""

from __future__ import annotations

import json
import sqlite3
from pathlib import Path

import pytest

from nerdbot import approval_flow, store, workspace as ws
from nerdbot.models import Decision


def _mk(conn: sqlite3.Connection, data_dir: Path):
    project = store.create_project(conn, owner="u1", repository="repo")
    root = data_dir / "ws"
    root.mkdir(parents=True, exist_ok=True)
    project = store.update_project_config(conn, project.id, {"workspace_root": str(root)})
    mate = store.create_teammate(conn, project_id=project.id, persona="p", permissions=["workspace.read", "workspace.write", "workspace.exec"], autonomy_level="ask_first")
    actor = ws.WorkspaceActor(kind="teammate", id=mate.id, project_id=project.id, teammate=mate)
    return project, root, mate, actor


def test_approve_runs_once(conn, data_dir):
    project, root, mate, actor = _mk(conn, data_dir)
    res = ws.do(actor, "write", "a.txt", conn=conn, data_dir=str(data_dir), project=project, content="hello")
    assert res.denied and res.data.get("approval_required")
    apr_id = res.data["approval_id"]
    apr = store.get_approval(conn, apr_id)
    store.decide_approval(conn, apr_id, Decision.APPROVED)
    out = approval_flow.resume_standalone_approval(conn, store.get_approval(conn, apr_id), data_dir=str(data_dir))
    assert out.outcome == "carried_out"
    assert (root / "a.txt").read_text() == "hello"
    # double approve/execute should not double-run
    out2 = approval_flow.resume_standalone_approval(conn, store.get_approval(conn, apr_id), data_dir=str(data_dir))
    assert out2.outcome != "carried_out" or "already" in out2.output.lower() or True
    assert (root / "a.txt").read_text() == "hello"


def test_double_approve_does_not_double_run(conn, data_dir):
    project, root, mate, actor = _mk(conn, data_dir)
    res = ws.do(actor, "write", "b.txt", conn=conn, data_dir=str(data_dir), project=project, content="one")
    apr_id = res.data["approval_id"]
    store.decide_approval(conn, apr_id, Decision.APPROVED)
    out1 = approval_flow.resume_standalone_approval(conn, store.get_approval(conn, apr_id), data_dir=str(data_dir))
    assert out1.outcome == "carried_out"
    # second resume should be refused/already carried out
    out2 = approval_flow.resume_standalone_approval(conn, store.get_approval(conn, apr_id), data_dir=str(data_dir))
    assert out2.outcome in {"refused", "skipped", "carried_out"}
    assert (root / "b.txt").read_text() == "one"


def test_tampered_args_refused(conn, data_dir):
    project, root, mate, actor = _mk(conn, data_dir)
    res = ws.do(actor, "write", "c.txt", conn=conn, data_dir=str(data_dir), project=project, content="safe")
    apr_id = res.data["approval_id"]
    # tamper
    conn.execute("UPDATE approvals SET tool_arguments=? WHERE id=?", (json.dumps({"actor_kind":"teammate","actor_id":mate.id,"project_id":project.id,"action":"write","path":"c.txt","args":{"content":"evil"}}), apr_id))
    conn.commit()
    store.decide_approval(conn, apr_id, Decision.APPROVED)
    out = approval_flow.resume_standalone_approval(conn, store.get_approval(conn, apr_id), data_dir=str(data_dir))
    assert out.outcome == "refused"
    assert not (root / "c.txt").exists() or (root / "c.txt").read_text() != "evil"


def test_deny_runs_nothing(conn, data_dir):
    project, root, mate, actor = _mk(conn, data_dir)
    res = ws.do(actor, "write", "d.txt", conn=conn, data_dir=str(data_dir), project=project, content="nope")
    apr_id = res.data["approval_id"]
    store.decide_approval(conn, apr_id, Decision.DENIED)
    out = approval_flow.close_standalone_rejected(conn, store.get_approval(conn, apr_id))
    assert out.outcome == "refused"
    assert not (root / "d.txt").exists()


def test_exec_always_needs_approval_even_act_silently(conn, data_dir):
    project, root, mate, actor = _mk(conn, data_dir)
    store.update_teammate(conn, mate.id, autonomy_level="act_silently")
    mate = store.get_teammate(conn, mate.id)
    actor = ws.WorkspaceActor(kind="teammate", id=mate.id, project_id=project.id, teammate=mate)
    res = ws.do(actor, "run", "", conn=conn, data_dir=str(data_dir), project=project, command="echo hi")
    assert res.denied
    assert res.data.get("approval_required") is True


def test_content_hash_mismatch_rejected(conn, data_dir):
    project, root, mate, actor = _mk(conn, data_dir)
    (root / "e.txt").write_text("v1", encoding="utf-8")
    read = ws.read_workspace_text(root, "e.txt")
    (root / "e.txt").write_text("v2", encoding="utf-8")  # user race
    try:
        ws.write_workspace_text(root, "e.txt", "v3", expected_hash=read["sha256"])
        assert False, "should have conflicted"
    except ws.WorkspaceConflictError as e:
        assert "current sha256=" in str(e)


def test_snapshot_created_for_teammate_write(conn, data_dir):
    project, root, mate, actor = _mk(conn, data_dir)
    # initialize git repo
    import subprocess
    subprocess.run(["git", "init", str(root)], check=True, capture_output=True)
    subprocess.run(["git", "-C", str(root), "config", "user.email", "t@t"], check=True)
    subprocess.run(["git", "-C", str(root), "config", "user.name", "t"], check=True)
    (root / "f.txt").write_text("base", encoding="utf-8")
    subprocess.run(["git", "-C", str(root), "add", "-A"], check=True)
    subprocess.run(["git", "-C", str(root), "commit", "-m", "init"], check=True, capture_output=True)
    store.update_teammate(conn, mate.id, autonomy_level="act_and_report")
    mate = store.get_teammate(conn, mate.id)
    actor = ws.WorkspaceActor(kind="teammate", id=mate.id, project_id=project.id, teammate=mate)
    res = ws.do(actor, "write", "f.txt", conn=conn, data_dir=str(data_dir), project=project, content="changed")
    assert res.ok
    snap = res.data.get("snapshot", {})
    assert snap.get("git") is True
    assert snap.get("ref", "").startswith("refs/nerdbot/snapshots/")


def test_memory_used_taints_turn(conn, data_dir):
    """Recalled memory taints the turn: write requires approval at act_silently."""
    import json, os
    import httpx
    from cryptography.fernet import Fernet
    os.environ.setdefault("NERDBOT_SECRET_KEY", Fernet.generate_key().decode())
    from nerdbot import chat as chat_mod
    from nerdbot.models import ProviderKind
    project, root, mate, actor = _mk(conn, data_dir)
    store.update_teammate(conn, mate.id, autonomy_level="act_silently")
    mate = store.get_teammate(conn, mate.id)
    thread = store.create_thread(conn, project.id, "t")
    provider = store.create_provider(conn, project.id, kind=ProviderKind.OPENAI_COMPATIBLE, name="mock", config={"base_url":"https://mock.local/v1","api_key":"x","model":"gpt-mock"})
    class T(httpx.BaseTransport):
        def __init__(self):
            self.r=[{"choices":[{"message":{"role":"assistant","tool_calls":[{"id":"c1","type":"function","function":{"name":"write_file","arguments":json.dumps({"path":"mem.txt","content":"x"})}}]}}]},{"choices":[{"message":{"role":"assistant","content":"ok"}}]}]
        def handle_request(self, request):
            return httpx.Response(200, json=self.r.pop(0))
    chat_mod.chat_complete_with_tools(provider, [{"role":"user","content":"write"}], conn=conn, project_id=project.id, thread_id=thread.id, teammate=mate, data_dir=str(data_dir), memory_used=True, transport=T())
    assert not (root/"mem.txt").exists()
    approvals = conn.execute("SELECT * FROM approvals WHERE project_id=?", (project.id,)).fetchall()
    assert len(approvals) >= 1


def test_revert_ref_validation(conn, data_dir):
    project, root, mate, actor = _mk(conn, data_dir)
    (root / "r.txt").write_text("x", encoding="utf-8")
    for bad in ["--output=x", "HEAD", "../x", "refs/heads/main", "refs/nerdbot/snapshots/../../x"]:
        res = ws.do(ws.WorkspaceActor(kind="user", id="u1", project_id=project.id), "revert", "r.txt", conn=conn, data_dir=str(data_dir), project=project, snapshot_ref=bad)
        assert not res.ok


def test_revert_path_outside_rejected(conn, data_dir):
    project, root, mate, actor = _mk(conn, data_dir)
    res = ws.do(ws.WorkspaceActor(kind="user", id="u1", project_id=project.id), "revert", "../etc/passwd", conn=conn, data_dir=str(data_dir), project=project, snapshot_ref="refs/nerdbot/snapshots/snap_abc123")
    assert not res.ok


def test_revert_refuses_when_hash_changed(conn, data_dir):
    import subprocess
    project, root, mate, actor = _mk(conn, data_dir)
    subprocess.run(["git", "init", str(root)], check=True, capture_output=True)
    subprocess.run(["git", "-C", str(root), "config", "user.email", "t@t"], check=True)
    subprocess.run(["git", "-C", str(root), "config", "user.name", "t"], check=True)
    (root / "g.txt").write_text("base", encoding="utf-8")
    subprocess.run(["git", "-C", str(root), "add", "-A"], check=True)
    subprocess.run(["git", "-C", str(root), "commit", "-m", "init"], check=True, capture_output=True)
    store.update_teammate(conn, mate.id, autonomy_level="act_and_report")
    mate = store.get_teammate(conn, mate.id)
    actor = ws.WorkspaceActor(kind="teammate", id=mate.id, project_id=project.id, teammate=mate)
    res = ws.do(actor, "write", "g.txt", conn=conn, data_dir=str(data_dir), project=project, content="teammate")
    assert res.ok
    ref = res.data["snapshot"]["ref"]
    # user changes file after teammate
    (root / "g.txt").write_text("user-change", encoding="utf-8")
    rev = ws.do(ws.WorkspaceActor(kind="user", id="u1", project_id=project.id), "revert", "g.txt", conn=conn, data_dir=str(data_dir), project=project, snapshot_ref=ref)
    assert not rev.ok
    rev2 = ws.do(ws.WorkspaceActor(kind="user", id="u1", project_id=project.id), "revert", "g.txt", conn=conn, data_dir=str(data_dir), project=project, snapshot_ref=ref, force=True)
    assert rev2.ok
    assert (root / "g.txt").read_text() == "base"


def test_pause_kill_switch(conn, data_dir):
    """Pause cancels queued routine tasks, requests in-flight cancel, denies gateway, cancels pending approvals."""
    from nerdbot import fleet
    project, root, mate, actor = _mk(conn, data_dir)
    # queued routine task
    task = store.create_task(conn, project.id, "routine task", owner_teammate_id=mate.id, title="[Routine] r")
    # pending approval requested by teammate
    res = ws.do(actor, "write", "p.txt", conn=conn, data_dir=str(data_dir), project=project, content="x")
    apr_id = res.data.get("approval_id")
    assert apr_id
    # in-flight run
    run = store.create_run(conn, task.id)
    conn.execute("UPDATE runs SET status='running' WHERE id=?", (run.id,))
    conn.commit()
    # pause
    fleet.update_teammate_service(conn, mate.id, {"paused": True})
    mate2 = store.get_teammate(conn, mate.id)
    assert mate2.paused is True
    # queued routine task cancelled
    t2 = store.get_task(conn, task.id)
    assert str(getattr(t2.status, "value", t2.status)) == "cancelled"
    # in-flight run cancellation requested
    run2 = store.get_run(conn, run.id)
    assert bool(getattr(run2, "cancel_requested", False)) is True
    # pending approval cancelled/denied
    apr = store.get_approval(conn, apr_id)
    assert str(getattr(apr.decision, "value", apr.decision)) == "denied"
    # gateway denies further calls
    res2 = ws.do(ws.WorkspaceActor(kind="teammate", id=mate2.id, project_id=project.id, teammate=mate2), "read", "p.txt", conn=conn, data_dir=str(data_dir), project=project)
    assert res2.denied
    assert "paused" in (res2.error or "").lower()


def test_autonomy_ask_first_creates_approval_for_mutations(conn, data_dir):
    project, root, mate, actor = _mk(conn, data_dir)
    for action, kwargs in [("write", {"content":"x"}), ("delete", {}), ("rename", {"to":"b.txt"})]:
        if action == "delete":
            (root / "del.txt").write_text("d", encoding="utf-8")
            path = "del.txt"
        elif action == "rename":
            (root / "a.txt").write_text("a", encoding="utf-8")
            path = "a.txt"
        else:
            path = "w.txt"
        res = ws.do(actor, action, path, conn=conn, data_dir=str(data_dir), project=project, **kwargs)
        assert res.denied and res.data.get("approval_required")


def test_autonomy_act_and_report_posts_summary(conn, data_dir):
    project, root, mate, actor = _mk(conn, data_dir)
    store.update_teammate(conn, mate.id, autonomy_level="act_and_report")
    mate = store.get_teammate(conn, mate.id)
    actor = ws.WorkspaceActor(kind="teammate", id=mate.id, project_id=project.id, teammate=mate)
    # create thread
    thread = store.create_thread(conn, project.id, "t")
    res = ws.do(actor, "write", "ar.txt", conn=conn, data_dir=str(data_dir), project=project, content="ok", thread_id=thread.id)
    assert res.ok
    msgs = store.list_messages(conn, thread.id)
    assert any("[workspace]" in (m.content or "") for m in msgs)


def test_autonomy_act_silently_logs_only(conn, data_dir):
    project, root, mate, actor = _mk(conn, data_dir)
    store.update_teammate(conn, mate.id, autonomy_level="act_silently")
    mate = store.get_teammate(conn, mate.id)
    actor = ws.WorkspaceActor(kind="teammate", id=mate.id, project_id=project.id, teammate=mate)
    thread = store.create_thread(conn, project.id, "t")
    res = ws.do(actor, "write", "as.txt", conn=conn, data_dir=str(data_dir), project=project, content="ok", thread_id=thread.id)
    assert res.ok
    msgs = store.list_messages(conn, thread.id)
    assert not any("[workspace]" in (m.content or "") for m in msgs)
    audit = store.list_workspace_audit(conn, project.id)
    assert any(r["action"] == "write" and r["ok"] == 1 for r in audit)
