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
- Next action: Phase 4 slices A/B/C verified implemented and the lease
  residual closed; per-phase review before any Phase 5 selection.

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
- B. **Durable outbox — DONE, lease residual closed.** Delivery
  states + locked claims (`b14d748`), backoff via `next_attempt_at`,
  `MAX_DELIVERY_ATTEMPTS` terminal failure, due sweep (`65bf04a`),
  failure events. In-process paths release the lock in a `finally`
  (notify.py `deliver_webhook`) and owner can `POST /notifications/{id}/unlock`.
  Crash-mid-send residual is now fixed: locks are lease-stamped
  (`locked_at`, idempotent `_PHASE8` migration) and the sweep reclaims
  lease-expiredsending rows — requeue with backoff or terminal fail at
  the bounded attempts, each with an audit event. Delivery semantics
  remain at-least-once, dedupable by the receiver via
  `X-Idempotency-Key`/payload id. Tests prove: fresh leases untouched,
  abandoned locks reclaimed + redelivered exactly once per attempt,
  exhausted attempts terminate without another send, and old schemas
  migrate. This also surfaced and fixed a latent `_migrate` bug where a
  later phase's per-table column list REPLACED earlier phases' columns
  (legacy databases could miss `next_attempt_at`/`locked`).
- C. **One real outbound channel — DONE (webhook-out).** Allowlisted
  HTTPS targets, SSRF-guarded via the same pinned transport, idempotent
  re-send payloads (receiver dedupes on notification id). No email/Slack
  work is scheduled; those remain stub capabilities.
- Acceptance for the B residual slice: a crashed `sending` delivery is
  retried or terminated per policy after restart or lease expiry; at most
  one in-flight send per notification row (lock testified by a test);
  failure path still records `notification.failed` with attempt count.
  STATUS: SHIPPED — see the milestone list and `docs/phase4-architecture.md`.
  Follow-up review fixes landed (lease sized from the full attempt bound,
  compare-and-set release, both stuck-window classes closed).
- [x] Operation enablement sweep trigger — `nerdbot deliveries-sweep` CLI
  (this slice): one shell invocation runs lease reclaims + due webhook
  sends via `notify.sweep_due_deliveries`; per-delivery outcome printed;
  exit 0 iff nothing ended failed, exit 1 otherwise. Designed for an OS
  cron/timer. NerdBot itself still contains no scheduler loop.

## Phase 4 operational state (verified 2026-10-17, do not overstate)

IMPLEMENTED + TESTED + REVIEWED + OPERATIONAL: GitHub issue fetch
(preview → ingest), webhook-out delivery end-to-end when targets are
allowlisted, dashboard notifications tab (deliver/unlock/sweep actions).

MANUAL TRIGGER ONLY — there is NO automatic background recovery: both
delivery sweeps and cron schedule firings run only when invoked
(`POST /webhooks/sweep`, `POST /schedules/{id}/fire`, dashboard buttons,
or the new `nerdbot deliveries-sweep` / existing CLI). Lease recovery and
schedule firing therefore require an operator or an OS-level timer; this
is a standing limitation, not an accident. A NerdBot-internal scheduler
tick is deliberately NOT built (fleet-style automation excluded for now;
propose separately per the product-direction rules).

## Phase 5(b) — GitHub-to-run E2E (2026-10-17)

Owner-selected smallest vertical: validate the product's CENTRAL workflow
across the real system instead of adding an isolated feature.

Acceptance criteria and actual results (all from
`tests/test_e2e_github_to_run.py`; no live network — GitHub fetch uses
host-pinned `check_url` with a fake resolver plus an injected
`httpx.MockTransport`, and provider chat uses an injected `MockTransport`,
mirroring the existing test seams):

Known scope limit (review follow-up F1): the fetch leg is invoked as the
`fetch_github_issue` function rather than `POST /projects/{id}/github/preview`,
and run/retry legs use `orchestrator.schedule_run`/`retry_task` directly
rather than `POST /tasks/{id}/runs` and `POST /tasks/{id}/retry`. Those API
endpoints are thin wrappers over the same functions (error mapping for the
preview endpoint is covered in `tests/test_github_fetch.py`; a provider
run via the API route is not transport-injectable and stays a documented
limitation, not a secret gap):

