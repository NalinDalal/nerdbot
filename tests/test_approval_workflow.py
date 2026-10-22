"""The approval workflow, end to end: a gated call, a decision, and the work.

A bot that asks for a privileged action must not be able to make it happen
by asking. It must be able to WAIT for the owner, and the owner's answer
must actually carry the work out — exactly once, and only for the exact
action that was asked for.

The provider here is a real HTTP server on localhost, scripted to ask for
``create_teammate``. Nothing inside NerdBot is mocked: the request goes
through the API, the agent loop, the gate, the store and the resume.

What is pinned:

- a gated call parks its run and its task, and the approval is visible with
  the whole association (bot, run, task, action, digest);
- approving carries the exact action out, once, and the run says so;
- rejecting and expiring perform nothing and leave the work recoverable;
- a second, identical decision changes nothing and repeats nothing;
- a second, different decision is refused;
- the permission is checked again at the moment of the resume;
- a run never reports success while a request is unresolved;
- a restart loses nothing and duplicates nothing.
"""

from __future__ import annotations

import json
import os
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer
from typing import Any

import pytest
from fastapi.testclient import TestClient

from nerdbot import store
from nerdbot.api import create_app

TOKEN = "approval-flow-token"
AUTH = {"Authorization": f"Bearer {TOKEN}"}


# -- a scripted provider on localhost ---------------------------------------


class _ScriptedProvider:
    """A tiny HTTP server that answers ``/chat/completions`` with a script.

    The first answer asks for a privileged tool call; the rest finish the
    conversation. A real socket, so the whole agent loop runs for real.
    """

    def __init__(self, script: list[dict[str, Any]]) -> None:
        self.script = script
        self.calls: list[dict[str, Any]] = []
        self._index = 0
        self._server = HTTPServer(("127.0.0.1", 0), self._make_handler())
        self._thread = threading.Thread(target=self._server.serve_forever, daemon=True)
        self._thread.start()

    @property
    def base_url(self) -> str:
        host, port = self._server.server_address[:2]
        return f"http://{host}:{port}/v1"

    def _make_handler(self):  # type: ignore[no-untyped-def]
        outer = self

        class Handler(BaseHTTPRequestHandler):
            def do_POST(self) -> None:  # noqa: N802 - http.server's naming
                length = int(self.headers.get("Content-Length") or 0)
                payload = json.loads(self.rfile.read(length) or b"{}")
                outer.calls.append(payload)
                # A conversation that has no assistant turn yet is a new one:
                # the script starts again, which is what a re-run looks like.
                messages = payload.get("messages") or []
                if not any(m.get("role") in ("assistant", "tool") for m in messages):
                    outer._index = 0
                index = min(outer._index, len(outer.script) - 1)
                outer._index += 1
                body = json.dumps(outer.script[index]).encode()
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def log_message(self, *args: Any) -> None:
                return

        return Handler

    def close(self) -> None:
        self._server.shutdown()
        self._server.server_close()


def _tool_call(call_id: str, name: str, arguments: dict[str, Any]) -> dict[str, Any]:
    return {
        "id": call_id,
        "type": "function",
        "function": {"name": name, "arguments": json.dumps(arguments)},
    }


def _answer(content: str | None = None, calls: list[dict[str, Any]] | None = None) -> dict:
    message: dict[str, Any] = {"role": "assistant", "content": content}
    if calls is not None:
        message["tool_calls"] = calls
    return {"choices": [{"message": message}]}


# -- fixtures ---------------------------------------------------------------


@pytest.fixture()
def client(tmp_path, monkeypatch):
    from cryptography.fernet import Fernet

    monkeypatch.setenv("NERDBOT_TOKEN", TOKEN)
    # The provider carries an inline key, which is encrypted at rest.
    monkeypatch.setenv("NERDBOT_SECRET_KEY", Fernet.generate_key().decode("ascii"))
    monkeypatch.setenv("NERDBOT_DB", str(tmp_path / "approvals.db"))
    monkeypatch.setenv("NERDBOT_DATA", str(tmp_path / "data"))
    return TestClient(create_app())


