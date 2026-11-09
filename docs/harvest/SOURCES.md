# Sources Summary

Verified survey of every harvest source. Each entry links its full inventory.

## Source table

| # | Source | Location | License | Status | Inventory |
|---|--------|----------|---------|--------|-----------|
| 1 | odysseus | `~/odysseus` + `~/nerdbot-harvest/scratch/odysseus-c3819e3c` | AGPL-3.0-or-later (ideas only) | Bundle HEAD `c3819e3c` **is on upstream main** — redundant, no unique local work | `INVENTORY-odysseus.md` |
| 2 | OpenBot | `~/OpenBot` | **none found** (idea-only) | Not a git repo: 37 files of agent skill markdown + 1 SQLite DB (do not copy DB) | `INVENTORY-OpenBot.md` |
| 3 | xiryn | `~/nerdbot-refs/xiryn` | MIT | Clean clone, fully pushed, no stashes | `INVENTORY-xiryn.md` |
| 4 | octop | `~/nerdbot-backups/octop-ecec9f70.bundle` → `scratch/octop-ecec9f70` | MIT (fork of TencentCloud/NerdBot) | **Upstream repo gone**; `work/org-platform` org layer not on any public remote → potentially unique | `INVENTORY-octop.md` |
| 5 | ai-teammates | `~/nerdbot-backups/ai-teammates-6bea24c.bundle` → `scratch/ai-teammates-6bea24c` | **none found** (idea-only) | HEAD `6bea24c` not in `~/nerdbot`; unpushed checkpoint commit | `INVENTORY-ai-teammates.md` |
| 6 | ai-teammates workdir | `~/nerdbot-backups/ai-teammates-workdir-20261017.tar.gz` → `scratch/ai-teammates-workdir` | **none found** (idea-only) | **22 modified + ~30 untracked files exist nowhere else** (approval queue, Docker sandbox, permissions lib, 14 tests) — only in patch + tarball | `INVENTORY-ai-teammates.md` |
| 7 | nerdbot-7ae4bf8 | `~/nerdbot-backups/nerdbot-7ae4bf8.bundle` → `scratch/nerdbot-7ae4bf8` | MIT (NerdBot itself) | **IS an ancestor of current `main`** — fully redundant | `INVENTORY-nerdbot-7ae4bf8.md` |
| 8 | nerdbot-7ae4bf8 source tarball | `~/nerdbot-backups/nerdbot-7ae4bf8-source.tar.gz` → `scratch/nerdbot-7ae4bf8-source` | MIT | Same snapshot as #7 | `INVENTORY-nerdbot-7ae4bf8.md` |
| 9 | Patches | `~/nerdbot-backups/ai-teammates-uncommitted.patch`, `octop-uncommitted.patch` | n/a | Cover the unique uncommitted work in #6 / #4 | see respective inventories |

## Backup-safety notes (from `~/nerdbot-backups/MANIFEST.txt`)

1. All four bundles pass `git bundle verify` — complete histories.
2. Unique-on-this-machine work: **octop org layer** (#4) and **ai-teammates workdir** (#6). Everything else is redundant with a public remote or with `~/nerdbot` history.
3. Nothing may be deleted until **Checkpoint 2**, when the owner names exact paths.

## What each source contributes to the goal

Goal: Odysseus-style workspace (library/notes/tasks/docs/memory/skills) + Octop/ai-teammates team under a CEO with approvals + Grok-style named teammate you @mention in chat.

1. **odysseus** → workspace pages (library/notes/tasks/calendar/memory), memory + skill extraction services. AGPL: re-implement only.
2. **OpenBot** → skill file format (frontmatter name/description/example-prompt, size caps, versioned library with explicit install).
3. **xiryn** → per-teammate threads, **`@mention` routing** (`lib/telegram/bridge.ts:645`), agent templates, routine catch-up, vault approvals, prompt hardening. MIT.
4. **octop** → **org layer**: CEO/PA/growth roles, approval gate (auto-approved read-only list, single-use decision vs execution nonce, `APPROVAL_TTL_SECONDS=900`, `awaiting_approval` status), org seed file `~/.nerdbot/org_seed.json`, English-first i18n, secret masking. MIT.
5. **ai-teammates** → group chat **handoff tool**, `remember`/`recall` memory across chats, shared team context, BYOK, decision log with no FKs, YAML bot import (`examples/bots.yml`). Idea-only.
6. **ai-teammates workdir** → approval queue ("approving records the decision but does not auto-run"), `lib/permissions.ts` policy (allow/deny/requires_approval), local Docker sandbox design, 14 test files as a guarantees checklist. Idea-only.
7. **nerdbot-7ae4bf8** → historical baseline only; note the old tabbed project page (`views-project.tsx`) as an alternative IA.

## Rules carried into Phase C

1. References stay **read-only** until Phase E (owner confirms deletion).
2. Never copy `.env`, keys, tokens, or DB files; scrub secrets from any quoted text.
3. AGPL (odysseus) → ideas/behavior only, re-implement. No license (OpenBot, ai-teammates) → idea-only. MIT (xiryn, octop) → copy allowed with `docs/provenance/PROVENANCE.md` + `THIRD_PARTY_NOTICES.md` entries.
4. NerdBot rules: one process, SQLite, `store.py` only DB access, `gates.py` permissions, approvals fail closed, persona never grants permissions, taint rules stay, small swappable functions, full docstrings, tests for everything new, migrations + backup manifest for new tables.
5. Commit small steps on `harvest/references`; never touch `main`.

---

**Next**: Phase B — `GAP-ANALYSIS.md`, then **CHECKPOINT 1** (owner picks features before any porting).
