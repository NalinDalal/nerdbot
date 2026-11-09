"""Named-teammate chat: @mention resolution, speaker prompts, attribution.

Feature: the owner addresses a teammate with ``@handle``; that teammate's
identity becomes the system prompt and its id is stamped on the saved reply,
so the dashboard can draw the reply's face and name. Backup and migration
must carry the two new fields.
"""

from __future__ import annotations

import json
import os
import sqlite3

import pytest
from fastapi.testclient import TestClient

from nerdbot import backup, fleet, store
from nerdbot import chat as chat_mod
from nerdbot import seed as seed_mod
from nerdbot.api import create_app
from nerdbot.models import TeammateStatus

TOKEN = "named-token"
AUTH = {"Authorization": f"Bearer {TOKEN}"}


@pytest.fixture()
def app_client(tmp_path, monkeypatch):
    monkeypatch.setenv("NERDBOT_TOKEN", TOKEN)
    monkeypatch.setenv("NERDBOT_DB", str(tmp_path / "named.db"))
    monkeypatch.setenv("NERDBOT_DATA", str(tmp_path / "data"))
    return TestClient(create_app())


def _project(client: TestClient) -> str:
    r = client.post("/projects", json={"repository": "c"}, headers=AUTH)
    assert r.status_code == 200, r.text
    return r.json()["id"]


def _thread(client: TestClient, pid: str, **kw) -> str:
    r = client.post(f"/projects/{pid}/threads", json=kw, headers=AUTH)
    assert r.status_code == 200, r.text
    return r.json()["id"]


def _mock_provider(client: TestClient, pid: str) -> str:
    r = client.post(f"/projects/{pid}/providers", json={"kind": "mock", "name": "m"},
                    headers=AUTH)
    assert r.status_code == 200, r.text
    return r.json()["id"]


def _teammate(client: TestClient, pid: str, **body) -> dict:
    r = client.post(f"/projects/{pid}/teammates", json=body, headers=AUTH)
    assert r.status_code == 200, r.text
    return r.json()


# -- migration ----------------------------------------------------------------


def test_migration_adds_speaker_columns(tmp_path) -> None:
    """An old database gains ``teammates.name`` and
    ``chat_messages.teammate_id`` without losing what is already there."""
    db = tmp_path / "old.db"
    conn = sqlite3.connect(str(db))
    conn.executescript(
        """
        CREATE TABLE projects (id TEXT PRIMARY KEY, owner TEXT, repository TEXT, config TEXT);
        CREATE TABLE teammates (
          id TEXT PRIMARY KEY, project_id TEXT, slug TEXT, persona TEXT,
          instructions TEXT, capabilities TEXT, memory_scope TEXT, permissions TEXT,
          status TEXT, tool_policy TEXT, provider_id TEXT, created_at TEXT, face TEXT
        );
        CREATE TABLE chat_messages (
          id TEXT PRIMARY KEY, thread_id TEXT, role TEXT, content TEXT, created_at TEXT
        );
        """
    )
    conn.execute(
        "INSERT INTO teammates (id, project_id, slug, persona, instructions,"
        " capabilities, memory_scope, permissions, status, tool_policy, created_at, face)"
        " VALUES ('tm_1', 'prj_1', 'ceo', 'p', '', '[]', 'project', '[]', 'active',"
        " '{}', '', '{}')"
    )
    # A row from before names existed: the label lives in persona and there
    # is no handle yet.
    conn.execute(
        "INSERT INTO teammates (id, project_id, slug, persona, instructions,"
        " capabilities, memory_scope, permissions, status, tool_policy, created_at, face)"
        " VALUES ('tm_2', 'prj_1', '', 'engineer', '', '[]', 'project', '[]', 'active',"
        " '{}', '', '{}')"
    )
    conn.commit()
    conn.close()

    conn2 = store.connect(str(db))
    mate_cols = {r["name"] for r in conn2.execute("PRAGMA table_info(teammates)").fetchall()}
    msg_cols = {r["name"] for r in conn2.execute("PRAGMA table_info(chat_messages)").fetchall()}
    assert "name" in mate_cols
    assert "teammate_id" in msg_cols
    mate = store.get_teammate(conn2, "tm_1")
    assert mate is not None
    assert mate.slug == "ceo"
    # Backfill: persona-as-label becomes a name plus a mention handle.
    legacy = store.get_teammate(conn2, "tm_2")
    assert legacy is not None
    assert legacy.name == "engineer"
    assert legacy.slug == "engineer"
    assert chat_mod.resolve_speaker(conn2, "prj_1", "@engineer hi").id == "tm_2"
    conn2.close()


# -- mention resolution -------------------------------------------------------


@pytest.fixture()
def conn():
    c = store.connect(":memory:")
    yield c
    c.close()


