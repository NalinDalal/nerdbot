"""End-to-end smoke tests for workspace tool flow with mock provider behavior."""

from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path

from cryptography.fernet import Fernet

os.environ.setdefault("NERDBOT_SECRET_KEY", Fernet.generate_key().decode())

from nerdbot import approval_flow, chat as chat_mod, store, workspace as ws
from nerdbot.models import Decision, ProviderKind


import httpx


class _MockTransport(httpx.BaseTransport):
    """Minimal mock transport returning a predetermined OpenAI-style response."""

    def __init__(self, responses):
        self.responses = list(responses)
        self.calls = []

    def handle_request(self, request):
        self.calls.append(request)
        _ = json.loads(request.content.decode())
        resp = self.responses.pop(0)
        return httpx.Response(200, json=resp)


def _mk_provider(conn, project_id):
    return store.create_provider(conn, project_id, kind=ProviderKind.OPENAI_COMPATIBLE, name="mock", config={"base_url": "https://mock.local/v1", "api_key": "x", "model": "gpt-mock"})


def test_e2e_ask_first_write_approval_audit_snapshot_revert(conn, data_dir):
    project = store.create_project(conn, owner="u1", repository="repo")
    root = data_dir / "ws"; root.mkdir(parents=True, exist_ok=True)
    project = store.update_project_config(conn, project.id, {"workspace_root": str(root)})
    # init git for snapshot
    import subprocess
    subprocess.run(["git","init",str(root)], check=True, capture_output=True)
    subprocess.run(["git","-C",str(root),"config","user.email","t@t"], check=True)
    subprocess.run(["git","-C",str(root),"config","user.name","t"], check=True)
    (root/"base.txt").write_text("base", encoding="utf-8")
    subprocess.run(["git","-C",str(root),"add","-A"], check=True)
    subprocess.run(["git","-C",str(root),"commit","-m","init"], check=True, capture_output=True)
    mate = store.create_teammate(conn, project_id=project.id, persona="p", permissions=["workspace.write","workspace.read"], autonomy_level="ask_first")
    thread = store.create_thread(conn, project.id, "t")
    provider = _mk_provider(conn, project.id)
    # mock provider returns a write_file tool call, then final text
    transport = _MockTransport([
        {"choices":[{"message":{"role":"assistant","tool_calls":[{"id":"c1","type":"function","function":{"name":"write_file","arguments":json.dumps({"path":"base.txt","content":"hello"})}}]}}]},
        {"choices":[{"message":{"role":"assistant","content":"done"}}]},
    ])
    text, parts = chat_mod.chat_complete_with_tools(provider, [{"role":"user","content":"write base"}], conn=conn, project_id=project.id, thread_id=thread.id, teammate=mate, data_dir=str(data_dir), memory_used=False, transport=transport)
    # approval appears
    approvals = store.list_approvals(conn, project_id=project.id) if hasattr(store, "list_approvals") else conn.execute("SELECT * FROM approvals WHERE project_id=?", (project.id,)).fetchall()
    assert len(list(approvals)) >= 1
    apr = store.get_approval(conn, list(approvals)[0]["id"] if isinstance(list(approvals)[0], dict) or hasattr(list(approvals)[0], "keys") else list(approvals)[0].id)
    store.decide_approval(conn, apr.id, Decision.APPROVED)
    out = approval_flow.resume_standalone_approval(conn, store.get_approval(conn, apr.id), data_dir=str(data_dir))
    assert out.outcome == "carried_out"
    assert (root/"base.txt").read_text() == "hello"
    read = ws.read_workspace_text(root, "base.txt")
    expected_hash = read["sha256"]
    assert expected_hash == hashlib.sha256(b"hello").hexdigest()
    audit = store.list_workspace_audit(conn, project.id)
    assert any(r["action"] == "write" for r in audit)
    # snapshot exists on a teammate write - check audit args and git ref
    write_audit = [r for r in audit if r["action"] == "write" and r["ok"] == 1]
    assert write_audit
    snap = json.loads(write_audit[-1].get("args_summary") or "{}").get("snapshot", {})
    assert snap.get("ref", "").startswith("refs/nerdbot/snapshots/")
    show_ref = subprocess.run(["git","-C",str(root),"show-ref","--verify",snap["ref"]], capture_output=True)
    assert show_ref.returncode == 0
    # Changed since snapshot: refuse without force, restore with force.
    rev_conflict = ws.do(ws.WorkspaceActor(kind="user", id="u1", project_id=project.id), "revert", "base.txt", conn=conn, data_dir=str(data_dir), project=project, snapshot_ref=snap["ref"])
    assert not rev_conflict.ok
    rev = ws.do(ws.WorkspaceActor(kind="user", id="u1", project_id=project.id), "revert", "base.txt", conn=conn, data_dir=str(data_dir), project=project, snapshot_ref=snap["ref"], force=True)
    assert rev.ok
    assert (root/"base.txt").read_text() == "base"
    assert any(r["action"] == "revert" and r["ok"] == 1 for r in store.list_workspace_audit(conn, project.id))


