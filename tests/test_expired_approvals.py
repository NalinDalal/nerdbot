"""An expired, undecided approval is not pending.

An approval carries an expiry. Once it passes and nobody decided it, the
approval is dead: the decision endpoint answers 410. The bug this file pins
is that the pending list still reported it as pending, so the dashboard
offered the owner a decision that was guaranteed to fail (the "Error 410:
approval apr_... expired" the owner actually clicked into).

The rule lives in one place on the server (``store.approval_is_pending``)
and is mirrored in the dashboard (``approvalIsPending``); this file pins the
server half.
"""

from __future__ import annotations

import os
from datetime import UTC, datetime, timedelta

import pytest
from fastapi.testclient import TestClient

from nerdbot import store
from nerdbot.api import create_app
from nerdbot.models import Decision

TOKEN = "expired-approval-token"
AUTH = {"Authorization": f"Bearer {TOKEN}"}


@pytest.fixture()
def client(tmp_path, monkeypatch):
    monkeypatch.setenv("NERDBOT_TOKEN", TOKEN)
    monkeypatch.setenv("NERDBOT_DB", str(tmp_path / "approvals.db"))
    monkeypatch.setenv("NERDBOT_DATA", str(tmp_path / "data"))
    return TestClient(create_app())


def _project(client: TestClient) -> str:
    return client.post("/projects", json={"repository": "r"}, headers=AUTH).json()["id"]


def _pending_approval(client: TestClient, pid: str, ttl_s: int = 600) -> str:
    """A gate approval awaiting the owner's decision."""
    conn = store.connect(os.environ["NERDBOT_DB"])
    try:
        approval = store.request_approval(
            conn,
            action="teammate.create",
            requester="tm_test",
            project_id=pid,
            ttl_s=ttl_s,
        )
        conn.commit()
        return approval.id
    finally:
        conn.close()


def test_expired_approval_is_not_reported_as_pending(client) -> None:
    """The pending list must not contain an approval nobody can decide."""
    pid = _project(client)
    approval_id = _pending_approval(client, pid)

    conn = store.connect(os.environ["NERDBOT_DB"])
    try:
        past = (datetime.now(UTC) - timedelta(minutes=5)).isoformat()
        conn.execute("UPDATE approvals SET expires_at = ? WHERE id = ?", (past, approval_id))
        conn.commit()
    finally:
        conn.close()

    pending = client.get(
        f"/projects/{pid}/approvals", params={"decision": "pending"}, headers=AUTH
    )
    assert pending.status_code == 200, pending.text
    ids = [a["id"] for a in pending.json()["approvals"]]
    assert approval_id not in ids, "an expired approval was reported as pending"


def test_live_approval_is_still_reported_as_pending(client) -> None:
    """The rule must not swallow approvals that are still decidable."""
    pid = _project(client)
    approval_id = _pending_approval(client, pid)

    pending = client.get(
        f"/projects/{pid}/approvals", params={"decision": "pending"}, headers=AUTH
    )
    assert pending.status_code == 200, pending.text
    ids = [a["id"] for a in pending.json()["approvals"]]
    assert approval_id in ids


def test_expired_approval_still_answers_410(client) -> None:
    """Deciding an expired approval is refused, not silently accepted."""
    pid = _project(client)
    approval_id = _pending_approval(client, pid)

    conn = store.connect(os.environ["NERDBOT_DB"])
    try:
        past = (datetime.now(UTC) - timedelta(minutes=5)).isoformat()
        conn.execute("UPDATE approvals SET expires_at = ? WHERE id = ?", (past, approval_id))
        conn.commit()
    finally:
        conn.close()

    r = client.post(
        f"/approvals/{approval_id}/decision", json={"decision": "approved"}, headers=AUTH
    )
    assert r.status_code == 410, r.text
    assert "expired" in r.text


def test_expired_approval_remains_queryable_as_history(client) -> None:
    """Hiding it from pending must not erase it from the record."""
    pid = _project(client)
    approval_id = _pending_approval(client, pid)

    conn = store.connect(os.environ["NERDBOT_DB"])
    try:
        past = (datetime.now(UTC) - timedelta(minutes=5)).isoformat()
        conn.execute("UPDATE approvals SET expires_at = ? WHERE id = ?", (past, approval_id))
        conn.commit()
    finally:
        conn.close()

    every = client.get(f"/projects/{pid}/approvals", headers=AUTH)
    assert every.status_code == 200, every.text
    ids = [a["id"] for a in every.json()["approvals"]]
    assert approval_id in ids, "the expired approval vanished from the project's record"


def test_approval_is_pending_predicate() -> None:
    """The predicate is the single source of truth for 'still actionable'."""
    now = datetime.now(UTC)

    class Fake:
        def __init__(self, decision, expires_at):
            self.decision = decision
            self.expires_at = expires_at

    assert store.approval_is_pending(Fake(Decision.PENDING, None), now=now) is True
    assert store.approval_is_pending(Fake(Decision.PENDING, now + timedelta(minutes=5)), now=now) is True
    assert store.approval_is_pending(Fake(Decision.PENDING, now - timedelta(minutes=5)), now=now) is False
    assert store.approval_is_pending(Fake(Decision.APPROVED, None), now=now) is False
    assert store.approval_is_pending(Fake(Decision.DENIED, now + timedelta(minutes=5)), now=now) is False
