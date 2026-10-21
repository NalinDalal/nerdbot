"""The dashboard's Priority 4 flows must behave as the screens that drive them.

The dashboard is only honest if the flows it renders are the real backend
flows. These tests pin the exact requests the dashboard's views send and the
state a human sees afterwards — the same contract style
``test_permission_grant_contract.py`` set for grants and membership:

- plan review (``views-boards.tsx`` decompose modal): a preview is
  side-effect-free and fails closed without a provider; the reviewed plan
  materializes *exactly* what the human saw (as ``views-boards.tsx`` posts
  it — ``{objective, plan, create_board: true}``, no second model call);
  a plan whose facts went stale is rejected whole with an error the modal
  can show, and nothing is created;
- handoffs (``views-task.tsx`` handoffs table): the dashboard's delegate
  body (``from/to/reason/depth``) becomes a pending delegation in both task
  view and the delegations endpoint; the owner may accept, decline, or
  cancel on a bot's behalf; a decided delegation is never re-decided;
- cancellation: cancelling a task cancels its pending delegations so no bot
  picks up work that was withdrawn;
- workspace browser (``WorkspacePanel``): the file browser is read-only,
  lists real files, resolves paths the human clicks, and rejects path
  escapes with the same error the tool gates show.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient

from nerdbot import decomposition
from nerdbot.api import create_app
from nerdbot.decomposition import Plan, SubTask

TOKEN = "dash-flow-token"
AUTH = {"Authorization": f"Bearer {TOKEN}"}


@pytest.fixture()
def client(tmp_path, monkeypatch):
    from cryptography.fernet import Fernet

    monkeypatch.setenv("NERDBOT_TOKEN", TOKEN)
    monkeypatch.setenv("NERDBOT_SECRET_KEY", Fernet.generate_key().decode("ascii"))
    monkeypatch.setenv("NERDBOT_DB", str(tmp_path / "dashflow.db"))
    monkeypatch.setenv("NERDBOT_DATA", str(tmp_path / "data"))
    return TestClient(create_app())


def _project(client: TestClient, repository: str = "r") -> str:
    r = client.post("/projects", json={"repository": repository}, headers=AUTH)
    assert r.status_code == 200, r.text
    return r.json()["id"]


def _teammate(client: TestClient, project_id: str, persona: str = "bot") -> str:
    r = client.post(
        f"/projects/{project_id}/teammates",
        json={"persona": persona, "instructions": "i", "capabilities": ["code"]},
        headers=AUTH,
    )
    assert r.status_code == 200, r.text
    return r.json()["id"]


def _board(client: TestClient, project_id: str, name: str = "board") -> str:
    r = client.post(
        "/boards",
        json={"name": name, "project_id": project_id},
        headers=AUTH,
    )
    assert r.status_code == 200, r.text
    return r.json()["id"]


def _task(client: TestClient, project_id: str, board_id: str = "", command: str = "echo hi") -> str:
    body: dict[str, Any] = {"description": "do the thing", "command": command}
    if board_id:
        body["board_id"] = board_id
    r = client.post(f"/projects/{project_id}/tasks", json=body, headers=AUTH)
    assert r.status_code == 200, r.text
    return r.json()["id"]


def _delegate(client: TestClient, task_id: str, from_id: str, to_id: str) -> dict[str, Any]:
    """Exactly this body, in this shape — views-task.tsx's delegate()."""
    r = client.post(
        f"/tasks/{task_id}/delegate",
        json={
            "from_teammate_id": from_id,
            "to_teammate_id": to_id,
            "reason": "needs another pair of hands",
            "depth": 1,
        },
        headers=AUTH,
    )
    assert r.status_code == 200, r.text
    return r.json()


# -- plan review: preview then materialize -------------------------------------


def test_plan_preview_fails_closed_without_a_provider(client: TestClient) -> None:
    project_id = _project(client)
    board_id = _board(client, project_id)
    r = client.post(
        f"/boards/{board_id}/decompose",
        json={"objective": "ship the parser", "preview": True},
        headers=AUTH,
    )
    assert r.status_code == 400, r.text
    assert "no provider available" in r.json()["detail"]


