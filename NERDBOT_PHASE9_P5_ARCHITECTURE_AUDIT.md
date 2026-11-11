# Nerdbot Phase 9 — P5 Stage 0: Workbench Code Mode Architecture Audit

**Status:** Audit only (no implementation)  
**Report date:** 2026-11-11 (audit run date)  
**Scope:** Phase 9 P5 — Workbench Code Mode architecture, readiness, gaps, risks, and incremental plan (Stages 1–7)

## 1. Verified baseline

### Git / preflight (verified, read-only)
- **Branch:** `main`
- **HEAD:** `b73a8670e0b142a79934bb5e0b50d61349443d2f` (`b73a867`)
- **HEAD commit:** `Complete Phase 9 P4 Stage 3 board coordination and visibility alignment`
- **P4 commits present (verified):**
  - Stage 1: `3f801c3` — `Harden Phase 9 P4 Stage 1 team and board authorization`
  - Stage 2: `0cb00e3` — `Complete Phase 9 P4 Stage 2 team lifecycle`
  - Stage 3: `b73a867` — `Complete Phase 9 P4 Stage 3 board coordination and visibility alignment`
- **Working tree:** not clean; **103 untracked files** were present at audit time, predominantly pre-existing generated/compiled dashboard JS artifacts and `dashboard/tsconfig.tsbuildinfo` (e.g. `dashboard/src/*.js`, `dashboard/src/bot/*.js`, `dashboard/src/views-workbench.js`, `dashboard/scripts/*.js`) plus Playwright/spec-related files already in tree context. No tracked modifications were observed. **No files were modified, deleted, staged, committed, pushed, or merged during this audit** (except creation of this report file as the required deliverable).

### Audit method
- Read-only inspection of backend/frontend source, schemas/models, API routes, workspace/runtime/terminal/orchestration modules, and existing tests/specs.
- Evidence gathered from: `backend/src/nerdbot/api.py`, `workspace.py`, `terminal.py`, `runtime.py`, `orchestrator.py`, `app_tools.py`, `gates.py`/permissions models context, `schemas.py`, dashboard `views-workbench.tsx`, `workbench.ts`, `app.tsx`, `api.ts`, and tests including `tests/test_workspace_os.py`, dashboard `workbench.test.ts`, `tests/workbench-states.spec.ts`, `tests/workbench-responsive.spec.ts`.

## 2. Existing capability inventory (exact implementation locations)

### 2.1 Workbench UI and frontend architecture
- **Primary workbench view (3-pane product model):** `dashboard/src/views-workbench.tsx`
  - Layout: files/bots (left), editor+terminal (center), changes+run/review (right); mobile tabbed panes (`files/editor/terminal/review`) with responsive behavior.
  - Features: project/workspace selection (persisted in localStorage key `nerdbot.workbench.project`), file tree/search/filter, open/create path flow, editor load/save, keyboard shortcuts/help modal, terminal panel (connect/restart/collapse/focus), diff/changes panel, latest task/run/approval/artifact summary with navigation to task detail.
  - Panel-level loading/empty/error states and project-tagged state handling to avoid cross-project stale renders.
- **Workbench pure logic/helpers:** `dashboard/src/workbench.ts`
  - Pane model, shortcut mapping (`shortcutFor`), text-file detection, initial/suggested file selection (`pickInitialFile`, `suggestFiles`), filtering/stepping, diff stats, byte/line formatting, task activity detection, terminal status/theme helpers.
- **Routing/app integration:** `dashboard/src/app.tsx`
  - Routes include `/workbench` and `/workbench/:projectId` (`WorkbenchView`), project/task navigation (`/p/:id`, `/p/:id/t/:taskId`), approvals, library, bots, boards, etc.
