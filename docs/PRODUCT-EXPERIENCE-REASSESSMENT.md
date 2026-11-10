# NerdBot Product Experience Reassessment

**Status:** Draft for review (pre-implementation)  
**Date:** 2026-11-10  
**Scope:** Reassess product experience against the intended “AI teammate operating environment” before further Stage B/C UI redesign. This document is grounded in the current implementation (frontend routes/views and backend models/APIs) as of `b5c8a8c`.

**Constraint:** Pause broad Chat polish and component styling. Do not start broad redesign implementation until this direction is reviewed. Preserve existing Phase 1–9 functionality, routes, and deep links unless an explicit migration plan is approved.

---

## 1. Audit: current experience vs intended experience

### 1.1 What a user sees immediately after entering NerdBot

**Current (implemented UI)**
- Route `/` renders `ConversationView` in home mode (`dashboard/src/app.tsx`, `dashboard/src/views-chat.tsx`).
- The primary surface is **Chat**: header (“Chat” / global chat copy), attention banner, team strip (when bots exist), capability/mode chips, and a large composer as the main interaction point.
- Recent conversations are listed in the main content area (Home has no internal project conversation rail); the global app sidebar also shows “Recent” conversations.
- The experience communicates “start a conversation / ask / delegate / plan” first; operating overview signals (active work, approvals, failures) exist but are secondary to chat.

**Intended**
- **Home** should be an operating overview across workspaces: active work, AI teammates, deliverables, attention items, and recent activity. Chat is available, but not the defining surface.

**Gap**
- Presentation/IA gap: backend has cross-workspace data (projects, tasks/runs, approvals inbox, bots, teams) and `useWorkspaceSummary` aggregates it, but Home is implemented as a chat-first landing rather than an operations dashboard.

### 1.2 What happens when a user opens a workspace

**Current**
- `/projects` (`ProjectsView`) lists workspaces in a table (bots/tasks/objectives/needs-you, search, “Show empty”, create/open/delete for non-Home).
- Opening a workspace goes to `/p/:id` (`ProjectDetailView`, `dashboard/src/views-project/*`).
- Workspace view is a **tabbed container**: primary tabs Overview, Chat, Work, Team, Files, Knowledge; Advanced menu includes Providers, Issues, Schedules, Approvals, Messages, Notifications, Memory, Backup, Metrics, Events, Boards. Header shows workspace name/counts and actions “Open chat”, “Workbench”.
- **Overview tab** shows: team chips, “Needs attention” (approvals), running/queued/blocked task sections, and recent done/failed (limited). No explicit objective/mission, no deliverables surface, no clear “next useful action” model.
- **Chat tab** embeds `ConversationView` scoped to project (adds workspace conversation rail on `xl`, creating duplication with global sidebar).
- **Workbench** (`/workbench`, linked prominently) is an IDE-like layout (files, editor, terminal, changes, runs) — powerful but technical.

**Intended**
- A workspace should be a **real project environment/operating dashboard** communicating objective, team, active work, progress, deliverables, and next actions. Technical tools appear contextually.

**Gap**
- Presentation/IA gap: rich data and tools exist, but the default mental model is “tabbed project admin + chat + IDE/workbench” rather than an operating environment for an AI team.

### 1.3 Whether the workspace communicates objective, team, active work, progress, deliverables, and next actions

| Dimension | Current state | Backend/data available | Assessment |
|---|---|---|---|
| Objective | No explicit workspace objective/goal/mission field surfaced in landing | Projects have `config`; tasks/issues/boards/objectives exist in domain | **Presentation + possible data-model gap** (no first-class workspace objective in UI; unclear if canonical field exists) |
| Team | Team tab and overview chips show teammates/status; can open agent detail | Teammates with persona/instructions/permissions/provider/model/memory/skills/face/status | **Partially exposed**; not framed as “who is on this mission and what are they doing now” |
| Active work | Running/queued/blocked/failed/done visible in overview and Work/Tasks; runs/tasks tracked | Tasks, runs, task events, latest runs, statuses | **Exposed but fragmented** across tabs/views |
| Progress | Counts/status badges and task/run states | Statuses, timestamps, run history, approvals | **Implicit**, not a coherent progress narrative |
| Deliverables | Library docs/reports, gallery assets, artifacts exist but not surfaced as workspace outcomes on landing | Library (docs/versions/access/export), gallery assets, artifacts, research reports | **Mostly buried/contextual**, not first-class on workspace landing |
| Next actions | “Needs attention”/approvals and task links provide some cues; no prioritized action model | Pending approvals, blocked/failed tasks, queued work, schedules/reminders | **Partial/implicit** |

