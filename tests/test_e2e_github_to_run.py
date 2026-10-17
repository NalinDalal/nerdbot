"""Phase 5(b) E2E: GitHub preview → ingest → task → run → artifacts.

Covers the product's central workflow end to end — api → execution →
persistence → inspectable state — with the dashboard view shapes exercised
from the same API responses. All external networks are mocked (GitHub
fetch transport + resolver, provider chat transport); no live network in
the suite. The real-GitHub smoke test is documented in docs/PLAN.md.
"""

from __future__ import annotations

import json
import os
from pathlib import Path

import httpx
import pytest
from fastapi.testclient import TestClient

from nerdbot import orchestrator, store
from nerdbot.api import create_app
from nerdbot.integrations.github import (
    GitHubAuthError,
    GitHubNotFoundError,
    fetch_github_issue,
)
from nerdbot.models import TaskStatus
from nerdbot.providers import OpenAICompatibleAdapter

TOKEN = "e2e-token"
AUTH = {"Authorization": f"Bearer {TOKEN}"}
SECRET = "sk-SECRET-XYZ"
CONFIG = {"base_url": "https://provider.example/v1", "model": "test-model", "api_key": SECRET}


@pytest.fixture()
def app_env(tmp_path, monkeypatch) -> object:
    monkeypatch.setenv("NERDBOT_TOKEN", TOKEN)
    monkeypatch.setenv("NERDBOT_DB", str(tmp_path / "e2e.db"))
    monkeypatch.setenv("NERDBOT_DATA", str(tmp_path / "data"))
    return tmp_path


# -- mock helpers: GitHub fetch leg -------------------------------------------


def _resolver(host: str) -> list[str]:
    assert host == "api.github.com"
    return ["140.82.121.6"]


def _github_transport(payload: bytes, status: int = 200) -> httpx.MockTransport:
    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.host == "api.github.com"
        return httpx.Response(status, content=payload)

    return httpx.MockTransport(handler)


def _issue_json(state: str = "open") -> dict:
    return {
        "title": "Assistant: resume fails after restart",
        "body": "Steps to reproduce. Tamper marker: <script>alert(1)</script>",
        "labels": [{"name": "bug"}, {"name": "p1"}],
        "state": state,
        "html_url": "https://github.com/nerdbot/assistant/issues/7",
    }


# -- mock helpers: provider chat leg (mirrors test_provider_agent_loop.py) ----


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


def _chat_transport(script: list) -> httpx.MockTransport:
    state = {"i": 0}

    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.host == "provider.example"
        assert request.headers["Authorization"] == f"Bearer {SECRET}"
        idx = min(state["i"], len(script) - 1)
        state["i"] += 1
        item = script[idx]
        if isinstance(item, Exception):
            raise item
        if isinstance(item, tuple):
            status, payload = item
            return httpx.Response(status, json=payload)
        return httpx.Response(200, json=item)

    return httpx.MockTransport(handler)


# -- shared chain helpers ------------------------------------------------------


def _project_and_api() -> tuple[TestClient, str]:
    client = TestClient(create_app())
    pid = client.post("/projects", json={}, headers=AUTH).json()["id"]
    return client, pid


def _seed_github_issue_and_task(client: TestClient, pid: str) -> tuple[str, str]:
    """preview → ingest → task, the owner-facing chain."""

    data = fetch_github_issue(
        "nerdbot/assistant",
        7,
        resolver=_resolver,
        transport=_github_transport(json.dumps(_issue_json()).encode()),
    )
    issue = client.post(
        f"/projects/{pid}/issues", json=data["suggested_ingest"], headers=AUTH
    ).json()
    assert issue["source"] == "github" and issue["external_id"] == "nerdbot/assistant#7"
    task = client.post(
        f"/projects/{pid}/tasks",
        json={
            "description": "Resolve the resumed-run crash",
            "issue_id": issue["id"],
            "command": "implement the fix for the linked issue",
        },
        headers=AUTH,
    ).json()
    return task["id"], issue["id"]


def _artifact_paths_on_disk(artifacts: list[dict]) -> None:
    for artifact in artifacts:
        path = Path(artifact["location"])
        # test-log artifacts record the task workspace (a directory);
        # transcript artifacts record the transcript file itself.
        if artifact["type"] == "test-log":
            assert path.is_dir() and any(path.iterdir()), artifact
        else:
            assert path.is_file() and path.stat().st_size > 0, artifact


