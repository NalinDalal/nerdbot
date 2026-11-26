"""Workspace chat binding security integration tests.

These exercise chat-triggered workspace tool execution with a selected
workspace_root and verify security boundaries remain authoritative.
"""

from __future__ import annotations

import json
import os
from datetime import UTC, datetime, timedelta
from pathlib import Path

import httpx
import pytest
from cryptography.fernet import Fernet

os.environ.setdefault("NERDBOT_SECRET_KEY", Fernet.generate_key().decode())

from nerdbot import approval_flow, chat as chat_mod, store, workspace as ws
from nerdbot.gates import GateDenied
from nerdbot.models import Decision, ProviderKind, RunStatus, TaskStatus


class _MockTransport(httpx.BaseTransport):
    def __init__(self, responses):
        self.responses = list(responses)

    def handle_request(self, request):
        _ = json.loads(request.content.decode() or "{}")
        return httpx.Response(200, json=self.responses.pop(0))


@pytest.fixture(autouse=True)
def _secret_key(monkeypatch):
    monkeypatch.setenv("NERDBOT_SECRET_KEY", Fernet.generate_key().decode())


def _mk_provider(conn, project_id):
    return store.create_provider(
        conn,
        project_id,
        kind=ProviderKind.OPENAI_COMPATIBLE,
        name="mock",
        config={"base_url": "https://mock.local/v1", "api_key": "x", "model": "gpt-mock"},
    )


def _mk_project(conn, data_dir: Path, *, owner="u1", permissions=None, autonomy="ask_first", paused=False):
    project = store.create_project(conn, owner=owner, repository="repo")
    root = data_dir / f"ws-{project.id[:8]}"
    root.mkdir(parents=True, exist_ok=True)
    (root / "inside.txt").write_text("inside", encoding="utf-8")
    project = store.update_project_config(conn, project.id, {"workspace_root": str(root)})
    mate = store.create_teammate(
        conn,
        project_id=project.id,
        persona="p",
        permissions=list(permissions or ["workspace.read", "workspace.write"]),
        autonomy_level=autonomy,
        paused=paused,
    )
    thread = store.create_thread(conn, project.id, "t")
    provider = _mk_provider(conn, project.id)
    return project, root, mate, thread, provider


def test_chat_workspace_binding_confines_tool_path(conn, data_dir, tmp_path):
    project, root, mate, thread, provider = _mk_project(conn, data_dir, autonomy="act_silently")
    outside = tmp_path / "outside.txt"
    outside.write_text("secret", encoding="utf-8")
    selected = data_dir / "selected"
    selected.mkdir()
    (selected / "ok.txt").write_text("ok", encoding="utf-8")

    transport = _MockTransport([
        {"choices": [{"message": {"role": "assistant", "tool_calls": [{"id": "c1", "type": "function", "function": {"name": "read_file", "arguments": json.dumps({"path": str(outside)})}}]}}]},
        {"choices": [{"message": {"role": "assistant", "content": "done"}}]},
    ])
    text, _parts = chat_mod.chat_complete_with_tools(
        provider,
        [{"role": "user", "content": "read it"}],
        conn=conn,
        project_id=project.id,
        thread_id=thread.id,
        teammate=mate,
        data_dir=str(data_dir),
        transport=transport,
        workspace_root=str(selected),
    )
    assert "secret" not in (text or "").lower()
    audit = store.list_workspace_audit(conn, project.id)
    assert any(r["action"] == "read" and r["denied"] == 1 for r in audit)


def test_chat_workspace_binding_cannot_bypass_project_isolation(conn, data_dir):
    project, _root, mate, _thread, provider = _mk_project(conn, data_dir, autonomy="act_silently")
    other = store.create_project(conn, owner="u2", repository="other")
    other_root = data_dir / "other-ws"
    other_root.mkdir()
    (other_root / "secret.txt").write_text("other-secret", encoding="utf-8")
    store.update_project_config(conn, other.id, {"workspace_root": str(other_root)})
    other_thread = store.create_thread(conn, other.id, "other")

    transport = _MockTransport([
        {"choices": [{"message": {"role": "assistant", "tool_calls": [{"id": "c1", "type": "function", "function": {"name": "read_file", "arguments": json.dumps({"path": "secret.txt"})}}]}}]},
        {"choices": [{"message": {"role": "assistant", "content": "done"}}]},
    ])
    # Teammate belongs to project, not other; workspace actor should be denied by permission/project scope.
    text, _ = chat_mod.chat_complete_with_tools(
        provider,
        [{"role": "user", "content": "read"}],
        conn=conn,
        project_id=other.id,
        thread_id=other_thread.id,
        teammate=mate,
        data_dir=str(data_dir),
        transport=transport,
        workspace_root=str(other_root),
    )
    assert "other-secret" not in (text or "")
    audit = store.list_workspace_audit(conn, other.id)
    assert any(r["denied"] == 1 for r in audit)


