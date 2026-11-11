"""P3 targeted hardening: workspace deletion, membership-aware execution, removal lifecycle."""

from __future__ import annotations

import sqlite3

import pytest
from fastapi.testclient import TestClient

from nerdbot import app_tools, store
from nerdbot.agent_context import AgentContext
from nerdbot.api import create_app

TOKEN = "hardening-token"
AUTH = {"Authorization": f"Bearer {TOKEN}"}


@pytest.fixture()
def client(tmp_path, monkeypatch):
    monkeypatch.setenv("NERDBOT_TOKEN", TOKEN)
    monkeypatch.setenv("NERDBOT_DB", str(tmp_path / "hardening.db"))
    monkeypatch.setenv("NERDBOT_DATA", str(tmp_path / "data"))
    return TestClient(create_app())


def _project(client: TestClient, repo: str = "r") -> str:
    r = client.post("/projects", json={"repository": repo}, headers=AUTH)
    assert r.status_code == 200, r.text
    return r.json()["id"]


def _teammate(client: TestClient, project_id: str, persona: str = "agent", **extra) -> dict:
    body = {"persona": persona, "name": persona.title(), "instructions": "help"}
    body.update(extra)
    r = client.post(f"/projects/{project_id}/teammates", json=body, headers=AUTH)
    assert r.status_code == 200, r.text
    return r.json()


def _task(client: TestClient, project_id: str, **extra) -> dict:
    body = {"description": "work", "command": "echo ok"}
    body.update(extra)
    r = client.post(f"/projects/{project_id}/tasks", json=body, headers=AUTH)
    assert r.status_code == 200, r.text
    return r.json()


def test_delete_origin_workspace_preserves_shared_teammate_and_rehomes(client: TestClient):
    p1 = _project(client, "origin")
    p2 = _project(client, "other")
    tid = _teammate(client, p1, persona="Shared")["id"]
    assert client.post(f"/projects/{p2}/teammates/{tid}/membership", headers=AUTH).status_code == 200
    t = _task(client, p2, owner_teammate_id=tid, description="survives")
    rmem = client.post("/memory", json={"scope": f"teammate:{tid}", "content": "identity", "source": "test"}, headers=AUTH)
    assert rmem.status_code == 200, rmem.text

    r = client.delete(f"/projects/{p1}", headers=AUTH)
    assert r.status_code == 200, r.text

    got = client.get(f"/teammates/{tid}", headers=AUTH)
    assert got.status_code == 200, got.text
    body = got.json()
    assert body["id"] == tid
    assert p2 in body.get("project_ids", [])
    assert p1 not in body.get("project_ids", [])
    assert body.get("project_id") == p2

    mates_p2 = {m["id"] for m in client.get(f"/projects/{p2}/teammates", headers=AUTH).json()["teammates"]}
    assert tid in mates_p2
    task_resp = client.get(f"/tasks/{t['id']}", headers=AUTH).json()
    task = task_resp.get("task", task_resp)
    assert task.get("owner_teammate_id") == tid and task.get("project_id") == p2
    mem = client.get("/memory", params={"scope": f"teammate:{tid}"}, headers=AUTH).json()["entries"]
    assert any(e["content"] == "identity" for e in mem)


def test_delete_non_origin_workspace_preserves_teammate(client: TestClient):
    p1 = _project(client, "origin")
    p2 = _project(client, "other")
    tid = _teammate(client, p1, persona="Shared")["id"]
    client.post(f"/projects/{p2}/teammates/{tid}/membership", headers=AUTH)
    assert client.delete(f"/projects/{p2}", headers=AUTH).status_code == 200
    body = client.get(f"/teammates/{tid}", headers=AUTH).json()
    assert p1 in body.get("project_ids", [])
    assert p2 not in body.get("project_ids", [])
    assert body.get("project_id") == p1


def test_delete_workspace_with_no_other_memberships_removes_local_teammate(client: TestClient):
    p1 = _project(client, "solo")
    tid = _teammate(client, p1, persona="Solo")["id"]
    assert client.delete(f"/projects/{p1}", headers=AUTH).status_code == 200
    assert client.get(f"/teammates/{tid}", headers=AUTH).status_code == 404


