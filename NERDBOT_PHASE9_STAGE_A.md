# Nerdbot — Phase 9 Stage A: Execution Reliability & Recovery — Audit & Plan

**Status:** Audit and plan only. No source modified. Awaiting approval before implementation.

---

## 1. Existing Execution & Recovery Implementation

### Entry points
- Synchronous: `POST /tasks/{id}/runs` → `orchestrator.schedule_run` (runs in-process, blocks HTTP).
- Asynchronous: `POST /tasks/{id}/runs/async` → starts run, returns immediately; workbench polls/SSE.
- Executor sweep: `POST /executor/sweep` or `NERDBOT_EXECUTOR=1` loop → `executor.sweep` claims pending unowned tasks to available bots.
- Retry: `POST /tasks/{id}/retry` → `orchestrator.retry_task` (new run, never new task).
- Cancel: `POST /runs/{id}/cancel` → `request_run_cancel` (process group kill).

### Recovery on startup
- `orchestrator.recover_incomplete_runs(conn)` on lifespan: running runs → stopped with recovery note; owning tasks left running with no active run → pending.
- `recover_docker_runs(conn)` for docker runtime.
- Approval recovery: `approval_flow.recover(conn)` settles runs waiting on approvals.

### Live progress
- SSE: `GET /runs/{id}/events/stream` (replays durable log from `after`, closes on terminal).
- Polling fallback: 2s in dashboard TaskDetailView.

### Idempotency
- `retry_task` creates a new run (not a new task) — correct.
- `create_run` + `mark_run_running` persist queued→running before execution.
- Cancel is idempotent (cancel token).

---

## 2. Identified Execution Reliability Gaps

| # | Gap | Severity | Evidence |
|---|---|---|---|
| 1 | **No retry with backoff for transient provider errors (429/5xx)**. A rate-limited run fails immediately; user must manually retry. | Medium | Live smoke test (Stage F) — task 3/4 failed on 429. |
| 2 | **No pause/resume for runs** — only cancel. Long tasks can't be suspended. | Medium | `runtime.py` has no pause; `cancel` only. |
| 3 | **Run timeout default 60s** (`NERDBOT_RUN_TIMEOUT_S`). Slow providers/local models fail. | Low (configurable) | `executor._run_timeout_s`, `orchestrator.schedule_run`. |
| 4 | **Executor sweep only claims unowned tasks**. Owned tasks that fail stay failed; no auto-retry. | Medium | `executor.sweep` claims pending unowned only. |
| 5 | **No max-retry cap / circuit breaker**. A failing task can be retried indefinitely. | Low | `retry_task` has no attempt limit. |
| 6 | **Approval recovery crash window**: a decision that lands but the resume crashes leaves the run in `awaiting_approval` or `resumed` without settling. `approval_flow.recover` handles it, but only on startup/sweep. | Medium | `store.list_approvals_needing_recovery`, `approval_flow.recover`. |
| 7 | **Docker runtime requires digest-pinned image**; if misconfigured, runs fail with "Docker runtime requires a digest-pinned image". | Low (config) | `DockerRuntimeAdapter.start_run`. |
| 8 | **No health check for provider before claiming** beyond `provider_block_reason` (key presence). A provider with a bad key blocks the task but the message may be cryptic. | Low | `providers.provider_block_reason`. |
| 9 | **SSE stream reconnect**: dashboard falls back to polling; no automatic SSE reconnect with backoff. | Low | `TaskDetailView` uses `streamRunEvents` then polling. |
| 10 | **No execution queue visibility**: queued tasks count only; no position/ETA. | Low | `WorkspaceSummary.queuedTasks` is a count. |
| 11 | **Task status can drift** if a run finishes but the task status update fails (crash between). Recovery handles running→pending but not all transitions. | Medium | `recover_incomplete_runs` only handles RUNNING runs. |
| 12 | **No provider rate-limit backoff** in the agent loop: a 429 aborts the whole task. | Medium | `providers.OpenAICompatibleAdapter` raises `ProviderRateLimitError`. |

---

## 3. Implementation Plan (Stage A)