- **API client/types:** `dashboard/src/api.ts` (workspace/tree/file/diff/terminal endpoints, task workspace endpoints, run/task APIs), `dashboard/src/types.ts` (workspace/task/run/artifact/approval types).
- **Frontend tests:** `dashboard/src/workbench.test.ts` (pure workbench logic), Playwright specs `dashboard/tests/workbench-states.spec.ts`, `dashboard/tests/workbench-responsive.spec.ts`.

### 2.2 Project filesystem, workspace roots, file explorer/editor APIs
- **Workspace domain/service:** `backend/src/nerdbot/workspace.py`
  - Project live root resolution: attached folder via `project.config["workspace_root"]` or default owned workspace under data dir (`configured_project_root`, `default_project_workspace`, `ensure_project_workspace`, `is_owned_by_config`).
  - Path safety: `safe_workspace_path` rejects empty/absolute/`..` traversal, `.git` metadata access, and symlink/resolve escapes outside root.
  - Tree/read/write: `list_workspace_files` (skips common generated dirs e.g. `.git`, `node_modules`, caches/build dirs; bounded by `MAX_TREE_ENTRIES`), `read_workspace_text`/`write_workspace_text` (UTF-8 text only, `MAX_TEXT_BYTES` cap), `workspace_meta`.
  - Git-aware status/diff helpers: `is_git_repo`, `current_branch`, `git_status_entries`, `workspace_diff` (diff vs `HEAD` plus explicit untracked/new-file rendering), `baseline_commit`, `ensure_branch`, `branch_name_for_task`.
  - Isolated task checkouts: `create_isolated_workspace`, `workspace_path_for_task`, seeding/cleanup helpers.
  - Live workspace concurrency primitive (in-process): `acquire_workspace_lock`, `release_workspace_lock`, `workspace_busy`.
- **Schemas:** `backend/src/nerdbot/schemas.py` — `WorkspaceAttach`, `WorkspaceFileWrite`, terminal input/resize/create schemas.
- **API endpoints (project live workspace / workbench):** `backend/src/nerdbot/api.py`
  - `GET /projects/{project_id}/workspace` (meta, attached/busy/git/branch/dirty), `POST /projects/{project_id}/workspace/attach`
  - `GET /projects/{project_id}/workspace/tree`, `GET /projects/{project_id}/workspace/file`, `PUT /projects/{project_id}/workspace/file`, `GET /projects/{project_id}/workspace/diff`
  - Project-scoped terminal sessions (see 2.5)
  - Task checkout/file surfaces: `GET /projects/{project_id}/workspace/files` (all task checkouts), `GET /tasks/{task_id}/workspace/files`, `GET /tasks/{task_id}/workspace/file`, `GET /tasks/{task_id}/workspace/diff`, `POST/DELETE /tasks/{task_id}/workspace` flows (ensure/cleanup)

### 2.3 Agent file access, workspace awareness, and codebase understanding
- **Task execution workspace model:** `backend/src/nerdbot/orchestrator.py`
  - Distinguishes `workspace` mode (project live root) vs isolated checkout per task (`prepare_task_workspace`, `task_workspace_root`), persists branch/path metadata, enforces one live run per project for live workspace via `workspace.acquire_workspace_lock`.
  - Injects execution workspace context into run/system framing; records run events for workspace/run lifecycle.
- **Agent/app tools (permission-gated):** `backend/src/nerdbot/app_tools.py`
  - Workspace inspection tool (`inspect_workspace`) lists files/sizes and basic git status within task workspace (bounded listing/truncation behavior), using resolved workspace path/context.
  - Task/delegation/messaging/knowledge/board/fleet tools routed through canonical gates (`gates`/tool permissions), ambient vs permissioned tools; no general-purpose unrestricted shell/edit tool exposed here by default.
- **Runtime command execution context:** `backend/src/nerdbot/runtime.py` provides local/docker adapters for task commands in a workspace (not an interactive editor agent FS abstraction).