@pytest.fixture()
def provider():
    scripted = _ScriptedProvider([])
    yield scripted
    scripted.close()


def _setup(
    client: TestClient,
    provider: _ScriptedProvider,
    *,
    permissions: list[str] | None = None,
) -> tuple[str, str, str]:
    """A project, a bot that may create teammates, and a provider for it."""
    project = client.post("/projects", json={"repository": "r"}, headers=AUTH).json()["id"]
    prov = client.post(
        f"/projects/{project}/providers",
        json={
            "kind": "openai-compatible",
            "name": "scripted",
            "config": {
                "base_url": provider.base_url,
                "model": "scripted-model",
                "api_key": "sk-test",
                "max_turns": 4,
            },
        },
        headers=AUTH,
    )
    assert prov.status_code == 200, prov.text
    prov_id = prov.json()["id"]
    bot = client.post(
        f"/projects/{project}/teammates",
        json={
            "persona": "ceo",
            "permissions": permissions if permissions is not None else ["teammate.create"],
            "provider_id": prov_id,
        },
        headers=AUTH,
    ).json()["id"]
    return project, bot, prov_id


def _task(client: TestClient, project: str, bot: str, description: str = "make a teammate") -> str:
    return client.post(
        f"/projects/{project}/tasks",
        json={"description": description, "owner_teammate_id": bot, "command": description},
        headers=AUTH,
    ).json()["id"]


def _conn() -> Any:
    return store.connect(os.environ["NERDBOT_DB"])


# -- the flow ----------------------------------------------------------------


def test_a_gated_call_parks_the_run_and_shows_the_request(
    client: TestClient, provider: _ScriptedProvider
) -> None:
    """The run waits, the task waits, and the request is visible with the
    whole association."""
    provider.script = [
        _answer(
            "",
            [
                _tool_call(
                    "c1",
                    "create_teammate",
                    {"persona": "engineer", "instructions": "writes code"},
                )
            ],
        ),
        _answer("done"),
    ]
    project, bot, _ = _setup(client, provider)
    task = _task(client, project, bot)

    r = client.post(f"/tasks/{task}/runs", headers=AUTH)
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["run"]["status"] == "awaiting_approval", body
    assert body["task_status"] == "awaiting_approval", body

    inbox = client.get("/approvals", params={"state": "pending"}, headers=AUTH)
    assert inbox.status_code == 200, inbox.text
    items = inbox.json()["approvals"]
    assert len(items) == 1, items
    item = items[0]
    assert item["action"] == "teammate.create"
    assert item["teammate_id"] == bot
    assert item["run_id"] == body["run"]["id"]
    assert item["task_id"] == task
    assert item["tool_name"] == "create_teammate"
    assert item["digest"]
    assert item["resumable"] is True
    assert item["performed"] is False
    assert item["state"] == "pending"

    # the action has NOT happened
    mates = client.get(f"/projects/{project}/teammates", headers=AUTH).json()["teammates"]
    assert [m["persona"] for m in mates] == ["ceo"]


