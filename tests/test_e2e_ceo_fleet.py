"""End-to-end CEO fleet scenario with real model execution (scripted upstream).

Exercises the acceptance workflow from the product brief against the real
orchestrator, gates, workspace, delegation and response channel — only the
model HTTP transport is mocked (no network, no paid calls):

1. Owner creates a team + a CEO bot with explicit, gated permissions.
2. CEO creates an engineering bot through the real ``create_teammate`` tool;
   the exact-action approval gate is presented and the owner approves it.
3. CEO receives a substantive objective, reasons, and delegates to the
   engineering bot via ``delegate_task``.
4. The engineering bot executes the delegated child task in its isolated Git
   workspace with a real (mocked-transport) model run.
5. The result flows back through the Delegation record; the CEO retrieves it
   with ``check_delegations`` and reports the final outcome.
6. State is inspectable: team membership, task tree, delegations, artifacts.

The model determines the plan; the application validates actions, permissions
and state transitions. No subtasks are pre-created by the test.
"""

from __future__ import annotations

import json

import httpx
import pytest
from fastapi.testclient import TestClient

from nerdbot import providers as providers_mod
from nerdbot.api import create_app
from nerdbot.models import ProviderKind

TOKEN = "e2e-ceo-token"
AUTH = {"Authorization": f"Bearer {TOKEN}"}
SECRET = "sk-e2e-mock-key"


@pytest.fixture()
def client(tmp_path, monkeypatch):
    from cryptography.fernet import Fernet

    monkeypatch.setenv("NERDBOT_TOKEN", TOKEN)
    monkeypatch.setenv("NERDBOT_SECRET_KEY", Fernet.generate_key().decode("ascii"))
    monkeypatch.setenv("NERDBOT_DB", str(tmp_path / "ceo.db"))
    monkeypatch.setenv("NERDBOT_DATA", str(tmp_path / "data"))
    return TestClient(create_app())


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


class ScriptedTransport(httpx.MockTransport):
    def __init__(self, script: list) -> None:
        self.script = script
        self.i = 0
        self.seen: list[dict] = []

        def handler(request: httpx.Request) -> httpx.Response:
            self.seen.append(json.loads(request.content))
            idx = min(self.i, len(self.script) - 1)
            self.i += 1
            return httpx.Response(200, json=self.script[idx])

        super().__init__(handler)


class FleetHarness:
    """Installs a scripted transport and captures tool outcomes."""

    def __init__(self, monkeypatch) -> None:  # type: ignore[no-untyped-def]
        self.transport: ScriptedTransport | None = None
        self.created: dict[str, str] = {}  # persona -> teammate id
        self.tool_results: list[tuple[str, str]] = []
        self._monkeypatch = monkeypatch
        self._install(monkeypatch)

    def _install(self, monkeypatch) -> None:  # type: ignore[no-untyped-def]
        real_init = providers_mod.OpenAICompatibleAdapter.__init__
        real_exec = providers_mod.OpenAICompatibleAdapter._execute_one
        outer = self

        def patched_init(self, config, **kwargs):  # type: ignore[no-untyped-def]
            if outer.transport is not None:
                kwargs["transport"] = outer.transport
            real_init(self, config, **kwargs)

        def capture_exec(self, workspace, name, arguments, context):  # type: ignore[no-untyped-def]
            result = real_exec(self, workspace, name, arguments, context)
            outer.tool_results.append((name, result))
            if name == "create_teammate" and "created teammate" in result:
                mate_id = result.split("created teammate ")[1].split(" ")[0]
                outer.created[arguments.get("persona", "")] = mate_id
            return result

        monkeypatch.setattr(providers_mod.OpenAICompatibleAdapter, "__init__", patched_init)
        monkeypatch.setattr(providers_mod.OpenAICompatibleAdapter, "_execute_one", capture_exec)

    def script(self, items: list) -> None:
        self.transport = ScriptedTransport(items)


def _project_with_provider(client: TestClient) -> tuple[str, str]:
    pid = client.post("/projects", json={"repository": "acme/app"}, headers=AUTH).json()["id"]
    r = client.post(
        f"/projects/{pid}/providers",
        json={
            "name": "mock",
            "kind": ProviderKind.OPENAI_COMPATIBLE.value,
            "config": {
                "base_url": "https://provider.example/v1",
                "model": "e2e-model",
                "api_key": SECRET,
            },
        },
        headers=AUTH,
    )
    assert r.status_code == 200, r.text
    provider_id = client.get(f"/projects/{pid}/providers", headers=AUTH).json()["providers"][0]["id"]
    return pid, provider_id


