"""The sweep must not claim work a provider cannot run.

A teammate whose model connection has no working key cannot serve a run.
The executor used to check only that a provider existed, so every sweep
claimed the task, ran it, and blocked it. The blocked count climbed and
nothing told the owner why.

Now a provider that cannot serve makes its bot unavailable, the task stays
pending, and the sweep says why it skipped.
"""

from __future__ import annotations

import os

import pytest
from fastapi.testclient import TestClient

from nerdbot import executor, store
from nerdbot.api import create_app

TOKEN = "sweep-provider-token"
AUTH = {"Authorization": f"Bearer {TOKEN}"}


@pytest.fixture()
def client(tmp_path, monkeypatch):
    monkeypatch.setenv("NERDBOT_TOKEN", TOKEN)
    monkeypatch.setenv("NERDBOT_DB", str(tmp_path / "sweep.db"))
    monkeypatch.setenv("NERDBOT_DATA", str(tmp_path / "data"))
    return TestClient(create_app())


def _project(client: TestClient) -> str:
    return client.post("/projects", json={"repository": "r"}, headers=AUTH).json()["id"]


def _unconfigured_provider(client: TestClient, pid: str) -> str:
    """A provider with a base url but no key: it cannot serve a run."""
    provider = client.post(
        f"/projects/{pid}/providers",
        json={
            "kind": "openai-compatible",
            "name": "groq",
            "config": {"base_url": "https://api.groq.com/openai/v1", "model": "m"},
        },
        headers=AUTH,
    )
    assert provider.status_code == 200, provider.text
    return provider.json()["id"]


def _bot_with(client: TestClient, pid: str, provider_id: str) -> str:
    bot = client.post(
        f"/projects/{pid}/teammates",
        json={"persona": "worker", "provider_id": provider_id},
        headers=AUTH,
    )
    assert bot.status_code == 200, bot.text
    return bot.json()["id"]


def test_sweep_does_not_claim_a_task_for_an_unusable_provider(client) -> None:
    """The task stays pending, and the sweep says why."""
    pid = _project(client)
    provider_id = _unconfigured_provider(client, pid)
    _bot_with(client, pid, provider_id)
    task = client.post(
        f"/projects/{pid}/tasks",
        json={"description": "needs a model"},
        headers=AUTH,
    )
    assert task.status_code == 200, task.text
    task_id = task.json()["id"]

    conn = store.connect(os.environ["NERDBOT_DB"])
    try:
        results = executor.sweep(conn, data_dir=os.environ["NERDBOT_DATA"])
        task_row = store.get_task(conn, task_id)
        assert task_row is not None
        assert task_row.status.value == "pending", (
            f"the task was claimed and blocked: {task_row.status.value}"
        )
        assert task_row.owner_teammate_id is None, "the task was claimed"
    finally:
        conn.close()

    skipped = [r for r in results if r.get("task_id") == task_id]
    assert skipped, f"the sweep did not report the skip: {results}"
    assert skipped[0]["status"] == "skipped"
    assert "provider" in skipped[0]["reason"], skipped[0]


def test_sweep_still_claims_when_the_provider_can_serve(client) -> None:
    """A mock provider works, so the sweep must not be blocked by this rule."""
    pid = _project(client)
    provider = client.post(
        f"/projects/{pid}/providers",
        json={"kind": "mock", "name": "mock"},
        headers=AUTH,
    )
    assert provider.status_code == 200, provider.text
    _bot_with(client, pid, provider.json()["id"])
    task = client.post(
        f"/projects/{pid}/tasks",
        json={"description": "runs fine"},
        headers=AUTH,
    )
    assert task.status_code == 200, task.text
    task_id = task.json()["id"]

    conn = store.connect(os.environ["NERDBOT_DB"])
    try:
        results = executor.sweep(conn, data_dir=os.environ["NERDBOT_DATA"])
        task_row = store.get_task(conn, task_id)
        assert task_row is not None
        assert task_row.status.value != "blocked", task_row.status.value
        assert not [r for r in results if r.get("task_id") == task_id and r.get("status") == "skipped"]
    finally:
        conn.close()


def test_provider_block_reason_reads_the_key_from_the_environment(
    client, monkeypatch
) -> None:
    """A key that lives in an environment variable counts as a working key."""
    pid = _project(client)
    provider_id = _unconfigured_provider(client, pid)
    conn = store.connect(os.environ["NERDBOT_DB"])
    try:
        provider = store.get_provider(conn, provider_id)
        assert provider is not None
        from nerdbot import providers as providers_mod

        assert providers_mod.provider_block_reason(provider) is not None
        monkeypatch.setenv("CLOUD_MODEL_KEY", "gsk-test-value")
        store.update_provider(
            conn, provider_id, config={"api_key_env": "CLOUD_MODEL_KEY"}
        )
        refreshed = store.get_provider(conn, provider_id)
        assert refreshed is not None
        assert providers_mod.provider_block_reason(refreshed) is None
    finally:
        conn.close()
