"""The safety properties of the approval workflow.

Four things have to hold when the process misbehaves, and each is pinned
here:

1. **Crash consistency.** A process can die at any point around the
   action. Whatever it leaves behind must be recoverable, and the action
   must never be performed twice.
2. **Concurrent decisions.** Two decisions arriving at the same instant
   must not both carry the action out, and a batch answered at once must
   not lose one of its actions.
3. **Digest integrity.** The resumed call must be the one that was asked
   for, even if the checkpoint was altered.
4. **Authorisation.** The cross-workspace inbox must not list another
   owner's requests, and every mutating route must check ownership.

The provider here is a scripted HTTP server on localhost, so the whole
agent loop runs for real.
"""

from __future__ import annotations

import json
import os
import sqlite3
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer
from typing import Any

import pytest
from fastapi.testclient import TestClient

from nerdbot import approval_flow, store
from nerdbot.api import create_app
from nerdbot.models import Decision

TOKEN = "approval-safety-token"
AUTH = {"Authorization": f"Bearer {TOKEN}"}


# -- a scripted provider on localhost ---------------------------------------


class _ScriptedProvider:
    def __init__(self, script: list[dict[str, Any]]) -> None:
        self.script = script
        self._server = HTTPServer(("127.0.0.1", 0), self._make_handler())
        threading.Thread(target=self._server.serve_forever, daemon=True).start()

    @property
    def base_url(self) -> str:
        host, port = self._server.server_address[:2]
        return f"http://{host}:{port}/v1"

    def close(self) -> None:
        self._server.shutdown()
        self._server.server_close()

    def _make_handler(self):  # type: ignore[no-untyped-def]
        outer = self

        class Handler(BaseHTTPRequestHandler):
            def do_POST(self) -> None:  # noqa: N802
                length = int(self.headers.get("Content-Length") or 0)
                json.loads(self.rfile.read(length) or b"{}")
                body = json.dumps(outer.script[0]).encode()
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def log_message(self, *args: Any) -> None:
                return

        return Handler


def _answer(content: str | None = None, calls: list[dict[str, Any]] | None = None) -> dict:
    message: dict[str, Any] = {"role": "assistant", "content": content}
    if calls is not None:
        message["tool_calls"] = calls
    return {"choices": [{"message": message}]}


def _call(call_id: str, name: str, arguments: dict[str, Any]) -> dict[str, Any]:
    return {
        "id": call_id,
        "type": "function",
        "function": {"name": name, "arguments": json.dumps(arguments)},
    }


# -- fixtures ---------------------------------------------------------------


