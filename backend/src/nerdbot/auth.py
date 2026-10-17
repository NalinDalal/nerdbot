"""Unified authentication and permissions for the Phase 1 slice.

Single-principal bearer-token auth (local development). The token is read
from the ``NERDBOT_TOKEN`` environment variable and defaults to a dev-only
value. Production deployments must set a unique secret.

Permission model:
- The authenticated principal owns every project it creates (owner field).
- Mutations on a project require the caller to be the project owner.
- A task's owner teammate must belong to the same project as the task.
- Secrets are never logged; only a redacted token prefix appears in errors.

Token policy (fail-closed, 2026-10-17): the well-known dev default is
accepted ONLY with the explicit ``NERDBOT_INSECURE_DEV_TOKEN=1`` opt-in
environment variable. With ``NERDBOT_TOKEN`` unset and no opt-in, the
server refuses every bearer token (HTTP 503) — serving a known public
secret by accident is the failure mode this prevents.
"""

from __future__ import annotations

import os
import sqlite3

from fastapi import Header, HTTPException

from . import store

DEV_DEFAULT_TOKEN = "dev-token-change-me"
PRINCIPAL = "local-owner"
_DEV_TOKEN_OPT_IN = "NERDBOT_INSECURE_DEV_TOKEN"


def token_status() -> str:
    """How the server resolves its bearer token.

    - ``configured``: ``NERDBOT_TOKEN`` is set (its value is the token).
    - ``dev``: NO token set but the explicit dev-only opt-in env var is
      ``1`` — the well-known default is accepted.
    - ``closed``: neither is present — NO token is valid; requests fail
      closed instead of silently serving the public dev secret.
    """
    if os.environ.get("NERDBOT_TOKEN", ""):
        return "configured"
    if os.environ.get(_DEV_TOKEN_OPT_IN) == "1":
        return "dev"
    return "closed"


def expected_token() -> str:
    """The valid token, or ``""`` when none is (fail-closed)."""
    status = token_status()
    if status == "configured":
        return os.environ["NERDBOT_TOKEN"]
    if status == "dev":
        return DEV_DEFAULT_TOKEN
    return ""


def principal_from_header(authorization: str | None = Header(default=None)) -> str:
    """Validate ``Authorization: Bearer <token>`` and return the principal."""
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="missing bearer token")
    if token_status() == "closed":
        raise HTTPException(
            status_code=503,
            detail="server token not configured: set NERDBOT_TOKEN, or"
            " NERDBOT_INSECURE_DEV_TOKEN=1 for explicit local-dev opt-in",
        )
    presented = authorization[len("Bearer ") :]
    if presented != expected_token():
        raise HTTPException(status_code=403, detail="invalid token")
    return PRINCIPAL


def require_project_owner(conn: sqlite3.Connection, project_id: str, principal: str) -> None:
    project = store.get_project(conn, project_id)
    if project is None:
        raise HTTPException(status_code=404, detail="project not found")
    if project.owner != principal:
        raise HTTPException(status_code=403, detail="not project owner")