1. Chain works: preview (reduced to fetch against api.github.com with the
   host-pinned `check_url` + fake resolver and injected mock transport) → `suggested_ingest` → `POST /projects/{id}/issues`
   → `POST /projects/{id}/tasks` with `issue_id` → run through the real
   OpenAI-compatible tool loop (scripted mock upstream) → run + task +
   `test-log` + `transcript` artifacts persisted with files on disk.
   ✅ `test_github_issue_to_agent_run_success`.
2. Inspectable state: `GET /tasks/{id}` returns task/runs/artifacts/issue
   with consistent linkage (issue `external_id == owner/repo#7`, one
   succeeded run, untrusted-framed output excerpt, artifact locations
   exist on disk). Dashboard already renders exactly this shape
   (`dashboard/src/views-task.tsx`, contract-tested in `api.test.ts` —
   no dashboard change needed for this slice). ✅
3. Rejected repository access (404 Not Found, 401 Bad credentials) leaves
   NOTHING ingested: empty issues list, zero tasks. ✅
4. Provider failure (upstream HTTP 500 → `ProviderProtocolError`): run
   failed + task failed + inspectable excerpt; retry adds exactly ONE new
   run on the same task and succeeds. ✅
5. Interrupted execution (crash after the persisted queued→running
   transition): app-lifespan `recover_incomplete_runs` moves the run to
   `stopped` with a `[recovered: …]` note and returns the task to
   `pending`; explicit reschedule then succeeds with exactly one new run
   — never duplicated work. ✅
6. Gates: pytest 174 passed (170 + 4 new), ruff clean, mypy strict (24
   files) clean, dashboard vitest 29 passed, `tsc --noEmit` clean. ✅

Boundary held: no new orchestration abstractions, no API/model changes —
this slice exercised existing endpoints and state machines end to end.

Real-GitHub smoke check (manual, one-off, NOT a suite gate):

    uv run python - <<'PY'
    from nerdbot.integrations.github import fetch_github_issue
    print(fetch_github_issue("owner/repo", 1))  # adapt owner/repo/number
    PY

Unauthenticated access is rate-limited by GitHub (60 req/h); to authenticate,
export a repo-scoped token and pass ``token_env="GH_TOKEN"``:

    GH_TOKEN=$GITHUB_PAT uv run python - <<'PY'
    from nerdbot.integrations.github import fetch_github_issue
    print(fetch_github_issue("owner/repo", 1, token_env="GH_TOKEN"))
    PY

SMOKE OUTCOME (2026-10-17, executed): PASSED on first attempt.
- `fetch_github_issue("psf/requests", 1)` → real api.github.com through the
  pinned transport; returned "Cookie support?", `external_id == psf/requests#1`,
  source/state/labels as expected, `authenticated == False`. Parser shape
  holds — no drift between the offline assumptions and the real service.
- Negative path: `psf/does-not-exist-zz#1` → typed `GitHubNotFoundError`,
  fail-closed as designed.
- Authenticated mode (GH_TOKEN) still unexercised — no token available; the
  documented `token_env` path remains covered by tests.

Expected: printed dict with `suggested_ingest.external_id == "owner/repo#1"`.
If the fetch raises `GitHubProtocolError`, the real HTML/JSON shape drifted
and the parser assumptions need re-verification offline first.

## Phase 5(c) — dashboard delivery-event surfacing (2026-10-17)

Smallest vertical as selected: make failed/lease-reclaimed deliveries
diagnosable from the ops dashboard, WITHOUT changing delivery semantics —
the sweep remains manual-trigger-only (this tab, `POST /webhooks/sweep`,
or the `nerdbot deliveries-sweep` CLI). No background recovery exists;
the dashboard now says so explicitly instead of implying it.

What landed:

1. `notifications.last_error` column (schema + `_PHASE9` migration following
   the `_PHASE8` per-table pattern; old-table migration test extended to
   cover the new column). Diagnostic policy: terminal/transient failures
   store a bounded (≤500 chars) typed reason ("FetchTimeoutError: …",
   host refusals included — the owner-local URL context is the diagnostic);
   success clears it; lease reclaims store why the row was requeued or
   terminally failed. No secrets exist on these paths.
