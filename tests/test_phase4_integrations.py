"""Phase 4: providers, knowledge, schedules, ingress/notify, backup, observability."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

import pytest
from fastapi.testclient import TestClient

from nerdbot import knowledge as knowledge_mod
from nerdbot import orchestrator, store
from nerdbot.api import create_app

TOKEN = "phase4-token"
AUTH = {"Authorization": f"Bearer {TOKEN}"}


@pytest.fixture()
def app_client(tmp_path, monkeypatch):
    monkeypatch.setenv("NERDBOT_TOKEN", TOKEN)
    monkeypatch.setenv("NERDBOT_DB", str(tmp_path / "p4.db"))
    monkeypatch.setenv("NERDBOT_DATA", str(tmp_path / "data"))
    return TestClient(create_app())


def _project(client: TestClient) -> str:
    r = client.post("/projects", json={"repository": "p4"}, headers=AUTH)
    assert r.status_code == 200, r.text
    return r.json()["id"]


def _teammate(client: TestClient, pid: str, persona: str = "dev") -> str:
    r = client.post(
        f"/projects/{pid}/teammates",
        json={"persona": persona, "instructions": "i"},
        headers=AUTH,
    )
    assert r.status_code == 200, r.text
    return r.json()["id"]


# -- Providers -----------------------------------------------------------------


def _secret_key(monkeypatch) -> None:
    from cryptography.fernet import Fernet

    monkeypatch.setenv("NERDBOT_SECRET_KEY", Fernet.generate_key().decode("ascii"))


def test_provider_lifecycle_and_redaction(app_client: TestClient, monkeypatch) -> None:
    _secret_key(monkeypatch)
    pid = _project(app_client)
    r = app_client.post(
        f"/projects/{pid}/providers",
        json={
            "kind": "mock",
            "name": "m",
            "config": {"api_key": "SECRET", "region": "us"},
            "capabilities": ["fast"],
        },
        headers=AUTH,
    )
    assert r.status_code == 200, r.text
    assert r.json()["config"] == {"api_key": "[redacted]", "region": "us"}
    prv = r.json()["id"]

    r = app_client.get(f"/providers/{prv}", headers=AUTH)
    assert r.json()["config"]["api_key"] == "[redacted]"

    r = app_client.post(f"/projects/{pid}/providers", json={"kind": "bogus"}, headers=AUTH)
    assert r.status_code == 400

    mate = _teammate(app_client, pid)
    r = app_client.patch(f"/teammates/{mate}", json={"provider_id": prv}, headers=AUTH)
    assert r.status_code == 200 and r.json()["provider_id"] == prv

    r = app_client.post(f"/teammates/{mate}", json={}, headers=AUTH)
    assert r.status_code in (404, 405)


def test_mock_provider_run_is_deterministic_and_audited(app_client: TestClient) -> None:
    pid = _project(app_client)
    prv = app_client.post(f"/projects/{pid}/providers", json={"kind": "mock"}, headers=AUTH).json()[
        "id"
    ]
    mate = _teammate(app_client, pid)
    app_client.patch(f"/teammates/{mate}", json={"provider_id": prv}, headers=AUTH)
    tid = app_client.post(
        f"/projects/{pid}/tasks",
        json={"description": "t", "owner_teammate_id": mate, "command": "do thing"},
        headers=AUTH,
    ).json()["id"]
    first = app_client.post(f"/tasks/{tid}/runs", headers=AUTH).json()
    assert first["run"]["status"] == "succeeded"
    assert first["run"]["provider_id"] == prv
    assert first["run"]["runtime"] == "mock"

    events = app_client.get(f"/projects/{pid}/events?entity=run", headers=AUTH).json()["events"]
    assert "run.provider.mock" in [e["event_type"] for e in events]

    second = app_client.post(f"/tasks/{tid}/retry", headers=AUTH).json()
    assert second["run"]["id"] != first["run"]["id"]
    assert "would execute: do thing" in second["run"]["output_excerpt"]


def test_unconfigured_and_disabled_providers_block(app_client: TestClient) -> None:
    pid = _project(app_client)
    oai = app_client.post(
        f"/projects/{pid}/providers",
        json={"kind": "openai-compatible", "config": {}},
        headers=AUTH,
    ).json()["id"]
    mate = _teammate(app_client, pid)
    app_client.patch(f"/teammates/{mate}", json={"provider_id": oai}, headers=AUTH)
    tid = app_client.post(
        f"/projects/{pid}/tasks",
        json={"description": "t", "owner_teammate_id": mate, "command": "echo hi"},
        headers=AUTH,
    ).json()["id"]
    body = app_client.post(f"/tasks/{tid}/runs", headers=AUTH).json()
    assert body["run"]["status"] == "blocked"
    assert "not configured" in (body["run"]["output_excerpt"] or "")

    mock = app_client.post(
        f"/projects/{pid}/providers", json={"kind": "mock"}, headers=AUTH
    ).json()["id"]
    app_client.patch(f"/teammates/{mate}", json={"provider_id": mock}, headers=AUTH)
    app_client.post(f"/providers/{mock}/disable", headers=AUTH)
    body = app_client.post(f"/tasks/{tid}/retry", headers=AUTH).json()
    assert body["run"]["status"] == "blocked"


# -- Knowledge ------------------------------------------------------------------


def test_chunk_and_retrieve() -> None:
    chunks = knowledge_mod.chunk_text(" ".join(f"w{i}" for i in range(300)))
    assert len(chunks) == 3
    assert chunks[0].split()[-30:] == chunks[1].split()[:30]  # overlap
    assert knowledge_mod.chunk_text("") == []
    with pytest.raises(ValueError):
        knowledge_mod.chunk_text("x", words_per_chunk=0)

    conn = store.connect(":memory:")
    project = store.create_project(conn, owner="o")
    knowledge_mod.ingest_knowledge(
        conn, project.id, "guide", "alpha beta gamma delta", source="manual-note"
    )
    knowledge_mod.ingest_knowledge(
        conn, project.id, "other", "zeta zeta zeta", source="manual-note"
    )
    hits = knowledge_mod.retrieve(conn, project.id, "alpha gamma")
    assert hits and hits[0]["source_title"] == "guide"
    assert hits[0]["confidence"] == 1.0
    assert knowledge_mod.retrieve(conn, project.id, "qqqq zzzz") == []
    conn.close()


def test_knowledge_validation_and_attach(app_client: TestClient) -> None:
    pid = _project(app_client)
    for bad in (
        {"title": "t", "content": "", "source": "s"},
        {"title": "t", "content": "x", "source": ""},
    ):
        r = app_client.post(f"/projects/{pid}/knowledge", json=bad, headers=AUTH)
        assert r.status_code == 400, r.text
    r = app_client.post(
        f"/projects/{pid}/knowledge",
        json={"title": "runbook", "content": "restart with the red button", "source": "ops-wiki"},
        headers=AUTH,
    )
    assert r.json()["chunks"] == 1
    tid = app_client.post(f"/projects/{pid}/tasks", json={"description": "t"}, headers=AUTH).json()[
        "id"
    ]
    r = app_client.post(
        f"/tasks/{tid}/knowledge/search", json={"query": "red button"}, headers=AUTH
    )
    assert r.json()["citations"][0]["source"] == "ops-wiki"
    r = app_client.post(
        f"/tasks/{tid}/knowledge/attach", json={"query": "red button"}, headers=AUTH
    )
    assert r.json()["citations"]
    view = app_client.get(f"/tasks/{tid}", headers=AUTH).json()
    assert any(a["type"] == "knowledge" for a in view["artifacts"])


# -- Schedules ------------------------------------------------------------------


def test_cron_validation_and_next() -> None:
    from nerdbot import schedules as sched

    with pytest.raises(ValueError):
        sched.parse_cron("not a cron")
    with pytest.raises(ValueError):
        sched.parse_cron("61 * * * *")
    base = datetime(2026, 1, 1, 0, 0, tzinfo=UTC)
    assert sched.next_after("* * * * *", base) == base + timedelta(minutes=1)
    assert sched.next_after("0 9 * * *", base) == base + timedelta(hours=9)
    assert sched.next_after("*/15 * * * *", base) == base + timedelta(minutes=15)


def test_schedule_lifecycle_and_overlap(tmp_path) -> None:
    conn = store.connect(":memory:")
    project = store.create_project(conn, owner="o")
    with pytest.raises(ValueError):
        orchestrator.create_scheduled(
            conn, project.id, "bad", "nope", {"description": "d", "command": "c"}
        )
    with pytest.raises(ValueError):
        orchestrator.create_scheduled(conn, project.id, "bad", "* * * * *", {"description": "d"})
    now = datetime(2026, 1, 1, 0, 0, tzinfo=UTC)
    sch = orchestrator.create_scheduled(
        conn,
        project.id,
        "nightly",
        "0 9 * * *",
        {"description": "nightly task", "command": "echo night"},
        now=now,
    )
    assert sch.next_run_at == now + timedelta(hours=9)
    assert store.lock_schedule(conn, sch.id) is True
    assert store.lock_schedule(conn, sch.id) is False  # overlap protection
    conn.execute("UPDATE schedules SET locked = 0 WHERE id = ?", (sch.id,))
    conn.commit()
    fired = orchestrator.fire_due_schedules(
        conn, now=now + timedelta(hours=9, minutes=1), data_dir=str(tmp_path)
    )
    assert len(fired) == 1 and fired[0]["status"] == "succeeded"
    updated = store.get_schedule(conn, sch.id)
    assert updated is not None and updated.fire_count == 1
    assert updated.next_run_at == now + timedelta(days=1, hours=9)
    notes = store.list_notifications(conn, project.id)
    assert [n.kind for n in notes] == ["schedule.fired"]
    conn.close()


def test_schedule_fire_endpoint_and_enable(app_client: TestClient) -> None:
    pid = _project(app_client)
    r = app_client.post(
        f"/projects/{pid}/schedules",
        json={
            "name": "s",
            "cron": "* * * * *",
            "task_template": {"description": "t", "command": "echo ok"},
        },
        headers=AUTH,
    )
    assert r.status_code == 200, r.text
    sch_id = r.json()["id"]
    r = app_client.post(f"/schedules/{sch_id}/fire", headers=AUTH)
    assert r.status_code == 400  # not due yet
    r = app_client.get(f"/projects/{pid}/schedules", headers=AUTH)
    assert len(r.json()["schedules"]) == 1


# -- Ingress / notify -------------------------------------------------------------


def test_ingress_creates_issue_and_task(app_client: TestClient) -> None:
    pid = _project(app_client)
    r = app_client.post(
        f"/projects/{pid}/ingress",
        json={"title": "ping", "body": "b", "labels": ["ext"], "source": "webhook"},
        headers=AUTH,
    )
    assert r.status_code == 200, r.text
    assert r.json()["issue"]["source"] == "webhook"
    assert r.json()["task"]["issue_id"] == r.json()["issue"]["id"]
    types = [
        e["event_type"]
        for e in app_client.get(f"/projects/{pid}/events", headers=AUTH).json()["events"]
    ]
    assert "ingress.received" in types
    assert app_client.post(f"/projects/{pid}/ingress", json={"title": ""}).status_code == 401


def test_notify_outbox_and_stubs(app_client: TestClient) -> None:
    pid = _project(app_client)
    r = app_client.post(
        f"/projects/{pid}/notify",
        json={"channel": "outbox", "kind": "ping", "payload": {"token": "SECRET", "msg": "hi"}},
        headers=AUTH,
    )
    assert r.status_code == 200, r.text
    assert r.json()["payload"] == {"token": "[redacted]", "msg": "hi"}
    r = app_client.post(
        f"/projects/{pid}/notify", json={"channel": "email", "kind": "x"}, headers=AUTH
    )
    assert r.status_code == 400 and "stub" in r.json()["detail"]
    notes = app_client.get(f"/projects/{pid}/notifications", headers=AUTH).json()["notifications"]
    assert len(notes) == 1 and notes[0]["status"] == "stored"


# -- Backup / metrics / capabilities -----------------------------------------------


def test_backup_redaction_and_validation(app_client: TestClient, monkeypatch) -> None:
    _secret_key(monkeypatch)
    pid = _project(app_client)
    app_client.post(
        f"/projects/{pid}/providers",
        json={"kind": "openai-compatible", "config": {"api_key": "LIVE", "base_url": "u"}},
        headers=AUTH,
    )
    manifest = app_client.get(f"/projects/{pid}/backup", headers=AUTH).json()
    assert manifest["version"] == 1
    assert manifest["tables"]["providers"][0]["config"]["api_key"] == "[redacted]"
    assert "tasks" in manifest["tables"] and "events" in manifest["tables"]
    r = app_client.post(
        f"/projects/{pid}/backup/validate", json={"manifest": manifest}, headers=AUTH
    )
    assert r.json() == {"valid": True, "errors": []}
    bad = dict(manifest, version=99)
    assert (
        app_client.post(
            f"/projects/{pid}/backup/validate", json={"manifest": bad}, headers=AUTH
        ).json()["valid"]
        is False
    )


def test_metrics_and_health(app_client: TestClient) -> None:
    pid = _project(app_client)
    tid = app_client.post(
        f"/projects/{pid}/tasks", json={"description": "t", "command": "exit 1"}, headers=AUTH
    ).json()["id"]
    app_client.post(f"/tasks/{tid}/runs", headers=AUTH)
    metrics = app_client.get(f"/projects/{pid}/metrics", headers=AUTH).json()
    assert metrics["runs_total"] == 1
    assert metrics["runs_by_status"]["failed"] == 1
    assert metrics["failed_commands"] == 1
    health = app_client.get("/health").json()
    assert health["status"] == "ok" and health["db"] == "ok" and "restarts" in health


def test_capabilities_flags(app_client: TestClient) -> None:
    caps = {
        c["id"]: c for c in app_client.get("/capabilities", headers=AUTH).json()["capabilities"]
    }
    assert caps["provider.local"]["status"] == "ready"
    assert caps["provider.mock"]["status"] == "ready"
    assert caps["provider.openai-compatible"]["status"] == "ready"
    for stub in ("notify.email", "agents.external", "browser.automation"):
        assert caps[stub]["status"] in ("stub", "rejected", "deferred"), stub
    assert app_client.get("/capabilities").status_code == 401


def test_restart_preserves_phase4_state(tmp_path, monkeypatch) -> None:
    db = str(tmp_path / "p4restart.db")
    monkeypatch.setenv("NERDBOT_TOKEN", TOKEN)
    monkeypatch.setenv("NERDBOT_DB", db)
    monkeypatch.setenv("NERDBOT_DATA", str(tmp_path / "data"))
    client = TestClient(create_app())
    pid = _project(client)
    prv = client.post(f"/projects/{pid}/providers", json={"kind": "mock"}, headers=AUTH).json()[
        "id"
    ]
    mate = _teammate(client, pid)
    client.patch(f"/teammates/{mate}", json={"provider_id": prv}, headers=AUTH)
    sch = client.post(
        f"/projects/{pid}/schedules",
        json={
            "name": "s",
            "cron": "0 9 * * *",
            "task_template": {"description": "t", "command": "echo ok"},
        },
        headers=AUTH,
    ).json()
    del client

    reloaded = TestClient(create_app())
    assert reloaded.get(f"/providers/{prv}", headers=AUTH).json()["kind"] == "mock"
    schedules = reloaded.get(f"/projects/{pid}/schedules", headers=AUTH).json()["schedules"]
    assert [(s["id"], s["fire_count"]) for s in schedules] == [(sch["id"], 0)]
    metrics = reloaded.get(f"/projects/{pid}/metrics", headers=AUTH).json()
    assert metrics["schedules"]["total"] == 1


def test_auth_on_phase4_routes(app_client: TestClient) -> None:
    bad = {"Authorization": "Bearer wrong"}
    assert app_client.get("/projects/x/providers", headers=bad).status_code == 403
    assert app_client.get("/projects/x/schedules").status_code == 401
    assert app_client.get("/projects/x/metrics", headers=bad).status_code == 403
    assert app_client.get("/projects/x/backup").status_code == 401


def test_request_id_traced(app_client: TestClient) -> None:
    r = app_client.get("/health")
    assert r.headers["X-Request-ID"]
    r = app_client.get("/health", headers={"X-Request-ID": "abc123"})
    assert r.headers["X-Request-ID"] == "abc123"


def test_restart_count_increments(tmp_path, monkeypatch) -> None:
    monkeypatch.setenv("NERDBOT_TOKEN", TOKEN)
    monkeypatch.setenv("NERDBOT_DB", str(tmp_path / "rc.db"))
    monkeypatch.setenv("NERDBOT_DATA", str(tmp_path / "data"))
    with TestClient(create_app()):
        pass
    with TestClient(create_app()):
        pass
    from nerdbot import store as store_mod

    conn = store_mod.connect(str(tmp_path / "rc.db"))
    try:
        assert store_mod.meta_get(conn, "restart_count") == "2"
    finally:
        conn.close()
