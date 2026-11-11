"""Phase 9 P4 Stage 2: team lifecycle and grouping completeness."""

from __future__ import annotations

import os
import sqlite3
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from nerdbot import store
from nerdbot.api import create_app
from nerdbot.models import BoardStatus

TOKEN = "p4-stage2-token"
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


def _teammate(client: TestClient, project_id: str, name: str = "bot") -> str:
    r = client.post(
        f"/projects/{project_id}/teammates",
        json={"persona": name, "name": name},
        headers=AUTH,
    )
    assert r.status_code == 200, r.text
    return r.json()["id"]


def _team(client: TestClient, name: str = "team", description: str = "desc") -> str:
    r = client.post("/teams", json={"name": name, "description": description}, headers=AUTH)
    assert r.status_code == 200, r.text
    return r.json()["id"]


def _open_conn(tmp_path: Path) -> sqlite3.Connection:
    db = os.environ.get("NERDBOT_DB") or str(tmp_path / "nerdbot.db")
    return store.connect(db)


def test_team_rename_success_and_invalid_metadata(client: TestClient):
    tid = _team(client, "Alpha")
    ok = client.patch(f"/teams/{tid}", json={"name": "Beta", "description": "updated"}, headers=AUTH)
    assert ok.status_code == 200, ok.text
    body = ok.json()
    assert body["name"] == "Beta"
    assert body["description"] == "updated"
    assert body["id"] == tid

    bad_empty = client.patch(f"/teams/{tid}", json={"name": "   "}, headers=AUTH)
    assert bad_empty.status_code == 400, bad_empty.text

    bad_long = client.patch(f"/teams/{tid}", json={"name": "x" * 121}, headers=AUTH)
    assert bad_long.status_code == 400, bad_long.text

    # preserve identity/associations
    detail = client.get(f"/teams/{tid}", headers=AUTH)
    assert detail.status_code == 200
    assert detail.json()["team"]["id"] == tid


def test_unauthorized_team_rename_rejected(client: TestClient):
    tid = _team(client, "Alpha")
    r = client.patch(f"/teams/{tid}", json={"name": "Nope"}, headers={"Authorization": "Bearer wrong"})
    assert r.status_code in (401, 403), r.text
    # cross-owner cannot see/edit
    with TestClient(create_app()) as other:
        # different token context not needed; simulate other principal by wrong auth rejected above.
        pass


def test_cross_owner_team_access_rejected(client: TestClient, tmp_path: Path):
    tid = _team(client, "Alpha")
    # create another owner's team directly and ensure principal cannot access it
    with _open_conn(tmp_path) as conn:
        other_team = store.create_team(conn, "other-owner", "Secret")
        other_id = other_team.id
    r = client.get(f"/teams/{other_id}", headers=AUTH)
    assert r.status_code == 404, r.text
    r2 = client.patch(f"/teams/{other_id}", json={"name": "x"}, headers=AUTH)
    assert r2.status_code == 404, r2.text
    r3 = client.delete(f"/teams/{other_id}", headers=AUTH)
    assert r3.status_code == 404, r3.text
    # original owner team unaffected
    assert client.get(f"/teams/{tid}", headers=AUTH).status_code == 200


def test_archive_and_restore_team_and_listing_behavior(client: TestClient):
    tid = _team(client, "Alpha")
    ar = client.post(f"/teams/{tid}/archive", headers=AUTH)
    assert ar.status_code == 200, ar.text
    assert ar.json()["status"] == "archived"

    active = client.get("/teams", headers=AUTH).json()["teams"]
    assert all(t["id"] != tid for t in active)
    archived = client.get("/teams?status=archived", headers=AUTH).json()["teams"]
    assert any(t["id"] == tid and t["status"] == "archived" for t in archived)
    all_teams = client.get("/teams?status=all", headers=AUTH).json()["teams"]
    assert any(t["id"] == tid for t in all_teams)

    # detail remains accessible to owner and clearly archived
    detail = client.get(f"/teams/{tid}", headers=AUTH).json()
    assert detail["team"]["status"] == "archived"

    rs = client.post(f"/teams/{tid}/restore", headers=AUTH)
    assert rs.status_code == 200, rs.text
    assert rs.json()["status"] == "active"
    active2 = client.get("/teams", headers=AUTH).json()["teams"]
    assert any(t["id"] == tid for t in active2)


def test_archived_team_membership_restrictions(client: TestClient):
    p = _project(client, "p")
    bot = _teammate(client, p, "bot")
    p2 = _project(client, "p2")
    tid = _team(client, "Alpha")
    client.post(f"/teams/{tid}/archive", headers=AUTH)

    r1 = client.post(f"/teams/{tid}/teammates", json={"teammate_id": bot}, headers=AUTH)
    assert r1.status_code == 400, r1.text
    assert "archived" in r1.json().get("detail", "").lower()

    r2 = client.post(f"/teams/{tid}/projects", json={"project_id": p2}, headers=AUTH)
    assert r2.status_code == 400, r2.text
    assert "archived" in r2.json().get("detail", "").lower()

    # restore allows additions again
    client.post(f"/teams/{tid}/restore", headers=AUTH)
    ok = client.post(f"/teams/{tid}/teammates", json={"teammate_id": bot}, headers=AUTH)
    assert ok.status_code == 200, ok.text


