"""P4 Stage 3 Item 3: board read/membership authorization consistency."""

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


def test_acting_member_with_board_read_can_read_board_scoped_views(client: TestClient, tmp_path: Path):
    p = _project(client)
    b = _board(client, p)
    mate = _teammate(client, p, "reader", permissions=["board.read"])
    r = client.post(f"/boards/{b}/members", json={"teammate_id": mate}, headers=AUTH)
    assert r.status_code == 200, r.text
    acting = {"X-Acting-Teammate": mate, **AUTH}

    detail = client.get(f"/boards/{b}", headers=acting)
    assert detail.status_code == 200, detail.text
    assert detail.json()["board"]["id"] == b

    exec_view = client.get(f"/boards/{b}/execution", headers=acting)
    assert exec_view.status_code == 200, exec_view.text
    assert exec_view.json()["board"]["id"] == b
    assert "tasks" in exec_view.json()

    msgs = client.get(f"/boards/{b}/messages", headers=acting)
    assert msgs.status_code == 200, msgs.text
    assert "messages" in msgs.json()

    inbox = client.get(f"/boards/{b}/inbox", headers=acting)
    assert inbox.status_code == 200, inbox.text
    assert "inbox" in inbox.json()


def test_acting_non_member_or_without_permission_denied_board_reads(client: TestClient, tmp_path: Path):
    p = _project(client)
    b = _board(client, p)
    reader = _teammate(client, p, "reader", permissions=["board.read"])
    outsider = _teammate(client, p, "outsider", permissions=["board.read"])
    # reader is member, outsider is not
    assert client.post(f"/boards/{b}/members", json={"teammate_id": reader}, headers=AUTH).status_code == 200

    # no permission but member
    no_perm = _teammate(client, p, "noperm", permissions=[])
    assert client.post(f"/boards/{b}/members", json={"teammate_id": no_perm}, headers=AUTH).status_code == 200
    r = client.get(f"/boards/{b}/execution", headers={"X-Acting-Teammate": no_perm, **AUTH})
    assert r.status_code == 403

    # permission but not member
    r = client.get(f"/boards/{b}/execution", headers={"X-Acting-Teammate": outsider, **AUTH})
    assert r.status_code == 403
    r = client.get(f"/boards/{b}/messages", headers={"X-Acting-Teammate": outsider, **AUTH})
    assert r.status_code == 403
    r = client.get(f"/boards/{b}/inbox", headers={"X-Acting-Teammate": outsider, **AUTH})
    assert r.status_code == 403


def test_acting_cross_project_board_read_denied(client: TestClient, tmp_path: Path):
    p1 = _project(client, "p1")
    p2 = _project(client, "p2")
    b1 = _board(client, p1)
    mate2 = _teammate(client, p2, "bot2", permissions=["board.read"])
    # even if someone tried to make member (shouldn't happen cross-project), read must deny by project isolation
    r = client.get(f"/boards/{b1}/execution", headers={"X-Acting-Teammate": mate2, **AUTH})
    assert r.status_code == 403