### 1.4 Whether AI teammates feel like independent entities

**Current**
- **Global/Workspace lists:** Bots/Team views and workspace Team tab present teammates with name/persona, status, model/provider hints, permissions/tool policy chips, actions (attach model, permissions, face, disable/archive). Functional but list/config oriented.
- **Agent detail (`BotDetailView`)**: strong foundation — avatar/face, status, open tasks/runs counts, project link, model info, edit/duplicate/face, memory section, skills/capabilities/permissions context (from inspected sections and models). Shows work-related signals.
- **Identity/capabilities in backend:** `Teammate` includes persona, instructions, capabilities, memory scope, permissions, tool policy, provider/model/fallback, face, soul/goals/wisdom, persona_version, status; teammate skills/memory APIs exist; tasks/runs/boards link ownership.

**Assessment**
- **Implemented backend capability is substantial** (identity config, model binding, permissions, memory/skills structures, ownership/history via tasks/runs). 
- **UI exposure is mixed:** detail view is richer than lists, but agents do not consistently read as autonomous teammates with a clear role, current assignment, recent outputs, and work history at a glance across the product. In many places they appear as “bots/teammates” resources.

### 1.5 Whether users can understand and coordinate work without starting a chat

**Current**
- Possible via: Workspaces/Project detail (Work/Tasks, Team, Boards in Advanced, Files, Knowledge), global Work/Activity, Approvals, Teams/Boards pages, Workbench.
- But Home entry is chat-first; Chat is a primary project tab; many “plan/execute/delegate” affordances are surfaced prominently in chat/composer.

**Assessment**
- **Partially supported** by existing features, but coordination is not the default path and requires navigating technical/fragmented surfaces. Chat is positioned as the easiest starting point.

### 1.6 Whether tasks, boards, approvals, activity, knowledge, files, and deliverables are first-class experiences

| Area | UI presence | First-class? | Notes |
|---|---|---|---|
| Tasks | Work view, project Work/Tasks tab, task detail | **Partial** | Strong execution objects exist; cross-surface consistency and outcome framing vary |
| Boards | `/boards`, project Advanced “Boards” tab | **No (buried/secondary)** | Treated as advanced/container tooling |
| Approvals | `/approvals`, Activity/attention, project Advanced Approvals | **Partial** | Actionable but spread across contexts; inbox exists |
| Activity | `/activity` (and `/work` compat) unifies jobs/runs/schedules/reminders/attention | **Yes/Partial** | Good execution hub, but not yet framed as operating timeline across teams/workspaces |
| Knowledge | Project Knowledge tab, memory surfaces, skills | **Partial** | Present but technical/fragmented |
| Files | Project Files tab, Workbench, chat attachments/refs | **Contextual/technical** | Useful; risks IDE-default feel when prominent |
| Deliverables (Library/Gallery/reports/artifacts) | Library/Gallery as destinations; research reports saveable; artifacts in task views | **Partial** | Exist (Phase 4+) but not central to workspace/home outcomes |

### 1.7 Features hidden, buried, or presented as technical infrastructure

- **Buried in project Advanced tabs:** Providers, Issues, Schedules, Approvals, Messages, Notifications, Memory, Backup, Metrics, Events, Boards.
- **Technical/diagnostic surfaces:** Capabilities, Workbench (IDE-like), raw IDs/monospace metadata in places, backup/metrics/events internals.
- **Not surfaced as outcomes:** deliverables (docs/reports/assets/artifacts), agent work histories/outputs as narrative, workspace objectives and next actions.
- **Duplicated/context confusion:** global sidebar + workspace conversation rail in scoped chat; multiple entry points for similar concepts (Team vs Teams/Teammates/Bots labels, Work vs Activity legacy).

### 1.8 Backend implemented vs UI exposed/understandable (summary)

**Strongly implemented in backend/domain (representative):** projects/workspaces, teammates/bots with identity/config/memory/skills/permissions/providers, tasks/runs/events/artifacts, approvals, boards/messages/members, teams, schedules/reminders, research jobs/reports, library docs/versions/access, gallery assets, knowledge sources/chunks, providers/credentials, notifications/events/backup, chat threads/messages/streaming, workspace files/terminal/workbench APIs.

