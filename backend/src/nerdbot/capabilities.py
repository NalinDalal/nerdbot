"""Capability flags: what is ready vs explicitly stubbed.

Every integration in Phase 4 scope is listed here exactly once. Stubs never
imitate working behavior; they report ``configured: false`` with a reason.
"""

from __future__ import annotations

from typing import Any

CAPABILITIES: list[dict[str, Any]] = [
    {
        "id": "provider.local",
        "status": "ready",
        "description": "Local shell execution inside the task workspace.",
    },
    {
        "id": "provider.mock",
        "status": "ready",
        "description": "Deterministic mock provider; executes nothing, returns canned output.",
    },
    {
        "id": "provider.openai-compatible",
        "status": "ready",
        "description": "Bounded agent loop over OpenAI-style /chat/completions; needs base_url plus api_key or api_key_env.",
    },
    {
        "id": "knowledge.overlap",
        "status": "ready",
        "description": "Offline chunk/cite/retrieve with token-overlap scoring (no vectors).",
    },
    {
        "id": "knowledge.vectors",
        "status": "rejected",
        "description": "No corpus justifies embeddings; overlap retrieval suffices.",
    },
    {
        "id": "scheduler.cron",
        "status": "ready",
        "description": "Persisted schedules with validated cron subset and overlap lock.",
    },
    {
        "id": "scheduler.nl-to-cron",
        "status": "rejected",
        "description": "Unneeded; validated cron subset suffices.",
    },
    {
        "id": "ingress.webhook",
        "status": "ready",
        "description": "Authenticated inbound ingestion creating issue + task.",
    },
    {
        "id": "notify.outbox",
        "status": "ready",
        "description": "Persisted notification records; no external send.",
    },
    {
        "id": "notify.email",
        "status": "stub",
        "description": "Deferred: no mail transport configured.",
    },
    {
        "id": "notify.slack",
        "status": "stub",
        "description": "Deferred: no webhook URL configured.",
    },
    {
        "id": "notify.webhook-out",
        "status": "stub",
        "description": "Deferred: no outbound target configured.",
    },
    {
        "id": "github.fetch",
        "status": "stub",
        "description": "Deferred: manual issue ingestion is the supported path.",
    },
    {
        "id": "agents.external",
        "status": "stub",
        "description": "Rejected until an adapter contract exists.",
    },
    {
        "id": "documents.calendar-email",
        "status": "stub",
        "description": "Deferred: no demand in this slice.",
    },
    {
        "id": "browser.automation",
        "status": "stub",
        "description": "Rejected: hardest channel to secure; static needs suffice.",
    },
    {
        "id": "backup.manifest",
        "status": "ready",
        "description": "Versioned metadata export with secret redaction + validation + validated import (history never replayed, secrets never restored).",
    },
    {
        "id": "database.postgres",
        "status": "deferred",
        "description": "SQLite plus migration path is acceptable for now.",
    },
]


def capability_map() -> dict[str, dict[str, Any]]:
    return {entry["id"]: entry for entry in CAPABILITIES}


def is_ready(capability_id: str) -> bool:
    entry = capability_map().get(capability_id)
    return entry is not None and entry["status"] == "ready"
