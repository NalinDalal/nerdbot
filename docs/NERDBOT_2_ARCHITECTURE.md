# Nerdbot 2.0 Architecture

**Status**: Stage 0 baseline (2026-04-10, `main@964476b`, branch `nerdbot-2.0/transformation`)  
**Method**: Source-inspected baseline. No wholesale rewrite; extend existing FastAPI + SQLite WAL + React/Vite/TS/Tailwind system.

## 1. Product direction

**Principle**: The user manages outcomes. Nerdbot manages execution.

Nerdbot 2.0 combines an outcome-first workspace with a persistent, bounded autonomous agent runtime. Existing task/run/approval/permission/provider/workspace/memory infrastructure is preserved and extended.

## 2. Current architecture (verified)

```text
Dashboard (React/Vite/TS/Tailwind)
  -> HTTP + SSE (/api)
FastAPI api.py (~255 routes)
  -> auth.principal_from_header (single bearer principal)
  -> gates/permissions (fail-closed agent/admin/external checks)
  -> workspace.py (confined files/git/exec, audit, approvals, snapshots)
  -> chat.py + providers.py (OpenAI-compatible bounded tool loop)
  -> app_tools.py (permission-gated tool schemas/execution)
  -> orchestrator.py (task/run lifecycle, retries, approvals, artifacts)
  -> executor.py (sweep claim + fire_due + approval recovery)
  -> schedules.py / routines.py (cron/presets; routines opt-in)
  -> knowledge.py / library.py / memory/persona in store.py
  -> search.py / fetch.py / notify.py / integrations/github
SQLite WAL store.py/models.py
  -> /app/.nerdbot-data (Docker named volume)
```

### Key modules

| Area | Primary files | Current role |
|---|---|---|
| API/Auth | `backend/src/nerdbot/api.py`, `auth.py` | Route surface, SSE, single-principal bearer auth, docs gating |
| Domain/Store | `models.py`, `store.py` | SQLite schema, repositories, migrations, audit/events |
| Agent context | `chat.py`, `agent_context.py`, `persona.py`, `app_tools.py` | Prompt assembly, tool loop, scoped memory/skills/inbox |
| Execution | `orchestrator.py`, `runtime.py`, `providers.py`, `run_events.py` | Task/run execution, local/docker hooks, provider adapters, durable run events |
| Background | `executor.py`, `schedules.py`, `routines.py`, `approval_flow.py` | Sweep claiming, due schedule/reminder fire, opt-in routines, approval resume |
| Workspace | `workspace.py` | Confined gateway, permissions, approvals, snapshots, audit |
| Knowledge/Memory | `knowledge.py`, `library.py`, `memory/persona in store/chat` | Chunked overlap retrieval, library ACL/taint, memory tiers/provenance |
| Integrations | `search.py`, `fetch.py`, `notify.py`, `integrations/github.py`, `capabilities.py` | Search/fetch, outbox/webhook-out, GitHub fetch, capability registry |
| UI | `dashboard/src/app.tsx`, `router.ts`, `views-*`, `api.ts` | Workspace-first shell present; advanced/admin surfaces still large |

## 3. Verified capability matrix (Stage 0)

| Capability | Status | Evidence | 2.0 gap |
|---|---|---|---|
| Task/run lifecycle, dependencies, retries, cancel | Implemented | `models.py`, `orchestrator.py`, `store.py` | Add leases/watchdog/idempotent recovery metadata |
| Approvals/checkpoints/gates | Implemented | `gates.py`, `permissions.py`, `approval_flow.py`, `store.py` | Central policy evaluator; approval-before-execution contract; expiry/revocation audit |
| Workspace gateway | Implemented | `workspace.py`, tests | Stronger sandbox policy for autonomous mode; egress/taint integration |
| Provider routing/fallback | Implemented | `providers.py`, `store.py`, `chat.py` | Runtime supervisor health/backoff/quarantine |
| Memory/knowledge/library | Partial-strong | `knowledge.py`, `library.py`, `persona.py`, `store.py` | Reflection jobs, dedupe/conflict/decay, trust-aware promotion |
| Schedules/reminders | Implemented | `schedules.py`, executor sweep, API | Unify into durable intent/wakeup queue |
| Routines/proactive triggers | Partial/opt-in | `routines.py`, `NERDBOT_ROUTINES=1` | Default-safe policy-driven supervisor; better trigger coverage/visibility |
| Browser/WebMCP/computer | Stub/minimal | `capabilities.py` browser stub; search/fetch only | New isolated browser service, WebMCP tools, audit/taint/approvals |
| External comms | Partial/stubbed | `notify.py`, webhooks, GitHub; email/slack stubs | Real adapters, idempotent inbound routing, delivery receipts/dead-letter |
| Self-evaluation | Missing | tests only | Capability probes, reports, quarantine, CLI/API/schedule |
| UI outcome-first workspace | Partial | workspace shell exists; many internal views exposed | Redesign IA around Overview/Work/Chat/Library/Agents; progressive disclosure |
| Observability/hardening | Partial | run events, audit, redaction, SSRF guards | metrics/tracing/alerts, backup restore drills, stronger auth/rotation path |

## 4. Nerdbot 2.0 target architecture

```text
                        +-------------------------------+
                        | Agent Supervisor              |
                        | heartbeats | leases | queue   |
                        | recovery | pause/resume/stop  |
                        +---------------+---------------+
                                        |
        +-------------------------------+-------------------------------+
        |                               |                               |
+-------v--------+             +--------v---------+             +-------v--------+
| Autonomy/Policy|             | Tool Runtime     |             | Event/Comms    |
| risk/budgets   |<----------->| workspace/browser|<----------->| webhook/slack/ |
| approvals      |             | webmcp/computer  |             | email/github   |
| decision log   |             | search/fetch     |             | notifications  |
+-------+--------+             +--------+---------+             +-------+--------+
        |                               |                               |
        +-------------------------------+-------------------------------+
                                        |
                        +---------------v---------------+
                        | State, Memory, Observability  |
                        | tasks/runs/approvals/events   |
                        | memory/knowledge/library      |
                        | capability eval reports        |
                        | audit/metrics/traces/backups  |
                        +---------------+---------------+
                                        |
                               SQLite WAL (now) + Postgres path later
```

## 5. Architectural constraints

- **Preserve**: task/run lifecycle, approval digest/checkpoint model, permission gates, provider routing/fallback, workspace gateway, memory/knowledge/library models, audit logs, SQLite deployment.
- **No wholesale rewrite**. No unnecessary DB migration. No invented API contracts. No fake integrations/autonomy.
- **Additive evolution**: new tables/columns/endpoints behind compatible defaults; existing tests must keep passing.
- **Security boundary**: LLM output never overrides policy engine; high-risk/external side effects require approval immediately before execution.

## 6. Stage 0 gaps to close first

1. Durable supervisor state (agent heartbeat, intent/wakeup, lease/claim idempotency).
2. Central autonomy policy evaluator and decision log.
3. Browser/WebMCP capability contract + isolated execution model.
4. Integration adapter contract with idempotent inbound/outbound delivery.
5. Reflection and self-evaluation jobs/reports.
6. Outcome-first UI IA and progressive disclosure.
7. Observability/security/recovery verification.
