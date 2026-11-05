# Docker Runtime Implementation Plan

## Smallest safe implementation

1. Add `DockerRuntimeAdapter` implementing existing `RuntimeAdapter`.
2. Add config flags and runtime selection.
3. Implement container lifecycle with subprocess `docker` CLI (avoid Docker SDK dependency initially).
4. Mount workspace and output dirs.
5. Enforce limits and timeout.
6. Collect logs and exit code.
7. Container cleanup on all paths.
8. Recovery reconciliation on startup.
9. Tests with mocked docker CLI.

## Files to change (future)

- `backend/src/nerdbot/runtime.py`
- `backend/src/nerdbot/models.py` / migrations
- `backend/src/nerdbot/api.py`
- config/settings
- tests

## Compatibility

- No Docker required by default.
- Local runtime unchanged.
- API contract unchanged.
- DB migration additive.

## Deferred

- GPU inference in containers.
- Advanced orchestration frameworks.
- Browser automation integration.
- MCP in containers.
- Complex volume quota enforcement beyond basic limits.
- Multi-host scheduling.

## Recommendation

Worth implementing now as optional adapter. Smallest safe version uses Docker CLI, default network none, strict limits, additive DB fields, and mocked tests. Defer advanced orchestration and GPU.
