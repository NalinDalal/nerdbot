# NerdBot Current-State Handoff (evidence-backed)

**Audit date:** 2026-11-10  
**Scope:** Repository and running UI/backend evidence for external product/design review. **Audit only** — no product code changes, no redesign implementation, no R4 work performed in this task.  
**Latest reported checkpoint verified:** `6d325a7d3b865071e020835d8ce6cdf969c2cebe` (present).  
**References (experience intent, not verified specs):** Odysseus/Octop (workspace depth) and Grok bots (bot identity/customization). Ambiguities listed in §8; no behavior invented for those products.

## 1. Repository state (verified)

| Item | Evidence |
|---|---|
| Branch | `main` (`git branch --show-current`) |
| HEAD | `6d325a7d3b865071e020835d8ce6cdf969c2cebe` (`git rev-parse HEAD`) |
| Recent commits (10) | `6d325a7` chore: add R1-R3 browser smoke verification and clarify workspace copy; `08f872b` feat: add workspace operating dashboard overview for R3; `086576e` feat: introduce home operating overview and align global navigation; `73296a0` docs: add product experience reassessment before redesign; `b5c8a8c` feat: clarify global and workspace chat scope; `07576a0` feat: refine shell accessibility and focus states; `f808c51` chore: add IA decisions and P0 verification fixes; `00ac545` feat: complete Phase 5 conversation management and jobs polish; `bdc0a94` feat: complete Phase 4 library/gallery polish and flows; `3116a46` feat: add Phase 4 library editor v1 foundations and gallery assets |
| Working tree | **Clean** (`git status --short --branch` → `## main...origin/main [ahead 2]`, no staged/unstaged/untracked changes at audit capture) |
| Repo structure (top-level) | `backend/` (FastAPI/Python), `dashboard/` (React/Vite/TS), `docs/` (architecture, ADRs, plans, audits, reassessment), `tests/` (pytest), `scripts/`, `workspace_manager/`, local/runtime dirs present (`.nerdbot-data/`, `.venv/`, `dashboard/dist/`, `workspaces/`, caches) — treat runtime/build dirs as local state, not source of truth |

### Stack
- **Backend:** Python 3.12+, FastAPI, uvicorn, Pydantic v2, SQLite (WAL), Click CLI, httpx, cryptography (`pyproject.toml`). App/API: `backend/src/nerdbot/api.py` (FastAPI, ~207 registered REST/SSE routes), persistence `store.py` (schema init + repositories), domain `models.py`, execution/orchestration `orchestrator.py`, `executor.py`, `runtime.py`, `agent_tools.py`, `app_tools.py`, chat `chat.py`, approvals/gates `approval_flow.py`/`gates.py`/`permissions.py`, providers/research/library/gallery/workspace/memory/skills/schedules/notifications/etc.
- **Frontend:** React 19, Vite 6, TypeScript 5, Tailwind 3, xterm, sonner (`dashboard/package.json`). SPA served by backend from `dashboard/dist` in production mode; dev via Vite.
- **Testing:** pytest (`tests/`, extensive unit/integration/e2e-ish API tests), Vitest (`dashboard/src/**/*.test.ts`), Playwright deps/specs + smoke scripts (`dashboard/tests/*.spec.ts`, `dashboard/verify-r1-r3.mjs`, `dashboard/verify-phase45.mjs` legacy).

### Startup commands (from README/CLI; verified by inspection and used in audit)
- Backend: `uv sync --group dev`; set `NERDBOT_TOKEN` (or `NERDBOT_INSECURE_DEV_TOKEN=1` for local dev), optional `NERDBOT_SECRET_KEY`, `NERDBOT_DB`, `NERDBOT_DATA`, `NERDBOT_RUN_TIMEOUT_S`; `uv run nerdbot run [--host 127.0.0.1 --port 8080]`.
- Dashboard dev: `cd dashboard && npm install && npm run dev` (Vite, proxies/API as configured). Build: `npm run build` (tsc + vite → `dist/`, served by backend).
- Ops/automation: `nerdbot executor-sweep`, `nerdbot fire-due`, `nerdbot deliveries-sweep`, `nerdbot ingest-issue`.
- Verification commands (repo): backend `uv run pytest -q`, `uv run ruff check backend/src/ tests/`, `uv run mypy`; dashboard `npm run test`, `npm run lint`, `npx tsc --noEmit`, `npm run build`.

