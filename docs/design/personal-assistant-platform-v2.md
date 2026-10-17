# Design: NerdBot v2 — Personal Assistant Platform (better UX, all-in bots)

Status: EARLY — draft; owner gave scope (2026-10-17): single user, "all of it" bot powers,
design-doc-first. SQLite decision included and justified. Slices are sequenced but NOT started.
Commit anchors: engine HEAD verified 2026-10-17; auth `backend/src/nerdbot/auth.py`,
provider resolution `providers.py:343-371` (resolve_run_provider), run orchestration
`orchestrator.py:55-100`, chat `api.py:1365-1450`, dashboard `dashboard/src/*`.

---

## Problem

The engine works end-to-end (verified live 2026-10-17: real Groq gpt-oss-120b chat reply +
real tool-executing task run with artifacts), but the product experience is an empty ops
shell: connection-scoped UI, no self-serve bot creation, BYOK via env var only, persona
unconfigured ("I'm GPT-4"), schedules fire only on trigger, no team/handoff, no per-bot
browser/desktop powers. The owner wants the ai-teammates *user journey* (sign in → set key
→ create bots → talk to them, bots that can use everything we built from octop/odysseus).

## Scope decisions (owner, 2026-10-17)

- **Single user forever-ish**: no multi-tenant accounts, no billing, no OAuth. The
  sign-up/sign-in *journey* is wanted; multiple humans are not. → The existing
  single-principal bearer model stays (auth.py); the UX around it changes.
- **Bot powers: "all of it"** — staged below; desktop/browser automation is a *reversal* of
  the previously the recorded `browser.automation: rejected` status and must carry its own ADR + gate.
- **Storage: SQLite stays** (owner asked us to choose). Rationale: 1 user; engine tables are
  all indexed single-writer; sandboxes/containers are outside the DB; Postgres = ops burden,
  zero benefit now. The store module is a single seam to migrate behind if the fleet decision
  ever turns real. Recorded as ADR-0009 when slice 1 lands.
- **Non-goals**: multi-user auth, Postgres, billing, hosted deployments, fleet-of-bots
  multi-tenant concepts, noVNC remote desktop (chat-side screenshots first).

---

## Target user journey (acceptance definition of done)

1. Open dashboard → sign-in screen (base URL + token) — **exists** (`app.tsx` ConnectScreen,
   session persistence shipped `1072df6`).
2. Settings → paste any OpenAI-compatible key (Groq/OpenRouter/OpenAI/Kimi/Zen...) →
   validated, **encrypted at rest**, shown as fingerprint. (New — extends the keyless-dev
   secret machinery: secrets writes already require `NERDBOT_SECRET_KEY`; BYOK makes that
   the normal path, stored per bot.)
3. Bots page → create a bot: name, job, instructions/persona, model (from a catalog fetched
   from the configured provider where possible), tools allowlist, memory toggle, schedule.
4. Chat → pick bot → talk (streaming path already exists; through-tools missions start as
   tasks from chat or the bot page; run buttons appear inline).
5. Bots can: run commands/files in workspaces (done), browse web incl. search (done),
   remember/recall per project+bot memory (exists via memory provenance), hand off to a
   teammate bot (new), schedule themselves hourly/daily (store exists; trigger needed),
   and — gated slice — drive a sandboxed browser with screenshots.

---

## Slices (each = code + tests + gates + commit + OpenCode review, per house rules)

### S1 — BYOK + Settings + Bot CRUD UI  (the "product exists" slice)

- Backend:
  - New `POST /providers` + `PATCH /providers/{id}` accept inline `api_key` → stored via the
    encrypted-secret column path; responses only ever return a **fingerprint** (`sk-****abcd`).
    `resolve_api_key` (providers.py:93 area) gains a stored-secret decrypt branch;
    keyless-dev stays legal only for non-secret configs (unchanged).
  - `NERDBOT_SECRET_KEY` becomes **required** to save BYOK (fail closed, stated in Settings UI).
  - Model catalog endpoint `GET /providers/{id}/models` → upstream `/v1/models`, allowlist-
    honoring, tolerant parse.
