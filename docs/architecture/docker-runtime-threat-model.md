# Docker Runtime Threat Model (Revised)

## Scope

Threats from agent code, network, resources, secrets, images, and host boundary.

## Docker daemon boundary

Docker daemon is privileged host boundary. Only backend invokes it. Agent containers cannot access socket. Backend compromise is host-level risk; mitigations: service account, no shell interpolation, audit logging, secrets hygiene.

## Network threat model

- Bridge networking is not an allowlist.
- Default no network.
- Approved outbound requires proxy/firewall with destination allowlist and DNS control.
- Block private/loopback/link-local/metadata.
- DNS restrictions via proxy or fixed resolver.

## Command execution

- Host uses subprocess arg arrays.
- `check_command` deny list.
- Shell injection prevented by no host shell interpolation.
- Untrusted code isolated in container but may exploit kernel/container runtime.

## Resource exhaustion

- CPU/mem/pids/time enforced by Docker.
- Disk quota host-dependent; backend enforces artifact max size and cleanup.
- Repeated cancellation handled idempotently.

## Secrets

- Explicit allowlist.
- Backend authorization.
- Prefer files; env residual exposure.
- Redaction in logs.
- Removal after execution via container cleanup.

## Image security

- Trusted sources, digest pins, scanning, no arbitrary pulls, non-root verification.

## Crash recovery

- Deterministic labels and reconciliation.
- Interrupted status, no automatic replay of privileged actions.

## Residual risks

- Kernel/container runtime vulnerabilities.
- Misconfigured proxy/firewall.
- Backend compromise.
- Host quota limitations.
- Image supply chain if trust boundary breached.

## Unresolved risks and assumptions

- External firewall/proxy required for true allowlisting.
- Disk quotas depend on storage backend.
- Recovery cannot prove side-effect uniqueness after crash.
