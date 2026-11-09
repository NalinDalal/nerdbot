"""Web search for chat and research.

Phase 1: provider layer with normalized results, config-driven backends,
timeouts/limits/dedupe, and safe error mapping.

Default provider is DuckDuckGo Lite (credential-free) and preserves the
original behavior/API used by agent tools and tests. Optional API providers
(Tavily, Serper, Brave Search) are enabled when their API keys are present
in config or environment variables.
"""

from __future__ import annotations

import json
import os
from dataclasses import dataclass
from html.parser import HTMLParser
from typing import Any, TypedDict
from urllib.parse import parse_qs, quote_plus, urljoin, urlparse

import httpx

from . import fetch as fetch_mod

SEARCH_URL = "https://lite.duckduckgo.com/lite/"
MAX_QUERY_CHARS = 400
DEFAULT_MAX_RESULTS = 5
HARD_MAX_RESULTS = 10
SEARCH_MAX_BYTES = 512_000
DEFAULT_TIMEOUT_S = 15.0


class SearchProviderError(ValueError):
    """Search provider unavailable, rejected the request, or rate-limited.

    Subclasses ValueError so the agent loop treats it as a recoverable
    tool error (framed text to the model) rather than a run failure.
    """


class SearchResult(TypedDict, total=False):
    title: str
    url: str
    snippet: str
    source: str
    rank: int


@dataclass
class SearchConfig:
    provider: str = "duckduckgo"
    max_results: int = DEFAULT_MAX_RESULTS
    timeout_s: float = DEFAULT_TIMEOUT_S
    tavily_api_key: str = ""
    serper_api_key: str = ""
    brave_api_key: str = ""

    @classmethod
    def from_env(cls, **overrides: Any) -> "SearchConfig":
        provider = str(
            overrides.get("provider")
            or os.environ.get("NERDBOT_SEARCH_PROVIDER")
            or "duckduckgo"
        ).strip().lower()
        return cls(
            provider=provider,
            max_results=int(overrides.get("max_results") or DEFAULT_MAX_RESULTS),
            timeout_s=float(overrides.get("timeout_s") or DEFAULT_TIMEOUT_S),
            tavily_api_key=str(
                overrides.get("tavily_api_key") or os.environ.get("TAVILY_API_KEY") or ""
            ),
            serper_api_key=str(
                overrides.get("serper_api_key") or os.environ.get("SERPER_API_KEY") or ""
            ),
            brave_api_key=str(
                overrides.get("brave_api_key")
                or os.environ.get("BRAVE_SEARCH_API_KEY")
                or ""
            ),
        )


def available_providers(config: SearchConfig | None = None) -> list[dict[str, Any]]:
    """Report configured search backends (honest; no secret values)."""
    cfg = config or SearchConfig.from_env()
    providers = [
        {
            "id": "duckduckgo",
            "name": "DuckDuckGo Lite",
            "configured": True,
            "credential_free": True,
        },
        {
            "id": "tavily",
            "name": "Tavily",
            "configured": bool(cfg.tavily_api_key),
            "credential_free": False,
        },
        {
            "id": "serper",
            "name": "Serper (Google)",
            "configured": bool(cfg.serper_api_key),
            "credential_free": False,
        },
        {
            "id": "brave",
            "name": "Brave Search",
            "configured": bool(cfg.brave_api_key),
            "credential_free": False,
        },
    ]
    for p in providers:
        p["active"] = p["id"] == cfg.provider and bool(p["configured"])
    return providers


def _normalize_query(query: str) -> str:
    if not isinstance(query, str) or not query.strip():
        raise ValueError("web_search requires a non-empty query string")
    return query.strip()[:MAX_QUERY_CHARS]


def _normalize_max_results(max_results: Any) -> int:
    try:
        max_results = int(max_results)
    except (TypeError, ValueError) as exc:
        raise ValueError("max_results must be an integer") from exc
    return max(1, min(max_results, HARD_MAX_RESULTS))


def _dedupe(results: list[SearchResult]) -> list[SearchResult]:
    seen: set[str] = set()
    out: list[SearchResult] = []
    for r in results:
        url = str(r.get("url") or "").strip()
        key = url.lower().rstrip("/")
        if not url or key in seen:
            continue
        seen.add(key)
        out.append(r)
    for i, r in enumerate(out, start=1):
        r["rank"] = i
    return out


# --- DuckDuckGo Lite (default, backward compatible) ---


def _unwrap_ddg_href(href: str) -> str:
    """Resolve protocol-relative wrappers and unwrap uddg redirect links."""
    base = urljoin(SEARCH_URL, href)
    parts = urlparse(base)
    if (parts.hostname or "") in (
        "duckduckgo.com",
        "www.duckduckgo.com",
        "lite.duckduckgo.com",
    ) and parts.query:
        qs = parse_qs(parts.query)
        if "uddg" in qs and qs["uddg"]:
            return qs["uddg"][0]
    return base