### 2.4 File editing and change tracking
- **Human/editor path:** `PUT /projects/{project_id}/workspace/file` (`api.py`) -> `workspace.write_workspace_text` with path confinement, text/size limits, and `workspace.file.saved` event recording; save blocked with `409` when live workspace is busy.
- **Change tracking:** `workspace.git_status_entries`, `workspace.workspace_diff`, and API diff endpoints for project workspace and task workspace; UI renders status/additions/deletions and changed files.
- **Task/run artifacts and evidence:** orchestrator captures patch/artifacts/reviews/PR package artifacts for task workspaces (patch capture uses git diff/baseline semantics); run events/artifacts persisted in store and surfaced in task/workbench views.

### 2.5 Terminal and command execution
- **Interactive owner terminal (PTY):** `backend/src/nerdbot/terminal.py`
  - In-memory sessions bound to `project_id` and resolved workspace root; per-project session cap; shell selection (`NERDBOT_TERMINAL_SHELL`/fallbacks), PTY pump with output buffering and secret scrubbing via runtime helpers, resize/input APIs, SSE stream snapshot+data+exit, clean close/kill behavior, `close_all()` lifecycle hook.
  - Session lookup enforces `(session_id, project_id)` binding.
- **API:** `POST/GET(stream)/POST input/POST resize/DELETE /projects/{project_id}/terminal...` in `api.py`, all owner-authorized per project.
- **Non-interactive task command execution:** `backend/src/nerdbot/runtime.py`
  - Local adapter runs commands via `sh -c` in workspace with deny-list policy (`check_command`/`BLOCKED_PATTERNS`), timeout/cancel/process-group termination, env secret exclusion/scrubbing, output framing helpers.
  - Docker adapter exists with stronger isolation controls (digest-pinned image required, read-only rootfs, dropped caps, no-new-privileges, resource limits, network none by config/default path shown) and secret scrubbing/artifact size checks.

### 2.6 Build, test, lint, and development workflows
- **Project-level workflows are external/repo-defined:** no dedicated first-class CI workflow orchestration service found in audited modules; users/agents rely on terminal commands or task commands in workspaces.
- **Existing automated tests relevant to P5 surface:**
  - Backend: `tests/test_workspace_os.py` (workspace meta/tree/file round-trip, path escape rejection, attach folder behavior, live task in project root/protection, etc.), plus broader task/run/approval/board suites.
  - Frontend: `dashboard/src/workbench.test.ts`, `dashboard/tests/workbench-states.spec.ts`, `dashboard/tests/workbench-responsive.spec.ts`.
- **Lint/type/build:** TypeScript/Vite dashboard build pipeline present; backend pytest-based regression suite present (full suite baseline recently **593 passed, 1 warning** per Stage 3 closeout context).

### 2.7 Git integration and repository safety
- **Workspace git utilities:** `workspace.py` (`is_git_repo`, status/diff, baseline commit, branch helpers, untracked diff rendering).
- **Safety boundaries:** editor/file APIs refuse `.git` paths; project diff/file ops confined to resolved workspace root; attached folders not auto-initialized unless explicitly requested/configured path logic allows.
- **Task isolation model:** isolated checkout branches per task for checkout mode; live workspace mode operates on project root with lock/busy protections.
- **Gaps:** no comprehensive guarded git command surface (commit/push/pull/merge/rebase/stash/cherry-pick/reset) exposed as managed, auditable workbench operations with policy/approval UX; git behavior is partly implicit/tooling-dependent.

### 2.8 Agent execution, orchestration, and approvals
- **Orchestration:** `backend/src/nerdbot/orchestrator.py` coordinates task/run lifecycle, workspace preparation, run events, dependency/retry semantics, artifact/review/package flows, and live-workspace locking.
- **Execution runtime abstraction:** `backend/src/nerdbot/runtime.py` + adapters; cancellation and process-group control for local runs.
- **Approvals/gates:** canonical permission/gate system (`gates`, `permissions`, tool-policy behavior) used by app tools and mutating surfaces (including board/fleet/admin actions and gated bot operations); digest-bound approvals/pending-approval UX patterns already present in product/API conventions.
- **Observability:** run events streaming, run status/output/artifacts/approvals surfaced in task detail and workbench review panel.