def _seed_mates(conn: sqlite3.Connection) -> tuple[str, dict[str, str]]:
    proj = store.create_project(conn, "local-owner", "p")
    ids: dict[str, str] = {}
    ids["ceo"] = store.create_teammate(
        conn, proj.id, slug="ceo", name="CEO", persona="You are the CEO."
    ).id
    ids["analyst"] = store.create_teammate(
        conn, proj.id, slug="", name="Analyst", persona="You analyse things."
    ).id
    ids["retired"] = store.create_teammate(
        conn, proj.id, slug="retired", name="Retired", persona="Gone."
    ).id
    store.set_teammate_status(conn, ids["retired"], TeammateStatus.DISABLED)
    return proj.id, ids


def test_resolve_speaker_matches_slug_then_name_then_id(conn) -> None:
    pid, ids = _seed_mates(conn)
    # slug, case-insensitive, with trailing punctuation outside the handle
    assert chat_mod.resolve_speaker(conn, pid, "hello @ceo, plan this").id == ids["ceo"]
    # display name works too when there is no slug
    assert chat_mod.resolve_speaker(conn, pid, "@ANALYST numbers").id == ids["analyst"]
    # the picker's last-resort handle: the id
    assert chat_mod.resolve_speaker(conn, pid, f"hey @{ids['ceo']}").id == ids["ceo"]
    # unknown handle, no mention at all: fall back to the default bot
    assert chat_mod.resolve_speaker(conn, pid, "@nobody home") is None
    assert chat_mod.resolve_speaker(conn, pid, "no mention here") is None
    assert chat_mod.resolve_speaker(conn, pid, "") is None
    # a disabled teammate cannot be addressed
    assert chat_mod.resolve_speaker(conn, pid, "@retired wake up") is None


def test_slug_collision_is_resolved_by_suffix(conn) -> None:
    """Two teammates must not share a handle: ``@ceo`` would be ambiguous."""
    proj = store.create_project(conn, "local-owner", "p")
    first = store.create_teammate(conn, proj.id, slug="ceo", name="CEO")
    second = store.create_teammate(conn, proj.id, slug="ceo", name="CEO two")
    assert first.slug == "ceo"
    assert second.slug == "ceo-2"
    assert chat_mod.resolve_speaker(conn, proj.id, "@ceo hi").id == first.id
    assert chat_mod.resolve_speaker(conn, proj.id, "@ceo-2 hi").id == second.id


def test_fleet_slugifies_a_display_name(conn) -> None:
    assert fleet.slugify("Personal Assistant") == "personal-assistant"
    assert fleet.slugify("  Data & Analytics!! ") == "data-analytics"
    assert fleet.slugify("!!!") == ""
    proj = store.create_project(conn, "local-owner", "p")
    mate = fleet.create_teammate_service(conn, proj.id, persona="p", name="Personal Assistant")
    assert mate.name == "Personal Assistant"
    assert mate.slug == "personal-assistant"
    assert chat_mod.resolve_speaker(conn, proj.id, "@personal-assistant hi").id == mate.id


# -- speaker prompt -----------------------------------------------------------


def test_build_messages_speaks_as_the_mentioned_teammate(conn) -> None:
    pid, ids = _seed_mates(conn)
    thread = store.create_thread(conn, pid, title="t")
    analyst = store.get_teammate(conn, ids["analyst"])
    assert analyst is not None

    messages, _ = chat_mod.build_messages(conn, pid, thread, speaker=analyst)
    first = messages[0]
    assert first["role"] == "system"
    assert "You are Analyst" in first["content"]
    assert "You analyse things." in first["content"]
    # A persona never carries authority: permissions stay in gates.py.
    assert "permission" not in first["content"].lower()

    # No mention -> the default routing (CEO persona when seeded).
    messages, _ = chat_mod.build_messages(conn, pid, thread)
    assert "You are the CEO." in messages[0]["content"]


def test_speaker_prompt_without_persona_still_names_the_teammate(conn) -> None:
    pid, ids = _seed_mates(conn)
    thread = store.create_thread(conn, pid, title="t")
    bare = store.create_teammate(conn, pid, slug="quiet", name="Quiet One")
    messages, _ = chat_mod.build_messages(conn, pid, thread, speaker=bare)
    assert "You are Quiet One" in messages[0]["content"]


# -- API attribution ----------------------------------------------------------


def test_reply_is_attributed_to_the_mentioned_teammate(app_client: TestClient) -> None:
    pid = _project(app_client)
    _mock_provider(app_client, pid)
    mate = _teammate(app_client, pid, persona="You research.", name="Research", slug="research")
    tid = _thread(app_client, pid, title="t")

    r = app_client.post(
        f"/threads/{tid}/chat",
        json={"content": "@research what happened?"},
        headers=AUTH,
    )
    assert r.status_code == 200, r.text
    assert r.json()["message"]["teammate_id"] == mate["id"]

    # No mention -> the default bot, and the reply is not pinned to a teammate.
    r = app_client.post(f"/threads/{tid}/chat", json={"content": "hello"}, headers=AUTH)
    assert r.status_code == 200, r.text
    assert r.json()["message"]["teammate_id"] == ""

    view = app_client.get(f"/threads/{tid}", headers=AUTH).json()
    attributed = [m["teammate_id"] for m in view["messages"] if m["role"] == "assistant"]
    assert attributed == [mate["id"], ""]


