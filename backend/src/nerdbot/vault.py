"""Central encrypted secrets vault: scoped credentials with audited access.

Everything sensitive in NerdBot — provider API keys, mail passwords, Telegram
tokens, MCP server headers — is stored here once, encrypted at rest through
:mod:`nerdbot.secrets`, and handed out only through this module's two doors:

* :func:`reveal` — the **owner** asking for a value in the UI. It fails
  closed: it needs an explicit confirmation, the second factor when one is
  enrolled, and a real owner approval when the item says so. Every attempt,
  allowed or not, lands in ``vault_access_log``.
* :func:`resolve_for` — the **server** needing a value on behalf of a
  teammate or an integration (mail sync, Telegram, MCP). It never returns a
  value without a grant for that specific grantee, and it audits every use.
  A caller that cannot be granted to cannot get the value.

There is no third door: no code path returns plaintext without a decision
record, and no plaintext is ever returned alongside list/metadata responses —
those carry fingerprints only.
"""

from __future__ import annotations

import json
import sqlite3
from datetime import UTC, datetime
from typing import Any

from . import store
from .secrets import SecretDecryptError, decrypt_secret, encrypt_secret, mask_stored

GRANT_PERMISSIONS = frozenset({"use", "read"})
REVEAL_POLICIES = frozenset({"confirm", "approval"})
SCOPE_LEVELS = frozenset({"global", "project", "teammate"})


class VaultError(ValueError):
    """Base class for vault failures. Carries an HTTP-agnostic reason."""


class VaultNotFound(VaultError):
    """No live item with that id/name in that scope."""


class VaultDenied(VaultError):
    """The caller has no grant, or the second factor failed."""


class VaultConfirmRequired(VaultError):
    """A reveal was attempted without the explicit confirmation flag."""


class VaultApprovalPending(VaultError):
    """A reveal needs an owner approval; carries the approval id."""

    def __init__(self, message: str, approval_id: str) -> None:
        super().__init__(message)
        self.approval_id = approval_id


class VaultApprovalNotGranted(VaultError):
    """The approval exists but is pending, denied or expired."""


def _now_iso() -> str:
    return datetime.now(UTC).isoformat()


# --------------------------------------------------------------------------- #
# Item lifecycle
# --------------------------------------------------------------------------- #


def put_item(
    conn: sqlite3.Connection,
    *,
    name: str,
    value: str,
    kind: str = "generic",
    scope_level: str = "global",
    scope_id: str = "",
    metadata: dict[str, Any] | None = None,
    principal: str = "",
    reveal_policy: str = "confirm",
    item_id: str | None = None,
) -> dict[str, Any]:
    """Create or rotate an item. The value is encrypted before it is stored."""
    name = (name or "").strip()
    if not name:
        raise VaultError("vault item name is required")
    if scope_level not in SCOPE_LEVELS:
        raise VaultError(f"unknown scope {scope_level!r}")
    if reveal_policy not in REVEAL_POLICIES:
        raise VaultError(f"unknown reveal policy {reveal_policy!r}")
    if scope_level == "global":
        scope_id = ""
    elif not (scope_id or "").strip():
        raise VaultError(f"scope {scope_level!r} requires a scope id")

    ciphertext = encrypt_secret(value)
    now = _now_iso()
    meta = json.dumps(metadata or {}, sort_keys=True)

    if item_id is not None:
        row = conn.execute(
            "SELECT id, version FROM vault_items WHERE id = ?", (item_id,)
        ).fetchone()
        if row is None:
            raise VaultNotFound(item_id)
        conn.execute(
            "UPDATE vault_items SET name = ?, kind = ?, ciphertext = ?, metadata = ?,"
            " version = version + 1, updated_at = ?, updated_by = ?, reveal_policy = ?"
            " WHERE id = ?",
            (name, kind, ciphertext, meta, now, principal, reveal_policy, item_id),
        )
        conn.commit()
        return get_item(conn, item_id)  # type: ignore[return-value]

    existing = conn.execute(
        "SELECT id FROM vault_items WHERE name = ? AND scope_level = ? AND scope_id = ?"
        " AND revoked_at IS NULL",
        (name, scope_level, scope_id),
    ).fetchone()
    if existing is not None:
        conn.execute(
            "UPDATE vault_items SET kind = ?, ciphertext = ?, metadata = ?,"
            " version = version + 1, updated_at = ?, updated_by = ?, reveal_policy = ?"
            " WHERE id = ?",
            (kind, ciphertext, meta, now, principal, reveal_policy, existing["id"]),
        )
        conn.commit()
        return get_item(conn, existing["id"])  # type: ignore[return-value]

    new_id = store.new_id("vlt")
    conn.execute(
        "INSERT INTO vault_items"
        " (id, name, kind, scope_level, scope_id, ciphertext, metadata, version,"
        "  created_at, updated_at, updated_by, revoked_at, reveal_policy)"
        " VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, NULL, ?)",
        (new_id, name, kind, scope_level, scope_id, ciphertext, meta, now, now, principal, reveal_policy),
    )
    conn.commit()
    return get_item(conn, new_id)  # type: ignore[return-value]


