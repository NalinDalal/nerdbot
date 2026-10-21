# Increment E + Phase 9 — Acceptance Report (2026-10-21)

Scope: the audit's **E1** (board-membership gate + shell-tool policy) and
**E2** (mid-flight run cancellation), then the end-to-end verification pass.
The audit's **E3** (Pydantic request models, `busy_timeout`, route tests for
untested endpoints) stays deferred, as the audit itself scheduled.

Everything below was executed against the real code in this repository. The
live cancellation check ran against a real `uvicorn` server with a real
subprocess and a real process-group kill — not a mock.

## 1. Verification gates (all green)

| Gate | Command | Result |
|---|---|---|
| Backend tests | `.venv/bin/python -m pytest -q` | **372 passed** (baseline 351 → +21) |
| Lint | `.venv/bin/python -m ruff check .` | clean |
| Types | `.venv/bin/python -m mypy` | clean, 33 source files |
| Dashboard types | `npx tsc --noEmit` | clean |
| Dashboard lint | `npx eslint src --max-warnings 0` | clean |
| Dashboard tests | `npx vitest run` | **50 passed** (5 files) |
| Dashboard build | `npx vite build` | OK — 447.35 kB JS / 122.56 kB gzip, 24.91 kB CSS |
| Live cancellation | `.venv/bin/python scripts/live_cancel_check.py` | **PASS** |

## 2. E1 — board membership is approval-gated

**What changed.** `add_board_member_service` and `remove_board_member_service`
(`backend/src/nerdbot/boards.py:193`, `:223`) now call
`gates.require(conn, acting, "teammate.create", payload=...)` after
`authorize_board`, and translate the gate exceptions through the shared
`gates.wrap_gate_error` (403 when the permission is absent, 409 with the
pending approval when a human decision is needed).

The digest binds the exact `(board_id, teammate_id, role, op)` tuple, so:

- an approval for one teammate does not cover another;
- an approval for one role does not cover another role;
- an approval to **add** a member does not authorize **removing** it;
- each approval is consumed on use (one-use, as everywhere else).

The human owner path (`acting is None`) is never gated.

**Evidence** — `tests/test_board_member_gates.py` (9 tests):

| Test | Asserts |
|---|---|
| `test_board_member_add_requires_approval_for_bot` | bot add → 409 + pending approval; after approval the call succeeds and the roster shows the member |
| `test_board_member_remove_requires_approval_for_bot` | same flow for removal |
| `test_board_member_change_denied_without_permission` | a bot without `teammate.create` gets 403 and no approval is created |
| `test_board_member_add_untouched_for_owner` | the owner path is not gated |
| `test_approval_does_not_transfer_to_another_teammate` | digest is teammate-specific |
| `test_approval_does_not_transfer_to_a_different_role` | digest is role-specific |
| `test_add_approval_does_not_authorize_a_removal` | digest is operation-specific |
| `test_approval_is_single_use` | a spent approval asks again |
| `test_board_member_add_denied_without_permission_creates_no_approval` | a denial leaves no pending row behind |

## 3. E2 — the shell-tool approval policy is decided and written down

**What changed.** New ADR `docs/decisions/0009-shell-tool-approval-policy.md`
(following the `docs/decisions/000N-slug.md` convention: title, date/status,
Context, Decisions, Consequences).

**The decision.** The shell is deliberately *outside* the digest-bound
approval gate. The rule now stated in the product: *if the action changes
who may do what, it is approval-gated; if the action only works inside an
already-authorized run, it is not.* The ADR records the two rejected
alternatives (per-command approval: an agent loop would stall on its first
tool call; a `shell.exec` permission: it would gate the visible half of the
hole while the task command still reached `sh -c`, and a permission is not a
sandbox) and names the six controls that bound the shell instead — run
boundary, workspace boundary, deny-list, secret hygiene, bounded execution,
and stoppability.

