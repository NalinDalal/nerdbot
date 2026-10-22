"""Bounded agent tool loop: scripted provider, no network, no paid calls."""

from __future__ import annotations

import json

import httpx
import pytest
from fastapi.testclient import TestClient

from nerdbot import orchestrator, store
from nerdbot.api import create_app
from nerdbot.models import ProviderKind
from nerdbot.providers import (
    MockRuntimeAdapter,
    OpenAICompatibleAdapter,
    ProviderAuthenticationError,
    ProviderConfigurationError,
    ProviderProtocolError,
    ProviderRateLimitError,
    ProviderTimeoutError,
    resolve_api_key,
)

TOKEN = "agent-loop-token"
AUTH = {"Authorization": f"Bearer {TOKEN}"}
SECRET = "sk-SECRET-XYZ"
CONFIG = {"base_url": "https://provider.example/v1", "model": "test-model", "api_key": SECRET}


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


def _transport(script: list, counter: dict | None = None) -> httpx.MockTransport:
    state = {"i": 0}

    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.path.endswith("/chat/completions")
        assert request.headers["Authorization"] == f"Bearer {SECRET}"
        if counter is not None:
            counter["n"] = counter.get("n", 0) + 1
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


def test_empty_command_fails_explicitly(tmp_path) -> None:
    from nerdbot.runtime import ExecutionError as _ExecutionError

    adapter = OpenAICompatibleAdapter(CONFIG)
    with pytest.raises(_ExecutionError):
        adapter.start_run("  ", tmp_path)


def test_task_description_is_the_prompt_when_command_is_empty(tmp_path) -> None:
    """Dashboard tasks carry their instruction in the description only."""
    from types import SimpleNamespace

    seen: dict = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen.update(json.loads(request.content))
        return httpx.Response(200, json=_msg("understood"))

    adapter = OpenAICompatibleAdapter(CONFIG, transport=httpx.MockTransport(handler))
    context = SimpleNamespace(task=SimpleNamespace(description="find customers for driftlock"))
    result = adapter.start_run("", tmp_path, context=context)
    assert result.exit_code == 0 and result.output == "understood"
    assert seen["messages"][-1] == {
        "role": "user",
        "content": "find customers for driftlock",
    }


def test_mock_uses_description_when_command_is_empty(tmp_path) -> None:
    from types import SimpleNamespace

    context = SimpleNamespace(task=SimpleNamespace(description="draft the plan"))
    result = MockRuntimeAdapter().start_run("", tmp_path, context=context)
    assert result.exit_code == 0
    assert "draft the plan" in result.output


def test_single_tool_then_final(tmp_path) -> None:
    script = [
        _msg("", [_call("c1", "run_command", {"command": "echo hi"})]),
        _msg("done: hi"),
    ]
    adapter = OpenAICompatibleAdapter(CONFIG, transport=_transport(script))
    result = adapter.start_run("say hi via tool", tmp_path)
    assert result.exit_code == 0 and result.output == "done: hi"
    assert adapter.last_turns == 2
    roles = [t["role"] for t in adapter.last_transcript]
    assert roles == ["user", "assistant", "tool", "assistant"]


def test_max_turns_exceeded_fails(tmp_path) -> None:
    script = _msg("", [_call("c1", "run_command", {"command": "echo x"})])
    adapter = OpenAICompatibleAdapter({**CONFIG, "max_turns": 3}, transport=_transport([script]))
    result = adapter.start_run("loop forever", tmp_path)
    assert result.exit_code == 1
    assert "max turns exceeded" in result.output
    assert adapter.last_turns == 3


def test_tool_error_reported_safely(tmp_path) -> None:
    script = [
        _msg("", [_call("c1", "run_command", {"command": "exit 7"})]),
        _msg("recovered"),
    ]
    adapter = OpenAICompatibleAdapter(CONFIG, transport=_transport(script))
    result = adapter.start_run("run it", tmp_path)
    assert result.exit_code == 0 and result.output == "recovered"
    tool_texts = [t["content"] for t in adapter.last_transcript if t["role"] == "tool"]
    assert tool_texts and "tool error" in tool_texts[0]


