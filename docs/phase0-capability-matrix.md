# Phase 0 — Capability/Ownership Matrix

Concepts compared across Octop (OCT), AI Teammates (AT), Odysseus (ODY), and the nerdbot target (NT).

Maturity: working / partial / experimental / documented-only / absent / unverified.
Rec: Reuse (copy code, license permitting) / Adapt (pattern, native TS) / Integrate (dependency) / Build (native) / Defer / Reject.

| # | Capability | OCT (MIT) | AT (ref-only, no LICENSE) | ODY (AGPL — concepts only) | NT target | Rec | Priority |
|---|---|---|---|---|---|---|---|
| C1 | Dynamic teammate creation & config | Agent = DB row via `POST /api/agents`; folders are templates; personas as data | `bots` row = name/avatar/job/instructions/status; CRUD in server actions; version history | n/a (single fixed agent) | `teammates` table + Product API | Build | P0 (design) |
| C2 | Model/provider abstraction & credentials | Global plaintext `providers.api_key`; connectors Fernet-encrypted | Hardcoded single provider; BYOK `llmApiKey` plaintext per user | At-rest `EncryptedText` for keys; fallback chains | Provider registry + encrypted key at rest | Build (Adapt ODY encryption pattern) | P0 |
| C3 | Durable agent runtime & conversation history | LangGraph checkpointer + `thread_messages` display projection | Trigger.dev `chat.agent` + transcript reload; `messages` projection now present | 38k-line self-loop + self-compaction at 85% | Trigger.dev runtime + own `messages` projection | Build (Adapt OCT split) | P0 |
| C4 | Tool execution, permissions, typed failures, guardrails | `ToolGuardPolicy` block/warn/require_approval + YAML regex rules; PII policy | Zod-only validation; 20k truncation; no guardrails; no typed failures | 6-gate dispatch; typed `failure_kind`; sealed approvals; untrusted framing | Typed failure union + TS guardrail rules + untrusted framing | Build (Adapt OCT rules, ODY patterns clean-room) | P0 |
| C5 | Multi-agent handoff & cycle prevention | Persisted `visited_agent_ids` in message metadata; `cycle_refused` with chain; 1024 cap | Originator-anchored composition; in-run `held` Set guard (lost across runs); `note` dropped | n/a | Persisted handoff chain rebuilt from transcript at run start | Build (Adapt OCT pattern) | P0 |
| C6 | Web search, static fetch, browser automation | CDP browser with persistent profiles; idle teardown | Absent; GUI desktop via mouse/keyboard + noVNC | Hardened static fetch: DNS pinning, redirect validation, 2MB/20MB budgets; SearXNG | `webSearch`/`webFetch` with SSRF guardrails; defer browser | Build (Adapt ODY concepts) | P1 (after P0 security) |
| C7 | Persistent memory & context | Per-agent namespace; FTS+vectors via octop-memory; extract/distill/slim | `MEMORY.md` per sandbox; `remember`/`recall`; whole-file recall, unbounded | Tiered JSON→Chroma→RAG; fail-closed mutation; post-chat extraction | Bounded recall + fail-closed reads + size cap + compaction | Build (Adapt ODY fail-closed) | P1 |
| C8 | MCP & external integrations | Three-tier MCP load; OAuth+PKCE; Fernet credentials; tool cache by fingerprint | Absent (`.mcp.json` only wires Trigger dev MCP) | Arbitrary MCP tools fail-high into approval gate | `createMCPClient` per bot; JSONB config on teammates; cache by fingerprint | Integrate (Adapt OCT patterns) | P2 |
| C9 | Scheduling & proactive tasks | APScheduler + `cron` table; `cronjob_*` tools with NL grammar in descriptions | Schema only (`scheduleHours`/`nextRunAt`); `wake-scheduled-bots` Trigger task | n/a | Trigger scheduled task consuming `nextRunAt` + `cronjob_*` tools | Build (Adapt OCT grammar trick) | P2 |
| C10 | File search, knowledge retrieval, citations | RAG chunk 800/120; per-KB SQLite vector sidecar; citation markers | `listFiles`/`readFile` only; no search | RAG over personal docs; owner-scoped chunk IDs | `searchFiles` (ripgrep-in-sandbox) first; pgvector KB deferred | Build (Adapt OCT citation markers) | P2 |
| C11 | Sandbox lifecycle & cost controls | Pluggable backends; browser idle timeout; auto-backup job | `stopBotSandbox`/`listRunningSandboxIds` defined, never called; no idle stop | n/a | Idle-stop scheduled task; cap sandboxes per user | Build | P0 |
| C12 | Human approval & user-question workflows | Live HITL `require_approval`; org gate — inert (verified) | Absent | Sealed approvals bound to owner/session/run/digest + expiry | Defer to Phase 9; `wait.forToken` + `chat.inject` | Defer | P2 |
| C13 | Auth, tenant isolation, secrets, rate limits | argon2, JWT sliding, lockout 5/900s, roles/permissions, SSO | scrypt+`timingSafeEqual`, DB sessions, 30-day cookie; plaintext key; no lockout/limits | bcrypt, TOTP 2FA, rate limits, internal loopback token, at-rest key encryption | Encrypt key at rest; lockout; rate limits; token scope narrowing | Build (Adapt OCT lockout + ODY encryption) | P0 |
| C14 | Observability, testing, deployment | 501 pytest files; mypy `--strict`; rotating logs; in-process metrics | Sentry per-turn `gen_ai.usage.*`; health endpoint; zero tests | Threat model + specs as living docs; honest gap lists | vitest foundation; lint/typecheck/test CI | Build | P0 |
| C15 | Optional organizational agents & workflows | Org layer: schema+migration, `OrgService`, REST — gate unwired (inert) | Absent (out of product scope) | n/a | Deferred pending explicit approval | Defer/Reject | P3 |

### Ownership seams (Phase 1 design)

| Seam | Owner | Boundary contract |
|---|---|---|
| Product API | backend/ | REST + SSE endpoints for projects, teammates, tasks, runs, artifacts, approvals, events |
| Teammates | backend/ | `teammates` table; persona/instructions/capabilities/memory-scope/permissions as data |
| Orchestrator | backend/ | Task → Run scheduling; dependency resolution; retry without duplication |
| Memory | backend/ | `memories` table; scoped reads/writes; provenance; fail-closed |
| Runtime adapters | backend/ | Adapter contract: `startRun`, `pollRun`, `stopRun`, `getArtifacts`; Octop is initial candidate |
| Workspace | workspace_manager/ | Isolated Git workspaces per task; file I/O through adapter |
| Integrations | backend/ | MCP/OAuth connectors behind adapter contract |
| Persistence | backend/ | SQLite default (local dev), PostgreSQL later; schema in SQL + migrations |