### 2.9 Security, workspace isolation, and concurrency
- **Filesystem isolation controls:** strict path resolution/confinement, `.git` metadata blocked from file editor APIs, text/binary/size/tree bounds, skipped heavy/generated dirs.
- **Command safety:** deny-list for dangerous shell idioms, env secret scrubbing/redaction, untrusted output framing, timeout/cancel with process-group termination.
- **Concurrency:** in-process per-project live-workspace lock (`workspace_busy`/acquire/release) and save/run conflict signaling (`409` busy in key paths); terminal session caps per project.
- **Auth/authorization:** project-owner checks on workspace/terminal/file APIs; board/task/messaging gates and acting-teammate enforcement in relevant services.

### 2.10 Local and hosted deployment compatibility
- **Local-first implementation:** filesystem paths rooted in configured/local data dirs and host filesystem; PTY terminal uses local shell/processes; local runtime executes on host via subprocess.
- **Hosted/container considerations present but partial:** Docker runtime adapter and recovery helpers exist for task execution; terminal/workbench file APIs and live workspace roots remain host-bound concepts. No unified hosted workspace sandbox/remote FS abstraction evident for workbench UX.

### 2.11 Frontend architecture and user experience
- **Mature workbench shell exists:** clear information architecture (files/editor/terminal/review), shortcut-driven productivity affordances, responsive layout, explicit state handling, integration with tasks/runs/approvals/artifacts.
- **UX gaps for "Code Mode" depth:** limited multi-file editing model, no native diff-apply/review workflow UI, no integrated git action panel/history/branch management, no first-class build/test task runner UX, no agent-change review/accept-reject loop in editor.

### 2.12 Existing tests and missing regression coverage (inventory)
- **Present:** `tests/test_workspace_os.py`, `dashboard/src/workbench.test.ts`, `dashboard/tests/workbench-states.spec.ts`, `dashboard/tests/workbench-responsive.spec.ts`, extensive backend API/orchestration/board/gate suites.
- **Not observed as dedicated coverage:** end-to-end workbench agent-edit collaboration flows, PTY terminal integration/security tests, git operation safety/approval flows, hosted-mode workspace behavior, concurrent multi-client editing/conflict semantics, large-repo performance, comprehensive path/encoding/permission regression matrix for all workspace surfaces.

## 3. Missing capabilities (P5-relevant)

1. **True agent "Code Mode" editing loop in workbench:** structured propose/edit/preview/apply/revert flow with user-visible change sets (beyond task patch artifacts and raw file saves).
2. **First-class git workflow UI/services:** status-aware stage/unstage, commit creation, branch switch/create, merge/rebase safety flows, push/pull integration (with explicit policy), conflict visualization/resolution aids.
3. **Managed build/test/lint/dev task runner:** configurable commands, presets per project, streaming logs/history tied to workspace state, actionable failure summaries, rerun/cancel semantics integrated with approvals/policy where needed.
4. **Richer editor capabilities:** multi-tab/buffer model, dirty-state coordination, file rename/move/create/delete UX, search/replace across workspace, language diagnostics integration (as feasible), binary/large-file handling UX.
5. **Agent-codebase understanding surfaces:** indexed/searchable project context, symbol/file discovery tools exposed coherently to workbench sessions, explicit read scopes/provenance in UI.
6. **Change review and safety controls:** diff hunk review, accept/reject per change, audit trail linking agent actions/commands/edits to approvals and run events.
7. **Hosted deployment parity:** remote workspace abstraction, sandboxed terminal/command execution model, storage/network policy alignment, and consistent auth/session semantics for multi-user/hosted environments.
8. **Operational hardening:** persistence/recovery semantics for terminal/editor sessions, stronger cross-process concurrency guarantees, quota/rate limits, and observability for workbench actions.

