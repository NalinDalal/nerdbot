"""SSRF-hardened fetch: mock transport only, no live network."""

from __future__ import annotations

import httpx
import pytest

from nerdbot import agent_tools
from nerdbot.fetch import (
    FetchBlockedError,
    FetchPolicy,
    FetchProtocolError,
    FetchTimeoutError,
    FetchTooLargeError,
    check_url,
    fetch_url_text,
)

PUBLIC = "https://public.example/page"
RESOLVER = {
    "public.example": ["93.184.216.34"],
    "mixed.example": ["93.184.216.34", "10.0.0.9"],
    "evil.example": ["169.254.169.254"],
}


def fake_resolver(host: str) -> list[str]:
    if host not in RESOLVER:
        raise FetchProtocolError(f"unexpected host in test: {host!r}")
    return RESOLVER[host]


def _transport(handler) -> httpx.MockTransport:  # type: ignore[no-untyped-def]
    return httpx.MockTransport(handler)


def test_allow_public_url() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        assert "Authorization" not in request.headers
        assert "Cookie" not in request.headers
        return httpx.Response(200, text="hello world")

    text = fetch_url_text(PUBLIC, resolver=fake_resolver, transport=_transport(handler))
    assert text == "hello world"


def test_deny_non_public_literals() -> None:
    for url in (
        "http://127.0.0.1/",
        "http://10.0.0.1/",
        "http://192.168.1.1/",
        "http://172.16.0.1/",
        "http://169.254.169.254/latest/meta-data/",
        "http://[::1]/",
        "http://0.0.0.0/",
        "http://[fe80::1]/",
    ):
        with pytest.raises(FetchBlockedError):
            check_url(url, resolver=fake_resolver)


def test_deny_local_hosts_and_schemes() -> None:
    for url in (
        "http://localhost/",
        "http://LOCALHOST:8000/x",
        "http://app.local/",
        "http://db.internal/",
        "http://x.lan/",
        "file:///etc/passwd",
        "ftp://public.example/x",
        "gopher://public.example/",
        "http://user:pass@public.example/",
        "",
        "not a url",
    ):
        with pytest.raises(FetchBlockedError):
            check_url(url, resolver=fake_resolver)


def test_deny_private_resolution() -> None:
    with pytest.raises(FetchBlockedError):
        check_url("https://evil.example/", resolver=fake_resolver)
    with pytest.raises(FetchBlockedError):
        check_url("https://mixed.example/", resolver=fake_resolver)  # all-pass, not any


def test_dns_failure_is_protocol_error() -> None:
    def resolver(host: str) -> list[str]:
        raise OSError("no such host")

    with pytest.raises(FetchProtocolError):
        check_url("https://public.example/", resolver=resolver)


def test_redirects_followed_and_capped() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/r1":
            return httpx.Response(302, headers={"location": "/r2"})
        if request.url.path == "/r2":
            return httpx.Response(302, headers={"location": "https://public.example/final"})
        return httpx.Response(200, text="landed")

    text = fetch_url_text(
        "https://public.example/r1", resolver=fake_resolver, transport=_transport(handler)
    )
    assert text == "landed"

    def loop(request: httpx.Request) -> httpx.Response:
        return httpx.Response(302, headers={"location": "/loop"})

    with pytest.raises(FetchProtocolError, match="too many redirects"):
        fetch_url_text(
            "https://public.example/loop",
            resolver=fake_resolver,
            transport=_transport(loop),
            policy=FetchPolicy(max_redirects=2),
        )


def test_redirect_to_private_blocked() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(302, headers={"location": "http://169.254.169.254/"})

    with pytest.raises(FetchBlockedError):
        fetch_url_text(PUBLIC, resolver=fake_resolver, transport=_transport(handler))


def test_size_caps() -> None:
    def big_header(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, headers={"content-length": str(10**9)}, content=b"x")

    with pytest.raises(FetchTooLargeError):
        fetch_url_text(
            PUBLIC,
            resolver=fake_resolver,
            transport=_transport(big_header),
            policy=FetchPolicy(max_bytes=100),
        )

    def big_stream(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, content=b"y" * 500)

    with pytest.raises(FetchTooLargeError):
        fetch_url_text(
            PUBLIC,
            resolver=fake_resolver,
            transport=_transport(big_stream),
            policy=FetchPolicy(max_bytes=100),
        )


