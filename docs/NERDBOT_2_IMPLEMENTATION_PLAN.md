# Nerdbot 2.0 Implementation Plan

**Status**: Stage 0 baseline plan (2026-04-10). This is an execution plan; implementation proceeds in staged commits on `nerdbot-2.0/transformation`.

## 0. Baseline (completed)

- [x] Inspect repo/branch/working tree (`main@964476b`, clean; branch created).
- [x] Run existing backend tests: `43 passed, 1 warning` with `.venv/bin/python -m pytest -q`.
- [x] Inspect architecture, routes, models, executor/orchestrator, workspace/gates, capabilities, UI routes.
- [x] Inspect local skillset (`~/skillset`, 128 skills; required skills present).
- [ ] Frontend typecheck/build baseline (run before UI changes).
- [ ] Create initial Nerdbot 2.0 docs set.

## 1. Delivery sequence

| Stage | Goal | Depends on | Exit criteria |
|---|---|---|---|
| 0 | Baseline audit + docs + branch | none | docs committed, baseline tests recorded |
| 1 | Persistent agent runtime | 0 | durable intents/heartbeats/leases/recovery tests pass |
| 2 | Autonomy policy engine | 1 | deterministic policy matrix + approval recheck tests pass |
| 3 | Browser/WebMCP/computer | 2 | isolated browser/WebMCP MVP, audits, permission tests |
| 4 | Integrations/comms | 2 | adapter contract + webhook/email/slack or safe stubs with receipts/idempotency |
| 5 | Memory/reflection | 1,2 | reflection jobs, provenance/taint, dedupe/conflict tests |
| 6 | Self-evaluation | 1-5 | capability probes/report CLI/API/UI; failing capability reported |
| 7 | Workspace UI transformation | 1-6 APIs stable | outcome-first IA, responsive/a11y/build/e2e checks |
| 8 | Hardening/release | all | failure scenarios, security/recovery/backup verification, release report |

## 2. Workstream plan

### A. Persistent autonomous agent runtime

**Files**: `executor.py`, `orchestrator.py`, `run_events.py`, `store.py`, `models.py`, `api.py`, `cli/main.py`, `routines.py`, `schedules.py`, new `supervisor.py`.

- Add durable tables/models: `agent_heartbeats`, `agent_intents`/wakeups, execution leases/claims, supervisor events.
- Implement supervisor loop: claim intents idempotently, heartbeat, lease renewal/expiry, stalled-run detection, controlled retry/backoff, pause/resume/stop.
- Unify wakeups: user request, assigned task, schedule, reminder, routine, webhook event, delegation, relevant workspace event.
- Reuse task/run lifecycle; no second competing execution engine.
- Recovery: restart-safe; no duplicate external side effects; approval recovery preserved.
- API/UI: agent runtime status, queue visibility, last heartbeat, pause/resume controls.

### B. Autonomy and decision engine

**Files**: `gates.py`, `permissions.py`, `approval_flow.py`, `app_tools.py`, `agent_context.py`, `decomposition.py`, `delegation.py`, `models.py`, `store.py`, new `autonomy/policy.py`.

- Central `PolicyEvaluator` with outcomes allow/require_approval/ask_user/defer/escalate/deny.
- Enforce autonomy levels from teammate config; remove decorative behavior.
- Risk classification, budgets/rate limits, decision logging, approval digest recheck immediately before execution.
- Goal/objective tracking and prioritization metadata; dependency-aware deferral.
- Policy test matrix covering all mandatory action categories.

### C. Browser, WebMCP, computer capabilities

**Files**: `capabilities.py`, `app_tools.py`, `workspace.py`, new `browser/`, `webmcp/`, `api.py`, dashboard WebMCP bridge.

- Isolated browser sessions (profile/container), navigation/DOM/a11y snapshot/screenshot/form/click/type/download/upload where authorized.
- WebMCP tool registry for Nerdbot dashboard: inspect_current_view/list_navigation/inspect_component/inspect_agent_status/inspect_capabilities/inspect_workspace_state/inspect_task_state/inspect_errors/inspect_responsive_state; mutating tools authorization-gated.
- Browser/computer actions permissioned, audited, taint-propagated, secret-isolated.
- No cookies/passwords/API keys in model context.

### D. Integrations and communication

**Files**: `notify.py`, `integrations/*`, `api.py`, `store.py`, `models.py`, new adapter interfaces.

- Adapter contract: inbound verify/idempotency/route, outbound approve/policy/send/receipt/retry/dead-letter.
- Complete webhooks first; add Slack/email/Telegram only with real auth/config and tests, else keep explicit stub status.
- Event-to-task routing; delivery history in UI.

### E. Memory and continuous reflection

**Files**: `persona.py`, `store.py`, `knowledge.py`, `library.py`, `agent_context.py`, `chat.py`, new `reflection.py`.

- Capture->Curate->Index->Retrieve->Reflect lifecycle.
- Scheduled reflection jobs with provenance; dedupe/conflict/expiry/decay; correction/deletion workflows.
- Trust/taint checks: untrusted content never silently promoted.
- Optional embeddings only behind flag if justified; lexical overlap remains default.

### F. Self-evaluation

**Files**: new `self_eval.py`, `capabilities.py`, `cli/main.py`, `api.py`, dashboard view, tests.

- Probes: provider, workspace, search/fetch, browser, WebMCP, integrations, memory, runtime/queue, recovery.
- Structured report: capability/status/evidence/failure/impact/remediation/last_success.
- CLI/API/scheduled; failing capability quarantined/reported, never marked healthy by prose.

### G. Workspace-first UI transformation

**Files**: `dashboard/src/app.tsx`, `router.ts`, `views-home-overview.tsx`, `views-work*.tsx`, `views-chat.tsx`, `views-library.tsx`, `views-bot*.tsx`, components/styles/api/types.

- Primary nav in workspace: Overview, Work, Chat, Library, Agents; advanced secondary/contextual.
- Overview answers happening/completed/needs attention/blocked/decisions/deliverables/next.
- Work detail outcome-first; raw logs/events progressive.
- Agent profiles as collaborators with controls/capabilities/history.
- Workbench as optional Code mode; keep accessible.
- Use real API contracts; no invented fields/demo data.

### H. Production hardening and release

**Files**: auth/runtime/store/api/docker/docs/tests/CI.

- Retry/backoff caps, idempotency, SSE reconnect, lease expiry, approval recovery.
- Auth fail-closed, token rotation path, secret redaction, SSRF/egress, workspace confinement, prompt-injection/taint.
- Structured logs/metrics/traces hooks; backup/restore verification.
- No Postgres/multi-user migration unless justified; document recommendation.

## 3. Test plan

- Baseline: existing pytest + dashboard tsc/build.
- TDD for new policy/runtime/recovery/idempotency logic.
- Add unit/integration/security/frontend/e2e per `docs/NERDBOT_2_TEST_REPORT.md`.
- Critical failure scenarios 1-12 from master prompt executed before release.

## 4. Risks / conservative defaults

- Missing external credentials/browser infra: implement safe interfaces, feature flags, and explicit stub reporting.
- No destructive git reset; no secret exposure.
- If blocked, document blocker and continue independent work.