## 4. Architectural inconsistencies

- **Dual workspace paradigms not fully unified in UX:** project live workspace (workbench) vs per-task isolated checkouts (`workspace_mode=checkout`) have different lifecycles, diff sources, and safety properties; mapping between "what agent changed" and "what user sees/edits now" can be ambiguous.
- **In-process concurrency assumptions:** live workspace lock is process-local (`threading.Lock` registry), sufficient for single-process server but not a distributed/hosted guarantee.
- **Terminal is human-only and decoupled from orchestration policy:** PTY sessions are owner-authorized but not represented in the same gated run/approval/audit model as agent actions; command policy differs from agent runtime deny-list/adapter constraints.
- **Git semantics vary by context:** default workspace may be baseline-committed; attached folders may be non-git; diff behavior differs (`workspace_diff` special-cases untracked/unborn HEAD). UI communicates some states but workflow actions are limited.
- **Agent file capabilities are fragmented:** `inspect_workspace`/task runtime operate in task workspace context, while workbench edits operate on project workspace root; no single coherent "code mode" capability contract across human editor, terminal, and agent tools.
- **Security posture differs across surfaces:** strong path confinement for file APIs, deny-list for runtime commands, but interactive terminal provides broad shell power within OS/user permissions (bounded mainly by ownership/session binding and env scrubbing).

## 5. Security and reliability risks

### High
- **Interactive terminal blast radius (owner session):** full shell in workspace root can perform destructive or exfiltrative actions within host permissions; not mediated by runtime deny-list/approval gates used for agent commands. In hosted/multi-tenant contexts this is a critical boundary risk.
- **Cross-process/distributed race risk:** in-memory workspace lock/busy state does not coordinate multiple server processes/instances; concurrent writes/runs may corrupt or obscure state in scaled deployments.
- **Live workspace mutation conflicts:** human edits, terminal commands, and live agent runs share the same root; limited conflict detection/merge UX can cause lost work or confusing diffs.

### Medium
- **Inconsistent policy enforcement across execution paths:** agent runtime blocks some shell idioms; user terminal does not. Policy expectations for "safe code mode" may be unclear.
- **Git repository safety gaps:** no guarded high-risk git operations workflow (reset/force actions/remote pushes) but absence of guardrails also means users may perform them manually in terminal without product-level confirmations/audit.
- **Resource/DoS exposure:** tree/read/write/terminal stream are bounded in places (file/tree limits, session caps) but lack comprehensive quotas/rate limiting/backpressure strategy for large repos or long-lived sessions.
- **Hosted compatibility uncertainty:** PTY, host shells, filesystem semantics, and path assumptions may not translate directly to sandboxed/containerized hosted environments.

### Low / Manageability
- **State persistence gaps:** terminal sessions are ephemeral (in-memory) and editor state is client-local in parts; restarts/dropouts can degrade continuity (reliability/UX issue more than data loss of saved files).
- **Binary/non-text and large-file ergonomics:** APIs correctly refuse unsupported cases, but UX/workflows for assets/generated outputs need refinement to avoid friction.

## 6. Existing components that should be reused

- **Workspace primitives:** `backend/src/nerdbot/workspace.py` (path safety, tree/meta/read/write, git status/diff, project root resolution, lock helpers) as the canonical filesystem boundary.
- **Workbench UI foundation:** `dashboard/src/views-workbench.tsx`, `dashboard/src/workbench.ts`, existing panel/state patterns, shortcut model, and responsive/tabbed layout.
- **Terminal infrastructure:** `backend/src/nerdbot/terminal.py` + existing SSE/input/resize/close API/client wiring for interactive shell sessions.
- **Orchestration/run evidence model:** `backend/src/nerdbot/orchestrator.py`, run events streaming, artifacts/reviews/approvals/task views for execution transparency.
- **Runtime safety utilities:** `backend/src/nerdbot/runtime.py` secret scrubbing/env filtering, deny-list checks, cancellation/process control, untrusted output framing.
- **Authorization/gate framework:** existing project ownership checks, canonical gates/permissions/tool policies, acting-teammate patterns, and approval UX conventions.
- **Existing tests/harnesses:** `tests/test_workspace_os.py`, dashboard workbench unit/state/responsive tests as regression anchors to extend incrementally.

