"""Credential-free web search for the agent loop (DuckDuckGo Lite).

Uses ``fetch.fetch_url_text`` — the SSRF-pinned, budgeted, credential-free
transport — to GET ``https://lite.duckduckgo.com/lite/?q=<query>`` and
parses the HTML table for a bounded number of results.

Clean-room implementation written from the behavior contract only.
Structure assumptions (defensive): one ``<a rel="nofollow">`` per result
row, optional snippet in ``<td class="result-snippet">``, and an optional
``//duckduckgo.com/l/?uddg=<encoded>`` URL wrapper. A page that parses to
no anchors is returned as zero results (a legitimate empty search), never
as a fabricated success.
"""

from __future__ import annotations

import json
from html.parser import HTMLParser
from urllib.parse import parse_qs, quote_plus, urljoin, urlparse

import httpx

from . import fetch as fetch_mod

SEARCH_URL = "https://lite.duckduckgo.com/lite/"
MAX_QUERY_CHARS = 400
DEFAULT_MAX_RESULTS = 5
HARD_MAX_RESULTS = 10
SEARCH_MAX_BYTES = 512_000


class SearchProviderError(ValueError):
    """Search provider unavailable, rejected the request, or rate-limited.

    Subclasses ValueError so the agent loop treats it as a recoverable
    tool error (framed text to the model) rather than a run failure.
    """


def _unwrap_ddg_href(href: str) -> str:
    """Resolve protocol-relative wrappers and unwrap uddg redirect links."""
    base = urljoin(SEARCH_URL, href)
    parts = urlparse(base)
    if (parts.hostname or "") in ("duckduckgo.com", "www.duckduckgo.com",
                                  "lite.duckduckgo.com") and parts.query:
        qs = parse_qs(parts.query)
        if "uddg" in qs and qs["uddg"]:
            return qs["uddg"][0]  # parse_qs already URL-decoded the target once
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
            self.rows.append({"href": self._href, "title": title or self._href,
                              "snippet": ""})
        elif tag == "td" and self._in_snippet:
            self._in_snippet = False
            snippet = " ".join("".join(self._snippet).split())
            if self.rows and not self.rows[-1]["snippet"]:
                self.rows[-1]["snippet"] = snippet

    def close(self) -> None:
        if self._in_anchor:  # unterminated final anchor
            title = " ".join("".join(self._title).split())
            self.rows.append({"href": self._href, "title": title or self._href,
                              "snippet": ""})
            self._in_anchor = False
        super().close()


def web_search(
    query: str,
    max_results: int = DEFAULT_MAX_RESULTS,
    transport: httpx.BaseTransport | None = None,
) -> list[dict[str, str]]:
    """Search DuckDuckGo Lite; return bounded {title,url,snippet} results.

    Raises ValueError for a malformed query and SearchProviderError for
    provider failures (rate limit, HTTP errors, unreachable host). No
    credentials, cookies, or Authorization headers are ever sent.
    """
    if not isinstance(query, str) or not query.strip():
        raise ValueError("web_search requires a non-empty query string")
    query = query.strip()[:MAX_QUERY_CHARS]
    try:
        max_results = int(max_results)
    except (TypeError, ValueError) as exc:
        raise ValueError("max_results must be an integer") from exc
    max_results = max(1, min(max_results, HARD_MAX_RESULTS))

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
            raise SearchProviderError(
                "search provider rate-limited; retry later"
            ) from exc
        raise SearchProviderError(f"search provider failed: {exc}") from exc
    except fetch_mod.FetchTooLargeError as exc:
        raise SearchProviderError(f"search provider failed: {exc}") from exc
    except fetch_mod.FetchBlockedError as exc:
        raise SearchProviderError(f"search provider request blocked: {exc}") from exc

    parser = _LiteParser()
    parser.feed(page)
    parser.close()

    results: list[dict[str, str]] = []
    for row in parser.rows:
        if len(results) >= max_results:
            break
        target = _unwrap_ddg_href(row["href"])
        if not target.lower().startswith(("http://", "https://")):
            continue
        results.append(
            {"title": row["title"], "url": target, "snippet": row["snippet"]}
        )
    return results


def format_results(results: list[dict[str, str]]) -> str:
    """Compact JSON line for the tool wall (bounded by tool truncation)."""
    return json.dumps(results, ensure_ascii=False, separators=(",", ":"))


def tool_payload(query: str, transport: httpx.BaseTransport | None = None) -> str:
    """Tool wall wrapper: run the search and shape bounded output text."""
    return format_results(web_search(query=query, transport=transport))