2. API: no new endpoints — `GET /projects/{id}/notifications` and the sweep
   response already carry the fields; the model row gained `last_error`.
3. Dashboard:
   - Notifications tab: Next attempt + Last error columns, `locked` chip,
     `sending` badge already colorized, and the manual-trigger-only reminder
     under the sweep button.
   - Events tab: `notification` filter — `notification.delivered`,
     `notification.failed`, `notification.reclaimed` are now browsable.
4. Tests: backend transition + failure-detail tests (transient keeps reason
   and clears on success; terminal refusal records the typed reason with
   the refused host; reclaim records both branches) and dashboard contract
   tests (failure rows pass through; sweep `fired` rows with `reclaimed`;
   events filtered by `entity=notification`).
5. N2 tamper-marker regression: the `<script>` marker from the fetched issue
   is asserted to survive verbatim as inert JSON text data in the E2E success
   chain (API serves `application/json`; the dashboard has zero innerHTML
   sinks — repo-wide grep — so React text rendering is the only consumer).
6. Gates: pytest 177 passed, ruff clean, mypy strict clean, dashboard vitest
   32 passed, `tsc --noEmit` clean, eslint clean.

OpenCode review (approve-with-followups, no must-fix) — follow-ups landed: (1) redundant duplicate delivery write removed
from the transient branch (F1); (2) `sweepWebhooks` contract typed so
`reclaimed`/`error` passthrough is compile-enforced, not mock-only (F2); (3)
the zero-innerHTML-sinks guarantee is now suite-enforced via
`dashboard/src/source.test.ts` (+ the `@types/node` devDependency it needs)
instead of a manual grep (F3); the transient-failure test asserts the exact
deterministic upstream message (N1). Deferred as cosmetic polish, not
residual risk: relative formatting/truncation styling for `next_attempt_at`
and `last_error` cells (F4, N2-b). Note (recorded, not rewritten): fb6d181's
commit message cites the contract tests and 32-count vitest gates that
physically landed in d4c6c01 after a missed git add.

## Milestones (updated)

- [x] Phase 0 — baseline checkpoint (`63ef83c`), provenance, gates green.
- [x] Phase 1 — real provider execution + minimal tool-call loop (`82edd35`, ADR 0005).
- [x] Phase 2 — personal-use security: credential encryption, approval hygiene,
  manifest import (`cfea25d`, `9b35cd8`, ADR 0006).
- [x] Phase 3 — web research with SSRF hardening (fetch + transport pinning +
  wall-clock budgets; credential-free DuckDuckGo Lite search via `search.py`;
  post-review fixes applied — see ADR 0007 item 7; DNS-time residual documented).
- [x] Phase 4 — durable integrations: GitHub fetch + outbox delivery + webhook-out
  channel (all three implemented, tested, reviewed; the four-state table below
  records what is operationally enabled vs manual. Marked here with the
  verification that happened alongside the ops slice `ed1292c`, not from the
  Phase 5(b) diff itself).
- [x] Phase 5(b) — GitHub ingest → task → run end-to-end validation: full central
  workflow chained across API → execution → persistence → inspectable state
  (`tests/test_e2e_github_to_run.py`, 4 scenarios: success, invalid repository
  access, provider failure, interrupted-execution recovery). All external
  network mocked; the real-GitHub smoke check remains a documented manual step
  (below), not a suite gate.
- [x] Phase 5(c) — dashboard delivery-event surfacing: `last_error` diagnostics,
  `locked` chip, next-attempt and events filtering (`notifications` entity in
  the events feed); manual-trigger-only sweep semantics stated explicitly in
  the UI, never implied as background recovery (see the Phase 5(c) section).
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

- Milestone: Phase 4 durable integrations shipped and reviewed; ops CLI
  (`nerdbot deliveries-sweep`) closes the manual-trigger gap for the outbox.
- Token hygiene scope: approval tokens expire/are one-use/purged; bearer-token
  rotation explicitly cut (capability `auth.token-rotation: deferred`).
- Keyless mode: local-dev without a key supports non-secret configs only.
- Blockers: none. Dev-default bearer token still accepted (explicit follow-up,
  unchanged). Delivery recovery is trigger-only (see operational state above).
