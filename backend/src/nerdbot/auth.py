"""Unified authentication and permissions for the Phase 1 slice.

Single-principal bearer-token auth (local development). The token is read
from the ``NERDBOT_TOKEN`` environment variable and defaults to a dev-only
value. Production deployments must set a unique secret.

Permission model:
- The authenticated principal owns every project it creates (owner field).
- Mutations on a project require the caller to be the project owner.
- A task's owner teammate must belong to the same project as the task.
- Secrets are never logged; only a redacted token prefix appears in errors.
"""

from __future__ import annotations

import os
import sqlite3

from fastapi import Header, HTTPException

from . import store

DEV_DEFAULT_TOKEN = "dev-token-change-me"
PRINCIPAL = "local-owner"


def expected_token() -> str:
    return os.environ.get("NERDBOT_TOKEN", DEV_DEFAULT_TOKEN)


def principal_from_header(authorization: str | None = Header(default=None)) -> str:
    """Validate ``Authorization: Bearer <token>`` and return the principal."""
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="missing bearer token")
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
