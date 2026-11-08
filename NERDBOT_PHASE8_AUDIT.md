# Nerdbot — Phase 8 Product Realignment & AI Workspace Transformation: Stage A Audit

**Status:** Audit only. No application code modified by this document. Awaiting review before Stage B.

---

## 1. Existing Architecture Map

```
Browser (React 19 dashboard, 5 destinations: Chat/Workspace/Agents/Activity/Settings)
  └─ bearer token ──► FastAPI (api.py, ~146 routes)
       ├─ auth.py (single principal "local-owner")
       ├─ store.py (SQLite WAL, 27 tables)
       ├─ orchestrator.py (tasks, runs, delegations, approvals, schedules, PR packages)
       ├─ executor.py (sweep: claim pending tasks to available bots)
       ├─ runtime.py (LocalRuntimeAdapter shell / DockerRuntimeAdapter)
       ├─ providers.py (OpenAI-compat / Ollama / mock / LocalRuntime fallback)
       ├─ chat.py (streaming chat, recall, thread summaries, objective detection)
       ├─ decomposition.py (objective → plan → materialized tasks)
       ├─ agent_tools.py (shell/file/fetch/search tools for model loop)
       ├─ app_tools.py (delegation, approvals, plans, teammate/team/board mgmt)
       ├─ agent_context.py (memory tiers)
       ├─ persona.py (soul/goals/wisdom)
       ├─ workspace.py (isolated git workspaces)
       ├─ knowledge.py (overlap-based RAG)
       ├─ boards.py, delegation.py, schedules.py, notify.py, backup.py
       └─ secrets.py (Fernet)
```

Data: SQLite (`nerdbot.db`) + `.nerdbot-data/` (workspaces, artifacts).

---

## 2. Capability Matrix

| Capability | Existing support | Required action |
|---|---|---|
| Central assistant (chat) | ✅ Verified (streaming, markdown, attachments, model switch) | Preserve/improve |
| Agent creation | ✅ Verified (createTeammate, BotsView wizard) | Integrate into Chat flows |
| Team management | ✅ Verified (teams, team_members, TeamDetailView) | Make first-class in Workspace |
| Workspace/project context | ✅ Verified (projects, tasks, files, knowledge) | Reframe as environment |
| Delegation | ✅ Verified (delegation.py, app_tools._delegate_task) | Surface in assistant |
| Tool execution (shell/file/fetch/search) | ✅ Verified (agent_tools) | Route correctly (see §3) |
| Research (web_search, fetch_url) | ✅ Verified (search.py DDG Lite) | Invoke via model loop |
| Shell execution | ✅ Verified (LocalRuntimeAdapter) | Only when command present |
| Memory (tiers) | ✅ Verified (agent_context, persona) | Integrate |
| Deliverables (artifacts, patches, PR packages) | ✅ Verified (local only) | Surface in workspace |
| Execution monitoring | ✅ Verified (SSE run events, polling) | Integrate into Activity |
| Approvals | ✅ Verified (fail-closed, 3 decisions) | Keep in Activity |
| Model flexibility | ✅ Verified (OpenAI-compat + Ollama + mock) | Native adapters optional |
| Multi-user | ❌ Not implemented | Out of scope (P2) |
| Browser automation | ❌ Rejected | Out of scope |
| Email/Slack send | ❌ Stub | Out of scope |

---

## 3. Current User Journey

1. User opens app → Connect screen (or auto-dev) → Home (Command Center).
2. Home: composer + getting-started steps + recent conversations + conversations list.
3. User types → thread created → streaming reply (Markdown).
4. Objective-like message → plan preview → approve → tasks created (often with empty commands).
5. Tasks run via executor (sweep) or manual Run → if no provider/command → "empty command" block or shell failure.
6. Results appear in Task detail (output, artifacts, runs) and Activity.
7. Bots managed via /bots; projects via /projects; settings via /settings.

**Pain points identified from screenshots:**
- "create other bots please" → objective plan → tasks with empty commands → run fails with "Nothing ran: the shell runtime got no command." The user sees a giant YAML dump (the assistant's reply) and a failed task.
- The assistant did not actually create bots; it only emitted a YAML proposal (by design: `teammate.create` is admin-gated and CEO lacks it).
- No clear distinction between conversational answer, model-driven task, and shell task.

---

## 4. Identified Execution Problems

### 4.1 Empty-shell-command routing
- **Symptom:** Tasks created from chat (coordination steps with `command=""`) run via `LocalRuntimeAdapter` when no provider resolves, raising `ExecutionError("empty command")`.
- **Root cause:** `schedule_run` blocks only when `provider is None AND command empty`. When a provider IS attached but command is empty, it proceeds to `adapter.start_run("", ...)` → LocalRuntimeAdapter (if provider resolved to local) or OpenAICompatibleAdapter (if provider present). For OpenAICompatibleAdapter, `_prompt_text` falls back to task description → runs as model task (correct). For LocalRuntimeAdapter (no provider), "empty command".
- **Where:** `orchestrator.schedule_run` (lines ~160-180), `providers.resolve_run_provider`, `runtime.LocalRuntimeAdapter.start_run`.
- **Fix direction:** Ensure tasks without a command and without a provider are blocked with a clear message (already done via explainRunError translation). For tasks with a provider, they already run as model tasks. The real gap is UX: explain in plain language and offer recovery (done in Phase C). No backend change strictly required, but the message could be clearer.
- **Additional gap:** The CEO bot lacks `teammate.create` permission, so "create bots" requests cannot execute even with a model — by design (admin-gated). The assistant should either (a) propose and route to approval, or (b) clarify that bot creation requires owner action. Currently it just dumps YAML.

### 4.2 Intent classification
- `chat.is_objective_message` / `objectiveLike` regex in views-chat triggers plan creation for any message containing build/create/research/etc. with ≥4 words. This over-triggers: "create other bots please" → plan. That's arguably correct (it's an objective), but the resulting tasks are coordination steps that can't actually create bots (permission gap).
- **Fix direction:** Improve plan generation prompt to mark steps that require admin actions; or have the assistant clarify rather than auto-plan. This is a backend (decomposition.py) + frontend change.

