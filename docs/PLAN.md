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

## Reconciled status (verified against code/history, 2026-10-17)

History note: everything below is now verified against the repository, not
owner-reported. The "Current verified architecture" section above describes
the pre-Phase-3 baseline and is kept for history; the older capability
inventory ("Absent: real model calls, web fetch, UI, dashboards") is
superseded by the record below and the git log.

- [x] Phase 3 fetch — hardened `fetch.py` (`f1f2e10`), DNS-rebinding
  transport pinning (`a89f5a2`), wall-clock budget + IPv4-mapped unwrap +
  encoding tests (this slice). ADR 0007. Acceptance: every resolved/pinned
  address must be globally public; blocked targets provably never reach the
  connector (recording-connector tests); redirects re-validated/re-pinned
  per hop; no proxy bypass; size/decompression/total-time caps; untrusted
  framing at `providers.py`.
- [x] Phase 4 slice A' (fetch behavior, pre-dating that naming): real
  webhook-out delivery behind the outbox (`b14d748`), scheduler-driven
  backoff (`65bf04a`), read-only GitHub issue fetch + preview-then-ingest
  (`449891c`), durable delivery states with locked claims and retry sweeps.
- [x] Dashboard: read-mostly ops UI consuming the API (`135652c`) with a
  chat home view (`2a239eb`) — strictly behind bearer auth.
- Remaining Phase 3 item: none — web search now implemented
  (credential-free DuckDuckGo Lite via `search.py`, ADR 0007 item 6,
  owner-selected). `tools.web_search` capability `ready`.
- Phase 4 remaining: per the prompt, the outbox/GitHub/webhook work that
  exists is the *slice* that proved the pattern; the remaining durable-
  delivery hardening (retry/backoff limits visibility, idempotent delivery
  keys, failure surfaces) is tracked as follow-up in
  `docs/phase4-architecture.md` review notes when the search slice closes.
- Next action: OpenCode reviews the Phase 3 diff (fetch + search +
  transport hardening) before any Phase 4 continuation.

## Phase 4 plan (written 2026-10-17; implementation gated on Phase 3 review)

Verified reality: the original Phase 4 acceptance criteria are already
substantially implemented — nothing below may restate completed work as
absent.

- A. **Real GitHub issue retrieval — DONE, keep verified.** One host
  (`api.github.com`), env-referenced token only (`449891c`), read-only,
  preview-then-ingest, typed errors (404/401/403/429/protocol), size/time
  caps, redirects re-validated on-host. Slice owner verifies test coverage
  (`tests/test_github_fetch.py`) once more during this review; no new
  build unless a gap is found.
- B. **Durable outbox — DONE, one residual to verify/harden.** Delivery
  states + locked claims (`b14d748`), backoff via `next_attempt_at`,
  `MAX_DELIVERY_ATTEMPTS` terminal failure, due sweep (`65bf04a`),
  failure events. Residual to verify: **stale delivery lock after a
  crash mid-send** — confirm whether recovery clears `locked=1` rows on
  restart or sweeps them after a lease timeout; add a tested fix if not.
- C. **One real outbound channel — DONE (webhook-out).** Allowlisted
  HTTPS targets, SSRF-guarded via the same pinned transport, idempotent
  re-send payloads (receiver dedupes on notification id). No email/Slack
  work is scheduled; those remain stub capabilities.
- Acceptance for the B residual slice: a crashed `sending` delivery is
  retried or terminated per policy after restart or lease expiry; at most
  one in-flight send per notification row (lock testified by a test);
  failure path still records `notification.failed` with attempt count.

## Milestones (updated)

- [x] Phase 0 — baseline checkpoint (`63ef83c`), provenance, gates green.
- [x] Phase 1 — real provider execution + minimal tool-call loop (`82edd35`, ADR 0005).
- [x] Phase 2 — personal-use security: credential encryption, approval hygiene,
  manifest import (`cfea25d`, `9b35cd8`, ADR 0006).
- [x] Phase 3 — web research with SSRF hardening (fetch + transport pinning +
  wall-clock budgets; credential-free DuckDuckGo Lite search via `search.py`;
  post-review fixes applied — see ADR 0007 item 7; DNS-time residual documented).
- [ ] Phase 4 — durable integrations (one real channel, real GitHub fetch, outbox delivery).
- [ ] Phase 5+ — productivity integrations, knowledge, MCP/delegation, automation, usability.

## Phase 1 outcome (implemented as `82edd35`)

Per-project provider row referencing a local env var or inline secret
(encrypted at rest since Phase 2); one OpenAI-compatible chat target;
bounded tool-call loop inside the adapter (see ADR 0005).

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

- Milestone: scheduler-driven webhook backoff implemented (single inline
  attempt, due-sweep retries, overlap locks); gates green.
- Token hygiene scope: approval tokens expire/are one-use/purged; bearer-token
  rotation explicitly cut (capability `auth.token-rotation: deferred`).
- Keyless mode: local-dev without a key supports non-secret configs only.
- Blockers: none for this milestone. Dev-default bearer token still accepted
  (explicit follow-up, unchanged).
- Next action: commit; next slice per owner selection.
