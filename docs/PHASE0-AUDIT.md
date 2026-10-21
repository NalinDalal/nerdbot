# Phase 0 Audit — Nerdbot Repository Reconnaissance

Source of truth: inspected the running repository at `/Users/nalindalal/nerdbot`.
- Dashboard: React 19 + Vite, raw CSS (no Tailwind), served by FastAPI backend on port 8080.
- Backend: FastAPI, SQLite (WAL mode), isolated Git task workspaces under `.nerdbot-data/workspaces/`.
- Auth: bearer token, fail-closed (HTTP 503 without `NERDBOT_TOKEN`), `NERDBOT_INSECURE_DEV_TOKEN=1` dev opt-in.
- All 351 backend tests pass; all 42 frontend tests pass; eslint, tsc, ruff, mypy, vite build all green.
- Verified end-to-end against a live server: Home chat without a project, mock provider streaming, thread persistence, teammate creation, task execution with isolated workspace, real fail-closed results (not faked).

## 1. Architecture and entry points

The FastAPI backend (`uv run nerdbot run`, port 8080) serves both the REST/SSE API and the built React dashboard (`dist/`). The dashboard dev server runs on port 5173 proxied to 8080.

Routes (hash-based, `dashboard/src/app.tsx`):
- `#/` → `ConversationView` — the chat entry point (chat-first, project-optional).
- `#/chat/<projectId>` → `ConversationView` scoped to a project.
- `#/workstation` → `WorkstationView` — fleet overview: all bots with status, new task/bot creation, executor sweep. (Not currently linked from the sidebar.)
- `#/projects` → `ProjectsView` — workspace directory, create/open workspaces.
- `#/p/<id>` → `ProjectDetailView` — 14 tabs: Tasks, Chat, Teammates, Providers, Issues, Knowledge, Schedules, Approvals, Messages, Notifications, Memory, Backup, Metrics, Events.
- `#/p/<id>/t/<taskId>` → `TaskDetailView` — task runs, artifacts, diffs, reviews, PR packages, delegation tree.
- `#/teams`, `#/team/<id>` → TeamsView, TeamDetailView.
- `#/bots`, `#/bot/<id>` → BotsView, BotDetailView.
- `#/boards`, `#/board/<id>` → BoardsView, BoardDetailView.
- `#/settings` → SettingsView — server health, BYOK secret-key posture, where things live.

## 2. Route-by-route UX assessment

