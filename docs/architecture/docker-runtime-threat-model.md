# Docker Runtime Threat Model

## Assets

- Host filesystem and credentials.
- NerdBot DB and workspaces.
- Provider secrets.
- Agent task outputs/artifacts.

## Threats and mitigations

1. Container escape / privileged execution
   - Mitigation: non-root, no privileged, no host namespaces, seccomp default, read-only root FS.

2. Docker socket access
   - Mitigation: do not mount socket; backend (outside container) controls Docker.

3. Host credential leakage
   - Mitigation: sanitize env, never export `NERDBOT_TOKEN`, `NERDBOT_SECRET_KEY`; redact output.

4. Cross-workspace access
   - Mitigation: mount only task workspace; no parent data dir.

5. Network exfiltration
   - Mitigation: default network none; allowlist explicit.

6. Resource exhaustion
   - Mitigation: CPU/memory/pids/disk/time limits.

7. Untrusted output execution
   - Mitigation: frame output as untrusted; never execute.

8. Stale containers after crash
   - Mitigation: labels + reconciliation + cleanup job.

9. Image tampering
   - Mitigation: pinned image digest, trusted registry.

10. Secret in image
   - Mitigation: no secrets baked in; inject at runtime only.

## Residual risks

- Kernel vulnerabilities in Docker.
- Misconfigured allowlisted network.
- User explicitly enabling broad access.
- Host compromise outside container scope.

## Security invariants

- Backend authorization remains authoritative.
- Container cannot escalate to host Docker control.
- No host env by default.
- Cleanup always attempted.
