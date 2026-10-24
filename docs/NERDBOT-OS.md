# NerdBot OS — one workspace, many bits

Status: proposed (2026-10-23). Supersedes the surface decisions in
`docs/design/personal-assistant-platform-v2.md` where they conflict.

## The one-line answer

NerdBot is not missing features. It is missing **a place to work** and
**a runtime that stays alive**. Build those two and Odysseus, Octop,
OpenBot, ai-teammates and Grok Bot stop being three products to integrate
and become four reference designs for one product.

## Why it feels ugly and unusable today

The engine is real: 462 backend tests, 108 frontend tests, durable tasks,
runs, artifacts, isolated checkouts, digest-bound approvals, delegation,
memory, providers. The product surface has not caught up with it.

1. **The product is organised by database table, not by work.** Five nav
   items hide 15-tab project pages, raw ids, and admin tables. The schema
   became the information architecture.
2. **The workspace is a row, not a room.** The only real directory is a
   per-task Git checkout (`<data-dir>/workspaces/<task_id>`). There is
   nowhere to open a repo, edit a file, run a command, and see the result.
3. **A bot is a row with a task queue, not a live teammate.** It wakes when
   you create a task, then sleeps. No presence, no session, no memory file,
   no reason to feel like a colleague.
4. **Nothing happens unless you click.** The executor is opt-in
   (`NERDBOT_EXECUTOR=1`), schedules need a CLI sweep, there are no
   channels. Autonomy is a setting, not a behaviour.
5. **There is a token set, but no shell.** The home is a dashboard of
   counters, Settings is a list of workspaces, Fleet is a broken table, and
   the project page is a 15-tab console. The visual system is ad-hoc:
   arbitrary Tailwind, 1,000-line component files, an unused Ant Design
   dependency, no single layout primitive.

## The model: Workspace OS

Four primitives. Everything else is a view over them.

```
┌───────────────────────────── SURFACES ─────────────────────────────┐
│  Web workbench · CLI · Telegram/Discord · API · MCP · ACP · cron   │
└───────────────────────────────┬────────────────────────────────────┘
                                │ one event journal, one approval gate
┌───────────────────────────────▼────────────────────────────────────┐
│  WORKSPACE (the room)                                              │
│  real directory · files · docs · knowledge · artifacts · checkouts │
│  .nerdbot/bits/<id>/SOUL.md · GOALS.md · WISDOM.md · MEMORY.md     │
│  shared DECISIONS.md · instructions · model · policies             │
└───────────────┬───────────────────────────────┬────────────────────┘
                │                               │
┌───────────────▼──────────────┐  ┌─────────────▼────────────────────┐
│  BITS (the actors)           │  │  RUNTIME (the nervous system)    │
│  persistent agent identity   │  │  live sessions + durable tasks   │
│  model · tools · permissions │  │  executor · scheduler · queue    │
│  autonomy level · channels   │  │  PTY · browser · MCP · sandbox   │
│  schedules · home workspace  │  │  approvals · budgets · journal   │
└──────────────────────────────┘  └──────────────────────────────────┘
```

- **Workspace** — a real directory the owner and the bits share. It owns
  files, knowledge, artifacts, task checkouts, and the bits' identity
  files. A workspace is not a table of settings.
- **Bit** — a small autonomous unit: a bot, a task, or a schedule. A bot
  is the durable actor. It has a job, a model, tools, an autonomy level,
  channel bindings, schedules, and a home inside the workspace.
- **Task / Run** — a durable unit of work with an auditable execution.
  Tasks can be created by the owner, a bit, a schedule, a channel message,
  or a webhook. A run executes in a checkout (safe) or the live workspace
  (fast, approval-gated).
- **Surface** — every way in. Web, CLI, chat channels, API, MCP, ACP,
  cron, webhooks. All of them write the same event journal and pass the
  same approval gate. Nothing gets a private path to the engine.

## What each reference actually contributes