class _LiteParser(HTMLParser):
    """Collect result anchors (document order); each result-snippet cell
    attaches to the most recent anchor that does not have one yet."""

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.rows: list[dict[str, str]] = []
        self._in_anchor = False
        self._href = ""
        self._title: list[str] = []
        self._in_snippet = False
        self._snippet: list[str] = []

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        data = {k: (v or "") for k, v in attrs}
        if tag == "a":
            href = data.get("href", "")
            if "nofollow" in data.get("rel", "") and href and not href.startswith("#"):
                self._in_anchor = True
                self._href = href
                self._title = []
        elif tag == "td" and "result-snippet" in data.get("class", ""):
            self._in_snippet = True
            self._snippet = []

    def handle_data(self, data: str) -> None:
        if self._in_anchor:
            self._title.append(data)
        elif self._in_snippet:
            self._snippet.append(data)

    def handle_endtag(self, tag: str) -> None:
        if tag == "a" and self._in_anchor:
            self._in_anchor = False
            title = " ".join("".join(self._title).split())
            self.rows.append(
                {"href": self._href, "title": title or self._href, "snippet": ""}
            )
        elif tag == "td" and self._in_snippet:
            self._in_snippet = False
            snippet = " ".join("".join(self._snippet).split())
            if self.rows and not self.rows[-1]["snippet"]:
                self.rows[-1]["snippet"] = snippet

    def close(self) -> None:
        if self._in_anchor:
            title = " ".join("".join(self._title).split())
            self.rows.append(
                {"href": self._href, "title": title or self._href, "snippet": ""}
            )
            self._in_anchor = False
        super().close()


def _search_duckduckgo(
    query: str, max_results: int, transport: httpx.BaseTransport | None
) -> list[SearchResult]:
    url = f"{SEARCH_URL}?q={quote_plus(query)}"
    try:
        page = fetch_mod.fetch_url_text(
            url,
            policy=fetch_mod.FetchPolicy(max_bytes=SEARCH_MAX_BYTES),
            transport=transport,
        )
    except fetch_mod.FetchTimeoutError as exc:
        raise SearchProviderError(f"search provider timed out: {exc}") from exc
    except fetch_mod.FetchProtocolError as exc:
        status = getattr(exc, "status", None)
        if status == 429:
            raise SearchProviderError("search provider rate-limited; retry later") from exc
        # Preserve original error shape/text for compatibility (tests match "HTTP 500").
        raise SearchProviderError(f"search provider failed: {exc}") from exc
    except fetch_mod.FetchTooLargeError as exc:
        raise SearchProviderError(f"search provider failed: {exc}") from exc
    except fetch_mod.FetchBlockedError as exc:
        raise SearchProviderError(f"search provider request blocked: {exc}") from exc

    parser = _LiteParser()
    parser.feed(page)
    parser.close()

    results: list[SearchResult] = []
    for row in parser.rows:
        if len(results) >= max_results:
            break
        target = _unwrap_ddg_href(row["href"])
        if not target.lower().startswith(("http://", "https://")):
            continue
        results.append(
            {
                "title": row["title"],
                "url": target,
                "snippet": row["snippet"],
                "source": "duckduckgo",
            }
        )
    return _dedupe(results)


# --- API providers (config-driven) ---


def _http_json(
    method: str,
    url: str,
    *,
    headers: dict[str, str] | None = None,
    json_body: dict[str, Any] | None = None,
    timeout_s: float,
    transport: httpx.BaseTransport | None = None,
) -> dict[str, Any]:
    try:
        with httpx.Client(timeout=timeout_s, transport=transport, follow_redirects=False) as client:
            resp = client.request(method, url, headers=headers, json=json_body)
    except httpx.TimeoutException as exc:
        raise SearchProviderError(f"search provider timed out: {exc}") from exc
    except httpx.RequestError as exc:
        raise SearchProviderError(f"search provider failed: {exc}") from exc
    if resp.status_code == 429:
        raise SearchProviderError("search provider rate-limited; retry later")
    if resp.status_code >= 400:
        raise SearchProviderError(f"search provider failed: HTTP {resp.status_code}")
    try:
        data = resp.json()
    except ValueError as exc:
        raise SearchProviderError(f"search provider failed: invalid JSON: {exc}") from exc
    if not isinstance(data, dict):
        raise SearchProviderError("search provider failed: unexpected response")
    return data


