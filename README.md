# NerdBot — Chat-first personal AI workspace

NerdBot is a self-hosted, single-owner personal AI workspace. Conversation is the primary entry point. Open it, start talking, and your existing workspace capabilities — persistent teammates (bots), projects, tasks, isolated Git workspaces, model providers, approvals, and bot-to-bot delegation — are all available from the same screen.

It is one product, not a dashboard assembled around backend resources. Projects organize sustained work but are never required to chat.

## Who it's for

One person (you) running a personal AI workspace on `http://localhost:8080`. You sign in with a bearer token, start a conversation in Home, and optionally create projects to scope sustained work. Your bots are persistent AI teammates with identity, model, permissions, memory, and task history. They execute real work through authorized application tools, never bypassing the backend gates.

## Primary experience

Open NerdBot and you see:

1. **Left sidebar** — New chat, searchable recent conversations, and Workspace navigation (Home, Projects, Bots, Boards, Teams, Settings).
2. **Main conversation area** — A useful empty state when no chat is selected. Pick a conversation or start a new one.
3. **Composer** — Send/stop/retry, model selection, and file/context attachments.
4. **Contextual access** — Project files, teammates/bots, and workspace resources from within the conversation, without navigating away.
5. **Execution view** — When work is underway: what is happening, which tools or bots are involved, progress, results, failures, and controls.
6. **Inspectable results** — Files, artifacts, task links, code diffs, and research outputs as appropriate to the request.

Projects are optional contexts. General assistant chats use your default Home context. Project-scoped chats use the project's files, instructions, tasks, and authorized artifacts. Project information never leaks into unrelated chats; context selection and permissions are explicit and enforced server-side.

## Capabilities

### Conversation
- Start a chat immediately in Home without creating a project.
- Send messages with streaming or non-streaming replies; stop or retry at any time.
- Switch model provider per thread; the default provider is used when none is selected.
- Attach local files or project files to a message.
- Create a task directly from a conversation.
- Threads carry history and summaries; summaries are recalled by later threads in the same project.

### Real assistant behavior (not mock)
- Project context (task and teammate counts) is prepended to the system prompt so the assistant can answer about your workspace.
- Recalled project memory and thread summaries are framed as untrusted context with provenance.
- The assistant does not fabricate tool execution, workspace access, or completed work. Unsupported integrations are identified as unsupported.

### Persistent teammates / bots
- Persistent identity: persona, instructions, configured provider/model, permissions, memory scope, tool policy.
- Bots access the same authorized logical workspace resources as you, subject to permissions.
- Select a bot from the conversation, or delegate to a suitable specialist.
- Per-task Git workspaces are isolated. Patches, files, and artifacts return through the existing transfer model; no unsafe shared Git checkouts.

### Tasks and execution
- Create tasks from conversation or from the Projects/Teams views.
- Run a task; each run produces output, exit code, and artifacts.
- Retry creates a new run, never a new task.
- View runs, artifacts, workspace files, diffs, reviews, PR packages, and the delegation tree.
- Cancel running work; cancellation blocks pending delegations.

### Approvals (fail-closed)
- Admin actions (bot creation, deletion, permission changes, board deletion, etc.) are default-deny and approval-gated unless `tool_policy` sets `"auto"`.
- Three owner decisions: Reject, Approve once (one-use, consumed at execution), or Approve forever (reusable).
- Approvals are enforced by the backend, not just UI buttons.

### Providers
- Model connections per project: OpenAI-compatible, local, or mock.
- Secret-shaped values (API keys) are Fernet-encrypted at rest when `NERDBOT_SECRET_KEY` is set.
- The mock provider works with zero setup for first-run verification.

## Architecture overview

NerdBot is a FastAPI backend (port 8080) with a React + Vite dashboard served by the same server. All state lives in SQLite (WAL mode) by default.

```
Browser (React dashboard, served at /)
  └─ bearer token ──► FastAPI REST + SSE API (localhost:8080)
                        └─ SQLite (nerdbot.db) + isolated Git workspaces (.nerdbot-data)
```

Relevant architecture decision records:
- `docs/decisions/0008-workspace-isolation.md` — workspace isolation and per-task Git workspaces
- `docs/ARCHITECTURE.md` — architecture boundary document and eight extension seams
- `docs/PLAN.md` — phase plan and capability matrix

## Local setup

### Prerequisites

- Python 3.12+ and `uv`
- Node.js and `npm` (for the dashboard)

### Backend

From the repository root:

```bash
uv sync --group dev

# Required bearer token (fail-closed; no anonymous mode)
export NERDBOT_TOKEN="$(openssl rand -hex 32)"

# Optional but recommended: encrypt stored provider API keys at rest
export NERDBOT_SECRET_KEY="$(uv run python -c "from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())")"

# Optional: agent-run wall-clock budget in seconds (default 60).
# Slow providers need a larger budget or runs fail with "provider timed out".
export NERDBOT_RUN_TIMEOUT_S=600

# Optional: local dev token (never combine with a real deployment)
export NERDBOT_INSECURE_DEV_TOKEN=1

# Start the API; it also serves the built dashboard
uv run nerdbot run
```

The server listens on `http://127.0.0.1:8080`. Open `http://localhost:8080` and sign in with your bearer token.

### Dashboard (frontend)

The dashboard is served by the API. To iterate on the frontend with hot reload:

```bash
cd dashboard
npm install
npm run dev        # vite dev server on http://localhost:5173
```

