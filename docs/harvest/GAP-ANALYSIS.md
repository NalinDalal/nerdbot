# Gap Analysis — Phase B

**Question**: what do the reference projects have that NerdBot doesn't, and what should we port?
**Rule**: nothing is ported until the owner picks from the ranked list below (CHECKPOINT 1).

---

## 1. Named-teammate chat today — the biggest gap

**What the goal asks**: a Grok-style persistent named teammate you @mention in chat.

**What NerdBot actually does today** (code evidence):

1. Every chat reply uses **one system prompt: the CEO persona**. `chat.py:63` `_ceo_persona_prompt()` → `build_messages()` (`chat.py:139-140`) picks `ceo_prompt` or the generic `SYSTEM_PROMPT`. No other teammate's persona is ever used.
2. **Threads are not bound to a teammate.** `chat_threads` (`store.py:179`) has only `project_id, title, provider_id, summary, tainted` — no `teammate_id`.
3. **No @mention parsing anywhere.** `grep mention` in `chat.py` → nothing. The composer's "∞ Teammates" button (`views-chat.tsx:1110`) opens a side panel; clicking a teammate calls `handleBotSelect` → **navigates away to `/bot/{id}`** (the admin page). It does not insert a mention or route the reply.
4. Bot admin pages (`/bot/{id}`) edit persona/permissions — a different screen from chat.

**What the references do**:

1. **xiryn (MIT)**: a thread belongs to one agent OR one squad (`threads.agentId` / `threads.squadId`); `@mention` routing exists: `/^@(\S+)\s+([\s\S]+)$/` matches a squad member by name and routes the message to them (`lib/telegram/bridge.ts:645-652`).
2. **ai-teammates (idea-only)**: group chats where each bot has its own job+instructions; a `handoff` tool passes the turn to the right teammate and back with a note; explicit prompt rules ("earlier replies may have been written by other teammates — don't present their work as your own").

**Gap**: NerdBot has teammates, personas, boards and delegations — but **chat is monologue with the CEO**. No identity per reply, no mention, no handoff.

---

## 2. Smallest shared Library

**What exists today**:

1. Knowledge system is real: `knowledge.py` (chunk → token-overlap retrieve → cite → attach), tables `knowledge_sources`/`knowledge_chunks`, API `POST/GET /projects/{id}/knowledge`, `POST /tasks/{id}/knowledge/search|attach`.
2. UI: a **Knowledge tab** inside the project page (`dashboard/src/views-project/knowledge.tsx`) — "Ingest knowledge" button (title/content/source form), list of sources, empty state.
3. Memories exist (tiered, project/teammate scope), persona files (soul/goals/wisdom) exist.

**What's missing** (odysseus has it):

