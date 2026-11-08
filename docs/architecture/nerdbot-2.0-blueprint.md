# NerdBot 2.0 — From Agent Dashboard to Autonomous AI Workforce

## North star
NerdBot is a personal AI operating system: an intelligent command center that
plans objectives, delegates to specialized AI teammates, monitors execution, and
delivers real artifacts — while keeping the human in control through approvals.

The user should never have to understand projects, tasks, runs, delegations,
boards, providers or memory tiers to get work done. Those are implementation
details behind a workforce experience.

## Principles
1. Preserve the FastAPI + SQLite + React stack; do not rebuild the framework.
2. Fix the brain first, then the interface.
3. One complete vertical slice before broad redesign.
4. Hide machinery; surface objectives, plans, agents, progress, deliverables.
5. Fail-closed safety and approvals remain non-negotiable.

## Preserve (already sound)
- Auth (bearer token), projects, providers, teammates, tasks, runs.
- Isolated per-task Git workspaces and workspace locks.
- Run event streaming (SSE) and durable event log.
- Approval flow that actually carries out approved actions.
- Delegation lifecycle with bounds.
- LLM decomposition (`decomposition.py`).
- Provider adapters, health checks, retries, model routing metadata.
- Knowledge ingestion/retrieval, memory tiers, persona files.
- Boards, teams, notifications, schedules, backup, metrics, terminal.

## Phase 0 — Capability wiring (brain fixes)
Goal: make stored capabilities actually affect execution.

- [x] Wire teammate `model`, `fallback_provider_id`, `fallback_model` into
      `resolve_run_provider` (via `select_provider_for_teammate`).
- [x] Wire `teammate.model` override into adapter config (done in resolve_run_provider).
- [x] Expose web search as an agent tool (wrap `search.py` in `app_tools`),
      permission-gated via `web.search`.
- [x] Expose knowledge retrieve/attach as agent tools (`read_knowledge`,
      `attach_knowledge`, `ingest_knowledge`).
- [x] Make decomposition available from chat/objective flow (preview + materialize).
- [x] Use `select_provider_for_teammate` in executor sweep (fallbacks honored).
- [ ] Apply model override in chat providers when teammate context exists.

## Phase 1 — Unified orchestration (NerdBot as chief of staff)
Goal: a user objective becomes a plan, delegation, execution, monitoring, and
deliverables without manual task creation.

Components:
- `orchestrator.understand_objective(conn, project_id, objective)`:
  builds context (available teammates, capabilities, providers, knowledge).
- `orchestrator.plan(conn, ...)`:
  reuses `decomposition.plan_objective` to produce a validated Plan.
- `orchestrator.delegate(conn, plan)`:
  materializes tasks with owners via `materialize_plan`, sets up board.
- `orchestrator.monitor(conn, board_id)`:
  tracks task/run status, surfaces blockers and approvals.
- `orchestrator.deliver(conn, board_id)`:
  collects artifacts, diffs, reports, and presents them.

API:
- `POST /objectives` (or extend chat) — submit objective, returns plan preview.
- `POST /objectives/{id}/approve` — materialize + execute.
- `GET /objectives/{id}` — status, tasks, agents, deliverables.

Chat integration:
- Detect objective-like messages ("build", "research", "launch").
- Return a plan card instead of a plain reply.
- Allow "Execute" action.

## Phase 2 — Workforce experience
Goal: teammates feel like employees.

- Profile pages: identity, role, skills, model, memory, task history, comms.
- Status: available/busy/blocked, current objective, KPIs.
- Communication: teammate-to-teammate messages and NerdBot help requests.
- Memory view per teammate + shared project memory.

## Phase 3 — Objective-driven Command Center
Goal: Home is a command center, not a chatbot.

- Hero: "What should we accomplish?" + objective input.
- Plan preview with editable steps and agent assignment.
- Live execution timeline: agents, tasks, progress, blockers, approvals.
- Deliverables panel: files, diffs, reports, links.
- Recent objectives and outcomes.

## Phase 4 — Live delegation and execution visualization
- SSE already streams run events; build a unified execution view per objective.
- Show agent ownership, dependencies, retries, approvals.
- Intervene: pause, retry, reassign, approve.

## Phase 5 — Memory and knowledge integration
- Auto-recall relevant memory/knowledge into objective planning.
- Persist decisions and learnings per objective.
- Semantic search (future: embeddings) — for now improve token retrieval.

## Phase 6 — Deliverables experience
- Collect artifacts by objective/board.
- Show diffs, tests, reports, generated assets.
- Export package (zip/PR).

## Phase 7 — Creative Studio (P3)
- Add image/video generation providers and tools.
- Asset library and timelines.

## Phase 8 — Advanced integrations (P3)
- Email/Slack notifications (currently stubs).
- More GitHub write operations (PR creation).

## Acceptance test (vertical slice)
User: "Build a landing page for DriftLock."
Expected:
1. NerdBot returns a plan with research, design, implementation, review steps.
2. Steps assigned to Researcher/Engineer/QA.
3. Tasks materialize and execute via executor.
4. Live progress visible.
5. Approval requested for any gated action.
6. Final deliverable: landing page files + diff + summary.

## Tracking
Track as NerdBot 2.0 milestones. Do not rebuild endpoints; wire existing ones
into the orchestration and presentation layers.