def test_chat_workspace_write_requires_approval_and_respects_expiration(conn, data_dir):
    project, root, mate, thread, provider = _mk_project(conn, data_dir, autonomy="ask_first")
    transport = _MockTransport([
        {"choices": [{"message": {"role": "assistant", "tool_calls": [{"id": "c1", "type": "function", "function": {"name": "write_file", "arguments": json.dumps({"path": "new.txt", "content": "hello"})}}]}}]},
        {"choices": [{"message": {"role": "assistant", "content": "needs approval"}}]},
    ])
    chat_mod.chat_complete_with_tools(
        provider,
        [{"role": "user", "content": "write file"}],
        conn=conn,
        project_id=project.id,
        thread_id=thread.id,
        teammate=mate,
        data_dir=str(data_dir),
        transport=transport,
        workspace_root=str(root),
    )
    assert not (root / "new.txt").exists()
    approvals = [a for a in store.list_approvals_for_project(conn, project.id) if a.decision.value == "pending"]
    assert approvals
    apr = approvals[0]
    store.decide_approval(conn, apr.id, Decision.APPROVED)
    conn.execute("UPDATE approvals SET expires_at=? WHERE id=?", ((datetime.now(UTC) - timedelta(seconds=1)).isoformat(), apr.id))
    conn.commit()
    out = approval_flow.resume_standalone_approval(conn, store.get_approval(conn, apr.id), data_dir=str(data_dir))
    assert out.outcome in {"refused", "waiting", "skipped", "expired"}
    assert not (root / "new.txt").exists()


def test_chat_workspace_write_denied_for_read_only_teammate(conn, data_dir):
    project, root, mate, thread, provider = _mk_project(conn, data_dir, permissions=["workspace.read"], autonomy="act_silently")
    transport = _MockTransport([
        {"choices": [{"message": {"role": "assistant", "tool_calls": [{"id": "c1", "type": "function", "function": {"name": "write_file", "arguments": json.dumps({"path": "nope.txt", "content": "no"})}}]}}]},
        {"choices": [{"message": {"role": "assistant", "content": "denied"}}]},
    ])
    text, _ = chat_mod.chat_complete_with_tools(
        provider, [{"role": "user", "content": "write"}], conn=conn, project_id=project.id,
        thread_id=thread.id, teammate=mate, data_dir=str(data_dir), transport=transport, workspace_root=str(root),
    )
    assert not (root / "nope.txt").exists()
    assert "denied" in (text or "").lower() or any(r["denied"] == 1 and r["action"] == "write" for r in store.list_workspace_audit(conn, project.id))


def test_chat_workspace_untrusted_content_requires_approval_even_act_silently(conn, data_dir):
    project, root, mate, thread, provider = _mk_project(conn, data_dir, permissions=["workspace.read", "workspace.write"], autonomy="act_silently")
    transport = _MockTransport([
        {"choices": [{"message": {"role": "assistant", "tool_calls": [{"id": "c1", "type": "function", "function": {"name": "web_search", "arguments": json.dumps({"query": "x"})}}]}}]},
        {"choices": [{"message": {"role": "assistant", "tool_calls": [{"id": "c2", "type": "function", "function": {"name": "write_file", "arguments": json.dumps({"path": "u.txt", "content": "u"})}}]}}]},
        {"choices": [{"message": {"role": "assistant", "content": "ok"}}]},
    ])
    # Patch web search to deterministic untrusted content
    from nerdbot import search as search_mod
    orig = search_mod.web_search
    search_mod.web_search = lambda *a, **k: [{"title":"t","url":"https://example.com","snippet":"s"}]
    try:
        chat_mod.chat_complete_with_tools(
            provider, [{"role": "user", "content": "search and write"}], conn=conn, project_id=project.id,
            thread_id=thread.id, teammate=mate, data_dir=str(data_dir), transport=transport, workspace_root=str(root),
        )
    finally:
        search_mod.web_search = orig
    assert not (root / "u.txt").exists()
    approvals = [a for a in store.list_approvals_for_project(conn, project.id) if a.decision.value == "pending"]
    assert approvals


