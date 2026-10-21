"""Recent conversations are reachable from anywhere, not just their project.

The Command Center is a cross-workspace surface: its resume list has to
include conversations started in *other* projects, or a conversation is only
reachable from the workspace that happens to own it. These tests pin the
cross-project listing and its owner scoping.
"""

from __future__ import annotations

import os

import pytest
from fastapi.testclient import TestClient

from nerdbot import store
from nerdbot.api import create_app

TOKEN = "recent-threads-token"
AUTH = {"Authorization": f"Bearer {TOKEN}"}


@pytest.fixture()
def client(tmp_path, monkeypatch):
    monkeypatch.setenv("NERDBOT_TOKEN", TOKEN)
    monkeypatch.setenv("NERDBOT_DB", str(tmp_path / "threads.db"))
    monkeypatch.setenv("NERDBOT_DATA", str(tmp_path / "data"))
    return TestClient(create_app())


def _project(client: TestClient, repository: str) -> str:
    return client.post("/projects", json={"repository": repository}, headers=AUTH).json()["id"]


def _thread(client: TestClient, pid: str, title: str) -> str:
    r = client.post(f"/projects/{pid}/threads", json={"title": title}, headers=AUTH)
    assert r.status_code == 200, r.text
    return r.json()["id"]


def test_recent_threads_span_every_project(client) -> None:
    """A conversation in another project is still in the resume list."""
    a = _project(client, "alpha")
    b = _project(client, "beta")
    in_a = _thread(client, a, "conversation in alpha")
    in_b = _thread(client, b, "conversation in beta")

    r = client.get("/threads", headers=AUTH)
    assert r.status_code == 200, r.text
    ids = [t["id"] for t in r.json()["threads"]]
    assert in_a in ids, "a conversation from another project was missing"
    assert in_b in ids


def test_recent_threads_carry_their_project(client) -> None:
    """The list says which project each conversation belongs to."""
    b = _project(client, "beta")
    in_b = _thread(client, b, "conversation in beta")

    r = client.get("/threads", headers=AUTH)
    assert r.status_code == 200, r.text
    by_id = {t["id"]: t for t in r.json()["threads"]}
    assert by_id[in_b]["project_id"] == b


def test_recent_threads_are_newest_first(client) -> None:
    """The list is a resume list: most recent conversation first."""
    pid = _project(client, "alpha")
    older = _thread(client, pid, "older")
    newer = _thread(client, pid, "newer")

    r = client.get("/threads", headers=AUTH)
    assert r.status_code == 200, r.text
    ids = [t["id"] for t in r.json()["threads"]]
    assert ids.index(newer) < ids.index(older), "the newest conversation is not first"


def test_recent_threads_honour_the_limit(client) -> None:
    pid = _project(client, "alpha")
    for i in range(5):
        _thread(client, pid, f"thread {i}")

    r = client.get("/threads", params={"limit": 2}, headers=AUTH)
    assert r.status_code == 200, r.text
    assert len(r.json()["threads"]) == 2


def test_recent_threads_are_owner_scoped(client) -> None:
    """A project owned by somebody else is not listed."""
    a = _project(client, "alpha")
    mine = _thread(client, a, "mine")

    # The app is single-principal, but the query is owner-scoped and has to
    # stay that way: a project owned by another principal must not leak.
    conn = store.connect(os.environ["NERDBOT_DB"])
    try:
        theirs = store.create_project(conn, owner="someone-else", repository="theirs")
        store.create_thread(conn, theirs.id, title="not yours")
        conn.commit()
    finally:
        conn.close()

    r = client.get("/threads", headers=AUTH)
    assert r.status_code == 200, r.text
    ids = [t["id"] for t in r.json()["threads"]]
    assert mine in ids
    assert all(t["project_id"] == a for t in r.json()["threads"]), (
        "a conversation from another owner's project was listed"
    )


def test_recent_threads_require_authentication(client) -> None:
    r = client.get("/threads")
    assert r.status_code in (401, 403), r.text