### Relevant product/design documents
- Product/IA: `docs/PRODUCT-EXPERIENCE-REASSESSMENT.md` (approved direction R1–R5, gaps/sequence), `docs/IA-DECISION.md`, `docs/PRODUCT-RESEARCH-2026-10-21.md`, `docs/PRODUCT-EXPERIENCE-REASSESSMENT.md` context, `docs/PLAN.md`, `docs/phase*`/`docs/PHASE1-PRODUCT-BRIEF.md`.
- Architecture/ADRs: `docs/ARCHITECTURE.md`, `docs/current-architecture.md`, `docs/decisions/0001–0015*` (workspace isolation, shell/approval policy, bot faces/motion, approval workflow/action binding, task-run prompt, workspace IA, etc.).
- Audits/verification: `docs/WORKBENCH-AUDIT-2026-10-26.md`, `docs/audits/*`, `docs/ACCEPTANCE-*`, prior phase audits.
- Design guidance referenced by product docs: `https://github.com/NalinDalal/skillset` → `skills/ui/ui-core/SKILL.md`, `skills/ui/house-style/SKILL.md`, `curations/impeccable/overlay/SKILL.md` (**not present in this repository**; accessibility/follow-through assessed in UI-EVIDENCE.md §design guidance).

## 2. Actual execution lifecycle (as implemented; evidence-based)

**Intended/implemented flow:** User assigns work → agent/model selection → permissions/tools → execution → progress/events → approval/recovery → persisted outcome.

| Stage | Implementation evidence | Notes |
|---|---|---|
| Work creation/assignment | Tasks created via API/UI (`POST /projects/{id}/tasks`, task creation from chat/tools/decomposition/delegation); owner/team/board/context fields in `models.Task`, store/API; delegation `store/delegation.py`, `POST /tasks/{id}/delegate`, `POST /delegations/{id}/decide` | Manual/UI/API or agent-driven (tool-gated) creation/assignment. |
| Agent/model selection | `orchestrator.schedule_run` resolves owner teammate/provider/model/fallback (`providers.resolve_run_provider`, `select_provider_for_teammate`), blocks if owner inactive or no runnable command/model/provider; run records `provider_id`/runtime | Selection is server-side per task owner + configured providers/bindings. |
| Permissions/tools | `permissions.py`, `gates.py`, `app_tools.py` (tool schemas filtered by permissions, `TOOL_PERMISSIONS`/`AMBIENT_TOOLS`, gate checks), `agent_tools.py` (workspace-bound tools: run_command/read_file/write_file/persona/memory/fetch/search with path/size/guardrail limits), `approval_flow.py` (digest-bound, resumable approvals) | Admin/mutating actions default-deny/approval-gated unless policy allows; shell runs under workspace/deny-list/run-boundary policy (ADR 0009), not per-command approval. |
| Execution | `orchestrator` prepares workspace (`workspace.py`, checkout vs live workspace modes), marks running, builds `agent_context`, executes via runtime adapter (`LocalRuntimeAdapter` in `runtime.py`, polling/cancel token/process-group kill) and/or model tool loop/provider paths; artifacts/events emitted via `emit_event`/`run_events` | Synchronous `POST /tasks/{id}/runs`, async `POST /tasks/{id}/runs/async` (API), and sweeps (`executor.py`, CLI/API) can drive runs. |
| Progress/events | `run_events` broker + `store.append_run_event`; `GET /runs/{id}/events`, `GET /runs/{id}/events/stream` (SSE, resume), dashboard task view streams/polls | Event persistence + live fan-out; UI falls back to polling if stream unavailable. |
| Approval/recovery | `POST /runs/{id}/approvals`, `GET /approvals`, `POST /approvals/{id}/decision`, `POST /approvals/{id}/reask`, `POST /approvals/sweep`, `approval_flow.recover` (called in executor sweep), inbox/resume semantics per ADR 0011/0012 | Decisions can carry out exact gated action (one-use binding) when resumable; recovery depends on triggers (sweep/API/manual) — see gaps. |
| Persisted outcome | Runs, artifacts, reviews, PR packages, workspace files/diffs, task statuses, events, reports/research outputs, library/gallery documents/assets persisted in SQLite/store + data dirs | Outcomes are inspectable via API/UI where surfaced; completeness of “deliverable” aggregation varies.

