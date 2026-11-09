# Inventory – ai-teammates

**Sources**:
- Bundle clone: `~/nerdbot-harvest/scratch/ai-teammates-6bea24c` (from `~/nerdbot-backups/ai-teammates-6bea24c.bundle`)
- **Workdir with unique uncommitted work**: `~/nerdbot-harvest/scratch/ai-teammates-workdir` (from `ai-teammates-workdir-20261017.tar.gz`)

**License**: **no LICENSE file found** → treat as **idea-only**; do not copy code. (README points at `github.com/code-with-antonio/ai-teammates`, an educational build-along project.)
**Stack**: Next.js 16, React 19, AI SDK 7, Trigger.dev, Daytona (→ Docker in workdir), Drizzle ORM, **Postgres**, shadcn/ui

## Provenance status (important)

1. Bundle HEAD `6bea24c` = workdir HEAD. `git merge-base --is-ancestor 6bea24c HEAD` → yes; workdir has **0 extra commits**.
2. `6bea24c` is **NOT in `~/nerdbot`** (verified `git cat-file -t` → not found).
3. Workdir `origin` = `https://github.com/NalinDalal/nerdbot.git` (reused remote), `git log --branches --not --remotes` → 1 commit (`6bea24c` itself, i.e. the checkpoint commit is unpushed).
4. **The unique work is uncommitted**: workdir `git status` shows **22 modified + ~30 untracked files** that exist nowhere else — covered only by `~/nerdbot-backups/ai-teammates-uncommitted.patch` + the workdir tarball. **Preserve both until Checkpoint 2.**
5. Commit message on HEAD: `checkpoint: preserve pre-roadmap NerdBot snapshot` — this is a fork point before the NerdBot roadmap.

## What it is (bundle, committed state)

"AI Teammates — the open-source alternative to Grok Bot, OpenAI Dots and Meta Muse." Named AI interns, each with a job, a memory and a cloud computer.

### Committed features (code evidence)

1. **Teammates with a job** — `db/schema.ts:56` `bots` table: `name`, `job`, `instructions`, `sandboxId`, `status` (`draft|active|paused`), `scheduleHours` (cron wake, hours, 0=off), `nextRunAt`.
2. **Versioned bot edits** — `bot_versions` table: every save keeps the previous name/job/instructions so the owner can roll back (`db/schema.ts:94`).
3. **Append-only decision log** — `decisions` table, deliberately **no foreign keys**: "a decision log that loses its entries when a bot or chat is deleted is no log" (`db/schema.ts:118`).
4. **Group chats with handoffs** — `lib/handoff-tool.ts` (34 lines): `handoff` tool lets a bot pass the turn to a teammate whose job it is, or hand it back with a note as a report. Description says "No teammate ever receives the same request twice" (anti-bounce guarantee).
5. **Handoff prompt rules** — `trigger/chat.ts:80-100`: originator vs picked-you prompts; "Earlier replies may have been written by other teammates… do not present their work as your own."
6. **Memory across chats** — `trigger/chat.ts:102-105`: `remember` / `recall` tools; notes live in `MEMORY.md` in the bot's sandbox home; explicit instructions ("Never say you do not know something about the person… until you have called recall in this turn").
7. **Shared team context** — `users.sharedContext`: "One context the owner wrote for the whole team; injected into every bot's prompt" (`db/schema.ts:27`).
8. **Per-user BYOK** — `users.llmApiKey`: each user's own Kimi/Moonshot key, used for every model call. No gateway.
9. **Auth** — email + password, **scrypt** hash formatted `salt:hex`, session token cookie (`db/schema.ts:19-45`).
10. **Durable turns** — Trigger.dev runs the chat agent; a long desktop task survives refreshes/redeploys (`trigger/chat.ts`, 306 lines, 50-step cap).
11. **Sandbox per bot** — Daytona: shell, filesystem, graphical desktop streamed over noVNC (`lib/daytona.ts`, `lib/sandbox-tools.ts`, `components/desktop-panel.tsx`).
12. **Bot import from YAML** — `examples/bots.yml`: `shared_context` + `bots[key,name,job,instructions,status,scheduleHours]` + `group_chats[name,bots[]]`.
13. **UI** — `app/(dashboard)/chats/[chatId]`, `group-chat-dialog.tsx`, `group-chat-avatar.tsx`, `team-context-dialog.tsx`, `api-key-dialog.tsx`, `bot-dialog.tsx`, `search-command.tsx`.

## Unique uncommitted work (workdir) — the highest-value part

`git status` in the workdir:

**Modified (22)**: `.env.example`, `README.md`, `actions/bot.ts`, `actions/chat.ts`, `app/(dashboard)/page.tsx`, `app/globals.css`, `app/layout.tsx`, `app/sign-in/page.tsx`, `app/sign-up/page.tsx`, `components/api-key-dialog.tsx`, `components/app-sidebar.tsx`, `components/bot-dialog.tsx`, `components/create-menu.tsx`, `db/schema.ts`, `docker-compose.yml`, `eslint.config.mjs`, **`lib/daytona.ts` (D)**, `lib/handoff-tool.ts`, `lib/model.ts`, `lib/sandbox-tools.ts`, `package-lock.json`, `package.json`, `trigger/chat.ts`