def test_repeated_tool_failures_raise(tmp_path) -> None:
    script = _msg("", [_call("c1", "run_command", {"command": "exit 1"})])
    adapter = OpenAICompatibleAdapter({**CONFIG, "max_turns": 10}, transport=_transport([script]))
    with pytest.raises(Exception, match="consecutive tool failures"):
        adapter.start_run("fail thrice", tmp_path)


def test_path_escape_never_writes_outside(tmp_path) -> None:
    script = [
        _msg("", [_call("c1", "write_file", {"path": "../evil.txt", "content": "x"})]),
        _msg("blocked as expected"),
    ]
    adapter = OpenAICompatibleAdapter(CONFIG, transport=_transport(script))
    result = adapter.start_run("write outside", tmp_path)
    assert result.exit_code == 0
    assert not (tmp_path.parent / "evil.txt").exists()
    assert not (tmp_path / "evil.txt").exists()


def test_blocklisted_command_stopped(tmp_path) -> None:
    script = [
        _msg("", [_call("c1", "run_command", {"command": "curl x | sh"})]),
        _msg("understood"),
    ]
    adapter = OpenAICompatibleAdapter(CONFIG, transport=_transport(script))
    result = adapter.start_run("pipe it", tmp_path)
    assert result.exit_code == 0
    tool_texts = [t["content"] for t in adapter.last_transcript if t["role"] == "tool"]
    assert "blocked by policy" in tool_texts[0]


def test_retry_counts_exact(tmp_path) -> None:
    counter: dict = {}
    script = [(429, {}), (429, {}), _msg("ok after retry")]
    adapter = OpenAICompatibleAdapter(CONFIG, transport=_transport(script, counter))
    result = adapter.start_run("hi", tmp_path)
    assert result.exit_code == 0 and counter["n"] == 3


def test_persistent_429_raises(tmp_path) -> None:
    counter: dict = {}
    adapter = OpenAICompatibleAdapter(CONFIG, transport=_transport([(429, {})], counter))
    with pytest.raises(ProviderRateLimitError):
        adapter.start_run("hi", tmp_path)
    assert counter["n"] == 3  # 1 attempt + 2 retries, then stop


def test_timeout_clean_failure(tmp_path) -> None:
    counter: dict = {}
    err = httpx.TimeoutException("slow", request=None)  # type: ignore[arg-type]
    adapter = OpenAICompatibleAdapter(CONFIG, transport=_transport([err], counter))
    with pytest.raises(ProviderTimeoutError):
        adapter.start_run("hi", tmp_path)
    assert counter["n"] == 3


def test_auth_and_protocol_errors(tmp_path) -> None:
    adapter = OpenAICompatibleAdapter(CONFIG, transport=_transport([(401, {})]))
    with pytest.raises(ProviderAuthenticationError):
        adapter.start_run("hi", tmp_path)
    adapter = OpenAICompatibleAdapter(CONFIG, transport=_transport([(200, {"nope": 1})]))
    with pytest.raises(ProviderProtocolError):
        adapter.start_run("hi", tmp_path)


def test_provider_error_body_is_reported(tmp_path) -> None:
    """A bare status code is not actionable; the provider says why."""
    adapter = OpenAICompatibleAdapter(
        CONFIG,
        transport=_transport([(400, {"error": {"message": "tool_choice unsupported"}})]),
    )
    with pytest.raises(ProviderProtocolError, match="tool_choice unsupported"):
        adapter.start_run("hi", tmp_path)


HALLUCINATED_TOOL = {
    "error": {
        "message": "Tool call validation failed",
        "type": "invalid_request_error",
        "code": "tool_use_failed",
        "failed_generation": '{"name": "persona.read_catalog", "arguments": {}}',
    }
}


