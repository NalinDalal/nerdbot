# Docker Runtime Design (Revised)

## 1. Docker daemon security

Docker daemon is a privileged host boundary. Only the NerdBot backend process (single owner) may invoke Docker. Agent containers never receive `/var/run/docker.sock` or any equivalent. Backend runs Docker CLI via subprocess argument arrays with a restricted service account where possible.

If backend is compromised, attacker gains Docker control; therefore backend hardening, token secrecy, and least privilege are prerequisites. Agent containers are not a containment boundary against backend compromise.

## 2. Runtime adapter contract

Reuse existing `RuntimeAdapter`, `RunResult`, `CancelToken`, typed errors. Docker adapter must match signature exactly. Selection via config (`NERDBOT_RUNTIME`), default local.

## 3. Command execution

- Validate with existing `check_command` before container start.
- Construct Docker invocation as Python list, never shell string.
- Pass task command as container command array: `["sh", "-c", command]` only inside container; host never shells out with command interpolation.
- Treat task code/output as untrusted; frame output.

## 4. Container configuration

- Image pinned by digest.
- User non-root (uid/gid from image or `--user`).
- `--read-only` root FS, tmpfs `/tmp`.
- `--cap-drop ALL`, no privileged, no host namespaces.
- Mounts: task workspace rw at `/workspace`; output dir rw; no parent data dir.
- Env: sanitized `child_env()`, plus explicitly authorized secrets only.
- Labels: `nerdbot.run_id`, `nerdbot.task_id`, `nerdbot.runtime=docker`.

## 5. Network isolation

Default `--network none`. Bridge networking alone is not an allowlist. Approved outbound access requires either:
- host firewall rules, or
- controlled proxy with destination allowlist and DNS restrictions.
Protect against private/loopback/link-local/metadata IPs (127.0.0.0/8, 10/8, 172.16/12, 192.168/16, 169.254.169.254). DNS restricted to proxy or fixed resolver.

## 6. Resource limits

Immediately enforceable:
- CPU: `--cpus`
- Memory: `--memory`, `--memory-swap`
- PIDs: `--pids-limit`
- Timeout: adapter deadline + `docker stop --time`

Host-dependent / not hard guarantees:
- Disk/workspace quota: depends on storage driver/filesystem; document as best-effort unless enforced by volume driver.
- Max artifact size: enforced by backend collection (reject above configured bytes).
- Temp files cleaned by container removal and post-run cleanup.

## 7. Crash recovery

- Unique run ID and container name/label.
- DB stores `container_id`, runtime, status.
- On startup, reconcile labeled containers:
  - running container + DB run running -> adopt or mark interrupted
  - container gone + DB run running -> mark interrupted/failed
  - unknown container -> remove if labeled
- Backend restart during creation: if container ID stored, reconcile; else mark run failed.
- Backend restart during execution: mark run interrupted; do not rerun automatically.
- Orphan cleanup retries with backoff.
- Interrupted runs represented as `interrupted` (new status or metadata) and recoverable manually.
- Recovery never repeats privileged actions; approvals remain consumed and audit log records execution.

## 8. Secrets

- Only explicitly authorized provider secrets may enter container.
- Authorization by backend based on task/teammate policy.
- Prefer mounted read-only secret files over env where possible; env allowed only for short-lived authorized values.
- Redact secrets and ciphertext from logs/output.
- Remove secret mounts after run; container removal destroys ephemeral state.
- Container inspection may expose env, so prefer files and scrub; document residual exposure.

## 9. Image security

- Trusted sources only (configured registry/namespace).
- Digest pinning required.
- Update policy: manual approved updates, no `:latest`.
- Vulnerability scanning expected before approval.
- No arbitrary image pulls by agents.
- Verify non-root user and permissions at startup (image metadata check).

## 10. Tests

See implementation plan.

## Unresolved risks and assumptions

- Docker daemon compromise equals host compromise.
- Host filesystem quota enforcement not guaranteed.
- macOS Docker Desktop virtualization differences.
- Recovery cannot fully prevent duplicate side effects if container completed but backend crashed before recording; mitigation via idempotency/approval audit, not automatic replay.
- Network allowlisting requires external proxy/firewall beyond Docker.