**UI exposure gaps (presentation/IA):** operating overviews (Home/Workspace), first-class deliverables and objectives, agent-as-teammate narrative (role, current work, outputs, history) consistently across surfaces, non-chat coordination paths, de-emphasis of IDE/infra views, consolidation of duplicated navigation/context.

**Potential genuine backend gaps (to validate during implementation planning):** first-class workspace objective/mission and “next actions” model; unified deliverables/outcomes aggregation per workspace; explicit agent assignment/workload/availability model beyond inferred task/run state; richer activity timeline semantics for human-readable operations. (These require confirmation against current APIs/models before treating as missing.)

---

## 2. Product experience model (intended)

These define experiences and responsibilities, not mandatory route renames.

### Home — Operating overview across workspaces
- Immediate answers: what needs attention, what’s running, what shipped, which teammates are active/blocked, what changed recently.
- Entry points to workspaces, agents, work, and conversations **without** forcing chat.
- Cross-workspace awareness with clear scoping.

### Workspaces — Real project environments (not IDE containers)
- Workspace landing = operating dashboard for that mission.
- Communicates objective, team, active work, progress, deliverables, and next actions.
- Chat, Team, Tasks/Work, Boards, Knowledge, Files, Activity, and deliverables are coherent parts of the workspace, shown contextually by relevance.
- Editors/terminals/filesystem tools appear when needed, not as default identity.

### Agents — AI teammate directory and management
- Agents presented as independent teammates with identity, role/personality, capabilities/skills, models/providers, memory/knowledge, permissions/approvals, current assignments/status, work history/outputs.
- Users can open, understand, talk to, and assign/delegate work to agents.
- Distinguish global agent roster vs workspace membership/assignment as appropriate.

### Work — Cross-workspace execution
- Tasks, boards, runs, delegation, approvals, and progress understandable without inspecting internal technical details.
- Truthful states, timelines, blockers, and human-attention items; links to source context (workspace/agent/chat/deliverable).

### Chat — Powerful conversational interface (not the whole product)
- Supports global chat, workspace chat, and direct interaction with individual agents.
- Embedded/contextual where conversation helps (agent, task, deliverable, workspace), but not the default frame for every surface.

---

## 3. Proposed navigation (reconsidered)

Treat the prior 6-item nav as a starting point. Preserve routes/deep links; migrate presentation progressively.

### 3.1 Global navigation (product identity: AI workforce operations)

**Proposed primary global destinations:** `Home`, `Workspaces`, `Agents`, `Work`, `Chat`, `Library` (or `Deliverables` label if aligned with domain), `Settings`.

- **Home:** operating overview (default landing).
- **Workspaces:** find/open project environments; status/attention summaries.
- **Agents:** teammate directory/management (global view) with filters by workspace/status/capability; entry to agent detail and direct chat.
- **Work:** cross-workspace execution and attention (tasks/runs/boards/delegation/approvals/progress) — can absorb/rename current Activity semantics while keeping compatibility.
- **Chat:** global conversational surface and conversation management (all scopes visible), not the home dashboard.
- **Library/Deliverables:** documents, reports, assets, outputs (and access to gallery as appropriate) as first-class outcomes.
- **Settings:** configuration, providers/credentials, permissions/autonomy defaults, integrations, diagnostics (Capabilities) under Advanced.

**Notes**
- Avoid duplicating “Teams” as a separate top-level concept unless it represents a distinct user job; prefer Agents + coordination constructs (groups/teams/boards) surfaced in context (Agent/Workspace/Work) with preserved routes (`/bots`, `/teams`, `/boards`).
- Keep `/activity`, `/work`, `/approvals`, `/capabilities`, `/workbench`, etc. working via redirects/aliases as needed.

### 3.2 Workspace navigation (coherent, not a second competing global sidebar)

Within a workspace, provide **one coherent local navigation** (tabs/sections/secondary rail appropriate to layout, not an IDE chrome default) focused on:
- **Overview** (landing dashboard): objective, team, active work, progress, deliverables, next actions, attention.
- **Work** (tasks/boards/runs/queue/blockers relevant to workspace).
- **Agents/Team** (members assigned to workspace, status, assignments).
- **Chat** (workspace-scoped conversations and agent interactions in context).
- **Deliverables/Knowledge** (library docs/reports/assets/knowledge relevant to workspace).
- **Files & Tools** (contextual; includes file browsing/terminal/editor/workbench only when needed).