**Manual triggers / workers / disconnected or conditional steps (evidence):**
- **`nerdbot executor-sweep` / `POST /executor/sweep`:** claims pending unowned tasks to available bots and runs them; also fires due schedules/reminders and runs approval recovery as part of sweep (`executor.py`, CLI). Not continuously running unless invoked (CLI/cron/endpoint) or process-level automation enabled.
- **`nerdbot fire-due` / `POST /schedules/sweep` and reminder/job sweeps:** schedule/reminder firing is heartbeat-driven by invocations/sweeps (CLI/API), not an implicit always-on guarantee without a runner.
- **`NERDBOT_EXECUTOR=1`:** opt-in background executor loop noted in README/CLI behavior context; autonomous continuous execution is conditional.
- **`POST /tasks/{id}/runs` vs async:** synchronous run endpoint executes in request path; async endpoint schedules background execution (API). UI/task flows may rely on specific path.
- **Actual model execution:** requires configured reachable provider/credentials/model; mock provider supports zero-setup chat/flows in limited cases, but live agent tool-execution quality depends on real provider integration and environment.

## 3. High-level capability and UI posture (summary)

Detailed evidence: **CAPABILITY-MATRIX.md**. Visual/product evidence: **UI-EVIDENCE.md**. Prioritized gaps: **GAP-LIST.md**.

- **Strongest implemented backend domains (by code/routes/tests):** projects/workspaces, tasks/runs/events/artifacts/reviews/PR packages, approvals/inbox/resume, teammates/personas/faces/memory tiers/skills bindings, providers (BYOK/config/health/models, secret handling), chat threads/messages/streaming/management, library docs/versions/access/export, gallery assets, knowledge ingestion/search/attach, schedules/reminders/jobs/research, boards/teams/delegations, workspace files/diff/terminal, backup/metrics/events/notifications/webhooks, permissions/capabilities endpoints.
- **Frontend exposure:** R1–R3 realigned global nav (Home, Workspaces, Agents, Work, Chat, Library, Settings) and workspace operating overview; many capabilities remain reachable but **buried/contextual/technical** (workspace Advanced tabs, Workbench, Settings/Capabilities, deep routes). Chat and IDE/workbench conventions still dominate parts of the experience outside the new overview surfaces.
- **Cohesion:** improving at Home/Workspace overview slices, but product still reads as multiple generations (operating overview + admin tabs + IDE/workbench + legacy copy/flows) rather than one fully integrated teammate-operating product.

## 4. Verification evidence (executed in this audit context) and reconciliation

**Executed (isolated environment, no production data):**
- Repo inspection: git state/structure, route/model/service/frontend inventory, doc review.
- Isolated backend+SPA run: `NERDBOT_DB=/tmp/nerdbot-r3-verify/nerdbot.db NERDBOT_DATA=/tmp/nerdbot-r3-verify/data NERDBOT_INSECURE_DEV_TOKEN=1 uv run nerdbot run --host 127.0.0.1 --port 8765` (health OK, dev auth).
- Labeled fixture seeding in isolated DB (projects/tasks/agent/approval/library/gallery) via `uv run python` + `nerdbot.store`/SQL (scripted in `/tmp`, fixtures explicitly labeled `[TEST FIXTURE]`).
- Browser capture/verification (Playwright Chromium headless, cached): screenshots saved durably under `docs/audit-evidence/r1-r3-handoff/screenshots/` and recording `docs/audit-evidence/r1-r3-handoff/recording/home-workspace-agent-task-deliverable-fixture.webm` with `journey-notes.txt`.
- Prior increment checks executed and recorded (from `6d325a7` context, re-validated by commands in this session): `tsc --noEmit` PASS; `dashboard npm test` **22 files / 191 tests PASS**; `dashboard npm run build` **PASS** (pre-existing chunk-size warning); `dashboard/verify-r1-r3.mjs` smoke **20/20 PASS** against isolated fixtures.