### 4.3 No agent chat threads
- By decision #2, individual agents don't get chat threads. The central assistant delegates via tasks. This is preserved.

---

## 5. Product Information Architecture (Proposed)

```
Home (AI Command Center)
  └─ Chat composer (primary) + contextual activity rail + recent workspaces
Workspace (/projects, /p/:id)
  └─ Overview / Team / Work / Files & Deliverables / Knowledge / Activity
Agents (/bots, /bot/:id)
  └─ Fleet grid + agent detail (Overview/Config/Capabilities/Memory/Work/Activity)
Activity (/activity)
  └─ Running / Queued / Needs attention / Completed / Failed + approvals
Settings (/settings)
  └─ General / Providers / Credentials / Permissions / Integrations / Autonomy / Advanced
```

Advanced surfaces (boards, teams, workbench, capabilities, metrics, backup, events, notifications, memory, schedules, messages, issues) move under Workspace/Settings/Activity as appropriate. No removal.

---

## 6. Proposed Navigation (Phase 1 already done)
Five primary destinations: Chat, Workspace, Agents, Activity, Settings. Advanced disclosure in sidebar. Bottom nav on mobile. ✓ Already implemented.

---

## 7. Backend Gaps

| Gap | Severity | Justification |
|---|---|---|
| No `teammate.create` granted to CEO by default | Medium | Admin-gated by design; assistant can propose but not execute. Could grant via tool_policy "auto" or add an approval-gated flow. |
| No native Anthropic/xAI/Google adapters | Low | OpenAI-compat covers most; native adapters optional. |
| No pause/resume for runs | Medium | Only cancel exists. |
| No GitHub push (PR packages local only) | Medium | Could add if in scope. |
| No vector/semantic memory | Low | Intentionally rejected. |
| No MCP client | Low | Tool ecosystem limited. |
| No multi-user | High (for SaaS) | Out of scope for single-user. |
| Run timeout default 60s | Low | Configurable via env. |

No backend changes strictly required for Phase 8 Stage B if we reuse existing capabilities. The "create bots" flow can be handled by routing to the existing create-teammate wizard via the assistant's plan, with approval.

---

## 8. Implementation Plan (Stages B–F)

### Stage B — Central Assistant (priority)
- Improve `is_objective_message` to distinguish "create bots" (admin action) from "research X" (model task).
- When objective requires bot creation, have the assistant either (a) create a plan whose steps are "coordination" and instruct the owner to use Agents, or (b) route to the create-teammate wizard with prefilled roles.
- Ensure tasks without commands + provider run as model tasks (already works).
- Surface execution progress in chat via the activity rail (done Phase 2).
- Deliverable: assistant summarizes results and links to artifacts.

### Stage C — Workspace Experience
- Reframe ProjectDetailView as a workspace: Overview tab (objective, team, active work, recent accomplishments) instead of generic project header. Reuse existing tabs.
- Add team composition panel in workspace (reuse TeammatesTab data).

### Stage D — Team Experience
- Make Teams first-class: team detail shows members, responsibilities, workspace, active assignments, results. Reuse existing TeamDetailView.

### Stage E — Product-Wide Integration
- Connect assistant → workspace → team → agents → activity. Remove redundant nav friction.

### Stage F — Validation
- End-to-end scenarios 1-6 from the prompt.

---

## 9. End-to-End Scenarios — Status

| Scenario | Status | Notes |
|---|---|---|
| 1. Create bots | Partially implemented | BotsView wizard works; assistant can propose but not execute (permission-gated). |
| 2. Create a team | Implemented | TeamsView/TeamDetailView work. |
| 3. Delegate work | Implemented | Tasks + delegation + executor work. |
| 4. Inspect work | Implemented | Activity + TaskDetail + workspace files. |
| 5. Recover from failure | Implemented (Phase C) | explainRunError + retry. |
| 6. Continue previous work | Implemented | Thread summaries + memory tiers. |

---

## 10. Known Limitations

- "Create bots" via assistant requires owner action (admin-gated); assistant currently emits a proposal YAML rather than executing.
- No pause/resume for runs.
- PR packages are local only (no GitHub push).
- No vector/semantic memory.
- Single principal only.
- No browser automation, email/Slack send, MCP.

---

## 11. Recommended Next Steps (in order)

1. **Improve assistant intent routing** so "create bots" doesn't produce empty-shell tasks; instead propose roles and link to Agents (or grant approval-gated creation).
2. **Reframe Workspace overview** (Stage C) — add an Overview tab summarizing objective/team/active work.
3. **Make Teams first-class** (Stage D) — surface team composition and results.
4. **Improve deliverable surfacing** — link artifacts/PR packages from Activity and Workspace.
5. **Validation pass** (Stage F) — run scenarios 1-6 end-to-end with a real provider.

No backend changes required for items 1-4 except possibly granting `teammate.create` to CEO via default permissions (a one-line change in persona seed, not a schema change).

---

*Audit only. No source modified by this document.*
