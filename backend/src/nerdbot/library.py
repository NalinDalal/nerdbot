"""Library policy: who may read/write a document, and what a save means.

The store persists rows; this module decides whether a principal may touch
them and what provenance a save records. Three rules define the feature:

1. **Fail closed.** The owner (no acting teammate) sees everything. A
   teammate needs an explicit ACL row *and* the matching ``knowledge.*``
   gate — no row, no access, even with the permission.
2. **A bot write taints.** Any save by a teammate marks the document
   tainted and records its id, and a teammate can never clear a taint by
   resaving. Only an owner edit wipes it: the owner vouches for the text.
3. **ACL is owner-only.** A teammate, however privileged, cannot widen its
   own access; ``permission.change`` is not consulted because no grant from
   a bot counts here.
"""

from __future__ import annotations

import sqlite3

from . import gates, store
from .models import LibraryDoc, LibraryDocAccess, LibraryDocVersion, Teammate

# Uploads are text files only, capped at 1 MiB (store enforces the same cap
# on content; this one also catches the bytes before decoding).
MAX_UPLOAD_BYTES = 1_048_576


class AccessDenied(Exception):
    """The principal may not touch this document. Fail closed, always."""


def _acl_level(conn: sqlite3.Connection, doc_id: str, mate: Teammate) -> str:
    """``"read"``/``"write"`` for an ACL row, ``""`` when there is none."""
    row = store.get_library_doc_access(conn, doc_id, mate.id)
    return row.access if row is not None else ""


def require_read(
    conn: sqlite3.Connection, doc: LibraryDoc, acting: Teammate | None
) -> None:
    """Raise AccessDenied unless ``acting`` may read ``doc``.

    The owner always may. A teammate needs both an ACL row (read or write)
    and the ``knowledge.read`` gate, checked in that order: the cheap
    fail-closed check runs before any gate work.
    """
    if acting is None:
        return
    if _acl_level(conn, doc.id, acting) == "":
        raise AccessDenied("you do not have access to this document")
    gates.require(conn, acting, "knowledge.read", payload={"doc_id": doc.id})


def require_write(
    conn: sqlite3.Connection, doc: LibraryDoc, acting: Teammate | None
) -> None:
    """Raise AccessDenied unless ``acting`` may edit ``doc``."""
    if acting is None:
        return
    if _acl_level(conn, doc.id, acting) != "write":
        raise AccessDenied("you have read-only access to this document")
    gates.require(conn, acting, "knowledge.write", payload={"doc_id": doc.id})


def list_visible(
    conn: sqlite3.Connection, project_id: str, acting: Teammate | None
) -> list[LibraryDoc]:
    """Documents the principal may see: all for the owner, ACL'd for a bot."""
    docs = store.list_library_docs(conn, project_id)
    if acting is None:
        return docs
    return [d for d in docs if _acl_level(conn, d.id, acting) != ""]


def save_rules(
    acting: Teammate | None, version: LibraryDocVersion | None = None
) -> tuple[str, bool]:
    """Return ``(teammate_id, tainted)`` for a save by ``acting``.

    Owner save: clears the taint and empties the writer — the owner now
    vouches for the content. Teammate save: always taints and always records
    the bot, so a bot can never launder text by resaving it. A version
    restore keeps the restored version's provenance instead, unless a
    teammate performs it (then rule two still applies).
    """
    if acting is None:
        if version is None:
            return "", False
        # Restoring is the owner picking that exact text back, but the
        # provenance of what was picked stays honest: a bot-written version
        # restores as bot-written.
        return (version.teammate_id, version.tainted)
    return acting.id, True


def create_doc(
    conn: sqlite3.Connection,
    project_id: str,
    acting: Teammate | None,
    *,
    kind: str = "note",
    title: str = "",
    content: str = "",
    source: str = "",
) -> LibraryDoc:
    """Create a document, applying taint rules and granting the creator."""
    if acting is not None:
        gates.require(
            conn, acting, "knowledge.write",
            payload={"project_id": project_id, "title": title},
        )
    teammate_id, tainted = save_rules(acting)
    doc = store.create_library_doc(
        conn, project_id, kind=kind, title=title, content=content,
        source=source, teammate_id=teammate_id, tainted=tainted,
    )
    if acting is not None:
        # The creator can come back to what it wrote; without this row its
        # own document would be invisible to it on the next request.
        store.set_library_doc_access(conn, doc.id, acting.id, "write")
    return doc


def save_doc(
    conn: sqlite3.Connection,
    doc: LibraryDoc,
    acting: Teammate | None,
    *,
    title: str | None = None,
    content: str | None = None,
) -> LibraryDoc:
    """Edit a document under write access and the taint rules."""
    require_write(conn, doc, acting)
    teammate_id, tainted = save_rules(acting)
    return store.update_library_doc(
        conn, doc.id, title=title, content=content,
        teammate_id=teammate_id, tainted=tainted,
    )


def restore_version(
    conn: sqlite3.Connection, doc: LibraryDoc, version: int, acting: Teammate | None
) -> LibraryDoc:
    """Put an old version's text back as a new save (history is never lost)."""
    require_write(conn, doc, acting)
    saved = store.get_library_doc_version(conn, doc.id, version)
    if saved is None:
        raise KeyError(f"unknown version {version}")
    teammate_id, tainted = save_rules(acting, version=saved)
    return store.update_library_doc(
        conn, doc.id, title=saved.title, content=saved.content,
        source=saved.source, teammate_id=teammate_id, tainted=tainted,
    )


def delete_doc(
    conn: sqlite3.Connection, doc_id: str, acting: Teammate | None
) -> None:
    """Owner-only: deleting takes the whole history with it, so a bot may
    never do it, whatever permissions it holds."""
    if acting is not None:
        raise AccessDenied("only the owner can delete a document")
    if not store.delete_library_doc(conn, doc_id):
        raise KeyError(f"unknown library doc {doc_id}")


def clear_access(
    conn: sqlite3.Connection,
    doc_id: str,
    acting: Teammate | None,
    teammate_id: str,
) -> None:
    """Owner-only: revoke one teammate's row (absence = no access)."""
    if acting is not None:
        raise AccessDenied("only the owner can change document access")
    store.clear_library_doc_access(conn, doc_id, teammate_id)


def set_access(
    conn: sqlite3.Connection,
    doc_id: str,
    acting: Teammate | None,
    teammate_id: str,
    access: str,
) -> None:
    """Owner-only ACL change: a bot can never widen its own access."""
    if acting is not None:
        raise AccessDenied("only the owner can change document access")
    store.set_library_doc_access(conn, doc_id, teammate_id, access)


def list_access(
    conn: sqlite3.Connection, doc_id: str, acting: Teammate | None
) -> list[LibraryDocAccess]:
    """Owner-only: who can see this document is owner business."""
    if acting is not None:
        raise AccessDenied("only the owner can view document access")
    return store.list_library_doc_access(conn, doc_id)


def parse_upload(filename: str, raw: bytes) -> tuple[str, str]:
    """Decode an uploaded file to ``(source, content)``. Text files only.

    Rejects oversize files and anything that is not UTF-8 text, so a binary
    can never end up as a "document" the dashboard tries to render.
    """
    if len(raw) > MAX_UPLOAD_BYTES:
        raise ValueError("file exceeds the 1MiB upload limit")
    try:
        content = raw.decode("utf-8")
    except UnicodeDecodeError as exc:
        raise ValueError("only UTF-8 text files can be uploaded") from exc
    source = (filename or "upload").strip() or "upload"
    return source, content
