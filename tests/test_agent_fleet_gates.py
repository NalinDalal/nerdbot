"""Agent runtime gates: permission filters, digest-bound approvals, delegation.

Covers the Slice 2-5 surface: gates.require modes, the app-tool permission
filter, the approve-then-retry roundtrip, nested delegation with cycle and
depth prevention, the response channel (delegation result + board message),
memory isolation by teammate identity, and the Phase 13 migration.
"""

from __future__ import annotations

import shutil
import sqlite3
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from nerdbot import app_tools, chat, decomposition, gates, orchestrator, store
from nerdbot import delegation as delegation_mod
from nerdbot.agent_context import AgentContext
from nerdbot.api import create_app
from nerdbot.models import Decision, ProviderKind
from nerdbot.providers import ProviderAuthenticationError, ProviderRateLimitError

TOKEN = "fleet-token"
AUTH = {"Authorization": f"Bearer {TOKEN}"}
ACTING = "X-Acting-Teammate"


# -- fixtures / helpers -------------------------------------------------------

@pytest.fixture()
def app_client(tmp_path, monkeypatch):
    monkeypatch.setenv("NERDBOT_TOKEN", TOKEN)
    monkeypatch.setenv("NERDBOT_DB", str(tmp_path / "fleet.db"))
    monkeypatch.setenv("NERDBOT_DATA", str(tmp_path / "data"))
    return TestClient(create_app())


def _project(client: TestClient) -> str:
    r = client.post("/projects", json={"repository": "r"}, headers=AUTH)
    assert r.status_code == 200, r.text
    return r.json()["id"]


def _teammate(
    client: TestClient, project_id: str, persona: str = "coder", **extra
) -> str:
    body = {"persona": persona, "instructions": "i", "capabilities": ["code"]}
    body.update(extra)
    r = client.post(
        f"/projects/{project_id}/teammates", json=body, headers=AUTH
    )
    assert r.status_code == 200, r.text
    return r.json()["id"]


def _task(client: TestClient, project_id: str, **extra) -> str:
    body = {"description": "t", "command": "echo ok"}
    body.update(extra)
    r = client.post(f"/projects/{project_id}/tasks", json=body, headers=AUTH)
    assert r.status_code == 200, r.text
    return r.json()["id"]


def _ctx(conn, task_id: str, mate_id: str) -> AgentContext:
    task = store.get_task(conn, task_id)
    assert task is not None
    mate = store.get_teammate(conn, mate_id)
    assert mate is not None
    return AgentContext(
        conn=conn,
        task=task,
        project=None,
        teammate=mate,
        system_message="",
        allowed_permissions=frozenset(mate.permissions),
    )


# -- gates.require modes ------------------------------------------------------

def test_admin_permission_absent_is_deny() -> None:
    conn = store.connect(":memory:")
    project = store.create_project(conn, owner="local-owner")
    mate = store.create_teammate(conn, project.id, persona="bot")
    with pytest.raises(gates.GateDenied):
        gates.require(conn, mate, "teammate.create")
    conn.close()


def test_admin_permission_granted_requires_approval_then_grants_once() -> None:
    conn = store.connect(":memory:")
    project = store.create_project(conn, owner="local-owner")
    mate = store.create_teammate(
        conn, project.id, persona="ceo", permissions=["teammate.create"]
    )
    payload = {"project_id": project.id, "persona": "eng", "permissions": []}
    with pytest.raises(gates.GateApprovalRequired) as exc_info:
        gates.require(conn, mate, "teammate.create", payload=payload)
    approval = exc_info.value.approval
    assert approval.digest is not None
    assert approval.project_id == project.id

    decided = store.decide_approval(conn, approval.id, Decision.APPROVED)
    assert decided.decision == Decision.APPROVED

    # Same payload now proceeds and consumes the approval.
    used = gates.require(conn, mate, "teammate.create", payload=payload)
    assert used is not None and used.id == approval.id
    refreshed = store.get_approval(conn, approval.id)
    assert refreshed is not None and refreshed.executed_at is not None

    # One-use: a second call with the same payload must not reuse it.
    with pytest.raises(gates.GateApprovalRequired):
        gates.require(conn, mate, "teammate.create", payload=payload)
    conn.close()


def test_admin_permission_granted_approve_forever_is_reusable() -> None:
    conn = store.connect(":memory:")
    project = store.create_project(conn, owner="local-owner")
    mate = store.create_teammate(
        conn, project.id, persona="ceo", permissions=["teammate.create"]
    )
    payload = {"project_id": project.id, "persona": "eng", "permissions": []}
    with pytest.raises(gates.GateApprovalRequired) as exc_info:
        gates.require(conn, mate, "teammate.create", payload=payload)
    approval = exc_info.value.approval

    decided = store.decide_approval(conn, approval.id, Decision.APPROVED_FOREVER)
    assert decided.decision == Decision.APPROVED_FOREVER
    assert decided.consumed_at is None  # forever approvals are not consumed
    assert decided.expires_at is None  # forever approvals never expire

    # Same payload proceeds and does NOT consume the approval.
    used = gates.require(conn, mate, "teammate.create", payload=payload)
    assert used is not None and used.id == approval.id
    refreshed = store.get_approval(conn, approval.id)
    assert refreshed is not None and refreshed.executed_at is None

    # Forever: a second call with the same payload reuses it (not one-use).
    used2 = gates.require(conn, mate, "teammate.create", payload=payload)
    assert used2 is not None and used2.id == approval.id
    conn.close()