## 7. Required backend and frontend changes (by capability)

### 7.1 Backend (incremental, scoped)
- **Unified workbench change tracking/audit model (service-level):** represent human/agent/terminal-originated file changes and command/run records with consistent attribution and timestamps (reusing run events/artifacts where possible; avoid schema redesign unless approved).
- **Workspace operation APIs for P5:** safe file operations beyond read/write (create/delete/rename/move) with the same confinement/limits, conflict-aware responses, and eventing.
- **Git operation orchestration layer:** backend-mediated, policy-aware git actions for common flows (status snapshot already exists, commit/branch/diff helpers partial) with explicit allow/deny boundaries and approval hooks for risky operations.
- **Build/test/lint task execution service integration:** reusable command execution profiles for workspace checks (streaming output, status, cancellation), aligned with runtime safety/quotas and ownership/auth.
- **Agent Code Mode tool contract:** explicit, permissioned tools/capabilities for code navigation/edit proposals and reviewable application in the correct workspace target (project live vs task checkout) without bypassing gates.
- **Concurrency/consistency hardening:** stronger lease/lock semantics (cross-process safe strategy when needed), optimistic concurrency/version checks for file writes, and clearer busy/conflict error contracts.
- **Hosted-compatible abstractions (staged):** isolate filesystem/terminal/command execution behind interfaces/adapters so local and hosted backends can share workbench behavior without unrestricted host shell assumptions.

### 7.2 Frontend (incremental, scoped)
- **Editor/workbench UX expansion:** file operation affordances, better unsaved/conflict states, multi-buffer or improved open-file workflow, and navigation/search affordances.
- **Changes/review UX:** richer diff presentation, change grouping, provenance (human/agent/command), and actionable apply/revert/review controls where backend supports them.
- **Git/build/test panels:** dedicated panels/workflows for repo status, commits/branches (approved subset), and configurable run commands with streaming results/history.
- **Terminal integration polish:** session lifecycle/reconnect UX, clearer policy/scope messaging, and safe defaults; no UX that implies sandboxing beyond actual guarantees.
- **Approval/notification integration:** inline prompts and links to canonical approval flows for gated workbench/agent operations.
- **State resilience:** preserve/restore editor/session context safely per project; robust loading/empty/error handling for all new panels.

## 8. Required tests and acceptance criteria

### 8.1 Required tests (new/expanded)

**Backend**
- Workspace API matrix: read/write/create/delete/rename/move (if added), path escape/symlink/traversal, `.git` protection, size/binary limits, busy/conflict (`409`) semantics, attached vs default roots.
- Git service tests: status/diff correctness (including untracked/unborn HEAD), safe operations, rejection/approval gating for risky actions, non-git/dirty/merge-conflict scenarios.
- Terminal tests: session binding/ownership, lifecycle (stream/input/resize/close), output scrubbing, caps/limits, restart/recovery behavior, failure modes.
- Command/build/test runner tests: streaming, cancellation/timeouts, policy enforcement, audit/event linkage, project scoping.
- Agent Code Mode tests: permission/gate enforcement, correct workspace targeting (live vs checkout), reviewable edit application, no silent destructive actions.
- Concurrency/integration: simultaneous human edit + agent run + terminal activity; multi-client consistency; process-restart behavior where applicable.
- Security regression: secret non-leakage in terminal/run/file outputs and events; policy bypass attempts.

