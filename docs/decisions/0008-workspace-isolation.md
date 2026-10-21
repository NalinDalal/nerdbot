# 0008 — Workspace Isolation and the Agent File-Surface Trust Model

Date: 2026-10-21. Status: accepted and implemented.

## Context

Phase 3 gave every bot real file access and real delegation. That made the
file surface the most dangerous part of the system: a task run can read and
write disk, and delegation means the *parent* model influences what a
*child* bot does. Two questions had to be answered before any of that is
safe:

1. Where do bots read and write, and who decides?
2. When multiple bots collaborate, do they share a checkout?

## Decisions

1. **One isolated Git workspace per task.** Each task gets
   `<data-dir>/workspaces/<task_id>/` (`workspace.workspace_path_for_task`),
   initialized as a Git repo with a purposeful branch
   (`nb/<task_id>`). Every task file I/O goes through the workspace manager,
   never to arbitrary disk paths. Task ids are sanitized; workspace paths are
   derived, never accepted verbatim, from input.

2. **Collaboration is explicit patch/artifact transfer, not a shared
   checkout.** Bots never share a working directory. A child bot works in
   its own task workspace; if a parent needs the result, the transfer
   happens through the task/artifact store (delegation results, artifacts,
   diffs) — which is reviewable and permission-checked. Sharing a
   multi-bot checkout was rejected because it has no defined answer for
   concurrent commits, branch ownership, conflict resolution, or who is
   authorized to accept another bot's changes. Global branch naming
   (`nb/<task_id>`) keeps branches collision-free *within* a repo, not as a
   substitute for isolation.

3. **`inspect_workspace` trust model: runtime-authoritative, DB-untrusted.**
   The DB-stored `task.workspace_path` is a *claim*, not a fact. Inside a
   run, the adapter's `workspace_path` parameter is authoritative (the
   runtime mounted it; the bot reads where it actually runs). Outside a
   run, the standalone fallback accepts a DB path only when it resolves to
   the canonical per-task path under *this deployment's* data dir. A stale
   or poisoned path is refused with
   "no workspace directory exists for this task yet" — never read. Facts
   this pins: cross-task reads via a poisoned path are impossible; a
   malicious actor with DB access still cannot redirect a standalone
   inspection to, say, `<data-dir>/..`.
   Tests: `tests/test_agent_tools.py::inspect_workspace_*`.

4. **Listing is read-only and bounded.** `inspect_workspace` returns a
   size+path listing (≤200 entries, output-truncated) plus short
   `git status`; `.git` is skipped; `write_file` rejects path escape before
   touching disk.

5. **Workspaces are evidence.** They persist across restarts; removal is
   explicit only (`DELETE /tasks/{id}/workspace`, recorded as
   `workspace.cleaned`), and recovery never deletes them. Artifact rows
   keep their recorded locations even after cleanup, when paths may no
   longer exist.

## Consequences

- Standalone inspection fails closed: a task whose workspace is missing or
  non-canonical gets an honest refusal, not an arbitrary-directory read.
- Cross-bot file transfer requires a delegating task, artifact, or patch —
  visible to a human in the dashboard, gated by `task.assign` /
  delegation acceptance.
- Tests that assert workspace paths must use the injected adapter
  `workspace_path` or set the task's path to the canonical value.