def _row_to_meta(row: sqlite3.Row | dict[str, Any]) -> dict[str, Any]:
    data = dict(row)
    value = data.pop("ciphertext", "")
    data["fingerprint"] = mask_stored(str(value))
    try:
        data["metadata"] = json.loads(data.get("metadata") or "{}")
    except ValueError:
        data["metadata"] = {}
    return data


def get_item(conn: sqlite3.Connection, item_id: str) -> dict[str, Any] | None:
    row = conn.execute(
        "SELECT * FROM vault_items WHERE id = ? AND revoked_at IS NULL", (item_id,)
    ).fetchone()
    return _row_to_meta(row) if row is not None else None


def find_item(
    conn: sqlite3.Connection,
    name: str,
    scope_level: str = "global",
    scope_id: str = "",
) -> dict[str, Any] | None:
    if scope_level == "global":
        scope_id = ""
    row = conn.execute(
        "SELECT * FROM vault_items WHERE name = ? AND scope_level = ? AND scope_id = ?"
        " AND revoked_at IS NULL",
        (name, scope_level, scope_id),
    ).fetchone()
    return _row_to_meta(row) if row is not None else None


def list_items(
    conn: sqlite3.Connection,
    scope_level: str | None = None,
    scope_id: str | None = None,
) -> list[dict[str, Any]]:
    """Metadata and fingerprints only — never a value."""
    sql = "SELECT * FROM vault_items WHERE revoked_at IS NULL"
    args: list[Any] = []
    if scope_level is not None:
        sql += " AND scope_level = ?"
        args.append(scope_level)
        if scope_level != "global":
            sql += " AND scope_id = ?"
            args.append(scope_id or "")
    sql += " ORDER BY name"
    return [_row_to_meta(row) for row in conn.execute(sql, args).fetchall()]


def revoke_item(conn: sqlite3.Connection, item_id: str, principal: str = "") -> bool:
    row = conn.execute(
        "SELECT id FROM vault_items WHERE id = ? AND revoked_at IS NULL", (item_id,)
    ).fetchone()
    if row is None:
        return False
    conn.execute(
        "UPDATE vault_items SET revoked_at = ?, updated_at = ?, updated_by = ? WHERE id = ?",
        (_now_iso(), _now_iso(), principal, item_id),
    )
    conn.execute("DELETE FROM vault_grants WHERE item_id = ?", (item_id,))
    conn.commit()
    return True


# --------------------------------------------------------------------------- #
# Grants (who may use a value without asking the owner)
# --------------------------------------------------------------------------- #


def grant(
    conn: sqlite3.Connection,
    item_id: str,
    grantee_kind: str,
    grantee_id: str,
    permission: str = "use",
    principal: str = "",
) -> dict[str, Any]:
    if permission not in GRANT_PERMISSIONS:
        raise VaultError(f"unknown permission {permission!r}")
    if get_item(conn, item_id) is None:
        raise VaultNotFound(item_id)
    if not (grantee_id or "").strip():
        raise VaultError("grantee id is required")
    now = _now_iso()
    conn.execute(
        "INSERT INTO vault_grants (id, item_id, grantee_kind, grantee_id, permission, created_at)"
        " VALUES (?, ?, ?, ?, ?, ?)"
        " ON CONFLICT(item_id, grantee_kind, grantee_id)"
        " DO UPDATE SET permission = excluded.permission",
        (store.new_id("vgr"), item_id, grantee_kind, grantee_id, permission, now),
    )
    _log(conn, item_id, principal, "grant", "allowed", f"{grantee_kind}:{grantee_id}:{permission}")
    conn.commit()
    return {
        "item_id": item_id,
        "grantee_kind": grantee_kind,
        "grantee_id": grantee_id,
        "permission": permission,
    }