def test_plan_preview_creates_nothing(client: TestClient, monkeypatch) -> None:
    project_id = _project(client)
    board_id = _board(client, project_id)
    r = client.post(
        f"/projects/{project_id}/providers",
        json={"kind": "mock", "name": "planner"},
        headers=AUTH,
    )
    assert r.status_code == 200, r.text

    fixed = Plan(tasks=[SubTask(description="step a"), SubTask(description="step b", depends_on=[0])])
    monkeypatch.setattr(decomposition, "plan_objective", lambda *a, **k: fixed)

    r = client.post(
        f"/boards/{board_id}/decompose",
        json={"objective": "ship the parser", "preview": True},
        headers=AUTH,
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["preview"] is True
    assert body["board"] is None
    assert body["tasks"] == []
    assert body["plan"]["tasks"][1]["depends_on"] == [0]

    # Side-effect free: a preview decides nothing.
    r = client.get(f"/boards/{board_id}", headers=AUTH)
    assert r.status_code == 200, r.text
    assert r.json()["board"]["name"] == "board"
    r = client.get("/boards", params={"project_id": project_id}, headers=AUTH)
    assert r.status_code == 200, r.text
    assert [b["id"] for b in r.json()["boards"]] == [board_id], r.text
    r = client.get(f"/projects/{project_id}/tasks", headers=AUTH)
    assert [t["id"] for t in r.json()["tasks"]] == [], r.text


def test_reviewed_plan_materializes_exactly(client: TestClient) -> None:
    """The plan the human saw is the plan that runs — same steps, same
    order, same dependencies, same owners; no second model call in between.
    Sent exactly as the decompose modal sends it."""
    project_id = _project(client)
    board_id = _board(client, project_id)
    mate_id = _teammate(client, project_id, "worker")
    # A step named for a teammate is created owned by that teammate — the
    # human authorizes the assignment by reviewing the plan.
    plan: dict[str, Any] = {
        "tasks": [
            {"description": "write the parser", "command": "echo parser", "depends_on": []},
            {
                "description": "test the parser",
                "command": "echo test",
                "depends_on": [0],
                "owner_teammate_id": mate_id,
            },
        ]
    }
    r = client.post(
        f"/boards/{board_id}/decompose",
        json={"objective": "ship the parser", "plan": plan, "create_board": True},
        headers=AUTH,
    )
    assert r.status_code == 200, r.text
    body = r.json()

    # A fresh plan board, owned by the workspace owner — visible to a human,
    # not held hostage by whichever bot triggered the flow.
    plan_board = body["board"]
    assert plan_board is not None
    assert plan_board["name"] == "Plan: ship the parser"
    assert plan_board["project_id"] == project_id

    created = body["tasks"]
    assert [t["description"] for t in created] == ["write the parser", "test the parser"]
    assert all(t["board_id"] == plan_board["id"] for t in created)
    assert created[0]["owner_teammate_id"] in (None, "")  # human path → claimable
    assert created[1]["owner_teammate_id"] == mate_id
    assert created[1]["dependencies"] == [created[0]["id"]]

    r = client.get(f"/projects/{project_id}/tasks", headers=AUTH)
    assert {t["id"] for t in r.json()["tasks"]} >= {t["id"] for t in created}


def test_reviewed_plan_rejected_whole_when_ill_edited(client: TestClient) -> None:
    """A plan edited into a cycle (or whose facts went stale) is refused in
    full — nothing partial — with the error the decompose modal shows."""
    project_id = _project(client)
    board_id = _board(client, project_id)
    plan_bad: dict[str, Any] = {
        "tasks": [
            {"description": "first", "command": "echo a", "depends_on": [1]},
            {"description": "second", "command": "echo b", "depends_on": []},
        ]
    }
    r = client.post(
        f"/boards/{board_id}/decompose",
        json={"objective": "obj", "plan": plan_bad},
        headers=AUTH,
    )
    assert r.status_code == 400, r.text
    assert "plan rejected" in r.json()["detail"]
    assert "dependencies must point backwards" in r.json()["detail"]

    # Rejected whole: even the plan board was never created.
    r = client.get("/boards", params={"project_id": project_id}, headers=AUTH)
    boards = r.json()["boards"]
    assert [b["id"] for b in boards] == [board_id], r.text
    r = client.get(f"/projects/{project_id}/tasks", headers=AUTH)
    assert r.json()["tasks"] == [], r.text


def test_reviewed_plan_named_after_a_dead_bot_is_rejected_whole(
    client: TestClient,
) -> None:
    """Stale facts: a reviewed plan that names a bot which was archived in
    the meantime is refused before anything is created."""
    project_id = _project(client)
    board_id = _board(client, project_id)
    mate_id = _teammate(client, project_id, "worker")
    assert client.post(f"/teammates/{mate_id}/archive", headers=AUTH).status_code == 200

    plan: dict[str, Any] = {
        "tasks": [
            {"description": "step", "command": "echo x", "owner_teammate_id": mate_id},
        ]
    }
    r = client.post(
        f"/boards/{board_id}/decompose",
        json={"objective": "obj", "plan": plan},
        headers=AUTH,
    )
    assert r.status_code == 400, r.text
    assert "plan rejected" in r.json()["detail"]
    assert "not an active bot" in r.json()["detail"]
    r = client.get(f"/projects/{project_id}/tasks", headers=AUTH)
    assert r.json()["tasks"] == [], r.text


# -- handoffs (delegation) ------------------------------------------------------


def test_handoff_delegation_is_visible_and_decidable(client: TestClient) -> None:
    project_id = _project(client)
    board_id = _board(client, project_id)
    owner_bot = _teammate(client, project_id, "lead")
    helper = _teammate(client, project_id, "helper")
    task_id = _task(client, project_id, board_id)

    delegation = _delegate(client, task_id, owner_bot, helper)
    assert delegation["status"] == "pending"
    assert delegation["from_teammate_id"] == owner_bot
    assert delegation["to_teammate_id"] == helper
    assert delegation["reason"] == "needs another pair of hands"
    assert delegation["depth"] == 1

    # The handoffs table reads /tasks/{id}/delegations; both it and the task
    # view render the same pending row.
    r = client.get(f"/tasks/{task_id}/delegations", headers=AUTH)
    assert [d["id"] for d in r.json()["delegations"]] == [delegation["id"]]
    r = client.get(f"/tasks/{task_id}", headers=AUTH)
    view_delegations = r.json().get("delegations", [])
    assert [d["id"] for d in view_delegations] == [delegation["id"]]

    # The owner declines on the delegatee's behalf (bots have no model here).
    r = client.post(
        f"/delegations/{delegation['id']}/decide",
        json={"decision": "declined"},
        headers=AUTH,
    )
    assert r.status_code == 200, r.text
    assert r.json()["status"] == "declined"
    assert r.json()["decided_at"] is not None

    # A refusal is terminal: never re-decided, never rewritten into acceptance.
    r = client.post(
        f"/delegations/{delegation['id']}/decide",
        json={"decision": "accepted"},
        headers=AUTH,
    )
    assert r.status_code == 400, r.text
    assert "cannot be re-decided" in r.json()["detail"]

    r = client.get(f"/tasks/{task_id}/delegations", headers=AUTH)
    assert r.json()["delegations"][0]["status"] == "declined"


def test_handoff_accept_records_the_delegatee_s_commitment(client: TestClient) -> None:
    project_id = _project(client)
    board_id = _board(client, project_id)
    lead = _teammate(client, project_id, "lead")
    helper = _teammate(client, project_id, "helper")
    task_id = _task(client, project_id, board_id)

    delegation = _delegate(client, task_id, lead, helper)
    r = client.post(
        f"/delegations/{delegation['id']}/decide",
        json={"decision": "accepted"},
        headers=AUTH,
    )
    assert r.status_code == 200, r.text
    assert r.json()["status"] == "accepted"

    r = client.get(f"/tasks/{task_id}/delegations", headers=AUTH)
    assert r.json()["delegations"][0]["status"] == "accepted"


def test_owner_can_cancel_a_pending_handoff(client: TestClient) -> None:
    project_id = _project(client)
    board_id = _board(client, project_id)
    lead = _teammate(client, project_id, "lead")
    helper = _teammate(client, project_id, "helper")
    task_id = _task(client, project_id, board_id)

    delegation = _delegate(client, task_id, lead, helper)
    r = client.post(
        f"/delegations/{delegation['id']}/cancel",
        json={"reason": "changed my mind"},
        headers=AUTH,
    )
    assert r.status_code == 200, r.text
    assert r.json()["status"] == "cancelled"


def test_cancelling_a_task_cancels_its_pending_handoffs(client: TestClient) -> None:
    """No bot may pick up work the human withdrew: cancelling a task
    cancels every pending delegation out of it."""
    project_id = _project(client)
    board_id = _board(client, project_id)
    lead = _teammate(client, project_id, "lead")
    helper = _teammate(client, project_id, "helper")
    task_id = _task(client, project_id, board_id)

    delegation = _delegate(client, task_id, lead, helper)
    r = client.post(f"/tasks/{task_id}/cancel", json={"reason": "withdrawn"}, headers=AUTH)
    assert r.status_code == 200, r.text
    task = r.json()
    assert task["status"] in ("cancelled", "blocked"), task["status"]

    r = client.get(f"/tasks/{task_id}/delegations", headers=AUTH)
    statuses = {d["id"]: d["status"] for d in r.json()["delegations"]}
    assert statuses[delegation["id"]] == "cancelled", statuses


# -- workspace browser -----------------------------------------------------------


def test_workspace_browser_lists_reads_and_refuses_escapes(client: TestClient) -> None:
    project_id = _project(client)
    task_id = _task(client, project_id)

    from nerdbot import workspace as workspace_mod

    r = client.post(f"/tasks/{task_id}/workspace", json={}, headers=AUTH)
    assert r.status_code == 200, r.text
    ensured = r.json()
    assert Path(ensured["path"]).name == task_id
    assert ensured["branch"] == f"nb/{task_id}"

    # Seed tracked content so the diff has something real to show.
    work_path = Path(ensured["path"])
    (work_path / "notes.txt").write_text("v1\n", encoding="utf-8")
    workspace_mod.baseline_commit(work_path)
    (work_path / "notes.txt").write_text("v2\n", encoding="utf-8")

    r = client.get(f"/tasks/{task_id}/workspace/files", headers=AUTH)
    assert r.status_code == 200, r.text
    listing = r.json()
    assert listing["root"] == str(work_path)
    assert [f["path"] for f in listing["files"]] == ["notes.txt"]

    r = client.get(f"/tasks/{task_id}/workspace/file?path=notes.txt", headers=AUTH)
    assert r.status_code == 200, r.text
    assert r.json()["content"] == "v2\n"

    # The browser renders whatever the server returns, so the server has
    # to be the one that refuses to leave the workspace.
    r = client.get(
        f"/tasks/{task_id}/workspace/file",
        params={"path": "../data/outside.txt"},
        headers=AUTH,
    )
    assert r.status_code == 400, r.text
    assert "path escapes workspace" in r.json()["detail"]

    r = client.post(f"/tasks/{task_id}/workspace", json={}, headers=AUTH)
    assert r.status_code == 200, r.text
    again = r.json()
    assert again["path"] == ensured["path"]  # reuse, not recreation

    # Deleting the workspace removes the listing; artifact rows keep their
    # recorded locations — the dashboard shows what was, not what is.
    r = client.delete(f"/tasks/{task_id}/workspace", headers=AUTH)
    assert r.status_code == 200, r.text
    assert r.json()["removed"] is True

    r = client.get(f"/tasks/{task_id}/workspace/files", headers=AUTH)
    assert r.status_code == 200, r.text
    assert r.json()["files"] == [], r.text