1. **No Library page** — no top-level place where the owner's documents/notes live. Odysseus has `/library` + `/notes` + `/memory` as first-class pages (`app.py:977,945,965`).
2. Knowledge is **project-tab-only** and paste-only (a text form). Odysseus's DocsService **indexes a whole directory** and answers queries over it.
3. **No notes/docs at all** — no notes table, no page.
4. **No skills at all** — `backend/src/nerdbot/` has no skills module. (OpenBot's SKILL.md format + odysseus's skill extractor + octop's skills hub all show what this could be.)

**Smallest useful slice**: one **Library page** = the existing knowledge sources + memories shown in one place with add/search, plus one "add file" path (ingest a pasted/uploaded document). Reuses existing tables — small, honest, no new DB surface.

---

## 3. Octop org-layer deltas (what NerdBot doesn't have yet)

Octop = MIT fork of a gone TencentCloud repo + ~1k LOC org layer. Deltas vs NerdBot:

1. **Org roles as data** — `nerdbot_org_agents(org_role, department)`: ceo/pa/growth/specialist, each bound to an agent. NerdBot has `teammates.role` + `teams`/`team_members`, close but no department concept and no "CEO is the only interface" rule enforced anywhere except the CEO persona text.
2. **Approval TTL default** — Octop `APPROVAL_TTL_SECONDS = 900`; NerdBot `DEFAULT_APPROVAL_TTL_S = 600` with expiry + 410 + single-use digest + `consumed_at` — **NerdBot is already stronger here** (octop's split nonce `decision_consumed`/`token_consumed` ≈ NerdBot's digest/consumed model). No port needed; maybe align TTL value only.
3. **`awaiting_approval` as a task status** — Octop's `TASK_STATUSES` includes it. NerdBot tasks have `blocked_reason` instead. Optional idea.
4. **English-first i18n** — Octop: `i18n/{en,zh}.json` + `dashboard/src/locales/{en,zh}.json` (85 keys) with recent commits translating everything to English-first. NerdBot: no i18n. **Likely drop** (single owner, English UI).
5. **API-key masking** — Octop: `redact_servers_for_api`, header values → `"***"` in logs. NerdBot: `redact_provider_config` in backup + `maskSecrets` in dashboard — **mostly covered**; check log-masking as a small hardening item.
6. **Seed personas outside the repo** — Octop reads `~/.nerdbot/org_seed.json` exactly once, never inside the repo (can't leak to VCS). NerdBot's `teammates.seed.json` **lives in the repo**. Small, good idea: support an external seed path.
7. **Auto-approved read-only list** — Octop's `AUTO_APPROVED_TOOLS` (memory/read/list/search/fetch…). NerdBot: `tool_policy[perm] == "auto"` per teammate — more granular, already fine. The *idea* worth copying: a documented default-deny/auto list in one place.
8. **Hidden/unfinished in octop**: org gate shipped "inert" (commit `13df1a24`), no org dashboard UI at all, `persona_mbti` empty.

---

## 4. Hidden / unfinished across sources

1. **ai-teammates workdir (unique, uncommitted)**: approval queue page whose rule is *"approving records the decision but does not auto-run the action"*; `lib/permissions.ts` (`allow/deny/requires_approval`, "a skill can never grant permission"); local Docker sandbox replacing Daytona; 14 test files pinning handoff/guard guarantees. **Exists only in the tarball + patch.**
2. **xiryn**: routine catch-up (`CATCH_UP = 6h`, missed runs fire when the machine wakes, older skipped); vault with OS-keychain key + `vault_approvals`; `request_takeover`; prompt hardening text (untrusted-content rules).
3. **odysseus (AGPL, ideas)**: skill extractor (conversation → reusable skills), DocsService directory indexing, teacher escalation "Tier 2 (TODO)".
4. **nerdbot-7ae4bf8**: old tabbed project page (`views-project.tsx`, 13 tabs) — ancestor, nothing to port; the tabbed-IA idea is already mirrored by today's project tabs.
5. **OpenBot**: not code — a skill file format (frontmatter + size caps + versioned library + explicit install).

---

## 5. Ranked top-10 to port

| # | What | From | License | Effort | Why |
|---|------|------|---------|--------|-----|
| 1 | **Named-teammate chat**: bind thread → teammate, parse `@name`, reply with that teammate's persona + name, "∞ Teammates" inserts mention instead of navigating away | xiryn idea + ai-teammates prompt rules | MIT / idea-only | **M** | The core of the goal; NerdBot has every piece (personas, threads, teammates) but chat ignores them |
| 2 | **Handoff in chat**: model can pass a request to another teammate and get their note back; never answer as CEO for someone else's job | ai-teammates | idea-only | M | Makes #1 feel like a team, not a costume change |
| 3 | **Library page**: one place for knowledge + memories + add/search (reuses existing tables; then add file ingest) | odysseus idea | AGPL ideas | **S–M** | Smallest workspace slice that's visibly missing |
| 4 | **Skill file format**: SKILL.md with frontmatter (name/description/example), versioned, explicit install; skills become files teammates can load | OpenBot | idea-only | M | Nothing exists today; format is small and portable |
| 5 | **External seed file**: allow seed personas from outside the repo (`~/.nerdbot/` or `$NERDBOT_DATA`) | octop `seed.py` | MIT | **S** | Stops seed/persona data leaking into git |
| 6 | **Agent template gallery**: ready-made teammate templates (`name/role/blurb/instructions/uses[]`) for the create-teammate flow | xiryn `lib/templates.ts` | MIT | S | Cheap UX win on Teammates page |
| 7 | **Routine/schedule catch-up**: missed schedule fires when the app wakes (bounded window), old ones skipped | xiryn `lib/routines.ts` | MIT | M | NerdBot schedules silently miss while the laptop sleeps |
| 8 | **Approval queue copy + read-only auto list**: page says "approving records the decision, it does not auto-run"; one documented auto-approved read-only list | ai-teammates workdir + octop gate | idea-only / MIT | S | Matches NerdBot's fail-closed behavior; makes it legible |
| 9 | **Memory remember/recall prompt discipline**: "call recall before answering anything that depends on another conversation; call remember in the same turn" | ai-teammates `trigger/chat.ts` | idea-only | S | NerdBot has recall (`_frame_recalled`) but not the *when to use it* rules |
| 10 | **Log secret masking**: mask provider headers/api keys in server logs the way connectors redact | octop `builder.py` | MIT | S | Small security hardening |

**Total: 10 items, ~4 S, ~5 M, 0 L.**

---

## 6. Drop list (do NOT port)

1. **All odysseus code** — AGPL; ideas only, no direct copies. Its email/cookbook/gallery/calendar/compare/STT/TTS apps: out of scope.
2. **Octop i18n (zh)**, LDAP, SSO, Discord/IM bridge, Tencent connectors, skills *market* — enterprise/multi-tenant features NerdBot doesn't need.
3. **Octop approval TTL=900 / task `awaiting_approval` status** — NerdBot's approval model is already stronger; only take the status idea if a UI need appears.
4. **ai-teammates Daytona** — already replaced by Docker in its own workdir; NerdBot runs local workspaces.
5. **Postgres / Trigger.dev / multi-user** — NerdBot rules: one process, SQLite.
6. **xiryn Telegram bridge, live desktop streaming, OS-keychain vault, MBTI personas** — valuable but large; not in the top-10.
7. **Vector/embedding search** — deliberately not built (documented in `knowledge.py` and the audit).
8. **GitHub write/push, browser automation, email send** — already explicitly deferred in `NERDBOT_AUDIT.md`.
9. **nerdbot-7ae4bf8** — ancestor of main; nothing to port.

---

## 7. Baseline before porting (recorded on this branch)

1. Backend: **503 passed, 0 failed** (was 33 failed / 470 passed on pristine `main`; 27 were test pollution fixed in `7fbb459`, 6 were the backup round-trip bug fixed in `b4cfce5`).
2. Frontend: **165 passed (19 files)**.
3. Branch: `harvest/references` (3 commits so far; `main` untouched).

---

**STOP — CHECKPOINT 1**: pick which of the top-10 to port (and any reordering/drops). Nothing is ported until you choose.