def test_timeout_and_status() -> None:
    def slow(request: httpx.Request) -> httpx.Response:
        raise httpx.TimeoutException("slow", request=request)

    with pytest.raises(FetchTimeoutError):
        fetch_url_text(PUBLIC, resolver=fake_resolver, transport=_transport(slow))

    def missing(request: httpx.Request) -> httpx.Response:
        return httpx.Response(404, text="nope")

    with pytest.raises(FetchProtocolError, match="404"):
        fetch_url_text(PUBLIC, resolver=fake_resolver, transport=_transport(missing))


def test_fetch_tool_dispatch_and_bounds(tmp_path) -> None:
    names = [t["function"]["name"] for t in agent_tools.tool_schemas()]
    assert names == ["run_command", "read_file", "write_file", "fetch_url"]

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, text="z" * 9000)

    # Public IP literal needs no DNS, so no live network is touched.
    out = agent_tools.execute_tool(
        tmp_path, "fetch_url", {"url": "http://93.184.216.34/"}, transport=_transport(handler)
    )
    assert len(out) <= agent_tools.TOOL_OUTPUT_MAX_CHARS + 60
    assert "truncated" in out
    with pytest.raises(ValueError):
        agent_tools.execute_tool(tmp_path, "fetch_url", {"url": 123})  # type: ignore[dict-item]
    with pytest.raises(FetchBlockedError):
        agent_tools.execute_tool(
            tmp_path, "fetch_url", {"url": "http://169.254.169.254/"}, transport=_transport(handler)
        )


def test_fetch_tool_uses_policy(tmp_path, monkeypatch) -> None:
    import nerdbot.agent_tools as tools_mod

    seen: dict = {}

    def fake_fetch(url: str, **kwargs) -> str:  # type: ignore[no-untyped-def]
        seen["url"] = url
        return "ok"

    monkeypatch.setattr("nerdbot.fetch.fetch_url_text", fake_fetch)
    assert tools_mod.execute_tool(tmp_path, "fetch_url", {"url": PUBLIC}) == "ok"
    assert seen["url"] == PUBLIC


def test_loop_fetch_tool_end_to_end(tmp_path) -> None:
    import json as _json

    from nerdbot import orchestrator, store
    from nerdbot.providers import OpenAICompatibleAdapter

    def tool_msg() -> dict:
        return {
            "choices": [
                {
                    "message": {
                        "role": "assistant",
                        "content": None,
                        "tool_calls": [
                            {
                                "id": "f1",
                                "type": "function",
                                "function": {
                                    "name": "fetch_url",
                                    "arguments": _json.dumps({"url": "http://93.184.216.34/data"}),
                                },
                            }
                        ],
                    }
                }
            ]
        }

    state = {"n": 0}

    def router(request: httpx.Request) -> httpx.Response:
        if request.url.path.endswith("/chat/completions"):
            state["n"] += 1
            if state["n"] == 1:
                return httpx.Response(200, json=tool_msg())
            return httpx.Response(
                200, json={"choices": [{"message": {"role": "assistant", "content": "rate is 7"}}]}
            )
        assert "Authorization" not in request.headers
        return httpx.Response(200, text="rate is 7")

    config = {"base_url": "https://provider.example/v1", "model": "m", "api_key": "k"}
    adapter = OpenAICompatibleAdapter(config, transport=_transport(router))
    conn = store.connect(":memory:")
    project = store.create_project(conn, owner="o")
    task = store.create_task(conn, project.id, "t", command="fetch the rate")
    run, result, _ = orchestrator.schedule_run(
        conn, task.id, adapter=adapter, data_dir=str(tmp_path)
    )
    assert result is not None and result.exit_code == 0 and "rate is 7" in result.output
    roles = [t["role"] for t in adapter.last_transcript]
    assert roles == ["user", "assistant", "tool", "assistant"]
    conn.close()