It also states what is **not** claimed: the shell is not sandboxed, the
deny-list is not an allow-list, and a project is a workspace, not a security
boundary. The trigger that voids the decision (bot authors the owner does
not control) and the shape of the tier that would replace it (`tool_policy`
trust tier) are written down, so the gap is a decision with a trigger rather
than an oversight.

**Evidence.** The two secret-hygiene claims the ADR makes are now pinned by
tests that did not exist before: `test_run_command_never_exports_server_secrets`
and `test_run_command_scrubs_secrets_from_output`
(`tests/test_agent_tools.py`).

## 4. E2 (audit) — mid-flight run cancellation

**What changed.**

| Layer | Change |
|---|---|
| `runtime.py` | `subprocess.run` → `subprocess.Popen` with `start_new_session=True`; the adapter polls the child; on cancel it calls `os.killpg` (SIGTERM → grace → SIGKILL) on the whole **process group**; `CancelToken`, `RunCancelled` (carries the partial output), and a live-run registry keyed by run id |
| `providers.py` | the provider adapter checks the token between model turns, so a model loop is interruptible mid-flight, not just a shell command |
| `orchestrator.py` | one `CancelToken` per run, registered with the runtime; `RunCancelled` → run `cancelled`, task `cancelled`, delegation finalized as failed, test-log artifact written; the persisted cancel request is honoured when the run starts |
| `store.py` | `runs.cancel_requested` column (+ idempotent migration), `request_run_cancel`, `run_cancel_requested`, `cancelled` transitions for runs and tasks, `cancelled` is terminal |
| `api.py` | `POST /runs/{run_id}/cancel` — records the request, then signals the live run; 404 unknown, 409 already terminal |
| dashboard | "Stop run" button on the task view, `cancelled` labels, `cancelled` counted in the task tally, `cancel_requested` on the Run type |

**Design notes worth stating.** A cancel can land in the short window
between "the run is marked running" and "the run registered itself with the
runtime". The first API test hit exactly that race and failed, so the
request is made **durable**: it is written to the run row first, and the
orchestrator honours the recorded request as the run starts. The response
says which happened: `cancel_requested: true` always, `signalled: true`
only when the live process was reached directly.

**Evidence** — `tests/test_run_cancellation.py` (10 tests):

| Test | Asserts |
|---|---|
| `test_local_runtime_cancels_a_running_command` | a cancelled command raises `RunCancelled` and stops promptly |
| `test_local_runtime_kills_the_whole_process_group` | the **grandchild** dies with the shell — no orphan left behind |
| `test_local_runtime_still_times_out` | the wall-clock budget still applies |
| `test_store_records_the_cancel_request` | the flag is durable; a terminal run refuses a cancel |
| `test_api_cancels_a_live_run` | a real run in flight is stopped through the API; run and task end `cancelled`; the partial output is kept |
| `test_api_refuses_to_cancel_a_finished_run` | 409, not a fake stop |
| `test_api_cancel_unknown_run_is_404` | 404 |
| `test_a_cancelled_task_can_be_run_again` | cancelling ends the run, not the task's life |
| `test_orchestrator_records_a_cancelled_run` | the run ends cancelled (not succeeded, not failed), the task is cancelled, and a test-log artifact is still written |
| `test_cancel_landed_before_registration_still_stops_the_run` | the race the API can hit is closed |

**Live evidence** (real `uvicorn` server, real subprocess, real
`killpg` — `scripts/live_cancel_check.py`):

```
live run started: run_3b16f5b02bd0
grandchild pid: 19350
cancel -> 200 {"run": {... "status": "running" ...
run status: cancelled  task status: cancelled
stopped in 0.04s
grandchild alive after cancel: False
RESULT: PASS
```

The run was stopped **40 ms** after the cancel, and the backgrounded
grandchild was gone — the whole process group died, not just the shell.

## 5. Acceptance against the original criteria