**Deleted**: `lib/daytona.ts` — Daytona **removed**, replaced by local Docker.

**Untracked (new)**: `actions/approval.ts`, `actions/bot-import.ts`, `app/(dashboard)/approvals/page.tsx`, `components/approval-queue.tsx`, `components/bot-import-dialog.tsx`, **`docker/sandbox/`** (Dockerfile, docker-compose.yml, entrypoint.sh), `examples/bots.yml`, **`lib/permissions.ts`**, **`lib/sandbox-docker.ts`**, `lib/sandbox-tool-names.ts`, `lib/sandbox.ts`, `public/nerdbot-*.svg`, `queries/messages.ts`, **`tests/`** (14 test files), `vitest.config.ts`

### What each new piece does

1. **Approval queue** (`actions/approval.ts`, `app/(dashboard)/approvals/page.tsx`, `components/approval-queue.tsx`)
   - `requestApproval()` — creates a pending row and **executes nothing**: *"Nothing is executed here on purpose. The caller must stop and wait for owner resolution before running the requested capability."*
   - `resolveApproval()` — approve/reject with a ≤500-char reason.
   - Approvals page copy: *"Pending requests are created automatically when a bot needs permission. Approving records the decision but does not auto-run the action."* — decision recorded, action re-triggered explicitly (matches NerdBot's fail-closed rule).
   - Schema: `approvalRequests` with `approval_status` enum, `capability`, `botId`, `chatId`, `params`, `decisionReason`.
2. **Permissions library** (`lib/permissions.ts`) — **idea directly aligned with NerdBot's `gates.py`**:
   - *"A skill or instruction may describe an action, but it can never grant the permission to perform it."*
   - `PermissionPolicy = {allow?, deny?, requires_approval?}`; `can()` = deny wins, then allow; `needsApproval()`.
   - `IMPLEMENTED_CAPABILITIES` list: `sandbox.exec`, `notes.read_shared`, `notes.write_own`, `drafts.write`, `web.fetch`, `web.search`, `github.read`, `tasks.create/assign/read/review`, `briefing.write`.
3. **Local Docker sandbox replacing Daytona** (`lib/sandbox.ts`, `lib/sandbox-docker.ts`, `docker/sandbox/`)
   - `SANDBOX_IMAGE=nerd-sandbox:latest`, CPU `0.5`, memory `512m`, network `sandbox-net`, VNC port 6080.
   - `validateSandboxId()` / `containerNameFor()` / `volumeNameFor()` — strict regex validation (no shell injection), deterministic VNC port via hash `7000 + hash % 900`.
   - `MEMORY_FILE = "MEMORY.md"`.
4. **Bot import validation** (`actions/bot-import.ts`, `components/bot-import-dialog.tsx`) — YAML → bots with `memoryEnabled: true` defaults.
5. **Test suite** (`tests/`, 14 files + `vitest.config.ts`): `auth`, `bot-import-validation`, `handoff-chain`, `handoff-guard`, `permissions`, `preview`, `projection-guard`, `prompts`, `sandbox`, `sandbox-docker`, `sandbox-docker.integration`, `schemas`, `truncate`, `helpers`.
   - Notably `handoff-guard` / `projection-guard` — tests for the anti-bounce and no-leak guarantees.
6. **Branding** — `public/nerdbot-logo*.svg` (renamed from ai-teammates → NerdBot).

## Relevance to NerdBot

1. **The named-teammate chat the goal asks for** — group chat + `handoff` + per-bot job/instructions + memory across chats is exactly "a Grok-style persistent named teammate you @mention in chat."
2. **`lib/permissions.ts` policy shape** mirrors NerdBot's `gates.py` — compare allow/deny/requires_approval vs NerdBot's permission strings.
3. **Approval queue semantics** ("approving records the decision but does not auto-run") match NerdBot's fail-closed approvals — good cross-check.
4. **YAML bot import** (`examples/bots.yml`) maps to NerdBot's `teammates.seed.json`.
5. **Docker sandbox design** (image/limits/port hash/validation regex) is a concrete reference for NerdBot's task workspaces.
6. **Decision log with no FKs** — a small, good idea for audit durability.

## Port effort

- **M** — behavior ideas only (no license): handoff rules, permission policy, approval semantics, YAML import shape, sandbox limits.
- The workdir's 14 tests are a useful checklist of guarantees to re-implement in NerdBot's pytest suite.

## Hidden / unfinished

1. Everything in "Unique uncommitted work" is **uncommitted** — if the tarball and patch are lost, it's gone.
2. `.env.swp` and `.env.local` exist in the workdir — **do not copy** (secrets; harvest rules).
3. Daytona removal is mid-flight (`lib/daytona.ts` deleted, `lib/sandbox-docker.ts` new).
