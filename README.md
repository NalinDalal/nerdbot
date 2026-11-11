# Nerdbot

Nerdbot is a self-hosted **AI work environment** — a place to organize work, collaborate with AI teammates, delegate tasks, make decisions, and review outcomes.

It is **not** an AI agent management dashboard, and not an embedded IDE.

## Product principle

**The user manages outcomes. Nerdbot manages execution.**

- Users control: objectives, teammates, context, decisions, and results.
- Nerdbot handles (mostly behind the scenes): runs, orchestration, channels/handoffs, permissions mechanics, event streams, and IDs.
- The interface should answer: *What was requested? What’s happening? Who’s responsible? What’s blocking? What’s produced? What should happen next?* Evidence/logs/debug remain available progressively, not upfront.

## Locked direction: Phase 9 — Workspace Experience Transformation

The next milestone is a product experience and frontend evolution (not a backend rewrite).

### Constraints
1. No backend rewrite or database migration.
2. Preserve all working Phase 1–9 capabilities.
3. Reuse existing project, chat, task, agent, knowledge, and artifact data.
4. Keep execution infrastructure operational.
5. Replace developer-tool-oriented navigation with workspace-oriented navigation.
6. Make outcomes and deliverables the primary interface.

### Workspace-first information architecture
A **Workspace** is the primary environment where work, knowledge, conversations, AI teammates, tasks, and deliverables live with shared context.

**Primary (within a workspace):**
- **Overview** — what’s happening and what needs attention (resume, decide, start)
- **Work** — tasks and execution, outcome-first
- **Chat** — ask and delegate in context
- **Library** — files, knowledge, and deliverables
- **Agents** — collaborators and capabilities

**Advanced / contextual (demoted, not primary):** Teams, Boards, Workbench (Code mode), execution diagnostics, administration. Backend capabilities may remain intact, but users should not need to manage internal machinery to get work done.

### Core concepts
- **Workspace:** the environment/context for work.
- **AI teammates (agents):** collaborators that do work within the workspace.
- **Work/Tasks:** delegated objectives with clear state, owner, blockers, and outcomes.
- **Library/Knowledge:** documents, files, research, memory, and produced deliverables.
- **Chat:** conversation and delegation in shared context.

### Teams and Boards
Technically different today, but **internal coordination/grouping concepts** that should not be primary user-facing objects:
- **Teams:** grouping/rollup of bots and workspaces (organizational; no permission grant in the current model).
- **Boards:** collaboration/execution channels with membership/messages/tasks/deliverables (membership can be a real grant).

Direction: keep necessary backend/infrastructure behavior, **demote from primary navigation**, simplify, and expose only contextually/under Advanced where a clear job exists. Do not force users to understand Teams vs Boards to get work done.

### Workbench (Code mode)
Workbench (files/editor/terminal/diffs) is a **capability, not a destination**. Open it explicitly (e.g. “Open in Code/Workbench”) when code inspection or editing is needed. The default experience should communicate AI teammates doing work, not an embedded IDE.

### Outcome-first experience
Show outcomes and next actions (completed/reviewable results, in-progress work, blocked items needing approval/input, resumable work) rather than operational metrics and machinery (runs, channels, raw IDs, event streams) by default.

## Implementation priorities (initial)
| Priority | Focus |
|---|---|
| P0 | Establish workspace-first navigation and IA |
| P1 | Build Workspace Overview (existing `/p/:projectId`, outcome-first) |
| P2 | Redesign Task/Work detail around outcomes (evidence progressive) |
| P3 | Integrate Agents into workspace context |
| P4 | Demote and simplify Teams and Boards |
| P5 | Reposition Workbench as Code mode |
| P6 | Refine Home into Resume / Decide / Start |

**First implementation target:** existing `/p/:projectId` as Workspace Overview, reusing current data/capabilities. Experience/API mappings for implementation specs must be grounded in actual source contracts (routes, views, API clients, types) — do not invent field or component mappings.

## Development notes
- Backend: `backend/src/nerdbot` (FastAPI, SQLite). Frontend: `dashboard/` (Vite/React/TypeScript).
- Historical/maintained product knowledge may also exist in external handoff/backup artifacts from prior documentation cleanup.