def test_stream_announces_the_speaker_before_the_text(app_client: TestClient) -> None:
    pid = _project(app_client)
    _mock_provider(app_client, pid)
    mate = _teammate(app_client, pid, persona="You research.", name="Research", slug="research")
    tid = _thread(app_client, pid, title="t")

    with app_client.stream(
        "POST",
        f"/threads/{tid}/chat/stream",
        json={"content": "@research look into this"},
        headers=AUTH,
    ) as response:
        assert response.status_code == 200, response.read()
        events = [
            json.loads(line[5:])
            for line in response.iter_lines()
            if line.startswith("data:") and line[5:].strip().startswith("{")
        ]

    assert events, "the stream produced no events"
    assert events[0]["kind"] == "speaker"
    assert events[0]["teammate_id"] == mate["id"]
    assert events[0]["name"] == "Research"
    assert any(e.get("kind") == "text" for e in events)

    view = app_client.get(f"/threads/{tid}", headers=AUTH).json()
    saved = [m for m in view["messages"] if m["role"] == "assistant"]
    assert saved and saved[-1]["teammate_id"] == mate["id"]


# -- seed ---------------------------------------------------------------------


def test_seed_carries_name_and_slug(conn) -> None:
    proj = store.create_project(conn, "local-owner", "p")
    created = seed_mod.seed_teammates(conn, proj.id)
    assert created, "the seed created no teammates"
    for mate in created:
        assert mate.slug, f"{mate.persona!r} has no mention handle"
        assert mate.name, f"{mate.slug} has no display name"
    ceo = next(m for m in created if m.slug == "ceo")
    assert ceo.name == "CEO"
    assert chat_mod.resolve_speaker(conn, proj.id, "@ceo hi").id == ceo.id


def test_seed_names_a_legacy_teammate_it_owns(conn) -> None:
    """A row created before names existed keeps its slug; the seed that owns
    that slug supplies the display name it defines."""
    proj = store.create_project(conn, "local-owner", "p")
    legacy = store.create_teammate(conn, proj.id, slug="ceo", persona="ceo")
    assert legacy.name == ""
    seed_mod.seed_teammates(conn, proj.id)
    refreshed = store.get_teammate(conn, legacy.id)
    assert refreshed is not None
    assert refreshed.name == "CEO"
    assert refreshed.slug == "ceo"
    # Idempotent: a second run changes nothing.
    seed_mod.seed_teammates(conn, proj.id)
    assert store.get_teammate(conn, legacy.id).name == "CEO"


# -- backup -------------------------------------------------------------------


def test_backup_roundtrip_keeps_name_and_attribution(app_client: TestClient) -> None:
    pid = _project(app_client)
    _mock_provider(app_client, pid)
    mate = _teammate(app_client, pid, persona="You research.", name="Research", slug="research")
    tid = _thread(app_client, pid, title="t")
    app_client.post(
        f"/threads/{tid}/chat", json={"content": "@research hello"}, headers=AUTH
    )

    exported = app_client.get(f"/projects/{pid}/backup", headers=AUTH)
    assert exported.status_code == 200, exported.text
    manifest = exported.json()
    backup.validate_manifest(manifest)
    mate_rows = {row["id"]: row for row in manifest["tables"]["teammates"]}
    assert mate_rows[mate["id"]]["name"] == "Research"
    assert mate_rows[mate["id"]]["slug"] == "research"
    reply = next(
        row for row in manifest["tables"]["chat_messages"] if row["role"] == "assistant"
    )
    assert reply["teammate_id"] == mate["id"]

    # Wipe the rows, then restore: name and attribution must survive.
    conn = store.connect(os.environ["NERDBOT_DB"])
    conn.execute("DELETE FROM chat_messages WHERE thread_id = ?", (tid,))
    conn.execute("DELETE FROM teammates WHERE id = ?", (mate["id"],))
    conn.commit()
    conn.close()

    restored = app_client.post(
        f"/projects/{pid}/backup/import", json={"manifest": manifest}, headers=AUTH
    )
    assert restored.status_code == 200, restored.text
    assert restored.json()["rejected"] == [], restored.json()["rejected"]

    mates = app_client.get(f"/projects/{pid}/teammates", headers=AUTH).json()["teammates"]
    restored_mate = next(m for m in mates if m["id"] == mate["id"])
    assert restored_mate["name"] == "Research"
    assert restored_mate["slug"] == "research"
    view = app_client.get(f"/threads/{tid}", headers=AUTH).json()
    reply = next(m for m in view["messages"] if m["role"] == "assistant")
    assert reply["teammate_id"] == mate["id"]
