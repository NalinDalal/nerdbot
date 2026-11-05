# Docker Runtime Verification

## Files changed

- backend/src/nerdbot/runtime.py
- backend/src/nerdbot/providers.py
- backend/src/nerdbot/store.py
- backend/src/nerdbot/models.py

## Architecture implemented

Optional DockerRuntimeAdapter implementing RuntimeAdapter. Local remains default. Config via NERDBOT_RUNTIME=docker. Subprocess arg arrays. Non-root, read-only root, cap-drop, no-new-privileges, network none, resource limits, cleanup, recovery helper.

## Test results

- pytest targeted persistence/security: 26 passed, 8 failed (pre-existing crash recovery/provider failures).
- ruff: pass after fixes.
- mypy runtime.py: pass.
- Real Docker smoke: exit 0, non-root uid 1000, output collected.

## Crash-recovery failure root cause

Failing test: test_crash_recovery_marks_orphaned_running. Root cause: done_task has no configured provider; current product requires a provider for execution, so done_run is blocked. This is pre-existing behavior, not introduced by Docker changes. Evidence: same failure on stashed baseline.

## Security configuration evidence

- No --privileged, no socket mount, no host env injection (child_env).
- --network none.
- --read-only, --cap-drop ALL, --security-opt no-new-privileges.
- --user 1000:1000 (verified).
- Image configurable but defaults to digest-pinned placeholder; no arbitrary selection in code.
- Secrets not injected in Docker adapter.

## Remaining risks

- Host-dependent disk quotas.
- Recovery cannot prove side-effect uniqueness.
- Real image digest must be supplied by operator.
- Network allowlisting deferred.

## Known limitations

- Outbound network allowlisting not implemented.
- Provider secrets not injected.
- GPU/MCP/browser deferred.

## Enable/test commands

NERDBOT_RUNTIME=docker NERDBOT_DOCKER_IMAGE=<digest-pinned-image> NERDBOT_RUN_TIMEOUT_S=60 uv run nerdbot run
