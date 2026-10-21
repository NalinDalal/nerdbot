# NerdBot — Fleet & Agent Layer Gap Analysis

Verified against the working tree on 2026-10-20 (second pass, after the
`board.read` enforcement work). Baseline gates at audit time:
`pytest 279 passed`, `ruff` clean, `mypy` strict clean (31 files),
dashboard `vitest 40 passed`, `tsc --noEmit` clean, `eslint` clean,
`vite build` OK.

The prompt's premise ("some combination of…") understates the codebase: a prior
session already built most of the agent layer. This document records what is
**real**, what was **broken**, what was **fixed**, and what is still
**missing**.

## Already implemented and verified working

| Capability | Where | State |
|---|---|---|
| Model-driven agent loop with tool calling | `providers.py` `OpenAICompatibleAdapter` (~L180-262) | Bounded turns, transcript capture, fail-closed tool filter |
| Permission-filtered agent tools | `app_tools.py` `app_tool_schemas` / `execute_app_tool` | Filter by `allowed_permissions`; schema and enforcement now agree (tool_policy keys included) |
| Server-side permission + digest-bound approval gate | `gates.py` `require` / `require_many` | Default-deny admin perms, one-use approvals, values bound into the digest |
| Board-scoped approvals & actor filtering | `boards.py`, `store.list_approvals_for_project` | Project-level approvals reachable |
| Delegation with depth cap + cycle check | `store.create_delegation`, `app_tools._delegate_task` | depth ≤ 5; ancestor-owner cycle check |
| Async child execution / resume | `executor.sweep` phase 2, `app_tools._await_delegations` | Child results write back to `Delegation` |
| Per-identity memory isolation | `agent_context.memory_scopes_for`, `store.recall_memory` | `teammate:<id>` + optional `project:<id>`; scopes recomputed per run |
| Isolated Git workspace per task | `workspace.py` | `git init`, `nb/<task>` branch, path-escape guard |
| Auth: fail-closed single-principal bearer | `auth.py` | closed/dev/configured tri-state |
| UI: fleet, bot detail, boards, tasks, delegations, approvals, memory, teams | `dashboard/src/views-*.tsx` | Real API calls, no mocks |

## Fixed in this pass

1. **`board.read` was declared but never enforced — and never offered.**
   `board.read` sat in `gates.PERMISSION_ONLY` and `app_tools.TOOL_PERMISSIONS`
   while *no code path consumed it*: there was no `read_board` handler, no
   schema, and `GET /boards/{id}` was owner-only. `store.actor_can_access_board`
   was documented as "the single source of truth … and the agent board-read
   tool (enforcement)" — but that tool did not exist.
   **Fix:** `boards.authorize_board` is now the one board authorization rule
   (permission → project scope → board membership); `boards.read_board_service`
   uses it; `app_tools` gained a `read_board` tool + schema; `GET /boards/{id}`
   and `GET /boards` accept an acting teammate gated on `board.read`.

2. **Board scope was bypassed by `acting=None`.** `app_tools` called
   `boards.create_board_message_service(..., acting=None)` and
   `boards.delete_board_service(..., acting=None)`, which skipped the service's
   permission *and* project check. A bot with `board.delete` + `tool_policy
   auto` could delete a board in another workspace, and a bot with
   `message.send` could post to any board in any workspace (the `to_board_id` /
   `to_teammate_id` targets were never validated).
   **Fix:** both tools now pass the acting identity; bot-supplied targets are
   validated against authoritative state.

3. **Acting identity was trusted, not validated.** `app_tools._dispatch` used
   `ctx.teammate` as-is. **Fix:** `_resolve_actor` re-reads the teammate from
   the store and requires it to exist, be active, belong to the task's project,
   and own the task — otherwise the tool is denied.

4. **Privilege escalation through bot management.** `gates.has_permission`
   counts a `tool_policy` key as holding that permission, but
   `fleet.update_teammate_service` gated `tool_policy` changes with nothing
   extra and did not bound a bot to the permissions it already holds — a bot
   with `teammate.update` could set `tool_policy={"board.delete": "auto"}` and
   gain board deletion. Approvals also bound only the *field names* of an
   update, so one approval covered any value.
   **Fix:** escalation guard (a bot may not grant what it does not hold),
   `permission.change` now also gates `tool_policy`, and the approval digest
   binds the exact change values.

5. **`create_teammate` could not attach a model.** The gap analysis flagged it
   and it was still true: the tool had no `provider_id`, so a CEO bot could
   spawn a bot that could never use the agent platform.
   **Fix:** `provider_id` is in the schema, forwarded to the service, and bound
   into the approval digest (approving provider A does not authorize B).

