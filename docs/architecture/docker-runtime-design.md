# Docker Runtime Design

## Purpose

Add an optional Docker-based execution runtime alongside the existing local runtime. The local runtime remains the default and must continue to work without Docker installed.

## Reuse vs change

Reusable:
- `RuntimeAdapter` protocol (`start_run`, `RunResult`, `CancelToken`, `BlockedError`, `ExecutionError`, `RunCancelled`).
- `check_command`, `scrub_secrets`, `child_env`, `frame_untrusted`.
- Workspace path contract: task runs in its isolated workspace directory.
- Orchestrator registration/unregistration and cancel endpoint integration.

Must change:
- Docker adapter implementation.
- Runtime selection/config plumbing.
- Cleanup/recovery logic for containers.
- Artifact collection from container workspace volume.

## Proposed interface

```python
class DockerRuntimeAdapter:
    name = "docker"

    def start_run(self, command, workspace, timeout_s=60.0, context=None, *, cancel=None) -> RunResult:
        ...
```

Same signature as local adapter. Internally:
1. Validate command with `check_command`.
2. Build container config from runtime settings.
3. Mount workspace read/write into container at `/workspace`.
4. Mount empty output/artifact directory read/write.
5. Run with resource limits and timeout.
6. Stream logs to backend.
7. On completion, collect stdout/stderr, exit code, workspace diff/patch, artifacts.
8. Ensure container removal.

## Lifecycle

1. Orchestrator calls adapter.
2. Adapter creates container with:
   - image from config
   - command `sh -c <command>`
   - working dir `/workspace`
   - env from sanitized `child_env()` plus explicitly authorized secrets
   - mounts: workspace rw, output rw
   - limits: CPU, memory, pids, timeout
   - network: none by default or allowlisted bridge
   - user: non-root uid/gid
   - read-only root FS where possible
3. Poll container status and cancel token.
4. On cancel: `docker stop` then `docker kill`.
5. On timeout: kill container.
6. Collect outputs.
7. Remove container and temporary mounts metadata.

## Inputs/outputs

- Input workspace mounted at `/workspace`.
- Command output captured via Docker logs.
- Patch/artifact collection by comparing workspace after run or explicit output dir.
- RunResult same fields; output truncated to 8000 chars.

## Resource limits

- CPU: `--cpus` or cgroup quota.
- Memory: `--memory`, `--memory-swap`.
- PIDs: `--pids-limit`.
- Disk: separate volume size limit or workspace quota.
- Time: adapter-level deadline + Docker `--stop-timeout`.

## Network

- Default `--network none`.
- Optional allowlisted network for approved integrations.
- No host networking.
- No Docker socket.

## Security

- Non-root user.
- Read-only root filesystem with tmpfs for `/tmp`.
- No privileged.
- No host env by default.
- Secrets only via explicit runtime context.
- Backend authorization remains source of truth.

## Recovery

- Track container IDs in DB or runtime registry.
- On server restart, reconcile dangling containers by label and remove or adopt.
- Cancel tokens are process-local; recovery marks interrupted runs failed/cancelled and cleans containers.

## Config

Environment/config:
- `NERDBOT_RUNTIME=docker|local`
- `NERDBOT_DOCKER_IMAGE`
- `NERDBOT_DOCKER_CPU`
- `NERDBOT_DOCKER_MEMORY`
- `NERDBOT_DOCKER_PIDS`
- `NERDBOT_DOCKER_NETWORK=none|allowlist`
- `NERDBOT_DOCKER_TIMEOUT`

## DB changes

- `runs.runtime` (local/docker)
- `runs.container_id` nullable
- `runs.resource_limits` JSON
- optional `runtime_events` table for container lifecycle

## Test cases

- Adapter conformance tests matching local adapter.
- Cancel kills container.
- Timeout kills container.
- Blocked command rejected before container start.
- Secret redaction in logs.
- Cleanup after crash.
- Recovery reconciliation.
- No Docker socket/env leakage.

## Deployment

- Docker Compose optional profile.
- macOS dev: Docker Desktop.
- Linux: Docker Engine.
- Keep local runtime default.
