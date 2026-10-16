# Phase 4 Architecture — Selective Integration Through the Product Model

Proves one vertical (provider + knowledge + schedule + outbox) through the
established domain/permission/task/run/artifact/memory/audit model. Everything
else is a capability flag (see `docs/integration-adapters.md`).

## Provider layer (`providers.py`, `Provider` rows)

- Per-project provider config: kind (`local | mock | openai-compatible`),
  name, config map, capabilities, status. Secrets live only in `config`.
- `schedule_run` resolves the adapter from the task owner's teammate
  (`teammate.provider_id` → active same-project provider, else default
  local). Unservable providers (disabled, cross-project, openai stub)
  produce an explicit **blocked** run, never a silent local fallback.
- Every run records `provider_id`; a `run.provider.<kind>` event is emitted.
- API and backup responses redact secret-shaped config keys.

## Knowledge (`knowledge.py`, `knowledge_sources` + `knowledge_chunks`)

- Ingest requires provenance (`source`) and content; chunking is a
  deterministic word-window splitter (120/30 defaults).
- Retrieval scores token overlap, returns citations
  `{chunk, source_title, source, excerpt, confidence}`.
- `attach_evidence` persists a `knowledge` artifact (file under
  `data/artifacts/`) so evidence rides with the task across restarts.

## Scheduling (`schedules.py` + orchestrator firing)

- Validated 5-field cron subset (`*`, `*/n`, ranges, lists); `next_after`
  scans forward bounded to one year.
- `fire_due_schedules(now)` fires due schedules in `(next_run_at, id)`
  order: overlap lock → task from template → run → outbox notification →
  audit → unlock with advanced `next_run_at` and `fire_count + 1`.
- A firing that raises is recorded (`schedule.error` + notification) and
  unlocked; other schedules still fire. `POST /schedules/{id}/fire` fires
  only when due (400 otherwise).

## Ingress / notify (`orchestrator.ingest_inbound`, `notify.py`)

- `POST /projects/{id}/ingress` (bearer auth): one payload → issue + task +
  `ingress.received` event.
- `outbox` channel persists redacted notification rows. `email`, `slack`,
  `webhook-out` raise `ChannelNotConfiguredError` (400 with stub message).

## Backup (`backup.py`)

- `GET /projects/{id}/backup`: versioned manifest (v1) with all domain rows
  attributable to the project + workspace refs (task, branch, path).
  Provider configs redacted; memories limited to the project scope (see
  `docs/backup-restore.md` for the limitation).
- `POST .../backup/validate`: structural validation incl. secret-leak check.

## Observability

- `X-Request-ID` middleware (echo/generate), structured log fields
  (request_id, principal, method, path, status), extended `/health`
  (version, db, restart count), owner-scoped `/metrics`.
- `restart_count` in `meta`, incremented by the lifespan hook.
