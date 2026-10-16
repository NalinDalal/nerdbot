# Observability

## Health

`GET /health` (unauthenticated, no sensitive data):
`{"status", "version", "db": "ok"|"error", "restarts"}`.

## Request tracing

Middleware assigns `X-Request-ID` (incoming value echoed, else generated)
and logs structured fields per request: `request_id`, `principal`
(`anonymous` when unauthenticated), `method`, `path`, `status`.
No tokens, secrets, or raw payloads are logged.

## Metrics (owner-scoped)

`GET /projects/{id}/metrics`:

- `runs_total`, `runs_by_status` (queued/running/succeeded/failed/…)
- `failed_commands` (runs with non-zero exit)
- `approvals_by_decision`
- `restarts` (global process-start counter in `meta`)
- `schedules`: total/enabled/fired
- `knowledge`: sources/chunks; `notifications`: total

Use `runs_by_status.failed` + `failed_commands` with the task view
(runs carry command/stdout/stderr/duration) to debug a failed run;
`events?entity=run` gives the ordered audit trail.
