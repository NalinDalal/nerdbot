"""BYOK slice (design S1): encrypted at rest, fingerprinted reads, updates,
and model catalog — store-level and endpoint-level, no live network."""

from __future__ import annotations

import sqlite3

import httpx
import pytest
from cryptography.fernet import Fernet
from fastapi.testclient import TestClient

from nerdbot import providers as providers_impl
from nerdbot import secrets as secrets_mod
from nerdbot import store
from nerdbot.api import create_app


@pytest.fixture()
def secret_key_env(monkeypatch):  # type: ignore[no-untyped-def]
    key = Fernet.generate_key().decode("ascii")
    monkeypatch.setenv("NERDBOT_SECRET_KEY", key)
    return key


def _client(tmp_path, monkeypatch) -> TestClient:  # type: ignore[no-untyped-def]
    monkeypatch.setenv("NERDBOT_TOKEN", "tok")
    monkeypatch.setenv("NERDBOT_DB", str(tmp_path / "byok.db"))
    monkeypatch.setenv("NERDBOT_DATA", str(tmp_path / "data"))
    return TestClient(create_app(), headers={"Authorization": "Bearer tok"})


def _project(client: TestClient) -> str:
    return client.post("/projects", json={}).json()["id"]


# -- endpoint-level BYOK behavior ---------------------------------------------


def test_byok_create_stores_ciphertext_and_returns_fingerprint(
    tmp_path, monkeypatch, secret_key_env
) -> None:
    client = _client(tmp_path, monkeypatch)
    pid = _project(client)
    r = client.post(
        f"/projects/{pid}/providers",
        json={
            "kind": "openai-compatible",
            "name": "groq",
            "config": {
                "base_url": "https://api.groq.com/openai/v1",
                "model": "openai/gpt-oss-120b",
                "api_key": "gsk_secretsecretsecret9999",
            },
        },
    )
    assert r.status_code == 200, r.text
    prov = r.json()
    # fingerprinted, never plaintext, never ciphertext envelope
    assert prov["config"]["api_key"].startswith("****")
    assert prov["config"]["api_key"].endswith("9999")
    assert "enc:" not in prov["config"]["api_key"]
    assert prov["config"]["api_key"].count("secretsecret") == 0

    # at rest: ciphertext only
    conn = sqlite3.connect(str(tmp_path / "byok.db"))
    raw = conn.execute("SELECT config FROM providers WHERE id=?", (prov["id"],)).fetchone()[0]
    conn.close()
    assert "gsk_secretsecretsecret9999" not in raw
    assert "enc:1:" in raw

    # usable end-to-end: resolve_api_key decrypts back to the plaintext
    loaded = store.get_provider(store.connect(str(tmp_path / "byok.db")), prov["id"])
    assert loaded is not None
    assert providers_impl.resolve_api_key(loaded.config) == "gsk_secretsecretsecret9999"


def test_byok_create_fails_closed_without_secret_key(tmp_path, monkeypatch) -> None:
    monkeypatch.delenv("NERDBOT_SECRET_KEY", raising=False)
    monkeypatch.delenv("NERDBOT_SECRET_KEY_PREVIOUS", raising=False)
    client = _client(tmp_path, monkeypatch)
    pid = _project(client)
    r = client.post(
        f"/projects/{pid}/providers",
        json={
            "kind": "openai-compatible",
            "config": {"base_url": "https://x/v1", "model": "m", "api_key": "sk-plain"},
        },
    )
    assert r.status_code == 400, r.text
    assert "NERDBOT_SECRET_KEY" in r.json()["detail"]


def test_keyless_non_secret_config_still_allowed(tmp_path, monkeypatch) -> None:
    monkeypatch.delenv("NERDBOT_SECRET_KEY", raising=False)
    client = _client(tmp_path, monkeypatch)
    pid = _project(client)
    r = client.post(
        f"/projects/{pid}/providers",
        json={
            "kind": "openai-compatible",
            "config": {
                "base_url": "https://api.groq.com/openai/v1",
                "model": "m",
                "api_key_env": "CLOUD_MODEL_KEY",
            },
        },
    )
    assert r.status_code == 200, r.text
    assert r.json()["config"]["api_key_env"] == "CLOUD_MODEL_KEY"