**Frontend**
- Unit tests (`workbench.ts` and new utilities): path/state reducers, diff/change models, shortcut/command mapping, conflict/dirty logic.
- Component/view tests: panel states (loading/empty/error/success), file ops, save/conflict UX, terminal controls, git/build panels, approval prompts.
- Playwright/e2e: responsive layout, core edit-save-diff flow, terminal session flow, run/build feedback, agent change review flow, permission/approval-denied UX, cross-project isolation in UI state.
- Accessibility/UX smoke: keyboard navigation, focus management, ARIA roles for tabs/panels/dialogs/streams.

### 8.2 Acceptance criteria (P5 program-level)
- **Correctness:** All workbench file/terminal/git/build/agent operations are project-scoped, path-confined, and auditable with deterministic UI states.
- **Security:** No unauthorized cross-project/workspace access; no secret leakage in logs/streams/UI; risky actions require explicit policy/approval where defined; no unrestricted host-shell exposure introduced by new agent surfaces.
- **Reliability:** Concurrent edits/runs produce clear conflict/busy outcomes (no silent corruption/lost updates); failures are recoverable and user-visible.
- **Compatibility:** Local mode remains fully functional; hosted-mode constraints are explicitly handled (supported, gated, or gracefully unavailable) without unsafe fallbacks.
- **Regression safety:** Existing Phases 1–8 and Phase 9 P1–P4 behaviors remain intact; full backend/frontend test/build gates pass before stage completion.

## 9. Dependency ordering across P5 Stages 1–7

| Stage | Focus | Depends on | Primary outcomes |
|---|---|---|---|
| **1** | Workspace & file operation foundation hardening | P5 Stage 0 audit (this document), P4 baseline | Canonical file op APIs/contracts, conflict/busy semantics, stronger invariants and tests for workbench FS surface |
| **2** | Editor/change-tracking and review primitives | Stage 1 | Reliable edit buffers/save flows, change provenance, diff/review building blocks in UI and backend contracts |
| **3** | Git integration (safe, auditable subset) | Stages 1–2 | Managed git status/branch/commit flows (and guarded risky actions), UI panels, policy/approval integration points |
| **4** | Build/test/lint and command workflow integration | Stages 1–2 (optionally 3 for git-aware flows) | First-class task runners/checks with streaming output, history, cancellation, and workspace-scoped results |
| **5** | Agent Code Mode execution & collaboration loop | Stages 1–4 | Permissioned agent edit/propose/apply/review loop aligned with workbench, orchestration, and approvals (no parallel engine) |
| **6** | Hosted/local parity, isolation, and operational hardening | Stages 1–5 | Adapterized execution/terminal/workspace boundaries, stronger concurrency/security controls, deployment-aware behavior |
| **7** | UX polish, performance, regression hardening, rollout | Stages 1–6 | End-to-end quality, accessibility/perf tuning, complete test coverage, rollout/operability review |

**Ordering rationale:** establish safe filesystem/contracts first, then human-visible editing/review, then repo and validation workflows, then agent collaboration on top of stable primitives, then deployment hardening and final reliability/UX closure.

## 10. Risks and migration requirements (if any)

### Risks
- **Scope creep into platform redesign:** Code Mode can pressure changes to execution, storage, or permission models; must resist broad redesign without approval.
- **Security regression via convenience:** adding git/agent/terminal power without uniform policy/audit can weaken trust boundaries.
- **Data/workspace consistency bugs:** live shared workspace + concurrent actors is inherently race-prone.
- **Hosted feasibility gaps:** local PTY/host FS assumptions may require adapter boundaries or feature gating for hosted mode.

### Migration requirements
- **No immediate schema migration required** for audit-stage recommendations; prefer additive metadata/eventing and API evolution within existing models.
- **Potential future migrations (approval-gated):** only if durable audit trails, cross-process locks/leases, or hosted workspace/session persistence cannot be represented safely with existing structures.
- **Configuration/compatibility:** any new git/build/terminal policies must default safely and preserve existing local workflows; attached-workspace behavior must remain backward-compatible.

