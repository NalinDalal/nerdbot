# Nerdbot 2.0 Security Review

## Baseline controls (existing)

- Bearer auth fail-closed; docs gated.
- Workspace path confinement, deny-list exec, approvals, audit, snapshots.
- SSRF-guarded fetch/search/webhook-out.
- Provider secrets encrypted/redacted; export redacts secrets.
- Approval digest binding and one-use consumption.

## Gaps addressed in 2.0 program

- Central autonomy policy evaluator before tool execution (planned/in progress).
- Idempotency keys for external side effects and delivery records.
- Taint propagation through memory/reflection/browser content.
- Self-evaluation reports must include evidence; no self-reported healthy without checks.
- Browser/computer isolation, credential isolation, egress restrictions.

## Open risks / blockers

- Single-principal auth model; token rotation deferred.
- SQLite single-node; Postgres deferred.
- Browser automation/computer use require sandbox/runtime credentials and are feature-flagged.
- Email/Slack/external agents remain stubs unless credentials/adapters implemented.
- Shell deny-list is not a sandbox; autonomous high-risk exec requires stronger isolation.

## Verification checklist

- [ ] Auth fail-closed tests
- [ ] SSRF/egress tests
- [ ] Path confinement tests
- [ ] Secret redaction tests
- [ ] Prompt-injection/taint tests
- [ ] Approval digest/idempotency tests
- [ ] Unauthorized action rejection tests
- [ ] Cross-project isolation tests