6. **`DelegationStatus.CANCELLED` was unreachable.** Nothing could cancel a
   delegation or a task.
   **Fix:** `store.cancel_delegation` / `store.cancel_task`, API routes
   (`POST /delegations/{id}/cancel`, `POST /tasks/{id}/cancel`), an agent tool
   (`cancel_delegation`), and dashboard controls. A cancelled child is blocked
   so the executor never picks it up, and a late result cannot overwrite the
   cancellation.

7. **Retries were unbounded.** `orchestrator.retry_task` could be called
   forever on a failing task. **Fix:** `store.MAX_TASK_RETRIES` (10 attempts).

8. **Bot-created boards were invisible to the owner.** `create_board_service`
   and `decomposition.materialize_plan` set the board owner to the *bot*, so
   the board dropped out of the owner's board list. **Fix:** the board is owned
   by the workspace owner and the creating bot joins as a member.

9. **Over-gating on teammate updates.** The HTTP `PATCH /teammates/{id}`
   always sent a `permissions` key (even `None`), so *any* acting-bot update
   demanded `permission.change`. **Fix:** the gate triggers only when
   permissions or `tool_policy` actually change.

## Still missing / deliberately not built

- **No decline path for agent-driven delegation.** `delegate_task` auto-accepts
  (`auto_accept=True`), so `DelegationStatus.DECLINED` is only reachable
  through the human `POST /delegations/{id}/decide` route.
- **No per-task Git workspace *sharing*.** Each task gets its own repo; there
  is no mechanism for several bots to share one checkout.
- **`inspect_workspace` is a local-command surface.** It lists the run's
  workspace; it does not push to or pull from a remote.
- **No `/secrets` surface, no `/health` fleet detail.** Minor; skipped.
- **Decompose is not an agent tool.** It is an API + dashboard flow; a bot
  cannot call it. The `create_task` tool covers in-run planning.

## Update 2026-10-21

Bridges phase-2/3 agent work and the dashboard. Current state:

1. **Agent-driven delegation is complete** (the "no decline path" gap above
   is closed): `delegation.py` implements the full
   pending/accepted/declined/failed/timed_out/cancelled lifecycle with
   bounded attempts and no simulated child results — children run in the
   same executor sweep as any task, and results flow back through the
   delegation record. Evidence: `tests/test_agent_delegation.py`,
   `tests/test_e2e_ceo_fleet.py`, `tests/test_dashboard_flow_contract.py`.

2. **Decomposition is now an agent surface** (closing the "decompose is not
   an agent tool" gap): the `propose_plan` / `apply_plan` tool pair
   (`app_tools.py`, `decomposition.materialize_plan`). `propose_plan` is the
   model draft validated server-side with no side effects; `apply_plan`
   re-validates against live state and materializes — an invalid plan is
   rejected whole, never partially executed; a dedicated plan board also
   needs `board.create`, steps assigned to other bots need `task.assign`.
   Evidence: `tests/test_agent_decomposition.py` (including a scripted-
   transport E2E that runs the child bot for real).

3. **Workspace trust model pinned:** `inspect_workspace` uses the run's
   adapter `workspace_path` inside a run; the standalone fallback accepts a
   DB-stored path only when it resolves to the canonical per-task workspace.
   Decision record: `docs/decisions/0008-workspace-isolation.md`. Evidence:
   the `inspect_workspace_*` tests in `tests/test_agent_tools.py`.

4. **Dashboard Priority 4 flows audited rather than rebuilt:** bot
   CRUD/config + permission editor + board membership (`views-bot.tsx`),
   delegation handoffs with accept/decline/cancel and the delegation tree
   (`views-task.tsx`), the plan-review decompose modal with an editable side-
   effect-free preview (`views-boards.tsx`), run/artifact/workspace/diff
   inspection and cancellation are all real API-driven flows. The UI↔backend
   contracts are now pinned in `tests/test_dashboard_flow_contract.py`
   (plan review fails closed / materializes exactly the reviewed plan /
   rejects stale plans whole; handoff lifecycle; cancellation cascades to
   pending handoffs; workspace browser refuses path escapes).

Gates after this bridge: `pytest 344 passed`, `ruff` clean, `mypy` clean
(33 files), dashboard `vitest 40 passed`, `vite build` OK.

## Deliberately NOT changing

- No second task system, provider layer, workspace impl, or `Board`-as-team
  duplication. Boards remain per-project workspace containers; **Team** groups
  projects and bots.
- Single-principal auth retained.
- Human owner is never gated; only `X-Acting-Teammate` calls are.
- `board.message` (HTTP route) and `message.send` (agent tool) stay distinct
  permissions; the board service takes the permission name explicitly rather
  than aliasing the two, so granting one never silently grants the other.