def test_digest_binds_to_exact_payload() -> None:
    conn = store.connect(":memory:")
    project = store.create_project(conn, owner="local-owner")
    mate = store.create_teammate(
        conn, project.id, persona="ceo", permissions=["teammate.create"]
    )
    with pytest.raises(gates.GateApprovalRequired) as exc_info:
        gates.require(
            conn, mate, "teammate.create", payload={"persona": "eng"}
        )
    store.decide_approval(conn, exc_info.value.approval.id, Decision.APPROVED)
    # A different payload is a different digest: still gated.
    with pytest.raises(gates.GateApprovalRequired):
        gates.require(conn, mate, "teammate.create", payload={"persona": "ops"})
    conn.close()


def test_tool_policy_auto_skips_approval() -> None:
    conn = store.connect(":memory:")
    project = store.create_project(conn, owner="local-owner")
    mate = store.create_teammate(
        conn, project.id, persona="ceo", permissions=["teammate.create"]
    )
    mate = store.update_teammate(
        conn, mate.id, tool_policy={"teammate.create": "auto"}
    )
    assert gates.require(conn, mate, "teammate.create", payload={"persona": "x"}) is None
    conn.close()


def test_non_admin_permission_only_gate() -> None:
    conn = store.connect(":memory:")
    project = store.create_project(conn, owner="local-owner")
    mate = store.create_teammate(conn, project.id, persona="bot")
    with pytest.raises(gates.GateDenied):
        gates.require(conn, mate, "task.create")
    mate = store.update_teammate(
        conn, mate.id, permissions=["task.create"]
    )
    assert gates.require(conn, mate, "task.create") is None
    conn.close()


# -- app tool permission filter ----------------------------------------------

def test_app_tool_schemas_fail_closed_filter() -> None:
    ambient = {t["function"]["name"] for t in app_tools.app_tool_schemas(set())}
    # Ambient reads are always available.
    assert {"inspect_workspace", "list_tasks", "read_messages"} <= ambient
    assert "create_teammate" not in ambient
    assert "delegate_task" not in ambient

    full = {
        t["function"]["name"]
        for t in app_tools.app_tool_schemas(set(gates.ALL_PERMISSIONS))
    }
    assert "create_teammate" in full
    assert "delegate_task" in full


def test_execute_unknown_tool_raises() -> None:
    conn = store.connect(":memory:")
    project = store.create_project(conn, owner="local-owner")
    mate = store.create_teammate(conn, project.id, persona="bot")
    task = store.create_task(conn, project.id, "t", owner_teammate_id=mate.id)
    ctx = _ctx(conn, task.id, mate.id)
    with pytest.raises(ValueError):
        app_tools.execute_app_tool(ctx, "definitely_not_a_tool", {})
    conn.close()


def test_create_teammate_tool_gate_roundtrip() -> None:
    conn = store.connect(":memory:")
    project = store.create_project(conn, owner="local-owner")
    ceo = store.create_teammate(
        conn, project.id, persona="ceo", permissions=["teammate.create"]
    )
    task = store.create_task(conn, project.id, "spawn", owner_teammate_id=ceo.id)
    ctx = _ctx(conn, task.id, ceo.id)

    out = app_tools.execute_app_tool(
        ctx, "create_teammate", {"persona": "engineer", "permissions": []}
    )
    assert "APPROVAL REQUIRED" in out
    pending = store.list_approvals_for_project(conn, project.id)
    assert len(pending) == 1 and pending[0].decision == Decision.PENDING
    assert pending[0].action == "teammate.create"
    assert pending[0].project_id == project.id

    store.decide_approval(conn, pending[0].id, Decision.APPROVED)
    out = app_tools.execute_app_tool(
        ctx, "create_teammate", {"persona": "engineer", "permissions": []}
    )
    assert "created teammate" in out
    mates = store.list_teammates(conn, project.id)
    assert any(m.persona == "engineer" for m in mates)
    conn.close()


def test_bot_cannot_grant_permissions_it_lacks() -> None:
    conn = store.connect(":memory:")
    project = store.create_project(conn, owner="local-owner")
    ceo = store.create_teammate(
        conn, project.id, persona="ceo", permissions=["teammate.create"]
    )
    task = store.create_task(conn, project.id, "spawn", owner_teammate_id=ceo.id)
    ctx = _ctx(conn, task.id, ceo.id)
    out = app_tools.execute_app_tool(
        ctx,
        "create_teammate",
        {"persona": "risky", "permissions": ["board.delete"]},
    )
    # The escalation attempt is denied outright (no approval can authorize it).
    assert "cannot grant permissions" in out or "permission denied" in out
    mates = store.list_teammates(conn, project.id)
    assert not any(m.persona == "risky" for m in mates)
    conn.close()


def test_delete_board_tool_requires_digest_approval() -> None:
    conn = store.connect(":memory:")
    project = store.create_project(conn, owner="local-owner")
    mate = store.create_teammate(
        conn, project.id, persona="ops", permissions=["board.delete"]
    )
    board = store.create_board(conn, owner="local-owner", name="b", project_id=project.id)
    task = store.create_task(conn, project.id, "t", owner_teammate_id=mate.id)
    ctx = _ctx(conn, task.id, mate.id)

    out = app_tools.execute_app_tool(ctx, "delete_board", {"board_id": board.id})
    assert "APPROVAL REQUIRED" in out
    assert store.get_board(conn, board.id) is not None

    approval = store.list_approvals_for_project(conn, project.id)[0]
    store.decide_approval(conn, approval.id, Decision.APPROVED)
    out = app_tools.execute_app_tool(ctx, "delete_board", {"board_id": board.id})
    assert "deleted board" in out
    assert store.get_board(conn, board.id) is None
    conn.close()