def revoke_grant(
    conn: sqlite3.Connection, item_id: str, grantee_kind: str, grantee_id: str
) -> bool:
    cur = conn.execute(
        "DELETE FROM vault_grants WHERE item_id = ? AND grantee_kind = ? AND grantee_id = ?",
        (item_id, grantee_kind, grantee_id),
    )
    conn.commit()
    return cur.rowcount > 0


def grants_for(conn: sqlite3.Connection, item_id: str) -> list[dict[str, Any]]:
    return [dict(row) for row in conn.execute(
        "SELECT * FROM vault_grants WHERE item_id = ? ORDER BY grantee_kind, grantee_id",
        (item_id,),
    ).fetchall()]


def _has_grant(
    conn: sqlite3.Connection,
    item: dict[str, Any],
    grantee_kind: str,
    grantee_id: str,
    permission: str,
) -> bool:
    row = conn.execute(
        "SELECT permission FROM vault_grants WHERE item_id = ? AND grantee_kind = ?"
        " AND grantee_id = ?",
        (item["id"], grantee_kind, grantee_id),
    ).fetchone()
    if row is not None:
        granted = str(row["permission"])
        if granted == "use" or granted == permission:
            return True
    # An item scoped to a teammate is usable by that teammate by construction:
    # the scope IS the grant, so scoping a credential does not also require a
    # second grant row to say the same thing.
    if item.get("scope_level") == "teammate" and item.get("scope_id") == grantee_id:
        return True
    return False


# --------------------------------------------------------------------------- #
# Audit
# --------------------------------------------------------------------------- #


def _log(
    conn: sqlite3.Connection,
    item_id: str,
    principal: str,
    action: str,
    decision: str,
    reason: str = "",
    totp_verified: bool = False,
) -> None:
    conn.execute(
        "INSERT INTO vault_access_log"
        " (id, item_id, principal, action, decision, reason, totp_verified, created_at)"
        " VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        (
            store.new_id("val"),
            item_id,
            principal,
            action,
            decision,
            reason[:500],
            1 if totp_verified else 0,
            _now_iso(),
        ),
    )


def access_log(
    conn: sqlite3.Connection, item_id: str | None = None, limit: int = 100
) -> list[dict[str, Any]]:
    sql = "SELECT * FROM vault_access_log"
    args: list[Any] = []
    if item_id is not None:
        sql += " WHERE item_id = ?"
        args.append(item_id)
    sql += " ORDER BY created_at DESC, rowid DESC LIMIT ?"
    args.append(max(1, min(int(limit), 500)))
    return [dict(row) for row in conn.execute(sql, args).fetchall()]


# --------------------------------------------------------------------------- #
# Door 1: the owner revealing a value
# --------------------------------------------------------------------------- #


def _pending_approval(
    conn: sqlite3.Connection, item_id: str, principal: str
) -> dict[str, Any] | None:
    rows = conn.execute(
        "SELECT * FROM approvals WHERE action = ? AND requester = ?"
        " ORDER BY rowid DESC LIMIT 5",
        (f"vault.reveal:{item_id}", principal),
    ).fetchall()
    for row in rows:
        data = dict(row)
        if data.get("consumed_at"):
            continue
        if data.get("decision") not in ("pending", "approved", "approved_forever"):
            continue
        expires = data.get("expires_at")
        if expires and datetime.fromisoformat(expires) < datetime.now(UTC):
            continue
        return data
    return None


def request_revelation(
    conn: sqlite3.Connection, item_id: str, principal: str
) -> str:
    """Open (or re-open) the owner approval for revealing ``item_id``."""
    if get_item(conn, item_id) is None:
        raise VaultNotFound(item_id)
    digest = store.tool_digest(
        tool_name="vault.reveal",
        arguments=json.dumps({"item_id": item_id, "principal": principal}, sort_keys=True),
    )
    existing = _pending_approval(conn, item_id, principal)
    if existing is not None:
        return str(existing["id"])
    approval = store.request_approval(
        conn,
        action=f"vault.reveal:{item_id}",
        requester=principal,
        digest=digest,
    )
    return approval.id


