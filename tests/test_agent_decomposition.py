"""Agent-driven decomposition: propose a plan, apply it, hand its work off.

The decomposition tool pair rides on the same authorized tool architecture as
every other app tool:

- ``propose_plan``: the planner model drafts the plan; the server validates
  it (bounds, backwards-only dependencies, known owners) and returns it to
  the model *without creating anything*;
- ``apply_plan``: the model decides the plan; the server re-validates every
  rule against live state and creates tasks through the existing services.
  An invalid plan is rejected whole — never partially executed;
- creating a dedicated plan board also needs ``board.create`` — omission
  hangs the plan's tasks on the current task's board instead;
- steps assigned to other bots additionally need ``task.assign``: getting
  work for free into another bot's queue is not free.

The model decides the plan; the application validates and executes it.
"""

from __future__ import annotations

import json
import sqlite3
from typing import Any

import httpx
import pytest
from fastapi.testclient import TestClient

from nerdbot import app_tools, decomposition, executor, orchestrator, providers, store
from nerdbot.agent_context import AgentContext
from nerdbot.api import create_app
from nerdbot.decomposition import Plan, SubTask
from nerdbot.models import ProviderKind

TOKEN = "agent-decomp-token"
AUTH = {"Authorization": f"Bearer {TOKEN}"}
ACTING = "X-Acting-Teammate"


# -- shared fixtures -----------------------------------------------------------


@pytest.fixture()
def app_client(tmp_path, monkeypatch):
    from cryptography.fernet import Fernet

    monkeypatch.setenv("NERDBOT_TOKEN", TOKEN)
    monkeypatch.setenv("NERDBOT_SECRET_KEY", Fernet.generate_key().decode("ascii"))
    monkeypatch.setenv("NERDBOT_DB", str(tmp_path / "decomp.db"))
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


def _plan(**overrides: Any) -> Plan:
    tasks = [
        SubTask(description="write the parser", command="echo parser", depends_on=[]),
        SubTask(description="test the parser", command="echo test", depends_on=[0]),
    ]
    return Plan(tasks=overrides.get("tasks", tasks))


def _project(conn: sqlite3.Connection) -> str:
    return store.create_project(conn, owner="local-owner").id


# -- the schema filter ---------------------------------------------------------


def test_decomposition_tools_are_not_offered_without_task_create() -> None:
    schemas = app_tools.app_tool_schemas(set())
    names = {s["function"]["name"] for s in schemas}
    assert "propose_plan" not in names
    assert "apply_plan" not in names

    schemas = app_tools.app_tool_schemas({"task.create"})
    names = {s["function"]["name"] for s in schemas}
    assert {"propose_plan", "apply_plan"} <= names
    assert "create_task" in names


# -- propose_plan --------------------------------------------------------------


def test_propose_plan_is_permission_gated() -> None:
    conn = store.connect(":memory:")
    project_id = _project(conn)
    mate = store.create_teammate(conn, project_id, persona="p", permissions=[])
    task = store.create_task(conn, project_id, "objective", owner_teammate_id=mate.id)
    out = app_tools.execute_app_tool(_ctx(conn, task.id, mate.id), "propose_plan", {})
    assert "permission denied" in out
    assert store.list_tasks_for_project(conn, project_id) == [task]
    conn.close()


def test_propose_plan_returns_a_validated_plan_and_creates_nothing(
    monkeypatch,
) -> None:
    conn = store.connect(":memory:")
    project_id = _project(conn)
    store.create_provider(conn, project_id, kind=ProviderKind.MOCK)
    mate = store.create_teammate(
        conn, project_id, persona="planner", permissions=["task.create"]
    )
    provider_id = conn.execute(
        "SELECT id FROM providers WHERE project_id = ?", (project_id,)
    ).fetchone()["id"]
    store.update_teammate(conn, mate.id, provider_id=provider_id)
    task = store.create_task(conn, project_id, "ship the feature", owner_teammate_id=mate.id)

    def fake_plan(conn, project_id, objective, provider):  # noqa: ANN001
        assert objective == "ship the feature"
        return _plan()

    monkeypatch.setattr(decomposition, "plan_objective", fake_plan)
    out = app_tools.execute_app_tool(
        _ctx(conn, task.id, mate.id), "propose_plan", {"objective": "ship the feature"}
    )
    assert "NOTHING created yet" in out
    assert '"test the parser"' in out
    # Side-effect free: no tasks, no boards, no delegations.
    assert store.list_tasks_for_project(conn, project_id) == [task]
    assert store.list_boards(conn) == []
    conn.close()


