# Inventory – odysseus

**Source**: `~/odysseus` (repo) + `~/nerdbot-harvest/scratch/odysseus-c3819e3c` (bundle clone)
**License**: AGPL-3.0-or-later → **ideas/behavior only, never paste code**
**Stack**: Python (FastAPI `app.py` + `routes/` + `services/`) + JS frontend, SQLite, Chroma vector store, Docker
**Bundle status**: bundle HEAD `c3819e3c` **is on upstream `odysseus-dev/odysseus` main** (verified by fetch + `merge-base --is-ancestor`). Bundle is redundant; `~/odysseus` is clean at the same commit. No unique local work (no stashes, no unpushed commits).

## What it is

A single-user self-hosted personal workspace: chat with an agent that has tools, plus a set of "apps" (notes, tasks, calendar, library, memory, cookbook, email, gallery). Closest analogue to the Odysseus-style workspace half of the NerdBot goal.

## Feature inventory (with code evidence)

1. **Workspace pages (server-rendered routes in `app.py`)**
   - Where: `app.py:933-986` — `/`, `/notes`, `/calendar`, `/cookbook`, `/email`, `/memory`, `/gallery`, `/tasks`, `/library`, `/backgrounds`, `/login`
   - UI visible: yes (full page set)
   - Maturity: working (shipped product)
   - Relevance: high — this is the exact "library/notes/tasks/docs/memory" page set NerdBot lacks
   - Port effort: L (re-implement page by page)
   - License: AGPL → re-implement, don't copy

2. **Route modules (the API surface)**
   - Where: `routes/` — 60+ files: `chat_routes.py`, `note_routes.py`, `task_routes.py`, `calendar_routes.py`, `memory/memory_routes.py`, `document/document_routes.py`, `vault_routes.py`, `search_routes.py`, `skills_routes.py`, `backup_routes.py`, `auth_routes.py`, `shell_routes.py`, `mcp/mcp_routes.py`, `research/research_routes.py`, `email_routes.py`, `gallery/gallery_routes.py`, `contacts_routes.py`, `webhook_routes.py`, …
   - Relevance: high — good checklist of what a "complete" workspace API includes
   - Port effort: read as a checklist, port selectively

3. **Memory service (remember/recall + skill extraction)**
   - Where: `services/memory/` — `memory.py`, `memory_vector.py`, `memory_extractor.py`, `skills.py`, `skill_extractor.py`, `skill_lifecycle.py`, `skill_importer.py`, `builtin_skills.py`, `service.py`
   - API: `MemoryService.remember(text)`, `recall(query, top_k)`, `get_all(limit)`, `delete(id)` (`services/memory/service.py:75-116`)
   - Distinctive: **skill extractor** — turns conversation into reusable skills, plus a skill lifecycle (import/format/lifecycle). NerdBot has memories but no skill extraction.
   - Relevance: high for the skills half of the goal
   - Port effort: M (behavior re-implement; AGPL)

4. **Docs service (document library + vector index)**
   - Where: `services/docs/service.py` — `DocsService.query(top_k)`, `index(directory)`, `add_document`, `get_stats`, `rebuild_index` (Chroma `persist_dir`)
   - Relevance: high — this is the "Library" concept: index a directory of documents and query it
   - Port effort: M (NerdBot already has `knowledge_sources`/`knowledge_chunks` — compare approaches)

5. **Deep research pipeline**
   - Where: `routes/research/research_routes.py`, `services/research/`
   - Maturity: partial
   - Relevance: med — NerdBot has web_search/fetch but no multi-step research report flow
   - Port effort: L

6. **Tasks + calendar**
   - Where: `routes/task_routes.py`, `routes/calendar_routes.py`
   - Relevance: med — NerdBot already has tasks; calendar/reminders is a gap
   - Port effort: M

7. **Vault (secrets/secure storage)**
   - Where: `routes/vault_routes.py`
   - Relevance: med — compare with xiryn's encrypted vault
   - Port effort: M

8. **MCP integration**
   - Where: `routes/mcp/mcp_routes.py`
   - Relevance: med — external tool connectors
   - Port effort: M

9. **Email (IMAP/SMTP + pollers)**
   - Where: `routes/email_routes.py`, `routes/email_pollers.py`, `routes/contacts_routes.py`
   - Maturity: partial
   - Relevance: low-med
   - Port effort: L

10. **Misc apps**: cookbook (`routes/cookbook_routes.py`), gallery (`routes/gallery/`), compare (`routes/compare_routes.py`), shell (`routes/shell_routes.py`), backup (`routes/backup_routes.py`), auth/2FA (`routes/auth_routes.py`, `core/auth.py`), webhook, STT/TTS, YouTube, faces
    - Relevance: low-med each; mostly outside the NerdBot goal
    - Note: `routes/backup_routes.py` is worth reading for comparison with NerdBot's `backup.py`

## Hidden / unfinished

- `src/teacher_escalation.py:17` — "Tier 2 (TODO): LLM self-eval for ambiguous cases. Not in first cut."
- Frontend is thin in the bundle clone (`frontend/src` only has `shared/`) — the real UI lives elsewhere in the repo layout; treat page names from `app.py` as the source of truth.

## Summary for gap analysis

1. Odysseus is the reference for the **workspace half** (pages: library/notes/tasks/calendar/memory/docs).
2. Its **memory + skill extraction** services are the strongest idea source for NerdBot's skills goal.
3. AGPL: every port must be a re-implementation; record ideas in `docs/provenance/PROVENANCE.md`.
4. Bundle is redundant with upstream — no unique local work to preserve.
