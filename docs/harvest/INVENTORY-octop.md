# Inventory – octop bundle (`octop-ecec9f70`)

**Source**: `~/nerdbot-backups/octop-ecec9f70.bundle` → `~/nerdbot-harvest/scratch/octop-ecec9f70`
**License**: **MIT** (README badge + `LICENSE`; the repo is a rebranded fork of TencentCloud/NerdBot)
**Stack**: Python 3.12+ backend (`src/nerdbot/`, 676 `.py` files), Vite/React dashboard, SQLite + Postgres migrations, 60 API routers, 44 migration files

## Provenance status (important)

1. `origin` points at the **bundle file itself** — there is no real network remote configured.
2. `git ls-remote https://github.com/TencentCloud/NerdBot.git` → **`Repository not found`**. The upstream is gone.
3. Branch `work/org-platform` (HEAD `ecec9f70`) is **not on any public remote** — verified: the org commits (`ecec9f70`, `81385fa8`, `7e6cafc3`, `13df1a24`) are **NOT in** any reachable `origin/main`, and no public repo has them.
4. → The org layer work is **potentially unique on this machine**. Preserve the bundle until Checkpoint 2.
5. MIT → code may be copied, but must be recorded in `docs/provenance/PROVENANCE.md` + `THIRD_PARTY_NOTICES.md`.

## What it is

TencentCloud/NerdBot (a multi-user, multi-agent self-hosted assistant) plus a local **organizational layer** built on a branch: CEO + departments + task board + approval gate + org memory. This is the Octop/ai-teammates "team under a CEO" idea, implemented in Python on top of a NerdBot-like codebase.

## The org layer (the crown jewels) — ~1,026 LOC

1. **Files**
   - `src/nerdbot/infra/org/gate.py` (205 lines) — central approval gate
   - `src/nerdbot/infra/org/service.py` (305 lines) — org agents, tasks, approvals, memory
   - `src/nerdbot/api/routers/org.py` (330 lines) — REST API
   - `src/nerdbot/infra/db/repos/org_agent.py` (186 lines)
   - `src/nerdbot/infra/org/templates/` — `templates.py`, `seed.py`
2. **Migrations** (both SQLite and Postgres variants):
   - `021_org_layer.sql` — tables: `nerdbot_org_agents`, `nerdbot_tasks`, `nerdbot_approval_requests`, `nerdbot_org_memory` (+ 5 indexes)
   - `022_org_approval_nonce_split.sql` — splits single-use nonce into `decision_consumed` (human decision) vs `token_consumed` (execution runs once)

### API endpoints (`api/routers/org.py`)

| Method | Path | Purpose |
|---|---|---|
| GET | `/org/agents` | List org agents |
| GET | `/org/templates` | List shipped org templates |
| POST | `/org/agents` | Create org agent from template or scratch |
| PATCH | `/org/agents/{org_role}/{agent_id}` | Update |
| DELETE | `/org/agents/{org_role}/{agent_id}` | Delete |
| POST | `/org/tasks` | Create task |
| GET | `/org/tasks`, `/org/tasks/{task_id}` | List / get |
| POST | `/org/tasks/{task_id}/complete` | Complete |
| POST | `/org/tasks/{task_id}/fail` | Mark failed |
| GET | `/org/approvals` | List approval requests |
| POST | `/org/approvals/{request_id}/decide` | Approve or reject |
| GET | `/org/memory` | Search org memory |
| GET | `/org/memory/{scope}` | List memory for a scope |

### Approval gate behavior (`gate.py`) — ideas worth porting

1. **`AUTO_APPROVED_TOOLS`** — read-only tools never need approval: `current_time`, `agent_list`, `ask_agent`, `memory_search/get/forget`, `read_file`, `list_files`, `grep_files`, `web_search`, `web_fetch`, `ask_user_question`.
2. **`is_external_action()`** — approval needed for anything prefixed `send_`, `post_`, `publish_`, `submit_`, `deploy_`, `push_`, `create_github_pr`, `create_issue`, plus a configured external-action set.
3. **Fail-closed**: `wrap_tool()` wraps every external tool; if a request is needed and can't be granted, it raises `_ApprovalRequired` — the action never runs.
4. **Single-use decisions**: `decide()` returns "request not found or already decided" on repeat — a second approve cannot replay.
5. **TTL**: `APPROVAL_TTL_SECONDS = 900` (15 min) in `service.py:23`; `expire_stale_approvals()` sweeps them.
6. **Audit**: every decision records `approval.approve` / `approval.reject` user events.
7. **Reject un-blocks**: rejecting an approval sets the owning task back to `active`.