def _search_tavily(
    query: str, max_results: int, cfg: SearchConfig, transport: httpx.BaseTransport | None
) -> list[SearchResult]:
    if not cfg.tavily_api_key:
        raise SearchProviderError("Tavily search is not configured (missing TAVILY_API_KEY)")
    data = _http_json(
        "POST",
        "https://api.tavily.com/search",
        json_body={
            "api_key": cfg.tavily_api_key,
            "query": query,
            "max_results": max_results,
            "search_depth": "basic",
            "include_answer": False,
            "include_raw_content": False,
        },
        timeout_s=cfg.timeout_s,
        transport=transport,
    )
    items = data.get("results") or []
    results: list[SearchResult] = []
    if isinstance(items, list):
        for item in items[:max_results]:
            if not isinstance(item, dict):
                continue
            url = str(item.get("url") or "").strip()
            if not url.lower().startswith(("http://", "https://")):
                continue
            results.append(
                {
                    "title": str(item.get("title") or url),
                    "url": url,
                    "snippet": str(item.get("content") or item.get("snippet") or ""),
                    "source": "tavily",
                }
            )
    return _dedupe(results)


def _search_serper(
    query: str, max_results: int, cfg: SearchConfig, transport: httpx.BaseTransport | None
) -> list[SearchResult]:
    if not cfg.serper_api_key:
        raise SearchProviderError("Serper search is not configured (missing SERPER_API_KEY)")
    data = _http_json(
        "POST",
        "https://google.serper.dev/search",
        headers={"X-API-KEY": cfg.serper_api_key, "Content-Type": "application/json"},
        json_body={"q": query, "num": max_results},
        timeout_s=cfg.timeout_s,
        transport=transport,
    )
    items = data.get("organic") or []
    results: list[SearchResult] = []
    if isinstance(items, list):
        for item in items[:max_results]:
            if not isinstance(item, dict):
                continue
            url = str(item.get("link") or "").strip()
            if not url.lower().startswith(("http://", "https://")):
                continue
            results.append(
                {
                    "title": str(item.get("title") or url),
                    "url": url,
                    "snippet": str(item.get("snippet") or ""),
                    "source": "serper",
                }
            )
    return _dedupe(results)


def _search_brave(
    query: str, max_results: int, cfg: SearchConfig, transport: httpx.BaseTransport | None
) -> list[SearchResult]:
    if not cfg.brave_api_key:
        raise SearchProviderError("Brave Search is not configured (missing BRAVE_SEARCH_API_KEY)")
    url = f"https://api.search.brave.com/res/v1/web/search?q={quote_plus(query)}&count={max_results}"
    data = _http_json(
        "GET",
        url,
        headers={"Accept": "application/json", "X-Subscription-Token": cfg.brave_api_key},
        timeout_s=cfg.timeout_s,
        transport=transport,
    )
    web = data.get("web") if isinstance(data.get("web"), dict) else {}
    items = web.get("results") if isinstance(web, dict) else []
    results: list[SearchResult] = []
    if isinstance(items, list):
        for item in items[:max_results]:
            if not isinstance(item, dict):
                continue
            urlv = str(item.get("url") or "").strip()
            if not urlv.lower().startswith(("http://", "https://")):
                continue
            results.append(
                {
                    "title": str(item.get("title") or urlv),
                    "url": urlv,
                    "snippet": str(item.get("description") or ""),
                    "source": "brave",
                }
            )
    return _dedupe(results)


def web_search(
    query: str,
    max_results: int = DEFAULT_MAX_RESULTS,
    transport: httpx.BaseTransport | None = None,
    provider: str | None = None,
    config: SearchConfig | dict[str, Any] | None = None,
) -> list[SearchResult]:
    """Search the web and return bounded normalized results.

    Backward compatible: DDG remains the default and returns
    ``{title,url,snippet,...}`` dicts. Configured API providers are used when
    selected and their keys are present.
    """
    query = _normalize_query(query)
    max_results = _normalize_max_results(max_results)

    if isinstance(config, dict):
        cfg = SearchConfig.from_env(**config)
    elif isinstance(config, SearchConfig):
        cfg = config
    else:
        cfg = SearchConfig.from_env()
    if provider:
        cfg.provider = str(provider).strip().lower()

    if cfg.provider in ("", "duckduckgo", "ddg", "duckduckgo-lite"):
        return _search_duckduckgo(query, max_results, transport)
    if cfg.provider == "tavily":
        return _search_tavily(query, max_results, cfg, transport)
    if cfg.provider in ("serper", "google", "google-serper"):
        return _search_serper(query, max_results, cfg, transport)
    if cfg.provider == "brave":
        return _search_brave(query, max_results, cfg, transport)
    raise SearchProviderError(
        f"unknown search provider {cfg.provider!r}; use duckduckgo, tavily, serper, or brave"
    )


def format_results(results: list[dict[str, Any]]) -> str:
    """Compact JSON line for the tool wall (bounded by tool truncation)."""
    return json.dumps(results, ensure_ascii=False, separators=(",", ":"))


def tool_payload(query: str, transport: httpx.BaseTransport | None = None) -> str:
    """Tool wall wrapper: run the search and shape bounded output text."""
    return format_results(web_search(query=query, transport=transport))
