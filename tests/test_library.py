"""Library: documents, versions, ACL, taint/provenance, upload, backup.

Feature 3 of the harvest port: the owner's notes/docs live in one Library
page. The rules under test are the ones that must never regress — access
fails closed, a bot write taints and a bot cannot un-taint, ACL changes are
owner-only, and backup round-trips all three tables.
"""

from __future__ import annotations

import os
import sqlite3

import pytest
from fastapi.testclient import TestClient

from nerdbot import backup, library as library_mod, store
from nerdbot.api import create_app

TOKEN = "library-token"
AUTH = {"Authorization": f"Bearer {TOKEN}"}


@pytest.fixture()
def app_client(tmp_path, monkeypatch):
    monkeypatch.setenv("NERDBOT_TOKEN", TOKEN)
    monkeypatch.setenv("NERDBOT_DB", str(tmp_path / "library.db"))
    monkeypatch.setenv("NERDBOT_DATA", str(tmp_path / "data"))
    return TestClient(create_app())


def _project(client: TestClient) -> str:
    r = client.post("/projects", json={"repository": "c"}, headers=AUTH)
    assert r.status_code == 200, r.text
    return r.json()["id"]


def _doc(client: TestClient, pid: str, **body) -> dict:
    r = client.post(f"/projects/{pid}/library", json=body, headers=AUTH)
    assert r.status_code == 200, r.text
    return r.json()


def _teammate(client: TestClient, pid: str, **body) -> dict:
    r = client.post(f"/projects/{pid}/teammates", json=body, headers=AUTH)
    assert r.status_code == 200, r.text
    return r.json()


def _grant(client: TestClient, doc_id: str, mate_id: str, access: str) -> None:
    r = client.put(
        f"/library/{doc_id}/access",
        json={"teammate_id": mate_id, "access": access},
        headers=AUTH,
    )
    assert r.status_code == 200, r.text


def _acting(mate_id: str) -> dict[str, str]:
    return {**AUTH, "X-Acting-Teammate": mate_id}


# -- migration ----------------------------------------------------------------


