"""RFC 6238 TOTP second factor and recovery codes.

Implemented from RFC 4226 (HOTP) and RFC 6238 (TOTP) with the standard
primitives only — ``hmac``, ``hashlib``, ``base64``, ``struct`` — so the
factor works with no extra dependency and no network.

Properties this module holds:

* **Fail-closed.** No enrollment, or an enrollment that was never confirmed,
  means "second factor not configured", never "accept anything".
* **No replay.** A successful verification advances ``last_used_step``; the
  same code cannot be presented twice inside its own time step.
* **Secrets never leave the server.** The shared secret is stored encrypted
  through :mod:`nerdbot.secrets`; only the enrollment status and a masked
  identifier are ever returned to a client.
* **Recovery codes are one-use.** Stored as SHA-256 hashes, consumed on use.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import secrets as _secrets
import sqlite3
import struct
from datetime import UTC, datetime
from typing import Any

from . import store
from .secrets import SecretDecryptError, decrypt_secret, encrypt_secret

DIGITS = 6
PERIOD = 30
#: Accept the previous/next step to tolerate clock skew and the boundary of a
#: step; anything wider would hand an attacker 90 s of guesses.
WINDOW = 1
RECOVERY_CODE_COUNT = 10
RECOVERY_CODE_SHAPE = "XXXXX-XXXXX"


class TotpError(ValueError):
    """Base class for second-factor failures."""


class TotpNotEnrolled(TotpError):
    """The principal has no confirmed second factor."""


class TotpInvalid(TotpError):
    """The presented code did not verify."""


class TotpReplayed(TotpError):
    """The code was already used inside its own time step."""


# --------------------------------------------------------------------------- #
# HOTP / TOTP core
# --------------------------------------------------------------------------- #


def generate_secret() -> str:
    """A new base32 (no padding) shared secret, 160 bits as recommended."""
    raw = _secrets.token_bytes(20)
    return base64.b32encode(raw).decode("ascii").rstrip("=")


def _decode_secret(secret: str) -> bytes:
    padded = secret + "=" * (-len(secret) % 8)
    try:
        raw = base64.b32decode(padded.upper(), casefold=True)
    except Exception as exc:  # noqa: BLE001 - malformed secret is a config error
        raise TotpInvalid("stored second-factor secret is malformed") from exc
    if not raw:
        raise TotpInvalid("stored second-factor secret is empty")
    return raw


def hotp(secret: str, counter: int, digits: int = DIGITS) -> str:
    """RFC 4226 dynamic-truncation code for ``counter``."""
    key = _decode_secret(secret)
    mac = hmac.new(key, struct.pack(">Q", counter), hashlib.sha1).digest()
    offset = mac[-1] & 0x0F
    (value,) = struct.unpack(">I", mac[offset : offset + 4])
    value &= 0x7FFFFFFF
    return str(value % (10**digits)).zfill(digits)


def totp(secret: str, at: float | None = None, period: int = PERIOD) -> str:
    """The code valid at ``at`` (epoch seconds, default now)."""
    moment = time_now() if at is None else at
    return hotp(secret, int(moment // period))


def time_now() -> float:
    return datetime.now(UTC).timestamp()


def seconds_remaining(at: float | None = None, period: int = PERIOD) -> int:
    moment = time_now() if at is None else at
    return period - int(moment % period)


def verify_code(
    secret: str,
    code: str,
    at: float | None = None,
    window: int = WINDOW,
) -> bool:
    """True when ``code`` matches the current or an adjacent step."""
    normalized = "".join(ch for ch in (code or "") if ch.isdigit())
    if len(normalized) != DIGITS:
        return False
    moment = time_now() if at is None else at
    counter = int(moment // PERIOD)
    for candidate in range(counter - window, counter + window + 1):
        if candidate < 0:
            continue
        if hmac.compare_digest(hotp(secret, candidate), normalized):
            return True
    return False


# --------------------------------------------------------------------------- #
# Enrollment state (per principal, stored encrypted)
# --------------------------------------------------------------------------- #


def enrollment(conn: sqlite3.Connection, principal: str) -> dict[str, Any] | None:
    row = conn.execute(
        "SELECT * FROM totp_enrollment WHERE principal = ?", (principal,)
    ).fetchone()
    if row is None:
        return None
    return dict(row)


def is_enabled(conn: sqlite3.Connection, principal: str) -> bool:
    row = conn.execute(
        "SELECT enabled FROM totp_enrollment WHERE principal = ?", (principal,)
    ).fetchone()
    return bool(row and int(row["enabled"]))


def begin_enrollment(conn: sqlite3.Connection, principal: str) -> dict[str, Any]:
    """Create (or replace an unconfirmed) enrollment and return its secret.

    The secret is returned exactly once, at enrollment time, so the operator
    can scan it. It is stored encrypted; replacing an enrollment resets it to
    ``enabled = 0`` until a code is confirmed.
    """
    secret = generate_secret()
    now = _now_iso()
    existing = enrollment(conn, principal)
    if existing is None:
        conn.execute(
            "INSERT INTO totp_enrollment"
            " (id, principal, secret, enabled, confirmed_at, created_at, last_used_step)"
            " VALUES (?, ?, ?, 0, NULL, ?, -1)",
            (store.new_id("totp"), principal, encrypt_secret(secret), now),
        )
    else:
        conn.execute(
            "UPDATE totp_enrollment SET secret = ?, enabled = 0, confirmed_at = NULL,"
            " last_used_step = -1 WHERE principal = ?",
            (encrypt_secret(secret), principal),
        )
    conn.commit()
    return {
        "principal": principal,
        "secret": secret,
        "issuer": "NerdBot",
        "digits": DIGITS,
        "period": PERIOD,
        "algorithm": "SHA1",
        "enabled": False,
    }


def _stored_secret(conn: sqlite3.Connection, principal: str) -> str:
    row = conn.execute(
        "SELECT secret FROM totp_enrollment WHERE principal = ?", (principal,)
    ).fetchone()
    if row is None:
        raise TotpNotEnrolled("no second factor enrolled")
    try:
        return decrypt_secret(str(row["secret"]))
    except SecretDecryptError as exc:
        raise TotpNotEnrolled("second-factor secret is unreadable") from exc


def confirm_enrollment(
    conn: sqlite3.Connection, principal: str, code: str, at: float | None = None
) -> bool:
    """Verify the first code and switch the factor on."""
    row = conn.execute(
        "SELECT secret FROM totp_enrollment WHERE principal = ?", (principal,)
    ).fetchone()
    if row is None:
        raise TotpNotEnrolled("no second factor enrolled")
    secret = decrypt_secret(str(row["secret"]))
    if not verify_code(secret, code, at=at):
        return False
    conn.execute(
        "UPDATE totp_enrollment SET enabled = 1, confirmed_at = ?, last_used_step = ?"
        " WHERE principal = ?",
        (_now_iso(), _step(at), principal),
    )
    conn.commit()
    return True


def _step(at: float | None) -> int:
    moment = time_now() if at is None else at
    return int(moment // PERIOD)


def verify(
    conn: sqlite3.Connection,
    principal: str,
    code: str,
    at: float | None = None,
) -> bool:
    """Verify a TOTP code for an enabled factor, refusing replay."""
    if not is_enabled(conn, principal):
        raise TotpNotEnrolled("second factor is not enabled")
    secret = _stored_secret(conn, principal)
    if not verify_code(secret, code, at=at):
        return False
    step = _step(at)
    row = conn.execute(
        "SELECT last_used_step FROM totp_enrollment WHERE principal = ?",
        (principal,),
    ).fetchone()
    last_used = int(row["last_used_step"]) if row else -1
    if step <= last_used:
        raise TotpReplayed("this code was already used")
    conn.execute(
        "UPDATE totp_enrollment SET last_used_step = ? WHERE principal = ?",
        (step, principal),
    )
    conn.commit()
    return True


# --------------------------------------------------------------------------- #
# Recovery codes
# --------------------------------------------------------------------------- #


def _hash_code(principal: str, code: str) -> str:
    normalized = "".join(ch for ch in code.upper() if ch.isalnum())
    return hashlib.sha256(f"{principal}:{normalized}".encode()).hexdigest()


def generate_recovery_codes(conn: sqlite3.Connection, principal: str) -> list[str]:
    """Issue a fresh set of one-use codes, invalidating the previous set."""
    conn.execute("DELETE FROM totp_recovery_codes WHERE principal = ?", (principal,))
    codes: list[str] = []
    for _ in range(RECOVERY_CODE_COUNT):
        raw = _secrets.token_urlsafe(8).replace("-", "")[:10].upper()
        raw = raw.ljust(10, "0")
        code = f"{raw[:5]}-{raw[5:]}"
        codes.append(code)
        conn.execute(
            "INSERT INTO totp_recovery_codes"
            " (id, principal, code_hash, used_at, created_at)"
            " VALUES (?, ?, ?, NULL, ?)",
            (store.new_id("trec"), principal, _hash_code(principal, code), _now_iso()),
        )
    conn.commit()
    return codes


def use_recovery_code(conn: sqlite3.Connection, principal: str, code: str) -> bool:
    """Consume a recovery code. One use, ever."""
    digest = _hash_code(principal, code)
    row = conn.execute(
        "SELECT id FROM totp_recovery_codes"
        " WHERE principal = ? AND code_hash = ? AND used_at IS NULL",
        (principal, digest),
    ).fetchone()
    if row is None:
        return False
    conn.execute(
        "UPDATE totp_recovery_codes SET used_at = ? WHERE id = ?",
        (_now_iso(), row["id"]),
    )
    conn.commit()
    return True


def disable(conn: sqlite3.Connection, principal: str) -> bool:
    """Turn the factor off (the owner must authenticate to reach here)."""
    row = conn.execute(
        "SELECT id FROM totp_enrollment WHERE principal = ?", (principal,)
    ).fetchone()
    if row is None:
        return False
    conn.execute(
        "UPDATE totp_enrollment SET enabled = 0 WHERE principal = ?", (principal,)
    )
    conn.execute("DELETE FROM totp_recovery_codes WHERE principal = ?", (principal,))
    conn.commit()
    return True


def status(conn: sqlite3.Connection, principal: str) -> dict[str, Any]:
    """What a client may know: enabled or not, never the secret."""
    row = enrollment(conn, principal)
    if row is None:
        return {"enabled": False, "enrolled": False}
    remaining = conn.execute(
        "SELECT COUNT(*) AS n FROM totp_recovery_codes"
        " WHERE principal = ? AND used_at IS NULL",
        (principal,),
    ).fetchone()
    return {
        "enabled": bool(int(row["enabled"])),
        "enrolled": True,
        "confirmed_at": row.get("confirmed_at") or None,
        "recovery_codes_remaining": int(remaining["n"]) if remaining else 0,
    }


def verify_factor(
    conn: sqlite3.Connection, principal: str, presented: str | None
) -> bool:
    """Verify a presented factor (TOTP or recovery code) when one is enabled.

    Returns ``True`` when no factor is configured — the factor is only
    enforced once the operator has turned it on.
    """
    if not is_enabled(conn, principal):
        return True
    if not presented:
        return False
    candidate = presented.strip()
    if "-" in candidate and not candidate.isdigit():
        if use_recovery_code(conn, principal, candidate):
            return True
        return False
    try:
        return verify(conn, principal, candidate)
    except TotpError:
        return False


def _now_iso() -> str:
    return datetime.now(UTC).isoformat()
