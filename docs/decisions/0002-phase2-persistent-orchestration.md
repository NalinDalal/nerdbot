# 0002 — Persistent Teammates and Restart-Safe Orchestration (Phase 2)

Date: 2026-10-16. Status: accepted.

## Context

Phase 1 proved one project → teammate → task → run → artifact through the
local runtime adapter, but left gaps: teammates were create-only, run
`running` was never persisted, a crash mid-run left ambiguous state,
approvals had no expiry or one-use rule, and most transitions emitted no
audit event.

## Decisions

1. **Single SQLite store, explicit migrations.** New columns (`teammates.status`,
   `teammates.tool_policy`, `approvals.expires_at/consumed_at`) ship in the
   fresh schema; `_migrate()` adds them idempotently to Phase 1 databases.
   No PostgreSQL in this phase.
2. **Deterministic state machines in `store`, enforced at write time.**
   `TASK_TRANSITIONS` / `RUN_TRANSITIONS`; terminal runs are immutable
   (`TerminalRunError`); retry is allowed only from terminal task states and
   always creates a new run. Stored run terminal state is `succeeded`
   (= the `completed` of the phase brief; kept for Phase 1 compatibility).
3. **Crash recovery without duplication.** `schedule_run` persists
   `queued → running` before executing. `recover_incomplete_runs()` (also
   wired to app startup via lifespan) moves orphaned `running` runs to
   `stopped` with an explicit note, returns their tasks to `pending`, and
   creates nothing — completed runs are never duplicated.
4. **Approvals are one-use with expiry.** Default TTL 600s; deciding twice →
   409, deciding after expiry → 410, unknown run → 404.
5. **Teammate lifecycle:** active → disabled → archived; archived is terminal
   (no reactivation). Only active teammates accept new task ownership;
   existing assignments are stable. Archived/disabled is enforced in
   `assign_task_owner` and `schedule_run` (blocked run + event).
6. **Dependency cycles rejected** at update time via DFS (`task.dependencies_updated`;
   self-dependency included).
7. **Events on every state change** (`task.status.*`, `run.status.*`,
   `teammate.*`, `approval.*`, `artifact.created`, `workspace.cleaned`,
   `memory.stored` for project scopes), each carrying project + entity +
   event type.
8. **Workspaces persist across restarts** for evidence; removal is explicit
   only (`DELETE /tasks/{id}/workspace` → `workspace.cleaned`).
9. **Lint lessons recorded:** `SIM118` is a false positive on `sqlite3.Row`
   (`in` tests values, so `.keys()` is required — a blind fix broke
   status/expiry reads and was caught by tests); FastAPI `Depends()` in
   defaults is idiomatic (`B008` ignored for `api.py`); request models must
   live at module level (`MemoryBody` inside `create_app` produced 422s).

## Consequences

- `GET /projects/{id}/runs`, `GET /runs/{id}`, `GET /artifacts/{id}`,
  teammate get/list/update/disable/archive, task assign/patch, run approval
  listing, project-scoped memory, workspace deletion, and filtered events
  are all owner-checked.
- Package split of flat modules remains deferred (see 0001).