def reveal(
    conn: sqlite3.Connection,
    item_id: str,
    *,
    principal: str,
    factor_ok: bool = True,
    confirm: bool = False,
) -> str:
    """Return the plaintext value for the owner. Raises :class:`VaultError`.

    Order matters and every refusal is logged: existence → explicit
    confirmation → second factor → (when the item demands it) a granted
    owner approval → decryption. A failure at any step returns nothing.
    """
    row = conn.execute(
        "SELECT * FROM vault_items WHERE id = ? AND revoked_at IS NULL", (item_id,)
    ).fetchone()
    if row is None:
        raise VaultNotFound(item_id)
    item = dict(row)

    if not confirm:
        _log(conn, item_id, principal, "reveal", "denied", "confirmation missing", factor_ok)
        conn.commit()
        raise VaultConfirmRequired("revelation requires an explicit confirmation")

    if not factor_ok:
        _log(conn, item_id, principal, "reveal", "denied", "second factor failed", False)
        conn.commit()
        raise VaultDenied("second factor failed")

    policy = str(item.get("reveal_policy") or "confirm")
    if policy == "approval":
        digest = store.tool_digest(
            tool_name="vault.reveal",
            arguments=json.dumps({"item_id": item_id, "principal": principal}, sort_keys=True),
        )
        pending = _pending_approval(conn, item_id, principal)
        if pending is None:
            approval_id = request_revelation(conn, item_id, principal)
            _log(conn, item_id, principal, "reveal", "denied", "approval requested", factor_ok)
            conn.commit()
            raise VaultApprovalPending("revelation awaits owner approval", approval_id)
        if pending.get("decision") not in ("approved", "approved_forever"):
            _log(
                conn, item_id, principal, "reveal", "denied",
                f"approval {pending.get('decision')}", factor_ok,
            )
            conn.commit()
            raise VaultApprovalNotGranted("revelation approval is not granted")
        if pending.get("digest") and pending["digest"] != digest:
            _log(conn, item_id, principal, "reveal", "denied", "digest mismatch", factor_ok)
            conn.commit()
            raise VaultApprovalNotGranted("revelation approval no longer matches this item")

    try:
        plaintext = decrypt_secret(str(item["ciphertext"]))
    except SecretDecryptError as exc:
        _log(conn, item_id, principal, "reveal", "denied", "decrypt failed", factor_ok)
        conn.commit()
        raise VaultDenied("stored value cannot be decrypted") from exc

    # One-use: an approved approval is consumed by the reveal it authorized.
    if policy == "approval":
        conn.execute(
            "UPDATE approvals SET consumed_at = ? WHERE action = ? AND requester = ?"
            " AND decision = 'approved' AND consumed_at IS NULL",
            (_now_iso(), f"vault.reveal:{item_id}", principal),
        )
    _log(conn, item_id, principal, "reveal", "allowed", "", factor_ok)
    conn.commit()
    return plaintext


# --------------------------------------------------------------------------- #
# Door 2: the server resolving a value for a grantee
# --------------------------------------------------------------------------- #


def resolve_for(
    conn: sqlite3.Connection,
    name: str,
    *,
    grantee_kind: str,
    grantee_id: str,
    scope_level: str = "global",
    scope_id: str = "",
    purpose: str = "",
) -> str:
    """Resolve a credential for an integration, fail-closed and audited.

    Used by mail sync, the Telegram bridge, MCP servers and providers. A
    missing item, a revoked item or a missing grant all raise
    :class:`VaultDenied` — never a fallback to a plaintext environment value.
    """
    item = find_item(conn, name, scope_level, scope_id)
    if item is None:
        _log(conn, name, f"{grantee_kind}:{grantee_id}", "resolve", "denied", "not found")
        conn.commit()
        raise VaultNotFound(f"no vault item {name!r} in {scope_level} scope")
    if not _has_grant(conn, item, grantee_kind, grantee_id, "use"):
        _log(
            conn, item["id"], f"{grantee_kind}:{grantee_id}", "resolve", "denied",
            f"no grant ({purpose})",
        )
        conn.commit()
        raise VaultDenied(f"{grantee_kind}:{grantee_id} has no grant for {name!r}")
    try:
        plaintext = decrypt_secret(str(item["ciphertext"]))
    except SecretDecryptError as exc:
        _log(conn, item["id"], f"{grantee_kind}:{grantee_id}", "resolve", "denied", "decrypt failed")
        conn.commit()
        raise VaultDenied("stored value cannot be decrypted") from exc
    _log(
        conn, item["id"], f"{grantee_kind}:{grantee_id}", "resolve", "allowed",
        purpose or "", True,
    )
    conn.commit()
    return plaintext
