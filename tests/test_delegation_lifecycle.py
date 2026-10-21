"""Delegation lifecycle: cancellation, failure propagation, retry limits.

``DelegationStatus.CANCELLED`` existed in the model with no code path able to
reach it, and a task could be retried forever. These tests pin the lifecycle
down: a delegation can be cancelled by the delegator or the delegatee (never
by a bystander), a cancelled child is never picked up by the executor, a late
result cannot overwrite a cancellation, and retries are bounded.
"""

from __future__ import annotations

import os

import pytest
from fastapi.testclient import TestClient

from nerdbot import app_tools, executor, orchestrator, store
from nerdbot.agent_context import AgentContext
from nerdbot.api import create_app
from nerdbot.models import DelegationStatus, ProviderKind, TaskStatus

TOKEN = "cancel-token"
AUTH = {"Authorization": f"Bearer {TOKEN}"}
ACTING = "X-Acting-Teammate"


@pytest.fixture()
def app_client(tmp_path, monkeypatch):
    monkeypatch.setenv("NERDBOT_TOKEN", TOKEN)
    monkeypatch.setenv("NERDBOT_DB", str(tmp_path / "cancel.db"))
    monkeypatch.setenv("NERDBOT_DATA", str(tmp_path / "data"))
    return TestClient(create_app())


def _project(client: TestClient) -> str:
    r = client.post("/projects", json={"repository": "r"}, headers=AUTH)
    assert r.status_code == 200, r.text
    return r.json()["id"]


def _teammate(
    client: TestClient, project_id: str, persona: str = "bot", **extra
) -> str:
    body = {"persona": persona, "instructions": "i", "capabilities": ["code"]}
    body.update(extra)
    r = client.post(
        f"/projects/{project_id}/teammates", json=body, headers=AUTH
    )
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


def _fleet(conn):
    project = store.create_project(conn, owner="local-owner")
    ceo = store.create_teammate(
        conn, project.id, persona="ceo", permissions=["task.delegate"]
    )
    eng = store.create_teammate(
        conn, project.id, persona="engineer", permissions=["task.delegate"]
    )
    parent = store.create_task(
        conn, project.id, "objective", owner_teammate_id=ceo.id
    )
    return project, ceo, eng, parent


# -- cancellation --------------------------------------------------------------


def test_cancel_delegation_by_the_delegator() -> None:
    conn = store.connect(":memory:")
    _project, ceo, eng, parent = _fleet(conn)
    ctx = _ctx(conn, parent.id, ceo.id)
    app_tools.execute_app_tool(
        ctx, "delegate_task", {"to_teammate_id": eng.id, "description": "sub"}
    )
    delegation = store.list_delegations_for_task(conn, parent.id)[0]
    child = store.get_task(conn, delegation.child_task_id)
    assert child is not None and child.status == TaskStatus.PENDING

    out = app_tools.execute_app_tool(
        ctx, "cancel_delegation", {"delegation_id": delegation.id}
    )
    assert "cancelled delegation" in out, out
    refreshed = store.get_delegation(conn, delegation.id)
    assert refreshed is not None
    assert refreshed.status == DelegationStatus.CANCELLED
    # The child is blocked, so the executor will not pick it up.
    child = store.get_task(conn, delegation.child_task_id)
    assert child is not None and child.status == TaskStatus.BLOCKED
    assert store.list_runnable_delegated_tasks(conn) == []
    conn.close()


def test_cancel_delegation_by_the_delegatee() -> None:
    """The delegatee withdraws from its own task (the delegation that made
    it), without needing the delegator's context."""
    conn = store.connect(":memory:")
    _project, ceo, eng, parent = _fleet(conn)
    app_tools.execute_app_tool(
        _ctx(conn, parent.id, ceo.id),
        "delegate_task",
        {"to_teammate_id": eng.id, "description": "sub"},
    )
    delegation = store.list_delegations_for_task(conn, parent.id)[0]
    child = store.get_task(conn, delegation.child_task_id)
    assert child is not None
    out = app_tools.execute_app_tool(
        _ctx(conn, child.id, eng.id), "cancel_delegation", {}
    )
    assert "cancelled delegation" in out, out
    refreshed = store.get_delegation(conn, delegation.id)
    assert refreshed is not None
    assert refreshed.status == DelegationStatus.CANCELLED
    conn.close()


def test_bystander_cannot_cancel_a_delegation() -> None:
    conn = store.connect(":memory:")
    project, ceo, eng, parent = _fleet(conn)
    stranger = store.create_teammate(
        conn, project.id, persona="stranger", permissions=["task.delegate"]
    )
    app_tools.execute_app_tool(
        _ctx(conn, parent.id, ceo.id),
        "delegate_task",
        {"to_teammate_id": eng.id, "description": "sub"},
    )
    delegation = store.list_delegations_for_task(conn, parent.id)[0]

    # At the store level: a teammate that is neither delegator nor delegatee
    # is refused, and the delegation is untouched.
    with pytest.raises(ValueError, match="only the delegator or the delegatee"):
        store.cancel_delegation(
            conn, delegation.id, actor_teammate_id=stranger.id
        )
    refreshed = store.get_delegation(conn, delegation.id)
    assert refreshed is not None
    assert refreshed.status == DelegationStatus.PENDING
    conn.close()


