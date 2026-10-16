"""GitHub issue fetch: mock transport only, no live network."""

from __future__ import annotations

import json

import httpx
import pytest
from fastapi.testclient import TestClient

from nerdbot import fetch as fetch_mod
from nerdbot.api import create_app
from nerdbot.integrations import github as gh
from nerdbot.integrations.github import (
    GitHubAuthError,
    GitHubConfigurationError,
    GitHubNotFoundError,
    GitHubProtocolError,
    GitHubRateLimitError,
    fetch_github_issue,
)

TOKEN = "github-token"
AUTH = {"Authorization": f"Bearer {TOKEN}"}
SECRET = "ghp_SUPERSEKRET"
RESOLVER = {"api.github.com": ["140.82.121.6"]}


@pytest.fixture()
def app_client(tmp_path, monkeypatch):
    monkeypatch.setenv("NERDBOT_TOKEN", TOKEN)
    monkeypatch.setenv("NERDBOT_DB", str(tmp_path / "gh.db"))
    monkeypatch.setenv("NERDBOT_DATA", str(tmp_path / "data"))
    return TestClient(create_app())


def _resolver(host: str) -> list[str]:
    if host not in RESOLVER:
        raise AssertionError(f"unexpected DNS for {host!r} (no live network in tests)")
    return RESOLVER[host]


def _transport(handler) -> httpx.MockTransport:  # type: ignore[no-untyped-def]
    return httpx.MockTransport(handler)


def _issue_payload(**overrides) -> dict:
    payload = {
        "title": "Bug title",
        "body": "Steps <script>alert(1)</script>",
        "labels": [{"name": "bug"}, {"name": "p1"}],
        "state": "open",
        "html_url": "https://github.com/o/r/issues/7",
    }
    payload.update(overrides)
    return payload


def test_success_mapping() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.host == "api.github.com"
        assert request.url.path == "/repos/o/r/issues/7"
        assert "Authorization" not in request.headers
        return httpx.Response(200, json=_issue_payload())

    issue = fetch_github_issue("o/r", 7, transport=_transport(handler), resolver=_resolver)
    assert issue["title"] == "Bug title"
    assert issue["labels"] == ["bug", "p1"]
    assert issue["state"] == "open"
    assert issue["authenticated"] is False
    assert issue["untrusted"] is True
    assert issue["suggested_ingest"]["external_id"] == "o/r#7"
    assert issue["suggested_ingest"]["source"] == "github"


def test_authenticated_mode_sends_token() -> None:
    seen: dict = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen["auth"] = request.headers.get("Authorization")
        return httpx.Response(200, json=_issue_payload())

    import os

    os.environ["GH_TEST_TOKEN"] = SECRET
    try:
        issue = fetch_github_issue("o/r", 7, token_env="GH_TEST_TOKEN",
                                   transport=_transport(handler), resolver=_resolver)
    finally:
        del os.environ["GH_TEST_TOKEN"]
    assert seen["auth"] == f"Bearer {SECRET}"
    assert issue["authenticated"] is True
    dumped = json.dumps(issue)
    assert SECRET not in dumped


def test_status_mapping() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(404, json={"message": "nf"})

    with pytest.raises(GitHubNotFoundError):
        fetch_github_issue("o/r", 9, transport=_transport(handler), resolver=_resolver)

    def auth(request: httpx.Request) -> httpx.Response:
        return httpx.Response(401, json={})

    with pytest.raises(GitHubAuthError):
        fetch_github_issue("o/r", 9, transport=_transport(auth), resolver=_resolver)

    def forbidden(request: httpx.Request) -> httpx.Response:
        return httpx.Response(403, json={})

    with pytest.raises(GitHubAuthError):
        fetch_github_issue("o/r", 9, transport=_transport(forbidden), resolver=_resolver)

    def limited(request: httpx.Request) -> httpx.Response:
        return httpx.Response(403, json={}, headers={"X-RateLimit-Remaining": "0"})

    with pytest.raises(GitHubRateLimitError):
        fetch_github_issue("o/r", 9, transport=_transport(limited), resolver=_resolver)

    def limited2(request: httpx.Request) -> httpx.Response:
        return httpx.Response(429, json={})

    with pytest.raises(GitHubRateLimitError):
        fetch_github_issue("o/r", 9, transport=_transport(limited2), resolver=_resolver)

    def broken(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, text="not json")

    with pytest.raises(GitHubProtocolError):
        fetch_github_issue("o/r", 9, transport=_transport(broken), resolver=_resolver)

    def server(request: httpx.Request) -> httpx.Response:
        return httpx.Response(500, json={})

    with pytest.raises(GitHubProtocolError):
        fetch_github_issue("o/r", 9, transport=_transport(server), resolver=_resolver)