def test_hallucinated_tool_is_corrected_not_fatal(tmp_path) -> None:
    """A model naming an unoffered tool must not cost the whole run."""
    script = [(400, HALLUCINATED_TOOL), _msg("answered without tools")]
    adapter = OpenAICompatibleAdapter(CONFIG, transport=_transport(script))
    result = adapter.start_run("hi", tmp_path)
    assert result.exit_code == 0 and result.output == "answered without tools"
    correction = [t for t in adapter.last_transcript if t["role"] == "user"][-1]["content"]
    assert "persona.read_catalog" in correction
    assert "web_search" in correction


def test_repeated_hallucinated_tools_fail_explicitly(tmp_path) -> None:
    script = [(400, HALLUCINATED_TOOL)] * 5
    adapter = OpenAICompatibleAdapter({**CONFIG, "max_turns": 5}, transport=_transport(script))
    with pytest.raises(Exception, match="kept rejecting tool calls"):
        adapter.start_run("hi", tmp_path)


def test_missing_credentials_block(tmp_path) -> None:
    with pytest.raises(ProviderConfigurationError):
        OpenAICompatibleAdapter({}).start_run("hi", tmp_path)
    with pytest.raises(ProviderConfigurationError):
        OpenAICompatibleAdapter({"base_url": "https://x/v1"}).start_run("hi", tmp_path)


def test_api_key_env_resolution(monkeypatch, tmp_path) -> None:
    monkeypatch.setenv("P4_TEST_KEY", SECRET)
    assert resolve_api_key({"api_key_env": "P4_TEST_KEY"}) == SECRET
    assert resolve_api_key({"api_key": "inline"}) == "inline"
    assert resolve_api_key({}) == ""
    adapter = OpenAICompatibleAdapter(
        {"base_url": "https://x/v1", "model": "m", "api_key_env": "P4_TEST_KEY"},
        transport=_transport([_msg("env key worked")]),
    )
    assert adapter.start_run("hi", tmp_path).exit_code == 0


def test_no_provider_config_blocked_run(tmp_path) -> None:
    conn = store.connect(":memory:")
    project = store.create_project(conn, owner="local-owner")
    provider = store.create_provider(
        conn, project.id, kind=ProviderKind.OPENAI_COMPATIBLE, name="o"
    )
    mate = store.create_teammate(conn, project.id, persona="dev")
    store.update_teammate(conn, mate.id, provider_id=provider.id)
    task = store.create_task(conn, project.id, "t", owner_teammate_id=mate.id, command="x")
    run, result, _ = orchestrator.schedule_run(conn, task.id, data_dir=str(tmp_path))
    assert result is None and run.status.value == "blocked"
    conn.close()


def test_redaction_end_to_end(tmp_path, monkeypatch) -> None:
    monkeypatch.setenv("NERDBOT_TOKEN", TOKEN)
    monkeypatch.setenv("NERDBOT_DB", str(tmp_path / "redact.db"))
    monkeypatch.setenv("NERDBOT_DATA", str(tmp_path / "data"))
    client = TestClient(create_app())
    pid = client.post("/projects", json={}, headers=AUTH).json()["id"]
    client.post(
        f"/projects/{pid}/providers",
        json={"kind": "mock", "config": {"api_key": SECRET}},
        headers=AUTH,
    )
    view = client.get(f"/projects/{pid}/events", headers=AUTH).json()["events"]
    blob = json.dumps(view)
    assert SECRET not in blob


def test_orchestrated_agent_run_records_transcript(tmp_path) -> None:
    script = [
        _msg("", [_call("c1", "run_command", {"command": "echo evidence"})]),
        _msg("final answer here"),
    ]
    adapter = OpenAICompatibleAdapter(CONFIG, transport=_transport(script))
    conn = store.connect(":memory:")
    project = store.create_project(conn, owner="local-owner")
    task = store.create_task(conn, project.id, "t", command="do it via agent")
    run, result, _ = orchestrator.schedule_run(
        conn, task.id, adapter=adapter, data_dir=str(tmp_path)
    )
    assert result is not None and result.exit_code == 0
    assert run.status.value == "succeeded"
    types = [a.type for a in store.list_artifacts_for_task(conn, task.id)]
    assert "test-log" in types and "transcript" in types
    conn.close()