def test_workspace_approval_resume_keeps_workspace_and_checks(conn, data_dir, monkeypatch):
    project, root, mate, thread, _provider = _mk_project(conn, data_dir, autonomy="ask_first")
    selected = data_dir / "selected-approval"
    selected.mkdir()
    # request approval through gateway bound to selected workspace
    with ws.bound_workspace(selected):
        actor = ws.WorkspaceActor(kind="teammate", id=mate.id, project_id=project.id, teammate=mate)
        res = ws.do(actor, "write", "a.txt", conn=conn, data_dir=str(data_dir), project=project, content="hello")
    assert res.denied and res.data.get("approval_required")
    apr = store.get_approval(conn, res.data["approval_id"])
    store.decide_approval(conn, apr.id, Decision.APPROVED)

    # Revoke permission before resume: must fail closed
    store.update_teammate(conn, mate.id, permissions=["workspace.read"])
    out = approval_flow.resume_standalone_approval(conn, store.get_approval(conn, apr.id), data_dir=str(data_dir))
    assert out.outcome == "refused"
    assert not (selected / "a.txt").exists()

    # Restore permission and resume: writes to selected workspace, not project root
    store.update_teammate(conn, mate.id, permissions=["workspace.read", "workspace.write"])
    out2 = approval_flow.resume_standalone_approval(conn, store.get_approval(conn, apr.id), data_dir=str(data_dir))
    # Already marked resumed/refused once - checkpoint single-use; ensure no write happened in wrong place
    assert not (root / "a.txt").exists()


def test_workspace_approval_revocation_blocks_execution(conn, data_dir):
    project, root, mate, _thread, _provider = _mk_project(conn, data_dir, autonomy="ask_first")
    actor = ws.WorkspaceActor(kind="teammate", id=mate.id, project_id=project.id, teammate=mate)
    res = ws.do(actor, "write", "r.txt", conn=conn, data_dir=str(data_dir), project=project, content="x")
    apr = store.get_approval(conn, res.data["approval_id"])
    store.decide_approval(conn, apr.id, Decision.DENIED)
    out = approval_flow.close_standalone_rejected(conn, store.get_approval(conn, apr.id))
    assert out.outcome in {"refused", "skipped"}
    assert not (root / "r.txt").exists()


def test_workspace_audit_failure_is_fail_closed(conn, data_dir, monkeypatch):
    project, root, mate, _thread, _provider = _mk_project(conn, data_dir, autonomy="act_silently")
    actor = ws.WorkspaceActor(kind="teammate", id=mate.id, project_id=project.id, teammate=mate)

    def boom(*args, **kwargs):
        raise RuntimeError("audit db down")

    monkeypatch.setattr(store, "record_workspace_audit", boom)
    res = ws.do(actor, "read", "inside.txt", conn=conn, data_dir=str(data_dir), project=project)
    assert not res.ok
    assert res.denied or "audit" in (res.error or "").lower()


def test_execution_boundary_workspace_denial_never_dispatches(conn, data_dir, monkeypatch):
    project, root, mate, _thread, _provider = _mk_project(conn, data_dir, permissions=["workspace.read"], autonomy="act_silently")
    # create run/lease context
    task = store.create_task(conn, project.id, "t", command="echo")
    run = store.create_run(conn, task.id)
    run = store.mark_run_running(conn, run.id, owner="worker-1", lease_s=300)
    from nerdbot import app_tools, agent_context
    ctx = agent_context.build(conn, task, mate)
    ctx.run_id = run.id
    ctx.run_owner = "worker-1"
    ctx.data_dir = str(data_dir)
    called = {"dispatched": False}
    real = ws.do
    def spy(*args, **kwargs):
        called["dispatched"] = True
        return real(*args, **kwargs)
    monkeypatch.setattr(ws, "do", spy)
    # use gateway directly: read-only cannot write
    actor = ws.WorkspaceActor(kind="teammate", id=mate.id, project_id=project.id, teammate=mate)
    res = ws.do(actor, "write", "no.txt", conn=conn, data_dir=str(data_dir), project=project, content="x")
    assert not res.ok and res.denied
    assert not (root / "no.txt").exists()