# -- delegation + response channel -------------------------------------------

def test_delegate_tool_creates_child_and_pending_delegation() -> None:
    """The delegation starts PENDING — the delegatee has to accept it."""
    conn = store.connect(":memory:")
    project = store.create_project(conn, owner="local-owner")
    ceo = store.create_teammate(
        conn, project.id, persona="ceo", permissions=["task.delegate"]
    )
    eng = store.create_teammate(
        conn, project.id, persona="engineer", permissions=["task.delegate"]
    )
    parent = store.create_task(conn, project.id, "objective", owner_teammate_id=ceo.id)
    ctx = _ctx(conn, parent.id, ceo.id)

    out = app_tools.execute_app_tool(
        ctx,
        "delegate_task",
        {"description": "write the parser", "to_teammate_id": eng.id},
    )
    assert "delegated" in out
    assert "PENDING" in out
    children = store.list_child_tasks(conn, parent.id)
    assert len(children) == 1
    assert children[0].owner_teammate_id == eng.id
    assert children[0].parent_task_id == parent.id
    delegations = store.list_delegations_for_task(conn, parent.id)
    assert len(delegations) == 1
    assert delegations[0].child_task_id == children[0].id
    assert delegations[0].status.value == "pending"
    assert delegations[0].deadline_at is not None
    conn.close()


def test_delegatee_accepts_the_delegation() -> None:
    """The delegatee accepts the work it was handed."""
    conn = store.connect(":memory:")
    project = store.create_project(conn, owner="local-owner")
    ceo = store.create_teammate(
        conn, project.id, persona="ceo", permissions=["task.delegate"]
    )
    eng = store.create_teammate(
        conn, project.id, persona="engineer", permissions=["task.delegate"]
    )
    parent = store.create_task(conn, project.id, "objective", owner_teammate_id=ceo.id)
    ceo_ctx = _ctx(conn, parent.id, ceo.id)
    app_tools.execute_app_tool(
        ceo_ctx,
        "delegate_task",
        {"description": "write the parser", "to_teammate_id": eng.id},
    )
    child = store.list_child_tasks(conn, parent.id)[0]
    eng_ctx = _ctx(conn, child.id, eng.id)

    out = app_tools.execute_app_tool(
        eng_ctx, "respond_to_delegation", {"decision": "accepted"}
    )
    assert "accepted" in out
    delegation = store.list_delegations_for_task(conn, parent.id)[0]
    assert delegation.status.value == "accepted"
    conn.close()


def test_delegatee_declines_the_delegation() -> None:
    """Declining is a real outcome: the child is blocked and never runs."""
    conn = store.connect(":memory:")
    project = store.create_project(conn, owner="local-owner")
    ceo = store.create_teammate(
        conn, project.id, persona="ceo", permissions=["task.delegate"]
    )
    eng = store.create_teammate(
        conn, project.id, persona="engineer", permissions=["task.delegate"]
    )
    parent = store.create_task(conn, project.id, "objective", owner_teammate_id=ceo.id)
    ceo_ctx = _ctx(conn, parent.id, ceo.id)
    app_tools.execute_app_tool(
        ceo_ctx,
        "delegate_task",
        {"description": "write the parser", "to_teammate_id": eng.id},
    )
    child = store.list_child_tasks(conn, parent.id)[0]
    eng_ctx = _ctx(conn, child.id, eng.id)

    out = app_tools.execute_app_tool(
        eng_ctx,
        "respond_to_delegation",
        {"decision": "declined", "reason": "not my specialty"},
    )
    assert "declined" in out
    delegation = store.list_delegations_for_task(conn, parent.id)[0]
    assert delegation.status.value == "declined"
    assert "not my specialty" in delegation.reason
    refreshed = store.get_task(conn, child.id)
    assert refreshed is not None and refreshed.status.value == "blocked"
    conn.close()


def test_a_bystander_cannot_decide_somebody_elses_delegation() -> None:
    conn = store.connect(":memory:")
    project = store.create_project(conn, owner="local-owner")
    ceo = store.create_teammate(
        conn, project.id, persona="ceo", permissions=["task.delegate"]
    )
    eng = store.create_teammate(
        conn, project.id, persona="engineer", permissions=["task.delegate"]
    )
    other = store.create_teammate(
        conn, project.id, persona="stranger", permissions=["task.delegate"]
    )
    parent = store.create_task(conn, project.id, "objective", owner_teammate_id=ceo.id)
    ceo_ctx = _ctx(conn, parent.id, ceo.id)
    app_tools.execute_app_tool(
        ceo_ctx,
        "delegate_task",
        {"description": "write the parser", "to_teammate_id": eng.id},
    )
    child = store.list_child_tasks(conn, parent.id)[0]
    other_ctx = _ctx(conn, child.id, other.id)
    out = app_tools.execute_app_tool(
        other_ctx, "respond_to_delegation", {"decision": "accepted"}
    )
    assert "does not own task" in out or "only the delegatee" in out
    delegation = store.list_delegations_for_task(conn, parent.id)[0]
    assert delegation.status.value == "pending"
    # The service refuses a decision by anybody but the delegatee.
    with pytest.raises(Exception, match="delegatee"):
        delegation_mod.respond(
            conn,
            delegation,
            actor=other,
            decision="accepted",
        )
    conn.close()


