"""GitHub issue adapter.

Status: DEFERRED. No credentials, no network calls, no GitHub API usage.
Manual issue ingestion (``POST /projects/{id}/issues``) is the supported
path. This module exists so a future credential-backed adapter has a clean
seam to implement — it must never be mistaken for a working integration.
"""

from __future__ import annotations

from typing import Any, Protocol


class AdapterNotConfiguredError(RuntimeError):
    """Raised when a deferred integration is invoked without configuration."""


class GitHubIssueFetcher(Protocol):
    """Contract a future credential-backed GitHub adapter would implement."""

    def fetch_issue(self, repository: str, number: int) -> dict[str, Any]: ...  # pragma: no cover


class StubGitHubIssueFetcher:
    """Placeholder that always explains the deferral explicitly."""

    def fetch_issue(self, repository: str, number: int) -> dict[str, Any]:
        raise AdapterNotConfiguredError(
            "GitHub issue fetching is deferred: no credentials or API client configured. "
            f"Ingest issue {repository}#{number} manually via POST /projects/{{id}}/issues."
        )


def github_status() -> dict[str, Any]:
    return {
        "configured": False,
        "reason": "deferred: no credentials, no network calls",
        "manual_fallback": "POST /projects/{project_id}/issues",
    }
