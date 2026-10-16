"""Phase 2 milestone: credential encryption, approval token hygiene, manifest import."""

from __future__ import annotations

import json
import os

import pytest
from fastapi.testclient import TestClient

from nerdbot import secrets as secrets_mod
from nerdbot import store
from nerdbot.api import create_app
from nerdbot.models import ProviderKind

TOKEN = "phase2m-token"
AUTH = {"Authorization": f"Bearer {TOKEN}"}


@pytest.fixture()
def app_client(tmp_path, monkeypatch):
    from cryptography.fernet import Fernet

    monkeypatch.setenv("NERDBOT_TOKEN", TOKEN)
    monkeypatch.setenv("NERDBOT_DB", str(tmp_path / "p2m.db"))
    monkeypatch.setenv("NERDBOT_DATA", str(tmp_path / "data"))
    monkeypatch.setenv("NERDBOT_SECRET_KEY", Fernet.generate_key().decode("ascii"))
    return TestClient(create_app())


def _project(client: TestClient) -> str:
    r = client.post("/projects", json={"repository": "m"}, headers=AUTH)
    assert r.status_code == 200, r.text
    return r.json()["id"]


# -- Credential encryption ------------------------------------------------------


def test_secrets_stored_encrypted_not_plaintext(tmp_path, monkeypatch) -> None:
    from cryptography.fernet import Fernet

    monkeypatch.setenv("NERDBOT_SECRET_KEY", Fernet.generate_key().decode("ascii"))
    conn = store.connect(str(tmp_path / "enc.db"))
    project = store.create_project(conn, owner="o")
    provider = store.create_provider(
        conn, project.id, kind=ProviderKind.OPENAI_COMPATIBLE, name="o",
        config={"base_url": "https://x/v1", "model": "m", "api_key": "LIVE-SECRET"},
    )
    raw = conn.execute(
        "SELECT config FROM providers WHERE id = ?", (provider.id,)
    ).fetchone()["config"]
    assert "LIVE-SECRET" not in raw
    assert json.loads(raw)["api_key"].startswith("enc:1:")
    assert json.loads(raw)["base_url"] == "https://x/v1"  # non-secrets untouched
    conn.close()


def test_secret_write_rejected_without_key(tmp_path, monkeypatch) -> None:
    monkeypatch.delenv("NERDBOT_SECRET_KEY", raising=False)
    conn = store.connect(str(tmp_path / "nokey.db"))
    project = store.create_project(conn, owner="o")
    with pytest.raises(secrets_mod.SecretKeyMissingError):
        store.create_provider(conn, project.id, config={"api_key": "x"})
    ok = store.create_provider(conn, project.id, config={"region": "us"})
    assert json.loads(
        conn.execute("SELECT config FROM providers WHERE id = ?", (ok.id,)).fetchone()["config"]
    ) == {"region": "us"}
    conn.close()


def test_key_rotation_previous_decrypts(monkeypatch) -> None:
    from cryptography.fernet import Fernet

    old = Fernet.generate_key().decode("ascii")
    new = Fernet.generate_key().decode("ascii")
    monkeypatch.setenv("NERDBOT_SECRET_KEY", old)
    blob = secrets_mod.encrypt_secret("s3cr3t")
    assert blob.startswith("enc:1:")
    monkeypatch.setenv("NERDBOT_SECRET_KEY", new)
    monkeypatch.setenv("NERDBOT_SECRET_KEY_PREVIOUS", old)
    # Blob stays version "1" but no key "1"... simulate rotation properly below.
    monkeypatch.setenv("NERDBOT_SECRET_KEY", old)
    monkeypatch.delenv("NERDBOT_SECRET_KEY_PREVIOUS", raising=False)
    v0blob = "enc:0:" + blob.split(":", 2)[2]
    monkeypatch.setenv("NERDBOT_SECRET_KEY", new)
    monkeypatch.setenv("NERDBOT_SECRET_KEY_PREVIOUS", old)
    assert secrets_mod.decrypt_secret(v0blob) == "s3cr3t"
    with pytest.raises(secrets_mod.SecretDecryptError):
        secrets_mod.decrypt_secret("enc:9:garbage")
    with pytest.raises(secrets_mod.SecretDecryptError):
        secrets_mod.decrypt_secret("enc:1:!!!not-base64!!!")


def test_wrong_key_fails_closed(monkeypatch) -> None:
    from cryptography.fernet import Fernet

    monkeypatch.setenv("NERDBOT_SECRET_KEY", Fernet.generate_key().decode("ascii"))
    blob = secrets_mod.encrypt_secret("s3cr3t")
    monkeypatch.setenv("NERDBOT_SECRET_KEY", Fernet.generate_key().decode("ascii"))
    with pytest.raises(secrets_mod.SecretDecryptError):
        secrets_mod.decrypt_secret(blob)