### A.1 Retry with exponential backoff for transient errors (Medium)
- In `orchestrator.schedule_run` / agent loop, catch `ProviderRateLimitError` and `ProviderNetworkError`, retry up to N times with exponential backoff (configurable, default 3, max 30s).
- Record each attempt as a run event (`run.provider.retry`).
- Surface retry count in run output.
- **Files:** `providers.py` (agent loop), `orchestrator.py` (schedule_run), `store.py` (run events already exist).
- **Tests:** unit test for backoff, integration test for 429 retry.

### A.2 Pause/resume for runs (Medium–High)
- Add `POST /runs/{id}/pause` and `POST /runs/{id}/resume` endpoints.
- `CancelToken` already supports cancellation; add a `paused` flag checked in the agent loop between turns (sleep/poll).
- Persist pause state in `runs` table (new column `paused_at`, or reuse status `paused`).
- **Migration:** add `paused` to RunStatus enum + DB column (migration needed).
- **Files:** `models.py`, `store.py`, `runtime.py`, `orchestrator.py`, `api.py`, `providers.py`.
- **Tests:** pause/resume integration test.

### A.3 Auto-retry for failed tasks in executor sweep (Low–Medium)
- In `executor.sweep`, before claiming, check if task has a recent failed run with a transient error; if so, retry (up to max attempts) instead of skipping.
- Add `retry_count` to task or run; cap at configurable max (default 3).
- **Files:** `executor.py`, `store.py` (retry_count column or derive from runs).
- **Tests:** sweep retry test.

### A.4 Max-retry cap (Low)
- In `retry_task`, check attempt count; refuse if exceeded (return 409 or block).
- **Files:** `orchestrator.retry_task`, `api.py`.
- **Tests:** retry cap test.

### A.5 Approval recovery on demand (Low)
- Add `POST /approvals/recover` (already exists as `/approvals/sweep`? check) or expose existing `approval_flow.recover` via an endpoint.
- Actually `POST /approvals/sweep` and `POST /webhooks/sweep` exist. Surface in UI as "Recover" button in Activity.
- **Files:** `api.py` (already), `views-work.tsx` (add button).

### A.6 Provider health pre-check (Low)
- Before claiming a task, call `provider_health` or a lightweight check; if unhealthy, block with clear message.
- **Files:** `executor._available_bot`, `providers.provider_block_reason`.

### A.7 SSE reconnect with backoff (Low)
- In `TaskDetailView`, on SSE failure, retry with exponential backoff (max 3) before falling back to polling.
- **Files:** `views-task.tsx`, `api.ts` `streamRunEvents`.

### A.8 Queue visibility (Low)
- Add queue position to `WorkspaceSummary` (derive from pending tasks ordered by created_at).
- **Files:** `views-home.tsx` `summarize`, `WorkspaceSummary`.

---

## 4. Affected Files & APIs

**Backend:** `providers.py`, `orchestrator.py`, `executor.py`, `runtime.py`, `models.py`, `store.py`, `api.py`, `approval_flow.py`.
**Frontend:** `views-task.tsx`, `views-work.tsx`, `views-home.tsx`, `api.ts`.
**Tests:** `tests/test_run_timeout_knob.py`, `tests/test_run_cancellation.py`, `tests/test_run_event_stream.py`, `tests/test_provider_agent_loop.py`, new tests.

---

## 5. Test Strategy

- Unit: backoff logic, pause/resume state machine, retry cap, provider health check.
- Integration: 429 retry end-to-end (mock provider returning 429 then 200), pause/resume run, recovery after process kill (existing `live_cancel_check.py` pattern).
- Regression: full pytest suite must pass.

---

## 6. Risks & Tradeoffs

- Pause/resume requires DB migration (new column). Backward-compatible if nullable.
- Auto-retry could mask persistent failures; cap + clear logging needed.
- Backoff delays increase run time; must respect wall-clock budget.
- SSE reconnect adds complexity; polling fallback already exists.

---

## 7. Open Questions

1. Should pause/resume be P0 or P1? (Recommend P1 — cancel + retry covers most cases.)
2. Auto-retry default: on or off? (Recommend off by default, opt-in via env, to avoid masking failures.)
3. Max retry attempts: 3 (configurable).

---

*Audit and plan only. No source modified. Awaiting approval before implementation.*