Move infra/config surfaces (providers, schedules, notifications, backup/metrics/events, issues/messages as applicable) to **Workspace Settings/Advanced** or relevant contextual locations; avoid exposing them as equal primary workspace tabs.

**Duplication rule:** when inside a workspace chat or workspace context, do not show a second persistent conversation sidebar that competes with global navigation. Use scoped switchers/panels/drawers or in-context lists.

### 3.3 Chat’s place in navigation
- Global Chat is a destination for conversation-centric work.
- Workspace Chat and Agent Chat are **contextual entry points** (from workspace/agent/task/deliverable) that open in a consistent chat surface with explicit scope, without making chat the container for the entire app.

---

## 4. Screen-by-screen redesign proposal

### 4.1 Home dashboard (replace chat-first landing)

**Purpose:** answer “what’s happening across my AI workforce right now?”

**Primary content (priority order)**
1. **Needs attention:** approvals/decisions, failed/blocked work, expiring/overdue items (truthful, actionable).
2. **Active work:** running tasks/runs, active agents, queued pressure, cross-workspace highlights.
3. **Deliverables & recent outcomes:** recently produced docs/reports/assets/artifacts with links to workspace/agent/task.
4. **AI teammates snapshot:** who is active/idle/blocked/waiting, current assignments (summary), quick open/message.
5. **Recent activity timeline:** meaningful events (started/completed/needs input/delivered), not raw logs.

**Secondary**
- Quick actions: open workspace, view all work, talk to an agent, start a task/goal (choose scope explicitly), search.
- Optional compact “resume conversation” module, but not the dominant hero.

**Acceptance cues:** user can triage and navigate to workspaces/agents/work without composing a chat message.

### 4.2 Workspace landing (operating dashboard, not IDE)

**Purpose:** answer the six questions in one view.

**Sections**
- **Objective & context:** workspace name, objective/mission (or clearly labeled “No objective set” with action if supported), scope/links.
- **Team right now:** assigned agents with identity, role, status (active/idle/blocked/waiting), current task, quick message/assign.
- **Active work & progress:** in-progress/queued/blocked/awaiting-approval/completed summaries, progress indicators, links to Work views.
- **Deliverables:** recent docs/reports/assets/artifacts produced in this workspace.
- **Needs human attention:** approvals, failures, questions, required inputs.
- **Next useful actions:** suggested/prioritized actions derived from real state (e.g. review approval, retry failed run, assign idle task, open deliverable) — no fabricated intent.

**Access to capabilities (coherent parts, contextual)**
- Chat (workspace/agent), Work/Boards/Tasks, Agents/Team, Knowledge/Deliverables, Files & Tools (contextual), Workspace settings/advanced.

**Non-goals/defaults:** no file tree + editor + terminal as default hero; Workbench/tools launched from relevant tasks/files/needs.

### 4.3 Agent directory (global)

**Purpose:** manage and understand the AI workforce.

**List/grid characteristics**
- Identity-forward: avatar/face, name, role/persona summary.
- Operational state: active/idle/blocked/waiting, current assignment, workspace(s).
- Capability signals: key skills/capabilities, model/provider (as secondary), permissions/approval posture indicators where relevant.
- Actions: open, message/chat, assign work (if supported), filter/search.

**Distinguish:** configured-but-unavailable (no model/disabled), active, archived; avoid raw technical IDs as primary labels.

### 4.4 Agent detail

**Purpose:** understand one teammate completely and act.

**Core sections**
- **Identity & role:** name, persona/role, instructions summary, avatar/face, status.
- **Current work:** active/queued/blocked assignments, recent runs/tasks, what they’re waiting on.
- **Capabilities & configuration:** skills, tools/capabilities, model/provider/fallback, autonomy/permissions/approval requirements (honest, user-facing).
- **Memory & knowledge:** scoped memory/knowledge access and management (as implemented), with provenance/taint cues where applicable.
- **History & outputs:** timeline of work, completed tasks/runs, produced artifacts/docs/reports.
- **Interaction:** direct chat with agent, delegate/assign work, quick actions (edit config, duplicate, pause/disable/archive) according to permissions.

