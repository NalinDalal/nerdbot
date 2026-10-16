# Phase 0 — Pinned Commit SHAs

Pinned as of 2026-10-16. All reference repositories are READ-ONLY; nerdbot is the working tree.

| Repository | Path | Branch | Commit SHA | License | Status |
|---|---|---|---|---|---|
| Octop (primary app-shell candidate) | `~/octop` | `work/org-platform` | `ecec9f7017b42a5cbdd9fcfae7851effc387374c` | MIT | Clean tree except 1 pre-existing modified file (`src/nerdbot/infra/org/service.py`: unused import + EOF newline; no behavior change) |
| Odysseus (concept-only reference) | `~/odysseus` | `dev` | `c3819e3cbf56c4f899eacc66b21115a77d9c570d` | AGPL-3.0-or-later | Clean |
| AI Teammates (schema patterns, reference-only) | `~/ai-teammates` | `main` | `6bea24c7a043dea100bed930f8bbc6da1e14e43a` | No LICENSE present (default copyright) | Fresh `.git` re-initialized; 1,757 working-tree files intact |
| NerdBot Audit (audit reports, read-only) | `~/nerdbot-audit` | N/A | Not a git repository | N/A | 5 report files present |
| NerdBot (working product) | `~/nerdbot` | `main` | No commits yet (empty tree) | TBD | `README.md` + `.gitignore` only; `backend/`, `dashboard/`, `tests/`, `workspace_manager/`, `docs/` exist but empty |

Validation command (run from each repo root):
```bash
git rev-parse HEAD
```