def test_propose_plan_surfaces_provider_failure() -> None:
    conn = store.connect(":memory:")
    project_id = _project(conn)
    mate = store.create_teammate(
        conn, project_id, persona="planner", permissions=["task.create"]
    )
    task = store.create_task(conn, project_id, "objective", owner_teammate_id=mate.id)
    out = app_tools.execute_app_tool(
        _ctx(conn, task.id, mate.id), "propose_plan", {"objective": "o"}
    )
    assert "no provider available for planning" in out
    conn.close()


def test_propose_plan_reports_validation_problems(monkeypatch) -> None:
    conn = store.connect(":memory:")
    project_id = _project(conn)
    store.create_provider(conn, project_id, kind=ProviderKind.MOCK)
    mate = store.create_teammate(
        conn, project_id, persona="planner", permissions=["task.create"]
    )
    provider_id = conn.execute(
        "SELECT id FROM providers WHERE project_id = ?", (project_id,)
    ).fetchone()["id"]
    store.update_teammate(conn, mate.id, provider_id=provider_id)
    task = store.create_task(conn, project_id, "objective", owner_teammate_id=mate.id)
    ghost = store.create_teammate(conn, project_id, persona="gone", permissions=[])
    conn.execute("UPDATE teammates SET status = 'archived' WHERE id = ?", (ghost.id,))
    conn.commit()
    bad = Plan(
        tasks=[
            SubTask(description="one", command="", depends_on=[1]),
            SubTask(description="two", command="", depends_on=[]),
            SubTask(description="three", command="", owner_teammate_id=ghost.id),
        ]
    )

    monkeypatch.setattr(decomposition, "plan_objective", lambda *a, **k: bad)
    out = app_tools.execute_app_tool(
        _ctx(conn, task.id, mate.id), "propose_plan", {"objective": "o"}
    )
    assert "REJECTED by validation" in out
    assert "dependencies must point backwards" in out
    assert "not an active bot" in out
    conn.close()


# -- apply_plan ----------------------------------------------------------------


def test_apply_plan_is_permission_gated() -> None:
    conn = store.connect(":memory:")
    project_id = _project(conn)
    mate = store.create_teammate(conn, project_id, persona="p", permissions=[])
    task = store.create_task(conn, project_id, "objective", owner_teammate_id=mate.id)
    out = app_tools.execute_app_tool(
        _ctx(conn, task.id, mate.id), "apply_plan", {"plan": _plan().model_dump()}
    )
    assert "permission denied" in out
    assert store.list_tasks_for_project(conn, project_id) == [task]
    conn.close()


def test_apply_plan_hangs_tasks_on_the_current_board_without_board_create(
    tmp_path,
) -> None:
    conn = store.connect(":memory:")
    project_id = _project(conn)
    mate = store.create_teammate(
        conn, project_id, persona="planner", permissions=["task.create"]
    )
    board = store.create_board(
        conn, owner="local-owner", name="ops", project_id=project_id
    )
    task = store.create_task(
        conn, project_id, "objective", owner_teammate_id=mate.id, board_id=board.id
    )
    out = app_tools.execute_app_tool(
        _ctx(conn, task.id, mate.id),
        "apply_plan",
        {"plan": _plan().model_dump(), "objective": "the objective"},
    )
    assert "applied plan: created 2 tasks" in out
    assert f"on board {board.id}" in out
    tasks = store.list_tasks_for_project(conn, project_id)
    assert len(tasks) == 3
    [first, second] = [t for t in tasks if t.id != task.id]
    assert first.description == "write the parser"
    assert second.description == "test the parser"
    assert second.dependencies == [first.id]
    assert first.owner_teammate_id == mate.id  # unnamed steps stay with the bot
    assert first.board_id == board.id
    assert not store.list_delegations_for_task(conn, mate.id)
    conn.close()


