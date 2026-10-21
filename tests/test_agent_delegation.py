"""Agent-driven delegation: decide, delegate, accept/reject, await, retry.

The delegation lifecycle under test:

- a delegation starts ``pending``; the delegatee must accept or decline it;
- only the delegatee (or the human owner) may decide;
- a delegation resolves from the delegatee's *actual* run result, never from
  the delegator's expectation;
- ``declined``, ``failed``, ``timed_out`` and ``cancelled`` are never
  reported to the delegator as success;
- a delegation can be retried, within a bounded number of attempts;
- a bot without ``task.delegate`` cannot delegate at all.
"""

from __future__ import annotations

import sqlite3
from datetime import UTC, datetime, timedelta

import pytest
from fastapi.testclient import TestClient

from nerdbot import app_tools, orchestrator, store
from nerdbot import delegation as delegation_mod
from nerdbot.agent_context import AgentContext
from nerdbot.api import create_app
from nerdbot.models import DelegationStatus, ProviderKind

TOKEN = "agent-delegation-token"
AUTH = {"Authorization": f"Bearer {TOKEN}"}


@pytest.fixture()
def app_client(tmp_path, monkeypatch):
    from cryptography.fernet import Fernet

    monkeypatch.setenv("NERDBOT_TOKEN", TOKEN)
    monkeypatch.setenv("NERDBOT_SECRET_KEY", Fernet.generate_key().decode("ascii"))
    monkeypatch.setenv("NERDBOT_DB", str(tmp_path / "delegation.db"))
    monkeypatch.setenv("NERDBOT_DATA", str(tmp_path / "data"))
    return TestClient(create_app())


def _ctx(conn: sqlite3.Connection, task_id: str, mate_id: str) -> AgentContext:
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


def _fleet(conn: sqlite3.Connection) -> tuple[str, str, str, str]:
    project = store.create_project(conn, owner="local-owner")
    ceo = store.create_teammate(
        conn, project.id, persona="ceo", permissions=["task.delegate"]
    )
    eng = store.create_teammate(
        conn, project.id, persona="engineer", permissions=["task.delegate"]
    )
    parent = store.create_task(conn, project.id, "objective", owner_teammate_id=ceo.id)
    return project.id, ceo.id, eng.id, parent.id


# -- permission ---------------------------------------------------------------


def test_a_bot_without_the_delegate_permission_cannot_delegate() -> None:
    conn = store.connect(":memory:")
    project = store.create_project(conn, owner="local-owner")
    ceo = store.create_teammate(conn, project.id, persona="ceo", permissions=[])
    eng = store.create_teammate(conn, project.id, persona="engineer", permissions=[])
    parent = store.create_task(conn, project.id, "objective", owner_teammate_id=ceo.id)
    out = app_tools.execute_app_tool(
        _ctx(conn, parent.id, ceo.id),
        "delegate_task",
        {"to_teammate_id": eng.id, "description": "do it"},
    )
    assert "permission denied" in out
    assert store.list_delegations_for_task(conn, parent.id) == []
    conn.close()


def test_the_delegate_tool_is_not_offered_without_the_permission() -> None:
    schemas = app_tools.app_tool_schemas(set())
    names = {s["function"]["name"] for s in schemas}
    assert "delegate_task" not in names
    assert "list_teammates" not in names
    assert "retry_delegation" not in names
    # Accepting work handed to you needs no permission — you are the delegatee.
    assert "respond_to_delegation" in names

    schemas = app_tools.app_tool_schemas({"task.delegate"})
    names = {s["function"]["name"] for s in schemas}
    assert {"delegate_task", "list_teammates", "retry_delegation"} <= names
    assert "create_task" not in names


# -- choosing a delegatee ----------------------------------------------------


