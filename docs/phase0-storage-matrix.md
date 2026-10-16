# Phase 0 — Storage Mapping: Where Agents, Sessions, Memory, Tasks, Workspace State Live

## Octop (`~/octop`)

| Concept | Storage location | Technology | Notes |
|---|---|---|---|
| Agents / experts | `~/.nerdbot/nerdbot.db` table `agents` + `agents/<agent_id>/` workspace dir | SQLite control-plane DB + per-agent filesystem | Folder scanned at boot: `manifest.json` + `SOUL.md` + `skills/` |
| Sessions / threads | `nerdbot.db` tables `threads`, `thread_messages` (display projection) | LangGraph checkpointer + separate display projection | Checkpoint state and display history kept separate |
| Memory | Per-agent namespace `agent_<id>` under agent workspace | octop-memory (FTS + vectors) | Extract/distill/slim pipelines; portable with workspace |
| Tasks / runs | `nerdbot.db` (LangGraph checkpointer, `trajectory_events`) | SQLite | Restart-safe: full runtime tree rebuilt from DB on boot |
| Workspace / files | Pluggable backends: local FS, Docker, PostgreSQL, S3/COS/OSS/OBS | `infra/backend/resolver.py` | Separate from control-plane DB |
| Approvals / HITL | `nerdbot.db` + in-process `ToolGuardPolicy` | SQLite + runtime state | HITL `require_approval`, org approval gate (inert) |
| Events / audit | `trajectory_events` table + audit rows | SQLite | |
| Config | `~/.nerdbot/config.json` + env `NERDBOT_*` | JSON file | SQLite or PostgreSQL via `database` section |

## AI Teammates (`~/ai-teammates`)

| Concept | Storage location | Technology | Notes |
|---|---|---|---|
| Users | Postgres table `users` | Drizzle ORM / `db:push` | `id`, `email`, `passwordHash` (scrypt), `llmApiKey` (**plaintext**), `sharedContext` |
| Sessions | Postgres table `sessions` | Drizzle | `token`, `userId`, `expiresAt` (30-day cookie) |
| Teammates (bots) | Postgres table `bots` | Drizzle | `id`, `userId`, `name`, `avatar`, `job`, `instructions`, `sandboxId`, `status`, `modelId`, `tools[]`, `memoryEnabled`, `scheduleHours`, `nextRunAt` |
| Bot versions | Postgres table `bot_versions` | Drizzle | Append-only history of bot edits |
| Chats | Postgres table `chats` | Drizzle | `id`, `userId`, `kind` (direct/group), `name`, `lastMessagePreview`, `lastMessageAt` |
| Chat members | Postgres table `chat_members` | Drizzle | Composite PK (`chatId`, `botId`) |
| Messages (display projection) | Postgres table `messages` | Drizzle | `id` (chat-scoped), `chatId`, `userId`, `botId`, `role`, `turn`, `text`, `toolSummary` |
| Transcript / checkpoint | Trigger.dev default storage keyed by `chatId` | Trigger.dev platform | Source of truth for resume/reload; no own `messages` table originally |
| Decisions / audit log | Postgres table `decisions` | Drizzle | Append-only, no FKs (survives bot/chat deletion) |
| Approval requests | Postgres table `approval_requests` | Drizzle | `capability`, `params` (JSONB), `status`, `decisionReason` |
| Memory | Per-sandbox `MEMORY.md` file | Daytona sandbox filesystem | Base64-append `remember`, whole-file `recall`; unbounded |
| Sandbox / workspace | One Daytona container per bot | Daytona | Shell, filesystem, graphical desktop; lazy wake; stop helpers exist but never called |

## Odysseus (`~/odysseus`) — concept reference only

| Concept | Storage location | Technology | Notes |
|---|---|---|---|
| Users / sessions | SQLite `app.db` under `DATA_DIR` | SQLAlchemy | bcrypt + 7-day tokens, TOTP 2FA |
| Agent state / journal | SQLite + server-owned action journal | `src/agent_runtime/journal.py` | Model text cannot insert authoritative receipts |
| Memory | Tiered: JSON (`data/memory.json`) → Chroma vectors → RAG | SQLite + ChromaDB | Fail-closed mutation, owner-scoped chunk IDs |
| Tasks / runs | SQLite tables `TaskRun`, `ScheduledTask` | SQLAlchemy | |
| Workspace / files | Virtual `/workspace` with path confinement | `src/containment.py` | Bubblewrap/rlimits, enforcing vs report_only |
| Approvals | Sealed approval proposals (sha256-bound, TTL 600s) | `src/tool_approvals.py` | Owner/session/run/digest binding |
| Events | In-process event bus | `src/event_bus.py` | |

## Cross-reference: Hard distinctions (nerdbot product model)

| Concept | Definition | Canonical store |
|---|---|---|
| Teammate | Durable identity (persona, instructions, capabilities, memory scope, permissions) | `teammates` table |
| Run | One execution of a task | `runs` table |
| Task | Owned unit of work with dependencies, execution history, verifiable outcome | `tasks` table (can have multiple runs) |
| Memory | Provenanced, scoped content | `memories` table (`scope`, `source`, `confidence`) |
| Artifact | Task output with verification status | `artifacts` table (`type`, `location`, `verification_status`) |
| Approval | Gated action decision | `approvals` table (`run`, `action`, `requester`, `decision`) |
| Event | Project-scoped occurrence | `events` table (`entity`, `event_type`, `timestamp`) |

Rule: Task can have multiple runs; retry must not duplicate tasks; user/chat transcript is not the canonical task log.