def test_apply_plan_without_a_board_needs_board_create(monkeypatch) -> None:
    conn = store.connect(":memory:")
    project_id = _project(conn)
    mate = store.create_teammate(
        conn, project_id, persona="planner", permissions=["task.create"]
    )
    task = store.create_task(conn, project_id, "objective", owner_teammate_id=mate.id)
    ctx = _ctx(conn, task.id, mate.id)
    # The default (no explicit create_board) asks board.create to make the plan
    # board; without it the plan is refused whole.
    before = store.list_tasks_for_project(conn, project_id)
    out = app_tools.execute_app_tool(
        ctx, "apply_plan", {"plan": _plan().model_dump(), "create_board": True}
    )
    assert "permission denied: board.create" in out
    assert store.list_tasks_for_project(conn, project_id) == before
    conn.close()


def test_apply_plan_with_board_create_creates_board_and_membership() -> None:
    conn = store.connect(":memory:")
    project_id = _project(conn)
    mate = store.create_teammate(
        conn,
        project_id,
        persona="planner",
        permissions=["task.create", "board.create"],
    )
    task = store.create_task(conn, project_id, "objective", owner_teammate_id=mate.id)
    out = app_tools.execute_app_tool(
        _ctx(conn, task.id, mate.id),
        "apply_plan",
        {"plan": _plan().model_dump(), "create_board": True},
    )
    assert "applied plan: created 2 tasks" in out
    boards = store.list_boards(conn)
    assert len(boards) == 1
    board = boards[0]
    # The board belongs to the workspace owner, never to the bot.
    assert board.owner == "local-owner"
    assert board.name.startswith("Plan: ")
    members = store.list_board_members(conn, board.id)
    assert [m.teammate_id for m in members] == [mate.id]
    conn.close()


def test_apply_plan_rejects_an_invalid_plan_whole() -> None:
    conn = store.connect(":memory:")
    project_id = _project(conn)
    mate = store.create_teammate(
        conn, project_id, persona="planner", permissions=["task.create"]
    )
    task = store.create_task(conn, project_id, "objective", owner_teammate_id=mate.id)
    before_tasks = store.list_tasks_for_project(conn, project_id)
    before_boards = store.list_boards(conn)
    ctx = _ctx(conn, task.id, mate.id)

    # Forward dependency: not executable in order.
    bad_order = Plan(
        tasks=[
            SubTask(description="one", command="", depends_on=[1]),
            SubTask(description="two", command="", depends_on=[]),
        ]
    )
    out = app_tools.execute_app_tool(
        ctx, "apply_plan", {"plan": bad_order.model_dump(), "create_board": False}
    )
    assert "plan rejected" in out and "dependencies must point backwards" in out

    # Over budget.
    budget = Plan(
        tasks=[
            SubTask(description=f"step {i}", command="", depends_on=[])
            for i in range(decomposition.MAX_PLAN_STEPS + 1)
        ]
    )
    out = app_tools.execute_app_tool(
        ctx, "apply_plan", {"plan": budget.model_dump(), "create_board": False}
    )
    assert f"the limit is {decomposition.MAX_PLAN_STEPS}" in out

    # Empty plan.
    out = app_tools.execute_app_tool(
        ctx, "apply_plan", {"plan": {"tasks": []}, "create_board": False}
    )
    assert "needs at least one step" in out

    # Garbage payloads.
    out = app_tools.execute_app_tool(ctx, "apply_plan", {"plan": "not json"})
    assert "must be a JSON object" in out
    out = app_tools.execute_app_tool(
        ctx, "apply_plan", {"plan": {"tasks": "not-a-list"}}
    )
    assert "invalid plan" in out

    assert store.list_tasks_for_project(conn, project_id) == before_tasks
    assert store.list_boards(conn) == before_boards
    conn.close()


