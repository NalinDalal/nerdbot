# NerdBot 2.0 — Build Handoff & Execution Plan

This document is the source of truth for continuing NerdBot 2.0 in a fresh ChatGPT session, coding agent, or local model. It records the product goal, current implementation state, priorities, architecture constraints, and acceptance tests.

## 1. Product goal

Build **NerdBot as a self-hosted AI operating system / autonomous AI workforce**, not merely a chatbot or an agent-management dashboard.

The user gives NerdBot an objective. NerdBot understands it, plans the work, selects and delegates to specialized teammates, executes with tools and models, monitors progress, asks for approval when necessary, produces real deliverables, and remembers useful project context.

The user should interact with outcomes and teammates. Internal concepts such as task IDs, runs, provider IDs, delegation records, memory tiers, and executor sweeps should not dominate the experience.

### Product capabilities to target

- Conversational command center and chief-of-staff orchestrator.
- Persistent AI teammates with identities, roles, skills, instructions, model choices, permissions, tools, and memory.
- Objective planning, task decomposition, dependency management, delegation, coordination, retries, and recovery.
- Real tool use: repository/workspace access, terminal, web search, knowledge retrieval, GitHub and integrations.
- Model routing across Ollama/local and hosted providers, with teammate overrides and fallbacks.
- Background execution and schedules on the VPS.
- Human approval gates for privileged or destructive actions.
- Project-scoped context, files, knowledge, and durable memory.
- Deliverables: code changes, tests, diffs, PR packages, research reports, documents, and generated media.
- Eventually, a Studio for image/video workflows using external generation providers. Do not pretend this exists until integrated and tested.

## 2. Current state — reported as of 2026-11-05

The user reports these changes have already been made:

1. Blueprint created at `docs/architecture/nerdbot-2.0-blueprint.md`.
2. Teammate model overrides and fallback providers are now applied during runs through `resolve_run_provider` and the orchestrator.
3. `POST /projects/{id}/objectives` added. It wraps existing decomposition into a one-shot plan → board + tasks flow.
4. Home/Thread composer has a **Plan & execute** button that calls the objective endpoint and opens the resulting tasks.

Previously reported audit:

### Working foundations

- FastAPI backend and React dashboard.
- Chat threads and streaming.
- Provider connections, health checks, model catalogues.
- Persistent teammates, persona, permissions, memory scopes.
- Tasks, runs, isolated Git workspaces.
- Run event streaming.
- Approvals.
- Delegation lifecycle and task decomposition.
- Knowledge ingestion/retrieval (currently basic token-overlap retrieval).
- Memory tiers/persona files.
- Schedules, executor sweep, notifications.
- Terminal sessions, GitHub issue preview, boards, metrics, backups.

### Known gaps from the earlier audit — re-verify before changing

- Chat was completion-only; it did not run a full objective → plan → delegate → execute → deliver loop.
- Model selection helper and teammate overrides were previously unused. The user reports this has now been fixed; verify with tests.
- Web search was not exposed as an agent tool.
- Knowledge retrieval was not exposed in the agent tool loop.
- Background executor required `NERDBOT_EXECUTOR=1` or manual sweeps; no always-on scheduler daemon was confirmed.
- Delegation visibility was task-oriented rather than a first-class live orchestration view.
- Memory retrieval was token-overlap, not semantic/vector search.
- Creative image/video generation was not integrated.
- UI emphasized resources (projects/tasks/runs) instead of user objectives, workforce activity, and deliverables.

Do not assume any gap remains unchanged. Inspect the current repository and recent commits first.

## 3. Immediate priorities — do these in order

### P0 — Make the objective execution loop reliable

1. Inspect the new objective endpoint and its tests.
2. Verify it creates a plan, board, tasks, and dependency relationships correctly.
3. Verify the Plan & execute UI sends the right project/objective data and handles errors.
4. Verify tasks can actually be claimed and executed by the intended teammates.
5. Verify run status, events, artifacts, failures, retries, and approvals are reflected correctly.
6. Add an end-to-end test for one objective that creates multiple tasks and produces a real deliverable.

**Do not build more UI on top of a broken execution path.**

### P0 — Finish agent tool access

