# 0004 — Phase 4 Feature Selection

Date: 2026-10-16. Status: accepted (written before implementation).

Rule: prove one or two complete vertical slices; everything else lands as a
stub with a capability flag. No subsystem rewrites.

## Selected (complete verticals)

### S1. Provider adapter layer — ADAPT (local/mock ready, others stubbed)
- Source: Octop pluggable-backends pattern (MIT, concept only — no code).
- Value: teammate runs record *which* provider executed them; choice is
  auth-scoped and auditable. High — required for any future model work.
- Cost: low. One `Provider` row per project, `RuntimeAdapter` dispatch by
  kind, `run.provider_id` + audit event.
- Risk: low. `local` reuses the proven adapter; `mock` executes nothing
  (deterministic canned output); `openai-compatible` is a stub that refuses
  without credentials instead of implying a working integration.

### S2. Knowledge / retrieval adapter — ADAPT (token-overlap, no vectors)
- Source: usefulness patterns from all three refs (chunk/cite/recall);
  reimplemented from scratch (word-window chunker, overlap scoring).
- Value: runs/tasks gain cited evidence artifacts with source, scope,
  confidence, timestamp. Medium-high, fully offline.
- Cost: medium. Two tables + chunk/retrieve/attach + evidence artifact.
- Risk: low. No embeddings, no external deps; deterministic scoring.

## Supporting (thin, SQLite-backed)

### S3. Scheduling / cron adapter — ADAPT (minimal cron subset)
- Source: Octop cron-table pattern (MIT, concept only).
- Scope: persisted schedules, validated 5-field cron (`*`, `*/n`, ranges,
  lists), `next_run_at`, overlap lock, deterministic `fire_due_schedules`
  (schedule → task → run → audit). No natural-language-to-cron.
- Risk: low-medium; overlap lock + id-ordered firing keep it deterministic.

### S4. One ingress + outbox notification — ADAPT/BUILD minimal
- Inbound webhook-style ingress (`POST /projects/{id}/ingress`) creates
  issue + task + audit event. Real and authenticated.
- Outbound `outbox` channel persists notification rows (no external send).
  email/slack/webhook-out are stubs with capability flags. Secrets redacted.

### S5. Backup manifest + restore validation — BUILD minimal
- Versioned JSON export of domain rows + workspace refs; provider secrets
  redacted. Restore = validated manifest + documented API-replay procedure
  (no blind row import). Tested at metadata/ref level.

### S6. Observability — BUILD minimal
- Request IDs, structured log fields, extended `/health`, owner-scoped
  `/metrics` (runs, approvals, failed commands, restarts, schedules).

## Stubs (capability flags + tests, no behavior)

| Candidate | Verdict | Source / license | Why |
|---|---|---|---|
| GitHub issue fetching | DEFER (stub exists) | — | No credentials; manual ingest works |
| External coding agents | REJECT (stub) | — | Violates adapter-only rule until contracted |
| Document/calendar/email workflows | DEFER (stub) | — | No demand in slice; outbox covers records |
| Second notify channel | REJECT (stub) | — | One channel proves the path |
| Browser automation | REJECT (stub) | Octop CDP / ODY fetch concepts | Hardest to secure; static needs suffice |
| Vector RAG / pgvector | REJECT | — | No corpus; overlap retrieval suffices |
| PostgreSQL | DEFER | — | SQLite + migration path acceptable |
| Multi-org hierarchy | REJECT | Octop org layer (inert upstream) | Out of product scope |
| OAuth/MCP | DEFER (stub) | Octop patterns (MIT) | Needs credential-custody audit first |
| NL-to-cron | REJECT | — | Unneeded; validated cron subset suffices |
| Push/merge automation | REJECT | — | Explicitly out of scope |

## License notes
- No Odysseus (AGPL) code is copied; fetch-hardening *concepts* are not even
  needed here (no outbound network in any selected adapter).
- Octop (MIT) concepts adapted with attribution in provenance; no verbatim reuse.
- AI Teammates remains reference-only.