def test_apply_plan_step_assignment_needs_task_assign() -> None:
    conn = store.connect(":memory:")
    project_id = _project(conn)
    mate = store.create_teammate(
        conn, project_id, persona="planner", permissions=["task.create"]
    )
    eng = store.create_teammate(conn, project_id, persona="eng", permissions=[])
    task = store.create_task(conn, project_id, "objective", owner_teammate_id=mate.id)
    assigned = Plan(
        tasks=[SubTask(description="the work", command="", owner_teammate_id=eng.id)]
    )
    ctx = _ctx(conn, task.id, mate.id)
    out = app_tools.execute_app_tool(
        ctx, "apply_plan", {"plan": assigned.model_dump(), "create_board": False}
    )
    assert "needs task.assign" in out
    assert store.list_tasks_for_project(conn, project_id) == [task]

    with_perm = store.create_teammate(
        conn,
        project_id,
        persona="lead",
        permissions=["task.create", "task.assign"],
    )
    lead_task = store.create_task(conn, project_id, "objective", owner_teammate_id=with_perm.id)
    out = app_tools.execute_app_tool(
        _ctx(conn, lead_task.id, with_perm.id),
        "apply_plan",
        {"plan": assigned.model_dump(), "create_board": False},
    )
    assert "applied plan: created 1 tasks" in out
    created = [
        t
        for t in store.list_tasks_for_project(conn, project_id)
        if t.id not in (task.id, lead_task.id)
    ]
    assert len(created) == 1
    assert created[0].owner_teammate_id == eng.id
    conn.close()


def test_apply_plan_reported_apply_when_the_plan_names_an_archived_bot() -> None:
    conn = store.connect(":memory:")
    project_id = _project(conn)
    mate = store.create_teammate(
        conn,
        project_id,
        persona="planner",
        permissions=["task.create", "task.assign"],
    )
    gone = store.create_teammate(conn, project_id, persona="gone", permissions=[])
    conn.execute("UPDATE teammates SET status = 'archived' WHERE id = ?", (gone.id,))
    conn.commit()
    task = store.create_task(conn, project_id, "objective", owner_teammate_id=mate.id)
    stale = Plan(
        tasks=[SubTask(description="work", command="", owner_teammate_id=gone.id)]
    )
    out = app_tools.execute_app_tool(
        _ctx(conn, task.id, mate.id),
        "apply_plan",
        {"plan": stale.model_dump(), "create_board": False},
    )
    assert "not an active bot" in out
    conn.close()


# -- the executor's dependency semantics --------------------------------------


def test_sweep_leaves_dependent_tasks_pending_until_their_dependencies_finish(
    tmp_path,
) -> None:
    from nerdbot.models import TaskStatus

    conn = store.connect(":memory:")
    project_id = _project(conn)
    store.create_provider(conn, project_id, kind=ProviderKind.MOCK)
    mate = store.create_teammate(conn, project_id, persona="worker", permissions=[])
    provider_id = conn.execute(
        "SELECT id FROM providers WHERE project_id = ?", (project_id,)
    ).fetchone()["id"]
    store.update_teammate(conn, mate.id, provider_id=provider_id)
    first = store.create_task(conn, project_id, "first", command="echo one")
    second = store.create_task(
        conn, project_id, "second", dependencies=[first.id], command="echo two"
    )
    # Run the first task to completion directly.
    orchestrator.schedule_run(conn, first.id, data_dir=str(tmp_path))
    assert store.get_task(conn, first.id).status == TaskStatus.DONE  # type: ignore[union-attr]
    summary = executor.sweep(conn, data_dir=str(tmp_path))
    assert [s for s in summary if s.get("status") == "requeued"] == []
    assert any(
        s.get("task_id") == second.id and s.get("status") == "succeeded"
        for s in summary
    ), summary
    conn.close()


def test_sweep_does_not_claim_a_task_whose_dependencies_are_not_done(tmp_path) -> None:
    conn = store.connect(":memory:")
    project_id = _project(conn)
    store.create_provider(conn, project_id, kind=ProviderKind.MOCK)
    mate = store.create_teammate(conn, project_id, persona="worker", permissions=[])
    provider_id = conn.execute(
        "SELECT id FROM providers WHERE project_id = ?", (project_id,)
    ).fetchone()["id"]
    store.update_teammate(conn, mate.id, provider_id=provider_id)
    first = store.create_task(conn, project_id, "first", command="echo one")
    second = store.create_task(
        conn, project_id, "second", dependencies=[first.id], command="echo two"
    )
    executor.sweep(conn, data_dir=str(tmp_path))
    # The dependent task was NOT claimed and NOT blocked: it stays pending
    # and executable once its dependency finishes.
    second_task = store.get_task(conn, second.id)
    assert second_task is not None and second_task.status.value == "pending"
    assert second_task.owner_teammate_id is None
    _ = first
    conn.close()