## 11. Recommended incremental implementation sequence (proposed)

1. **Stage 1 — Workspace foundation:** formalize file operation contracts (and safe extensions), add conflict/version signals, harden API/service tests around `workspace.py`/project workspace endpoints.
2. **Stage 2 — Editor & change review core:** implement robust editor state and change-set presentation (human vs agent provenance) using existing diff/run-event primitives.
3. **Stage 3 — Safe git workflows:** introduce backend-mediated git actions (read-mostly to mutating in controlled steps), with explicit approvals/audit for risky operations and non-git compatibility.
4. **Stage 4 — Build/test/lint workflows:** add project-scoped runnable checks with streamed logs/cancel/retry and integration into workbench/review panels.
5. **Stage 5 — Agent Code Mode loop:** enable permissioned, reviewable agent edits/commands against the correct workspace target through existing orchestration/gates (no parallel engine), with clear approval and evidence trails.
6. **Stage 6 — Deployment and isolation hardening:** adapterize/contain terminal and execution for hosted parity where feasible; enforce cross-process safety and resource controls.
7. **Stage 7 — Reliability, UX, and rollout:** close gaps found in e2e/regression testing, performance/accessibility polish, documentation, and production rollout checks.

**Guardrails for all stages:** preserve Phases 1–8 and completed P4; reuse `workspace.py`, runtime safety utilities, gates/approvals, orchestrator/run evidence; no unrestricted host-shell execution for agents; no permission-model redesign or parallel orchestration engine.

## 12. Security and reliability assessment

- **Current posture:** solid baseline for local owner-driven workbench use (path confinement, text/size bounds, secret scrubbing, runtime command deny-list/cancel, project-scoped APIs, run/approval evidence). Workbench UI already models core states and integrates files/editor/terminal/changes/runs.
- **Primary concern:** the **interactive owner terminal** and **live shared workspace** model provide necessary power but create a broad trust/consistency boundary, especially for hosted or multi-actor scenarios.
- **Reliability concern:** concurrency and lifecycle guarantees are mostly single-process/in-memory; robust Code Mode requires stronger conflict detection, coordination, and recovery semantics.
- **Overall assessment:** **Viable foundation, not yet production-complete for full agent-driven Code Mode.** P5 should prioritize safety, consistency, and auditable workflows over feature breadth, with staged hardening before expanding autonomous capabilities.

## 13. Test strategy

- **Layered approach:**
  - **Unit/pure logic:** extend `dashboard/src/workbench.test.ts` and backend utility/module tests for path, diff, policy, and state logic.
  - **API/service integration:** expand `tests/test_workspace_os.py` and add dedicated suites for terminal, git workflows, build/test runners, and agent Code Mode permissions/targeting.
  - **End-to-end/UI:** grow Playwright coverage (`dashboard/tests/workbench-*`) for real flows (edit/save/diff, terminal lifecycle, checks, agent review/approval states, responsive and failure modes).
  - **Security/regression:** explicit negative tests for path escapes, unauthorized access, secret leakage, blocked actions, and cross-project isolation.
  - **Non-functional checks:** performance on large trees/diffs/log streams, cancellation/timeout behavior, restart/reconnect resilience.
- **Gate per stage:** targeted tests after each meaningful change, plus full backend pytest, dashboard tests, TypeScript checks, and production build before declaring a stage complete.
- **Traceability:** every identified gap/risk in this audit maps to at least one test category and acceptance criterion in Stage 1–7 plans.

## 14. Explicit statement

**No implementation was performed.** This audit was conducted as a read-only analysis of the existing Nerdbot baseline (`main@b73a867`, including verified P4 Stages 1–3). No product source files were modified, no migrations were applied, and no commits, pushes, or merges were created as part of this audit; only this report (`NERDBOT_PHASE9_P5_ARCHITECTURE_AUDIT.md`) was produced as the requested deliverable.

**Stop/approval:** Awaiting approval before any P5 implementation work.