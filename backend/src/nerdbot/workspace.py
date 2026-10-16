"""Isolated Git workspaces, one per task.

Each task gets ``<data-dir>/workspaces/<task_id>/`` initialised as a Git
repository (or reused if present). All task file I/O goes through this
manager, never directly to arbitrary disk paths.

Cleanup policy: workspaces persist across app restarts so run evidence and
artifacts remain inspectable. A workspace is removed only by explicit
cleanup (``cleanup_workspace`` / ``DELETE /tasks/{id}/workspace``), which
records a ``workspace.cleaned`` event. Artifact rows keep their recorded
locations; after cleanup those paths may no longer exist on disk.
Recovery never deletes workspaces.
"""

from __future__ import annotations

import os
import shutil
import subprocess
from pathlib import Path


def workspaces_root(data_dir: str | Path) -> Path:
    root = Path(data_dir) / "workspaces"
    root.mkdir(parents=True, exist_ok=True)
    return root


def workspace_path_for_task(data_dir: str | Path, task_id: str) -> Path:
    safe = "".join(c for c in task_id if c.isalnum() or c in ("-", "_")).strip()
    if not safe:
        raise ValueError("invalid task id")
    return workspaces_root(data_dir) / safe


def create_isolated_workspace(data_dir: str | Path, task_id: str) -> Path:
    """Create (or reuse) an isolated Git workspace for a task."""
    path = workspace_path_for_task(data_dir, task_id)
    path.mkdir(parents=True, exist_ok=True)
    if not (path / ".git").exists():
        subprocess.run(
            ["git", "init", "-q", str(path)],
            check=True,
            env={**os.environ, "GIT_CONFIG_NOSYSTEM": "1"},
        )
    return path


def branch_name_for_task(task_id: str) -> str:
    safe = "".join(c for c in task_id if c.isalnum() or c in ("-", "_")).strip()
    if not safe:
        raise ValueError("invalid task id")
    return f"nb/{safe}"


def _git(path: Path, *args: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        ["git", *args],
        cwd=str(path),
        capture_output=True,
        text=True,
        check=False,
        env={**os.environ, "GIT_CONFIG_NOSYSTEM": "1"},
    )


def ensure_branch(path: Path, branch: str) -> str:
    """Create (or reuse) a purposeful branch in the workspace repo.

    Works on fresh repos (unborn HEAD) and existing ones. Never touches
    remotes, never pushes.
    """
    current = _git(path, "branch", "--show-current").stdout.strip()
    if current == branch:
        return branch
    if _git(path, "rev-parse", "--verify", "--quiet", branch).returncode == 0:
        result = _git(path, "checkout", branch)
    else:
        result = _git(path, "checkout", "-b", branch)
    if result.returncode != 0:
        raise RuntimeError(f"cannot prepare branch {branch}: {result.stderr.strip()}")
    return branch


def baseline_commit(path: Path) -> bool:
    """Commit current workspace content as the review baseline. Idempotent:
    returns False when there is nothing new to commit."""
    _git(path, "config", "user.email", "nerdbot@localhost")
    _git(path, "config", "user.name", "nerdbot")
    _git(path, "add", "-A")
    status = _git(path, "status", "--porcelain").stdout.strip()
    head = _git(path, "rev-parse", "--verify", "--quiet", "HEAD").returncode == 0
    if not status and head:
        return False
    result = _git(path, "commit", "-q", "-m", "nerdbot baseline", "--allow-empty")
    return result.returncode == 0


def workspace_diff(path: Path, max_chars: int = 20000) -> str:
    """Uncommitted diff of the workspace against its baseline commit."""
    diff = _git(path, "diff", "HEAD", "--").stdout
    if len(diff) > max_chars:
        return diff[:max_chars] + f"\n... [truncated {len(diff) - max_chars} chars]"
    return diff


def seed_workspace(path: Path, seed_from: str | Path) -> int:
    """Copy fixture/source files into the workspace. Returns file count."""
    src = Path(seed_from)
    if not src.is_dir():
        raise ValueError(f"seed source is not a directory: {seed_from}")
    count = 0
    for item in sorted(src.iterdir()):
        if item.name == ".git":
            continue
        dest = path / item.name
        if item.is_dir():
            shutil.copytree(item, dest, dirs_exist_ok=True)
        else:
            shutil.copy2(item, dest)
        count += 1
    return count


def cleanup_workspace(data_dir: str | Path, task_id: str) -> bool:
    path = workspace_path_for_task(data_dir, task_id)
    if path.exists():
        shutil.rmtree(path)
        return True
    return False


def write_file(data_dir: str | Path, task_id: str, relpath: str, content: str) -> Path:
    """Write a file inside the task workspace; rejects path escape."""
    base = create_isolated_workspace(data_dir, task_id)
    target = (base / relpath).resolve()
    if target != base and base not in target.parents:
        raise ValueError("path escapes workspace")
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(content, encoding="utf-8")
    return target