def test_sweep_requeues_a_blocked_task_when_its_dependencies_finish(
    tmp_path,
) -> None:
    from nerdbot.models import TaskStatus

    conn = store.connect(":memory:")
    project_id = _project(conn)
    store.create_provider(conn, project_id, kind=ProviderKind.MOCK)
    mate = store.create_teammate(conn, project_id, persona="worker", permissions=[])
    provider_id = conn.execute(
        "SELECT id FROM providers WHERE project_id = ?", (project_id,)
    ).fetchone()["id"]
    store.update_teammate(conn, mate.id, provider_id=provider_id)
    first = store.create_task(conn, project_id, "first", command="echo one")
    second = store.create_task(
        conn, project_id, "second", dependencies=[first.id], command="echo two"
    )
    orchestrator.schedule_run(conn, second.id, data_dir=str(tmp_path))
    assert store.get_task(conn, second.id).status == TaskStatus.BLOCKED  # type: ignore[union-attr]
    orchestrator.schedule_run(conn, first.id, data_dir=str(tmp_path))
    summary = executor.sweep(conn, data_dir=str(tmp_path))
    requeued = [s for s in summary if s.get("task_id") == second.id]
    assert any(s.get("status") == "requeued" for s in requeued), summary
    assert any(
        s.get("task_id") == second.id and s.get("status") == "succeeded" for s in summary
    ), summary
    conn.close()


def test_sweep_never_requeues_a_declined_delegation_child(tmp_path) -> None:
    from nerdbot.models import TaskStatus

    conn = store.connect(":memory:")
    project_id = _project(conn)
    ceo = store.create_teammate(conn, project_id, persona="ceo", permissions=["task.delegate"])
    eng = store.create_teammate(conn, project_id, persona="eng", permissions=[])
    parent = store.create_task(conn, project_id, "objective", owner_teammate_id=ceo.id)
    app_tools.execute_app_tool(
        _ctx(conn, parent.id, ceo.id),
        "delegate_task",
        {"to_teammate_id": eng.id, "description": "sub", "command": "echo hi"},
    )
    child = store.list_child_tasks(conn, parent.id)[0]
    app_tools.execute_app_tool(
        _ctx(conn, child.id, eng.id), "respond_to_delegation", {"decision": "declined"}
    )
    executor.sweep(conn, data_dir=str(tmp_path))
    child_after = store.get_task(conn, child.id)
    assert child_after is not None and child_after.status == TaskStatus.BLOCKED
    conn.close()


# -- the HTTP decompose surface -------------------------------------------------


def _project_api(client: TestClient) -> str:
    r = client.post("/projects", json={"repository": "r"}, headers=AUTH)
    assert r.status_code == 200, r.text
    return r.json()["id"]


def _board_api(client: TestClient, project_id: str) -> str:
    r = client.post(
        "/boards", json={"name": "seed", "project_id": project_id}, headers=AUTH
    )
    assert r.status_code == 200, r.text
    return r.json()["id"]


def test_materialize_leg_now_validates_reviewed_plans(app_client: TestClient) -> None:
    """Regression: the reviewed-plan leg used to validate nothing — a plan
    with a forward dependency was materialized as-is."""
    pid = _project_api(app_client)
    board_id = _board_api(app_client, pid)
    bad = {
        "tasks": [
            {"description": "one", "command": "", "depends_on": [1]},
            {"description": "two", "command": "", "depends_on": []},
        ]
    }
    r = app_client.post(
        f"/boards/{board_id}/decompose",
        json={"objective": "o", "plan": bad, "create_board": False},
        headers=AUTH,
    )
    assert r.status_code == 400, r.text
    assert "dependencies must point backwards" in r.text
    assert app_client.get(f"/projects/{pid}/tasks", headers=AUTH).json() == {"tasks": []}