def test_byok_patch_rotates_key_and_updates_model(
    tmp_path, monkeypatch, secret_key_env
) -> None:
    client = _client(tmp_path, monkeypatch)
    pid = _project(client)
    made = client.post(
        f"/projects/{pid}/providers",
        json={
            "kind": "openai-compatible",
            "name": "groq",
            "config": {"base_url": "https://api.groq.com/openai/v1", "api_key": "gsk_abcdefgh12345678"},
        },
    ).json()
    r = client.patch(
        f"/providers/{made['id']}",
        json={
            "name": "groq-renamed",
            "config": {"model": "openai/gpt-oss-20b", "api_key": "gsk_newkeynewkey0000"},
        },
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["name"] == "groq-renamed"
    assert body["config"]["model"] == "openai/gpt-oss-20b"
    assert body["config"]["api_key"] == "****0000"
    # base_url survived the partial patch
    assert body["config"]["base_url"] == "https://api.groq.com/openai/v1"

    conn = sqlite3.connect(str(tmp_path / "byok.db"))
    raw = conn.execute("SELECT config FROM providers WHERE id=?", (made["id"],)).fetchone()[0]
    conn.close()
    assert "gsk_abcdefgh12345678" not in raw  # old key gone
    assert "gsk_newkeynewkey0000" not in raw  # new key never plaintext


def test_patch_status_toggle(tmp_path, monkeypatch, secret_key_env) -> None:
    client = _client(tmp_path, monkeypatch)
    pid = _project(client)
    made = client.post(
        f"/projects/{pid}/providers",
        json={"kind": "openai-compatible", "config": {"base_url": "https://x/v1"}},
    ).json()
    r = client.patch(f"/providers/{made['id']}", json={"status": "disabled"})
    assert r.status_code == 200, r.text
    assert r.json()["status"] == "disabled"


def _patch_models_transport(monkeypatch, handler) -> None:  # type: ignore[no-untyped-def]
    """Route list_upstream_models' HTTP through a mock handler (no live net)."""
    real_client = httpx.Client  # captured BEFORE patching: factory must not recurse

    def factory(**kwargs):  # type: ignore[no-untyped-def]
        if kwargs.get("transport") is None:
            kwargs["transport"] = httpx.MockTransport(handler)
        return real_client(**kwargs)

    monkeypatch.setattr(providers_impl.httpx, "Client", factory)


def test_models_endpoint_parses_catalog(tmp_path, monkeypatch, secret_key_env) -> None:
    captured: dict[str, str] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured["auth"] = request.headers.get("authorization", "")
        captured["url"] = str(request.url)
        return httpx.Response(
            200,
            json={"data": [{"id": "b-model"}, {"id": "a-model"}, {"bogus": 1}],
                  "extra": "ignored"},
        )

    _patch_models_transport(monkeypatch, handler)
    client = _client(tmp_path, monkeypatch)
    pid = _project(client)
    made = client.post(
        f"/projects/{pid}/providers",
        json={
            "kind": "openai-compatible",
            "config": {"base_url": "https://api.groq.com/openai/v1",
                       "api_key": "gsk_probe____________"},
        },
    ).json()
    r = client.get(f"/providers/{made['id']}/models")
    assert r.status_code == 200, r.text
    assert r.json()["models"] == ["a-model", "b-model"]
    assert captured["auth"].startswith("Bearer gsk_")
    assert captured["url"] == "https://api.groq.com/openai/v1/models"


def test_models_endpoint_upstream_failure_maps_502(
    tmp_path, monkeypatch, secret_key_env
) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(500, text="boom")

    _patch_models_transport(monkeypatch, handler)
    client = _client(tmp_path, monkeypatch)
    pid = _project(client)
    made = client.post(
        f"/projects/{pid}/providers",
        json={
            "kind": "openai-compatible",
            "config": {"base_url": "https://api.groq.com/openai/v1",
                       "api_key": "gsk_probe____________"},
        },
    ).json()
    r = client.get(f"/providers/{made['id']}/models")
    assert r.status_code == 502, r.text


def test_health_reports_secret_key_state(tmp_path, monkeypatch, secret_key_env) -> None:
    client = _client(tmp_path, monkeypatch)
    h = client.get("/health")
    assert h.status_code == 200
    assert h.json()["secret_key"] == "configured"
    monkeypatch.delenv("NERDBOT_SECRET_KEY", raising=False)
    client2 = _client(tmp_path, monkeypatch)
    h2 = client2.get("/health")
    assert h2.json()["secret_key"] == "absent"


# -- store-level: rotation integrity ------------------------------------------


def test_update_provider_requires_known_id(tmp_path) -> None:
    conn = store.connect(str(tmp_path / "p.db"))
    with pytest.raises(KeyError):
        store.update_provider(conn, "prv_missing")
    conn.close()


def test_secret_mask_helpers() -> None:
    assert secrets_mod.mask("sk-1234567890abcd") == "****abcd"
    assert secrets_mod.mask("short") == "****"
    assert secrets_mod.mask("") == "[unset]"
    assert secrets_mod.mask_stored("sk-plain-value9999") == "****9999"


# -- review fixes (ses_eb6109c32ffeoaS3Lh6dijBuaB blockers) --------------------


def test_non_string_secret_refused_not_stored_in_the_clear(
    tmp_path, monkeypatch, secret_key_env
) -> None:
    """Reviewer blocker 1: secret-shaped keys with non-string values bypassed
    both encryption and masking. Now refused at write (400), and legacy rows
    with such values are masked, never echoed raw."""
    client = _client(tmp_path, monkeypatch)
    pid = _project(client)
    r = client.post(
        f"/projects/{pid}/providers",
        json={
            "kind": "openai-compatible",
            "config": {
                "base_url": "https://x/v1",
                "api_key": {"note": "sk-real-key-inside"},
            },
        },
    )
    assert r.status_code == 400, r.text
    assert "must be a string" in r.json()["detail"]

    r2 = client.post(
        f"/projects/{pid}/providers",
        json={
            "kind": "openai-compatible",
            "config": {"base_url": "https://x/v1", "token": 12345},
        },
    )
    assert r2.status_code == 400, r2.text

    # legacy row with a non-string secret: GET masks it, raw value never served
    conn = sqlite3.connect(str(tmp_path / "byok.db"))
    conn.execute(
        "INSERT INTO providers (id, project_id, kind, name, config, capabilities, status, created_at)"
        " VALUES (?, ?, 'openai-compatible', '', '{\"api_key_env\": \"K\", \"secret\": {\"leaky\": 1}}',"
        " '[]', 'active', '2026-01-01T00:00:00+00:00')",
        ("prv_legacy", pid),
    )
    conn.commit()
    conn.close()
    got = client.get("/providers/prv_legacy")
    assert got.status_code == 200, got.text
    cfg = got.json()["config"]
    assert cfg["secret"] == "[redacted]"
    assert "leaky" not in got.text


def test_patch_round_tripping_fingerprint_refused(
    tmp_path, monkeypatch, secret_key_env
) -> None:
    """Reviewer blocker 2: a GET→PATCH round trip used to silently encrypt the
    fingerprint '****1234' as if it were a real key. Now 400, actionable."""
    client = _client(tmp_path, monkeypatch)
    pid = _project(client)
    made = client.post(
        f"/projects/{pid}/providers",
        json={
            "kind": "openai-compatible",
            "config": {"base_url": "https://x/v1", "api_key": "gsk_realrealreal1111"},
        },
    ).json()
    assert made["config"]["api_key"] == "****1111"
    r = client.patch(f"/providers/{made['id']}", json={"config": {"api_key": "****1111"}})
    assert r.status_code == 400, r.text
    assert "looks like a redaction/fingerprint" in r.json()["detail"]
    # sentinel-style redaction strings equally refused
    r2 = client.patch(f"/providers/{made['id']}", json={"config": {"api_key": "[redacted]"}})
    assert r2.status_code == 400, r2.text


def test_patch_teammate_provider_id_null_detaches(
    tmp_path, monkeypatch, secret_key_env
) -> None:
    """Reviewer blocker 3: PATCH provider_id: null used to be a no-op (absent
    and null were indistinguishable server-side). Now null truly detaches."""
    client = _client(tmp_path, monkeypatch)
    pid = _project(client)
    prov = client.post(
        f"/projects/{pid}/providers",
        json={
            "kind": "openai-compatible",
            "name": "groq",
            "config": {"base_url": "https://api.groq.com/openai/v1", "api_key": "gsk_probe____________"},
        },
    ).json()
    mate = client.post(f"/projects/{pid}/teammates", json={"persona": "ceo"}).json()
    att = client.patch(f"/teammates/{mate['id']}", json={"provider_id": prov["id"]})
    assert att.status_code == 200, att.text
    mate = att.json()
    assert mate["provider_id"] == prov["id"]

    # absent field = no change
    same = client.patch(f"/teammates/{mate['id']}", json={"persona": "ceo2"})
    assert same.json()["provider_id"] == prov["id"]
    # explicit null = detach
    det = client.patch(f"/teammates/{mate['id']}", json={"provider_id": None})
    assert det.status_code == 200, det.text
    assert det.json()["provider_id"] is None


def test_base_url_must_be_http_s(tmp_path, monkeypatch, secret_key_env) -> None:
    """Review followup 4 (cheap part): the model catalog refuses non-http(s)
    base_urls instead of handing the bearer key to whatever scheme."""
    client = _client(tmp_path, monkeypatch)
    pid = _project(client)
    made = client.post(
        f"/projects/{pid}/providers",
        json={
            "kind": "openai-compatible",
            "config": {"base_url": "file:///etc", "api_key": "gsk_probe____________"},
        },
    ).json()
    r = client.get(f"/providers/{made['id']}/models")
    assert r.status_code == 400, r.text
    assert "http(s) URL" in r.json()["detail"]
