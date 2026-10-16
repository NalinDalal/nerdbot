"""Read-only GitHub issue fetch for preview-then-ingest.

Exactly one host (``api.github.com``) — no arbitrary base URLs. SSRF policy
is reused from ``fetch.py``; responses are size/time capped; redirects stay
on-host and are re-validated. Auth is an env-referenced token only (never a
raw secret in requests, storage, logs, or exports); unauthenticated mode is
allowed within GitHub's rate limits. Nothing is written to GitHub.
"""

from __future__ import annotations

import os
import re
from collections.abc import Callable
from typing import Any
from urllib.parse import urljoin, urlparse

import httpx

from .. import fetch as fetch_mod

GITHUB_API_HOST = "api.github.com"
GITHUB_API_BASE = f"https://{GITHUB_API_HOST}"
MAX_BYTES = 262_144
TIMEOUT_S = 15.0

_REPO_RE = re.compile(r"^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$")


class GitHubNotFoundError(ValueError):
    """Issue or repository does not exist (HTTP 404)."""


class GitHubAuthError(RuntimeError):
    """Credentials rejected (HTTP 401, or 403 that is not rate limiting)."""


class GitHubRateLimitError(RuntimeError):
    """Rate limited (HTTP 429, or 403 with an exhausted rate budget)."""


class GitHubProtocolError(RuntimeError):
    """Unreachable host, bad payload, too many redirects."""


class GitHubConfigurationError(ValueError):
    """Bad repository reference, issue number, or token reference."""


def resolve_token(token_env: str = "") -> str:
    """Resolve an env-referenced token. Empty string = unauthenticated mode."""
    if not isinstance(token_env, str) or not token_env:
        return ""
    if token_env.startswith("NERDBOT_"):
        raise GitHubConfigurationError("token_env must not reference NERDBOT_* server variables")
    value = os.environ.get(token_env, "")
    return value if isinstance(value, str) else ""


def validate_reference(owner_repo: str, number: int) -> tuple[str, str, int]:
    if not isinstance(owner_repo, str) or not _REPO_RE.match(owner_repo):
        raise GitHubConfigurationError(f"bad repository reference: {owner_repo!r}")
    if not isinstance(number, int) or isinstance(number, bool) or number <= 0:
        raise GitHubConfigurationError(f"bad issue number: {number!r}")
    parts = owner_repo.split("/")
    if len(parts) != 2 or any(p in (".", "..", "") for p in parts):
        raise GitHubConfigurationError(f"bad repository reference: {owner_repo!r}")
    owner, repo = parts
    return owner, repo, number


def _rate_exhausted(response: httpx.Response) -> bool:
    return str(response.headers.get("X-RateLimit-Remaining")) == "0"


def fetch_github_issue(
    owner_repo: str,
    number: int,
    token_env: str = "",
    transport: httpx.BaseTransport | None = None,
    resolver: Callable[[str], list[str]] | None = None,
) -> dict[str, Any]:
    """Fetch one issue as untrusted data. Returns title/body/labels/state/urls."""
    owner, repo, num = validate_reference(owner_repo, number)
    token = resolve_token(token_env)
    headers = {
        "Accept": "application/vnd.github+json",
        "User-Agent": "nerdbot-fetch/0.1",
        "X-GitHub-Api-Version": "2022-11-28",
    }
    if token:
        headers["Authorization"] = f"Bearer {token}"
    url = f"{GITHUB_API_BASE}/repos/{owner}/{repo}/issues/{num}"
    fetch_mod.check_url(url, resolver=resolver)
    if transport is None:
        transport = fetch_mod.PinnedTransport(
            resolver=resolver, timeout_s=TIMEOUT_S, max_bytes=MAX_BYTES
        )
    client = httpx.Client(follow_redirects=False, timeout=TIMEOUT_S, transport=transport)
    try:
        for _ in range(fetch_mod.DEFAULT_MAX_REDIRECTS + 1):
            try:
                response = client.get(url, headers=headers)
            except httpx.TimeoutException as exc:
                raise fetch_mod.FetchTimeoutError(f"github fetch timed out: {exc}") from exc
            except httpx.TransportError as exc:
                raise GitHubProtocolError(f"github fetch failed: {exc}") from exc
            if response.status_code in (301, 302, 303, 307, 308):
                location = response.headers.get("location", "")
                if not location:
                    raise GitHubProtocolError("redirect without location")
                nxt = _join(url, location)
                if _host_of(nxt) != GITHUB_API_HOST:
                    raise fetch_mod.FetchBlockedError("redirect leaves api.github.com")
                url = fetch_mod.check_url(nxt, resolver=resolver)
                continue
            if response.status_code == 404:
                raise GitHubNotFoundError(f"issue not found: {owner_repo}#{num}")
            if response.status_code == 401:
                raise GitHubAuthError("github rejected credentials (HTTP 401)")
            if response.status_code == 429 or (
                response.status_code == 403 and _rate_exhausted(response)
            ):
                raise GitHubRateLimitError("github rate limit exhausted")
            if response.status_code == 403:
                raise GitHubAuthError("github forbade access (HTTP 403)")
            if response.status_code != 200:
                raise GitHubProtocolError(
                    f"unexpected github status (HTTP {response.status_code})"
                )
            if len(response.content) > MAX_BYTES:
                raise fetch_mod.FetchTooLargeError(
                    f"github response exceeds cap {MAX_BYTES} bytes"
                )
            try:
                data = response.json()
            except ValueError as exc:
                raise GitHubProtocolError(f"github response is not JSON: {exc}") from exc
            return _to_issue(owner_repo, num, data, token is not None and token != "")
        raise GitHubProtocolError("too many redirects")
    finally:
        client.close()


def _host_of(url: str) -> str:
    return (urlparse(url).hostname or "").lower()


def _join(base: str, location: str) -> str:
    return urljoin(base, location)


def _to_issue(
    owner_repo: str, number: int, data: Any, authenticated: bool
) -> dict[str, Any]:
    if not isinstance(data, dict):
        raise GitHubProtocolError("github issue payload is not an object")
    labels = data.get("labels") or []
    names = [label.get("name", "") for label in labels if isinstance(label, dict)]
    return {
        "repository": owner_repo,
        "number": number,
        "title": str(data.get("title") or ""),
        "body": str(data.get("body") or ""),
        "labels": names,
        "state": str(data.get("state") or ""),
        "url": str(data.get("html_url") or ""),
        "authenticated": authenticated,
        "untrusted": True,
        "suggested_ingest": {
            "title": str(data.get("title") or ""),
            "body": str(data.get("body") or ""),
            "labels": names,
            "source": "github",
            "external_id": f"{owner_repo}#{number}",
        },
    }


def github_status() -> dict[str, Any]:
    return {
        "configured": True,
        "host": GITHUB_API_HOST,
        "mode": "read-only issue fetch; unauthenticated or env-referenced token",
        "manual_fallback": "POST /projects/{project_id}/issues",
    }
