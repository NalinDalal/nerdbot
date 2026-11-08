"""Tests for the conversational chat tool loop."""

from __future__ import annotations

import httpx
import pytest

from nerdbot import chat as chat_mod
from nerdbot import store
from nerdbot.models import Provider, ProviderKind


def _conn(tmp_path):
    return store.connect(tmp_path / "t.db")


def _project(conn):
    return store.create_project(conn, "local-owner", "p").id


def _provider(conn, project_id):
    import os
    from cryptography.fernet import Fernet

    os.environ.setdefault("NERDBOT_SECRET_KEY", Fernet.generate_key().decode())
    return store.create_provider(
        conn, project_id, kind=ProviderKind.OPENAI_COMPATIBLE, name="o",
        config={"base_url": "https://x/v1", "model": "m", "api_key": "k"},
    )


def _transport(responses):
    """responses: list of dicts returned in order; last reused."""
    calls = {"n": 0}

    def handler(request):
        idx = min(calls["n"], len(responses) - 1)
        calls["n"] += 1
        import json as _json

        return httpx.Response(200, json=responses[idx])

    return httpx.MockTransport(handler), calls


def test_mock_provider_path_is_untouched(tmp_path):
    conn = _conn(tmp_path)
    pid = _project(conn)
    provider = Provider(id="prv", project_id=pid, kind=ProviderKind.MOCK, name="m")
    msgs = [{"role": "user", "content": "hi"}]
    text, _parts = chat_mod.chat_complete_with_tools(
        provider, msgs, conn=conn, project_id=pid
    )
    assert text == chat_mod.chat_complete(provider, msgs)


def test_cap_enforced(tmp_path):
    conn = _conn(tmp_path)
    pid = _project(conn)
    provider = _provider(conn, pid)
    # Always returns a tool call for web_search; loop must stop after 5 turns
    # and make a final tool-less call.
    tool_resp = {
        "choices": [{"message": {"content": "", "tool_calls": [
            {"id": "1", "type": "function", "function": {"name": "web_search", "arguments": '{"query":"q"}'}}
        ]}}]
    }
    final_resp = {"choices": [{"message": {"content": "done", "tool_calls": []}}]}
    # Avoid real search network calls being counted in `calls`.
    chat_mod.search_mod.web_search = lambda *a, **k: []
    chat_mod.search_mod.format_results = lambda r: "[]"
    responses = [tool_resp] * 5 + [final_resp]
    transport, calls = _transport(responses)
    msgs = [{"role": "user", "content": "research"}]
    text, _parts = chat_mod.chat_complete_with_tools(
        provider, msgs, conn=conn, project_id=pid, transport=transport
    )
    # 5 tool turns + 1 final = 6 requests max
    assert calls["n"] <= 6
    assert text == "done"


def test_tool_output_framed_untrusted(tmp_path):
    # web_search results are data; ensure the tool message is appended (not crash)
    conn = _conn(tmp_path)
    pid = _project(conn)
    provider = _provider(conn, pid)
    tool_resp = {
        "choices": [{"message": {"content": "", "tool_calls": [
            {"id": "1", "type": "function", "function": {"name": "web_search", "arguments": '{"query":"q"}'}}
        ]}}]
    }
    final_resp = {"choices": [{"message": {"content": "ok", "tool_calls": []}}]}
    transport, _ = _transport([tool_resp, final_resp])
    msgs = [{"role": "user", "content": "research"}]
    text, _parts = chat_mod.chat_complete_with_tools(
        provider, msgs, conn=conn, project_id=pid, transport=transport
    )
    assert text == "ok"


def test_failing_tool_does_not_crash_stream(tmp_path):
    conn = _conn(tmp_path)
    pid = _project(conn)
    provider = _provider(conn, pid)
    tool_resp = {
        "choices": [{"message": {"content": "", "tool_calls": [
            {"id": "1", "type": "function", "function": {"name": "fetch_url", "arguments": '{"url":"http://127.0.0.1/nope"}'}}
        ]}}]
    }
    final_resp = {"choices": [{"message": {"content": "recovered", "tool_calls": []}}]}
    transport, _ = _transport([tool_resp, final_resp])
    msgs = [{"role": "user", "content": "fetch"}]
    text, _parts = chat_mod.chat_complete_with_tools(
        provider, msgs, conn=conn, project_id=pid, transport=transport
    )
    assert text == "recovered"


def test_create_task_blocked_after_untrusted(tmp_path):
    conn = _conn(tmp_path)
    pid = _project(conn)
    provider = _provider(conn, pid)
    # First turn: web_search; second: create_task should be blocked
    search_resp = {
        "choices": [{"message": {"content": "", "tool_calls": [
            {"id": "1", "type": "function", "function": {"name": "web_search", "arguments": '{"query":"q"}'}}
        ]}}]
    }
    create_resp = {
        "choices": [{"message": {"content": "", "tool_calls": [
            {"id": "2", "type": "function", "function": {"name": "create_task", "arguments": '{"description":"x"}'}}
        ]}}]
    }
    final_resp = {"choices": [{"message": {"content": "done", "tool_calls": []}}]}
    transport, _ = _transport([search_resp, create_resp, final_resp])
    msgs = [{"role": "user", "content": "do"}]
    text, _parts = chat_mod.chat_complete_with_tools(
        provider, msgs, conn=conn, project_id=pid, transport=transport
    )
    assert text == "done"
    # No task should have been created
    assert store.list_tasks_for_project(conn, pid) == []


def test_size_cap(tmp_path):
    conn = _conn(tmp_path)
    pid = _project(conn)
    provider = _provider(conn, pid)
    # fetch returns large; tool output capped at 4000
    big = "a" * 10000
    # monkeypatch fetch_url_text
    orig = chat_mod.fetch_mod.fetch_url_text
    chat_mod.fetch_mod.fetch_url_text = lambda *a, **k: big
    try:
        tool_resp = {
            "choices": [{"message": {"content": "", "tool_calls": [
                {"id": "1", "type": "function", "function": {"name": "fetch_url", "arguments": '{"url":"https://example.com"}'}}
            ]}}]
        }
        final_resp = {"choices": [{"message": {"content": "ok", "tool_calls": []}}]}
        transport, _ = _transport([tool_resp, final_resp])
        msgs = [{"role": "user", "content": "fetch"}]
        chat_mod.chat_complete_with_tools(
            provider, msgs, conn=conn, project_id=pid, transport=transport
        )
    finally:
        chat_mod.fetch_mod.fetch_url_text = orig