def test_safe_team_deletion_preserves_identities_workspaces_and_cleans_memberships(client: TestClient, tmp_path: Path):
    p = _project(client, "p")
    bot = _teammate(client, p, "bot")
    tid = _team(client, "Alpha")
    assert client.post(f"/teams/{tid}/teammates", json={"teammate_id": bot}, headers=AUTH).status_code == 200
    assert client.post(f"/teams/{tid}/projects", json={"project_id": p}, headers=AUTH).status_code == 200

    # board reference to team must be handled explicitly on delete
    with _open_conn(tmp_path) as conn:
        owner = store.get_team(conn, tid).owner
        board = store.create_board(conn, owner, "b", project_id=p, team_id=tid)
        board_id = board.id
        assert board.team_id == tid

    d = client.delete(f"/teams/{tid}", headers=AUTH)
    assert d.status_code == 200, d.text
    assert d.json().get("deleted") is True

    # repeated delete -> consistent not-found
    d2 = client.delete(f"/teams/{tid}", headers=AUTH)
    assert d2.status_code == 404, d2.text

    with _open_conn(tmp_path) as conn:
        assert store.get_team(conn, tid) is None
        assert conn.execute("SELECT COUNT(*) AS n FROM team_members WHERE team_id = ?", (tid,)).fetchone()["n"] == 0
        # global teammate and workspace preserved
        mate = store.get_teammate(conn, bot)
        assert mate is not None
        assert store.get_project(conn, p) is not None
        # board preserved, team reference cleared
        b = store.get_board(conn, board_id)
        assert b is not None
        assert b.team_id in (None, "")

    # teammate still accessible and in workspace
    assert client.get(f"/teammates/{bot}", headers=AUTH).status_code == 200


def test_membership_lifecycle_idempotent_add_and_remove_preserves_workspace_membership(client: TestClient, tmp_path: Path):
    p = _project(client, "p")
    bot = _teammate(client, p, "bot")
    tid = _team(client, "Alpha")

    a = client.post(f"/teams/{tid}/teammates", json={"teammate_id": bot}, headers=AUTH)
    b = client.post(f"/teams/{tid}/teammates", json={"teammate_id": bot}, headers=AUTH)
    assert a.status_code == 200 and b.status_code == 200, (a.text, b.text)

    with _open_conn(tmp_path) as conn:
        assert conn.execute(
            "SELECT COUNT(*) AS n FROM team_members WHERE team_id = ? AND teammate_id = ?",
            (tid, bot),
        ).fetchone()["n"] == 1
        assert store.teammate_in_project(conn, bot, p)

    # add workspace membership idempotently
    w1 = client.post(f"/teams/{tid}/projects", json={"project_id": p}, headers=AUTH)
    w2 = client.post(f"/teams/{tid}/projects", json={"project_id": p}, headers=AUTH)
    assert w1.status_code == 200 and w2.status_code == 200

    rm = client.delete(f"/teams/{tid}/teammates/{bot}", headers=AUTH)
    assert rm.status_code == 200, rm.text
    # removal from team must not remove workspace membership or identity
    with _open_conn(tmp_path) as conn:
        assert store.get_teammate(conn, bot) is not None
        assert store.teammate_in_project(conn, bot, p)
        assert conn.execute(
            "SELECT COUNT(*) AS n FROM team_members WHERE team_id = ? AND teammate_id = ?",
            (tid, bot),
        ).fetchone()["n"] == 0

    rmw = client.delete(f"/teams/{tid}/projects/{p}", headers=AUTH)
    assert rmw.status_code == 200, rmw.text
    assert store.get_project(conn, p) is not None


def test_acting_bot_cannot_manage_team_lifecycle(client: TestClient):
    p = _project(client, "p")
    actor = _teammate(client, p, "actor")
    tid = _team(client, "Alpha")
    ah = {**AUTH, "X-Acting-Teammate": actor}

    assert client.patch(f"/teams/{tid}", json={"name": "x"}, headers=ah).status_code == 403
    assert client.post(f"/teams/{tid}/archive", headers=ah).status_code == 403
    assert client.post(f"/teams/{tid}/restore", headers=ah).status_code == 403
    assert client.delete(f"/teams/{tid}", headers=ah).status_code == 403
    assert client.post(f"/teams/{tid}/projects", json={"project_id": p}, headers=ah).status_code == 403
    assert client.delete(f"/teams/{tid}/projects/{p}", headers=ah).status_code == 403


def test_team_deletion_is_transactional_on_failure(client: TestClient, tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    p = _project(client, "p")
    bot = _teammate(client, p, "bot")
    tid = _team(client, "Alpha")
    client.post(f"/teams/{tid}/teammates", json={"teammate_id": bot}, headers=AUTH)
    client.post(f"/teams/{tid}/projects", json={"project_id": p}, headers=AUTH)

    real_connect = store.connect

    class TxFailConn(sqlite3.Connection):
        def commit(self) -> None:
            import inspect
            if any(frame.function == "delete_team" for frame in inspect.stack()):
                raise sqlite3.OperationalError("boom")
            return super().commit()

    def connect_fail(db_path):
        path = Path(db_path)
        if str(path) != ":memory:":
            path.parent.mkdir(parents=True, exist_ok=True)
        conn = sqlite3.connect(str(path), check_same_thread=False, factory=TxFailConn)
        conn.row_factory = sqlite3.Row
        conn.execute(f"PRAGMA busy_timeout = {store.BUSY_TIMEOUT_MS}")
        conn.executescript(store.SCHEMA)
        store._migrate(conn)
        return conn

    monkeypatch.setattr(store, "connect", connect_fail)
    with TestClient(create_app(), raise_server_exceptions=False) as bad_client:
        r = bad_client.delete(f"/teams/{tid}", headers=AUTH)
    assert r.status_code == 500, r.text
    monkeypatch.setattr(store, "connect", real_connect)

    with _open_conn(tmp_path) as conn:
        assert store.get_team(conn, tid) is not None
        assert conn.execute("SELECT COUNT(*) AS n FROM team_members WHERE team_id = ?", (tid,)).fetchone()["n"] >= 1
        assert store.get_teammate(conn, bot) is not None
        assert store.get_project(conn, p) is not None
