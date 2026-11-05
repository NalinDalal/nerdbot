# Docker Runtime Implementation Plan (Revised)

## Exact implementation sequence

1. Add config and runtime selection (default local).
2. Add DB fields (runtime, container_id, resource limits, interrupted status handling).
3. Implement Docker adapter with subprocess arg arrays.
4. Implement container lifecycle and cleanup.
5. Implement recovery reconciliation at startup.
6. Add tests (mocked Docker CLI).
7. Add deployment docs and compose profile.

## Tests expanded

- Malicious command args rejected.
- Network access attempts blocked/default none.
- Private IP/metadata access blocked.
- CPU/memory/pid/time limits configured.
- Resource exhaustion handling.
- Secret leakage redaction.
- Backend crash during creation.
- Backend crash during execution.
- Orphan cleanup.
- Repeated cancellation.
- Duplicate action prevention (approval audit).
- Image digest/user verification.

## Decisions requiring human approval

- Enabling Docker runtime in production.
- Allowing any outbound network.
- Secret classes permitted in containers.
- Trusted image registry and digest.
- Resource defaults.
- Recovery behavior (fail vs manual retry).

## Recommendation

Smallest safe version is practical: Docker CLI adapter, default network none, strict limits, additive DB changes, mocked tests, manual recovery. Defer true destination allowlisting to proxy/firewall integration, hard disk quotas to storage-specific implementation, GPU, and orchestration frameworks.
