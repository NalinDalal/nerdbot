# 0003 — Coding Workflow: Issue to Reviewable Patch (Phase 3)

Date: 2026-10-16. Status: accepted.

## Context

Phases 1–2 proved project → teammate → task → run → artifact with persistent,
restart-safe orchestration. Phase 3 turns that substrate into a coding
workflow: issue intake, isolated branched workspaces, verified execution,
reviewer passes, patch capture, and a validated PR candidate — without
pushing code or opening external PRs.

## Decisions

1. **Issues are first-class rows** (`issues` table; manual ingestion only).
   Tasks link via nullable `task.issue_id` (same-project enforced); the task
   view and `GET /issues/{id}` expose the link both ways for provenance.
2. **GitHub is an explicit stub.** `integrations/github.py` defines the
   `GitHubIssueFetcher` contract plus a stub that raises
   `AdapterNotConfiguredError`; `GET /integrations/github/status` reports
   `{"configured": false}`. No credentials, no network, never implied.
3. **One branched workspace per task.** `ensure_task_workspace` creates the
   isolated dir, seeds fixture/source files, records a baseline commit, and
   checks out `nb/<task_id>`. Branch + path persist on the task row, so the
   mapping survives restarts. Worktrees are plain directories (no
   `git worktree` locks); cleanup stays explicit-only per the Phase 2 policy,
   which recovery never violates.
4. **Every executed run leaves a test-log artifact** — `PASSED` on exit 0,
   `FAILED` otherwise (including empty/failed commands). Runs now record
   command, split stdout/stderr, duration, and timestamps.
5. **Reviewers are separate rows, never overwrites.** `submit_review`
   requires an active reviewer who differs from the implementing owner and
   writes a `review` artifact (accepted→passed, needs_work→unverified,
   rejected→failed). Implementation artifacts are structurally untouched.
6. **Patch = diff against the baseline commit**, stored as a file under
   `data/artifacts/` (never inside the workspace, so capture is repeatable).
7. **PR packages are validated payloads, not pushes.** Digest (sha256 over a
   canonical JSON of task/branches/patch/test/review evidence) binds the
   package; `merge_ready` is computed explicitly (patch + passing test +
   accepted review) and stored on the package artifact — `UNVERIFIED`
   otherwise, never silent approval.
8. **Package approvals bind run + task + digest** (`task_id`, `digest`
   columns added to approvals) with the Phase 2 TTL/one-use semantics.
9. **Roll-ups are artifacts too** (`rollup` JSON naming branch, patch, tests,
   review, package, approval status) so reload shows exactly the same state.
10. **CLI ingestion** (`nerdbot ingest-issue`) writes directly to `NERDBOT_DB`
    with an ownership check against `NERDBOT_OWNER`; fixtures live under
    `tests/fixtures/`, never in product data.
11. **Lint lesson (repeat of 0002, still biting):** `sqlite3.Row` needs
    `.keys()`; also request models must live at module level. Both are now
    covered by per-file ignores and tests.

## Consequences

- New tables: `issues`, `reviews`, `pr_packages`; new nullable/extended
  columns migrated idempotently onto Phase 1/2 databases.
- Task view now aggregates issue, reviews, and PR packages alongside
  runs/artifacts (additive; existing contracts preserved).