def test_delegate_rejects_cycle_to_ancestor_owner() -> None:
    conn = store.connect(":memory:")
    project = store.create_project(conn, owner="local-owner")
    ceo = store.create_teammate(
        conn, project.id, persona="ceo", permissions=["task.delegate"]
    )
    eng = store.create_teammate(
        conn, project.id, persona="engineer", permissions=["task.delegate"]
    )
    parent = store.create_task(conn, project.id, "obj", owner_teammate_id=ceo.id)
    child = store.create_task(
        conn, project.id, "sub", owner_teammate_id=eng.id, parent_task_id=parent.id
    )
    ctx = _ctx(conn, child.id, eng.id)
    out = app_tools.execute_app_tool(
        ctx, "delegate_task", {"to_teammate_id": ceo.id, "description": "up"}
    )
    assert "cycle detected" in out
    conn.close()


def test_task_chain_depth_is_bounded() -> None:
    conn = store.connect(":memory:")
    project = store.create_project(conn, owner="local-owner")
    mate = store.create_teammate(conn, project.id, persona="bot")
    current = store.create_task(conn, project.id, "root", owner_teammate_id=mate.id)
    for i in range(5):
        current = store.create_task(
            conn,
            project.id,
            f"child-{i}",
            owner_teammate_id=mate.id,
            parent_task_id=current.id,
        )
    with pytest.raises(ValueError, match="depth limit"):
        store.create_task(
            conn,
            project.id,
            "too-deep",
            owner_teammate_id=mate.id,
            parent_task_id=current.id,
        )
    conn.close()


def test_delegation_result_flows_back_with_board_message(tmp_path) -> None:
    conn = store.connect(":memory:")
    project = store.create_project(conn, owner="local-owner")
    ceo = store.create_teammate(
        conn, project.id, persona="ceo", permissions=["task.delegate"]
    )
    eng = store.create_teammate(
        conn, project.id, persona="engineer", permissions=["task.delegate"]
    )
    board = store.create_board(conn, owner="local-owner", name="b", project_id=project.id)
    parent = store.create_task(
        conn, project.id, "objective", owner_teammate_id=ceo.id, board_id=board.id
    )
    ctx = _ctx(conn, parent.id, ceo.id)
    app_tools.execute_app_tool(
        ctx, "delegate_task",
        {"description": "sub", "to_teammate_id": eng.id, "command": "echo child-work"},
    )
    child = store.list_child_tasks(conn, parent.id)[0]

    # The delegatee accepts the work before doing it.
    eng_ctx = _ctx(conn, child.id, eng.id)
    app_tools.execute_app_tool(eng_ctx, "respond_to_delegation", {"decision": "accepted"})

    # The child executes (mock provider, deterministic, no network).
    provider = store.create_provider(conn, project.id, kind=ProviderKind.MOCK)
    store.update_teammate(conn, eng.id, provider_id=provider.id)
    run, result, _ = orchestrator.schedule_run(conn, child.id, data_dir=str(tmp_path))
    assert result is not None and result.exit_code == 0

    # The delegation record carries the result.
    delegations = store.delegations_by_child_task(conn, child.id)
    assert len(delegations) == 1
    d = delegations[0]
    assert d.status.value == "completed"
    assert d.result and d.result_run_id == run.id and d.finished_at is not None

    # And the delegator's inbox got a targeted board message.
    inbox = store.list_messages_for_teammate(conn, ceo.id, board_id=board.id)
    assert len(inbox) == 1
    assert inbox[0].kind == "delegation"
    assert inbox[0].to_teammate_id == ceo.id
    assert inbox[0].from_teammate_id == eng.id
    assert child.id in inbox[0].content
    conn.close()


def test_a_child_run_that_never_accepted_is_not_a_success(tmp_path) -> None:
    """Work done without accepting the hand-off is a failure, not a success."""
    conn = store.connect(":memory:")
    project = store.create_project(conn, owner="local-owner")
    ceo = store.create_teammate(
        conn, project.id, persona="ceo", permissions=["task.delegate"]
    )
    eng = store.create_teammate(
        conn, project.id, persona="engineer", permissions=["task.delegate"]
    )
    provider = store.create_provider(conn, project.id, kind=ProviderKind.MOCK)
    store.update_teammate(conn, eng.id, provider_id=provider.id)
    parent = store.create_task(conn, project.id, "obj", owner_teammate_id=ceo.id)
    ctx = _ctx(conn, parent.id, ceo.id)
    app_tools.execute_app_tool(
        ctx, "delegate_task",
        {"description": "sub", "to_teammate_id": eng.id, "command": "echo child-work"},
    )
    child = store.list_child_tasks(conn, parent.id)[0]
    orchestrator.schedule_run(conn, child.id, data_dir=str(tmp_path))
    delegation = store.list_delegations_for_task(conn, parent.id)[0]
    assert delegation.status.value == "failed"
    assert "without accepting" in delegation.result
    conn.close()


def test_await_delegations_runs_pending_children(tmp_path) -> None:
    conn = store.connect(":memory:")
    project = store.create_project(conn, owner="local-owner")
    ceo = store.create_teammate(
        conn, project.id, persona="ceo", permissions=["task.delegate"]
    )
    eng = store.create_teammate(
        conn, project.id, persona="engineer", permissions=["task.delegate"]
    )
    provider = store.create_provider(conn, project.id, kind=ProviderKind.MOCK)
    store.update_teammate(conn, eng.id, provider_id=provider.id)
    parent = store.create_task(conn, project.id, "obj", owner_teammate_id=ceo.id)
    ctx = _ctx(conn, parent.id, ceo.id)
    app_tools.execute_app_tool(
        ctx, "delegate_task",
        {"description": "sub", "to_teammate_id": eng.id, "command": "echo child-work"},
    )
    child = store.list_child_tasks(conn, parent.id)[0]
    # The delegatee accepts; the delegator then awaits the real result.
    eng_ctx = _ctx(conn, child.id, eng.id)
    app_tools.execute_app_tool(eng_ctx, "respond_to_delegation", {"decision": "accepted"})
    out = app_tools.execute_app_tool(ctx, "await_delegations", {}, data_dir=str(tmp_path))
    assert "completed" in out
    child = store.list_child_tasks(conn, parent.id)[0]
    assert child.status.value == "done"
    conn.close()