**R1–R3 gate reconciliation (explicit):**
- **Library document hard-navigation/API route collision:** **confirmed**. `GET /library/{doc_id}` API route is matched before SPA fallback when serving same-origin, so direct browser hard-navigation/refresh to `/library/:docId` returns API 401 without bearer auth; SPA client-side navigation (in-app deliverable click) works. Evidence: browser response capture during smoke + `backend/src/nerdbot/api.py` route ordering/fallback.
- **Partial-source-failure browser behavior:** **not visually fault-injected in browser this audit**; handling implemented in workspace overview (`Promise.allSettled`, per-source unavailable states/retry, no fabricated zeros) and **unit-tested** (`dashboard/src/views-project/overview.test.ts`). Visual capture remains a verification gap.
- **Conversation-operation coverage:** route/scope/navigation smoke covered; **full Phase 5 operation matrix (rename/pin/archive/unarchive/move/delete/restore/export/search/filter/recents/provider-binding-cleared-on-move semantics) not exhaustively browser-verified** in this run (historical/feature implementation evidence exists in prior commits/tests/docs).
- **Keyboard/focus and reduced-motion verification:** **smoke-level** (Tab moved focus in headless run; reduced-motion media emulation render smoke). No comprehensive focus-order/visible-focus audit across all components/themes or reduced-motion visual parity review.
- **Mission persistence and partial deliverables aggregation:** **unimplemented by design/evidence**. No canonical `Project` mission field/API; workspace overview shows honest empty state. Deliverables overview aggregates **Library + Gallery** only (bounded), not all task/run artifacts/PR packages/outputs.

**Historical vs executed vs recommended (distinguished):**
- **Historical (reported in repo/docs/commits, not rerun here):** backend full suite `uv run pytest -q` previously reported **534 passed, 1 warning** at R1/R2/R3 checkpoints; Phase 4/5 smoke/API checks reported in prior commits/docs.
- **Executed now/in this audit:** repo/state inspection, isolated run + fixture seeding, Playwright screenshot/recording capture, dashboard tests/tsc/build, R1–R3 smoke script behavior, targeted browser checks above.
- **Recommended:** rerun full backend/frontend lint/type/test matrices in current environment; exhaustive browser E2E for critical journeys (chat ops, approvals decision+resume, live task run with real/mock provider, workspace tools), accessibility (WCAG/focus/reduced-motion), fault-injected partial-failure UI states, and deep-link audit across SPA/API collisions.

**Debt labeling:** “Pre-existing” is used only where baseline evidence exists (e.g. chunk-size warning consistent across builds, long-standing route-collision/API-SPA serving behavior evidenced by current route structure; README drift predates this audit). Where baseline is unclear, items are listed as **observed/unknown baseline**.

## 5. Factual summary (what NerdBot can do today)

- **Can do (implemented, with varying verification):** host a single-owner authenticated workspace app (FastAPI+SQLite+React SPA) with projects/workspaces, persistent teammates/agents (identity/persona/permissions/provider bindings/faces/memory/skills constructs), tasks/runs/events/artifacts/reviews/PR packages and isolated or live workspace execution modes, approval-gated admin/resumable actions, chat threads (global/workspace scoped) with provider-backed responses/streaming and conversation management features, Library/Gallery documents and assets, knowledge/memory/schedules/reminders/research/jobs/notifications/webhooks/boards/teams/delegation APIs and UIs in varying depth, plus contextual workbench/files/terminal tooling.
- **Users can discover and use (current UX):** Home operating overview and workspace operating dashboard (R1–R3) for attention/active work/agents/deliverables/navigation entry points; global nav to Workspaces/Agents/Work/Chat/Library/Settings; workspace tabs/advanced tools; direct chat, task/work views, agent/bot pages, library/gallery, settings/providers/capabilities, workbench. Many powerful capabilities remain **buried in advanced tabs, technical screens, or API-level concepts**.
- **Why it currently fails to feel cohesive:** the product combines multiple UI generations and mental models (new overview surfaces, legacy admin/tabbed workspace internals, IDE-like workbench, chat-centric flows, technical terminology and duplicated concepts). Agents and outcomes are only partially presented as first-class teammates/work products; navigation and scope transitions can be cognitively split; visual language and interaction patterns are not yet unified across all surfaces; several core intents (mission, full deliverables, authoritative availability, seamless execution/assignment narratives) are constrained by missing or unaggregated data and partial UI integration. See **UI-EVIDENCE.md** and **GAP-LIST.md** for specifics.
