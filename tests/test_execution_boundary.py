"""Execution-boundary autonomy enforcement regression tests."""

from __future__ import annotations

import json
import sqlite3
from datetime import UTC, datetime, timedelta

import pytest

from nerdbot import app_tools, gates, store, workspace as ws
from nerdbot.agent_context import AgentContext
from nerdbot.models import Decision, RunStatus, TaskStatus, TeammateStatus


def _mk(tmp_path, *, tool_permissions=None, paused=False):
    db = tmp_path / "t.db"
    conn = store.connect(db)
    project = store.create_project(conn, owner="local", repository="", config={"name": "p"})
    root = tmp_path / "ws"
    root.mkdir(parents=True, exist_ok=True)
    store.update_project_config(conn, project.id, {"workspace_root": str(root)})
    mate = store.create_teammate(
        conn,
        project_id=project.id,
        persona="worker",
        permissions=tool_permissions or ["workspace.read", "workspace.write", "task.create", "email.send"],
        autonomy_level="act_silently",
        paused=paused,
    )
    task = store.create_task(conn, project.id, "do work", command="echo hi", owner_teammate_id=mate.id)
    run = store.create_run(conn, task.id)
    run = store.mark_run_running(conn, run.id, owner="worker-1", lease_s=300)
    store.set_task_status(conn, task.id, TaskStatus.RUNNING)
    ctx = AgentContext(conn=conn, task=task, project=project, teammate=mate, system_message="", allowed_permissions=frozenset(mate.permissions))
    ctx.run_id = run.id
    ctx.run_owner = "worker-1"
    ctx.data_dir = str(tmp_path)
    return conn, project, root, mate, task, run, ctx


def _audit_rows(conn, project_id):
    return store.list_workspace_audit(conn, project_id)


def test_expired_approval_blocks_execution(tmp_path):
    conn, project, root, mate, task, run, ctx = _mk(tmp_path, tool_permissions=["email.send"])
    try:
        out = app_tools.execute_app_tool(ctx, "send_email", {"to": "a@b.com", "subject": "hi", "body": "body"}, data_dir=str(tmp_path), run_id=run.id)
        apr = ctx.pending_approvals[-1]
        store.decide_approval(conn, apr.id, Decision.APPROVED)
        conn.execute("UPDATE approvals SET expires_at=? WHERE id=?", ((datetime.now(UTC)-timedelta(seconds=1)).isoformat(), apr.id))
        conn.commit()
        from nerdbot import approval_flow
        outcome = approval_flow.resume_run(conn, run.id, str(tmp_path))
        assert outcome.outcome in {"refused", "waiting"}
        assert  [n for n in store.list_notifications(conn, project.id) if n.channel=='outbox'] == []
    finally:
        conn.close()


def test_revoked_approval_blocks_execution(tmp_path):
    conn, project, root, mate, task, run, ctx = _mk(tmp_path, tool_permissions=["email.send"])
    try:
        out = app_tools.execute_app_tool(ctx, "send_email", {"to": "a@b.com", "subject": "hi", "body": "body"}, data_dir=str(tmp_path), run_id=run.id)
        apr = ctx.pending_approvals[-1]
        store.decide_approval(conn, apr.id, Decision.DENIED)
        from nerdbot import approval_flow
        outcome = approval_flow.resume_run(conn, run.id, str(tmp_path))
        assert  [n for n in store.list_notifications(conn, project.id) if n.channel=='outbox'] == []
        assert outcome.outcome in {"refused", "skipped", "waiting"}
    finally:
        conn.close()