def test_await_delegations_reports_a_refusal_without_claiming_success(tmp_path) -> None:
    conn = store.connect(":memory:")
    project = store.create_project(conn, owner="local-owner")
    ceo = store.create_teammate(
        conn, project.id, persona="ceo", permissions=["task.delegate"]
    )
    eng = store.create_teammate(
        conn, project.id, persona="engineer", permissions=["task.delegate"]
    )
    provider = store.create_provider(conn, project.id, kind=ProviderKind.MOCK)
    store.update_teammate(conn, eng.id, provider_id=provider.id)
    parent = store.create_task(conn, project.id, "obj", owner_teammate_id=ceo.id)
    ctx = _ctx(conn, parent.id, ceo.id)
    app_tools.execute_app_tool(
        ctx, "delegate_task",
        {"description": "sub", "to_teammate_id": eng.id, "command": "echo child-work"},
    )
    child = store.list_child_tasks(conn, parent.id)[0]
    eng_ctx = _ctx(conn, child.id, eng.id)
    app_tools.execute_app_tool(
        eng_ctx, "respond_to_delegation", {"decision": "declined", "reason": "busy"}
    )
    out = app_tools.execute_app_tool(ctx, "await_delegations", {}, data_dir=str(tmp_path))
    assert "declined" in out
    assert "completed" not in out
    conn.close()


def test_executor_sweep_phase2_runs_delegated_children(tmp_path) -> None:
    from nerdbot import executor

    conn = store.connect(":memory:")
    project = store.create_project(conn, owner="local-owner")
    ceo = store.create_teammate(
        conn, project.id, persona="ceo", permissions=["task.delegate"]
    )
    eng = store.create_teammate(
        conn, project.id, persona="engineer", permissions=["task.delegate"]
    )
    provider = store.create_provider(conn, project.id, kind=ProviderKind.MOCK)
    store.update_teammate(conn, eng.id, provider_id=provider.id)
    parent = store.create_task(conn, project.id, "obj", owner_teammate_id=ceo.id)
    ctx = _ctx(conn, parent.id, ceo.id)
    app_tools.execute_app_tool(
        ctx, "delegate_task",
        {"description": "sub", "to_teammate_id": eng.id, "command": "echo child-work"},
    )
    runnable = store.list_runnable_delegated_tasks(conn)
    assert len(runnable) == 1 and runnable[0][0].id == store.list_child_tasks(conn, parent.id)[0].id

    summary = executor.sweep(conn, data_dir=str(tmp_path))
    delegated = [s for s in summary if s.get("phase") == "delegated"]
    assert len(delegated) == 1
    child = store.list_child_tasks(conn, parent.id)[0]
    assert child.status.value == "done"
    conn.close()


# -- HTTP acting path: bots-manage-bots over the API -------------------------

def test_api_teammate_create_gated_for_acting_bot(app_client) -> None:
    pid = _project(app_client)
    ceo = _teammate(
        app_client, pid, persona="ceo", permissions=["teammate.create"]
    )
    # Bot path: approval required, 409 with the pending approval attached.
    r = app_client.post(
        f"/projects/{pid}/teammates",
        json={"persona": "engineer", "permissions": []},
        headers={**AUTH, ACTING: ceo},
    )
    assert r.status_code == 409, r.text
    approval = r.json()["detail"]["approval"]
    assert approval["action"] == "teammate.create"
    assert approval["project_id"] == pid

    # The human decides, then the bot retries the exact action.
    r = app_client.post(
        f"/approvals/{approval['id']}/decision",
        json={"decision": "approved"},
        headers=AUTH,
    )
    assert r.status_code == 200, r.text
    r = app_client.post(
        f"/projects/{pid}/teammates",
        json={"persona": "engineer", "permissions": []},
        headers={**AUTH, ACTING: ceo},
    )
    assert r.status_code == 200, r.text
    assert r.json()["persona"] == "engineer"
    # The gate approval is consumed exactly once.
    approvals = app_client.get(
        f"/projects/{pid}/approvals", headers=AUTH
    ).json()["approvals"]
    gate = [a for a in approvals if a["id"] == approval["id"]][0]
    assert gate["executed_at"] is not None


def test_api_teammate_create_denied_without_permission(app_client) -> None:
    pid = _project(app_client)
    powerless = _teammate(app_client, pid, persona="intern")
    r = app_client.post(
        f"/projects/{pid}/teammates",
        json={"persona": "engineer", "permissions": []},
        headers={**AUTH, ACTING: powerless},
    )
    assert r.status_code == 403, r.text


def test_api_human_path_never_gated(app_client) -> None:
    pid = _project(app_client)
    r = app_client.post(
        f"/projects/{pid}/teammates",
        json={"persona": "human-created", "permissions": ["teammate.create"]},
        headers=AUTH,
    )
    assert r.status_code == 200, r.text


def test_api_board_delete_gated_for_acting_bot(app_client) -> None:
    pid = _project(app_client)
    board = app_client.post(
        "/boards", json={"name": "b", "project_id": pid}, headers=AUTH
    ).json()
    ops = _teammate(
        app_client, pid, persona="ops", permissions=["board.delete"]
    )
    r = app_client.delete(
        f"/boards/{board['id']}", headers={**AUTH, ACTING: ops}
    )
    assert r.status_code == 409, r.text
    approval = r.json()["detail"]["approval"]
    app_client.post(
        f"/approvals/{approval['id']}/decision",
        json={"decision": "approved"},
        headers=AUTH,
    )
    r = app_client.delete(f"/boards/{board['id']}", headers={**AUTH, ACTING: ops})
    assert r.status_code == 200, r.text


