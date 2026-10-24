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
import threading
from pathlib import Path
from typing import Any

#: Directories the file tree never descends into by default. They are where
#: generated/dependency content lives; showing them makes a workspace tree
#: unusable and can walk tens of thousands of files on every refresh.
SKIP_DIRS = frozenset(
    {
        ".git",
        ".hg",
        ".svn",
        "node_modules",
        ".venv",
        "venv",
        "env",
        "__pycache__",
        ".pytest_cache",
        ".mypy_cache",
        ".ruff_cache",
        "dist",
        "build",
        "target",
        ".next",
        ".nuxt",
        ".turbo",
        "coverage",
        ".DS_Store",
    }
)

#: A text file larger than this is refused by the editor API rather than
#: loaded into the browser and the model.
MAX_TEXT_BYTES = 1_000_000

#: Upper bound on entries returned by one tree request. The UI can filter but
#: cannot render an unbounded walk.
MAX_TREE_ENTRIES = 6000

#: Live runs share the owner's tree. One at a time per project prevents two
#: agents from rewriting the same files and making the diff meaningless. This
#: is in-process, matching the current single-process server architecture.
_WORKSPACE_LOCKS: dict[str, threading.Lock] = {}
_WORKSPACE_LOCKS_GUARD = threading.Lock()


def _project_lock(project_id: str) -> threading.Lock:
    with _WORKSPACE_LOCKS_GUARD:
        lock = _WORKSPACE_LOCKS.get(project_id)
        if lock is None:
            lock = threading.Lock()
            _WORKSPACE_LOCKS[project_id] = lock
        return lock


def acquire_workspace_lock(project_id: str) -> bool:
    """Try to claim a project's live workspace for one run. Non-blocking."""
    return _project_lock(project_id).acquire(blocking=False)


def release_workspace_lock(project_id: str) -> None:
    lock = _WORKSPACE_LOCKS.get(project_id)
    if lock is not None and lock.locked():
        lock.release()


def workspace_busy(project_id: str) -> bool:
    lock = _WORKSPACE_LOCKS.get(project_id)
    return bool(lock is not None and lock.locked())


def workspaces_root(data_dir: str | Path) -> Path:
    root = Path(data_dir) / "workspaces"
    root.mkdir(parents=True, exist_ok=True)
    return root


def workspace_path_for_task(data_dir: str | Path, task_id: str) -> Path:
    safe = "".join(c for c in task_id if c.isalnum() or c in ("-", "_")).strip()
    if not safe:
        raise ValueError("invalid task id")
    return workspaces_root(data_dir) / safe


def default_project_workspace(data_dir: str | Path, project_id: str) -> Path:
    """The workspace NerdBot owns for a project when the owner has not
    attached an existing folder."""
    safe = "".join(c for c in project_id if c.isalnum() or c in ("-", "_")).strip()
    if not safe:
        raise ValueError("invalid project id")
    return workspaces_root(data_dir) / safe


def configured_project_root(project: Any, data_dir: str | Path) -> Path:
    """Resolve a project's live root without creating it.

    ``project.config["workspace_root"]`` is the owner's attached folder. It
    is validated at attach time and must be absolute; a relative value is
    ignored rather than interpreted against an unpredictable process cwd.
    """
    config = getattr(project, "config", None) or {}
    raw = config.get("workspace_root") if isinstance(config, dict) else None
    if isinstance(raw, str) and raw.strip():
        candidate = Path(raw).expanduser()
        if candidate.is_absolute():
            return candidate.resolve()
    return default_project_workspace(data_dir, getattr(project, "id", ""))


def is_owned_by_config(project: Any) -> bool:
    config = getattr(project, "config", None) or {}
    raw = config.get("workspace_root") if isinstance(config, dict) else None
    return bool(isinstance(raw, str) and raw.strip())


def ensure_project_workspace(
    project: Any,
    data_dir: str | Path,
    *,
    initialize_git: bool = True,
) -> Path:
    """Create the default workspace, or adopt an attached folder.

    Default workspaces are created and baseline-committed so the diff view is
    meaningful from the first edit. An attached folder is never silently made
    into a repository: if it already has Git we use it, and if it does not we
    leave it alone unless the caller explicitly asked to initialize one.
    """
    root = configured_project_root(project, data_dir)
    configured = is_owned_by_config(project)
    if not root.exists():
        if configured:
            raise ValueError(f"workspace does not exist: {root}")
        root.mkdir(parents=True, exist_ok=True)
    if not root.is_dir():
        raise ValueError(f"workspace is not a directory: {root}")
    git_dir = root / ".git"
    should_init = (not configured) or (initialize_git and _config_bool(project, "initialize_git"))
    if not git_dir.exists() and should_init:
        _init_repo(root)
    return root


def _config_bool(project: Any, key: str) -> bool:
    config = getattr(project, "config", None) or {}
    return bool(isinstance(config, dict) and config.get(key))


def _init_repo(root: Path) -> None:
    subprocess.run(
        ["git", "init", "-q", str(root)],
        check=True,
        env={**os.environ, "GIT_CONFIG_NOSYSTEM": "1"},
    )
    baseline_commit(root)


def current_branch(root: Path) -> str:
    if not is_git_repo(Path(root)):
        return ""
    return _git(Path(root), "branch", "--show-current").stdout.strip()


def is_git_repo(root: Path) -> bool:
    if not (Path(root) / ".git").exists():
        return False
    return _git(Path(root), "rev-parse", "--is-inside-work-tree").returncode == 0