def test_materialize_leg_rejects_a_plan_with_a_stale_owner(app_client: TestClient) -> None:
    pid = _project_api(app_client)
    board_id = _board_api(app_client, pid)
    ghost = app_client.post(
        f"/projects/{pid}/teammates", json={"persona": "gone"}, headers=AUTH
    ).json()["id"]
    r = app_client.post(f"/teammates/{ghost}/archive", headers=AUTH)
    assert r.status_code == 200, r.text
    bad = {
        "tasks": [
            {"description": "work", "command": "", "depends_on": [],
             "owner_teammate_id": ghost},
        ]
    }
    r = app_client.post(
        f"/boards/{board_id}/decompose",
        json={"objective": "o", "plan": bad},
        headers=AUTH,
    )
    assert r.status_code == 400, r.text
    assert "not an active bot" in r.text


# -- end-to-end: the model proposes, applies, and delegates ---------------------


class _ScriptedTransport(httpx.MockTransport):
    """Turns a scripted request handler into a transport; captures bodies."""

    def __init__(self, handler) -> None:  # noqa: ANN001
        self.bodies: list[dict] = []
        real = handler

        def wrapped(request: httpx.Request) -> httpx.Response:
            self.bodies.append(json.loads(request.content))
            return real(request)

        super().__init__(wrapped)


def _msg(content: str | None = None, calls: list[dict] | None = None) -> dict:
    message: dict = {"role": "assistant", "content": content}
    if calls is not None:
        message["tool_calls"] = calls
    return {"choices": [{"message": message}]}


def _call(call_id: str, name: str, arguments: dict) -> dict:
    return {
        "id": call_id,
        "type": "function",
        "function": {"name": name, "arguments": json.dumps(arguments)},
    }


