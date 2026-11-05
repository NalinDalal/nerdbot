# Architecture Upgrade Plan

## Phase 1 — Audit (complete)
- Cross-project audit created.
- No application code changes.

## Phase 2 — Optional Docker runtime
- Add runtime adapter alongside local runtime.
- Isolated per-task containers, no shared writable FS by default.
- Resource limits, timeout, cancellation, cleanup.
- No privileged, no Docker socket in agent containers.
- Restricted network by default with allowlists.
- Collect logs/exit/patches/artifacts.
- Safe recovery from crashes/restarts.
- Configurable per deployment/teammate/task.

## Phase 3 — GPU/local inference
- Ollama via OpenAI-compatible API.
- Configurable endpoints, per-teammate models.
- Hosted+local combinations.
- Timeouts, context limits, retries, tool-call failures.
- Explicit capability flags.
- Health checks and actionable errors.
- Encrypted credentials at rest.
- GPU optional, not required.

## Phase 4 — Long-running agents
- Persist checkpoints.
- Recover interrupted tasks safely.
- Prevent duplicate privileged actions.
- Cancellation/retry and inspectable history.
- Avoid repeating executed actions.
- Evaluate durable execution engine only if justified.

## Phase 5 — Agent filesystem memory (optional)
- Preserve DB memory.
- Per-agent scoped files with provenance/timestamps.
- Permission boundaries and untrusted context handling.
- Controls for read/write/update.
- Avoid loading full memory dirs into prompts.
- Implement only if real advantage.

## Phase 6 — Integrations/tools
- MCP servers, OAuth, browser automation, connectors.
- Consent, secure credential storage/rotation.
- Tool permissions, approval gates, SSRF protection.
- Network isolation, audit logging.
- No credentials in prompts/logs.

## Phase 7 — Deployment audit
- Verify volumes/mounts/secrets/users/health/restart/backups/migrations.
- Non-GPU default, optional GPU.
- Fix confirmed bugs.

## Phase 8 — Dashboard
- Runtime/container/provider status and logs.
- Delegation tree, resource usage, memory inspection.
- Approval/permission management.
- Preserve visual identity and workflows.

## Engineering constraints
- No unnecessary rewrites.
- No removal of functionality.
- Adapters/modular extensions.
- Backend security enforcement.
- Tests/lint/typecheck/build per phase.
- Migrations for DB changes.
- No silent API contract changes.
