# Phase 3 Architecture — Issue Intake to Reviewable Patch

Builds on `docs/ARCHITECTURE.md` and `docs/phase2-architecture.md`. Module
flow stays `api -> orchestrator -> store -> runtime adapter`; integrations
sit behind contracts and are never called by the orchestrator directly.

## Entities added

- **Issue**: source (`manual` supported; `github` reserved), external id,
  title/body, acceptance criteria, repository URL, base branch, labels,
  owner, priority, status.
- **Review**: task, optional run, reviewer, verdict
  (`accepted | needs_work | rejected`), notes, risks.
- **PRPackage**: title/body, base/head branches, labels, patch summary,
  test evidence, review evidence, patch artifact id, sha256 digest.

## Workflow

```
ingest issue → create task (issue_id, owner) → ensure workspace/branch
  → run (test-log artifact, pass or fail) → retry with new commands as needed
  → reviewer pass (review artifact) → capture patch (diff artifact)
  → generate PR package (digest, merge_ready) → package approval (digest-bound)
  → roll-up artifact
```

- Implementation and test phases are ordinary runs with different
  `task.command` values (updated via `PATCH /tasks/{id}`); each retry is a
  new run, terminal runs are never rewritten.
- `merge_ready = has patch AND a passed test AND an accepted review`.
  Anything less yields `UNVERIFIED` — the package is reviewable either way.
- Nothing pushes, merges, or opens external PRs. The deliverable is the
  validated package + approval + roll-up.

## Workspace and branches

`<data>/workspaces/<task_id>/` on deterministic branch `nb/<task_id>`,
baseline-committed at setup. `git diff HEAD` at capture time is the patch.
Seed sources are server-local directories (fixtures in tests). Cleanup is
explicit (`DELETE /tasks/{id}/workspace`); restart/recovery never deletes.

## Evidence files

`patch-*.diff`, `<package-id>.json`, `review-*.md`, `rollup-*.json` live
under `<data>/artifacts/`; artifact rows point at them. Test-log artifacts
point at the workspace (existing behavior preserved).

## Restart

Branch/path/issue/runs/artifacts/reviews/packages/approvals are all DB rows
or files under the data dir: reload shows identical state. Recovery from
Phase 2 is unchanged.

## Explicitly deferred

Credential-backed GitHub fetching (stub only), push/merge automation,
PostgreSQL, browser automation, OAuth/MCP, external coding agents, org
structure.