def test_list_teammates_reports_eligibility_and_workload() -> None:
    conn = store.connect(":memory:")
    project = store.create_project(conn, owner="local-owner")
    ceo = store.create_teammate(
        conn, project.id, persona="ceo", permissions=["task.delegate"]
    )
    busy = store.create_teammate(
        conn, project.id, persona="busy", permissions=[], capabilities=["ops"]
    )
    idle = store.create_teammate(
        conn, project.id, persona="idle", permissions=[], capabilities=["code"]
    )
    # The busy bot already owns an open task.
    store.create_task(conn, project.id, "work", owner_teammate_id=busy.id)
    parent = store.create_task(conn, project.id, "objective", owner_teammate_id=ceo.id)

    out = app_tools.execute_app_tool(_ctx(conn, parent.id, ceo.id), "list_teammates", {})
    assert busy.id in out and idle.id in out
    assert "persona='idle'" in out
    assert "capabilities=['code']" in out
    # The busy bot is reported as not available, the idle one as available.
    busy_line = next(line for line in out.splitlines() if busy.id in line)
    idle_line = next(line for line in out.splitlines() if idle.id in line)
    assert "available=False" in busy_line
    assert "available=True" in idle_line
    conn.close()


def test_list_teammates_only_shows_the_projects_fleet() -> None:
    conn = store.connect(":memory:")
    mine = store.create_project(conn, owner="local-owner")
    theirs = store.create_project(conn, owner="local-owner")
    ceo = store.create_teammate(conn, mine.id, persona="ceo", permissions=["task.delegate"])
    stranger = store.create_teammate(conn, theirs.id, persona="stranger", permissions=[])
    parent = store.create_task(conn, mine.id, "objective", owner_teammate_id=ceo.id)
    out = app_tools.execute_app_tool(_ctx(conn, parent.id, ceo.id), "list_teammates", {})
    assert stranger.id not in out
    conn.close()


# -- delegation bounds --------------------------------------------------------


def test_a_delegation_carries_objective_scope_context_and_deadline() -> None:
    conn = store.connect(":memory:")
    _project_id, ceo_id, eng_id, parent_id = _fleet(conn)
    out = app_tools.execute_app_tool(
        _ctx(conn, parent_id, ceo_id),
        "delegate_task",
        {
            "to_teammate_id": eng_id,
            "description": "Implement the parser",
            "scope": "src/parser only",
            "context": "the grammar is in docs/grammar.md",
            "timeout_s": 120,
        },
    )
    assert "delegated" in out and "PENDING" in out
    delegation = store.list_delegations_for_task(conn, parent_id)[0]
    assert delegation.scope == "src/parser only"
    assert "docs/grammar.md" in delegation.reason
    assert delegation.deadline_at is not None
    delta = delegation.deadline_at - datetime.now(UTC)
    assert timedelta(seconds=100) < delta <= timedelta(seconds=120)
    child = store.get_task(conn, delegation.child_task_id)
    assert child is not None
    assert child.description == "Implement the parser"
    assert child.parent_task_id == parent_id
    conn.close()


def test_delegation_budget_is_bounded() -> None:
    conn = store.connect(":memory:")
    project = store.create_project(conn, owner="local-owner")
    ceo = store.create_teammate(
        conn, project.id, persona="ceo", permissions=["task.delegate"]
    )
    bots = [
        store.create_teammate(conn, project.id, persona=f"bot-{i}", permissions=[])
        for i in range(delegation_mod.MAX_DELEGATIONS_PER_TASK + 1)
    ]
    parent = store.create_task(conn, project.id, "objective", owner_teammate_id=ceo.id)
    ctx = _ctx(conn, parent.id, ceo.id)
    for bot in bots[: delegation_mod.MAX_DELEGATIONS_PER_TASK]:
        out = app_tools.execute_app_tool(
            ctx,
            "delegate_task",
            {"to_teammate_id": bot.id, "description": "again"},
        )
        assert "delegated" in out, out
    out = app_tools.execute_app_tool(
        ctx, "delegate_task", {"to_teammate_id": bots[-1].id, "description": "too many"}
    )
    assert "budget exhausted" in out
    conn.close()