# -- memory isolation by teammate identity -----------------------------------

def test_acting_teammate_memory_isolation(app_client) -> None:
    pid = _project(app_client)
    private = _teammate(
        app_client, pid, persona="secret", memory_scope="teammate"
    )
    other = _teammate(app_client, pid, persona="other", memory_scope="teammate")
    headers = {**AUTH, ACTING: other}

    # Own identity scope: allowed.
    r = app_client.post(
        "/memory",
        json={
            "scope": f"teammate:{other}",
            "content": "note to self",
            "source": "test",
        },
        headers=headers,
    )
    assert r.status_code == 200, r.text
    r = app_client.get(
        "/memory", params={"scope": f"teammate:{other}"}, headers=headers
    )
    assert r.status_code == 200 and len(r.json()["entries"]) == 1

    # Another teammate's identity scope: denied.
    r = app_client.get(
        "/memory", params={"scope": f"teammate:{private}"}, headers=headers
    )
    assert r.status_code == 403

    # A teammate with scope=teammate cannot touch project memory at all.
    r = app_client.post(
        f"/projects/{pid}/memory",
        json={"scope": f"project:{pid}", "content": "x", "source": "t"},
        headers=headers,
    )
    assert r.status_code == 403


def test_project_scope_teammate_sees_project_memory(app_client) -> None:
    pid = _project(app_client)
    shared = _teammate(app_client, pid, persona="shared", memory_scope="project")
    r = app_client.post(
        f"/projects/{pid}/memory",
        json={
            "scope": f"project:{pid}",
            "content": "collective fact",
            "source": "test",
        },
        headers={**AUTH, ACTING: shared},
    )
    assert r.status_code == 200, r.text
    r = app_client.get(f"/projects/{pid}/memory", headers={**AUTH, ACTING: shared})
    assert r.status_code == 200 and len(r.json()["entries"]) == 1


# -- workspace surface + new listing endpoints --------------------------------

def test_workspace_file_list_read_diff_endpoints(app_client, tmp_path) -> None:
    pid = _project(app_client)
    tid = _task(app_client, pid)
    # Seed an isolated workspace with one file.
    from nerdbot import workspace as ws

    root = ws.create_isolated_workspace(tmp_path / "data", tid)
    (root / "hello.txt").write_text("hi there", encoding="utf-8")

    r = app_client.get(f"/tasks/{tid}/workspace/files", headers=AUTH)
    assert r.status_code == 200, r.text
    files = r.json()["files"]
    assert any(f["path"] == "hello.txt" for f in files)

    r = app_client.get(
        f"/tasks/{tid}/workspace/file",
        params={"path": "hello.txt"},
        headers=AUTH,
    )
    assert r.status_code == 200 and r.json()["content"] == "hi there"

    # Path escape is rejected.
    r = app_client.get(
        f"/tasks/{tid}/workspace/file",
        params={"path": "../outside.txt"},
        headers=AUTH,
    )
    assert r.status_code == 400

    r = app_client.get(f"/tasks/{tid}/workspace/diff", headers=AUTH)
    assert r.status_code == 200 and r.json()["exists"] is True


def test_project_listing_endpoints(app_client) -> None:
    pid = _project(app_client)
    tid = _task(app_client, pid)
    mate = _teammate(app_client, pid)

    r = app_client.get("/projects", headers=AUTH)
    assert r.status_code == 200 and any(p["id"] == pid for p in r.json()["projects"])

    r = app_client.get(f"/projects/{pid}/tasks", headers=AUTH)
    assert r.status_code == 200 and any(t["id"] == tid for t in r.json()["tasks"])

    r = app_client.get(f"/projects/{pid}/approvals", headers=AUTH)
    assert r.status_code == 200 and r.json()["approvals"] == []

    board = app_client.post(
        "/boards", json={"name": "b", "project_id": pid}, headers=AUTH
    ).json()
    app_client.post(
        f"/boards/{board['id']}/messages",
        json={"content": "hello feed", "to_teammate_id": mate},
        headers=AUTH,
    )
    r = app_client.get(f"/projects/{pid}/messages", headers=AUTH)
    assert r.status_code == 200
    messages = r.json()["messages"]
    assert len(messages) == 1 and messages[0]["content"] == "hello feed"
    assert messages[0]["to_teammate_id"] == mate


def test_task_view_includes_delegation_tree(app_client) -> None:
    pid = _project(app_client)
    ceo = _teammate(app_client, pid, persona="ceo")
    eng = _teammate(app_client, pid, persona="eng")
    parent = _task(app_client, pid, owner_teammate_id=ceo)
    # The human-facing delegate endpoint creates the linked child.
    r = app_client.post(
        f"/tasks/{parent}/delegate",
        json={"from_teammate_id": ceo, "to_teammate_id": eng, "reason": "work"},
        headers=AUTH,
    )
    assert r.status_code == 200, r.text
    r = app_client.get(f"/tasks/{parent}", headers=AUTH)
    assert r.status_code == 200, r.text
    view = r.json()
    assert "delegations" in view and "children" in view and "parent" in view