def test_redirects_same_host_only() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/repos/o/r/issues/7":
            return httpx.Response(301, headers={"location": "/repos/o/r/issues/8"})
        return httpx.Response(200, json=_issue_payload())

    issue = fetch_github_issue("o/r", 7, transport=_transport(handler), resolver=_resolver)
    assert issue["title"] == "Bug title"

    def offsite(request: httpx.Request) -> httpx.Response:
        return httpx.Response(301, headers={"location": "https://evil.example/x"})

    with pytest.raises(fetch_mod.FetchBlockedError):
        fetch_github_issue("o/r", 7, transport=_transport(offsite), resolver=_resolver)

    def loop(request: httpx.Request) -> httpx.Response:
        return httpx.Response(301, headers={"location": "/repos/o/r/issues/7"})

    with pytest.raises(GitHubProtocolError, match="too many redirects"):
        fetch_github_issue("o/r", 7, transport=_transport(loop), resolver=_resolver)


def test_size_and_timeout_caps() -> None:
    def big(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, content=b"z" * (gh.MAX_BYTES + 10))

    with pytest.raises(fetch_mod.FetchTooLargeError):
        fetch_github_issue("o/r", 7, transport=_transport(big), resolver=_resolver)

    def slow(request: httpx.Request) -> httpx.Response:
        raise httpx.TimeoutException("slow", request=request)

    with pytest.raises(fetch_mod.FetchTimeoutError):
        fetch_github_issue("o/r", 7, transport=_transport(slow), resolver=_resolver)


def test_reference_validation() -> None:
    for bad_repo in ("", "nope", "o/r/x", "../x", "o r", "o/r "):
        with pytest.raises(GitHubConfigurationError):
            fetch_github_issue(bad_repo, 1, resolver=_resolver)
    for bad_num in (0, -3, True, "7"):  # type: ignore[arg-type]
        with pytest.raises(GitHubConfigurationError):
            fetch_github_issue("o/r", bad_num, resolver=_resolver)
    with pytest.raises(GitHubConfigurationError):
        fetch_github_issue("o/r", 1, token_env="NERDBOT_TOKEN", resolver=_resolver)


def test_preview_endpoint_wiring(app_client: TestClient, monkeypatch) -> None:
    pid = app_client.post("/projects", json={}, headers=AUTH).json()["id"]
    preview = {"title": "T", "body": "B", "labels": [], "suggested_ingest": {
        "title": "T", "body": "B", "labels": [], "source": "github", "external_id": "o/r#1"}}

    def fake_fetch(repository: str, number: int, token_env: str = "") -> dict:
        assert (repository, number, token_env) == ("o/r", 1, "")
        return preview  # type: ignore[return-value]

    monkeypatch.setattr("nerdbot.api.fetch_github_issue", fake_fetch)
    r = app_client.post(f"/projects/{pid}/github/preview",
                        json={"repository": "o/r", "number": 1}, headers=AUTH)
    assert r.status_code == 200 and r.json()["title"] == "T"

    # Preview-then-ingest through the existing manual path.
    r = app_client.post(f"/projects/{pid}/issues", json=preview["suggested_ingest"], headers=AUTH)
    assert r.status_code == 200, r.text
    assert r.json()["source"] == "github" and r.json()["external_id"] == "o/r#1"

    # Error mapping through the endpoint.
    for exc, status in ((GitHubNotFoundError("nf"), 404), (GitHubAuthError("a"), 401),
                        (GitHubRateLimitError("rl"), 429), (GitHubProtocolError("p"), 502),
                        (GitHubConfigurationError("c"), 400)):
        def raiser(repository: str, number: int, token_env: str = "",
                   _exc: Exception = exc) -> dict:
            raise _exc

        monkeypatch.setattr("nerdbot.api.fetch_github_issue", raiser)
        r = app_client.post(f"/projects/{pid}/github/preview",
                            json={"repository": "o/r", "number": 1}, headers=AUTH)
        assert r.status_code == status, (exc, r.text)
    r = app_client.post(f"/projects/{pid}/github/preview",
                        json={"repository": "o/r", "number": "x"}, headers=AUTH)
    assert r.status_code == 400
    bad = {"Authorization": "Bearer wrong"}
    assert app_client.post(f"/projects/{pid}/github/preview",
                           json={"repository": "o/r", "number": 1}, headers=bad).status_code == 403


def test_capability_ready(app_client: TestClient) -> None:
    caps = {c["id"]: c for c in app_client.get("/capabilities", headers=AUTH).json()["capabilities"]}
    assert caps["github.fetch"]["status"] == "ready"