def _inside(root: Path, target: Path) -> bool:
    try:
        target.relative_to(root)
        return True
    except ValueError:
        return False


def safe_workspace_path(root: Path, relpath: str) -> Path:
    """Resolve a client-supplied path inside a workspace, rejecting escape.

    This is the single security boundary for the file API and the editor.
    Absolute paths, ``..`` traversal, and symlinks that resolve outside the
    root are all refused. ``.git`` is refused too: editing repository
    metadata is never a workspace edit.
    """
    if not isinstance(relpath, str) or not relpath.strip():
        raise ValueError("path is required")
    rel = Path(relpath)
    if rel.is_absolute() or ".." in rel.parts:
        raise ValueError("path escapes workspace")
    if ".git" in rel.parts:
        raise ValueError("cannot access repository metadata")
    base = root.resolve()
    target = (base / rel).resolve()
    if not _inside(base, target):
        raise ValueError("path escapes workspace")
    return target


def workspace_meta(root: Path) -> dict[str, Any]:
    root = Path(root).resolve()
    git = is_git_repo(root)
    branch = _git(root, "branch", "--show-current").stdout.strip() if git else ""
    status = git_status_entries(root) if git else []
    file_count = 0
    truncated = False
    if root.is_dir():
        for _, dirs, files in os.walk(root, followlinks=False):
            dirs[:] = [d for d in dirs if d not in SKIP_DIRS]
            for _name in files:
                file_count += 1
                if file_count >= MAX_TREE_ENTRIES:
                    truncated = True
                    break
            if truncated:
                break
    return {
        "root": str(root),
        "name": root.name or str(root),
        "exists": root.is_dir(),
        "git": git,
        "branch": branch,
        "dirty": bool(status),
        "changes": status,
        "file_count": file_count,
        "truncated": truncated,
    }


def list_workspace_files(
    root: Path, limit: int = MAX_TREE_ENTRIES
) -> dict[str, Any]:
    root = Path(root).resolve()
    if not root.is_dir():
        return {"files": [], "dirs": [], "truncated": False}
    files: list[dict[str, Any]] = []
    dirs: list[str] = []
    truncated = False
    for current, subdirs, names in os.walk(root, followlinks=False):
        current_path = Path(current)
        subdirs[:] = sorted(d for d in subdirs if d not in SKIP_DIRS)
        rel_dir = current_path.relative_to(root).as_posix()
        for d in subdirs:
            dirs.append(d if rel_dir == "." else f"{rel_dir}/{d}")
        for name in sorted(names):
            path = current_path / name
            if path.is_symlink():
                # List it, but reading it still goes through safe_workspace_path.
                pass
            try:
                stat = path.stat()
            except OSError:
                continue
            rel = path.relative_to(root).as_posix()
            files.append(
                {
                    "path": rel,
                    "size": stat.st_size,
                    "modified": stat.st_mtime,
                }
            )
            if len(files) >= limit:
                truncated = True
                break
        if truncated:
            break
    return {"files": files, "dirs": dirs, "truncated": truncated}


def read_workspace_text(root: Path, relpath: str) -> dict[str, Any]:
    target = safe_workspace_path(Path(root), relpath)
    if not target.is_file():
        raise FileNotFoundError("file not found")
    size = target.stat().st_size
    if size > MAX_TEXT_BYTES:
        raise ValueError("file too large to display")
    try:
        content = target.read_text(encoding="utf-8")
    except UnicodeDecodeError as exc:
        raise ValueError("file is not text") from exc
    return {"path": Path(relpath).as_posix(), "content": content, "size": size}


def write_workspace_text(root: Path, relpath: str, content: str) -> dict[str, Any]:
    if not isinstance(content, str):
        raise ValueError("content must be text")
    if len(content.encode("utf-8")) > MAX_TEXT_BYTES:
        raise ValueError("file too large to save")
    target = safe_workspace_path(Path(root), relpath)
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(content, encoding="utf-8")
    return {
        "path": Path(relpath).as_posix(),
        "size": target.stat().st_size,
    }


def git_status_entries(root: Path) -> list[dict[str, str]]:
    if not is_git_repo(Path(root)):
        return []
    out = _git(
        Path(root), "status", "--porcelain", "--untracked-files=all"
    )
    entries: list[dict[str, str]] = []
    for line in out.stdout.splitlines():
        if not line.strip():
            continue
        code = line[:2].strip() or "?"
        path = line[3:].strip()
        if " -> " in path:
            path = path.split(" -> ", 1)[1]
        entries.append({"status": code, "path": path})
    return entries


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
    """Uncommitted diff of the workspace against its baseline commit.

    Works on an unborn repository too: in that case there is no HEAD to diff
    against, so the changed/untracked file list is the honest evidence. Never
    raises just because Git is missing; the caller gets an empty string and the
    separate status surface still works.
    """
    path = Path(path)
    if not is_git_repo(path):
        return ""
    if _git(path, "rev-parse", "--verify", "--quiet", "HEAD").returncode == 0:
        diff = _git(path, "diff", "HEAD", "--").stdout
    else:
        diff = ""
    # `git diff HEAD` omits untracked files. A newly created file is exactly
    # the evidence the owner wants after an agent run, so render it explicitly.
    for entry in git_status_entries(path):
        if entry["status"] not in ("??", "A", "AM"):
            continue
        rel = entry["path"]
        target = path / rel
        if target.is_file() and target.stat().st_size <= MAX_TEXT_BYTES:
            diff += _git(
                path,
                "diff",
                "--no-index",
                "--",
                os.devnull,
                rel,
            ).stdout
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