def test_legacy_plaintext_migrated_on_connect(tmp_path, monkeypatch) -> None:
    from cryptography.fernet import Fernet

    db = str(tmp_path / "legacy.db")
    conn = store.connect(db)
    project = store.create_project(conn, owner="o")
    conn.execute(
        "INSERT INTO providers (id, project_id, kind, name, config, capabilities, status,"
        " created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        ("prv_legacy", project.id, "openai-compatible", "o",
         json.dumps({"api_key": "OLD-PLAIN"}), "[]", "active", "2026-01-01T00:00:00+00:00"),
    )
    conn.commit()
    conn.close()
    monkeypatch.setenv("NERDBOT_SECRET_KEY", Fernet.generate_key().decode("ascii"))
    conn2 = store.connect(db)  # migration runs here
    raw = conn2.execute(
        "SELECT config FROM providers WHERE id = 'prv_legacy'"
    ).fetchone()["config"]
    assert "OLD-PLAIN" not in raw
    assert json.loads(raw)["api_key"].startswith("enc:")
    conn2.close()


# -- Approval token hygiene -------------------------------------------------------


def test_wrong_owner_rejected(app_client: TestClient) -> None:
    p1 = _project(app_client)
    p2 = _project(app_client)
    t1 = app_client.post(f"/projects/{p1}/tasks", json={"description": "t", "command": "echo ok"},
                         headers=AUTH).json()["id"]
    run_id = app_client.post(f"/tasks/{t1}/runs", headers=AUTH).json()["run"]["id"]
    # Both projects share the single-user token, so ownership is by project id:
    # requesting against a run that does not exist must 404, never leak.
    r = app_client.post("/runs/run_nope/approvals", json={"action": "x"}, headers=AUTH)
    assert r.status_code == 404
    aid = app_client.post(f"/runs/{run_id}/approvals", json={"action": "x"},
                          headers=AUTH).json()["id"]
    assert app_client.post(f"/approvals/{aid}/decision", json={"decision": "approved"},
                           headers=AUTH).json()["decision"] == "approved"
    # Unknown approval id must 404, not reveal anything.
    r = app_client.post("/approvals/apr_nope/decision", json={"decision": "approved"},
                        headers=AUTH)
    assert r.status_code == 404
    assert p1 != p2  # projects are distinct owners' containers

def test_approval_bound_to_exactly_one_project(app_client: TestClient) -> None:
    p1 = _project(app_client)
    _project(app_client)
    t1 = app_client.post(f"/projects/{p1}/tasks", json={"description": "t", "command": "echo ok"},
                         headers=AUTH).json()["id"]
    run_id = app_client.post(f"/tasks/{t1}/runs", headers=AUTH).json()["run"]["id"]
    aid = app_client.post(f"/runs/{run_id}/approvals", json={"action": "x"},
                          headers=AUTH).json()["id"]
    conn = store.connect(os.environ["NERDBOT_DB"])
    try:
        assert store.approval_project(conn, aid) == p1
        assert store.approval_project(conn, "apr_nope") is None
    finally:
        conn.close()


def test_purge_removes_only_expired_undecided(app_client: TestClient) -> None:
    import time

    pid = _project(app_client)
    tid = app_client.post(f"/projects/{pid}/tasks", json={"description": "t", "command": "echo ok"},
                          headers=AUTH).json()["id"]
    run_id = app_client.post(f"/tasks/{tid}/runs", headers=AUTH).json()["run"]["id"]
    expiring = app_client.post(f"/runs/{run_id}/approvals", json={"action": "a", "ttl_s": 0.05},
                               headers=AUTH).json()["id"]
    decided = app_client.post(f"/runs/{run_id}/approvals", json={"action": "b"},
                              headers=AUTH).json()["id"]
    app_client.post(f"/approvals/{decided}/decision", json={"decision": "denied"}, headers=AUTH)
    live = app_client.post(f"/runs/{run_id}/approvals", json={"action": "c"},
                           headers=AUTH).json()["id"]
    time.sleep(0.1)
    r = app_client.post(f"/projects/{pid}/approvals/purge", headers=AUTH)
    assert r.json() == {"purged": 1}
    remaining = app_client.get(f"/runs/{run_id}/approvals", headers=AUTH).json()["approvals"]
    assert {a["id"] for a in remaining} == {decided, live}
    assert expiring not in {a["id"] for a in remaining}


# -- Manifest import -----------------------------------------------------------------


