"""Team-as-fleet-grouping: bots join teams; the create_team tool works.

Covers the fixed membership model (a team groups bots and/or projects),
the digest-bound gate on bot membership, and the previously-broken
``create_team`` agent tool path.
"""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from nerdbot import store
from nerdbot.api import create_app

TOKEN = "team-token"
AUTH = {"Authorization": f"Bearer {TOKEN}"}
ACTING = "X-Acting-Teammate"


@pytest.fixture()
def client(tmp_path, monkeypatch):
    monkeypatch.setenv("NERDBOT_TOKEN", TOKEN)
    monkeypatch.setenv("NERDBOT_DB", str(tmp_path / "teams.db"))
    monkeypatch.setenv("NERDBOT_DATA", str(tmp_path / "data"))
    return TestClient(create_app())


def _project(client: TestClient) -> str:
    return client.post("/projects", json={"repository": "r"}, headers=AUTH).json()["id"]


def _bot(client: TestClient, pid: str, persona: str, **extra) -> dict:
    body = {"persona": persona, "permissions": []}
    body.update(extra)
    r = client.post(f"/projects/{pid}/teammates", json=body, headers=AUTH)
    assert r.status_code == 200, r.text
    return r.json()


def test_team_membership_round_trip_via_api(client) -> None:
    pid = _project(client)
    eng = _bot(client, pid, "engineer")
    rev = _bot(client, pid, "reviewer")
    team = client.post("/teams", json={"name": "Squad"}, headers=AUTH).json()

    r = client.post(
        f"/teams/{team['id']}/teammates", json={"teammate_id": eng["id"]}, headers=AUTH
    )
    assert r.status_code == 200, r.text
    assert r.json()["teammate_id"] == eng["id"]

    # create with member_ids in one call now works (was broken)
    team2 = client.post(
        "/teams", json={"name": "Squad2", "member_ids": [rev["id"]]}, headers=AUTH
    )
    assert team2.status_code == 200, team2.text

    detail = client.get(f"/teams/{team['id']}", headers=AUTH).json()
    assert {t["id"] for t in detail["teammates"]} == {eng["id"]}
    detail2 = client.get(f"/teams/{team2.json()['id']}", headers=AUTH).json()
    assert {t["id"] for t in detail2["teammates"]} == {rev["id"]}

    rm = client.delete(f"/teams/{team['id']}/teammates/{eng['id']}", headers=AUTH)
    assert rm.status_code == 200
    detail = client.get(f"/teams/{team['id']}", headers=AUTH).json()
    assert detail["teammates"] == []


def test_team_detail_returns_projects_with_decoded_config(client) -> None:
    """Regression: GET /teams/{id} must decode projects' JSON ``config`` column.

    ``list_projects_for_team`` previously built ``Project(**dict(row))``, which
    fed the raw JSON string into the ``config: dict`` field and raised a 500.
    """
    pid = _project(client)
    team = client.post(
        "/teams", json={"name": "T", "project_member_ids": [pid]}, headers=AUTH
    ).json()

    r = client.get(f"/teams/{team['id']}", headers=AUTH)
    assert r.status_code == 200, r.text
    detail = r.json()
    assert [p["id"] for p in detail["projects"]] == [pid]
    assert detail["projects"][0]["config"] == {}


def test_create_team_agent_tool_is_approval_gated(client) -> None:
    """A bot with team.create proposes a team; the owner approves the exact action."""
    pid = _project(client)
    ceo = _bot(
        client, pid, "ceo", permissions=["team.create", "teammate.create"]
    )
    coworker = _bot(client, pid, "coworker")

    client.post(
        f"/projects/{pid}/tasks",
        json={
            "description": "form a squad",
            "command": "form a squad",
            "owner_teammate_id": ceo["id"],
        },
        headers=AUTH,
    )

    # No approval yet: the bot's create_team call is gated.
    r = client.post(
        "/teams",
        json={"name": "Bot Squad", "member_ids": [coworker["id"]]},
        headers={**AUTH, ACTING: ceo["id"]},
    )
    assert r.status_code == 409, r.text
    approval = r.json()["detail"]["approval"]
    assert approval["action"] == "team.create"
    assert approval["digest"]

    # Owner approves, then the identical call succeeds.
    d = client.post(
        f"/approvals/{approval['id']}/decision",
        json={"decision": "approved"},
        headers=AUTH,
    )
    assert d.status_code == 200, d.text
    r2 = client.post(
        "/teams",
        json={"name": "Bot Squad", "member_ids": [coworker["id"]]},
        headers={**AUTH, ACTING: ceo["id"]},
    )
    assert r2.status_code == 200, r2.text
    team_id = r2.json()["id"]
    detail = client.get(f"/teams/{team_id}", headers=AUTH).json()
    assert {t["id"] for t in detail["teammates"]} == {coworker["id"]}


def test_teammate_membership_requires_permission(client) -> None:
    pid = _project(client)
    plain = _bot(client, pid, "plain")  # no team.membership
    other = _bot(client, pid, "other")
    team = client.post("/teams", json={"name": "T"}, headers=AUTH).json()
    r = client.post(
        f"/teams/{team['id']}/teammates",
        json={"teammate_id": other["id"]},
        headers={**AUTH, ACTING: plain["id"]},
    )
    assert r.status_code == 403, r.text


def test_store_cross_owner_membership_rejected(tmp_path) -> None:
    conn = store.connect(str(tmp_path / "x.db"))
    store.create_project(conn, owner="local-owner")
    p2 = store.create_project(conn, owner="someone-else")
    alien = store.create_teammate(conn, p2.id, persona="alien")
    team = store.create_team(conn, owner="local-owner", name="T")
    with pytest.raises(ValueError):
        store.add_teammate_to_team(conn, team.id, alien.id)
    conn.close()