def test_a_bot_cannot_be_handed_two_pending_delegations() -> None:
    conn = store.connect(":memory:")
    _project_id, ceo_id, eng_id, parent_id = _fleet(conn)
    ctx = _ctx(conn, parent_id, ceo_id)
    assert "delegated" in app_tools.execute_app_tool(
        ctx, "delegate_task", {"to_teammate_id": eng_id, "description": "one"}
    )
    out = app_tools.execute_app_tool(
        ctx, "delegate_task", {"to_teammate_id": eng_id, "description": "two"}
    )
    assert "already has a pending delegation" in out
    conn.close()


def test_delegation_to_a_bot_in_another_project_is_refused() -> None:
    conn = store.connect(":memory:")
    project = store.create_project(conn, owner="local-owner")
    other = store.create_project(conn, owner="local-owner")
    ceo = store.create_teammate(conn, project.id, persona="ceo", permissions=["task.delegate"])
    stranger = store.create_teammate(conn, other.id, persona="stranger", permissions=[])
    parent = store.create_task(conn, project.id, "objective", owner_teammate_id=ceo.id)
    out = app_tools.execute_app_tool(
        _ctx(conn, parent.id, ceo.id),
        "delegate_task",
        {"to_teammate_id": stranger.id, "description": "do it"},
    )
    assert "another project" in out
    conn.close()


# -- the delegatee's decision ------------------------------------------------


def test_declining_blocks_the_child_so_it_never_runs(tmp_path) -> None:
    conn = store.connect(":memory:")
    _project_id, ceo_id, eng_id, parent_id = _fleet(conn)
    provider = store.create_provider(conn, store.get_task(conn, parent_id).project_id, kind=ProviderKind.MOCK)
    store.update_teammate(conn, eng_id, provider_id=provider.id)
    app_tools.execute_app_tool(
        _ctx(conn, parent_id, ceo_id),
        "delegate_task",
        {"to_teammate_id": eng_id, "description": "sub", "command": "echo hi"},
    )
    child = store.list_child_tasks(conn, parent_id)[0]
    app_tools.execute_app_tool(
        _ctx(conn, child.id, eng_id),
        "respond_to_delegation",
        {"decision": "declined", "reason": "wrong specialty"},
    )
    child = store.get_task(conn, child.id)
    assert child is not None and child.status.value == "blocked"

    from nerdbot import executor

    summary = executor.sweep(conn, data_dir=str(tmp_path))
    assert [s for s in summary if s.get("phase") == "delegated"] == []
    conn.close()


def test_a_delegation_cannot_be_decided_twice() -> None:
    conn = store.connect(":memory:")
    _project_id, ceo_id, eng_id, parent_id = _fleet(conn)
    app_tools.execute_app_tool(
        _ctx(conn, parent_id, ceo_id),
        "delegate_task",
        {"to_teammate_id": eng_id, "description": "sub"},
    )
    child = store.list_child_tasks(conn, parent_id)[0]
    eng_ctx = _ctx(conn, child.id, eng_id)
    out = app_tools.execute_app_tool(eng_ctx, "respond_to_delegation", {"decision": "accepted"})
    assert "accepted" in out
    out = app_tools.execute_app_tool(eng_ctx, "respond_to_delegation", {"decision": "declined"})
    assert "already" in out
    delegation = store.list_delegations_for_task(conn, parent_id)[0]
    assert delegation.status == DelegationStatus.ACCEPTED
    conn.close()