| Reference | What to take | What not to take |
|---|---|---|
| **Odysseus** | The room: files, documents, notes, research, email, calendar, local models. The idea that chat sits *beside* work, not instead of it. | The whole app, the AGPL code, the 94k-star scope. |
| **Octop** | The nervous system: experts, channels (Telegram/Discord/…), cron, connectors, browser/terminal, ACP in both directions, one-process control plane. | Multi-user/JWT tenancy, remote desktop, the dashboard. |
| **OpenBot** | Every bit gets a computer: browser, files, tools; every consequential action is decided before it happens. | The CopilotKit UI stack and its agent runtime. |
| **ai-teammates** | The soul: SOUL/GOALS/WISDOM/RESUME as plain markdown, ownership boundaries, three-tier memory, handoff protocol, decision log. | The CLI/TUI and the coding-agent adapters as the product. |
| **Grok Bot** | The presence: one persistent computer, group chats where bits pass work, routines learned from a demonstration, progressive trust, proactive follow-ups. | The marketplace and image/video generation. |
| **Bits** | The unit of command: bot, task, schedule. The workspace orchestrates them. | "Bits" as another top-level page to manage. |

## What already exists (do not rebuild)

| Need | Existing code | State |
|---|---|---|
| Durable tasks, runs, retries | `orchestrator.py`, `store.py` | real, tested |
| Isolated task checkouts | `workspace.py` | real, tested |
| Approval gate | `gates.py`, `approval_flow.py` | real, digest-bound |
| Bot identity, permissions, memory scope | `fleet.py`, `agent_context.py`, `store.py` | real, tested |
| Model loop + tool calls | `providers.py`, `app_tools.py` | real, OpenAI-compatible |
| Delegation / handoff | `delegation.py`, `store.py` | real, depth-capped |
| Memory, knowledge, schedules, events, backup | `store.py`, `knowledge.py`, `schedules.py`, `backup.py` | real |
| Faces | `dashboard/src/bot/` | real, distinctive; keep |
| Web dashboard, 5 surfaces | `dashboard/src/` | real, needs a shell |
| 462 + 108 tests | `tests/`, `dashboard/src/*.test.ts` | green at time of writing |

## What is missing (the actual build)

1. **A workspace root.** `projects` has no path. Add `workspace_root` to the
   project config (or a column) and a mode: `live` (shared directory) or
   `checkout` (per-task isolation). Import an existing folder. This is the
   single change that turns NerdBot from a task console into a workspace.
2. **A file + terminal surface.** Tree, read/write, diff, editor, PTY over
   SSE. The backend already has path-escape guards; reuse them. This is the
   Odysseus room and the Octop terminal.
3. **Live sessions.** A chat thread bound to `(workspace, bit)` that runs
   the existing tool loop against the live workspace, streams, and writes
   memory back. Today chat is a transcript; tasks are one-shot. Make chat a
   session, and let a session spawn tasks.
4. **An always-on runtime.** Start the executor and scheduler loops by
   default; add a trigger table (cron, channel, webhook, file change); add
   budgets and a kill switch. No more "trigger-only".
5. **Channels.** Telegram first (long polling, no public URL), then
   Discord/Slack. One conversation per (channel, workspace, bit). This is
   what makes a bit feel alive.
6. **Per-bit computer.** Browser (Playwright, per-bit profile), terminal,
   files, and MCP tools, all behind the existing approval gate. This is
   OpenBot/Grok Bot parity.
7. **MCP + ACP.** MCP client for tools/connectors; MCP server so Claude
   Code/Codex/OpenCode can use NerdBot; ACP runner so a bit can delegate a
   coding task to those agents in the workspace.
8. **Skills.** Markdown + optional scripts in the workspace, loaded per bit.
   The cheapest way to make bits capable without shipping code.

## Surface design: the workbench

Replace the five-page admin app with one shell:

```
┌──────────┬───────────────────────────────────────┬──────────────────┐
│ RAIL     │  ACTIVE SURFACE                       │  CONTEXT         │
│          │                                       │                  │
│ workspace│  chat thread / editor / task / run    │  files changed   │
│  switcher│  / document / board                   │  artifacts       │
│          │                                       │  approvals       │
│ bits     │                                       │  run trace       │
│  (faces, │                                       │  memory          │
│  presence)│                                      │                  │
│          │                                       │                  │
│ ⌘K       │  composer (chat) / toolbar (editor)   │                  │
└──────────┴───────────────────────────────────────┴──────────────────┘
```