def test_remove_non_origin_membership_preserves_identity_memory_other_memberships(client: TestClient, tmp_path):
    p1 = _project(client, "origin")
    p2 = _project(client, "other")
    tid = _teammate(client, p1, persona="Shared")["id"]
    client.post(f"/projects/{p2}/teammates/{tid}/membership", headers=AUTH)
    client.post("/memory", json={"scope": f"teammate:{tid}", "content": "remember", "source": "test"}, headers=AUTH)
    t2 = _task(client, p2, owner_teammate_id=tid, description="historical")
    # Make the historical record non-in-flight so safe removal is allowed.
    db = tmp_path / "hardening.db"
    conn = sqlite3.connect(db)
    conn.execute("UPDATE tasks SET status='done', owner_teammate_id=NULL WHERE id=?", (t2["id"],))
    conn.commit()
    conn.close()

    r = client.delete(f"/projects/{p2}/teammates/{tid}/membership", headers=AUTH)
    assert r.status_code == 200, r.text
    body = client.get(f"/teammates/{tid}", headers=AUTH).json()
    assert p1 in body.get("project_ids", [])
    assert p2 not in body.get("project_ids", [])
    mem = client.get("/memory", params={"scope": f"teammate:{tid}"}, headers=AUTH).json()["entries"]
    assert any(e["content"] == "remember" for e in mem)
    task_resp = client.get(f"/tasks/{t2['id']}", headers=AUTH).json()
    task = task_resp.get("task", task_resp)
    # Historical task record preserved in its workspace.
    assert task.get("project_id") == p2 and task.get("id") == t2["id"]


def test_remove_origin_membership_rehomes_when_other_memberships_exist(client: TestClient):
    p1 = _project(client, "origin")
    p2 = _project(client, "other")
    tid = _teammate(client, p1, persona="Shared")["id"]
    client.post(f"/projects/{p2}/teammates/{tid}/membership", headers=AUTH)

    r = client.delete(f"/projects/{p1}/teammates/{tid}/membership", headers=AUTH)
    assert r.status_code == 200, r.text
    body = client.get(f"/teammates/{tid}", headers=AUTH).json()
    assert p2 in body.get("project_ids", [])
    assert p1 not in body.get("project_ids", [])
    assert body.get("project_id") == p2


def test_reject_unsafe_membership_removal_with_inflight_tasks(client: TestClient):
    p1 = _project(client, "origin")
    p2 = _project(client, "other")
    tid = _teammate(client, p1, persona="Shared")["id"]
    client.post(f"/projects/{p2}/teammates/{tid}/membership", headers=AUTH)
    _task(client, p2, owner_teammate_id=tid, description="active", command="echo ok")

    r = client.delete(f"/projects/{p2}/teammates/{tid}/membership", headers=AUTH)
    assert r.status_code == 409, r.text
    text = r.text.lower()
    assert "reassign" in text or "resolve" in text or "active" in text or "pending" in text
    body = client.get(f"/teammates/{tid}", headers=AUTH).json()
    assert p2 in body.get("project_ids", [])


def test_member_can_act_in_non_origin_workspace_via_app_tools(client: TestClient, tmp_path):
    p1 = _project(client, "origin")
    p2 = _project(client, "other")
    tid = _teammate(client, p1, persona="Shared")["id"]
    client.post(f"/projects/{p2}/teammates/{tid}/membership", headers=AUTH)
    t = _task(client, p2, owner_teammate_id=tid, description="cross workspace")
    db = tmp_path / "hardening.db"
    conn = sqlite3.connect(db)
    conn.row_factory = sqlite3.Row
    task = store.get_task(conn, t["id"])
    mate = store.get_teammate(conn, tid)
    assert task and mate
    ctx = AgentContext(conn=conn, task=task, project=store.get_project(conn, p2), teammate=mate, system_message="", allowed_permissions=frozenset(mate.permissions or []))
    resolved = app_tools._resolve_actor(ctx)
    assert resolved.id == tid
    conn.close()


def test_non_member_cannot_act_in_workspace(client: TestClient, tmp_path):
    p1 = _project(client, "origin")
    p2 = _project(client, "other")
    tid = _teammate(client, p1, persona="Solo")["id"]
    t = _task(client, p2, description="other workspace task")
    db = tmp_path / "hardening.db"
    conn = sqlite3.connect(db)
    conn.row_factory = sqlite3.Row
    task = store.get_task(conn, t["id"])
    mate = store.get_teammate(conn, tid)
    assert task and mate
    ctx = AgentContext(conn=conn, task=task, project=store.get_project(conn, p2), teammate=mate, system_message="", allowed_permissions=frozenset(mate.permissions or []))
    with pytest.raises(Exception) as ei:
        app_tools._resolve_actor(ctx)
    msg = str(ei.value).lower()
    assert "not a member" in msg or "denied" in msg
    conn.close()


def test_cannot_assign_non_member_teammate_preserves_isolation(client: TestClient):
    p1 = _project(client, "a")
    p2 = _project(client, "b")
    tid = _teammate(client, p1, persona="A")["id"]
    r = client.post(f"/projects/{p2}/tasks", json={"description": "x", "command": "echo x", "owner_teammate_id": tid}, headers=AUTH)
    assert r.status_code == 400, r.text


def test_project_scoped_creation_compatibility(client: TestClient):
    p = _project(client)
    mate = _teammate(client, p, persona="Compat")
    assert mate["project_id"] == p
    assert mate["id"].startswith("tm")
    listed = client.get(f"/projects/{p}/teammates", headers=AUTH).json()["teammates"]
    assert any(m["id"] == mate["id"] for m in listed)
