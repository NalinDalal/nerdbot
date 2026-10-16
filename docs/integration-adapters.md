# Integration Adapters — Status Table

Source of truth in code: `capabilities.py` + `GET /capabilities`.
License posture: Octop (MIT) concepts adapted with attribution; Odysseus
(AGPL) code never copied; AI Teammates reference-only.

| Adapter | Status | Notes |
|---|---|---|
| provider.local | READY | In-workspace shell via `LocalRuntimeAdapter` |
| provider.mock | READY | Canned deterministic output, executes nothing |
| provider.openai-compatible | STUB | Refuses without credentials; execution deferred |
| knowledge.overlap | READY | Word-window chunks, overlap scoring, citations |
| knowledge.vectors | REJECTED | No corpus justifies embeddings |
| scheduler.cron | READY | Validated subset, overlap lock, deterministic firing |
| scheduler.nl-to-cron | REJECTED | Unneeded |
| ingress.webhook | READY | Authenticated issue+task creation |
| notify.outbox | READY | Persisted redacted records, no external send |
| notify.email/slack/webhook-out | STUB | `ChannelNotConfiguredError` |
| github.fetch | STUB | Manual ingestion is the supported path |
| agents.external | STUB | Rejected until an adapter contract exists |
| documents.calendar-email | STUB | Deferred, no demand |
| browser.automation | STUB | Rejected, hardest to secure |
| backup.manifest | READY | V1 export + validation + validated import (history never replayed, secrets never restored) |
| database.postgres | DEFERRED | SQLite + migration path acceptable |

Stub contract: calling a stub returns an explicit not-configured error
(never empty success); `GET /capabilities` reports each entry; every stub
is covered by a test asserting the refusal.