def test_model_proposes_applies_and_delegates_a_plan(app_client, monkeypatch, tmp_path) -> None:
    """The full loop, through the real provider adapter:

    run 1: the CEO's model calls propose_plan then apply_plan (creating the
           plan board and tasks, persistently), and delegates the plan's
           first task to the engineer.
    child: the engineer accepts and executes; its result flows back through
           the delegation record.
    """
    pid = _project_api(app_client)
    provider = app_client.post(
        f"/projects/{pid}/providers",
        json={
            "name": "loop",
            "kind": ProviderKind.OPENAI_COMPATIBLE.value,
            "config": {
                "base_url": "https://provider.example/v1",
                "model": "m",
                "api_key": "sk-test",
            },
        },
        headers=AUTH,
    )
    assert provider.status_code == 200, provider.text
    provider_id = provider.json()["id"]
    ceo = app_client.post(
        f"/projects/{pid}/teammates",
        json={
            "persona": "ceo",
            "permissions": ["task.create", "board.create", "task.delegate"],
            "provider_id": provider_id,
        },
        headers=AUTH,
    ).json()
    eng = app_client.post(
        f"/projects/{pid}/teammates",
        json={"persona": "engineer", "provider_id": provider_id, "permissions": []},
        headers=AUTH,
    ).json()
    task = app_client.post(
        f"/projects/{pid}/tasks",
        json={
            "description": "objective",
            "command": "Ship the parser end to end.",
            "owner_teammate_id": ceo["id"],
        },
        headers=AUTH,
    ).json()

    # The planner leg (propose_plan) is a separate completion: script it and
    # capture which objective it was asked to plan.
    planned: dict[str, str] = {}

    def fake_plan(conn, project_id, objective, provider):  # noqa: ANN001
        planned["objective"] = objective
        return _plan()

    monkeypatch.setattr(decomposition, "plan_objective", fake_plan)

    # The agent-loop transport: turn 1 proposes + applies; turn 2 delegates
    # the first plan task (the id is read back out of the real tool result).
    state: dict[str, str] = {}
    delegate_call_made = {"v": False}

    def handler(request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content)
        tool_messages = [
            m for m in body.get("messages", []) if m.get("role") == "tool"
        ]
        names = [m.get("name") for m in tool_messages]
        if not tool_messages:
            return httpx.Response(
                200,
                json=_msg(
                    "",
                    [
                        _call("p1", "propose_plan", {"objective": "Ship the parser"}),
                        _call("a1", "apply_plan", {"plan": _plan().model_dump()}),
                    ],
                ),
            )
        if "apply_plan" in names and not delegate_call_made["v"]:
            apply_result = next(m for m in tool_messages if m.get("name") == "apply_plan")
            first_line = next(
                line
                for line in apply_result["content"].splitlines()
                if line.startswith("- task ")
            )
            state["plan_task_id"] = first_line.split()[2]
            delegate_call_made["v"] = True
            return httpx.Response(
                200,
                json=_msg(
                    "",
                    [
                        _call(
                            "d1",
                            "delegate_task",
                            {
                                "task_id": state["plan_task_id"],
                                "to_teammate_id": eng["id"],
                                "description": "write the parser",
                                "scope": "parser only",
                                "command": "echo parser-done",
                            },
                        )
                    ],
                ),
            )
        return httpx.Response(
            200, json=_msg("plan applied; first task delegated and pending.")
        )

    transport = _ScriptedTransport(handler)
    real_init = providers.OpenAICompatibleAdapter.__init__

    def patched_init(self, config, **kwargs):  # noqa: ANN001
        kwargs["transport"] = transport
        real_init(self, config, **kwargs)

    monkeypatch.setattr(providers.OpenAICompatibleAdapter, "__init__", patched_init)

    run = app_client.post(f"/tasks/{task['id']}/runs", json={}, headers=AUTH)
    assert run.status_code == 200, run.text

    # The plan persisted: board + tasks + membership.
    boards = app_client.get("/boards", params={"project_id": pid}, headers=AUTH).json()["boards"]
    assert len(boards) == 1
    board = boards[0]
    assert board["name"].startswith("Plan: ")
    members = app_client.get(f"/boards/{board['id']}/members", headers=AUTH).json()["members"]
    assert [m["teammate_id"] for m in members] == [ceo["id"]]
    tasks = app_client.get(f"/projects/{pid}/tasks", headers=AUTH).json()["tasks"]
    # Exclude the objective root task and the delegation child (which shares
    # the plan step's description) — the two plan tasks remain.
    plan_tasks = {
        t["description"]: t
        for t in tasks
        if t["id"] != task["id"] and t["parent_task_id"] != state["plan_task_id"]
    }
    assert set(plan_tasks) == {"write the parser", "test the parser"}
    assert plan_tasks["write the parser"]["owner_teammate_id"] == ceo["id"]
    assert (
        plan_tasks["test the parser"]["dependencies"]
        == [plan_tasks["write the parser"]["id"]]
    )
    assert planned["objective"] == "Ship the parser"

    # The delegation from the plan's first task is real and pending.
    delegations = app_client.get(
        f"/tasks/{state['plan_task_id']}/delegations", headers=AUTH
    ).json()["delegations"]
    assert len(delegations) == 1
    assert delegations[0]["status"] == "pending"
    child_id = delegations[0]["child_task_id"]
    assert delegations[0]["scope"] == "parser only"

    # The engineer's run: accept, then do the work.
    accept_calls = {"n": 0}

    def child_handler(request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content)
        tool_messages = [m for m in body.get("messages", []) if m.get("role") == "tool"]
        if not tool_messages:
            accept_calls["n"] += 1
            return httpx.Response(
                200,
                json=_msg("", [_call("a1", "respond_to_delegation",
                                     {"decision": "accepted"})]),
            )
        return httpx.Response(200, json=_msg("parser written and tested locally."))

    def patched_engineer_init(self, config, **kwargs):  # noqa: ANN001
        kwargs["transport"] = _ScriptedTransport(child_handler)
        real_init(self, config, **kwargs)

    monkeypatch.setattr(
        providers.OpenAICompatibleAdapter, "__init__", patched_engineer_init
    )
    child_run = app_client.post(f"/tasks/{child_id}/runs", json={}, headers=AUTH)
    assert child_run.status_code == 200, child_run.text
    assert child_run.json()["run"]["status"] == "succeeded", child_run.json()

    # The engineering result flowed back through the delegation record.
    refreshed = app_client.get(
        f"/tasks/{state['plan_task_id']}/delegations", headers=AUTH
    ).json()["delegations"][0]
    assert refreshed["status"] == "completed"
    assert "parser written and tested locally" in refreshed["result"]
