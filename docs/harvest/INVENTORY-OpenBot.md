# Inventory – OpenBot

**Source**: `~/OpenBot` (not a git repo — no `.git`, no LICENSE, no README)
**License**: **unknown** (no license file) → treat as **idea-only**; do not copy text verbatim into NerdBot
**Stack**: none — this is not code. It is agent skill markdown (SKILL.md files) plus one SQLite database.

## What it actually contains (complete file list)

1. **37 files total**, all under `Agents/agent-*/` — four agent directories, each with the same two copies of the same three skills:
   - `.agents/skills/<name>/SKILL.md` + `.openbot-managed.json`
   - `.claude/skills/<name>/SKILL.md` + `.openbot-managed.json` (identical mirror)
2. **Three skills** (duplicated across 4 agents = 24 skill files):
   - `openbot-skill-creator` — how the agent creates/revises a reusable local skill
   - `openbot-data` — shared structured data access
   - `openbot-site-hosting` — static site publishing
3. **`Shared/Data/agent-data.db`** — a SQLite database. **Do not copy** (per harvest rules: no DB files).
4. Empty `Downloads/` and `Transfers/` dirs.

## Skill format (the useful idea)

Each `SKILL.md` is:

1. YAML frontmatter: `name` (≤80 chars), `description` (≤500 chars, says what it does **and when to use it**), optional `example-prompt` (≤1000 chars).
2. Markdown body: intended outcome, workflow, constraints, how to verify success.
3. Optional `scripts/`, `references/`, `assets/` (icon ≤512 KB). Bundle limits: **200 files, 10 MB expanded**.
4. A `.openbot-managed.json` marker: `{"managedBy":"openbot","slug":"...","version":1}`.

The skill-creator workflow (paraphrased, from `openbot-skill-creator/SKILL.md`):

1. `list_local_skills` → check for an existing skill; for revisions read it and keep ID + `expectedRevision`.
2. Build in a workspace folder; **never edit installed copies in `.agents/skills`**.
3. Write frontmatter + concise instructions.
4. Safety check (no secrets, no env files, no symlinks, no archives).
5. `create_skill` / `revise_skill` with the folder path; revisions preserve previous versions; other agents must explicitly `install_local_skill`.

## Relevance to NerdBot

1. **Skill package format** — frontmatter name/description/example-prompt + size caps is a clean, portable spec for NerdBot's skills goal. NerdBot has no skill files today.
2. **Versioned skill library with explicit install** — create vs install are separate actions; revisions keep history. Good behavior to re-implement.
3. **"Never edit installed copies"** — safe upgrade pattern worth copying as a rule.
4. The `.openbot-managed.json` ownership marker is a simple way to know which skills were shipped vs user-made.

## Port effort

- **Low** — the deliverable is a file format + a few workflow rules, not code.
- Since there is no license, re-implement the *format ideas*; write NerdBot's own SKILL.md spec. Record in `docs/provenance/PROVENANCE.md` as idea-only.

## Notes

- No hidden/unfinished work: there is no code at all.
- The four `agent-*` directories are identical duplicates; one is enough as reference.
