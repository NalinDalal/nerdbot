"""Board roster changes are digest-bound approvals for bots.

Adding or removing a board member changes who can coordinate, the same way
creating a teammate does, so a bot holding ``teammate.create`` must first
win owner approval for the exact (board, teammate) pair. The human owner
path (no acting teammate) is never gated.
"""

from __future__ import annotations

import os

import pytest
from fastapi.testclient import TestClient

from nerdbot.api import create_app

TOKEN = "board-roster-token"
AUTH = {"Authorization": f"Bearer {TOKEN}"}
ACTING = "X-Acting-Teammate"


@pytest.fixture()
def client(tmp_path, monkeypatch):
    monkeypatch.setenv("NERDBOT_TOKEN", TOKEN)
    monkeypatch.setenv("NERDBOT_DB", str(tmp_path / "roster.db"))
    monkeypatch.setenv("NERDBOT_DATA", str(tmp_path / "data"))
    return TestClient(create_app())


def _project(client: TestClient) -> str:
    return client.post("/projects", json={"repository": "r"}, headers=AUTH).json()["id"]


def _bot(client: TestClient, pid: str, persona: str, **extra) -> dict:
    body = {"persona": persona, "permissions": []}
    body.update(extra)
    return client.post(f"/projects/{pid}/teammates", json=body, headers=AUTH).json()


def test_board_member_add_requires_approval_for_bot(client) -> None:
    """A bot with teammate.create proposes the roster change; owner approves the digest."""
    pid = _project(client)
    ceo = _bot(client, pid, "ceo", permissions=["teammate.create"])
    worker = _bot(client, pid, "worker")
    board_id = client.post(
        "/boards", json={"name": "Standup", "project_id": pid}, headers=AUTH
    ).json()["id"]

    r = client.post(
        f"/boards/{board_id}/members",
        json={"teammate_id": worker["id"], "role": "member"},
        headers={**AUTH, ACTING: ceo["id"]},
    )
    assert r.status_code == 409, r.text
    approval = r.json()["detail"]["approval"]
    assert approval["action"] == "teammate.create"
    assert approval["digest"]

    # Approve, then the identical call proceeds and the roster shows the member.
    d = client.post(
        f"/approvals/{approval['id']}/decision", json={"decision": "approved"}, headers=AUTH
    )
    assert d.status_code == 200, d.text
    r2 = client.post(
        f"/boards/{board_id}/members",
        json={"teammate_id": worker["id"], "role": "member"},
        headers={**AUTH, ACTING: ceo["id"]},
    )
    assert r2.status_code == 200, r2.text
    members = client.get(f"/boards/{board_id}/members", headers=AUTH).json()["members"]
    member_ids = {m["teammate_id"] for m in members}
    assert worker["id"] in member_ids


def test_board_member_remove_requires_approval_for_bot(client) -> None:
    """Removing a member from a bot goes through the same approval flow."""
    pid = _project(client)
    ceo = _bot(client, pid, "ceo", permissions=["teammate.create"])
    worker = _bot(client, pid, "worker")
    board_id = client.post(
        "/boards", json={"name": "Standup", "project_id": pid}, headers=AUTH
    ).json()["id"]
    # Owner adds the member first (human path, not gated).
    client.post(
        f"/boards/{board_id}/members",
        json={"teammate_id": worker["id"]},
        headers=AUTH,
    )

    r = client.delete(
        f"/boards/{board_id}/members/{worker['id']}",
        headers={**AUTH, ACTING: ceo["id"]},
    )
    assert r.status_code == 409, r.text
    approval = r.json()["detail"]["approval"]
    assert approval["action"] == "teammate.create"

    d = client.post(
        f"/approvals/{approval['id']}/decision", json={"decision": "approved"}, headers=AUTH
    )
    assert d.status_code == 200, d.text
    r2 = client.delete(
        f"/boards/{board_id}/members/{worker['id']}",
        headers={**AUTH, ACTING: ceo["id"]},
    )
    assert r2.status_code == 200, r2.text
    members = client.get(f"/boards/{board_id}/members", headers=AUTH).json()["members"]
    member_ids = {m["teammate_id"] for m in members}
    assert worker["id"] not in member_ids


def test_board_member_change_denied_without_permission(client) -> None:
    """A bot without teammate.create is denied outright — no approval is created."""
    pid = _project(client)
    plain = _bot(client, pid, "plain")
    worker = _bot(client, pid, "worker")
    board_id = client.post(
        "/boards", json={"name": "Standup", "project_id": pid}, headers=AUTH
    ).json()["id"]

    r = client.post(
        f"/boards/{board_id}/members",
        json={"teammate_id": worker["id"]},
        headers={**AUTH, ACTING: plain["id"]},
    )
    assert r.status_code == 403, r.text
    assert "approval" not in r.text


def test_board_member_add_untouched_for_owner(client) -> None:
    """The human owner path (no acting teammate) is not gated."""
    pid = _project(client)
    worker = _bot(client, pid, "worker")
    board_id = client.post(
        "/boards", json={"name": "Standup", "project_id": pid}, headers=AUTH
    ).json()["id"]
    r = client.post(
        f"/boards/{board_id}/members", json={"teammate_id": worker["id"]}, headers=AUTH
    )
    assert r.status_code == 200, r.text


