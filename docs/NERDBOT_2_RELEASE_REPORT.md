# Nerdbot 2.0 Release Report

## Status

In progress on branch `nerdbot-2.0/transformation` from `main@964476b`. No release claim yet.

## Implemented

- Stage 0 baseline audit/revalidation and Nerdbot 2.0 docs created.
- Existing tests passing at baseline (43 passed, 1 warning).

## Reused

- Existing task/run lifecycle, approvals/checkpoints, gates/permissions, workspace gateway, provider routing, memory/knowledge/library, SQLite store, FastAPI/React stack.

## Pending

- Persistent agent supervisor/runtime.
- Central autonomy policy engine enforcement.
- Browser/WebMCP/computer capability adapters.
- Real integration adapters beyond existing webhooks/GitHub.
- Memory reflection/self-evaluation.
- Outcome-first UI transformation.
- Full verification and failure-scenario coverage.

## Verification

See `docs/NERDBOT_2_TEST_REPORT.md`.

## Blockers / external requirements

- Real browser/computer sandbox/runtime and credentials for end-to-end browser/WebMCP automation.
- Slack/email/Telegram credentials and app configuration for real adapters.
- Owner decisions on autonomy boundaries, deployment target, and external channel priority.

## Deployment / verification

Will be updated after implementation. Current baseline: `docker compose up --build`, API on 8080, dashboard on 5173.