def test_e2e_read_only_denies_write(conn, data_dir):
    project = store.create_project(conn, owner="u1", repository="repo")
    root = data_dir / "ws"; root.mkdir(parents=True, exist_ok=True)
    project = store.update_project_config(conn, project.id, {"workspace_root": str(root)})
    mate = store.create_teammate(conn, project_id=project.id, persona="p", permissions=["workspace.read"], autonomy_level="act_silently")
    thread = store.create_thread(conn, project.id, "t")
    provider = _mk_provider(conn, project.id)
    transport = _MockTransport([
        {"choices":[{"message":{"role":"assistant","tool_calls":[{"id":"c1","type":"function","function":{"name":"write_file","arguments":json.dumps({"path":"nope.txt","content":"no"})}}]}}]},
        {"choices":[{"message":{"role":"assistant","content":"denied"}}]},
    ])
    chat_mod.chat_complete_with_tools(provider, [{"role":"user","content":"write"}], conn=conn, project_id=project.id, thread_id=thread.id, teammate=mate, data_dir=str(data_dir), memory_used=False, transport=transport)
    assert not (root/"nope.txt").exists()


def test_e2e_untrusted_act_silently_still_needs_approval(conn, data_dir):
    project = store.create_project(conn, owner="u1", repository="repo")
    root = data_dir / "ws"; root.mkdir(parents=True, exist_ok=True)
    project = store.update_project_config(conn, project.id, {"workspace_root": str(root)})
    mate = store.create_teammate(conn, project_id=project.id, persona="p", permissions=["workspace.read","workspace.write"], autonomy_level="act_silently")
    thread = store.create_thread(conn, project.id, "t")
    provider = _mk_provider(conn, project.id)
    # web_search (untrusted) then write_file in same turn
    transport = _MockTransport([
        {"choices":[{"message":{"role":"assistant","tool_calls":[{"id":"c1","type":"function","function":{"name":"web_search","arguments":json.dumps({"query":"x"})}}]}}]},
        {"choices":[{"message":{"role":"assistant","tool_calls":[{"id":"c2","type":"function","function":{"name":"write_file","arguments":json.dumps({"path":"u.txt","content":"u"})}}]}}]},
        {"choices":[{"message":{"role":"assistant","content":"ok"}}]},
    ])
    chat_mod.chat_complete_with_tools(provider, [{"role":"user","content":"search and write"}], conn=conn, project_id=project.id, thread_id=thread.id, teammate=mate, data_dir=str(data_dir), memory_used=False, transport=transport)
    # should not have written without approval
    # either file not exists or approval pending
    approvals = conn.execute("SELECT * FROM approvals WHERE project_id=?", (project.id,)).fetchall()
    assert not (root/"u.txt").exists()
    assert len(approvals) >= 1
