# Inventory – nerdbot-7ae4bf8

**Sources**: `~/nerdbot-backups/nerdbot-7ae4bf8.bundle` → `~/nerdbot-harvest/scratch/nerdbot-7ae4bf8`, plus `nerdbot-7ae4bf8-source.tar.gz` → `~/nerdbot-harvest/scratch/nerdbot-7ae4bf8-source`
**License**: MIT (NerdBot's own license — same project as `~/nerdbot`)
**Stack**: same as current NerdBot (FastAPI + `store.py` SQLite + React dashboard), but 24 backend `.py` files vs today's much larger set

## Provenance status

1. `git cat-file -t 7ae4bf8` in `~/nerdbot` → `commit`; `git merge-base --is-ancestor 7ae4bf8 HEAD` → **IS an ancestor of current `main`**.
2. `git branch -a --contains 7ae4bf8` → `main`, `origin/main`.
3. `git bundle verify` → complete history.
4. → **Fully redundant**: everything in this bundle is already in `~/nerdbot`'s history (just older). Nothing unique to preserve.

## What it is

A Phase-1 checkpoint of NerdBot itself: "Persistent AI teammate workspace centered on three concepts: Project / Teammate / Task." One project, one teammate, one task through one runtime adapter.

## Differences vs current `~/nerdbot` (evidence from `diff -rq`)

### 1. Removed file worth knowing about: `dashboard/src/views-project.tsx` (1,009 lines)

- The **only file that exists in 7ae4bf8 and not in current** (besides docs).
- A single **tabbed Project detail page**: `TABS = Tasks, Chat, Teammates, Providers, Issues, Knowledge, Schedules, Approvals, Notifications, Memory, Backup, Metrics, Events`.
- Current NerdBot split this into separate pages: `views-projects.tsx`, `views-chat.tsx`, `views-approvals.tsx`, `views-boards.tsx`, `views-bot.tsx`, `views-teams.tsx`, `views-task.tsx`, `views-work.tsx`, `views-workbench.tsx`, `views-settings.tsx`, `views-home.tsx`.
- **Idea worth re-checking at gap analysis**: the old page kept "each thing in one place" — a project's whole world behind one route with tabs. Compare with today's NerdBot page rule (one main action per page) before deciding which layout serves the owner better.

### 2. Docs that exist there

`docs/ARCHITECTURE.md`, `docs/PLAN.md`, `docs/backup-restore.md`, `docs/decisions/0001…0007` (ADRs: layout consolidation, phase2 persistent orchestration, phase3 coding workflow, phase4 feature selection, phase1 provider loop, phase2 security, phase3 fetch), `docs/phase0-*.md` (capability matrix, commit SHAs, risks, startup commands, storage matrix), `docs/phase2/3/4-architecture.md`, `docs/integration-adapters.md`, `docs/observability.md`, `docs/provenance/`.

Most of these still exist in current `~/nerdbot/docs/`; the current repo has grown many more (`NERDBOT_AUDIT.md`, `FLEET-GAP-ANALYSIS.md`, `GROK-COMPARISON-AND-AUDIT…`, `WORKBENCH-AUDIT…`, `harvest/`, `audits/`, `design/`, `architecture/`).

### 3. `docs/PLAN.md` (historical, useful as a baseline)

Declares the original scope: *"Single-user personal AI assistant. Not SaaS, not multi-tenant, no billing, no company hierarchy, no org management."* Capability inventory at that time: no agent loop, no UI, backup export only (no import), stubbed providers. All of that has since been built — good before/after evidence for how far NerdBot has come.

### 4. Code delta

- 24 backend `.py` files then vs now: `diff -rq` shows current has many new modules (`agent_context.py`, `app_tools.py`, `approval_flow.py`, …) and most shared files differ.
- Tests: 15 test files then vs ~45 now.

## Relevance to NerdBot

1. **Low** — it's an ancestor; no unique code.
2. Two takeaways for gap analysis:
   - the **tabbed project page** (`views-project.tsx`) as an alternative IA to today's page-per-entity split;
   - `docs/PLAN.md`'s explicit "not org management" scope note — the harvest goal now *adds* org/team management, so that line is now stale and should be acknowledged when writing the gap analysis.

## Port effort

- **None** (already in history). Read `views-project.tsx` for the tabbed-layout idea only.

## Hidden / unfinished

- Nothing unique. Do not spend time here beyond the two notes above.