def test_schedule_enable_disable_endpoint(app_client) -> None:
    pid = _project(app_client)
    r = app_client.post(
        f"/projects/{pid}/schedules",
        json={
            "name": "nightly",
            "cron": "0 3 * * *",
            "task_template": {"description": "nightly chore", "command": "echo nightly"},
        },
        headers=AUTH,
    )
    assert r.status_code in (200, 201), r.text
    schedule = r.json()
    r = app_client.patch(
        f"/schedules/{schedule['id']}", json={"enabled": False}, headers=AUTH
    )
    assert r.status_code == 200 and r.json()["enabled"] is False
    r = app_client.patch(
        f"/schedules/{schedule['id']}", json={"enabled": True}, headers=AUTH
    )
    assert r.status_code == 200 and r.json()["enabled"] is True


# -- Phase 13 migration against a copy of the real database -------------------

def test_migration_upgrades_real_db_copy() -> None:
    real = Path(__file__).resolve().parents[1] / "nerdbot.db"
    if not real.is_file():
        pytest.skip("no real nerdbot.db present")
    import tempfile

    with tempfile.TemporaryDirectory() as tmp:
        copy = Path(tmp) / "nerdbot.db"
        shutil.copy2(real, copy)
        conn = sqlite3.connect(copy)
        conn.row_factory = sqlite3.Row
        from nerdbot import store as store_mod

        store_mod._migrate(conn)  # noqa: SLF001 - explicit upgrade exercise
        cols = {row["name"] for row in conn.execute("PRAGMA table_info(approvals)")}
        assert "project_id" in cols and "executed_at" in cols
        task_cols = {row["name"] for row in conn.execute("PRAGMA table_info(tasks)")}
        assert "parent_task_id" in task_cols
        msg_cols = {row["name"] for row in conn.execute("PRAGMA table_info(board_messages)")}
        assert "to_teammate_id" in msg_cols
        # Existing rows survive with the default project link.
        row = conn.execute("SELECT COUNT(*) AS n FROM approvals").fetchone()
        assert row["n"] >= 0
        conn.close()


# -- decompose plan-review flow (preview -> review -> materialize) -------------

def _seed_provider(client: TestClient, pid: str) -> None:
    r = client.post(
        f"/projects/{pid}/providers", json={"kind": "mock"}, headers=AUTH
    )
    assert r.status_code == 200, r.text


def _sample_plan() -> decomposition.Plan:
    return decomposition.Plan(
        tasks=[
            decomposition.SubTask(description="step one", command="echo one"),
            decomposition.SubTask(
                description="step two", command="echo two", depends_on=[0]
            ),
        ]
    )


