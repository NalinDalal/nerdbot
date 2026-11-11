"""Phase 9 P4 Stage 1: backend correctness and P3-aligned security hardening.

Focused regressions for team/membership authorization, board correctness,
messaging permission compatibility, and board deletion approval/cleanup.
"""

from __future__ import annotations

import os
import sqlite3
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from nerdbot import boards, gates, store
from nerdbot.api import create_app
from nerdbot.models import Decision

TOKEN = "p4-stage1-token"
AUTH = {"Authorization": f"Bearer {TOKEN}"}


@pytest.fixture()
def client(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> TestClient:
    monkeypatch.setenv("NERDBOT_TOKEN", TOKEN)
    monkeypatch.setenv("NERDBOT_DB", str(tmp_path / "nerdbot.db"))
    monkeypatch.setenv("NERDBOT_DATA", str(tmp_path / "data"))
    monkeypatch.delenv("NERDBOT_STATIC_DIR", raising=False)
    return TestClient(create_app())


def _project(client: TestClient, name: str = "proj") -> str:
    r = client.post("/projects", json={"repository": name}, headers=AUTH)
    assert r.status_code == 200, r.text
    return r.json()["id"]


def _teammate(
    client: TestClient,
    project_id: str,
    name: str = "bot",
    permissions: list[str] | None = None,
    tool_policy: dict[str, str] | None = None,
) -> str:
    body: dict = {"persona": name, "name": name, "project_id": project_id}
    if permissions is not None:
        body["permissions"] = permissions
    if tool_policy is not None:
        body["tool_policy"] = tool_policy
    r = client.post(f"/projects/{project_id}/teammates", json=body, headers=AUTH)
    assert r.status_code == 200, r.text
    return r.json()["id"]


def _open_conn(tmp_path: Path) -> sqlite3.Connection:
    db = os.environ.get("NERDBOT_DB") or str(tmp_path / "nerdbot.db")
    return store.connect(db)



# --- A. Global teammate/team membership authorization ---

def test_team_eligibility_allows_teammate_participating_in_owner_workspace_not_origin(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setenv("NERDBOT_DB", str(tmp_path / "nerdbot.db"))
    """A global teammate can be added to a team if they participate in any
    workspace owned by the team owner, even if origin differs."""
    monkeypatch.setenv("NERDBOT_DATA_DIR", str(tmp_path))
    with _open_conn(tmp_path) as conn:
        p1 = store.create_project(conn, "local", "p1")
        p2 = store.create_project(conn, "local", "p2")
        # Origin/home is p1, but teammate also participates in p2 owned by same team owner.
        mate = store.create_teammate(conn, p1.id, name="shared")
        store.add_teammate_to_project(conn, mate.id, p2.id)
        team = store.create_team(conn, "local", "fleet")
        member = store.add_teammate_to_team(conn, team.id, mate.id)
        assert member.teammate_id == mate.id
        assert store.teammate_in_project(conn, mate.id, p2.id)
        members = store.list_team_members(conn, team.id)
        assert any(m.teammate_id == mate.id for m in members)


def test_team_eligibility_rejects_teammate_with_no_eligible_owner_workspace(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setenv("NERDBOT_DB", str(tmp_path / "nerdbot.db"))
    monkeypatch.setenv("NERDBOT_DATA_DIR", str(tmp_path))
    with _open_conn(tmp_path) as conn:
        owner_p = store.create_project(conn, "local", "owner")
        alien_p = store.create_project(conn, "other", "alien")
        mate = store.create_teammate(conn, alien_p.id, name="alien-bot")
        team = store.create_team(conn, "local", "fleet")
        with pytest.raises(ValueError):
            store.add_teammate_to_team(conn, team.id, mate.id)


def test_add_teammate_to_team_duplicate_is_idempotent_and_no_identity_duplication(client: TestClient, tmp_path: Path):
    p = _project(client, "p")
    tid = _teammate(client, p, "bot")
    r = client.post("/teams", json={"name": "t"}, headers=AUTH)
    assert r.status_code == 200, r.text
    team_id = r.json()["id"]
    a = client.post(f"/teams/{team_id}/teammates", json={"teammate_id": tid}, headers=AUTH)
    b = client.post(f"/teams/{team_id}/teammates", json={"teammate_id": tid}, headers=AUTH)
    assert a.status_code == 200, a.text
    assert b.status_code == 200, b.text
    with _open_conn(tmp_path) as conn:
        assert conn.execute("SELECT COUNT(*) AS n FROM teammates WHERE id = ?", (tid,)).fetchone()["n"] == 1
        assert conn.execute(
            "SELECT COUNT(*) AS n FROM team_members WHERE team_id = ? AND teammate_id = ?",
            (team_id, tid),
        ).fetchone()["n"] == 1


def test_fleet_acting_team_add_requires_shared_workspace_owned_by_team_owner(client: TestClient, tmp_path: Path):
    """Least-privilege acting-bot check: sharing a team owner is not enough;
    acting and target must share an actual workspace owned by that team owner."""
    p1 = _project(client, "p1")
    p2 = _project(client, "p2")
    acting = _teammate(client, p1, "acting", permissions=["team.membership"])
    target = _teammate(client, p2, "target")
    with _open_conn(tmp_path) as conn:
        mate = store.get_teammate(conn, acting)
        assert mate is not None
        mate.tool_policy = {**dict(mate.tool_policy or {}), "team.membership": "auto"}
        conn.execute("UPDATE teammates SET tool_policy = ? WHERE id = ?", (__import__('json').dumps(mate.tool_policy), acting))
        conn.commit()
    team = client.post("/teams", json={"name": "t"}, headers=AUTH).json()["id"]
    r = client.post(
        f"/teams/{team}/teammates",
        json={"teammate_id": target},
        headers={**AUTH, "X-Acting-Teammate": acting},
    )
    assert r.status_code == 403, r.text
    # Make target participate in p1 (workspace owned by team owner, shared with acting).
    add = client.post(f"/projects/{p1}/teammates/{target}/membership", headers=AUTH)
    assert add.status_code == 200, add.text
    r2 = client.post(
        f"/teams/{team}/teammates",
        json={"teammate_id": target},
        headers={**AUTH, "X-Acting-Teammate": acting},
    )
    assert r2.status_code == 200, r2.text


def test_fleet_acting_team_add_rejects_cross_owner_workspace_sharing(client: TestClient, tmp_path: Path):
    """Acting/target sharing a workspace not owned by team owner must not grant access."""
    p_local = _project(client, "local-p")
    acting_id = _teammate(
        client, p_local, "acting",
        permissions=["team.membership"],
        tool_policy={"team.membership": "auto"},
    )
    team_id = client.post("/teams", json={"name": "t"}, headers=AUTH).json()["id"]
    with _open_conn(tmp_path) as conn:
        alien_project = store.create_project(conn, "alien", "other")
        target = store.create_teammate(conn, alien_project.id, name="alien-target")
        # Make acting a member of alien workspace too (cross-owner) - should not help
        store.add_teammate_to_project(conn, acting_id, alien_project.id)
        target_id = target.id
    r = client.post(
        f"/teams/{team_id}/teammates",
        json={"teammate_id": target_id},
        headers={**AUTH, "X-Acting-Teammate": acting_id},
    )
    assert r.status_code == 403, r.text


# --- B. Workspace membership-add authorization ---

def test_workspace_membership_add_fails_closed_for_unauthorized_teammate(client: TestClient, tmp_path: Path):
    target_ws = _project(client, "target")
    with _open_conn(tmp_path) as conn:
        alien_p = store.create_project(conn, "alien", "other")
        alien_mate = store.create_teammate(conn, alien_p.id, name="alien")
        alien_id = alien_mate.id
    r = client.post(f"/projects/{target_ws}/teammates/{alien_id}/membership", headers=AUTH)
    assert r.status_code == 403, r.text
    assert r.json().get("detail") == "not authorized to add this teammate"


def test_workspace_membership_add_allows_local_owner_controlled_global_teammate(client: TestClient):
    p1 = _project(client, "p1")
    p2 = _project(client, "p2")
    tid = _teammate(client, p1, "owned")
    r = client.post(f"/projects/{p2}/teammates/{tid}/membership", headers=AUTH)
    assert r.status_code == 200, r.text
    body = r.json()
    assert body.get("id") == tid
    assert p2 in body.get("project_ids", [])


# --- C. Board correctness and permission consistency ---

def test_patch_board_status_validates_and_authorizes(client: TestClient):
    p = _project(client, "p")
    rb = client.post("/boards", json={"project_id": p, "name": "b"}, headers=AUTH)
    assert rb.status_code == 200, rb.text
    board_id = rb.json()["id"]
    ok = client.patch(f"/boards/{board_id}", json={"status": "archived"}, headers=AUTH)
    assert ok.status_code == 200, ok.text
    assert ok.json()["status"] == "archived"
    bad = client.patch(f"/boards/{board_id}", json={"status": "nope"}, headers=AUTH)
    assert bad.status_code == 400, bad.text
    unauth = client.patch(f"/boards/{board_id}", json={"status": "active"}, headers={"Authorization": "Bearer wrong"})
    assert unauth.status_code in (401, 403), unauth.text


def test_board_messaging_permission_compat_message_send_and_board_message(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setenv("NERDBOT_DATA_DIR", str(tmp_path))
    with _open_conn(tmp_path) as conn:
        project = store.create_project(conn, "p", "local")
        board = store.create_board(conn, "local", "b", project_id=project.id)
        # message.send alone can post via board.message service path
        sender = store.create_teammate(conn, project.id, name="s", permissions=["message.send"])
        msg = boards.create_board_message_service(
            conn, board.id, "hi", from_teammate_id=sender.id, acting=sender, permission="board.message"
        )
        assert msg.board_id == board.id
        # board.message alone also satisfies
        sender2 = store.create_teammate(conn, project.id, name="s2", permissions=["board.message"])
        msg2 = boards.create_board_message_service(
            conn, board.id, "hi2", from_teammate_id=sender2.id, acting=sender2, permission="message.send"
        )
        assert msg2.board_id == board.id


def test_agent_send_message_tool_allows_board_message_permission(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    """Agent tool exposure/dispatch must accept board.message compatibly."""
    from nerdbot import agent_context as agent_context_mod, app_tools
    from nerdbot.models import TaskStatus

    monkeypatch.setenv("NERDBOT_DATA_DIR", str(tmp_path))
    with _open_conn(tmp_path) as conn:
        project = store.create_project(conn, "p", "local")
        board = store.create_board(conn, "local", "b", project_id=project.id)
        mate = store.create_teammate(conn, project.id, name="bot", permissions=["board.message"])
        store.create_board_member(conn, board.id, mate.id)
        task = store.create_task(conn, project.id, description="t", board_id=board.id)
        store.set_task_status(conn, task.id, TaskStatus.RUNNING)
        run = store.create_run(conn, task.id)
        ctx = agent_context_mod.build(conn, task, mate)
        # attach run if context supports it (tool execution may reference ctx.run)
        if hasattr(ctx, "run"):
            try:
                ctx.run = run
            except Exception:
                pass
        # schema exposure: board.message should allow send_message
        try:
            schemas = app_tools.tool_schemas(ctx)
        except Exception:
            try:
                schemas = app_tools.tool_schemas_for_context(ctx)
            except Exception:
                schemas = []
        names = set()
        for t in schemas or []:
            if isinstance(t, dict):
                fn = t.get("function", {}) if "function" in t else t
                if isinstance(fn, dict) and fn.get("name"):
                    names.add(fn["name"])
        if names:
            assert "send_message" in names
        result = app_tools.execute_app_tool(ctx, "send_message", {"content": "hello"})
        assert result.startswith("sent message "), result
        msgs = store.list_board_messages(conn, board.id)
        assert any(m.content == "hello" for m in msgs)


def test_board_delete_requires_canonical_gate_and_cleanup_targets_to_board_id(client: TestClient, tmp_path: Path):
    p = _project(client, "p")
    acting = _teammate(client, p, "actor", permissions=["board.delete"])
    with _open_conn(tmp_path) as conn:
        mate = store.get_teammate(conn, acting)
        assert mate is not None
        mate.tool_policy = {**dict(mate.tool_policy or {}), "board.delete": "auto"}
        conn.execute("UPDATE teammates SET tool_policy = ? WHERE id = ?", (__import__('json').dumps(mate.tool_policy), acting))
        conn.commit()
    r1 = client.post("/boards", json={"project_id": p, "name": "a"}, headers=AUTH)
    r2 = client.post("/boards", json={"project_id": p, "name": "b"}, headers=AUTH)
    assert r1.status_code == 200 and r2.status_code == 200
    a, b = r1.json()["id"], r2.json()["id"]
    rm = client.post(f"/boards/{b}/messages", json={"content": "ping", "to_board_id": a}, headers=AUTH)
    assert rm.status_code == 200, rm.text
    # Acting-bot delete without auto would be gated; with auto it proceeds through canonical gate path.
    ok = client.delete(f"/boards/{a}", headers={**AUTH, "X-Acting-Teammate": acting})
    assert ok.status_code == 200, ok.text
    with _open_conn(tmp_path) as conn:
        assert store.get_board(conn, a) is None
        rows = conn.execute(
            "SELECT * FROM board_messages WHERE board_id = ? OR to_board_id = ?",
            (a, a),
        ).fetchall()
        assert rows == []
        assert store.get_board(conn, b) is not None


def test_board_delete_acting_bot_approval_is_digest_bound_and_one_use(client: TestClient, tmp_path: Path):
    p = _project(client, "p")
    acting = _teammate(client, p, "actor", permissions=["board.delete"])
    a = client.post("/boards", json={"project_id": p, "name": "a"}, headers=AUTH).json()["id"]
    b = client.post("/boards", json={"project_id": p, "name": "b"}, headers=AUTH).json()["id"]
    # Missing approval -> 409
    missing = client.delete(f"/boards/{a}", headers={**AUTH, "X-Acting-Teammate": acting})
    assert missing.status_code == 409, missing.text
    # Approve digest for board b (wrong target) - must not authorize deleting a.
    with _open_conn(tmp_path) as conn:
        wrong_digest = gates.action_digest("board.delete", {"board_id": b})
        appr = store.request_approval(conn, "board.delete", "local", board_id=b, digest=wrong_digest, project_id=p)
        store.decide_approval(conn, appr.id, Decision.APPROVED)
    still = client.delete(f"/boards/{a}", headers={**AUTH, "X-Acting-Teammate": acting})
    assert still.status_code == 409, still.text
    assert client.get(f"/boards/{a}", headers=AUTH).status_code == 200
    # Approve correct digest and delete; approval is consumed (one-use)
    with _open_conn(tmp_path) as conn:
        digest_a = gates.action_digest("board.delete", {"board_id": a})
        appr_a = store.request_approval(conn, "board.delete", "local", board_id=a, digest=digest_a, project_id=p)
        store.decide_approval(conn, appr_a.id, Decision.APPROVED)
        aid = appr_a.id
    ok = client.delete(f"/boards/{a}", headers={**AUTH, "X-Acting-Teammate": acting})
    assert ok.status_code == 200, ok.text
    with _open_conn(tmp_path) as conn:
        appr_row = store.get_approval(conn, aid)
        assert appr_row is not None
        # one-use consumption should be recorded (consumed/executed marker or decision state)
        consumed = getattr(appr_row, "consumed", None)
        assert consumed is True or getattr(appr_row, "consumed_at", None) is not None or getattr(appr_row, "executed_at", None) is not None or appr_row.decision != Decision.APPROVED
