"""A blocked task says why it is blocked.

A task blocked because its model provider has no working key used to show a
bare "blocked" status, with the reason buried in the run log. The owner
looking at the Command Center saw a blocked count and no explanation. The
reason now lives on the task, so the UI can say it out loud, and it is
cleared when the task leaves the blocked state.
"""

from __future__ import annotations

import os

import pytest
from fastapi.testclient import TestClient

from nerdbot import store
from nerdbot.api import create_app
from nerdbot.models import TaskStatus

TOKEN = "blocked-reason-token"
AUTH = {"Authorization": f"Bearer {TOKEN}"}


@pytest.fixture()
def client(tmp_path, monkeypatch):
    monkeypatch.setenv("NERDBOT_TOKEN", TOKEN)
    monkeypatch.setenv("NERDBOT_DB", str(tmp_path / "blocked.db"))
    monkeypatch.setenv("NERDBOT_DATA", str(tmp_path / "data"))
    return TestClient(create_app())


def _project(client: TestClient) -> str:
    return client.post("/projects", json={"repository": "r"}, headers=AUTH).json()["id"]


def _bot_with_unconfigured_provider(client: TestClient, pid: str) -> tuple[str, str]:
    """A bot whose openai-compatible provider has no base_url or key."""
    provider = client.post(
        f"/projects/{pid}/providers",
        json={"kind": "openai-compatible", "name": "groq", "config": {}},
        headers=AUTH,
    )
    assert provider.status_code == 200, provider.text
    provider_id = provider.json()["id"]
    bot = client.post(
        f"/projects/{pid}/teammates",
        json={"persona": "worker", "provider_id": provider_id},
        headers=AUTH,
    )
    assert bot.status_code == 200, bot.text
    return bot.json()["id"], provider_id


def test_a_blocked_task_records_why(client) -> None:
    """Running a task whose provider has no key blocks it with a reason."""
    pid = _project(client)
    bot_id, _ = _bot_with_unconfigured_provider(client, pid)
    task = client.post(
        f"/projects/{pid}/tasks",
        json={"description": "needs a model", "owner_teammate_id": bot_id},
        headers=AUTH,
    )
    assert task.status_code == 200, task.text
    task_id = task.json()["id"]

    run = client.post(f"/tasks/{task_id}/runs", headers=AUTH)
    assert run.status_code == 200, run.text

    view = client.get(f"/projects/{pid}/tasks", headers=AUTH).json()["tasks"]
    blocked = next(t for t in view if t["id"] == task_id)
    assert blocked["status"] == "blocked", blocked
    assert blocked["blocked_reason"], "the blocked task does not say why"
    assert "provider" in blocked["blocked_reason"], blocked["blocked_reason"]


def test_the_reason_survives_a_round_trip_through_the_api(client) -> None:
    """The reason is part of the task, not only the run log."""
    pid = _project(client)
    bot_id, _ = _bot_with_unconfigured_provider(client, pid)
    task_id = client.post(
        f"/projects/{pid}/tasks",
        json={"description": "needs a model", "owner_teammate_id": bot_id},
        headers=AUTH,
    ).json()["id"]
    client.post(f"/tasks/{task_id}/runs", headers=AUTH)

    single = client.get(f"/tasks/{task_id}", headers=AUTH).json()
    assert single["task"]["blocked_reason"], single


def test_leaving_the_blocked_state_clears_the_reason(client) -> None:
    """A stale reason must not linger on a task that is running again."""
    pid = _project(client)
    bot_id, _ = _bot_with_unconfigured_provider(client, pid)
    task_id = client.post(
        f"/projects/{pid}/tasks",
        json={"description": "needs a model", "owner_teammate_id": bot_id},
        headers=AUTH,
    ).json()["id"]
    client.post(f"/tasks/{task_id}/runs", headers=AUTH)

    conn = store.connect(os.environ["NERDBOT_DB"])
    try:
        task = store.get_task(conn, task_id)
        assert task is not None and task.blocked_reason, "no reason was recorded"
        store.set_task_status(conn, task_id, TaskStatus.PENDING)
        refreshed = store.get_task(conn, task_id)
        assert refreshed is not None
        assert refreshed.blocked_reason == "", (
            f"the stale reason survived: {refreshed.blocked_reason!r}"
        )
    finally:
        conn.close()


def test_a_task_that_is_not_blocked_has_no_reason(client) -> None:
    pid = _project(client)
    task_id = client.post(
        f"/projects/{pid}/tasks",
        json={"description": "fine"},
        headers=AUTH,
    ).json()["id"]
    view = client.get(f"/projects/{pid}/tasks", headers=AUTH).json()["tasks"]
    fresh = next(t for t in view if t["id"] == task_id)
    assert fresh["blocked_reason"] == ""
