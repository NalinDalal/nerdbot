# Phase 2 Architecture — Persistent Teammates, Restart-Safe Orchestration

Builds on `docs/ARCHITECTURE.md` (Phase 1 seams unchanged). Module flow stays
`api -> orchestrator -> store -> runtime adapter`.

## State machines

Task: `pending → ready | running | blocked`, `ready → running | blocked | pending`,
`running → done | failed | blocked | pending` (pending only via recovery),
`blocked | failed | done → pending` (retry requeue only).

Run: `queued → running | blocked | failed | stopped`,
`running → succeeded | failed | blocked | stopped`.
Terminal: `succeeded, failed, blocked, stopped` — immutable afterwards.
(`succeeded` is the stored form of brief-level `completed`.)

Retry: allowed only from terminal task states; always a new run row on the
same task; `runs` history is append-only.

## Persistence

SQLite (WAL) file from `NERDBOT_DB`. Fresh schema + idempotent `_migrate()`
for Phase 1 files. All state changes commit synchronously; events are rows
in the same database (no separate log to lose).

## Restart / recovery

- Steady state (task/run/artifact/memory/teammate rows) survives restarts by
  construction — verified by close/reopen tests.
- `recover_incomplete_runs()` runs on app startup (lifespan) and is directly
  callable: `queued` runs stay startable, orphaned `running` runs → `stopped`
  + note, owner tasks with no active run → `pending`. Creates zero rows
  besides the audit events.
- Workspaces (`NERDBOT_DATA/workspaces/<task_id>/`) survive restarts;
  explicit deletion only.

## Approvals

`request_approval(run, action, requester, ttl_s=600)` → `expires_at`.
`decide_approval` enforces one-use (`consumed_at`, 409 on repeat) and expiry
(410 past `expires_at`). Request/decision both emit events.

## Ownership and auth

Bearer token (`NERDBOT_TOKEN`); missing → 401, wrong → 403. Every route
resolves the project (directly or via task→project / run→task→project /
artifact→task→project) and enforces owner equality. Memory has global
(auth-only) routes plus owner-pinned `project:{id}` routes.

## Teammates

Durable rows: persona, instructions, capabilities, memory scope, permissions,
`tool_policy`, `status` (active/disabled/archived, archived terminal).
Disabled/archived teammates keep history but take no new work.