### Org roles + personas (`templates/`)

1. Roles: `ceo`, `pa` (personal dept), `growth`, `specialist` (`service.py:17-19`).
2. Three shipped templates: **Chief Executive Officer**, **Personal Assistant**, **Business Growth** — all `template_name="general-assistant"`.
3. `_CEO_PROMPT` (role-based, in `templates.py`): CEO is the only interface the owner talks to; breaks objectives into department work; keeps a persistent task board; reviews results; every external action needs human approval, read-only doesn't; pause and describe when approval is needed.
4. **Personas as data**: `persona_mbti` field exists but is empty — prompts live in DB rows, not code.
5. **Seed file** (`seed.py`): reads `~/.nerdbot/org_seed.json` (or `$NERDBOT_ORG_SEED`) **exactly once**, only when `nerdbot_org_agents` is empty. Never inside the repo → can't leak to version control. Format: `{"agents":[{org_role, department, agent_id, display_name, description, system_prompt, default_model, template_name, enabled}]}`.

### Task board (`service.py`)

1. `TASK_STATUSES = ("active", "blocked", "awaiting_approval", "failed", "completed", "cancelled")` — note `awaiting_approval` as a first-class status.
2. Departments: `personal` (PA), `growth`.

## Rest of the octop repo (context, lower priority)

1. **60 API routers** — connectors (Tencent Docs, WeChat, OpenAlex…), MCP, skills hub, bridge (Discord/IM), LDAP, SSO, webhooks, ACP.
2. **Skills system** (`src/nerdbot/infra/skills/`) — skill packages, skillhub market, install/transfer/presentation.
3. **Plugins** (`plugins/`) — `bilibili-anime`, `demo-greeting-skill`, `demo-toolkit`, `demo-turn-logger`, `demo-ui-card`, `server-status`.
4. **i18n English-first**: `src/nerdbot/i18n/{en,zh}.json` (25 keys) + `dashboard/src/locales/{en,zh}.json` (85 keys); recent commits translated backend + dashboard to English-first copy.
5. **API key / secret masking**: `redact_servers_for_api`, `redact_server_for_api` (`connectors/custom_mcp.py:323-339`), `_redact_mcp_configs_for_log` masks header values as `"***"` (`connectors/builder.py:486-505`).
6. **Docs**: `docs/agent-delegation.md`, `agent-call-agent.md`, `agent-interop-mailbox.md`, `personas.md`, `expert-teams.md`, `memory-slim.md` — design docs for agent-to-agent calls (sync `@` + `ask_agent mode=background` with `job_id`, inbox worker, mailbox).

## Hidden / unfinished

1. Org layer is described as an **"inert gate"** in commit `13df1a24` — foundation landed before wiring.
2. `persona_mbti` is empty for all templates (personas are role prompts only, no MBTI).
3. Dashboard has **no org UI** — `grep -rln org dashboard/src` only hits locales/asset names, not an org page. The org layer is API-only in this branch.

## Relevance to NerdBot

1. **Highest-value source for the "team under a CEO with approvals" goal** — a complete, tested, MIT-licensed design of exactly that.
2. NerdBot already has approvals (`gates.py`, `approvals` table) — compare: TTL expiry, single-use decision vs execution nonce, `awaiting_approval` status, auto-approved read-only list.
3. Org seed file pattern (`~/.nerdbot/org_seed.json`) maps to NerdBot's `teammates.seed.json`.
4. Because the upstream repo is gone, **keep this bundle until Checkpoint 2**.

## Port effort

- **M** — the org layer is ~1k LOC of focused code; NerdBot's schema differs (`teammates`, `objectives`, `approvals`), so re-implement against NerdBot's `store.py` + `gates.py`.
- MIT → copying allowed with provenance records.
