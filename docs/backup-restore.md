# Backup and Restore

## Export

`GET /projects/{project_id}/backup` (owner only) returns a versioned manifest:

- `version` (currently 1), `exported_at`, `project_id`
- `tables`: every domain row attributable to the project (projects,
  teammates, tasks, runs via task join, memories in the project scope,
  artifacts via task join, approvals via run join, issues, reviews,
  PR packages, providers, knowledge sources/chunks, schedules,
  notifications, events)
- `workspaces`: `{task_id, branch, path}` refs for tasks with workspaces

Secrets: provider `config` keys shaped like secrets (`api_key`, `secret`,
`token`, `password`, …) are replaced with `[redacted]`; notification
payloads are stored redacted at write time.

## Validation

`POST .../backup/validate` checks structure (version, required keys,
per-table lists) and fails if any provider secret is unredacted. It
performs no writes.

## Restore policy

There is **no blind row import**. Restore procedure:

1. Validate the manifest (`backup/validate` → `{"valid": true}`).
2. Provision a fresh database (connect creates schema + migrations).
3. Replay creation through the API in dependency order: project →
   providers → teammates → issues → knowledge → schedules → tasks →
   runs (re-execute; run ids will differ — history, not identity, is
   what matters) → reviews → approvals → notifications.
4. Recreate workspaces via `POST /tasks/{id}/workspace` (branch mapping
   is deterministic: `nb/<task_id>`); re-attach evidence files from the
   manifest's workspace refs where still available.

## Failure modes

- Manifest version mismatch → validate reports `unsupported version`; do
  not replay across major versions.
- Missing workspace dirs → artifacts keep recorded locations; treat paths
  as refs, not guarantees (same rule as explicit cleanup).
- Memories outside the `project:{id}` scope are not exported (limitation:
  teammate/task scopes are not project-attributable in storage).
- Provider secrets are never in the manifest — re-enter credentials on the
  target before enabling non-local providers.