@pytest.fixture()
def client(tmp_path, monkeypatch):
    from cryptography.fernet import Fernet

    monkeypatch.setenv("NERDBOT_TOKEN", TOKEN)
    monkeypatch.setenv("NERDBOT_SECRET_KEY", Fernet.generate_key().decode("ascii"))
    monkeypatch.setenv("NERDBOT_DB", str(tmp_path / "safety.db"))
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
    persona: str = "engineer",
    permissions: list[str] | None = None,
) -> tuple[str, str]:
    project = client.post("/projects", json={"repository": "r"}, headers=AUTH).json()["id"]
    prov = client.post(
        f"/projects/{project}/providers",
        json={
            "kind": "openai-compatible",
            "name": "scripted",
            "config": {
                "base_url": provider.base_url,
                "model": "scripted",
                "api_key": "sk-test",
                "max_turns": 2,
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
    )
    assert bot.status_code == 200, bot.text
    return project, bot.json()["id"]


def _task(client: TestClient, project: str, bot: str) -> str:
    r = client.post(
        f"/projects/{project}/tasks",
        json={
            "description": "make a teammate",
            "command": "make a teammate",
            "owner_teammate_id": bot,
        },
        headers=AUTH,
    )
    assert r.status_code == 200, r.text
    return r.json()["id"]


def _conn() -> sqlite3.Connection:
    return store.connect(os.environ["NERDBOT_DB"])


def _pending_approval(client: TestClient) -> dict[str, Any]:
    items = client.get("/approvals", params={"state": "pending"}, headers=AUTH).json()[
        "approvals"
    ]
    assert len(items) == 1, items
    return items[0]


# -- 1. crash consistency ---------------------------------------------------


def test_a_crash_after_the_decision_is_recovered_by_the_sweep(
    client: TestClient, provider: _ScriptedProvider
) -> None:
    """The decision landed, the process died before the action ran.

    The action has NOT happened, so the recovery must carry it out. Nothing
    else will: nobody is going to press "approve" again.
    """
    provider.script = [
        _answer("", [_call("c1", "create_teammate", {"persona": "engineer"})]),
        _answer("done"),
    ]
    project, bot = _setup(client, provider)
    task = _task(client, project, bot)
    client.post(f"/tasks/{task}/runs", headers=AUTH)
    item = _pending_approval(client)

    # The decision lands, and the process dies right there.
    conn = _conn()
    try:
        store.decide_approval(conn, item["id"], Decision.APPROVED)
    finally:
        conn.close()

    mates = client.get(f"/projects/{project}/teammates", headers=AUTH).json()["teammates"]
    assert [m["persona"] for m in mates] == ["ceo"], mates

    # The sweep finds the decision nobody carried out, and carries it out.
    swept = client.post("/approvals/sweep", headers=AUTH)
    assert swept.status_code == 200, swept.text
    assert swept.json()["recovered"], swept.text

    mates = client.get(f"/projects/{project}/teammates", headers=AUTH).json()["teammates"]
    assert [m["persona"] for m in mates] == ["ceo", "engineer"], mates
    view = client.get(f"/tasks/{task}", headers=AUTH).json()
    assert view["task"]["status"] == "done", view["task"]


def test_a_crash_after_the_claim_loses_the_action_and_does_not_repeat_it(
    client: TestClient, provider: _ScriptedProvider
) -> None:
    """The action was claimed, the process died before it ran.

    At-most-once means the action is LOST here: it is not repeated, because
    repeating a privileged action is worse than losing it. The recovery says
    so in as many words, and leaves the work recoverable.
    """
    provider.script = [
        _answer("", [_call("c1", "create_teammate", {"persona": "engineer"})]),
        _answer("done"),
    ]
    project, bot = _setup(client, provider)
    task = _task(client, project, bot)
    client.post(f"/tasks/{task}/runs", headers=AUTH)
    item = _pending_approval(client)

    # The decision lands, the claim lands, and the process dies before the
    # action.
    conn = _conn()
    try:
        store.decide_approval(conn, item["id"], Decision.APPROVED)
        store.mark_approval_resumed(conn, item["id"])
    finally:
        conn.close()

    swept = client.post("/approvals/sweep", headers=AUTH)
    assert swept.status_code == 200, swept.text

    # The action was NOT performed, and the recovery did not try.
    mates = client.get(f"/projects/{project}/teammates", headers=AUTH).json()["teammates"]
    assert [m["persona"] for m in mates] == ["ceo"], mates

    view = client.get(f"/tasks/{task}", headers=AUTH).json()
    assert view["task"]["status"] == "blocked", view["task"]
    assert "not repeated" in view["task"]["blocked_reason"], view["task"]

    # And a second sweep does not perform it either.
    client.post("/approvals/sweep", headers=AUTH)
    mates = client.get(f"/projects/{project}/teammates", headers=AUTH).json()["teammates"]
    assert [m["persona"] for m in mates] == ["ceo"], mates


def test_a_crash_after_the_action_settles_the_run(
    client: TestClient, provider: _ScriptedProvider
) -> None:
    """The action ran, the process died before the run was settled.

    The checkpoint says the action was performed, so the recovery settles
    the run as done rather than reporting a loss.
    """
    provider.script = [
        _answer("", [_call("c1", "create_teammate", {"persona": "engineer"})]),
        _answer("done"),
    ]
    project, bot = _setup(client, provider)
    task = _task(client, project, bot)
    client.post(f"/tasks/{task}/runs", headers=AUTH)
    item = _pending_approval(client)

    # The action runs, its outcome is recorded, and the run is never settled.
    conn = _conn()
    try:
        store.decide_approval(conn, item["id"], Decision.APPROVED)
        store.mark_approval_resumed(conn, item["id"])
        store.record_approval_resume_result(conn, item["id"], "performed")
    finally:
        conn.close()

    # Nothing settled it: the run is still waiting.
    view = client.get(f"/tasks/{task}", headers=AUTH).json()
    assert view["task"]["status"] == "awaiting_approval", view["task"]

    swept = client.post("/approvals/sweep", headers=AUTH)
    assert swept.status_code == 200, swept.text
    view = client.get(f"/tasks/{task}", headers=AUTH).json()
    assert view["task"]["status"] == "done", view["task"]


def test_a_crash_during_the_decision_leaves_the_request_decidable(
    client: TestClient, provider: _ScriptedProvider
) -> None:
    """A decision that was never written leaves the request exactly as it
    was: pending, and decidable."""
    provider.script = [
        _answer("", [_call("c1", "create_teammate", {"persona": "engineer"})]),
        _answer("done"),
    ]
    project, bot = _setup(client, provider)
    task = _task(client, project, bot)
    client.post(f"/tasks/{task}/runs", headers=AUTH)
    item = _pending_approval(client)

    # Nothing was written: the request is untouched.
    swept = client.post("/approvals/sweep", headers=AUTH)
    assert swept.status_code == 200, swept.text
    assert swept.json()["count"] == 0, swept.text
    still = _pending_approval(client)
    assert still["id"] == item["id"]
    mates = client.get(f"/projects/{project}/teammates", headers=AUTH).json()["teammates"]
    assert [m["persona"] for m in mates] == ["ceo"], mates


# -- 2. concurrent decisions ------------------------------------------------


def test_two_decisions_at_once_carry_the_action_out_once(
    client: TestClient, provider: _ScriptedProvider
) -> None:
    """Two requests for the same approval, at the same instant.

    The claim is a conditional UPDATE, so only one of them performs the
    action. The other is told the run is no longer waiting — and it does not
    perform anything.
    """
    provider.script = [
        _answer("", [_call("c1", "create_teammate", {"persona": "engineer"})]),
        _answer("done"),
    ]
    project, bot = _setup(client, provider)
    task = _task(client, project, bot)
    client.post(f"/tasks/{task}/runs", headers=AUTH)
    item = _pending_approval(client)

    results: list[Any] = []
    errors: list[Exception] = []

    def decide() -> None:
        try:
            conn = _conn()
            try:
                store.decide_approval(conn, item["id"], Decision.APPROVED)
                results.append(
                    approval_flow.resume_run(conn, item["id"] and _run_of(item["id"], conn), ".")
                )
            finally:
                conn.close()
        except Exception as exc:  # noqa: BLE001 - the test wants the failure
            errors.append(exc)

    def _run_of(approval_id: str, conn: sqlite3.Connection) -> str:
        row = conn.execute(
            "SELECT run_id FROM approvals WHERE id = ?", (approval_id,)
        ).fetchone()
        return row["run_id"] if row else ""

    threads = [threading.Thread(target=decide) for _ in range(2)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join(timeout=30)

    # Either one won the decision, or both were told the same answer; what
    # must never happen is the action running twice.
    mates = client.get(f"/projects/{project}/teammates", headers=AUTH).json()["teammates"]
    assert [m["persona"] for m in mates].count("engineer") == 1, mates
    assert len(errors) <= 1, errors


def test_a_batch_answered_at_once_loses_no_action(
    client: TestClient, provider: _ScriptedProvider
) -> None:
    """Two requests in one turn, answered at the same instant.

    The claim is per checkpoint, not per run: a run-level claim would let
    one of the two answers perform nothing at all, and the owner would never
    know.
    """
    provider.script = [
        _answer(
            "",
            [
                _call("c1", "create_teammate", {"persona": "engineer"}),
                _call("c2", "create_teammate", {"persona": "reviewer"}),
            ],
        ),
        _answer("done"),
    ]
    project, bot = _setup(client, provider)
    task = _task(client, project, bot)
    client.post(f"/tasks/{task}/runs", headers=AUTH)

    pending = client.get("/approvals", params={"state": "pending"}, headers=AUTH).json()[
        "approvals"
    ]
    assert len(pending) == 2, pending

    errors: list[Exception] = []

    def decide(approval_id: str) -> None:
        try:
            conn = _conn()
            try:
                store.decide_approval(conn, approval_id, Decision.APPROVED)
                row = conn.execute(
                    "SELECT run_id FROM approvals WHERE id = ?", (approval_id,)
                ).fetchone()
                approval_flow.resume_run(conn, row["run_id"], ".")
            finally:
                conn.close()
        except Exception as exc:  # noqa: BLE001 - the test wants the failure
            errors.append(exc)

    threads = [threading.Thread(target=decide, args=(a["id"],)) for a in pending]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join(timeout=30)

    mates = client.get(f"/projects/{project}/teammates", headers=AUTH).json()["teammates"]
    personas = [m["persona"] for m in mates]
    assert personas.count("engineer") == 1, personas
    assert personas.count("reviewer") == 1, personas
    assert not errors, errors


def test_a_second_decision_after_the_run_was_settled_still_performs(
    client: TestClient, provider: _ScriptedProvider
) -> None:
    """A batch answered one at a time.

    The first answer carries its action out and settles the run — and if the
    second request was already answered by then, the run has nothing left to
    wait for. The second answer must still carry its own action out: the
    checkpoints are the truth, the run's status is only a summary of them.
    Dropping it would lose the owner's second "yes" silently.
    """
    provider.script = [
        _answer(
            "",
            [
                _call("c1", "create_teammate", {"persona": "engineer"}),
                _call("c2", "create_teammate", {"persona": "reviewer"}),
            ],
        ),
        _answer("done"),
    ]
    project, bot = _setup(client, provider)
    task = _task(client, project, bot)
    client.post(f"/tasks/{task}/runs", headers=AUTH)

    pending = client.get("/approvals", params={"state": "pending"}, headers=AUTH).json()[
        "approvals"
    ]
    assert len(pending) == 2, pending
    by_persona = {}
    for item in pending:
        conn = _conn()
        try:
            args = json.loads(item["tool_arguments"])
            by_persona[args["persona"]] = item["id"]
        finally:
            conn.close()

    # The owner answers the first one. The run settles: there is nothing
    # left to wait for, because the second request was answered too.
    first = client.post(
        f"/approvals/{by_persona['engineer']}/decision",
        json={"decision": "approved"},
        headers=AUTH,
    )
    assert first.status_code == 200, first.text
    second = client.post(
        f"/approvals/{by_persona['reviewer']}/decision",
        json={"decision": "approved"},
        headers=AUTH,
    )
    assert second.status_code == 200, second.text

    mates = client.get(f"/projects/{project}/teammates", headers=AUTH).json()["teammates"]
    personas = [m["persona"] for m in mates]
    assert personas.count("engineer") == 1, personas
    assert personas.count("reviewer") == 1, personas


# -- 3. digest integrity ----------------------------------------------------


def test_a_checkpoint_whose_action_was_altered_is_not_performed(
    client: TestClient, provider: _ScriptedProvider
) -> None:
    """The binding covers the tool, its canonical arguments, the bot, the run
    and the task. A checkpoint that no longer matches its binding is not
    performed.
    """
    provider.script = [
        _answer("", [_call("c1", "create_teammate", {"persona": "engineer"})]),
        _answer("done"),
    ]
    project, bot = _setup(client, provider)
    task = _task(client, project, bot)
    client.post(f"/tasks/{task}/runs", headers=AUTH)
    item = _pending_approval(client)

    # Somebody rewrites what the request is for.
    conn = _conn()
    try:
        conn.execute(
            "UPDATE approvals SET tool_arguments = ? WHERE id = ?",
            (json.dumps({"persona": "somebody-else"}), item["id"]),
        )
        conn.commit()
    finally:
        conn.close()

    r = client.post(
        f"/approvals/{item['id']}/decision", json={"decision": "approved"}, headers=AUTH
    )
    assert r.status_code == 200, r.text
    assert r.json()["resume"]["outcome"] == "refused", r.text
    mates = client.get(f"/projects/{project}/teammates", headers=AUTH).json()["teammates"]
    assert [m["persona"] for m in mates] == ["ceo"], mates


def test_the_tool_digest_canonicalises_the_arguments() -> None:
    """The same action written two ways is the same action."""
    a = store.tool_digest(
        tool_name="create_teammate",
        arguments=json.dumps({"persona": "x", "permissions": []}),
        teammate_id="tm_1",
        run_id="run_1",
        task_id="tsk_1",
    )
    b = store.tool_digest(
        tool_name="create_teammate",
        arguments=json.dumps({"permissions": [], "persona": "x"}),
        teammate_id="tm_1",
        run_id="run_1",
        task_id="tsk_1",
    )
    assert a == b
    # and a different bot, run or task is a different action
    c = store.tool_digest(
        tool_name="create_teammate",
        arguments=json.dumps({"permissions": [], "persona": "x"}),
        teammate_id="tm_2",
        run_id="run_1",
        task_id="tsk_1",
    )
    assert c != a


# -- 4. authorisation --------------------------------------------------------


def test_the_sweep_ignores_approvals_that_hold_no_action(
    client: TestClient, provider: _ScriptedProvider
) -> None:
    """An approval that was never a checkpoint is not a checkpoint.

    A manually requested run approval — one the owner made for themselves —
    has no tool and no arguments, so there is nothing to carry out. The
    recovery must leave it alone, and must not claim that it carried
    something out.
    """
    conn = _conn()
    try:
        project = store.create_project(conn, "local-owner", "r")
        task = store.create_task(conn, project.id, description="t")
        run = store.create_run(conn, task.id, runtime="local", session=task.id)
        manual = store.request_approval(
            conn,
            action="deploy",
            requester="local-owner",
            run_id=run.id,
            task_id=task.id,
            project_id=project.id,
            ttl_s=600,
        )
        store.decide_approval(conn, manual.id, Decision.APPROVED)
    finally:
        conn.close()

    swept = client.post("/approvals/sweep", headers=AUTH)
    assert swept.status_code == 200, swept.text
    assert swept.json()["recovered"] == [], swept.text

    # And the run it named was not settled as a success.
    conn = _conn()
    try:
        after = store.get_run(conn, run.id)
        assert after is not None
        assert after.status != "succeeded", after
    finally:
        conn.close()


def test_the_inbox_does_not_list_another_owners_requests(
    client: TestClient, provider: _ScriptedProvider
) -> None:
    """The inbox is scoped to the caller's own projects."""
    provider.script = [
        _answer("", [_call("c1", "create_teammate", {"persona": "engineer"})]),
        _answer("done"),
    ]
    project, bot = _setup(client, provider)
    task = _task(client, project, bot)
    client.post(f"/tasks/{task}/runs", headers=AUTH)
    assert len(_pending_approval(client)) >= 1

    # A request belonging to somebody else.
    conn = _conn()
    try:
        other = store.create_project(conn, "somebody-else", "theirs")
        theirs = store.request_approval(
            conn,
            action="teammate.create",
            requester="tm_somebody",
            project_id=other.id,
            ttl_s=600,
        )
    finally:
        conn.close()

    items = client.get("/approvals", params={"state": "pending"}, headers=AUTH).json()[
        "approvals"
    ]
    assert theirs.id not in [i["id"] for i in items], items


def test_deciding_another_owners_request_is_refused(
    client: TestClient, provider: _ScriptedProvider
) -> None:
    conn = _conn()
    try:
        other = store.create_project(conn, "somebody-else", "theirs")
        theirs = store.request_approval(
            conn,
            action="teammate.create",
            requester="tm_somebody",
            project_id=other.id,
            ttl_s=600,
        )
    finally:
        conn.close()

    r = client.post(
        f"/approvals/{theirs.id}/decision", json={"decision": "approved"}, headers=AUTH
    )
    assert r.status_code == 403, r.text


def test_the_sweep_does_not_close_another_owners_requests(
    client: TestClient, provider: _ScriptedProvider
) -> None:
    conn = _conn()
    try:
        other = store.create_project(conn, "somebody-else", "theirs")
        theirs = store.request_approval(
            conn,
            action="teammate.create",
            requester="tm_somebody",
            project_id=other.id,
            ttl_s=600,
        )
        conn.execute(
            "UPDATE approvals SET expires_at = '2000-01-01T00:00:00+00:00' WHERE id = ?",
            (theirs.id,),
        )
        conn.commit()
    finally:
        conn.close()

    swept = client.post("/approvals/sweep", headers=AUTH)
    assert swept.status_code == 200, swept.text
    assert swept.json()["count"] == 0, swept.text

    conn = _conn()
    try:
        after = store.get_approval(conn, theirs.id)
        assert after is not None
        assert after.decision == Decision.PENDING, after
    finally:
        conn.close()


def test_reasking_another_owners_task_is_refused(
    client: TestClient, provider: _ScriptedProvider
) -> None:
    conn = _conn()
    try:
        other = store.create_project(conn, "somebody-else", "theirs")
        mate = store.create_teammate(conn, other.id, persona="theirs")
        task = store.create_task(conn, other.id, description="theirs")
        theirs = store.request_approval(
            conn,
            action="teammate.create",
            requester=mate.id,
            project_id=other.id,
            task_id=task.id,
            ttl_s=600,
        )
    finally:
        conn.close()

    r = client.post(f"/approvals/{theirs.id}/reask", headers=AUTH)
    assert r.status_code == 403, r.text


def test_the_gate_still_refuses_a_bot_that_lost_its_permission(
    client: TestClient, provider: _ScriptedProvider
) -> None:
    """The binding is not a blank cheque: the permission is checked again
    when the action is carried out."""
    provider.script = [
        _answer("", [_call("c1", "create_teammate", {"persona": "engineer"})]),
        _answer("done"),
    ]
    project, bot = _setup(client, provider)
    task = _task(client, project, bot)
    client.post(f"/tasks/{task}/runs", headers=AUTH)
    item = _pending_approval(client)

    client.patch(f"/teammates/{bot}", json={"permissions": []}, headers=AUTH)

    r = client.post(
        f"/approvals/{item['id']}/decision", json={"decision": "approved"}, headers=AUTH
    )
    assert r.status_code == 200, r.text
    assert r.json()["resume"]["outcome"] == "refused", r.text
    mates = client.get(f"/projects/{project}/teammates", headers=AUTH).json()["teammates"]
    assert [m["persona"] for m in mates] == ["ceo"], mates