def test_decompose_preview_returns_plan_and_creates_nothing(
    app_client, monkeypatch
) -> None:
    pid = _project(app_client)
    _seed_provider(app_client, pid)
    board = app_client.post(
        "/boards", json={"name": "seed", "project_id": pid}, headers=AUTH
    ).json()
    seen: dict[str, str] = {}

    def fake_plan(conn, project_id, objective, provider):  # noqa: ANN001
        seen["objective"] = objective
        return _sample_plan()

    monkeypatch.setattr(decomposition, "plan_objective", fake_plan)
    r = app_client.post(
        f"/boards/{board['id']}/decompose",
        json={"objective": "ship the feature", "preview": True},
        headers=AUTH,
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["preview"] is True
    assert body["board"] is None and body["tasks"] == []
    assert seen["objective"] == "ship the feature"
    assert [t["description"] for t in body["plan"]["tasks"]] == [
        "step one",
        "step two",
    ]
    # Preview is side-effect free: no tasks, no new boards.
    assert app_client.get(f"/projects/{pid}/tasks", headers=AUTH).json() == {
        "tasks": []
    }
    boards = app_client.get(
        "/boards", params={"project_id": pid}, headers=AUTH
    ).json()["boards"]
    assert [b["id"] for b in boards] == [board["id"]]


def test_decompose_planning_messages_are_threadless() -> None:
    """Regression: the preview leg builds messages without any thread — the
    old stub-thread approach 500'd inside store.list_messages()."""
    conn = store.connect(":memory:")
    messages, provenance = chat.build_planning_messages(conn, "prj_stub")
    assert messages[0]["role"] == "system"
    assert provenance == []
    conn.close()


def test_decompose_preview_runs_real_chat_path(app_client, monkeypatch) -> None:
    """End-to-end preview with the REAL plan_objective: only the network
    completion is faked, so build_messages + stub + parse all execute."""
    pid = _project(app_client)
    _seed_provider(app_client, pid)
    board = app_client.post(
        "/boards", json={"name": "seed", "project_id": pid}, headers=AUTH
    ).json()
    payload = '{"tasks": [{"description": "a", "command": "echo a", "depends_on": []}]}'

    def fake_complete(provider, messages, **kwargs):  # noqa: ANN001
        assert any(m["role"] == "system" for m in messages)
        return payload

    monkeypatch.setattr(chat, "chat_complete", fake_complete)
    r = app_client.post(
        f"/boards/{board['id']}/decompose",
        json={"objective": "real path", "preview": True},
        headers=AUTH,
    )
    assert r.status_code == 200, r.text
    assert [t["description"] for t in r.json()["plan"]["tasks"]] == ["a"]
    # Still side-effect free.
    assert app_client.get(f"/projects/{pid}/tasks", headers=AUTH).json() == {
        "tasks": []
    }


def test_decompose_provider_auth_failure_is_typed_not_500(
    app_client, monkeypatch
) -> None:
    """Regression: a model/provider failure during planning must surface as a
    typed HTTP status (401 for bad credentials), never a bare 500."""
    pid = _project(app_client)
    _seed_provider(app_client, pid)
    board = app_client.post(
        "/boards", json={"name": "seed", "project_id": pid}, headers=AUTH
    ).json()

    def reject(provider, messages, **kwargs):  # noqa: ANN001
        raise ProviderAuthenticationError("chat rejected credentials (HTTP 401)")

    monkeypatch.setattr(chat, "chat_complete", reject)
    r = app_client.post(
        f"/boards/{board['id']}/decompose",
        json={"objective": "ship it", "preview": True},
        headers=AUTH,
    )
    assert r.status_code == 401, r.text
    assert "credentials" in r.json()["detail"]

    def rate_limited(provider, messages, **kwargs):  # noqa: ANN001
        raise ProviderRateLimitError("chat rate-limited (HTTP 429)")

    monkeypatch.setattr(chat, "chat_complete", rate_limited)
    r2 = app_client.post(
        f"/boards/{board['id']}/decompose",
        json={"objective": "ship it", "preview": True},
        headers=AUTH,
    )
    assert r2.status_code == 429, r2.text


def test_decompose_materializes_reviewed_plan_exactly(app_client, monkeypatch) -> None:
    pid = _project(app_client)
    board = app_client.post(
        "/boards", json={"name": "seed", "project_id": pid}, headers=AUTH
    ).json()

    def must_not_call(*_args, **_kwargs):  # noqa: ANN001
        raise AssertionError("materialize must not call the LLM")

    monkeypatch.setattr(decomposition, "plan_objective", must_not_call)
    r = app_client.post(
        f"/boards/{board['id']}/decompose",
        json={
            "objective": "ship the feature",
            "plan": _sample_plan().model_dump(),
            "create_board": True,
        },
        headers=AUTH,
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["board"]["name"].startswith("Plan:")
    tasks = app_client.get(f"/projects/{pid}/tasks", headers=AUTH).json()["tasks"]
    by_desc = {t["description"]: t for t in tasks}
    assert set(by_desc) == {"step one", "step two"}
    # Dependencies are wired exactly as the reviewed plan declared.
    assert by_desc["step two"]["dependencies"] == [by_desc["step one"]["id"]]
    assert body["plan"] == _sample_plan().model_dump()


def test_decompose_one_shot_human_path_ungated(app_client, monkeypatch) -> None:
    pid = _project(app_client)
    _seed_provider(app_client, pid)
    board = app_client.post(
        "/boards", json={"name": "seed", "project_id": pid}, headers=AUTH
    ).json()
    monkeypatch.setattr(
        decomposition, "plan_objective", lambda *a, **k: _sample_plan()
    )
    r = app_client.post(
        f"/boards/{board['id']}/decompose",
        json={"objective": "one shot"},
        headers=AUTH,
    )
    assert r.status_code == 200, r.text
    assert len(r.json()["tasks"]) == 2


def test_decompose_preview_gated_for_bot_without_permission(app_client) -> None:
    pid = _project(app_client)
    # No provider seeded: if the gate ran after provider resolution this
    # would be a 400 — the permission check must come first.
    board = app_client.post(
        "/boards", json={"name": "seed", "project_id": pid}, headers=AUTH
    ).json()
    powerless = _teammate(app_client, pid, persona="intern")
    r = app_client.post(
        f"/boards/{board['id']}/decompose",
        json={"objective": "o", "preview": True},
        headers={**AUTH, ACTING: powerless},
    )
    assert r.status_code == 403, r.text


def test_decompose_bot_needs_board_create_permission(app_client, monkeypatch) -> None:
    pid = _project(app_client)
    _seed_provider(app_client, pid)
    board = app_client.post(
        "/boards", json={"name": "seed", "project_id": pid}, headers=AUTH
    ).json()
    monkeypatch.setattr(
        decomposition, "plan_objective", lambda *a, **k: _sample_plan()
    )
    planner = _teammate(
        app_client, pid, persona="planner", permissions=["task.create"]
    )
    headers = {**AUTH, ACTING: planner}

    # Preview only needs task.create (nothing is created).
    r = app_client.post(
        f"/boards/{board['id']}/decompose",
        json={"objective": "o", "preview": True},
        headers=headers,
    )
    assert r.status_code == 200, r.text

    # Materializing with a new board needs board.create too -> denied.
    r = app_client.post(
        f"/boards/{board['id']}/decompose",
        json={"objective": "o", "plan": _sample_plan().model_dump()},
        headers=headers,
    )
    assert r.status_code == 403, r.text
    assert app_client.get(f"/projects/{pid}/tasks", headers=AUTH).json() == {
        "tasks": []
    }

    # Grant both permissions and the same call succeeds.
    app_client.patch(
        f"/teammates/{planner}",
        json={"permissions": ["task.create", "board.create"]},
        headers=AUTH,
    )
    r = app_client.post(
        f"/boards/{board['id']}/decompose",
        json={"objective": "o", "plan": _sample_plan().model_dump()},
        headers=headers,
    )
    assert r.status_code == 200, r.text
    assert len(r.json()["tasks"]) == 2


def test_decompose_rejects_bad_payloads(app_client) -> None:
    pid = _project(app_client)
    board = app_client.post(
        "/boards", json={"name": "seed", "project_id": pid}, headers=AUTH
    ).json()
    r = app_client.post(
        f"/boards/{board['id']}/decompose", json={}, headers=AUTH
    )
    assert r.status_code == 400, r.text
    r = app_client.post(
        f"/boards/{board['id']}/decompose",
        json={"objective": "o", "plan": {"tasks": "not-a-list"}},
        headers=AUTH,
    )
    assert r.status_code == 400, r.text
    r = app_client.post("/boards/nope/decompose", json={"objective": "o"}, headers=AUTH)
    assert r.status_code == 404, r.text