def test_approval_for_one_action_cannot_authorize_different_action(tmp_path):
    conn, project, root, mate, task, run, ctx = _mk(tmp_path, tool_permissions=["email.send"])
    try:
        out = app_tools.execute_app_tool(ctx, "send_email", {"to": "a@b.com", "subject": "hi", "body": "body"}, data_dir=str(tmp_path), run_id=run.id)
        apr = ctx.pending_approvals[-1]
        store.decide_approval(conn, apr.id, Decision.APPROVED)
        conn.execute("UPDATE approvals SET tool_arguments=? WHERE id=?", (json.dumps({"to":"evil@b.com","subject":"hi","body":"body"}), apr.id))
        conn.commit()
        from nerdbot import approval_flow
        outcome = approval_flow.resume_run(conn, run.id, str(tmp_path))
        assert  [n for n in store.list_notifications(conn, project.id) if n.channel=='outbox'] == []
        assert outcome.outcome == "refused"
    finally:
        conn.close()


def test_approval_for_one_project_or_agent_cannot_authorize_another(tmp_path):
    conn, project, root, mate, task, run, ctx = _mk(tmp_path, tool_permissions=["email.send"])
    try:
        out = app_tools.execute_app_tool(ctx, "send_email", {"to": "a@b.com", "subject": "hi", "body": "body"}, data_dir=str(tmp_path), run_id=run.id)
        apr = ctx.pending_approvals[-1]
        store.decide_approval(conn, apr.id, Decision.APPROVED)
        # different agent
        other = store.create_teammate(conn, project.id, persona="other", permissions=["email.send"], autonomy_level="act_silently")
        conn.execute("UPDATE approvals SET teammate_id=? WHERE id=?", (other.id, apr.id))
        conn.commit()
        from nerdbot import approval_flow
        outcome = approval_flow.resume_run(conn, run.id, str(tmp_path))
        assert  [n for n in store.list_notifications(conn, project.id) if n.channel=='outbox'] == []
        assert outcome.outcome == "refused"
    finally:
        conn.close()


def test_paused_agent_blocks_tool_execution(tmp_path):
    conn, project, root, mate, task, run, ctx = _mk(tmp_path, tool_permissions=["task.create"], paused=True)
    try:
        out = app_tools.execute_app_tool(ctx, "create_task", {"description": "x"}, data_dir=str(tmp_path), run_id=run.id)
        assert "denied" in out.lower() or "paused" in out.lower()
        assert conn.execute("SELECT COUNT(*) c FROM tasks WHERE project_id=? AND description='x'", (project.id,)).fetchone()["c"] == 0
    finally:
        conn.close()


def test_stopped_agent_blocks_tool_execution(tmp_path):
    conn, project, root, mate, task, run, ctx = _mk(tmp_path, tool_permissions=["task.create"])
    try:
        store.set_teammate_status(conn, mate.id, TeammateStatus.DISABLED)
        ctx.teammate = store.get_teammate(conn, mate.id)
        out = app_tools.execute_app_tool(ctx, "create_task", {"description": "x"}, data_dir=str(tmp_path), run_id=run.id)
        assert "denied" in out.lower() or "not active" in out.lower()
        assert conn.execute("SELECT COUNT(*) c FROM tasks WHERE project_id=? AND description='x'", (project.id,)).fetchone()["c"] == 0
    finally:
        conn.close()


def test_revoking_permission_after_planning_blocks_execution(tmp_path):
    conn, project, root, mate, task, run, ctx = _mk(tmp_path, tool_permissions=["email.send"])
    try:
        out = app_tools.execute_app_tool(ctx, "send_email", {"to": "a@b.com", "subject": "hi", "body": "body"}, data_dir=str(tmp_path), run_id=run.id)
        apr = ctx.pending_approvals[-1]
        store.decide_approval(conn, apr.id, Decision.APPROVED)
        store.update_teammate(conn, mate.id, permissions=["workspace.read"])  # revoke email.send
        from nerdbot import approval_flow
        outcome = approval_flow.resume_run(conn, run.id, str(tmp_path))
        assert  [n for n in store.list_notifications(conn, project.id) if n.channel=='outbox'] == []
        assert outcome.outcome == "refused"
    finally:
        conn.close()


