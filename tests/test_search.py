"""Credential-free DuckDuckGo Lite search: mock transport only, no live network."""

from __future__ import annotations

import json

import httpx
import pytest

from nerdbot import agent_tools
from nerdbot.search import (
    SEARCH_URL,
    SearchProviderError,
    web_search,
)

RESULT_HTML = """
<html><table>
<tr><td><a rel="nofollow" href="https://example.com/one">Example  One</a></td></tr>
<tr><td class="result-snippet">first snippet</td></tr>
<tr><td><a rel="nofollow"
 href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fwrapped.example%2Ftwo">Wrapped</a></td></tr>
<tr><td class="result-snippet">second snippet</td></tr>
<tr><td><a rel="nofollow" href="ftp://bad.example/x">nonHTTP</a></td></tr>
<tr><td><a rel="nofollow" href="#top">fragment-only</a></td></tr>
<tr><td><a rel="nofollow" href="https://example.com/three">Example Three</a></td></tr>
<tr><td class="result-snippet">third snippet</td></tr>
</table></html>
"""

EMPTY_PAGE = "<html><table><tr><td>nothing here</td></tr></table></html>"


def _mock(html: str, status: int = 200) -> httpx.MockTransport:
    def handler(request: httpx.Request) -> httpx.Response:
        assert "Authorization" not in request.headers
        assert "Cookie" not in request.headers
        assert request.url.host == "lite.duckduckgo.com"
        return httpx.Response(status, text=html)

    return httpx.MockTransport(handler)


def test_parses_bounded_results_in_document_order() -> None:
    results = web_search("hello world", transport=_mock(RESULT_HTML))
    assert [r["title"] for r in results] == ["Example One", "Wrapped", "Example Three"]
    assert results[0]["url"] == "https://example.com/one"
    assert results[1]["url"] == "https://wrapped.example/two"  # uddg unwrapped
    assert results[2]["url"] == "https://example.com/three"
    assert [r["snippet"] for r in results] == [
        "first snippet",
        "second snippet",
        "third snippet",
    ]
    bounded = web_search("hello world", max_results=2, transport=_mock(RESULT_HTML))
    assert len(bounded) == 2


def test_query_is_url_encoded_and_bounded() -> None:
    seen: dict[str, str] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen["q"] = request.url.params["q"]
        assert request.url.path.startswith("/lite/")
        return httpx.Response(200, text=RESULT_HTML)

    web_search("hello world Ähnlich", transport=httpx.MockTransport(handler))
    assert seen["q"] == "hello world Ähnlich"

    long_query = "x" * 1000
    web_search(long_query, transport=httpx.MockTransport(handler))
    assert len(seen["q"]) == 400  # MAX_QUERY_CHARS


def test_empty_result_page_is_a_success_with_zero_results() -> None:
    assert web_search("obscure query", transport=_mock(EMPTY_PAGE)) == []


def test_provider_rate_limit_and_errors() -> None:
    with pytest.raises(SearchProviderError, match="rate-limited"):
        web_search("query", transport=_mock("nope", status=429))
    with pytest.raises(SearchProviderError, match="HTTP 500"):
        web_search("query", transport=_mock("boom", status=500))

    def down(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("refused", request=request)

    with pytest.raises(SearchProviderError, match="search provider failed"):
        web_search("query", transport=httpx.MockTransport(down))


def test_query_validation() -> None:
    with pytest.raises(ValueError):
        web_search("")
    with pytest.raises(ValueError):
        web_search("   ")
    with pytest.raises(ValueError):
        web_search("ok", max_results="bogus")  # type: ignore[arg-type]


def test_tool_dispatch_and_bounds(tmp_path) -> None:
    out = agent_tools.execute_tool(
        tmp_path, "web_search", {"query": "hello world"}, transport=_mock(RESULT_HTML)
    )
    parsed = json.loads(out.rsplit("<<<", 1)[0].strip())
    assert len(parsed) == 3 and parsed[0]["title"] == "Example One"
    with pytest.raises(ValueError):
        agent_tools.execute_tool(tmp_path, "web_search", {"query": 123})  # type: ignore[dict-item]
    with pytest.raises(ValueError):
        agent_tools.execute_tool(tmp_path, "web_search", {})
    with pytest.raises(SearchProviderError):
        agent_tools.execute_tool(
            tmp_path, "web_search", {"query": "q"}, transport=_mock("x", status=429)
        )


def test_search_url_is_constant_https() -> None:
    assert SEARCH_URL == "https://lite.duckduckgo.com/lite/"


def test_loop_web_search_rate_limit_is_tool_error_not_run_failure(tmp_path) -> None:
    # A DDG rate limit must reach the model as recoverable tool-error text
    # and complete the run — never abort it.
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
                                "id": "s1",
                                "type": "function",
                                "function": {
                                    "name": "web_search",
                                    "arguments": _json.dumps({"query": "rate"}),
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
                200,
                json={"choices": [{"message": {"role": "assistant", "content": "gave up"}}]},
            )
        return httpx.Response(429, text="slow down")

    adapter = OpenAICompatibleAdapter(
        {"base_url": "https://provider.example/v1", "model": "m", "api_key": "k"},
        transport=httpx.MockTransport(router),
    )
    conn = store.connect(":memory:")
    project = store.create_project(conn, owner="o")
    task = store.create_task(conn, project.id, "t", command="search")
    run, result, _ = orchestrator.schedule_run(
        conn, task.id, adapter=adapter, data_dir=str(tmp_path)
    )
    assert result is not None and result.exit_code == 0 and "gave up" in result.output
    tool = [t for t in adapter.last_transcript if t["role"] == "tool"]
    assert len(tool) == 1
    assert "SearchProviderError" in tool[0]["content"]
    assert "rate-limited" in tool[0]["content"]
    conn.close()


def test_ddg_unwrap_requires_exact_host() -> None:
    from nerdbot.search import _unwrap_ddg_href

    # Only real DuckDuckGo hosts unwrap; look-alike hosts keep their URL.
    assert _unwrap_ddg_href(
        "//duckduckgo.com/l/?uddg=https%3A%2F%2Freal.example%2Fok"
    ) == "https://real.example/ok"
    lookalike = _unwrap_ddg_href(
        "//xduckduckgo.com/l/?uddg=https%3A%2F%2Fevil.example%2Fx"
    )
    assert lookalike == "https://xduckduckgo.com/l/?uddg=https%3A%2F%2Fevil.example%2Fx"