def test_migration_adds_library_tables(tmp_path) -> None:
    """A database from before the Library gains all three tables, and rows
    already in it are untouched."""
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
        INSERT INTO projects (id, owner, repository, config)
          VALUES ('prj_1', 'o', 'repo', '{}');
        """
    )
    conn.commit()
    conn.close()

    conn2 = store.connect(str(db))
    tables = {
        r[0]
        for r in conn2.execute("SELECT name FROM sqlite_master WHERE type='table'").fetchall()
    }
    assert {"library_docs", "library_doc_versions", "library_doc_access"} <= tables
    # Existing data survived the migration.
    assert store.get_project(conn2, "prj_1") is not None
    # And the new tables are usable immediately.
    doc = store.create_library_doc(conn2, "prj_1", title="first", content="hello")
    assert doc.version == 1
    conn2.close()


# -- CRUD + versions ----------------------------------------------------------


def test_crud_and_version_history(app_client: TestClient) -> None:
    pid = _project(app_client)
    doc = _doc(app_client, pid, title="Plan", content="# v1")
    assert doc["kind"] == "note"
    assert doc["version"] == 1
    assert doc["tainted"] is False
    assert doc["teammate_id"] == ""

    listed = app_client.get(f"/projects/{pid}/library", headers=AUTH).json()["docs"]
    assert [d["id"] for d in listed] == [doc["id"]]

    r = app_client.patch(f"/library/{doc['id']}", json={"content": "# v2"}, headers=AUTH)
    assert r.status_code == 200, r.text
    assert r.json()["version"] == 2
    assert r.json()["content"] == "# v2"

    # Only the sent fields change: title is untouched by a content-only save.
    assert r.json()["title"] == "Plan"

    versions = app_client.get(f"/library/{doc['id']}/versions", headers=AUTH).json()["versions"]
    assert [v["version"] for v in versions] == [1, 2]
    assert versions[0]["content"] == "# v1"
    assert versions[1]["content"] == "# v2"

    # Restore is a new save, never a rewind: history keeps both states.
    r = app_client.post(f"/library/{doc['id']}/versions/1/restore", headers=AUTH)
    assert r.status_code == 200, r.text
    assert r.json()["content"] == "# v1"
    assert r.json()["version"] == 3
    versions = app_client.get(f"/library/{doc['id']}/versions", headers=AUTH).json()["versions"]
    assert [v["version"] for v in versions] == [1, 2, 3]

    # Unknown version and unknown document fail cleanly.
    r = app_client.post(f"/library/{doc['id']}/versions/99/restore", headers=AUTH)
    assert r.status_code == 404, r.text
    r = app_client.get("/library/lib_nope", headers=AUTH)
    assert r.status_code == 404, r.text

    # Delete removes the doc with its history and ACL.
    _grant(app_client, doc["id"], _teammate(app_client, pid, name="Reader")["id"], "read")
    r = app_client.delete(f"/library/{doc['id']}", headers=AUTH)
    assert r.status_code == 200, r.text
    assert app_client.get(f"/library/{doc['id']}", headers=AUTH).status_code == 404
    conn = store.connect(os.environ["NERDBOT_DB"])
    assert store.list_library_doc_versions(conn, doc["id"]) == []
    assert store.list_library_doc_access(conn, doc["id"]) == []
    conn.close()


def test_store_rejects_bad_documents() -> None:
    conn = store.connect(":memory:")
    proj = store.create_project(conn, "o", "r")
    with pytest.raises(ValueError, match="unknown library kind"):
        store.create_library_doc(conn, proj.id, kind="binary")
    with pytest.raises(ValueError, match="title exceeds"):
        store.create_library_doc(conn, proj.id, title="x" * 201)
    with pytest.raises(ValueError, match="1MiB"):
        store.create_library_doc(conn, proj.id, content="x" * (1_048_576 + 1))
    with pytest.raises(KeyError):
        store.create_library_doc(conn, "prj_missing", title="x")
    with pytest.raises(KeyError, match="unknown teammate"):
        store.create_library_doc(conn, proj.id, teammate_id="tm_nope")
    conn.close()


# -- ACL: fail closed ---------------------------------------------------------


def test_access_fails_closed_for_teammates(app_client: TestClient) -> None:
    pid = _project(app_client)
    doc = _doc(app_client, pid, title="Secret plan", content="hidden")
    other = _doc(app_client, pid, title="Other", content="also hidden")
    mate = _teammate(
        app_client, pid, name="Helper",
        permissions=["knowledge.read", "knowledge.write"],
    )
    h = _acting(mate["id"])

    # No ACL row: not even the list entry is visible, whatever permissions it holds.
    assert app_client.get(f"/library/{doc['id']}", headers=h).status_code == 403
    visible = app_client.get(f"/projects/{pid}/library", headers=h).json()["docs"]
    assert visible == []

    # Read ACL: reads work, writes do not.
    _grant(app_client, doc["id"], mate["id"], "read")
    assert app_client.get(f"/library/{doc['id']}", headers=h).status_code == 200
    r = app_client.patch(f"/library/{doc['id']}", json={"content": "x"}, headers=h)
    assert r.status_code == 403
    assert "read-only" in r.json()["detail"]
    # The other document is still invisible: access is per document.
    assert app_client.get(f"/library/{other['id']}", headers=h).status_code == 403
    visible = app_client.get(f"/projects/{pid}/library", headers=h).json()["docs"]
    assert [d["id"] for d in visible] == [doc["id"]]

    # Write ACL: writes work.
    _grant(app_client, doc["id"], mate["id"], "write")
    r = app_client.patch(f"/library/{doc['id']}", json={"content": "bot"}, headers=h)
    assert r.status_code == 200, r.text

    # Revoking removes access again.
    r = app_client.delete(f"/library/{doc['id']}/access/{mate['id']}", headers=AUTH)
    assert r.status_code == 200, r.text
    assert app_client.get(f"/library/{doc['id']}", headers=h).status_code == 403


def test_gate_denies_without_permission(app_client: TestClient) -> None:
    """ACL is necessary but not sufficient: the knowledge gate must also pass."""
    pid = _project(app_client)
    doc = _doc(app_client, pid, title="Guarded", content="v")
    no_perms = _teammate(app_client, pid, name="NoPerms")
    _grant(app_client, doc["id"], no_perms["id"], "write")

    r = app_client.get(f"/library/{doc['id']}", headers=_acting(no_perms["id"]))
    assert r.status_code == 403
    assert "knowledge.read" in r.json()["detail"]

    r = app_client.patch(
        f"/library/{doc['id']}", json={"content": "x"}, headers=_acting(no_perms["id"])
    )
    assert r.status_code == 403
    assert "knowledge.write" in r.json()["detail"]

    # Listing also needs the read gate, even with an ACL row.
    r = app_client.get(f"/projects/{pid}/library", headers=_acting(no_perms["id"]))
    assert r.status_code == 403
    assert "knowledge.read" in r.json()["detail"]


def test_acl_is_owner_only(app_client: TestClient) -> None:
    """A teammate can never read or widen its own access list."""
    pid = _project(app_client)
    doc = _doc(app_client, pid, title="Mine", content="v")
    mate = _teammate(
        app_client, pid, name="Helper",
        permissions=["knowledge.read", "knowledge.write"],
    )
    h = _acting(mate["id"])
    _grant(app_client, doc["id"], mate["id"], "read")

    r = app_client.get(f"/library/{doc['id']}/access", headers=h)
    assert r.status_code == 403
    assert "only the owner" in r.json()["detail"]

    r = app_client.put(
        f"/library/{doc['id']}/access",
        json={"teammate_id": mate["id"], "access": "write"},
        headers=h,
    )
    assert r.status_code == 403

    r = app_client.delete(f"/library/{doc['id']}/access/{mate['id']}", headers=h)
    assert r.status_code == 403

    # Delete is owner-only too: history is not a bot's to destroy.
    r = app_client.delete(f"/library/{doc['id']}", headers=h)
    assert r.status_code == 403

    # Owner can still do all of it.
    assert app_client.get(f"/library/{doc['id']}/access", headers=AUTH).status_code == 200
    assert app_client.delete(f"/library/{doc['id']}", headers=AUTH).status_code == 200


# -- taint / provenance -------------------------------------------------------


def test_bot_write_taints_and_cannot_un_taint(app_client: TestClient) -> None:
    pid = _project(app_client)
    doc = _doc(app_client, pid, title="Notes", content="clean")
    bot = _teammate(
        app_client, pid, name="Writer",
        permissions=["knowledge.read", "knowledge.write"],
    )
    _grant(app_client, doc["id"], bot["id"], "write")
    h = _acting(bot["id"])

    # A bot save taints the doc and records who wrote it.
    r = app_client.patch(f"/library/{doc['id']}", json={"content": "bot text"}, headers=h)
    assert r.status_code == 200, r.text
    assert r.json()["tainted"] is True
    assert r.json()["teammate_id"] == bot["id"]

    # Resaving — even back to the original text — never clears the taint.
    r = app_client.patch(f"/library/{doc['id']}", json={"content": "clean"}, headers=h)
    assert r.json()["tainted"] is True
    assert r.json()["teammate_id"] == bot["id"]

    # Only an owner edit wipes it: the owner vouches for the content.
    r = app_client.patch(f"/library/{doc['id']}", json={"content": "reviewed"}, headers=AUTH)
    assert r.status_code == 200, r.text
    assert r.json()["tainted"] is False
    assert r.json()["teammate_id"] == ""

    # A restore keeps the provenance of the version it pulls back.
    app_client.patch(f"/library/{doc['id']}", json={"content": "bot again"}, headers=h)
    versions = app_client.get(f"/library/{doc['id']}/versions", headers=AUTH).json()["versions"]
    bot_version = next(v["version"] for v in versions if v["tainted"])
    r = app_client.post(
        f"/library/{doc['id']}/versions/{bot_version}/restore", headers=AUTH
    )
    assert r.json()["tainted"] is True
    assert r.json()["teammate_id"] == bot["id"]


def test_teammate_create_is_tainted_and_can_revisit(app_client: TestClient) -> None:
    """A doc a bot creates is tainted, and the bot keeps write access to it."""
    pid = _project(app_client)
    bot = _teammate(
        app_client, pid, name="Author",
        permissions=["knowledge.read", "knowledge.write"],
    )
    r = app_client.post(
        f"/projects/{pid}/library",
        json={"title": "Bot draft", "content": "written by bot"},
        headers=_acting(bot["id"]),
    )
    assert r.status_code == 200, r.text
    doc = r.json()
    assert doc["tainted"] is True
    assert doc["teammate_id"] == bot["id"]
    # The creator got an ACL row, so it can read its own document back.
    assert app_client.get(f"/library/{doc['id']}", headers=_acting(bot["id"])).status_code == 200


# -- upload -------------------------------------------------------------------


def test_upload_is_text_only_and_capped(app_client: TestClient) -> None:
    pid = _project(app_client)
    r = app_client.post(
        f"/projects/{pid}/library/upload?filename=meeting-notes.md",
        content=b"# Notes\n\n- ship it",
        headers={**AUTH, "Content-Type": "text/plain"},
    )
    assert r.status_code == 200, r.text
    doc = r.json()
    assert doc["kind"] == "upload"
    assert doc["source"] == "meeting-notes.md"
    assert doc["title"] == "meeting-notes.md"
    assert "ship it" in doc["content"]

    # A binary file is refused: the Library renders text, nothing else.
    r = app_client.post(
        f"/projects/{pid}/library/upload?filename=logo.png",
        content=b"\x89PNG\r\n\x1a\n\x00\x01",
        headers={**AUTH, "Content-Type": "text/plain"},
    )
    assert r.status_code == 400, r.text
    assert "UTF-8" in r.json()["detail"]

    # Oversize is refused while streaming, before the body is buffered whole.
    r = app_client.post(
        f"/projects/{pid}/library/upload?filename=huge.txt",
        content=b"x" * (library_mod.MAX_UPLOAD_BYTES + 1),
        headers={**AUTH, "Content-Type": "text/plain"},
    )
    assert r.status_code == 413, r.text

    # An upload by a bot carries the taint like any other bot write.
    bot = _teammate(
        app_client, pid, name="Uploader",
        permissions=["knowledge.read", "knowledge.write"],
    )
    r = app_client.post(
        f"/projects/{pid}/library/upload?filename=from-bot.md",
        content=b"bot upload",
        headers={**_acting(bot["id"]), "Content-Type": "text/plain"},
    )
    assert r.status_code == 200, r.text
    assert r.json()["tainted"] is True
    assert r.json()["teammate_id"] == bot["id"]


# -- backup -------------------------------------------------------------------


def test_backup_roundtrip_carries_docs_versions_and_access(
    app_client: TestClient,
) -> None:
    pid = _project(app_client)
    doc = _doc(app_client, pid, title="Backed up", content="v1 body")
    app_client.patch(f"/library/{doc['id']}", json={"content": "v2 body"}, headers=AUTH)
    bot = _teammate(
        app_client, pid, name="Writer",
        permissions=["knowledge.read", "knowledge.write"],
    )
    _grant(app_client, doc["id"], bot["id"], "write")
    app_client.patch(
        f"/library/{doc['id']}", json={"content": "bot body"},
        headers=_acting(bot["id"]),
    )

    exported = app_client.get(f"/projects/{pid}/backup", headers=AUTH)
    assert exported.status_code == 200, exported.text
    manifest = exported.json()
    backup.validate_manifest(manifest)
    assert len(manifest["tables"]["library_docs"]) == 1
    assert len(manifest["tables"]["library_doc_versions"]) == 3
    assert len(manifest["tables"]["library_doc_access"]) == 1
    assert manifest["tables"]["library_docs"][0]["tainted"] in (1, True)

    # Wipe the library, then restore: doc, history and ACL all come back.
    conn = store.connect(os.environ["NERDBOT_DB"])
    conn.execute("DELETE FROM library_doc_access")
    conn.execute("DELETE FROM library_doc_versions")
    conn.execute("DELETE FROM library_docs")
    conn.commit()
    conn.close()
    assert app_client.get(f"/projects/{pid}/library", headers=AUTH).json()["docs"] == []

    restored = app_client.post(
        f"/projects/{pid}/backup/import", json={"manifest": manifest}, headers=AUTH
    )
    assert restored.status_code == 200, restored.text
    assert restored.json()["rejected"] == [], restored.json()["rejected"]

    docs = app_client.get(f"/projects/{pid}/library", headers=AUTH).json()["docs"]
    assert len(docs) == 1
    restored_doc = docs[0]
    assert restored_doc["title"] == "Backed up"
    assert restored_doc["tainted"] is True
    assert restored_doc["teammate_id"] == bot["id"]
    versions = app_client.get(
        f"/library/{restored_doc['id']}/versions", headers=AUTH
    ).json()["versions"]
    assert [v["content"] for v in versions] == ["v1 body", "v2 body", "bot body"]
    access = app_client.get(f"/library/{restored_doc['id']}/access", headers=AUTH).json()["access"]
    assert [(a["teammate_id"], a["access"]) for a in access] == [(bot["id"], "write")]
    # The restored ACL actually works for the teammate.
    r = app_client.get(f"/library/{restored_doc['id']}", headers=_acting(bot["id"]))
    assert r.status_code == 200, r.text


def test_manifest_without_library_tables_still_imports(app_client: TestClient) -> None:
    """Manifests exported before the Library existed stay valid: the three
    tables are optional and default to empty."""
    pid = _project(app_client)
    doc = _doc(app_client, pid, title="Pre-library", content="x")
    exported = app_client.get(f"/projects/{pid}/backup", headers=AUTH).json()
    legacy = {k: v for k, v in exported.items()}
    legacy["tables"] = {
        k: v for k, v in exported["tables"].items() if not k.startswith("library_")
    }
    assert backup.validate_manifest(legacy) == []

    conn = store.connect(os.environ["NERDBOT_DB"])
    conn.execute("DELETE FROM library_doc_access")
    conn.execute("DELETE FROM library_doc_versions")
    conn.execute("DELETE FROM library_docs")
    conn.commit()
    conn.close()

    r = app_client.post(f"/projects/{pid}/backup/import", json={"manifest": legacy}, headers=AUTH)
    assert r.status_code == 200, r.text
    assert r.json()["rejected"] == []
    # Nothing to restore, and nothing exploded.
    assert app_client.get(f"/projects/{pid}/library", headers=AUTH).json()["docs"] == []
    assert doc["id"]