def test_ceo_creates_bots_delegates_and_reports(client, monkeypatch) -> None:
    pid, provider_id = _project_with_provider(client)
    harness = FleetHarness(monkeypatch)

    # --- Owner creates a team + a CEO bot with explicit permissions ---------
    team = client.post("/teams", json={"name": "Acme Squad"}, headers=AUTH).json()
    ceo = client.post(
        f"/projects/{pid}/teammates",
        json={
            "persona": "CEO orchestrator",
            "instructions": "Decompose objectives and delegate to specialists.",
            "permissions": [
                "teammate.create",
                "task.create",
                "task.assign",
                "task.delegate",
                "message.send",
            ],
            "provider_id": provider_id,
        },
        headers=AUTH,
    ).json()
    add = client.post(
        f"/teams/{team['id']}/teammates", json={"teammate_id": ceo["id"]}, headers=AUTH
    )
    assert add.status_code == 200, add.text

    task = client.post(
        f"/projects/{pid}/tasks",
        json={
            "description": "Ship the login feature",
            "command": "Ship the login feature end to end.",
            "owner_teammate_id": ceo["id"],
        },
        headers=AUTH,
    ).json()

    # --- Run 1: the CEO tries to create the engineering bot, gets gated ----
    # The CEO first looks up the workspace's model provider (it needs the
    # provider_id to attach a model to the bots it creates), then tries to
    # create both bots. Both creations are gated.
    harness.script([_msg("", [_call("p1", "list_providers", {}),
                              _call("c1", "create_teammate", {"persona": "engineer",
                                                              "provider_id": provider_id}),
                              _call("c2", "create_teammate", {"persona": "reviewer",
                                                              "provider_id": provider_id})])])
    run1 = client.post(f"/tasks/{task['id']}/runs", json={}, headers=AUTH).json()
    assert run1["run"]["status"] in ("succeeded", "failed")

    approvals = client.get(f"/projects/{pid}/approvals", headers=AUTH).json()["approvals"]
    pending = [a for a in approvals if a["decision"] == "pending"]
    assert len(pending) == 2, f"expected 2 gated creations, got {pending}"
    assert all(a["digest"] for a in pending)
    assert {a["requester"] for a in pending} == {ceo["id"]}
    assert all(a["project_id"] == pid for a in pending)

    # --- Owner approves the exact proposed actions -------------------------
    for a in pending:
        d = client.post(
            f"/approvals/{a['id']}/decision", json={"decision": "approved"}, headers=AUTH
        )
        assert d.status_code == 200, d.text

    # --- Run 2: approved creations materialize -----------------------------
    harness.script(
        [
            _msg("", [_call("c3", "create_teammate", {"persona": "engineer",
                                                       "provider_id": provider_id})]),
            _msg("", [_call("c4", "create_teammate", {"persona": "reviewer",
                                                       "provider_id": provider_id})]),
            _msg("bots created; ready to delegate"),
        ]
    )
    run2 = client.post(f"/tasks/{task['id']}/retry", json={}, headers=AUTH).json()
    assert run2["run"]["status"] in ("succeeded", "failed"), run2

    teammates = client.get("/teammates", headers=AUTH).json()["teammates"]
    personas = {t["persona"] for t in teammates}
    assert {"engineer", "reviewer"} <= personas, personas
    engineer = next(t for t in teammates if t["persona"] == "engineer")
    # The created bot carries a model, so it can actually run delegated work.
    assert engineer["provider_id"] == provider_id

    # --- Run 3: the CEO delegates the coding work to the engineer ----------
    harness.script(
        [
            _msg(
                "",
                [
                    _call(
                        "d1",
                        "delegate_task",
                        {
                            "to_teammate_id": engineer["id"],
                            "description": "Implement login endpoint",
                            "scope": "backend/routes/login only",
                            "context": "the API skeleton already exists in the repo",
                            "command": "git status > evidence.txt && echo implemented-login",
                            "reason": "coding specialist",
                        },
                    )
                ],
            ),
            _msg("", [_call("d2", "check_delegations", {})]),
            _msg("Delegated to the engineering bot; waiting for its acceptance."),
        ]
    )
    run3 = client.post(f"/tasks/{task['id']}/retry", json={}, headers=AUTH).json()
    assert run3["run"]["status"] in ("succeeded", "failed"), run3

    # A real child task was created by the CEO's delegation, and the
    # delegation is PENDING — it is not assumed to be accepted.
    view = client.get(f"/tasks/{task['id']}", headers=AUTH).json()
    child_ids = [c["id"] for c in view["children"]]
    assert child_ids, "CEO delegation must create a real child task"
    child = client.get(f"/tasks/{child_ids[0]}", headers=AUTH).json()
    assert child["task"]["owner_teammate_id"] == engineer["id"]
    assert child["task"]["parent_task_id"] == task["id"]

    delegations = client.get(f"/tasks/{task['id']}/delegations", headers=AUTH).json()["delegations"]
    assert delegations and delegations[0]["child_task_id"] in child_ids
    assert delegations[0]["status"] == "pending"
    assert delegations[0]["scope"] == "backend/routes/login only"

    # --- The delegated bot DECIDES, then does the work --------------------
    # The engineer's model accepts the delegation first (the accept tool is
    # ambient, so the delegatee always sees it), then executes the task.
    harness.script(
        [
            _msg("", [_call("a1", "respond_to_delegation", {"decision": "accepted"})]),
            _msg("accepted the delegated work and implemented the login endpoint"),
        ]
    )
    child_run = client.post(f"/tasks/{child_ids[0]}/runs", json={}, headers=AUTH).json()
    assert child_run["run"]["status"] == "succeeded", child_run
    # Isolated workspace + real artifacts.
    files = client.get(f"/tasks/{child_ids[0]}/workspace/files", headers=AUTH)
    assert files.status_code == 200
    child_view = client.get(f"/tasks/{child_ids[0]}", headers=AUTH).json()
    assert child_view["task"]["status"] == "done"
    assert child_view["artifacts"], "child execution must persist artifacts"
    assert child_view["task"]["workspace_path"]

    # Result flowed back through the delegation record (response channel).
    refreshed = client.get(f"/tasks/{task['id']}/delegations", headers=AUTH).json()["delegations"]
    assert refreshed[0]["status"] == "completed"
    assert refreshed[0].get("result"), "delegation must carry the child result"
    assert "accepted the delegated work" in refreshed[0]["result"]

    # --- Run 4: the CEO reads the real result and reports it ---------------
    harness.script(
        [
            _msg("", [_call("r1", "check_delegations", {})]),
            _msg("Final report: login implemented by the engineering bot."),
        ]
    )
    run4 = client.post(f"/tasks/{task['id']}/retry", json={}, headers=AUTH).json()
    assert run4["run"]["status"] in ("succeeded", "failed"), run4
    delegator_calls = [name for name, _ in harness.tool_results]
    assert delegator_calls[-1] == "check_delegations"
    final_tool_result = harness.tool_results[-1][1]
    assert "completed" in final_tool_result
    assert "accepted the delegated work" in final_tool_result


def test_owner_simple_path_no_ceo(client, monkeypatch) -> None:
    """The simpler path: create a teammate, assign a task, inspect the work."""
    pid, provider_id = _project_with_provider(client)
    harness = FleetHarness(monkeypatch)
    mate = client.post(
        f"/projects/{pid}/teammates",
        json={"persona": "assistant", "instructions": "help", "permissions": [], "provider_id": provider_id},
        headers=AUTH,
    ).json()
    task = client.post(
        f"/projects/{pid}/tasks",
        json={
            "description": "Run the smoke check",
            "command": "echo hello",
            "owner_teammate_id": mate["id"],
        },
        headers=AUTH,
    ).json()
    harness.script([_msg("smoke check complete")])
    run = client.post(f"/tasks/{task['id']}/runs", json={}, headers=AUTH).json()
    assert run["run"]["status"] == "succeeded"
    view = client.get(f"/tasks/{task['id']}", headers=AUTH).json()
    assert view["task"]["status"] == "done"
    assert view["runs"], "run history must persist"
    files = client.get(f"/tasks/{task['id']}/workspace/files", headers=AUTH)
    assert files.status_code == 200