def test_github_issue_to_agent_run_success(app_env) -> None:
    """Goal chain: github issue → ingest → task → real tool loop → artifacts."""
    client, pid = _project_and_api()
    task_id, issue_id = _seed_github_issue_and_task(client, pid)

    script = [
        _msg("", [_call("c1", "run_command", {"command": "echo evidence"})]),
        _msg("work complete: fix verified"),
    ]
    adapter = OpenAICompatibleAdapter(CONFIG, transport=_chat_transport(script))
    conn = store.connect(os.environ["NERDBOT_DB"])
    run, result, artifact_id = orchestrator.schedule_run(
        conn, task_id, adapter=adapter, data_dir=str(app_env)
    )
    conn.close()

    assert result is not None and result.exit_code == 0
    assert run.status.value == "succeeded"
    assert artifact_id is not None

    view = client.get(f"/tasks/{task_id}", headers=AUTH).json()
    assert view["task"]["status"] == "done" and view["task"]["issue_id"] == issue_id
    assert view["issue"]["external_id"] == "nerdbot/assistant#7"
    assert len(view["runs"]) == 1 and view["runs"][0]["status"] == "succeeded"
    assert view["runs"][0]["output_excerpt"].startswith("<<<UNTRUSTED_RUN_OUTPUT>>>")
    assert run.runtime == "openai-compatible"
    types = {a["type"] for a in view["artifacts"]}
    assert {"test-log", "transcript"} <= types
    _artifact_paths_on_disk(view["artifacts"])
    transcript = next(a for a in view["artifacts"] if a["type"] == "transcript")
    transcript_text = Path(transcript["location"]).read_text(encoding="utf-8")
    assert "work complete" in transcript_text
    assert "evidence" in transcript_text  # tool-loop round trip captured


def test_invalid_repository_access_leaves_nothing_ingested(app_env, monkeypatch) -> None:
    """A rejected GitHub fetch must not create a partial local state."""
    client, pid = _project_and_api()

    with pytest.raises(GitHubNotFoundError):
        fetch_github_issue(
            "nerdbot/ghost",
            999,
            resolver=_resolver,
            transport=_github_transport(
                b'{"message": "Not Found", "documentation_url": "https://docs.github.com"}',
                status=404,
            ),
        )
    monkeypatch.setenv("GH_E2E_TOKEN", "bad-token")
    with pytest.raises(GitHubAuthError):
        fetch_github_issue(
            "nerdbot/private",
            3,
            token_env="GH_E2E_TOKEN",
            resolver=_resolver,
            transport=_github_transport(b'{"message": "Bad credentials"}', status=401),
        )

    assert client.get(f"/projects/{pid}/issues", headers=AUTH).json()["issues"] == []
    conn = store.connect(os.environ["NERDBOT_DB"])
    assert store.list_tasks_for_project(conn, pid) == []
    conn.close()


def test_provider_failure_records_inspectable_state_and_retries(app_env) -> None:
    """Provider failure: failed run + failed task, retry adds NEW run, no dup."""
    client, pid = _project_and_api()
    task_id, issue_id = _seed_github_issue_and_task(client, pid)

    failing = OpenAICompatibleAdapter(CONFIG, transport=_chat_transport([(500, {})]))
    conn = store.connect(os.environ["NERDBOT_DB"])
    run, result, _ = orchestrator.schedule_run(
        conn, task_id, adapter=failing, data_dir=str(app_env)
    )
    assert result is None and run.status.value == "failed"

    view = client.get(f"/tasks/{task_id}", headers=AUTH).json()
    assert view["task"]["status"] == "failed"
    assert "ProviderProtocolError" in view["runs"][0]["output_excerpt"]
    assert len(view["runs"]) == 1  # the failure left exactly one inspectable run

    succeeding = OpenAICompatibleAdapter(CONFIG, transport=_chat_transport([_msg("fixed")]))
    run2, result2, _artifact_id = orchestrator.retry_task(
        conn, task_id, adapter=succeeding, data_dir=str(app_env)
    )
    conn.close()
    assert result2 is not None and result2.exit_code == 0

    view = client.get(f"/tasks/{task_id}", headers=AUTH).json()
    assert [r["status"] for r in view["runs"]] == ["failed", "succeeded"]
    assert view["task"]["status"] == "done"


def test_interrupted_run_recovered_on_restart(app_env) -> None:
    """Crash during execution (run persisted as running) → recovery → retry."""
    client, pid = _project_and_api()
    task_id, issue_id = _seed_github_issue_and_task(client, pid)

    conn = store.connect(os.environ["NERDBOT_DB"])
    crash_run = store.create_run(conn, task_id, runtime="openai-compatible", session=task_id)
    store.mark_run_running(conn, crash_run.id)
    store.set_task_status(conn, task_id, TaskStatus.RUNNING)
    conn.close()

    # Restart: the app lifespan recovers non-terminal runs explicitly.
    with TestClient(create_app()) as restarted:
        assert restarted.app.state.recovered_runs == [crash_run.id]  # type: ignore[attr-defined]
        view = restarted.get(f"/tasks/{task_id}", headers=AUTH).json()
        assert view["runs"][0]["status"] == "stopped"
        assert "[recovered" in view["runs"][0]["output_excerpt"]
        assert view["task"]["status"] == "pending"

    # The recovered pending task is explicitly rescheduled: one new run.
    adapter = OpenAICompatibleAdapter(CONFIG, transport=_chat_transport([_msg("fixed")]))
    conn = store.connect(os.environ["NERDBOT_DB"])
    run2, result2, _artifact_id = orchestrator.schedule_run(
        conn, task_id, adapter=adapter, data_dir=str(app_env)
    )
    conn.close()
    assert result2 is not None and result2.exit_code == 0
    view = client.get(f"/tasks/{task_id}", headers=AUTH).json()
    assert [r["status"] for r in view["runs"]] == ["stopped", "succeeded"]
    assert view["task"]["status"] == "done"