1. Inspect the existing tool registry and agent execution loop.
2. Add web search as a properly permissioned agent tool, with source URLs and citations retained in research outputs.
3. Expose project knowledge search/retrieval to agents.
4. Add relevant tools to the right teammates rather than giving every agent unrestricted access.
5. Add timeouts, error handling, tool-call logging, and tests.
6. Ensure tool permissions are enforced server-side, not just hidden in the UI.

### P1 — Make chat objective-aware

1. Keep normal chat fast; not every message should become a task.
2. Detect clear requests for multi-step work and offer or invoke planning according to explicit user intent.
3. Use the objective endpoint rather than implementing a second decomposition engine.
4. Show an editable/inspectable plan card: objective, tasks, dependencies, assigned teammates, risks, and approval needs.
5. Let the user approve, edit, or cancel the plan before execution when appropriate.
6. Keep the conversation connected to the resulting board/tasks/runs.

### P1 — Build live execution and deliverables views

Show, in one coherent view:
- Objective and plan.
- Teammates assigned and their current status.
- Task dependencies and progress.
- Live run events and useful logs.
- Blockers, retries, and approval requests.
- Files changed, test results, artifacts, reports, and final outputs.

Do not show raw event streams as the primary UX. Translate them into clear activity and status while retaining a technical-details view.

### P1 — Background reliability

1. Verify executor lifecycle and scheduling on the VPS.
2. Make startup, shutdown, concurrency, retries, and crash recovery safe.
3. Prevent duplicate task claims and duplicate scheduled runs.
4. Add health/heartbeat visibility and useful alerts.
5. Test that work continues when the browser is closed.

### P2 — Memory and knowledge

1. First make existing knowledge retrieval available to agents.
2. Improve retrieval quality and add provenance/source references.
3. Evaluate semantic/vector retrieval only after measuring the current retrieval failures.
4. Separate project knowledge, teammate memory, and user preferences.
5. Add explicit controls for what is stored, shared, and retrieved.

### P3 — Studio and advanced integrations

Add image/video generation only after the core workforce loop works. Use provider adapters so services can be swapped. Track jobs, prompts, assets, versions, costs/limits, and outputs. Do not hardwire a single vendor into the orchestration core.

## 4. Target user experience

Organize the product around these experiences:

1. **Command Center** — chat, objectives, plans, recent work, attention needed.
2. **Workforce** — teammate profiles, roles, skills, tools, models, permissions, memory, availability.
3. **Execution** — live plans, task graph, delegation, run activity, approvals, retries.
4. **Projects** — project context, files, knowledge, integrations, schedules.
5. **Deliverables** — final outputs, reports, code changes, artifacts, tests, PR packages.
6. **Studio** — future image/video/creative workflows.
7. **Control Room** — providers, models, routing, system health, permissions, background workers.

Preserve useful existing pages and components where possible. Reorganize them around workflows; do not rewrite the backend or discard working infrastructure just for visual consistency.

## 5. Architecture rules

- Keep FastAPI as the backend and the existing React dashboard unless repository evidence justifies a change.
- Reuse existing tasks, runs, boards, delegations, approvals, workspace, artifact, memory, and provider abstractions.
- Have one canonical orchestration path. Do not create competing planners or parallel task systems.
- Keep the objective endpoint as the entry point for planned work; evolve it deliberately and maintain API compatibility.
- Model routing must be deterministic, observable, and tested: teammate override → configured project/default policy → explicit fallback. Follow the actual repository's intended precedence if already documented.
- Tools must be permission-checked server-side.
- Keep secrets out of prompts, logs, artifacts, and frontend bundles.
- Use approval gates for privileged/destructive actions.
- Make long-running operations asynchronous and observable.
- Persist enough state to recover after process/browser restarts.
- Every important action should have traceable objective/task/run/agent provenance.
- Prefer small, tested changes over large rewrites.

## 6. Definition of done for the first complete vertical slice

Test this exact scenario:

**User objective:** “Research the market for DriftLock, identify five relevant competitors, create a concise comparison, then build a simple landing page in the connected repository and run its tests.”

Expected behavior:

