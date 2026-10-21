# Phase 1 — Product Positioning and Information Architecture

## Product positioning

"Nerdbot is your personal AI workspace. Bring your models, agents, and ongoing work together in one place."

Who it serves: one person (the owner) running a self-hosted AI workspace on `http://localhost:8080`, signing in with a bearer token.

Primary job: start or resume work with an AI — chat, delegate to a specialist, or pick up an ongoing task — without first setting up a project.

Role of each concept (user-facing vs internal):
- **Home / Command Center**: entry point. Chat is primary; recent conversations, active runs, and approvals needing attention are visible here.
- **Project / Workspace**: optional context for sustained work. Groups conversations, files, tasks, agents, and results. Never required to chat.
- **Task**: an intended unit of work. Has statuses queued/running/awaiting-approval/completed/failed/cancelled.
- **Run**: one execution attempt of a task. Retry creates a new run, never a new task.
- **Agent (teammate/bot)**: a persistent specialist — persona, instructions, model/provider, permissions, memory scope. Does real work in an isolated Git workspace.
- **Team**: coordinates agents; delegation, handoffs, approvals.
- **Board**: workspace container where bots own tasks (kept only if it adds a distinct workflow — currently overlaps teams/projects, so demoted from top-level nav).
- **Models & Connections**: provider setup per project; onboarding path when none configured.
- **Settings**: server state, BYOK posture, connection status — machine-level, not per-user accounts.

## Primary user journeys

1. **Quick chat.** Open Home → New chat → send a message → get a streaming reply. No project required.
2. **Delegate work.** From a conversation or the fleet, create a task, assign it to an agent, run it, inspect the run output/artifacts/diff.
3. **Resume ongoing work.** Open Home → pick a recent conversation or an active/awaiting-approval task → continue.

## Information architecture (sitemap)

```
WORK
├── Home / Command Center          #/                  ← entry point
│   ├── recent conversations
│   ├── active runs & approvals
│   └── primary composer
├── Workspaces / Projects          #/projects
│   └── Project <id>               #/p/<id>
│       ├── chat (conversation)
│       ├── tasks & runs
│       ├── agents / teammates
│       └── providers (models)
└── Tasks / Runs                   #/p/<id>/t/<taskId>
        execution detail, artifacts, diffs, delegation tree

AI FLEET
├── Agents                         #/bots
│   └── Agent <id>                 #/bot/<id>
├── Teams                          #/teams
│   └── Team <id>                  #/team/<id>
└── Boards                         #/boards   (secondary; distinct workflow TBD)
        └── Board <id>             #/board/<id>

CONFIGURE
├── Models & Connections           (per project → Providers tab; onboarding when none)
└── Settings                       #/settings
```

## Navigation specification

Top-level sidebar (WORK first, then AI FLEET, then CONFIGURE):
1. Home — command center, recent conversations, primary composer entry.
2. Projects — workspace directory; create/open.
3. Agents — agent directory; create agent.
4. Teams — team directory; create team.
5. Boards — secondary (only if distinct workflow justified).
6. Settings — server state, BYOK, connection status.

Persistent actions:
- New chat (prominent, in Home sidebar and command center header).
- New task (from conversation or project).
- Connect status / sign out.

Route preservation: keep all existing hash routes (`#/`, `#/chat/:id`, `#/projects`, `#/p/:id`, `#/p/:id/t/:taskId`, `#/teams`, `#/team/:id`, `#/bots`, `#/bot/:id`, `#/boards`, `#/board/:id`, `#/settings`). No redirects needed since routes are unchanged.

## Acceptance criteria for Phase 1

- Product brief states who it's for, the primary job, and the three journeys.
- Sitemap maps every concept to a route with no duplicated entities.
- Navigation spec names top-level sections and persistent actions without a nav item per backend entity.
- Next phase: design system (tokens + shared components) grounded in this IA.