def test_the_delegatee_sees_the_work_handed_to_it() -> None:
    """The context must tell the delegatee it has to decide."""
    from nerdbot import agent_context as agent_context_mod

    conn = store.connect(":memory:")
    _project_id, ceo_id, eng_id, parent_id = _fleet(conn)
    app_tools.execute_app_tool(
        _ctx(conn, parent_id, ceo_id),
        "delegate_task",
        {
            "to_teammate_id": eng_id,
            "description": "Implement the parser",
            "scope": "src/parser only",
        },
    )
    child = store.list_child_tasks(conn, parent_id)[0]
    ctx = agent_context_mod.build(conn, child, store.get_teammate(conn, eng_id))
    assert "Work handed to you" in ctx.system_message
    assert "respond_to_delegation" in ctx.system_message
    assert "src/parser only" in ctx.system_message
    assert "Implement the parser" in ctx.system_message
    assert len(ctx.inbound_delegations) == 1
    conn.close()


# -- timeouts -----------------------------------------------------------------


def test_a_delegation_that_passes_its_deadline_times_out() -> None:
    conn = store.connect(":memory:")
    _project_id, ceo_id, eng_id, parent_id = _fleet(conn)
    app_tools.execute_app_tool(
        _ctx(conn, parent_id, ceo_id),
        "delegate_task",
        {"to_teammate_id": eng_id, "description": "sub", "timeout_s": 60},
    )
    delegation = store.list_delegations_for_task(conn, parent_id)[0]
    # Move the deadline into the past.
    store.expire_delegation(conn, delegation.id, reason="deadline passed")
    refreshed = store.get_delegation(conn, delegation.id)
    assert refreshed is not None
    assert refreshed.status == DelegationStatus.TIMED_OUT
    child = store.get_task(conn, delegation.child_task_id)
    assert child is not None and child.status.value == "blocked"
    conn.close()


def test_check_delegations_reports_a_timeout_and_not_a_success() -> None:
    conn = store.connect(":memory:")
    _project_id, ceo_id, eng_id, parent_id = _fleet(conn)
    app_tools.execute_app_tool(
        _ctx(conn, parent_id, ceo_id),
        "delegate_task",
        {"to_teammate_id": eng_id, "description": "sub", "timeout_s": 1},
    )
    delegation = store.list_delegations_for_task(conn, parent_id)[0]
    # Force the deadline into the past.
    conn.execute(
        "UPDATE delegations SET deadline_at = ? WHERE id = ?",
        ((datetime.now(UTC) - timedelta(seconds=5)).isoformat(), delegation.id),
    )
    conn.commit()
    out = app_tools.execute_app_tool(_ctx(conn, parent_id, ceo_id), "check_delegations", {})
    assert "timed out" in out
    assert "completed" not in out
    conn.close()


# -- retry --------------------------------------------------------------------


def test_a_failed_delegation_can_be_retried() -> None:
    conn = store.connect(":memory:")
    _project_id, ceo_id, eng_id, parent_id = _fleet(conn)
    app_tools.execute_app_tool(
        _ctx(conn, parent_id, ceo_id),
        "delegate_task",
        {"to_teammate_id": eng_id, "description": "sub"},
    )
    delegation = store.list_delegations_for_task(conn, parent_id)[0]
    store.expire_delegation(conn, delegation.id, reason="deadline passed")

    out = app_tools.execute_app_tool(
        _ctx(conn, parent_id, ceo_id),
        "retry_delegation",
        {"delegation_id": delegation.id},
    )
    assert "retried" in out
    delegations = store.list_delegations_for_task(conn, parent_id)
    assert len(delegations) == 2
    retried = delegations[1]
    assert retried.status == DelegationStatus.PENDING
    assert retried.attempts == 2
    child = store.get_task(conn, retried.child_task_id)
    assert child is not None and child.description == "sub"
    conn.close()