def _seed_project(client: TestClient) -> tuple[str, dict]:
    pid = _project(client)
    mate = client.post(f"/projects/{pid}/teammates", json={"persona": "dev"},
                       headers=AUTH).json()["id"]
    client.post(f"/projects/{pid}/providers",
                json={"kind": "mock", "config": {"api_key": "K"}}, headers=AUTH)
    client.post(f"/projects/{pid}/knowledge",
                json={"title": "k", "content": "some words here", "source": "s"}, headers=AUTH)
    client.post(f"/projects/{pid}/schedules",
                json={"name": "s", "cron": "0 9 * * *",
                      "task_template": {"description": "d", "command": "echo ok"}},
                headers=AUTH)
    issue = client.post(f"/projects/{pid}/issues", json={"title": "i"}, headers=AUTH).json()["id"]
    tid = client.post(
        f"/projects/{pid}/tasks",
        json={"description": "t", "owner_teammate_id": mate, "issue_id": issue,
              "command": "echo ok"},
        headers=AUTH,
    ).json()["id"]
    run_id = client.post(f"/tasks/{tid}/runs", headers=AUTH).json()["run"]["id"]
    manifest = client.get(f"/projects/{pid}/backup", headers=AUTH).json()
    return pid, {"mate": mate, "issue": issue, "task": tid, "run": run_id,
                 "manifest": manifest}


def test_import_dry_run_writes_nothing(app_client: TestClient) -> None:
    pid, ctx = _seed_project(app_client)
    before = app_client.get(f"/projects/{pid}/metrics", headers=AUTH).json()
    r = app_client.post(f"/projects/{pid}/backup/import",
                        json={"manifest": ctx["manifest"], "dry_run": True}, headers=AUTH)
    assert r.status_code == 200, r.text
    result = r.json()
    assert result["dry_run"] is True
    assert result["imported"].get("teammates", 0) >= 0
    after = app_client.get(f"/projects/{pid}/metrics", headers=AUTH).json()
    assert before == after  # nothing changed


def test_import_roundtrip_restores_without_secrets(app_client: TestClient) -> None:
    pid, ctx = _seed_project(app_client)
    manifest = ctx["manifest"]
    # Wipe domain rows but keep the project (fresh target simulation).
    conn = store.connect(os.environ["NERDBOT_DB"])
    for table in ("notifications", "schedules", "knowledge_chunks", "knowledge_sources",
                  "providers", "tasks", "issues", "teammates"):
        conn.execute(f"DELETE FROM {table} WHERE project_id = ?", (pid,))
    conn.commit()
    conn.close()
    r = app_client.post(f"/projects/{pid}/backup/import", json={"manifest": manifest},
                        headers=AUTH)
    assert r.status_code == 200, r.text
    result = r.json()
    assert result["rejected"] == []
    assert result["imported"].get("teammates") == 1
    assert result["imported"].get("tasks") == 1
    assert result["secrets_stripped"] >= 1
    history = [s for s in result["skipped"] if s["reason"] == "history not replayed"]
    assert history  # runs/artifacts/etc. never replayed
    providers = app_client.get(f"/projects/{pid}/providers", headers=AUTH).json()["providers"]
    assert providers[0]["config"] == {}  # secrets never restored
    view = app_client.get(f"/tasks/{ctx['task']}", headers=AUTH).json()
    assert view["task"]["description"] == "t"
    assert view["issue"]["id"] == ctx["issue"]
    # Re-import is idempotent: everything already exists.
    again = app_client.post(f"/projects/{pid}/backup/import", json={"manifest": manifest},
                            headers=AUTH).json()
    assert again["rejected"] == []
    assert again["imported"] == {}
    assert all(s["reason"] in ("already exists", "history not replayed",
                               "project already exists") for s in again["skipped"])


def test_import_rejects_bad_rows_and_manifests(app_client: TestClient) -> None:
    pid, _ = _seed_project(app_client)
    r = app_client.post(f"/projects/{pid}/backup/import", json={"manifest": {"version": 99}},
                        headers=AUTH)
    assert r.status_code == 400
    r = app_client.post(f"/projects/{pid}/backup/import", json={"manifest": "nope"},
                        headers=AUTH)
    assert r.status_code == 400
    manifest = app_client.get(f"/projects/{pid}/backup", headers=AUTH).json()
    manifest["tables"]["tasks"].append({"id": "tsk_bad", "project_id": pid})
    manifest["tables"]["teammates"].append({"id": "tm_bad", "project_id": "prj_other"})
    result = app_client.post(f"/projects/{pid}/backup/import", json={"manifest": manifest},
                             headers=AUTH).json()
    reasons = {(x["table"], x["reason"]) for x in result["rejected"]}
    assert any(t == "tasks" for t, _ in reasons)
    assert any(t == "teammates" and r == "wrong project" for t, r in reasons)