def test_approving_carries_the_exact_action_out_once(
    client: TestClient, provider: _ScriptedProvider
) -> None:
    """The owner's yes does the work — and only that work."""
    provider.script = [
        _answer("", [_tool_call("c1", "create_teammate", {"persona": "engineer"})]),
        _answer("done"),
    ]
    project, bot, _ = _setup(client, provider)
    task = _task(client, project, bot)
    run = client.post(f"/tasks/{task}/runs", headers=AUTH).json()["run"]

    inbox = client.get("/approvals", params={"state": "pending"}, headers=AUTH).json()
    approval_id = inbox["approvals"][0]["id"]

    r = client.post(
        f"/approvals/{approval_id}/decision", json={"decision": "approved"}, headers=AUTH
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["decision"] == "approved"
    assert body["resume"]["outcome"] == "carried_out", body
    assert body["resume"]["run_status"] == "succeeded"

    # the action happened, exactly once
    mates = client.get(f"/projects/{project}/teammates", headers=AUTH).json()["teammates"]
    created = [m for m in mates if m["persona"] == "engineer"]
    assert len(created) == 1, mates

    # the run says what it did
    view = client.get(f"/tasks/{task}", headers=AUTH).json()
    assert view["task"]["status"] == "done", view["task"]
    runs = client.get(f"/projects/{project}/runs", headers=AUTH).json()["runs"]
    the_run = [x for x in runs if x["id"] == run["id"]][0]
    assert the_run["status"] == "succeeded"
    assert "engineer" in the_run["output_excerpt"]


def test_the_same_decision_twice_does_not_repeat_the_action(
    client: TestClient, provider: _ScriptedProvider
) -> None:
    """Deciding is idempotent: the same answer twice is the same answer."""
    provider.script = [
        _answer("", [_tool_call("c1", "create_teammate", {"persona": "engineer"})]),
        _answer("done"),
    ]
    project, bot, _ = _setup(client, provider)
    task = _task(client, project, bot)
    client.post(f"/tasks/{task}/runs", headers=AUTH)
    approval_id = client.get("/approvals", params={"state": "pending"}, headers=AUTH).json()[
        "approvals"
    ][0]["id"]

    first = client.post(
        f"/approvals/{approval_id}/decision", json={"decision": "approved"}, headers=AUTH
    )
    assert first.status_code == 200, first.text
    second = client.post(
        f"/approvals/{approval_id}/decision", json={"decision": "approved"}, headers=AUTH
    )
    assert second.status_code == 200, second.text
    assert second.json()["idempotent"] is True

    mates = client.get(f"/projects/{project}/teammates", headers=AUTH).json()["teammates"]
    assert len([m for m in mates if m["persona"] == "engineer"]) == 1, mates


def test_a_different_decision_is_refused(client: TestClient, provider: _ScriptedProvider) -> None:
    provider.script = [
        _answer("", [_tool_call("c1", "create_teammate", {"persona": "engineer"})]),
        _answer("done"),
    ]
    project, bot, _ = _setup(client, provider)
    task = _task(client, project, bot)
    client.post(f"/tasks/{task}/runs", headers=AUTH)
    approval_id = client.get("/approvals", params={"state": "pending"}, headers=AUTH).json()[
        "approvals"
    ][0]["id"]

    client.post(
        f"/approvals/{approval_id}/decision", json={"decision": "approved"}, headers=AUTH
    )
    other = client.post(
        f"/approvals/{approval_id}/decision", json={"decision": "denied"}, headers=AUTH
    )
    assert other.status_code == 409, other.text


def test_rejecting_performs_nothing_and_leaves_the_work_recoverable(
    client: TestClient, provider: _ScriptedProvider
) -> None:
    provider.script = [
        _answer("", [_tool_call("c1", "create_teammate", {"persona": "engineer"})]),
        _answer("done"),
    ]
    project, bot, _ = _setup(client, provider)
    task = _task(client, project, bot)
    client.post(f"/tasks/{task}/runs", headers=AUTH)
    approval_id = client.get("/approvals", params={"state": "pending"}, headers=AUTH).json()[
        "approvals"
    ][0]["id"]

    r = client.post(
        f"/approvals/{approval_id}/decision", json={"decision": "denied"}, headers=AUTH
    )
    assert r.status_code == 200, r.text
    assert r.json()["resume"]["outcome"] == "refused"

    mates = client.get(f"/projects/{project}/teammates", headers=AUTH).json()["teammates"]
    assert [m["persona"] for m in mates] == ["ceo"], mates

    view = client.get(f"/tasks/{task}", headers=AUTH).json()
    assert view["task"]["status"] == "blocked", view["task"]
    assert "refused" in view["task"]["blocked_reason"]


def test_an_expired_request_performs_nothing_and_can_be_asked_again(
    client: TestClient, provider: _ScriptedProvider
) -> None:
    """A request nobody answered dies visibly, and the work is recoverable."""
    provider.script = [
        _answer("", [_tool_call("c1", "create_teammate", {"persona": "engineer"})]),
        _answer("done"),
    ]
    project, bot, _ = _setup(client, provider)
    task = _task(client, project, bot)
    client.post(f"/tasks/{task}/runs", headers=AUTH)
    approval_id = client.get("/approvals", params={"state": "pending"}, headers=AUTH).json()[
        "approvals"
    ][0]["id"]

    # the request's time is up
    conn = _conn()
    try:
        conn.execute(
            "UPDATE approvals SET expires_at = '2000-01-01T00:00:00+00:00' WHERE id = ?",
            (approval_id,),
        )
        conn.commit()
    finally:
        conn.close()

    # it is no longer pending — it is expired, and it is visible as such
    pending = client.get("/approvals", params={"state": "pending"}, headers=AUTH).json()
    assert approval_id not in [a["id"] for a in pending["approvals"]]
    expired = client.get("/approvals", params={"state": "expired"}, headers=AUTH).json()
    assert approval_id in [a["id"] for a in expired["approvals"]]
    assert expired["approvals"][0]["state"] == "expired"

    # deciding it is refused: the window is closed
    late = client.post(
        f"/approvals/{approval_id}/decision", json={"decision": "approved"}, headers=AUTH
    )
    assert late.status_code == 410, late.text

    # the sweep closes the work: nothing was performed, and it is recoverable
    swept = client.post("/approvals/sweep", headers=AUTH)
    assert swept.status_code == 200, swept.text
    assert swept.json()["count"] == 1, swept.text
    mates = client.get(f"/projects/{project}/teammates", headers=AUTH).json()["teammates"]
    assert [m["persona"] for m in mates] == ["ceo"], mates
    view = client.get(f"/tasks/{task}", headers=AUTH).json()
    assert view["task"]["status"] == "blocked", view["task"]
    assert "expired" in view["task"]["blocked_reason"]

    # and the owner can ask again: a new run, a fresh request
    provider.script = [
        _answer("", [_tool_call("c1", "create_teammate", {"persona": "engineer"})]),
        _answer("done"),
    ]
    reask = client.post(f"/approvals/{approval_id}/reask", headers=AUTH)
    assert reask.status_code == 200, reask.text
    assert reask.json()["run"]["status"] == "awaiting_approval", reask.text
    assert client.get("/approvals", params={"state": "pending"}, headers=AUTH).json()[
        "approvals"
    ]


def test_no_run_reports_success_while_a_request_is_unresolved(
    client: TestClient, provider: _ScriptedProvider
) -> None:
    """The bug this fixes: the run used to end "succeeded" while the action
    it asked for had never happened."""
    provider.script = [
        _answer("", [_tool_call("c1", "create_teammate", {"persona": "engineer"})]),
        _answer("done"),
    ]
    project, bot, _ = _setup(client, provider)
    task = _task(client, project, bot)
    body = client.post(f"/tasks/{task}/runs", headers=AUTH).json()
    runs = client.get(f"/projects/{project}/runs", headers=AUTH).json()["runs"]
    the_run = [x for x in runs if x["id"] == body["run"]["id"]][0]
    assert the_run["status"] != "succeeded"
    assert the_run["status"] == "awaiting_approval"
    assert the_run["exit_code"] is None


def test_the_permission_is_checked_again_when_the_action_carries_out(
    client: TestClient, provider: _ScriptedProvider
) -> None:
    """A bot that lost its permission between the request and the answer
    cannot act — the resume is not a blank cheque."""
    provider.script = [
        _answer("", [_tool_call("c1", "create_teammate", {"persona": "engineer"})]),
        _answer("done"),
    ]
    project, bot, _ = _setup(client, provider)
    task = _task(client, project, bot)
    client.post(f"/tasks/{task}/runs", headers=AUTH)
    approval_id = client.get("/approvals", params={"state": "pending"}, headers=AUTH).json()[
        "approvals"
    ][0]["id"]

    # the bot loses the permission while the owner is deciding
    client.patch(f"/teammates/{bot}", json={"permissions": []}, headers=AUTH)

    r = client.post(
        f"/approvals/{approval_id}/decision", json={"decision": "approved"}, headers=AUTH
    )
    assert r.status_code == 200, r.text
    assert r.json()["resume"]["outcome"] == "refused", r.text
    mates = client.get(f"/projects/{project}/teammates", headers=AUTH).json()["teammates"]
    assert [m["persona"] for m in mates] == ["ceo"], mates


def test_a_restart_loses_nothing_and_duplicates_nothing(
    client: TestClient, provider: _ScriptedProvider
) -> None:
    """The request and its action are on disk, so a restart changes
    nothing."""
    provider.script = [
        _answer("", [_tool_call("c1", "create_teammate", {"persona": "engineer"})]),
        _answer("done"),
    ]
    project, bot, _ = _setup(client, provider)
    task = _task(client, project, bot)
    client.post(f"/tasks/{task}/runs", headers=AUTH)

    # the server restarts: a new app, the same database
    restarted = TestClient(create_app())
    inbox = restarted.get("/approvals", params={"state": "pending"}, headers=AUTH)
    assert inbox.status_code == 200, inbox.text
    items = inbox.json()["approvals"]
    assert len(items) == 1, items
    assert items[0]["tool_name"] == "create_teammate"
    assert items[0]["task_id"] == task

    # and the decision still carries the work out, once
    approval_id = items[0]["id"]
    r = restarted.post(
        f"/approvals/{approval_id}/decision", json={"decision": "approved"}, headers=AUTH
    )
    assert r.status_code == 200, r.text
    assert r.json()["resume"]["outcome"] == "carried_out"
    mates = restarted.get(f"/projects/{project}/teammates", headers=AUTH).json()["teammates"]
    assert len([m for m in mates if m["persona"] == "engineer"]) == 1, mates


def test_the_inbox_filters_and_deduplicates(client: TestClient, provider: _ScriptedProvider) -> None:
    """One row per action, and the filters are safe."""
    provider.script = [
        _answer("", [_tool_call("c1", "create_teammate", {"persona": "engineer"})]),
        _answer("done"),
    ]
    project, bot, _ = _setup(client, provider)
    task = _task(client, project, bot)
    client.post(f"/tasks/{task}/runs", headers=AUTH)

    pending = client.get("/approvals", params={"state": "pending"}, headers=AUTH).json()
    assert len(pending["approvals"]) == 1

    # filtered by the task that asked
    by_task = client.get(
        "/approvals", params={"state": "pending", "task_id": task}, headers=AUTH
    ).json()
    assert len(by_task["approvals"]) == 1
    other = client.get(
        "/approvals", params={"state": "pending", "task_id": "tsk_nope"}, headers=AUTH
    ).json()
    assert other["approvals"] == []

    # filtered by the bot that asked
    by_bot = client.get(
        "/approvals", params={"state": "pending", "teammate_id": bot}, headers=AUTH
    ).json()
    assert len(by_bot["approvals"]) == 1

    # an unknown state is refused, not guessed
    bad = client.get("/approvals", params={"state": "nonsense"}, headers=AUTH)
    assert bad.status_code == 400, bad.text


def test_a_duplicate_request_reuses_the_pending_approval(
    client: TestClient, provider: _ScriptedProvider
) -> None:
    """The same action asked twice is one request, not two — the owner
    decides it once."""
    provider.script = [
        _answer("", [_tool_call("c1", "create_teammate", {"persona": "engineer"})]),
        _answer("done"),
    ]
    project, bot, _ = _setup(client, provider)
    task = _task(client, project, bot)
    client.post(f"/tasks/{task}/runs", headers=AUTH)

    # the same action, asked again by hand
    conn = _conn()
    try:
        mate = store.get_teammate(conn, bot)
        assert mate is not None
        from nerdbot import gates

        # the payload the gate binds: the action, not the whole tool call
        payload = {
            "project_id": project,
            "persona": "engineer",
            "permissions": [],
            "provider_id": "",
        }
        digest = gates.action_digest("teammate.create", payload)
        with pytest.raises(gates.GateApprovalRequired) as exc_info:
            gates.require(conn, mate, "teammate.create", payload=payload)
        # the request that is already waiting is the one that comes back
        assert exc_info.value.approval.digest == digest
    finally:
        conn.close()

    items = client.get("/approvals", params={"state": "pending"}, headers=AUTH).json()[
        "approvals"
    ]
    assert len(items) == 1, items