- **Home is the last workspace you had open**, not a dashboard. A pulse
  strip at the top shows running / needs-you / failed. The composer is
  anchored at the bottom. The context panel is already open.
- **Bits are faces in the rail**, with presence (idle, working, waiting,
  blocked). Click opens a side panel, not a settings page. `@mention` in
  any thread.
- **Tasks are transcripts**, not forms. Output first, then artifacts,
  approvals inline, then the machinery under a disclosure.
- **Settings is a modal.** Workspaces are opened, not listed as Settings
  content. Boards/Teams/Knowledge are contextual panels, not nav items.
- **Command palette** for everything: switch workspace, new task, spawn
  bit, open file, run schedule, approve.
- **One design system**: Button, Field, Card, Dialog, Tabs, Table,
  EmptyState, Toast, Palette. One font (Geist is already loaded; self-host
  it). Near-black/ivory surfaces, one signal accent, semantic status
  colours. Motion only on state change, 150–250 ms, reduced-motion safe.
- **Delete**: raw ids on primary surfaces, 11-action headers, 15-tab
  project pages, duplicate attention banners, the `.row/.card` compat
  layer, the unused Ant Design dependency, and the "table of workspaces"
  as the Settings page.

## Build order

Each slice is shippable on its own and keeps the test gates green.

### Phase 0 — The Shell (2–3 days)
App shell (rail / surface / context), design system, command palette,
onboarding (connect model → create workspace → spawn bit → first task),
remove dead code and the 15-tab project page.
**Done when** a new user reaches a working bit in under five minutes and
no primary screen leads with an id or a raw table.

### Phase 1 — The Room (3–5 days)
`workspace_root` + import folder + live mode; file tree, editor, diff,
preview, terminal over SSE; bits read/write through the existing tool
layer; task runs become checkouts with a merge-back review.
**Done when** you can open a repo, ask a bit to change it, watch the diff,
and run the tests without leaving the screen.

### Phase 2 — The Bits (3–5 days)
Live sessions bound to `(workspace, bit)`; SOUL/GOALS/WISDOM/MEMORY
markdown; presence; @mentions; group threads; handoffs and decision log
visible in the thread.
**Done when** a bit acts on the workspace, remembers the next session, and
hands off to another bit without re-explaining.

### Phase 3 — Always On (4–6 days)
Default executor + scheduler loops; trigger table; event journal + SSE;
Telegram channel (then Discord/Slack); autonomy levels per bit; budgets;
approvals inline in chat and channel.
**Done when** you message a bit from your phone, a schedule fires
overnight, and you approve from the notification.

### Phase 4 — Command (4–6 days)
MCP client + server; ACP runner (OpenCode/Claude Code/Codex); skills;
browser with per-bit profiles; optional email/calendar/notes connectors.
**Done when** you add an MCP server without code, and a bit delegates a
coding task to an external agent and returns the diff.

### Phase 5 — Product (ongoing)
A11y, performance, packaging (`nerdbot up`), backups, docs, onboarding,
and the honesty pass on the Capabilities page.

## Non-goals (for now)

- Multi-user tenancy, billing, hosted SaaS.
- A bot marketplace.
- Image/video generation.
- Porting Odysseus's full document/email/calendar suite before the room
  and the runtime exist.
- A second task system, provider layer, or workspace implementation.

## Licensing

`LICENSE` is AGPL-3.0-or-later; `pyproject.toml` says MIT. Fix the
metadata to AGPL before accepting contributions.

- Odysseus is AGPL-3.0: concepts only unless the combined work stays AGPL.
  Clean-room re-implementation is the safer path.
- Octop, ai-teammates and OpenBot are permissive (MIT/Apache): patterns and
  adapted code are fine with attribution; keep `docs/provenance/` current.
- Do not copy Odysseus code into an MIT build.

## The first 48 hours

1. Freeze new features.
2. Implement Phase 0 + the first half of Phase 1: the shell, the workspace
   root, the file tree, and the terminal.
3. Put chat, files, and terminal on one screen with a bit as a participant.
4. Then wire live sessions. Everything else can wait.

The milestone that matters: **open NerdBot, land in your workspace, see
your bits, and get work done without opening a settings page.**