def test_retry_is_bounded() -> None:
    conn = store.connect(":memory:")
    _project_id, ceo_id, eng_id, parent_id = _fleet(conn)
    ctx = _ctx(conn, parent_id, ceo_id)
    app_tools.execute_app_tool(
        ctx, "delegate_task", {"to_teammate_id": eng_id, "description": "sub"}
    )
    delegation = store.list_delegations_for_task(conn, parent_id)[-1]
    for _ in range(delegation_mod.MAX_DELEGATION_ATTEMPTS - 1):
        store.expire_delegation(conn, delegation.id, reason="deadline passed")
        out = app_tools.execute_app_tool(
            ctx, "retry_delegation", {"delegation_id": delegation.id}
        )
        assert "retried" in out, out
        delegation = store.list_delegations_for_task(conn, parent_id)[-1]
    store.expire_delegation(conn, delegation.id, reason="deadline passed")
    out = app_tools.execute_app_tool(
        ctx, "retry_delegation", {"delegation_id": delegation.id}
    )
    assert "retry limit" in out
    conn.close()


def test_only_the_delegator_may_retry() -> None:
    conn = store.connect(":memory:")
    project = store.create_project(conn, owner="local-owner")
    ceo = store.create_teammate(conn, project.id, persona="ceo", permissions=["task.delegate"])
    eng = store.create_teammate(conn, project.id, persona="engineer", permissions=["task.delegate"])
    other = store.create_teammate(conn, project.id, persona="other", permissions=["task.delegate"])
    parent = store.create_task(conn, project.id, "objective", owner_teammate_id=ceo.id)
    app_tools.execute_app_tool(
        _ctx(conn, parent.id, ceo.id),
        "delegate_task",
        {"to_teammate_id": eng.id, "description": "sub"},
    )
    delegation = store.list_delegations_for_task(conn, parent.id)[0]
    store.expire_delegation(conn, delegation.id, reason="deadline passed")
    # The service refuses a retry by anybody but the delegator.
    with pytest.raises(delegation_mod.DelegationError, match="only the delegator"):
        delegation_mod.retry(conn, delegation, actor=other)
    # And the tool refuses it too (the actor does not own the task at all).
    out = app_tools.execute_app_tool(
        _ctx(conn, parent.id, other.id),
        "retry_delegation",
        {"delegation_id": delegation.id},
    )
    assert "does not own task" in out or "only the delegator" in out
    conn.close()




# -- the API surface ----------------------------------------------------------


def test_the_owner_can_accept_or_decline_a_delegation(app_client: TestClient) -> None:
    r = app_client.post("/projects", json={"repository": "r"}, headers=AUTH)
    project_id = r.json()["id"]
    r = app_client.post(
        f"/projects/{project_id}/teammates",
        json={"persona": "ceo", "permissions": ["task.delegate"]},
        headers=AUTH,
    )
    ceo = r.json()["id"]
    r = app_client.post(
        f"/projects/{project_id}/teammates",
        json={"persona": "engineer", "permissions": ["task.delegate"]},
        headers=AUTH,
    )
    eng = r.json()["id"]
    r = app_client.post(
        f"/projects/{project_id}/tasks",
        json={"description": "objective", "owner_teammate_id": ceo},
        headers=AUTH,
    )
    task_id = r.json()["id"]
    r = app_client.post(
        f"/tasks/{task_id}/delegate",
        json={"from_teammate_id": ceo, "to_teammate_id": eng, "reason": "specialist"},
        headers=AUTH,
    )
    assert r.status_code == 200, r.text
    delegation_id = r.json()["id"]
    assert r.json()["status"] == "pending"

    r = app_client.post(
        f"/delegations/{delegation_id}/decide",
        json={"decision": "declined", "reason": "not available"},
        headers=AUTH,
    )
    assert r.status_code == 200, r.text
    assert r.json()["status"] == "declined"

    # A decided delegation cannot be re-decided.
    r = app_client.post(
        f"/delegations/{delegation_id}/decide",
        json={"decision": "accepted"},
        headers=AUTH,
    )
    assert r.status_code == 400, r.text