**Use existing backend capabilities** (teammate config, skills, memory, provider bindings, permissions, task/run ownership/history). Clearly label unavailable data rather than inventing.

### 4.5 Work / execution experience

**Purpose:** coordinate and monitor execution across workspaces.

**Views/components**
- **Attention queue:** approvals and blockers requiring human action.
- **Active execution:** running tasks/runs with agent, workspace, progress/status, elapsed/updated time, safe controls (where supported).
- **Queues/backlog:** queued/scheduled work, dependencies/context.
- **Boards/delegation:** visual/structured coordination where useful (boards remain available, positioned as coordination tool).
- **History/outcomes:** completed/failed/cancelled with reasons, outputs, and links to deliverables.

**Principles:** understandable statuses in plain language; no need to inspect internal logs/IDs; drill-down available (task/run detail, events) as progressive disclosure.

### 4.6 Chat’s role in the overall product

- **Global Chat:** cross-workspace conversation hub (resume/search/manage threads) with explicit scope per conversation.
- **Workspace Chat:** conversations in workspace context (planning, coordination, questions) linked to workspace work/deliverables.
- **Agent Chat:** direct interaction with a specific teammate (instructions, check-ins, delegation) accessible from agent surfaces.
- **Contextual chat:** optional panels/entry points from tasks, approvals, or deliverables when conversation is the right tool.
- **Not:** the default home, not the default workspace landing, not the only way to coordinate.

---

## 5. Mapping existing features and routes to the new experience

| Existing route/surface | Current role | Proposed experience placement | Migration note |
|---|---|---|---|
| `/` (Home) | Chat-first CommandCenter | **Home operating overview** (chat available as module/entry) | Major presentation change; preserve conversation access |
| `/projects`, `/p/:id` | Workspace list + tabbed project detail | **Workspaces** list + **Workspace operating dashboard** with coherent local nav | Preserve deep links/tabs via mapping/redirects |
| `/bots`, `/bot/:id` | Bot list/detail (“Team”) | **Agents** directory/detail (global) + workspace team context | Rename in UI; keep routes |
| `/teams`, `/team/:id` | Teams management | **Coordination/groups** within Agents/Work/Workspace contexts | Keep routes; demote from top-level if redundant |
| `/boards`, `/board/:id` | Boards (advanced/global) | **Work coordination** (workspace/global as relevant) | Keep routes; integrate into Work/Workspace |
| `/activity`, `/work` | Unified execution/jobs/attention | **Work** (and/or Home attention modules) | Keep compat redirect; evolve labeling |
| `/approvals` | Approvals inbox | **Work attention / approvals queue** + contextual approvals in tasks/workspaces | Keep deep link |
| `/chat/:projectId` | Scoped chat view | **Workspace/Scoped Chat** experience (no duplicate sidebars) | Keep route; refactor layout/scope UX |
| `/library`, `/library/:docId` | Library/docs | **Library/Deliverables** (global) + workspace deliverables views | Keep routes |
| `/gallery` | Gallery assets | **Deliverables/Assets** within Library or Workspace context | Keep route; reposition |
| `/workbench` | IDE-like workbench | **Contextual Files & Tools / task tooling** (not default workspace) | Keep deep link; de-emphasize as primary |
| `/settings` | Global settings | **Settings** (+ Advanced/Diagnostics) | Keep route |
| `/capabilities` | Capabilities/diagnostics | **Settings > Advanced/Diagnostics** | Keep route |

**Feature mapping (selected):** tasks/runs/objectives → Work & Workspace; schedules/reminders/jobs → Work/Activity timelines; providers/models/credentials → Settings + workspace bindings; knowledge/memory/skills → Agents/Workspace knowledge & configuration; files/terminal/diffs → contextual tools; notifications/events/backup/metrics → Settings/Advanced & operational feedback.

---

## 6. Backend gaps vs frontend presentation gaps

### Frontend presentation/IA gaps (primary)
- Chat-first Home and chat-prominent workspace instead of operating dashboards.
- Workspace lacks explicit objective, deliverables, and next-actions framing.
- Agents presented as resources/config lists more than independent teammates in many surfaces.
- Work/coordination/deliverables fragmented or buried (Advanced tabs, separate destinations without outcome framing).
- IDE-like Workbench prominence; technical tools not consistently contextual.
- Navigation/context duplication (global sidebar + project conversation rail) and terminology drift (Bots/Teammates/Agents, Work/Activity, Projects/Workspaces).