def test_losing_run_lease_ownership_blocks_protected_execution(tmp_path):
    conn, project, root, mate, task, run, ctx = _mk(tmp_path, tool_permissions=["task.create"])
    try:
        conn.execute("UPDATE runs SET lease_owner=? WHERE id=?", ("worker-2", run.id))
        conn.commit()
        out = app_tools.execute_app_tool(ctx, "create_task", {"description": "x"}, data_dir=str(tmp_path), run_id=run.id)
        assert "denied" in out.lower() or "lease" in out.lower() or "owner" in out.lower()
        assert conn.execute("SELECT COUNT(*) c FROM tasks WHERE project_id=? AND description='x'", (project.id,)).fetchone()["c"] == 0
    finally:
        conn.close()


def test_unknown_actions_fail_closed(tmp_path):
    conn, project, root, mate, task, run, ctx = _mk(tmp_path, tool_permissions=["task.create"])
    try:
        out = app_tools.execute_app_tool(ctx, "totally_unknown_tool", {}, data_dir=str(tmp_path), run_id=run.id)
        assert "unknown tool" in out.lower()
        rows = conn.execute("SELECT decision, reason_code FROM execution_policy_audit WHERE project_id=?", (project.id,)).fetchall()
        assert any(r["decision"].lower() == "deny" for r in rows)
    finally:
        conn.close()


def test_denied_and_approval_required_do_not_execute_tool(tmp_path):
    conn, project, root, mate, task, run, ctx = _mk(tmp_path, tool_permissions=["email.send"])
    try:
        # approval required
        out = app_tools.execute_app_tool(ctx, "send_email", {"to": "a@b.com", "subject": "hi", "body": "body"}, data_dir=str(tmp_path), run_id=run.id)
        assert "APPROVAL REQUIRED" in out
        assert  [n for n in store.list_notifications(conn, project.id) if n.channel=='outbox'] == []
        # denied by missing permission
        store.update_teammate(conn, mate.id, permissions=["workspace.read"])
        ctx.teammate = store.get_teammate(conn, mate.id)
        ctx.allowed_permissions = frozenset(ctx.teammate.permissions)
        out2 = app_tools.execute_app_tool(ctx, "send_email", {"to": "a@b.com", "subject": "hi2", "body": "body"}, data_dir=str(tmp_path), run_id=run.id)
        assert "permission denied" in out2.lower() or "denied" in out2.lower()
        assert  [n for n in store.list_notifications(conn, project.id) if n.channel=='outbox'] == []
    finally:
        conn.close()


def test_every_policy_decision_produces_auditable_record(tmp_path):
    conn, project, root, mate, task, run, ctx = _mk(tmp_path, tool_permissions=["task.create"])
    try:
        app_tools.execute_app_tool(ctx, "create_task", {"description": "ok"}, data_dir=str(tmp_path), run_id=run.id)
        rows = conn.execute("SELECT action, decision, reason_code, run_id, task_id, teammate_id FROM execution_policy_audit WHERE project_id=?", (project.id,)).fetchall()
        assert rows
        assert any(r["action"] == "task.create" and r["decision"].lower() == "allow" and r["run_id"] == run.id and r["task_id"] == task.id and r["teammate_id"] == mate.id for r in rows)
    finally:
        conn.close()


def test_concurrent_policy_or_approval_changes_cannot_bypass_final_check(tmp_path):
    # simulate policy change between request and execution by mutating before resume
    conn, project, root, mate, task, run, ctx = _mk(tmp_path, tool_permissions=["email.send"])
    try:
        out = app_tools.execute_app_tool(ctx, "send_email", {"to": "a@b.com", "subject": "hi", "body": "body"}, data_dir=str(tmp_path), run_id=run.id)
        apr = ctx.pending_approvals[-1]
        store.decide_approval(conn, apr.id, Decision.APPROVED)
        # change policy concurrently: pause agent before execution
        store.update_teammate(conn, mate.id, paused=True)
        from nerdbot import approval_flow
        outcome = approval_flow.resume_run(conn, run.id, str(tmp_path))
        assert  [n for n in store.list_notifications(conn, project.id) if n.channel=='outbox'] == []
        assert outcome.outcome == "refused"
    finally:
        conn.close()