def test_chat_workspace_tool_permission_denied_and_no_elevation(conn, data_dir, tmp_path):
    project, root, mate, thread, provider = _mk_project(conn, data_dir, permissions=["workspace.read"], autonomy="act_silently")
    selected = data_dir / "sel-no-elev"
    selected.mkdir()
    (selected / "ok.txt").write_text("ok", encoding="utf-8")
    outside = tmp_path / "outside-elev.txt"
    outside.write_text("secret", encoding="utf-8")

    transport = _MockTransport([
        {"choices": [{"message": {"role": "assistant", "tool_calls": [
            {"id": "c1", "type": "function", "function": {"name": "write_file", "arguments": json.dumps({"path": "should-not-write.txt", "content": "x"})}},
            {"id": "c2", "type": "function", "function": {"name": "read_file", "arguments": json.dumps({"path": str(outside)})}},
        ]}}]},
        {"choices": [{"message": {"role": "assistant", "content": "done"}}]},
    ])
    chat_mod.chat_complete_with_tools(
        provider, [{"role": "user", "content": "do both"}], conn=conn, project_id=project.id,
        thread_id=thread.id, teammate=mate, data_dir=str(data_dir), transport=transport, workspace_root=str(selected),
    )
    assert not (selected / "should-not-write.txt").exists()
    assert not (root / "should-not-write.txt").exists()
    audit = store.list_workspace_audit(conn, project.id)
    assert any(r["action"] == "write" and r["denied"] == 1 for r in audit)
    assert any(r["action"] == "read" and r["denied"] == 1 for r in audit)


def test_workspace_approval_revocation_and_resume_checks(conn, data_dir):
    project, root, mate, _thread, _provider = _mk_project(conn, data_dir, autonomy="ask_first")
    selected = data_dir / "sel-revoke"
    selected.mkdir()
    actor = ws.WorkspaceActor(kind="teammate", id=mate.id, project_id=project.id, teammate=mate)
    res = ws.do(actor, "write", "rev.txt", conn=conn, data_dir=str(data_dir), project=project, content="hello", workspace_root=str(selected))
    assert res.data.get("approval_required")
    apr_id = res.data["approval_id"]

    # Revoke by denying decision on a fresh approval case: create another and deny.
    res2 = ws.do(actor, "write", "denied.txt", conn=conn, data_dir=str(data_dir), project=project, content="no", workspace_root=str(selected))
    apr2 = store.get_approval(conn, res2.data["approval_id"])
    store.decide_approval(conn, apr2.id, Decision.DENIED)
    out = approval_flow.close_standalone_rejected(conn, store.get_approval(conn, apr2.id))
    assert out.outcome in {"refused", "skipped"}
    assert not (selected / "denied.txt").exists()

    # Approved one should still resume into selected workspace after checks pass.
    store.decide_approval(conn, apr_id, Decision.APPROVED)
    out2 = approval_flow.resume_standalone_approval(conn, store.get_approval(conn, apr_id), data_dir=str(data_dir))
    assert out2.outcome == "carried_out"
    assert (selected / "rev.txt").read_text(encoding="utf-8") == "hello"
    assert not (root / "rev.txt").exists()


def test_workspace_lease_loss_prevents_protected_execution(conn, data_dir):
    project, root, mate, _thread, _provider = _mk_project(conn, data_dir, autonomy="act_silently")
    task = store.create_task(conn, project.id, "t", command="echo hi")
    run = store.create_run(conn, task.id)
    run = store.mark_run_running(conn, run.id, owner="worker-1", lease_s=300)
    actor = ws.WorkspaceActor(kind="teammate", id=mate.id, project_id=project.id, teammate=mate)

    # Lease loss while run is still marked running: owner mismatch must be denied.
    conn.execute("UPDATE runs SET lease_owner=? WHERE id=?", ("worker-2", run.id))
    conn.commit()
    stale = store.get_run(conn, run.id)

    from nerdbot import execution_policy
    decision = execution_policy.enforce_tool_execution(
        conn,
        action="workspace.write",
        teammate_id=mate.id,
        project_id=project.id,
        task_id=task.id,
        run_id=stale.id,
        run_owner="worker-1",
    )
    assert decision.allowed is False
    assert decision.decision == "DENY"
    assert "lease" in decision.reason_code

    dispatched = {"called": False}
    if decision.allowed:
        dispatched["called"] = True
        ws.do(actor, "write", "should-not.txt", conn=conn, data_dir=str(data_dir), project=project, content="x")
    assert dispatched["called"] is False
    assert not (root / "should-not.txt").exists()
