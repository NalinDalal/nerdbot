"""Extra CEO tests: concurrent approve, tamper, rollup guard."""

from __future__ import annotations

import os
from concurrent.futures import ThreadPoolExecutor

from fastapi.testclient import TestClient

from nerdbot import store
from nerdbot.api import create_app

TOKEN = "ceo-token"
AUTH = {"Authorization": f"Bearer {TOKEN}"}


def _client(tmp_path, monkeypatch):
    monkeypatch.setenv("NERDBOT_TOKEN", TOKEN)
    monkeypatch.setenv("NERDBOT_DB", str(tmp_path / "ceo.db"))
    monkeypatch.setenv("NERDBOT_DATA", str(tmp_path / "data"))
    return TestClient(create_app())


def _project(client):
    r = client.get("/home", headers=AUTH)
    assert r.status_code == 200
    return r.json()["id"]


def test_approve_idempotent_concurrent(tmp_path, monkeypatch):
    client = _client(tmp_path, monkeypatch)
    pid = _project(client)
    tid = client.post(f"/projects/{pid}/threads", json={}, headers=AUTH).json()["id"]
    conn = store.connect(os.environ["NERDBOT_DB"])
    plan_part = {"type": "plan", "plan_id": "pln_conc", "objective": "o", "steps": [{"title": "s1", "assignee_slug": ""}]}
    store.append_message(conn, tid, "assistant", "plan", parts=[plan_part])

    def call():
        return client.post(f"/threads/{tid}/plans/pln_conc/approve", json={}, headers=AUTH)

    with ThreadPoolExecutor(max_workers=2) as ex:
        r1 = ex.submit(call).result()
        r2 = ex.submit(call).result()
    assert r1.status_code == 200
    assert r2.status_code == 200
    objs = conn.execute("SELECT count(*) FROM objectives WHERE thread_id=?", (tid,)).fetchone()[0]
    assert objs == 1


def test_approve_tamper_rejected(tmp_path, monkeypatch):
    client = _client(tmp_path, monkeypatch)
    pid = _project(client)
    tid = client.post(f"/projects/{pid}/threads", json={}, headers=AUTH).json()["id"]
    conn = store.connect(os.environ["NERDBOT_DB"])
    plan_part = {"type": "plan", "plan_id": "pln_tamper", "objective": "o", "steps": [{"title": "s1", "assignee_slug": ""}]}
    store.append_message(conn, tid, "assistant", "plan", parts=[plan_part])
    r = client.post(f"/threads/{tid}/plans/pln_tamper/approve", json={"steps": [{"title": "s1", "assignee_slug": "nope"}]}, headers=AUTH)
    assert r.status_code == 422


def test_rollup_once_guard(tmp_path, monkeypatch):
    conn = store.connect(tmp_path / "ro.db")
    pid = store.create_project(conn, "local-owner", "p").id
    thread = store.create_thread(conn, pid)
    obj = store.create_objective(conn, thread.id, title="o")
    t1 = store.create_task(conn, pid, description="ok", objective_id=obj.id)
    conn.execute("UPDATE tasks SET status='done' WHERE id=?", (t1.id,))
    conn.commit()
    r1 = store.rollup_objective(conn, obj.id, thread.id)
    # simulate guard: only one report with this title should exist
    cnt = conn.execute("SELECT count(*) FROM reports WHERE thread_id=? AND title=?", (thread.id, f"Rollup {obj.id}")).fetchone()[0]
    assert cnt == 1