| Criterion (from the brief) | Result | Evidence |
|---|---|---|
| **E1** — `gates.require(conn, acting, "teammate.create", payload=…)` in both board-member services, after `authorize_board` | **PASS** | `boards.py:193` (add), `boards.py:229` (remove); 9 tests in `tests/test_board_member_gates.py` |
| **E1** — follow the `fleet.py` gate pattern (permission → digest-bound approval → one-use consumption) | **PASS** | same `gates.require` / `wrap_gate_error` shape as `fleet.py`; the shared wrapper was lifted out of `fleet.py` into `gates.py` so both surfaces use one implementation |
| **E1** — `GateDenied` / `GateApprovalRequired` mapped to honest HTTP (403 / 409 + pending approval) | **PASS** | `gates.wrap_gate_error`; asserted in the board tests |
| **E2** — ADR documenting the shell-tool approval policy, following the repo's ADR conventions | **PASS** | `docs/decisions/0009-shell-tool-approval-policy.md`, matching the `0001`–`0008` format |
| **E3** — replace the synchronous `subprocess.run` with `Popen` + poll + cancel flag | **PASS** | `runtime.py:213-283` (`LocalRuntimeAdapter.start_run`) |
| **E3** — `os.killpg` process-group kill | **PASS** | `runtime._terminate_process_group`; verified against a live grandchild |
| **E3** — API endpoint | **PASS** | `POST /runs/{run_id}/cancel` (+ dashboard "Stop run" button) |
| **E3** — store support | **PASS** | `runs.cancel_requested` + migration, `request_run_cancel`, `run_cancel_requested`, cancelled run/task transitions |
| **E3** — test | **PASS** | 10 tests in `tests/test_run_cancellation.py` + a live check script |
| **Phase 9** — tsc, eslint, vitest, vite build, pytest | **PASS** | §1 — 372 pytest, 50 vitest, tsc/eslint/ruff/mypy clean, build OK |
| **Phase 9** — acceptance against the original criteria | **PASS** | this table |

## 6. Honest limitations and what was deliberately not done

- **The shell is still not permission-gated.** The ADR decides that it should
  not be *approval*-gated and says exactly why; it also records that a
  permission gate would have to cover both shell surfaces (the `run_command`
  tool *and* the task command reaching `sh -c` through the local adapter) to
  be real rather than decorative. That work is a separate increment with its
  own risk, and it is not silently claimed as done.
- **The shell is not sandboxed.** A command still runs with the server
  process's privileges. This is the single-owner deployment posture the
  product states, not an oversight.
- **The model loop can only be interrupted between turns.** A cancel cannot
  abort an in-flight HTTP call to a provider; it takes effect at the next
  turn boundary. The local shell path has no such limit (50 ms poll).
- **The local adapter still runs the task command as `sh -c`.** A
  natural-language instruction that reaches it is executed by the shell and
  fails loudly. This was already recorded in the 2026-10-21 acceptance
  report as a real gap (its gap #2) and is unchanged by this increment.
- **The audit's E3 stays deferred**: Pydantic request models for the top
  mutating endpoints, a SQLite `busy_timeout`, and route tests for the
  untested endpoints. The cancel endpoint added here is covered.
- **A cancel for a run that is not live** (queued, or owned by another
  process) is recorded but cannot be signalled in memory; the request is
  honoured by the orchestrator when the run starts, and the response says so
  through `signalled: false`.

## 7. Files changed

Backend: `api.py`, `boards.py`, `fleet.py`, `gates.py`, `models.py`,
`orchestrator.py`, `providers.py`, `runtime.py`, `store.py`.
Dashboard: `api.ts`, `components.tsx`, `types.ts`, `views-task.tsx`.
Tests: `test_agent_tools.py` (+2), `test_board_member_gates.py` (new, 9),
`test_run_cancellation.py` (new, 10).
Docs: `decisions/0009-shell-tool-approval-policy.md` (new).
Tooling: `scripts/live_cancel_check.py` (new — reproducible live check).