1. NerdBot understands the objective and creates a multi-step plan.
2. Plan identifies research, synthesis, implementation, and verification tasks.
3. Appropriate teammates are assigned, with correct model/provider choices.
4. Research agent can search the web and preserve source links.
5. Agents can retrieve relevant project knowledge when available.
6. Engineer can read/edit files and run permitted commands in the workspace.
7. Dependencies are respected; synthesis waits for research, verification waits for implementation.
8. User sees live, understandable progress and can inspect each teammate's work.
9. Failures are visible, actionable, and retryable without duplicating completed work.
10. Approval is requested before privileged actions.
11. Final result includes competitor comparison with sources, changed files/diff, test results, and clear remaining limitations.
12. Refreshing the browser or restarting the worker does not silently lose or duplicate work.

This is the first milestone. Do not add more ambitious capabilities until it passes reliably.

## 7. How to work on the repository

At the start of every coding session:

1. Read `docs/architecture/nerdbot-2.0-blueprint.md` and this handoff.
2. Check `git status`, recent commits, and existing tests.
3. Inspect the actual current implementation; do not trust this document over code.
4. Identify the smallest next milestone and the files it touches.
5. Write a short implementation plan before editing.
6. Implement one coherent change.
7. Run relevant unit, integration, type, lint, and frontend tests.
8. Add tests for regressions and failure cases.
9. Update the blueprint with completed work, evidence, and next steps.
10. Report exact files changed, commands/tests run, results, known gaps, and the next task.

If a test cannot be run, say why. Never claim success based only on code inspection.

## 8. First tasks to execute now

1. **Verify the four reported changes** (blueprint, model routing, objective endpoint, Plan & execute UI) against code and tests.
2. **Fix any defects found** and add regression tests.
3. **Expose web search and knowledge retrieval in the agent tool loop**, with permissions and provenance.
4. **Add chat objective detection and plan cards**, reusing the objective endpoint.
5. **Build the live execution/deliverables view** around existing events, runs, and artifacts.
6. **Run the vertical-slice acceptance scenario** and record evidence.

## 9. Working agreement for any future AI coding agent

You are the engineering agent for NerdBot 2.0. Work directly in the existing repository. Be honest about what you can access. Do not invent files, endpoints, test results, integrations, or completed work. Do not replace working architecture without evidence and an explicit reason. Prioritize a reliable end-to-end objective execution loop over cosmetic changes or feature breadth.

At the end of each session, leave the repository in a coherent state and update this handoff or the main blueprint so another agent can continue without relying on chat history.

## Recent milestone progress (2026-11-05)

- Repository audit completed; full test suite restored to green (479 passed).
- Baseline defect fixed: `provider_block_reason(None)` no longer blocks plain
  command tasks, restoring `test_phase1_slice`.
- Backup import allowlist updated for teammate model/fallback columns.
- Executor sweep now honors `select_provider_for_teammate`, including configured
  fallback providers.
- Web search and project knowledge exposed as permission-gated app tools:
  `web_search` (`web.search`), `read_knowledge` / `attach_knowledge`
  (`knowledge.read`), `ingest_knowledge` (`knowledge.write`).
- Server-side permission enforcement added for base `web_search` when an acting
  teammate is present.
- All targeted tests pass (agent tools, search, provider agent loop, sweep).

Next: chat objective detection and editable plan cards (P1), then live execution
and deliverables views.

## Milestone: live execution + deliverables view (2026-11-05)

- Added `GET /boards/{board_id}/execution` aggregating tasks, latest runs, and
  artifacts/deliverables for a board (objective).
- Board detail view now renders an "Execution & deliverables" section: task
  status, latest run status/exit code, artifact counts, and a deliverables
  table. Task rows link to the task workbench.
- Backend now blocks explicitly when a task has neither a command nor a
  provider/model, instead of failing as "empty command".
- Frontend typecheck, tests (152), and production build pass.

Next: chat objective detection and editable plan cards.

## Milestone: chat objective-aware plan cards (2026-11-05)

- Backend `POST /projects/{id}/objectives` now supports `preview: true` (side-effect-free
  plan) and `plan` (materialize an exact reviewed plan), reusing the existing
  decomposition preview/materialize flow.
- Added `chat.is_objective_message` heuristic for objective-like requests.
- Thread view detects objective-like messages, fetches a plan preview, and renders
  an editable plan card with Approve & execute / Cancel. Approving materializes
  the reviewed plan and navigates to the resulting board.
- Frontend typecheck, tests (152), and build pass.