| Route | Assessment | Primary issue |
|-------|-----------|---------------|
| `#/` (Home chat) | Implemented, chat-first. Streaming composer, stop/retry, file attachments, execution view, bot selection. | First-run empty state is generic ("Select a conversation"); no onboarding or model-setup guidance when no provider exists. |
| `#/chat/<projectId>` | Project-scoped conversation. | Same as Home; no project context banner. |
| `#/workstation` | Fleet overview with real bot status, task creation, sweep. | Orphaned — not reachable from sidebar nav; duplicate of Projects + Bots concepts. |
| `#/projects` | Workspace directory + create. Functional but bare. | "New workspace" asks for a raw `prj_…` ID; no repository selection or friendly creation flow. |
| `#/p/<id>` | 14-tab project dashboard. | **P0 problem:** tab bar is a miniature copy of the entire backend; overwhelms the conversation. |
| `#/p/<id>/t/<taskId>` | Task detail with runs/artifacts/diffs/reviews/pr-packages/delegations. | Real and useful; execution statuses shown via StatusBadge. |
| `#/teams` / `#/team/<id>` | Team directory + detail. | Real but disconnected from the chat flow; no "delegate to team" entry from conversation. |
| `#/bots` / `#/bot/<id>` | Bot directory + detail (tasks, runs, memory, claim). | Real; bot creation uses a generic `EntityForm`. |
| `#/boards` / `#/board/<id>` | Board directory + detail with decompose flow. | Real but conceptually overlaps with teams/projects; unclear distinct value. |
| `#/settings` | Server health + BYOK posture. | Only server-level state; no model/provider configuration UI (providers live inside each project's Providers tab). |

## 3. Ten most consequential product/UX problems (ranked by user impact)

1. **Projects feel mandatory.** The project detail view is the "center of gravity" with 14 tabs; chat is tucked inside as one tab. New users must navigate to Projects before feeling oriented, contradicting the "chat without a project" promise.
2. **The 14-tab project dashboard is a backend dump.** One tab per backend entity (Tasks, Chat, Teammates, Providers, Issues, Knowledge, Schedules, Approvals, Messages, Notifications, Memory, Backup, Metrics, Events). No progressive disclosure; every entity competes for equal attention.
3. **No coherent command center.** `#/workstation` exists but is orphaned (not in sidebar). Users have no single obvious place to see active runs, pending approvals, and recent conversations together.
4. **Provider configuration is buried.** Models/connections are per-project under the Providers tab, but there's no "configure your first model" onboarding when none exists. The Settings view only reports server health, not provider setup.
5. **Execution status is fragmented.** Task runs live on the task page; the conversation's execution view is compact but disconnected from the project task list. No unified "what's running right now" surface.
6. **Inconsistent component density.** Project/team/board lists use `card`-in-`card` patterns; chat uses message bubbles; settings mixes cards, logs, and inline text. No shared design language.
7. **Empty states are thin.** "No conversations yet," "No teams yet," "No workspaces yet" all lack a clear next action tied to real functionality.
8. **No mobile layout.** Single fixed 260px sidebar grid (`grid-template-columns: 260px 1fr`) with no mobile collapse/drawer; the composer and message list don't reflow intentionally below 760px.
9. **No design system tokens.** Raw CSS with hand-written values; no spacing scale, type scale, or component tokens. High risk of visual drift as views are added.
10. **Interaction states incomplete.** Hover/focus/pressed states exist on buttons but not consistently across selects, tabs, list items, or destructive actions; no keyboard navigation audit.

## 4. Existing capabilities that must be preserved

- Project-optional Home chat (threads resolve a default Home project via `/home`).
- Streaming chat (`/threads/:id/chat/stream`) with stop/retry, provider switching per thread, thread summaries.
- File/context attachments in conversation.
- Task creation from conversation; task lifecycle (pending/running/done/failed/blocked), retry = new run, cancellation.
- Isolated Git task workspaces; workspace files, diffs, artifacts, reviews, PR packages.
- Delegation tree (delegate task → child task → result via response channel).
- Approvals (409 gates; reject / approve once / approve forever), enforced server-side.
- Teammates/bots: persona, instructions, capabilities, permissions, memory_scope, provider, tool_policy; per-task isolated execution.
- Teams, boards, messages/response channel, knowledge, schedules, notifications, webhooks.
- Providers per project (OpenAI-compatible, local, mock); Fernet-encrypted secrets at rest when `NERDBOT_SECRET_KEY` is set.
- Auth/authorization: bearer token, project ownership enforcement, fail-closed.

## 5. Highest-risk regressions to guard against

- Breaking the `/home` → project resolution that enables project-free chat.
- Breaking 409 approval gating in `describeError` / `ApiError.approval` (callers must surface the approval, not dump JSON).
- Weakening project ownership checks (every thread/task endpoint enforces ownership server-side).
- Leaking project context into unrelated chats (project-scoped memory/threads must stay explicit).
- Introducing mock/faked execution status or fabricated task results.
- Breaking encrypted secret handling (maskSecrets, Fernet, api_key_env).
- Breaking the 351 backend / 42 frontend tests, lint, tsc, ruff, mypy, vite build.

## 6. Recommended product hierarchy and design direction

WORK
- Home / Command Center (`#/`) — chat entry, recent conversations, active runs + approvals needing attention.
- Workspaces / Projects (`#/projects`, `#/p/<id>`) — optional context for sustained work.
- Tasks / Runs (`#/p/<id>/t/<taskId>`) — execution detail, artifacts, diffs, delegation tree.

AI FLEET
- Agents (`#/bots`, `#/bot/<id>`) — persistent specialists, real status, task history.
- Teams (`#/teams`, `#/team/<id>`) — coordination; delegation, handoffs, approvals.
- Boards — keep only if it adds a distinct workflow beyond tasks/projects (currently overlaps).

CONFIGURE
- Models & Connections — provider setup moved toward onboarding + Settings; per-project providers preserved.
- Settings — server state, BYOK posture, connection status.

Design direction: dark, calm, focused (already implemented in styles.css). One accent, cool gray family, system-ui font (Inter banned), flat/barely-rounded buttons, whitespace over borders/shadows, no em dashes, house-style law.

## 7. Phased implementation plan with acceptance criteria

Phase 1 — Product positioning and information architecture (next). Deliver: product brief, sitemap, primary user flows, navigation spec.
Phase 2 — Design system. Deliver: token scale (spacing, type, radius, color), shared components, DESIGN.md rationale.
Phase 3 — Command Center / Home redesign. Acceptance: first screen states A–H handled; primary composer obvious; chat without project; no fake statuses.
Phase 4 — Application shell and navigation. Acceptance: consistent shell across routes, mobile drawer, active states, no duplicate navigation.
Phase 5 — AI fleet and agent management. Acceptance: agent directory, staged creation, real statuses, no implied capabilities.
Phase 6 — Workspaces, tasks, execution. Acceptance: clear task states, execution view answers the 7 questions, failures actionable.
Phase 7 — Teams and collaboration. Acceptance: honest team status, no fake interactive builder.
Phase 8 — Boards, models, connections, settings. Acceptance: provider setup understandable, boards justified or demoted.
Phase 9 — ReactBits and purposeful motion. Acceptance: motion only where it communicates state; reduced-motion respected.
Phase 10 — Accessibility, responsiveness, consistency. Acceptance: 7 viewports, keyboard nav, focus, contrast AA, reduced motion.
Phase 11 — Tests, fixes, regression checks. Acceptance: browser-based critical-flow tests, lint/build/test green.
Phase 12 — Final product review. Acceptance: the 12 final review questions answered honestly.
