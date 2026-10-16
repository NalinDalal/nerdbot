"""Local secret encryption at rest (Fernet, key from environment).

- Current key: ``NERDBOT_SECRET_KEY`` (a Fernet key, version ``"1"``).
- Previous key: ``NERDBOT_SECRET_KEY_PREVIOUS`` (version ``"0"``, decrypt-only,
  enables rotation).
- Stored form: ``"enc:<version>:<fernet-token>"``.
- Fail-closed: decryption failure raises; callers must refuse to use the
  value, never fall back to it as plaintext. Missing key at encrypt time
  raises; nothing is silently stored in the clear.
"""

from __future__ import annotations

import os

from cryptography.fernet import Fernet, InvalidToken

ENC_PREFIX = "enc:"
CURRENT_VERSION = "1"
PREVIOUS_VERSION = "0"

SECRET_KEYS = frozenset({"api_key", "apikey", "secret", "token", "password", "authorization"})


class SecretKeyMissingError(ValueError):
    """No runtime key configured; refusing to store a secret in the clear."""


class SecretDecryptError(ValueError):
    """Stored ciphertext cannot be decrypted; refusing to use it."""


def _load_key(value: str, env_name: str) -> bytes:
    try:
        key = value.encode("ascii")
        Fernet(key)  # validates format without using it
    except Exception as exc:
        raise SecretKeyMissingError(f"{env_name} is not a valid Fernet key") from exc
    return key


def keyring() -> dict[str, bytes]:
    """Versioned decryption keys available in this process."""
    ring: dict[str, bytes] = {}
    current = os.environ.get("NERDBOT_SECRET_KEY", "")
    if current:
        ring[CURRENT_VERSION] = _load_key(current, "NERDBOT_SECRET_KEY")
    previous = os.environ.get("NERDBOT_SECRET_KEY_PREVIOUS", "")
    if previous:
        ring[PREVIOUS_VERSION] = _load_key(previous, "NERDBOT_SECRET_KEY_PREVIOUS")
    return ring


def is_encrypted(value: object) -> bool:
    return isinstance(value, str) and value.startswith(ENC_PREFIX)


def verify_envelope(blob: str) -> str:
    """Validate a ciphertext envelope without decrypting.

    Returns the blob unchanged when it parses as ``enc:<version>:<token>``
    with a known version. Raises SecretDecryptError otherwise, so callers
    never store malformed lookalikes.
    """
    if not is_encrypted(blob):
        raise SecretDecryptError("value is not encrypted ciphertext")
    try:
        _, version, token = blob.split(":", 2)
    except ValueError as exc:
        raise SecretDecryptError("malformed ciphertext envelope") from exc
    if version not in (CURRENT_VERSION, PREVIOUS_VERSION) or not token:
        raise SecretDecryptError(f"unknown ciphertext version {version!r}")
    return blob


def encrypt_secret(plaintext: str) -> str:
    """Encrypt one secret value. Raises SecretKeyMissingError without a key."""
    ring = keyring()
    if CURRENT_VERSION not in ring:
        raise SecretKeyMissingError("provider secrets require NERDBOT_SECRET_KEY to be configured")
    token = Fernet(ring[CURRENT_VERSION]).encrypt(plaintext.encode("utf-8")).decode("ascii")
    return f"{ENC_PREFIX}{CURRENT_VERSION}:{token}"


def decrypt_secret(blob: str) -> str:
    """Decrypt a stored value. Raises SecretDecryptError on any failure."""
    if not is_encrypted(blob):
        raise SecretDecryptError("value is not encrypted ciphertext")
    try:
        _, version, token = blob.split(":", 2)
    except ValueError as exc:
        raise SecretDecryptError("malformed ciphertext envelope") from exc
    key = keyring().get(version)
    if key is None:
        raise SecretDecryptError(f"no decryption key for version {version!r}")
    try:
        return Fernet(key).decrypt(token.encode("ascii")).decode("utf-8")
    except (InvalidToken, ValueError) as exc:
        raise SecretDecryptError("ciphertext failed authentication") from exc


def is_secret_key(name: str) -> bool:
    return name.lower() in SECRET_KEYS
