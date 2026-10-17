# Reference-research digest: odysseus, ai-teammates, octop (2026-10-17)

Recorded BEFORE the reference working copies were deleted/archived, so the
patterns live in this repo instead of requiring the originals. Local full
copies remain in `~/nerdbot-backups/*` bundles (+ uncommitted-state patches
and tarballs; see that MANIFEST).

## 1. odysseus (architectural research — the durability/security reference)

- One 38k-line agent loop; compaction at 85% context via utility model,
  deterministic 75% trim for unattended workers, protected recent turns.
- **Sealed approvals**: opaque one-use exact-action grants (owner, session,
  tool, content, workspace, effects, doc digest) — TTL 600s; claim
  re-verifies a canonical digest; browser never sees the payload.
  NerdBot already aligns: approval tokens expire / one-use / purged.
- **Fail-closed memory RMW**: lenient `load_all` for display vs strict
  `load_all_for_update` that never lets a caller overwrite an unreadable
  store with an empty view. Typed `MemoryStoreUnreadable` ≠ "no memories".
- Dispatch gates: request ≠ admission ≠ dispatch ≠ execution ≠ verification;
  durable effect claims written (fsync) before backend invocation.
- Distinct NerdBot strengths already in place: SSRF-pinned fetch + budgets
  (ADR 0007) — beyond what odysseus documents per-URL.

## 2. ai-teammates (the fleet-of-bots product reference)

- `db/schema.ts:56-91` bots: name, job(≤100), instructions(≤4000),
  sandboxId, status(draft/active/paused), modelId, tools allowlist,
  memoryEnabled, scheduleHours; append-only bot_versions; YAML fleet import
  (`actions/bot-import.ts`, `examples/bots.yml`).
- One Docker container + volume per bot; single persistent **MEMORY.md**
  per bot (`lib/sandbox-docker.ts:1,134-141`), recall/remember tools,
  memory gated by `memoryEnabled`.
- **Originator-anchored handoff** in group chats (`trigger/chat.ts:75-182,
  240-296`): the addressed bot owns the final answer; held-set prevents
  revisits; held chain rebuilt from transcript on replay; statuses filter
  who is visible/handable (`getChatBots`).
- Hourly cron wakes scheduled bots in their direct chats
  (`trigger/schedules.ts`). Team-wide append-only decision log.

## 3. octop (TencentCloud "Dots"-style product — the teams/place of a mature multi-agent system)

- **Agent schema**: `db/repos/agents.py:51-71` AgentRow — name, description,
  persona_mbti, default_model, system_prompt, enabled, config_json,
  template_name, icon/color (presentation fields), is_shared.
- **Personas**: MBTI-profile-driven rendered system prompts
  (`infra/agents/persona/loader.py:1-80`, `mbti_profiles.py`).
- **Teams/handoff**: host + members with `ask_agent` peer calls
  (`teams/team_manager.py:1-14`); cycle protection via visited-chain
  tracking (`teams/handoff_guard.py:28-133`, refused status
  `cycle_refused`, chain handed to the callee).
- **Guardrails**: global SecurityPolicy in settings with hitl + tool_guard
  modes (`security/policy_store.py:16-19` — note defaults ship with HITL
  disabled and tool_guard in warn mode); HITL session policies
  (`security/hitl_session.py:47-95`); org approvals with tokens that
  expire/consume (`infra/org/service.py:210-263`).
- **Memory**: namespaced per-agent backends `ns = agent_{agent_id}`
  (`memory/backend.py:68-76`) + slim/compaction stores.
- Org layer: departments + templates + tasks + approvals
  (`infra/org/service.py:35-294`).

## 4. Gap matrix — current NerdBot vs references

| Capability | NerdBot today | Verdict for the stated product |
|---|---|---|
| Single-user assistant workspace | projects/teammates/tasks/runs/artifacts/chat/memory | **Shipped** (Phases 0-5(c)) |
| Real web access, hard-fenced | pinned-transport fetch + DuckDuckGo Lite + wall-clock budgets | **Shipped, stronger than refs** |
| Real provider tool loop | bounded OpenAI-compatible loop, untrusted framing, transcript artifacts | **Shipped** |
| Durable outbox + one channel | webhook-out, leases, bounded retries, manual sweep | **Shipped** (sweep is trigger-only by design) |
| Teammates/personas | `Teammate(persona_text, provider_id, status)` — free text only | Partial: matches ai-teammates' spirit, no per-agent schema beyond persona/provider |
| Per-agent memory scoping | project-scoped memory entries + thread summaries; not per-teammate | Partial — acceptable for single owner; on the fleet path |
| Isolated workspaces | isolated local directories + branches, NOT containers | Partial by design — Docker-per-bot was explicitly out of scope |
| Bot fleet / group chat / handoff | none | Intentionally absent; separate proposal rule applies |
| Sealed/expiring approvals | command approval tokens (expire, one-use, purged) | Partial; no digest-sealed exact-action model |
| Scheduling | cron schedules with overlap lock | Shipped fires-manually; automation deferred |
| Decision/audit log | events (delivered/failed/reclaimed etc.) | Partial; read-mostly dashboard |
| Plugins/skill library, MCP | none (explicitly deferred) | Absent — owner-gated |

## 5. Conclusion

NerdBot matches the goal "AI assistant with AI workspaces" for a single
user, with hardening the references lack (SSRF pinning, lease-swept durable
delivery). The fleet capabilities (containers, per-bot MEMORY.md, handoff
chains, team rooms) remain a separate proposal — their design points are
now captured above, so the original repos are no longer needed for
reference.