### Backend/data gaps to validate (do not invent in UI)
- **Workspace objective/mission:** confirm if a canonical field exists beyond `project.config`/naming; if absent, define minimal model/API for user-facing objective.
- **Next useful actions:** may require aggregation/heuristics over existing state (approvals, blocked/failed/queued tasks, schedules) — can start as frontend-derived from real data if reliable.
- **Deliverables aggregation:** confirm unified way to query workspace outcomes (library docs/reports, assets, artifacts) for landing/overview.
- **Agent “current assignment/availability”:** largely inferable from tasks/runs/status today; assess if explicit availability/workload signals are needed.
- **Direct agent-chat routing semantics:** confirm/standardize how global/workspace/agent conversations are scoped and addressed.

(Each item above must be verified against `backend/src/nerdbot/*` APIs/models during implementation planning; only implement backend changes when necessary and approved.)

---

## 7. Incremental implementation sequence and acceptance criteria

**Sequencing principle:** coherent workspace experience first (not another round of Chat polish). Each increment must preserve functionality, routes, and truthful states.

### Phase R1 — Navigation & information architecture foundation (no behavior loss)
- **Work:** finalize global/workspace nav model, route/deep-link compatibility map, scope indicators; remove/replace duplicated chat sidebars in scoped contexts.
- **Acceptance:** all existing routes resolve; users can distinguish global vs workspace vs agent context; no second competing sidebar in workspace chat.

### Phase R2 — Home operating overview
- **Work:** replace chat-first hero with attention/active work/deliverables/teammates/activity overview; keep Chat accessible as destination/module.
- **Acceptance:** on entry, user sees cross-workspace status and can reach workspaces/agents/work/deliverables without sending a chat message; existing chat threads remain accessible.

### Phase R3 — Workspace operating dashboard (coherent workspace experience)
- **Work:** redesign workspace landing around objective, team, active work, progress, deliverables, attention, next actions; reorganize workspace-local navigation; make files/editor/terminal/workbench contextual.
- **Acceptance:** opening a workspace answers the six core questions; Chat/Work/Team/Knowledge/Deliverables/Tools accessible coherently; no IDE-default landing; Advanced/infra controls discoverable but not dominant.

### Phase R4 — Agents as first-class teammates
- **Work:** redesign Agents directory and Agent detail (identity, role, capabilities/skills, model, memory/knowledge, permissions, assignments/status, history/outputs, direct chat/delegation) using existing backend data.
- **Acceptance:** users can find, understand, message, and assign work to an agent; states/capabilities/limits are truthful and understandable.

### Phase R5 — Work/execution and deliverables integration
- **Work:** strengthen cross-workspace Work experience (attention, running/queued, boards/delegation, outcomes) and surface deliverables (Library/Gallery/artifacts/reports) as first-class outcomes in Home/Workspace/Agent views.
- **Acceptance:** execution progress and outputs are trackable end-to-end without relying on chat transcripts or internal technical views.

### Cross-cutting acceptance criteria (all phases)
- **Functionality:** Phase 1–9 features remain available (moved/reframed, not removed); backend contracts and permissions enforced server-side.
- **Truthfulness:** no fabricated progress, activity, identities, or outputs; explicit empty/loading/error/blocked states with recovery actions.
- **Accessibility/responsiveness:** keyboard navigation, visible focus, light/dark themes, reduced motion, desktop/mobile layouts.
- **Design quality:** follows `skills/ui/ui-core/SKILL.md`, `skills/ui/house-style/SKILL.md`, `curations/impeccable/overlay/SKILL.md`; clear hierarchy/whitespace/typography; avoids chat-app and IDE clones, generic card grids, decorative gradients/glows, and technical-primary language.
- **Verification per increment:** relevant tests, type checks, production build, and browser verification of affected journeys; report files changed, behavior preserved/moved, results, defects/limitations, and git state.

---

## 8. Immediate recommendation

1. **Review and approve this reassessment** (experience model, navigation, screen concepts, mapping, gaps, sequence).
2. **Do not proceed with additional Chat polish or broad styling passes.**
3. **Begin implementation at Phase R1/R2 planning detail only after approval**, starting with a coherent Home + Workspace experience slice that reduces chat/IDE dominance while preserving all existing capabilities and routes.