The dev server proxies to the API at `http://127.0.0.1:8080`. Build for production:

```bash
cd dashboard
npm run build      # tsc + vite → dist/ (served by the API)
```

### Verify a configured model

Once a provider is configured (OpenAI-compatible with `base_url` and `api_key`), open a chat in Home and send a message. The assistant should reply using your model. If no provider is configured, the mock provider answers with `[mock] reply to: ...` so you can verify the chat flow end-to-end without external services.

To list available models for a configured provider, open the provider in Settings or use:

```bash
curl -H "Authorization: Bearer $NERDBOT_TOKEN" \
  http://localhost:8080/providers/<provider_id>/models
```

## First-use walkthrough

1. **Open Home.** Start the server, open `http://localhost:8080`, sign in with your bearer token. You land in Home — your default personal conversation context. No project is required.
2. **Start a chat.** Click **New chat** (or pick a recent conversation) and send a message. The assistant answers using your configured provider, or the mock provider if none is set.
3. **Create a project.** From the sidebar, open **Workspace > Projects**, then create a project (a repository plus shared knowledge, memory, tasks, bots, boards, and approvals). Projects are optional organizational contexts; they add files, instructions, history, and scoped work to your chats.
4. **Configure a teammate.** In the project (or the global Fleet page), create a bot: give it a persona, instructions, memory scope, permissions, and attach a model provider. Bots are persistent teammates with their own task history.
5. **Run a real task.** From a conversation, click **Task** to create a task from the chat, or create one in Projects. Assign it to your bot and run it. The bot executes in its isolated workspace. Inspect the run output, artifacts, workspace files, and diff from the execution view or the task page. For admin actions, you will see an approval to decide (reject / approve once / approve forever).

## How context, memory, and permissions work

- **Workspace context:** Project-scoped chats prepend read-only project context (name, task and teammate counts) to the system prompt. General Home chats use your default personal context.
- **Persistent memory:** Provenanced, scoped storage (project / teammate / task). Reads are fail-closed (a read error is an error, never an empty result). Bots may touch their own `teammate:<id>` scope, and the shared `project:<id>` scope only when `memory_scope` is `project`.
- **Task workspaces:** Each task runs in an isolated Git workspace at `<data-dir>/workspaces/<task_id>/`. File I/O goes through the workspace manager, never directly to disk. Returned patches, files, and artifacts are visible in the shared workspace through the transfer model.
- **Bot permissions:** Bots hold permissions from the canonical server catalogue. Admin actions are default-deny and approval-gated. Bot instructions express intent only — they are never authorization.

## Testing, linting, type-checking, builds

### Backend

```bash
uv run pytest -q                 # 351 tests
uv run ruff check backend/src/ tests/
uv run mypy
```

### Dashboard

```bash
cd dashboard
npm run test        # vitest (42 tests)
npm run lint        # eslint
npx tsc --noEmit    # typecheck
npm run build       # tsc + vite → dist/
```

### Combined verification

```bash
# From repository root
uv run pytest -q
uv run ruff check backend/src/ tests/
uv run mypy
cd dashboard && npm run test && npm run lint && npx tsc --noEmit && npm run build
```

## Known limitations

- The dashboard is a single-owner personal workspace; multi-user and multi-tenant access are not implemented.
- External integrations (GitHub issues preview, webhooks, notifications) are present in the backend but some require external credentials or configuration.
- MCP/OAuth connectors are not implemented; provider access is OpenAI-compatible, local, or mock.
- Scheduled tasks (`NERDBOT_EXECUTOR=1`) run a background executor loop; continuous autonomous execution is opt-in.
- Browser-driven interaction tests for critical flows are not yet in the repository.

## Security and data-handling notes

- Single-human-principal bearer-token auth. Fail-closed: HTTP 503 if `NERDBOT_TOKEN` is unset and no dev opt-in.
- Secret-shaped config values are masked in API responses (fingerprints only) and Fernet-encrypted at rest when `NERDBOT_SECRET_KEY` is set.
- SSRF-pinned fetch, fail-closed authentication, workspace path validation.
- Migrations are additive; existing data is preserved.
- This software is provided for your personal use under the AGPL v3.0-or-later. If you make it available over a network to others, the AGPL requires you to offer them the corresponding source code. See `LICENSE`.

## Troubleshooting

**Cannot sign in.** Confirm `NERDBOT_TOKEN` is set on the server and you enter the same token in the dashboard connect screen. For local dev, set `NERDBOT_INSECURE_DEV_TOKEN=1` and use the dev token.

**Provider chat fails.** Confirm the provider is active, has `base_url` and `api_key` (or `api_key_env`), and the model is set. Use `/providers/<id>/models` to verify upstream reachability. Check `NERDBOT_SECRET_KEY` is set if you stored encrypted keys.

**Port already in use.** The API defaults to port 8080. The dashboard dev server defaults to 5173. Change either via environment or vite config if another service occupies them.

**Workspace access denied.** Every chat and project endpoint enforces project ownership server-side. You can only access projects and teammates you own. Home is auto-created for your principal on first access.

**No conversations yet.** Home starts empty. Click **New chat** to create your first thread. Threads are project-scoped; Home threads live in your default Home project.

**Build artifacts.** The dashboard `dist/` directory and local `nerdbot.db` / `.nerdbot-data/` are not committed. Exclude them from backups and version control as they contain local state and potentially encrypted secrets.
