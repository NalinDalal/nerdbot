"""Declared request bodies for the mutating endpoints.

Most write routes used to take a bare ``dict[str, Any]`` and coerce fields
by hand. ``str(body.get("command", ""))`` turns a missing field into an
empty string, an explicit ``None`` into the literal text ``"None"``, and a
wrong type into a silent success. These models give the important writes a
declared contract, so FastAPI rejects a malformed body with 422 before the
handler runs, and the accepted fields are written down in one place.

Three rules keep this a tightening rather than a rewrite:

* Unknown fields are ignored, exactly as before. A client that sends extra
  keys is not broken by this change.
* An optional field may be sent as ``null``. A browser client sends
  ``undefined`` for "not chosen", which ``JSON.stringify`` drops, but an
  explicit ``null`` is a normal thing to send and must not be a 422. The
  handler reads each one as ``value or ""``.
* The *semantic* checks — is this a valid provider kind, a valid decision? —
  stay in the handlers and keep their 400 responses. Typing those fields
  would turn a 400 into a 422, which is a different contract than callers
  have today.

Only the bodies the product actually writes are modelled here. The routes
that still take ``dict[str, Any]`` are listed in the architecture audit
rather than changed speculatively.
"""

from __future__ import annotations

from typing import Any

from pydantic import BaseModel, ConfigDict


class _Body(BaseModel):
    """Base for request bodies: ignore unknown fields, like the old dict."""

    model_config = ConfigDict(extra="ignore")


class ProjectCreate(_Body):
    repository: str | None = None
    config: dict[str, Any] | None = None


class TaskCreate(_Body):
    description: str | None = None
    command: str | None = None
    owner_teammate_id: str | None = None
    dependencies: list[str] | None = None
    issue_id: str | None = None


class TeammateCreate(_Body):
    persona: str | None = None
    instructions: str | None = None
    capabilities: list[str] | None = None
    memory_scope: str | None = None
    permissions: list[str] | None = None
    provider_id: str | None = None


class ThreadCreate(_Body):
    title: str | None = None
    provider_id: str | None = None


class ThreadUpdate(_Body):
    """Partial update: only the fields the caller actually sent are applied."""

    title: str | None = None
    provider_id: str | None = None
    summary: str | None = None


class ProviderCreate(_Body):
    kind: str | None = None
    name: str | None = None
    config: dict[str, Any] | None = None
    capabilities: list[str] | None = None


class ApprovalDecision(_Body):
    """The decision value itself is validated in the handler (400, as before)."""

    decision: str | None = None
