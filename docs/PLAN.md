# NerdBot — Persistent Implementation Plan

Single-user personal AI assistant. Not SaaS, not multi-tenant, no billing,
no company hierarchy, no org management.

## Current verified architecture

- `backend/src/nerdbot/`: FastAPI app (`api.py`), CLI (`cli/main.py` → `nerdbot run`),
  SQLite persistence (`store.py`, WAL, idempotent migrations), orchestrator
  (`orchestrator.py`: schedule/retry/recover, state machines), runtime adapters
  (`runtime.py`: `RuntimeAdapter` single-shot `start_run`; `providers.py`:
  local/mock ready, openai-compatible refused stub).
- Coding workflow (Phase 3): issues, branched workspaces, test-log artifacts,
  reviews, patch diffs, digest-bound PR packages, roll-ups. No push/PR automation.
- Selectively integrated (Phase 4): overlap knowledge retrieval, cron schedules
  with overlap lock, webhook ingress + outbox notifications, backup manifest +
  validation, metrics, request tracing, capability flags.
- No agent loop: runs are single synchronous executions. No UI (`dashboard/` empty).
- Quality gates: `uv run pytest`, `uv run ruff check`, `uv run mypy` (strict).

## Capability inventory

- Implemented: project/teammate/task/run/artifact/memory/approval/event CRUD +
  lifecycle; local + mock execution; overlap knowledge; cron firing; ingress +
  outbox; backup export/validate; metrics/tracing.
- Partial: backup (no import path); auth (bearer token, dev default accepted).
- Stubbed (tested refusals): openai-compatible provider, email/Slack/webhook-out,
  GitHub fetch, external agents, browser, MCP/OAuth, vectors, Postgres.
- Absent: real model calls, tool-call loop, web fetch, credentials encryption,
  lockouts/quotas, UI, push/PR automation, org hierarchy.

## Milestones

- [x] Phase 0 — baseline checkpoint (`63ef83c`), provenance, gates green.
- [ ] Phase 1 — real provider execution + minimal tool-call loop (PLANNING).
- [ ] Phase 2 — personal-use security (token hygiene, credential encryption, restore validation).
- [ ] Phase 3 — web research with SSRF hardening.
- [ ] Phase 4 — durable integrations (one real channel, real GitHub fetch, outbox delivery).
- [ ] Phase 5+ — productivity integrations, knowledge, MCP/delegation, automation, usability.

## Phase 1 analysis (planning, not implemented)

Inspected: `providers.py` (dispatch + refusal stub), `runtime.py`
(single-shot `start_run` protocol), `orchestrator.py` (sync schedule/retry).

- Keys: per-project provider row referencing a **local env var name**, never the
  secret value; secret loaded at call time from process env. User-supplied keys
  go through the same path (stored reference, not value). Rationale: secrets
  never touch SQLite/API output/backups, matching existing redaction behavior.
- Provider/model: one OpenAI-compatible chat-completions target first
  (configurable `base_url`, fixed model allowlist in code). No provider
  framework beyond the existing `RuntimeAdapter` dispatch.
- Runtime: existing single-shot contract is **insufficient** for agentic
  behavior. Required: minimal tool-call loop *inside* one model-backed adapter —
  bounded iterations (default ≤8), per-call + total timeouts, tool allowlist
  (workspace shell/files only, existing `BLOCKED_PATTERNS` enforced per call),
  all tool I/O framed untrusted, every iteration persisted as run events.
- Decision recorded in `docs/decisions/0005-phase1-provider-plan.md` (to be written
  at implementation kickoff).

## Test / quality-gate commands

`uv sync --group dev` · `uv run pytest` · `uv run ruff check` · `uv run mypy`

## Decisions

`docs/decisions/0001`–`0004` (layout, persistence, coding workflow, feature selection).

## Current status

- Milestone: Phase 2 milestone implemented (credential encryption at rest,
  approval token hygiene, manifest import; ADR 0006); gates green.
- Token hygiene scope: approval tokens expire/are one-use/purged; bearer-token
  rotation explicitly cut (capability `auth.token-rotation: deferred`).
- Keyless mode: local-dev without a key supports non-secret configs only.
- Commit: see `git log` (this change uncommitted at time of writing).
- Blockers: none for this milestone. Dev-default bearer token still accepted
  (explicit follow-up, unchanged by this slice).
- Next action: commit Phase 2 milestone; then web-research planning.
