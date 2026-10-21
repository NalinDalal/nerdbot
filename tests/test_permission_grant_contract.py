"""The dashboard's permission and membership grants must match the backend.

The dashboard renders its permission editor from ``GET /permissions`` and
manages board membership through the board-member API. These tests pin the
contract between the two:

- the catalogue the UI renders is the catalogue the backend enforces — no
  permission is missing from one side (the drift that hid ``board.read``);
- every permission the UI can offer is actually grantable;
- a name the backend does not know is rejected instead of silently granting
  nothing;
- board membership the UI can add is one the backend accepts, and the
  memberships the backend rejects (cross-project, inactive bot) are rejected
  with a clear error the UI can surface.
"""

from __future__ import annotations

import os

import pytest
from fastapi.testclient import TestClient

from nerdbot import gates, permissions, store
from nerdbot.api import create_app

TOKEN = "grant-token"
AUTH = {"Authorization": f"Bearer {TOKEN}"}


@pytest.fixture()
def app_client(tmp_path, monkeypatch):
    from cryptography.fernet import Fernet

    monkeypatch.setenv("NERDBOT_TOKEN", TOKEN)
    monkeypatch.setenv("NERDBOT_SECRET_KEY", Fernet.generate_key().decode("ascii"))
    monkeypatch.setenv("NERDBOT_DB", str(tmp_path / "grant.db"))
    monkeypatch.setenv("NERDBOT_DATA", str(tmp_path / "data"))
    return TestClient(create_app())


def _project(client: TestClient, repository: str = "r") -> str:
    r = client.post("/projects", json={"repository": repository}, headers=AUTH)
    assert r.status_code == 200, r.text
    return r.json()["id"]


def _teammate(client: TestClient, project_id: str, persona: str = "bot", **extra) -> str:
    body: dict = {"persona": persona, "instructions": "i", "capabilities": ["code"]}
    body.update(extra)
    r = client.post(f"/projects/{project_id}/teammates", json=body, headers=AUTH)
    assert r.status_code == 200, r.text
    return r.json()["id"]


def _board(client: TestClient, project_id: str, name: str = "board") -> str:
    r = client.post(
        "/boards",
        json={"name": name, "project_id": project_id},
        headers=AUTH,
    )
    assert r.status_code == 200, r.text
    return r.json()["id"]


# -- the catalogue the UI renders ---------------------------------------------


def test_catalogue_endpoint_matches_the_enforced_set(app_client: TestClient) -> None:
    r = app_client.get("/permissions", headers=AUTH)
    assert r.status_code == 200, r.text
    body = r.json()
    names = {p["name"] for p in body["permissions"]}
    assert names == set(gates.ALL_PERMISSIONS)
    # The two that were previously missing from the dashboard's hard-coded
    # lists: board reads and team membership changes.
    assert "board.read" in names
    assert "team.membership" in names
    # Admin permissions are flagged so the UI can show the approval gate.
    by_name = {p["name"]: p for p in body["permissions"]}
    assert by_name["board.delete"]["kind"] == "admin"
    assert by_name["board.delete"]["requires_approval"] is True
    assert by_name["board.read"]["kind"] == "agent"
    assert by_name["board.read"]["requires_approval"] is False
    assert all(p["summary"] for p in body["permissions"])


def test_catalogue_has_no_permission_the_store_would_reject(app_client: TestClient) -> None:
    """Every catalogue entry survives a real grant — the UI cannot offer a
    name the backend refuses."""
    project_id = _project(app_client)
    mate_id = _teammate(app_client, project_id)
    catalogue = app_client.get("/permissions", headers=AUTH).json()["permissions"]
    for entry in catalogue:
        r = app_client.patch(
            f"/teammates/{mate_id}", json={"permissions": [entry["name"]]}, headers=AUTH
        )
        assert r.status_code == 200, f"{entry['name']}: {r.text}"
        assert r.json()["permissions"] == [entry["name"]]