- Dashboard:
  - Settings view: connection status, key form (validate → fingerprint), secret-key state.
  - Bots view: real CRUD (list + create form + edit persona/model/tools/memory) — replaces
    the buried "New project" toggle pattern with a first-class page.
  - Fix persona default for the existing `tm_814ab1a4c779` so self-identification is sane.
- Tests: secret write/read roundtrip, fail-closed without `NERDBOT_SECRET_KEY`, fingerprint
  never leaks via list/get, catalog parse tolerance; dashboard contract tests as they exist
  today (`api.test.ts` pattern).

### S2 — Scheduler autonomy (small, closes a standing trigger-only residual)

- New CLI `nerdbot schedules fire-due` (executes due schedules with overlap lock),
  OS cron: `*/5 * * * *`, log `.nerdbot-data/scheduler.log`. Removes the last
  "trigger-only" residual from the checklist; both loops (sweeps, scheduler) are now real.

### S3 — Team handoff (the octop/ai-teammates "team" feeling, single owner)

- Model: multiple teammates per project = the team. Chat gains `@bot` addressing and a
  `handoff` tool: a bot run may delegate the turn to another teammate's run inside the same
  project (borrowing ai-teammates' handoff semantics incl. anti-bounce "held ids"
  constraint), bounded depth (default 3, hard cap in config). Decision-log table
  (ai-teammates `decisions`, octop decision discipline) as shared team memory.
- Chat UX: group-thread view with per-bot bubbles + handoff markers.
- Tests: handoff loop prevention, depth cap, decision log append/read.

### S4 — Browser/desktop sandbox (gated; reverses an earlier rejection — needs ADR-0012)

- Proposal: per-bot **Docker** sandbox (headless Chromium in container, no host network,
  read-only rootfs, resource caps), tools: navigate/click/type/screenshot (vision→model),
  bounded runs. Chat shows screenshot cards, not live VNC (non-goal above).
- Prereq gate: Docker present + ADR-0012 security review (network policy, escape surface,
  allowed-host policy per project) + explicit owner go/no-go. If Docker absent → slice
  stays rejected, no half-build.
- This is the only slice allowed to touch `browser.automation` status.

### S5 — Chat-first task launch (fills the arc between talk and ops)

- From the chat input: `/task <objective> [bot]` creates the task bound to the addressed
  bot, runs it, and posts the run summary + artifact links back into the thread. Buttons
  for view run artifact pages. Makes the chat the primary surface (per the plan's original
  intent), Projects page becomes the reviewing surface.

---

## Cross-cutting notes

- **Streaming chat** already exists (`/threads/{id}/chat/stream`, dashboard uses it) — S1/S3
  build on it; no re-architecture.
- **Encryption**: BYOK keys are owner-only secrets on an owner machine; stored with the
  Phase-2 secret machinery. Passwords do not exist (single principal stays).
- **Honesty rules unchanged**: capabilities page must reflect each slice the moment it
  ships (statuses move from stub/rejected → ready only with evidence). PLAN.md history
  preserved; each landed slice gets an ADR (0009 SQLite-stays, 0010 BYOK-encrypted,
  0011 handoff model, 0012 browser-reversal).
- Testing: backend gates (`pytest -q`, `ruff`, `mypy`) + dashboard gates per slice;
  no live network in the suite; one manual live smoke per slice recorded in PLAN.md.
- Runbook unchanged: `nerdbot run` + `vite`; cron lines for sweeps (installed) and scheduler
  (S2).

## Risk register (top 3)

1. Browser slice scope-creep → hard ADR gate + "no Docker, no slice".
2. Persona/catalog UX debt repeating the "buried button" problem → S1 bots page is
   first-class with empty states that teach (per the 2026-10-17 lesson).
3. Secret-key friction (BYOK fails closed without `NERDBOT_SECRET_KEY`) → show actionable
   copy in Settings UI ("run: NERDBOT_SECRET_KEY=... nerdbot run --init-secret").

## Verification of this design (measure, per product-engineering)

- S1 done = owner self-serves a Groq/OpenRouter key + their first bot in the UI in <5 min.
- S2 done = a scheduled task fires autonomously overnight with zero user action.
- S3 done = "@bot2 take over" handoff survives $depth-cap and logs a decision.
- S5 done = a full mission from chat → run → artifact → notification without leaving chat.
