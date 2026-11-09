"""Migration + backup tests for chat threads/messages/reports."""

from __future__ import annotations

import sqlite3

from nerdbot import backup, store


def test_old_db_migrates(tmp_path):
    db = tmp_path / "old.db"
    conn = sqlite3.connect(str(db))
    conn.executescript(
        """
        CREATE TABLE projects (id TEXT PRIMARY KEY, owner TEXT, repository TEXT, config TEXT);
        CREATE TABLE chat_threads (id TEXT PRIMARY KEY, project_id TEXT, title TEXT, provider_id TEXT, summary TEXT, created_at TEXT);
        CREATE TABLE chat_messages (id TEXT PRIMARY KEY, thread_id TEXT, role TEXT, content TEXT, created_at TEXT);
        """
    )
    conn.commit()
    conn.close()
    conn2 = store.connect(db)
    cols_threads = {r["name"] for r in conn2.execute("PRAGMA table_info(chat_threads)").fetchall()}
    cols_msgs = {r["name"] for r in conn2.execute("PRAGMA table_info(chat_messages)").fetchall()}
    assert "tainted" in cols_threads
    assert "parts" in cols_msgs
    tables = {r[0] for r in conn2.execute("SELECT name FROM sqlite_master WHERE type='table'").fetchall()}
    assert "reports" in tables
    conn2.close()


def test_backup_roundtrip_keeps_tainted_and_ordering(tmp_path):
    conn = store.connect(tmp_path / "b.db")
    proj = store.create_project(conn, "local-owner", "p")
    thread = store.create_thread(conn, proj.id, title="t")
    store.set_thread_tainted(conn, thread.id, True)
    m1 = store.append_message(conn, thread.id, "user", "hello")
    m2 = store.append_message(conn, thread.id, "assistant", "hi", parts=[{"type": "report", "title": "r", "content": "x"}])
    manifest = backup.build_manifest(conn, proj.id)
    backup.validate_manifest(manifest)
    threads = manifest["tables"]["chat_threads"]
    assert any(t["id"] == thread.id and t["tainted"] == 1 for t in threads)
    msgs = manifest["tables"]["chat_messages"]
    ids = [m["id"] for m in msgs]
    assert ids == sorted(ids, key=lambda i: next(m["created_at"] for m in msgs if m["id"] == i))
    assert any(m["id"] == m2.id for m in msgs)
    conn.close()