def test_the_api_exposes_the_delegation_lifecycle_fields(app_client: TestClient) -> None:
    r = app_client.post("/projects", json={"repository": "r"}, headers=AUTH)
    project_id = r.json()["id"]
    r = app_client.post(
        f"/projects/{project_id}/teammates",
        json={"persona": "ceo", "permissions": ["task.delegate"]},
        headers=AUTH,
    )
    ceo = r.json()["id"]
    r = app_client.post(
        f"/projects/{project_id}/teammates",
        json={"persona": "engineer", "permissions": ["task.delegate"]},
        headers=AUTH,
    )
    eng = r.json()["id"]
    r = app_client.post(
        f"/projects/{project_id}/tasks",
        json={"description": "objective", "owner_teammate_id": ceo},
        headers=AUTH,
    )
    task_id = r.json()["id"]
    r = app_client.post(
        f"/tasks/{task_id}/delegate",
        json={"from_teammate_id": ceo, "to_teammate_id": eng},
        headers=AUTH,
    )
    delegation_id = r.json()["id"]
    r = app_client.get(f"/tasks/{task_id}/delegations", headers=AUTH)
    body = r.json()["delegations"][0]
    for field in ("status", "scope", "attempts", "deadline_at", "child_task_id"):
        assert field in body, f"{field} missing from the delegation payload"
    assert body["attempts"] == 0
    conn = store.connect(app_client.app.state.db_path) if hasattr(app_client.app.state, "db_path") else None
    if conn is not None:
        conn.close()
    assert delegation_id


def test_orchestrator_does_not_overwrite_a_decline_that_happened_during_the_run(
    tmp_path,
) -> None:
    """A run that ends after the task was blocked must not report success.

    The delegatee's own model declines the delegation while its run is in
    flight; the run then finishes, and the outcome must stay "declined".
    """
    import json

    import httpx

    from nerdbot.providers import OpenAICompatibleAdapter

    conn = store.connect(":memory:")
    project = store.create_project(conn, owner="local-owner")
    ceo = store.create_teammate(conn, project.id, persona="ceo", permissions=["task.delegate"])
    eng = store.create_teammate(conn, project.id, persona="engineer", permissions=["task.delegate"])
    parent = store.create_task(conn, project.id, "objective", owner_teammate_id=ceo.id)
    app_tools.execute_app_tool(
        _ctx(conn, parent.id, ceo.id),
        "delegate_task",
        {"to_teammate_id": eng.id, "description": "sub", "command": "echo hi"},
    )
    child = store.list_child_tasks(conn, parent.id)[0]
    delegation = store.list_delegations_for_task(conn, parent.id)[0]

    def handler(request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content)
        already_called = any(
            message.get("role") == "tool" for message in body.get("messages", [])
        )
        if already_called:
            return httpx.Response(
                200,
                json={"choices": [{"message": {"role": "assistant", "content": "ok"}}]},
            )
        return httpx.Response(
            200,
            json={
                "choices": [
                    {
                        "message": {
                            "role": "assistant",
                            "content": "",
                            "tool_calls": [
                                {
                                    "id": "d1",
                                    "type": "function",
                                    "function": {
                                        "name": "respond_to_delegation",
                                        "arguments": json.dumps({"decision": "declined"}),
                                    },
                                }
                            ],
                        }
                    }
                ]
            },
        )

    adapter = OpenAICompatibleAdapter(
        {
            "base_url": "https://provider.example/v1",
            "model": "test-model",
            "api_key": "sk-test",
        },
        transport=httpx.MockTransport(handler),
    )
    run, _result, _artifact = orchestrator.schedule_run(
        conn, child.id, adapter=adapter, data_dir=str(tmp_path)
    )
    assert run.status.value != "succeeded"
    refreshed = store.get_task(conn, child.id)
    assert refreshed is not None and refreshed.status.value == "blocked"
    final = store.get_delegation(conn, delegation.id)
    assert final is not None and final.status == DelegationStatus.DECLINED
    conn.close()