def test_unknown_permission_is_rejected_not_silently_accepted(app_client: TestClient) -> None:
    project_id = _project(app_client)
    mate_id = _teammate(app_client, project_id)
    r = app_client.patch(
        f"/teammates/{mate_id}", json={"permissions": ["board.readd"]}, headers=AUTH
    )
    assert r.status_code == 400, r.text
    assert "board.readd" in r.text
    # And the bot was not changed.
    r = app_client.get(f"/teammates/{mate_id}", headers=AUTH)
    assert r.json()["permissions"] == []


def test_unknown_permission_is_rejected_on_creation(app_client: TestClient) -> None:
    project_id = _project(app_client)
    r = app_client.post(
        f"/projects/{project_id}/teammates",
        json={"persona": "x", "permissions": ["not-a-permission"]},
        headers=AUTH,
    )
    assert r.status_code == 400, r.text
    assert "not-a-permission" in r.text


def test_unknown_tool_policy_key_is_rejected(app_client: TestClient) -> None:
    project_id = _project(app_client)
    mate_id = _teammate(app_client, project_id)
    r = app_client.patch(
        f"/teammates/{mate_id}",
        json={"tool_policy": {"made.up": "auto"}},
        headers=AUTH,
    )
    assert r.status_code == 400, r.text


# -- board membership ----------------------------------------------------------


def test_owner_can_manage_board_membership_through_the_api(app_client: TestClient) -> None:
    project_id = _project(app_client)
    board_id = _board(app_client, project_id)
    mate_id = _teammate(app_client, project_id, persona="engineer")

    r = app_client.get(f"/boards/{board_id}/members", headers=AUTH)
    assert r.status_code == 200, r.text
    assert r.json()["members"] == []

    r = app_client.post(
        f"/boards/{board_id}/members",
        json={"teammate_id": mate_id, "role": "member"},
        headers=AUTH,
    )
    assert r.status_code == 200, r.text

    r = app_client.get(f"/boards/{board_id}/members", headers=AUTH)
    assert [m["teammate_id"] for m in r.json()["members"]] == [mate_id]

    # Membership is what makes board.read work for the bot.
    conn = store.connect(os.environ["NERDBOT_DB"])
    assert store.actor_can_access_board(conn, board_id, mate_id) is True
    conn.close()

    r = app_client.delete(f"/boards/{board_id}/members/{mate_id}", headers=AUTH)
    assert r.status_code == 200, r.text
    r = app_client.get(f"/boards/{board_id}/members", headers=AUTH)
    assert r.json()["members"] == []


def test_membership_of_a_bot_from_another_project_is_rejected(app_client: TestClient) -> None:
    project_a = _project(app_client, "a")
    project_b = _project(app_client, "b")
    board_id = _board(app_client, project_a)
    foreign_mate = _teammate(app_client, project_b, persona="outsider")

    r = app_client.post(
        f"/boards/{board_id}/members",
        json={"teammate_id": foreign_mate, "role": "member"},
        headers=AUTH,
    )
    assert r.status_code == 400, r.text
    assert "project" in r.text.lower()


def test_membership_of_an_inactive_bot_is_rejected(app_client: TestClient) -> None:
    project_id = _project(app_client)
    board_id = _board(app_client, project_id)
    mate_id = _teammate(app_client, project_id, persona="engineer")
    r = app_client.post(f"/teammates/{mate_id}/archive", headers=AUTH)
    assert r.status_code == 200, r.text

    r = app_client.post(
        f"/boards/{board_id}/members",
        json={"teammate_id": mate_id, "role": "member"},
        headers=AUTH,
    )
    assert r.status_code == 400, r.text
    assert "active" in r.text.lower()


def test_catalogue_helper_reports_unknown_names() -> None:
    assert permissions.unknown_permissions(["board.read", "nope"]) == ["nope"]
    assert permissions.unknown_permissions(["board.read"]) == []
    assert permissions.unknown_permissions("not-a-list") == []
    assert permissions.unknown_permissions(None) == []