def test_approval_does_not_transfer_to_another_teammate(client) -> None:
    """A digest binds the approval to one (board, teammate, role) triple."""
    pid = _project(client)
    ceo = _bot(client, pid, "ceo", permissions=["teammate.create"])
    worker = _bot(client, pid, "worker")
    other = _bot(client, pid, "other")
    board_id = client.post(
        "/boards", json={"name": "Standup", "project_id": pid}, headers=AUTH
    ).json()["id"]

    r = client.post(
        f"/boards/{board_id}/members",
        json={"teammate_id": worker["id"]},
        headers={**AUTH, ACTING: ceo["id"]},
    )
    assert r.status_code == 409, r.text
    approval = r.json()["detail"]["approval"]
    client.post(
        f"/approvals/{approval['id']}/decision", json={"decision": "approved"}, headers=AUTH
    )

    # The approved digest must not authorize a different teammate.
    r2 = client.post(
        f"/boards/{board_id}/members",
        json={"teammate_id": other["id"]},
        headers={**AUTH, ACTING: ceo["id"]},
    )
    assert r2.status_code == 409, r2.text
    assert r2.json()["detail"]["approval"]["id"] != approval["id"]


def test_approval_does_not_transfer_to_a_different_role(client) -> None:
    """Changing the role changes the digest, so the approval cannot be reused."""
    pid = _project(client)
    ceo = _bot(client, pid, "ceo", permissions=["teammate.create"])
    worker = _bot(client, pid, "worker")
    board_id = client.post(
        "/boards", json={"name": "Standup", "project_id": pid}, headers=AUTH
    ).json()["id"]

    r = client.post(
        f"/boards/{board_id}/members",
        json={"teammate_id": worker["id"], "role": "member"},
        headers={**AUTH, ACTING: ceo["id"]},
    )
    assert r.status_code == 409, r.text
    approval = r.json()["detail"]["approval"]
    client.post(
        f"/approvals/{approval['id']}/decision", json={"decision": "approved"}, headers=AUTH
    )

    r2 = client.post(
        f"/boards/{board_id}/members",
        json={"teammate_id": worker["id"], "role": "owner"},
        headers={**AUTH, ACTING: ceo["id"]},
    )
    assert r2.status_code == 409, r2.text


def test_add_approval_does_not_authorize_a_removal(client) -> None:
    """Approving "add this bot to this board" must not authorize removing it."""
    pid = _project(client)
    ceo = _bot(client, pid, "ceo", permissions=["teammate.create"])
    worker = _bot(client, pid, "worker")
    board_id = client.post(
        "/boards", json={"name": "Standup", "project_id": pid}, headers=AUTH
    ).json()["id"]
    # The owner adds the member first (human path, not gated).
    client.post(
        f"/boards/{board_id}/members",
        json={"teammate_id": worker["id"], "role": "member"},
        headers=AUTH,
    )

    r = client.post(
        f"/boards/{board_id}/members",
        json={"teammate_id": worker["id"], "role": "member"},
        headers={**AUTH, ACTING: ceo["id"]},
    )
    assert r.status_code == 409, r.text
    approval = r.json()["detail"]["approval"]
    client.post(
        f"/approvals/{approval['id']}/decision", json={"decision": "approved"}, headers=AUTH
    )

    # The removal is a different action: it asks for its own approval.
    removal = client.delete(
        f"/boards/{board_id}/members/{worker['id']}",
        headers={**AUTH, ACTING: ceo["id"]},
    )
    assert removal.status_code == 409, removal.text
    members = client.get(f"/boards/{board_id}/members", headers=AUTH).json()["members"]
    assert worker["id"] in {m["teammate_id"] for m in members}


def test_approval_is_single_use(client) -> None:
    """One approval authorizes one roster change, not a standing permission."""
    pid = _project(client)
    ceo = _bot(client, pid, "ceo", permissions=["teammate.create"])
    worker = _bot(client, pid, "worker")
    board_id = client.post(
        "/boards", json={"name": "Standup", "project_id": pid}, headers=AUTH
    ).json()["id"]

    r = client.post(
        f"/boards/{board_id}/members",
        json={"teammate_id": worker["id"]},
        headers={**AUTH, ACTING: ceo["id"]},
    )
    approval = r.json()["detail"]["approval"]
    client.post(
        f"/approvals/{approval['id']}/decision", json={"decision": "approved"}, headers=AUTH
    )
    ok = client.post(
        f"/boards/{board_id}/members",
        json={"teammate_id": worker["id"]},
        headers={**AUTH, ACTING: ceo["id"]},
    )
    assert ok.status_code == 200, ok.text

    # The same approval is spent: a second attempt asks again.
    again = client.post(
        f"/boards/{board_id}/members",
        json={"teammate_id": worker["id"]},
        headers={**AUTH, ACTING: ceo["id"]},
    )
    assert again.status_code == 409, again.text
    assert again.json()["detail"]["approval"]["id"] != approval["id"]


def test_board_member_add_denied_without_permission_creates_no_approval(client) -> None:
    """A denied bot must not leave a pending approval behind."""
    from nerdbot import store

    pid = _project(client)
    plain = _bot(client, pid, "plain")
    worker = _bot(client, pid, "worker")
    board_id = client.post(
        "/boards", json={"name": "Standup", "project_id": pid}, headers=AUTH
    ).json()["id"]

    r = client.post(
        f"/boards/{board_id}/members",
        json={"teammate_id": worker["id"]},
        headers={**AUTH, ACTING: plain["id"]},
    )
    assert r.status_code == 403, r.text

    conn = store.connect(os.environ["NERDBOT_DB"])
    try:
        count = conn.execute("SELECT COUNT(*) AS n FROM approvals").fetchone()["n"]
    finally:
        conn.close()
    assert count == 0
