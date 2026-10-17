"""Fail-closed bearer-token policy (2026-10-17 productionization item 2).

The well-known dev default is valid ONLY with an explicit opt-in; a server
with neither ``NERDBOT_TOKEN`` nor ``NERDBOT_INSECURE_DEV_TOKEN=1`` rejects
every token instead of silently serving a public secret.
"""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from nerdbot import auth
from nerdbot.api import create_app


@pytest.fixture()
def no_token_env(monkeypatch):  # type: ignore[no-untyped-def]
    monkeypatch.delenv("NERDBOT_TOKEN", raising=False)
    monkeypatch.delenv("NERDBOT_INSECURE_DEV_TOKEN", raising=False)


def _client(tmp_path, monkeypatch) -> TestClient:  # type: ignore[no-untyped-def]
    monkeypatch.setenv("NERDBOT_DB", str(tmp_path / "auth.db"))
    monkeypatch.setenv("NERDBOT_DATA", str(tmp_path / "data"))
    return TestClient(create_app())


def test_status_configured(monkeypatch) -> None:  # type: ignore[no-untyped-def]
    monkeypatch.setenv("NERDBOT_TOKEN", "real-token")
    monkeypatch.delenv("NERDBOT_INSECURE_DEV_TOKEN", raising=False)
    assert auth.token_status() == "configured"
    assert auth.expected_token() == "real-token"


def test_status_dev_requires_explicit_opt_in(monkeypatch) -> None:  # type: ignore[no-untyped-def]
    monkeypatch.delenv("NERDBOT_TOKEN", raising=False)
    monkeypatch.delenv("NERDBOT_INSECURE_DEV_TOKEN", raising=False)
    assert auth.token_status() == "closed"
    monkeypatch.setenv("NERDBOT_INSECURE_DEV_TOKEN", "1")
    assert auth.token_status() == "dev"
    assert auth.expected_token() == auth.DEV_DEFAULT_TOKEN


def test_closed_server_rejects_every_token(no_token_env, tmp_path, monkeypatch) -> None:
    client = _client(tmp_path, monkeypatch)
    for presented in (auth.DEV_DEFAULT_TOKEN, "anything-else"):
        r = client.post("/projects", json={}, headers={"Authorization": f"Bearer {presented}"})
        assert r.status_code == 503, (presented, r.status_code, r.text)
        assert "not configured" in r.json()["detail"]
    # missing token still reads as 401 (bearer validation precedes policy)
    assert client.post("/projects", json={}).status_code == 401


def test_dev_opt_in_accepts_only_dev_default(no_token_env, tmp_path, monkeypatch) -> None:
    monkeypatch.setenv("NERDBOT_INSECURE_DEV_TOKEN", "1")
    client = _client(tmp_path, monkeypatch)
    r = client.post(
        "/projects", json={}, headers={"Authorization": f"Bearer {auth.DEV_DEFAULT_TOKEN}"}
    )
    assert r.status_code == 200, r.text
    r = client.post("/projects", json={}, headers={"Authorization": "Bearer wrong"})
    assert r.status_code == 403


def test_configured_token_still_works(tmp_path, monkeypatch) -> None:
    monkeypatch.setenv("NERDBOT_TOKEN", "session-token")
    monkeypatch.delenv("NERDBOT_INSECURE_DEV_TOKEN", raising=False)
    client = _client(tmp_path, monkeypatch)
    r = client.post("/projects", json={}, headers={"Authorization": "Bearer session-token"})
    assert r.status_code == 200, r.text
    r = client.post(
        "/projects", json={}, headers={"Authorization": f"Bearer {auth.DEV_DEFAULT_TOKEN}"}
    )
    assert r.status_code == 403  # dev default is never valid when configured
