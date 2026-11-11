"""P4 Stage 3 Item 4: messaging and inbox integrity/validation parity."""

from __future__ import annotations

from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from nerdbot import store
from nerdbot.api import create_app

TOKEN = "p4-stage3-token"
AUTH = {"Authorization": f"Bearer {TOKEN}"}


@pytest.fixture()
def client(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setenv("NERDBOT_TOKEN", TOKEN)
    monkeypatch.setenv("NERDBOT_DB", str(tmp_path / "nerdbot.db"))
    monkeypatch.setenv("NERDBOT_DATA", str(tmp_path / "data"))
    monkeypatch.delenv("NERDBOT_STATIC_DIR", raising=False)
    with TestClient(create_app()) as c:
        yield c


def _project(client: TestClient, name: str = "p") -> str:
    r = client.post("/projects", json={"repository": name}, headers=AUTH)
    assert r.status_code == 200, r.text
    return r.json()["id"]


def _teammate(client: TestClient, project_id: str, name: str = "bot", permissions=None) -> str:
    body = {"persona": name, "name": name}
    if permissions is not None:
        body["permissions"] = permissions
    r = client.post(f"/projects/{project_id}/teammates", json=body, headers=AUTH)
    assert r.status_code == 200, r.text
    return r.json()["id"]


def _board(client: TestClient, project_id: str, name: str = "b") -> str:
    r = client.post("/boards", json={"name": name, "project_id": project_id}, headers=AUTH)
    assert r.status_code == 200, r.text
    return r.json()["id"]


def test_human_message_rejects_cross_project_targets(client: TestClient):
    p1 = _project(client, "p1")
    p2 = _project(client, "p2")
    b1 = _board(client, p1, "b1")
    b2 = _board(client, p2, "b2")
    t2 = _teammate(client, p2, "t2")

    r = client.post(f"/boards/{b1}/messages", json={"content": "x", "to_board_id": b2}, headers=AUTH)
    assert r.status_code == 400, r.text

    r = client.post(f"/boards/{b1}/messages", json={"content": "x", "to_teammate_id": t2}, headers=AUTH)
    assert r.status_code == 400, r.text


def test_human_message_allows_same_project_targets_and_inbox(client: TestClient):
    p = _project(client)
    b1 = _board(client, p, "b1")
    b2 = _board(client, p, "b2")
    t1 = _teammate(client, p, "t1")
    t2 = _teammate(client, p, "t2")

    r = client.post(
        f"/boards/{b1}/messages",
        json={"content": "hello", "to_board_id": b2, "to_teammate_id": t2},
        headers=AUTH,
    )
    assert r.status_code == 200, r.text
    msg = r.json()
    assert msg["board_id"] == b1
    assert msg["to_board_id"] == b2
    assert msg["to_teammate_id"] == t2
    # Human owner path posts without an acting teammate sender.
    assert msg["from_teammate_id"] is None

    inbox = client.get(f"/boards/{b2}/inbox", headers=AUTH)
    assert inbox.status_code == 200
    assert any(m["id"] == msg["id"] for m in inbox.json()["inbox"])


def test_acting_bot_message_enforces_same_project_targets(client: TestClient, tmp_path: Path):
    p1 = _project(client, "p1")
    p2 = _project(client, "p2")
    b1 = _board(client, p1, "b1")
    b2 = _board(client, p2, "b2")
    t2 = _teammate(client, p2, "t2")
    bot = _teammate(client, p1, "bot", permissions=["board.message", "board.read", "message.send"])
    # acting bot must be member for board.message/read flows where applicable; message service authorizes messaging on board
    conn = store.connect(str(tmp_path / "nerdbot.db"))
    try:
        store.create_board_member(conn, b1, bot)
    finally:
        conn.close()

    acting = {"X-Acting-Teammate": bot, **AUTH}
    r = client.post(f"/boards/{b1}/messages", json={"content": "x", "to_board_id": b2}, headers=acting)
    assert r.status_code == 400, r.text
    r = client.post(f"/boards/{b1}/messages", json={"content": "x", "to_teammate_id": t2}, headers=acting)
    assert r.status_code == 400, r.text