def test_cancelled_delegation_is_not_overwritten_by_a_late_result() -> None:
    conn = store.connect(":memory:")
    _project, ceo, eng, parent = _fleet(conn)
    app_tools.execute_app_tool(
        _ctx(conn, parent.id, ceo.id),
        "delegate_task",
        {"to_teammate_id": eng.id, "description": "sub"},
    )
    delegation = store.list_delegations_for_task(conn, parent.id)[0]
    store.cancel_delegation(conn, delegation.id, actor_teammate_id=ceo.id)
    store.finalize_delegation_result(conn, delegation.id, "late result")
    refreshed = store.get_delegation(conn, delegation.id)
    assert refreshed is not None
    assert refreshed.status == DelegationStatus.CANCELLED
    assert refreshed.result == ""
    conn.close()


def test_cancelled_child_is_never_executed(tmp_path) -> None:
    conn = store.connect(":memory:")
    project, ceo, eng, parent = _fleet(conn)
    provider = store.create_provider(conn, project.id, kind=ProviderKind.MOCK)
    store.update_teammate(conn, eng.id, provider_id=provider.id)
    app_tools.execute_app_tool(
        _ctx(conn, parent.id, ceo.id),
        "delegate_task",
        {"to_teammate_id": eng.id, "description": "sub", "command": "echo child"},
    )
    delegation = store.list_delegations_for_task(conn, parent.id)[0]
    store.cancel_delegation(conn, delegation.id, actor_teammate_id=ceo.id)

    summary = executor.sweep(conn, data_dir=str(tmp_path))
    delegated = [s for s in summary if s.get("phase") == "delegated"]
    assert delegated == []
    child = store.get_task(conn, delegation.child_task_id)
    assert child is not None and child.status == TaskStatus.BLOCKED
    conn.close()


def test_api_cancel_delegation_and_task(app_client) -> None:
    pid = _project(app_client)
    ceo = _teammate(app_client, pid, persona="ceo", permissions=["task.delegate"])
    eng = _teammate(app_client, pid, persona="engineer", permissions=["task.delegate"])
    parent = app_client.post(
        f"/projects/{pid}/tasks",
        json={"description": "obj", "command": "echo", "owner_teammate_id": ceo},
        headers=AUTH,
    ).json()
    delegation = app_client.post(
        f"/tasks/{parent['id']}/delegate",
        json={"from_teammate_id": ceo, "to_teammate_id": eng, "reason": "work"},
        headers=AUTH,
    ).json()

    # A bystander bot may not cancel somebody else's delegation.
    stranger = _teammate(app_client, pid, persona="stranger")
    r = app_client.post(
        f"/delegations/{delegation['id']}/cancel",
        json={},
        headers={**AUTH, ACTING: stranger},
    )
    assert r.status_code == 400, r.text

    # The delegator may.
    r = app_client.post(
        f"/delegations/{delegation['id']}/cancel",
        json={"reason": "no longer needed"},
        headers={**AUTH, ACTING: ceo},
    )
    assert r.status_code == 200, r.text
    assert r.json()["status"] == "cancelled"

    # The owner can cancel a task outright.
    r = app_client.post(f"/tasks/{parent['id']}/cancel", json={}, headers=AUTH)
    assert r.status_code == 200, r.text
    assert r.json()["status"] == "blocked"


def test_api_cancel_task_rejects_a_non_owner_bot(app_client) -> None:
    pid = _project(app_client)
    ceo = _teammate(app_client, pid, persona="ceo")
    other = _teammate(app_client, pid, persona="other")
    task = app_client.post(
        f"/projects/{pid}/tasks",
        json={"description": "t", "command": "echo", "owner_teammate_id": ceo},
        headers=AUTH,
    ).json()
    r = app_client.post(
        f"/tasks/{task['id']}/cancel", json={}, headers={**AUTH, ACTING: other}
    )
    assert r.status_code == 403, r.text


# -- retry limits --------------------------------------------------------------


def test_task_retry_is_bounded(tmp_path) -> None:
    conn = store.connect(":memory:")
    project = store.create_project(conn, owner="local-owner")
    mate = store.create_teammate(conn, project.id, persona="bot")
    task = store.create_task(
        conn, project.id, "t", owner_teammate_id=mate.id, command="echo ok"
    )
    run, result, _ = orchestrator.schedule_run(conn, task.id, data_dir=str(tmp_path))
    assert result is not None and result.exit_code == 0
    retries = 0
    while True:
        try:
            orchestrator.retry_task(conn, task.id, data_dir=str(tmp_path))
        except ValueError as exc:
            assert "retry limit" in str(exc)
            break
        retries += 1
        assert retries <= store.MAX_TASK_RETRIES
    assert len(store.list_runs_for_task(conn, task.id)) == store.MAX_TASK_RETRIES
    conn.close()


def test_api_retry_beyond_the_limit_is_rejected(app_client) -> None:
    pid = _project(app_client)
    task = app_client.post(
        f"/projects/{pid}/tasks",
        json={"description": "t", "command": "echo ok"},
        headers=AUTH,
    ).json()
    # One real run so the task reaches a terminal state.
    r = app_client.post(f"/tasks/{task['id']}/runs", json={}, headers=AUTH)
    assert r.status_code == 200, r.text
    # Exhaust the budget through the API-visible store.
    conn = store.connect(os.environ["NERDBOT_DB"])
    for _ in range(store.MAX_TASK_RETRIES + 1):
        try:
            orchestrator.retry_task(
                conn, task["id"], data_dir=os.environ["NERDBOT_DATA"]
            )
        except ValueError:
            break
    conn.close()

    r = app_client.post(f"/tasks/{task['id']}/retry", json={}, headers=AUTH)
    assert r.status_code == 400, r.text
    assert "retry limit" in r.text