- Next action: Phase 5(b)/5(c) shipped and documented. The live-GitHub smoke
  check (procedure in the 5(b) section) remains outstanding — run it with the
  documented procedure before relying on real fetch. Owner selects the next
  vertical; fleet-of-bots design (isolation, delegation, memory, scheduling
  acceptance criteria) is a separate proposal, not this roadmap.

## Product standing (2026-10-17, three definitions of complete)

IMPLEMENTATION COMPLETE: yes — all currently scoped milestones (Phase 0–4,
5(b), 5(c), N2) implemented, tested, reviewed. Gates at 7ae4bf8: pytest 177,
vitest 33, ruff/mypy strict/tsc/eslint clean.

OPERATIONALLY VERIFIED: now yes for GitHub fetch (live smoke passed 2026-10-17
above; negative path fail-closed confirmed). Still NOT verified live:
webhook-out against a real receiver, authenticated GitHub mode, and a real
model provider run — each needs owner-controlled credentials/endpoints.

PRODUCT COMPLETE: owner decision. Against the ORIGINAL vision (fleet of bots
with per-bot Docker sandboxes, persistent memory, delegation, scheduling),
NerdBot is deliberately NOT feature-complete — those were explicitly descope-,
and fleet design is a separate proposal. Against "single-user personal
assistant workspace", the remaining productionization checklist is below.

Before calling the current scope usable-for-daily-duty (owner checklist):
1. [x] Remote + push: `origin = https://github.com/NalinDalal/nerdbot.git`
   (2026-10-17; main and origin/main verified identical at `97a432e`,
   later CODE/doc commits pushed as they land).
2. [x] Dev-default bearer token DECIDED + shipped fail-closed
   (2026-10-17): the well-known `dev-token-change-me` token is valid ONLY
   with explicit `NERDBOT_INSECURE_DEV_TOKEN=1`; a server with neither
   `NERDBOT_TOKEN` nor the opt-in rejects every request with 503 instead
   of silently serving a public secret. Tri-state `token_status()`
   (configured/dev/closed); CLI warns at startup; 5 policy tests
   (`tests/test_auth_policy.py`).
3. [x] OS cron wired for delivery recovery (2026-10-17):
   `*/15 * * * *` runs `nerdbot deliveries-sweep --quiet`, appending to
   `.nerdbot-data/sweep.log`; manual verification run exited 0 with
   "0 deliveries, 0 failed". Removal: `crontab -e` and delete the line.
   Caveat: if macOS denies execution (Full Disk Access prompt), switch
   the same line to a launchd timer.
4. [x] Live webhook-out against a real internet receiver (2026-10-17):
   delivered to webhook.site (uuid cb9ceff6-0b3c…); the receiver logged
   the POST with `X-Idempotency-Key: ntf_3a48fedc9645` and the exact
   payload body — transport, allowlist, idempotency, status all true
   end-to-end. First listing lagged; confirmed on a plain re-read.
5. [x] Real provider + real tool loop (2026-10-17): local Ollama
   (`http://127.0.0.1:11434/v1`, `llama3.2:3b`) executed a task through
   `resolve_run_provider`; transcript shows the REAL model emitting a
   `run_command` tool call whose subprocess genuinely produced
   `nerdbot-live-provider-check`, then a second turn: 2 turns, run
   succeeded, test-log PASSED + transcript artifact persisted. The final
   assistant message was empty (3B model verbosity quirk), so a larger
   model is the Everyday driver — the loop itself is verified.

Nothing from this checklist remains. Known Accepted Residuals
(documented, not scheduled): schedules' due-firing stays trigger-only
(same OS-cron pattern applies if ever wanted); email/Slack channels are
stubs (webhook-out is the real channel); DNS time sits outside the fetch
wall-clock budget; octop-review cosmetics (F4/N2-b) deferred.

Backup taken 2026-10-17: `~/nerdbot-backups/` holds a git bundle + source
tar of NerdBot @ 7ae4bf8, and read-only preservation bundles of
ai-teammates (6bea24c), octop (ecec9f70), odysseus (c3819e3c). See
`~/nerdbot-backups/MANIFEST.txt`. Nothing deleted; elimination decisions
and pushes remain with the owner per the standing direction.
