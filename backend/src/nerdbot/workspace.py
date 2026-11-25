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

import hashlib
import json
import os
import shutil
import subprocess
import threading
from contextlib import contextmanager, suppress
from contextvars import ContextVar, Token
from dataclasses import dataclass, field
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

# ---------------------------------------------------------------------------
# Active workspace binding (context-local, Odysseus-style)
# ---------------------------------------------------------------------------

_ACTIVE_WORKSPACE: ContextVar[str | None] = ContextVar("nerdbot_active_workspace", default=None)


@dataclass(frozen=True)
class WorkspaceActor:
    """Who is performing a workspace action.

    Args:
        kind: "user" for project owner/human, "teammate" for an AI teammate.
        id: Principal/teammate id.
        project_id: Project the action is scoped to.
        teammate: Optional teammate object for permission/autonomy checks.
    """

    kind: str
    id: str
    project_id: str = ""
    teammate: Any = None


@dataclass
class WorkspaceResult:
    """Result of a workspace gateway action.

    Args:
        ok: Whether the action succeeded.
        action: Action name.
        path: Resolved relative path, when applicable.
        output: Human/model-readable output.
        data: Structured payload.
        error: Error message when not ok.
        denied: True when blocked by permission/policy/approval.
        audit_id: Event/audit row id if recorded.
    """

    ok: bool
    action: str
    path: str = ""
    output: str = ""
    data: dict[str, Any] = field(default_factory=dict)
    error: str = ""
    denied: bool = False
    audit_id: str = ""


def set_active_workspace(path: str | Path | None) -> Token[str | None]:
    """Set the context-local active workspace root.

    Args:
        path: Workspace root path, or None to clear.

    Returns:
        ContextVar token that can be used to reset the previous value.
    """
    value = str(Path(path).resolve()) if path else None
    return _ACTIVE_WORKSPACE.set(value)


def get_active_workspace() -> str | None:
    """Return the context-local active workspace root, if bound.

    Returns:
        Absolute workspace root string, or None.
    """
    return _ACTIVE_WORKSPACE.get()


@contextmanager
def bound_workspace(path: str | Path | None):
    """Context manager that binds the active workspace for the current context.

    Args:
        path: Workspace root path, or None.

    Yields:
        The bound workspace path string, or None.
    """
    token = set_active_workspace(path)
    try:
        yield get_active_workspace()
    finally:
        _ACTIVE_WORKSPACE.reset(token)

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


class WorkspaceConflictError(ValueError):
    """Optimistic concurrency conflict for a workspace file operation."""


def _file_meta(path: Path, rel: str) -> dict[str, Any]:
    st = path.stat()
    return {
        "path": Path(rel).as_posix(),
        "size": st.st_size,
        "modified": st.st_mtime,
    }


def file_sha256(path: Path) -> str:
    """Return sha256 hex digest for a file.

    Args:
        path: File path.

    Returns:
        Hex digest string.

    Raises:
        OSError: If file cannot be read.
    """
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(65536), b""):
            h.update(chunk)
    return h.hexdigest()


def read_workspace_text(root: Path, relpath: str) -> dict[str, Any]:
    """Read a text file from workspace and return content plus hash metadata.

    Args:
        root: Workspace root.
        relpath: Relative file path.

    Returns:
        Dict with path, content, size, modified, sha256.

    Raises:
        FileNotFoundError: If missing.
        ValueError: If too large or not text.
    """
    target = safe_workspace_path(Path(root), relpath)
    if not target.is_file():
        raise FileNotFoundError("file not found")
    size = target.stat().st_size
    if size > MAX_TEXT_BYTES:
        raise ValueError("file too large to display")
    raw = target.read_bytes()
    try:
        content = raw.decode("utf-8")
    except UnicodeDecodeError as exc:
        raise ValueError("file is not text") from exc
    return {
        "path": Path(relpath).as_posix(),
        "content": content,
        "size": size,
        "modified": target.stat().st_mtime,
        "sha256": hashlib.sha256(raw).hexdigest(),
    }


def write_workspace_text(
    root: Path,
    relpath: str,
    content: str,
    *,
    expected_mtime: float | None = None,
    expected_hash: str | None = None,
) -> dict[str, Any]:
    """Write text to a workspace file with optimistic concurrency checks.

    Args:
        root: Workspace root.
        relpath: Relative file path.
        content: Text content.
        expected_mtime: Legacy mtime check.
        expected_hash: SHA256 hash of content the caller last read.

    Returns:
        File metadata dict including sha256.

    Raises:
        ValueError: On invalid input/path.
        WorkspaceConflictError: If file changed (includes current hash).
    """
    if not isinstance(content, str):
        raise ValueError("content must be text")
    encoded = content.encode("utf-8")
    if len(encoded) > MAX_TEXT_BYTES:
        raise ValueError("file too large to save")
    target = safe_workspace_path(Path(root), relpath)
    if target.exists() and target.is_dir():
        raise ValueError("path is a directory")
    if target.exists() and target.is_file():
        current_hash = file_sha256(target)
        if expected_hash is not None and expected_hash != current_hash:
            raise WorkspaceConflictError(f"file changed since it was loaded; current sha256={current_hash}")
        if expected_hash is None and expected_mtime is not None:
            current = target.stat().st_mtime
            if abs(current - float(expected_mtime)) > 1e-6:
                raise WorkspaceConflictError(f"file changed since it was loaded; current sha256={current_hash}")
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_bytes(encoded)
    meta = _file_meta(target, Path(relpath).as_posix())
    meta["sha256"] = hashlib.sha256(encoded).hexdigest()
    return meta


def create_workspace_dir(root: Path, relpath: str) -> dict[str, Any]:
    target = safe_workspace_path(Path(root), relpath)
    if target.exists():
        if target.is_dir():
            return {"path": Path(relpath).as_posix(), "created": False}
        raise ValueError("path already exists")
    target.mkdir(parents=True, exist_ok=False)
    return {"path": Path(relpath).as_posix(), "created": True}


def delete_workspace_path(root: Path, relpath: str) -> dict[str, Any]:
    target = safe_workspace_path(Path(root), relpath)
    if not target.exists():
        raise FileNotFoundError("path not found")
    # Refuse deleting workspace root via empty-like edge cases (safe_workspace_path already guards)
    if target.resolve() == Path(root).resolve():
        raise ValueError("cannot delete workspace root")
    if target.is_dir():
        shutil.rmtree(target)
        kind = "dir"
    else:
        target.unlink()
        kind = "file"
    return {"path": Path(relpath).as_posix(), "deleted": True, "kind": kind}


def rename_workspace_path(root: Path, from_path: str, to_path: str) -> dict[str, Any]:
    src = safe_workspace_path(Path(root), from_path)
    dst = safe_workspace_path(Path(root), to_path)
    if not src.exists():
        raise FileNotFoundError("path not found")
    if src.resolve() == Path(root).resolve():
        raise ValueError("cannot move workspace root")
    if dst.exists():
        raise ValueError("destination already exists")
    dst.parent.mkdir(parents=True, exist_ok=True)
    src.rename(dst)
    return {
        "from": Path(from_path).as_posix(),
        "to": Path(to_path).as_posix(),
        "moved": True,
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
    """Run a git command in path.

    Args:
        path: Repository path.
        *args: Git arguments.

    Returns:
        CompletedProcess.
    """
    return subprocess.run(
        ["git", *args],
        cwd=str(path),
        capture_output=True,
        text=True,
        check=False,
        env={**os.environ, "GIT_CONFIG_NOSYSTEM": "1"},
    )


def create_workspace_snapshot(root: Path, reason: str = "teammate") -> dict[str, Any]:
    """Create a git snapshot without touching branch, index, or stash.

    Uses a temporary GIT_INDEX_FILE, `git add -A`, `write-tree`, `commit-tree`,
    `update-ref refs/nerdbot/snapshots/<id>`.

    Args:
        root: Workspace root.
        reason: Short reason.

    Returns:
        Snapshot metadata dict.
    """
    if not is_git_repo(root):
        return {"git": False}
    snap_id = f"snap_{hashlib.sha256(f'{root}:{reason}:{os.getpid()}:{threading.get_ident()}'.encode()).hexdigest()[:12]}"
    tmp_index = root / ".git" / f"tmp-index-{snap_id}"
    env = {**os.environ, "GIT_CONFIG_NOSYSTEM": "1", "GIT_INDEX_FILE": str(tmp_index)}
    try:
        add = subprocess.run(["git", "add", "-A"], cwd=str(root), capture_output=True, text=True, env=env)
        if add.returncode != 0:
            return {"git": True, "error": add.stderr.strip()}
        wt = subprocess.run(["git", "write-tree"], cwd=str(root), capture_output=True, text=True, env=env)
        if wt.returncode != 0:
            return {"git": True, "error": wt.stderr.strip()}
        tree = wt.stdout.strip()
        head = subprocess.run(["git", "rev-parse", "HEAD"], cwd=str(root), capture_output=True, text=True, env={**os.environ, "GIT_CONFIG_NOSYSTEM": "1"})
        parent = head.stdout.strip() if head.returncode == 0 else ""
        cmd = ["git", "commit-tree", tree, "-m", f"nerdbot snapshot {reason}"]
        if parent:
            cmd += ["-p", parent]
        ct = subprocess.run(cmd, cwd=str(root), capture_output=True, text=True, env={**os.environ, "GIT_CONFIG_NOSYSTEM": "1"})
        if ct.returncode != 0:
            return {"git": True, "error": ct.stderr.strip()}
        commit = ct.stdout.strip()
        ref = f"refs/nerdbot/snapshots/{snap_id}"
        ur = subprocess.run(["git", "update-ref", ref, commit], cwd=str(root), capture_output=True, text=True, env={**os.environ, "GIT_CONFIG_NOSYSTEM": "1"})
        if ur.returncode != 0:
            return {"git": True, "error": ur.stderr.strip()}
        return {"git": True, "snapshot_id": snap_id, "ref": ref, "commit": commit}
    finally:
        try:
            if tmp_index.exists():
                tmp_index.unlink()
        except Exception:
            pass


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


# Cap entries returned per directory browse (same spirit as Odysseus workspace picker).
_MAX_BROWSE_DIRS = 500

# Sensitive/system locations that should never be bound as a workspace.
_SENSITIVE_WORKSPACE_PARTS = {
    ".ssh", ".gnupg", ".aws", ".config/gcloud", ".kube", ".docker",
}


def _workspace_mount_pairs() -> list[tuple[str, str]]:
    """Odysseus-style host↔container workspace mount mapping.

    NERDBOT_WORKSPACE_MOUNTS="host=container,host2=container2"
    NERDBOT_WORKSPACE_HOST_ROOT / NERDBOT_WORKSPACE_CONTAINER_ROOT for a single pair.
    """
    pairs: list[tuple[str, str]] = []
    mapping = os.environ.get("NERDBOT_WORKSPACE_MOUNTS", "")
    for item in mapping.replace(";", ",").split(","):
        item = item.strip()
        if not item or "=" not in item:
            continue
        host, container = item.split("=", 1)
        host_path = str(Path(host.strip()).expanduser()) if host.strip() else ""
        container_path = str(Path(container.strip()).expanduser()) if container.strip() else ""
        if host_path and container_path:
            try:
                pairs.append((str(Path(host_path).resolve()), str(Path(container_path).resolve())))
            except OSError:
                pairs.append((os.path.abspath(host_path), os.path.abspath(container_path)))
    host_root = os.environ.get("NERDBOT_WORKSPACE_HOST_ROOT", "").strip()
    container_root = os.environ.get("NERDBOT_WORKSPACE_CONTAINER_ROOT", "").strip() or "/workspace"
    if host_root:
        try:
            pairs.append((str(Path(host_root).expanduser().resolve()), str(Path(container_root).expanduser().resolve())))
        except OSError:
            pass
    pairs.sort(key=lambda pair: len(pair[0]), reverse=True)
    return pairs


def backend_workspace_path(raw: str | None) -> str:
    """Translate a user-facing host workspace path into a backend-visible path."""
    text = str(raw or "").strip()
    if not text or "\n" in text or "\r" in text:
        return ""
    try:
        expanded = str(Path(text).expanduser().resolve())
    except OSError:
        expanded = os.path.abspath(os.path.expanduser(text))
    for host_root, container_root in _workspace_mount_pairs():
        try:
            common = os.path.commonpath([host_root, expanded])
        except ValueError:
            continue
        if common != host_root:
            continue
        rel = os.path.relpath(expanded, host_root)
        if rel == ".":
            return container_root
        return os.path.join(container_root, rel)
    return expanded


def _is_sensitive_workspace(path: Path) -> bool:
    lowered = {p.lower() for p in path.parts}
    return any(part.lower() in lowered for part in _SENSITIVE_WORKSPACE_PARTS)


def vet_workspace_candidate(raw: str | None) -> Path | None:
    """Validate a path for workspace binding. Returns canonical path or None.

    Rejects empty/relative paths, filesystem roots, missing/non-dir paths,
    and sensitive locations. Translates host paths through Odysseus-style
    mount mappings before validation.
    """
    text = str(raw or "").strip()
    if not text or "\n" in text or "\r" in text:
        return None
    translated = backend_workspace_path(text)
    candidate = Path(translated).expanduser()
    if not candidate.is_absolute():
        return None
    try:
        resolved = candidate.resolve()
    except OSError:
        return None
    if resolved == Path(resolved.anchor):
        return None
    if not resolved.is_dir():
        return None
    if _is_sensitive_workspace(resolved):
        return None
    return resolved


def browse_workspace_dirs(raw: str | None) -> dict[str, Any]:
    """List subdirectories for a workspace picker, like Odysseus /api/workspace/browse.

    Directories only, hidden entries omitted, symlinks not followed. Returns
    a canonical path, parent, dirs, truncation, and whether the current path
    is selectable as a workspace.
    """
    start = str(raw or "").strip()
    target = vet_workspace_candidate(start)
    if target is None:
        # Fall back to home for empty/invalid starts; keep browsing usable.
        home = Path.home().resolve()
        target = home if home.is_dir() else Path("/").resolve()
    # If vet rejected a real directory because it's sensitive/root, still allow
    # browsing by resolving it directly when it is a directory.
    if target is None:
        candidate = Path(start).expanduser()
        try:
            resolved = candidate.resolve()
        except OSError:
            resolved = Path.home().resolve()
        target = resolved if resolved.is_dir() else Path.home().resolve()

    dirs: list[dict[str, str]] = []
    try:
        with os.scandir(target) as it:
            for entry in it:
                try:
                    if entry.name.startswith("."):
                        continue
                    if entry.is_dir(follow_symlinks=False):
                        dirs.append({"name": entry.name, "path": os.path.join(str(target), entry.name)})
                except OSError:
                    continue
    except (PermissionError, OSError):
        dirs = []

    dirs.sort(key=lambda d: d["name"].lower())
    truncated = len(dirs) > _MAX_BROWSE_DIRS
    parent = target.parent
    return {
        "path": str(target),
        "parent": str(parent) if parent != target else None,
        "dirs": dirs[:_MAX_BROWSE_DIRS],
        "truncated": truncated,
        "selectable": vet_workspace_candidate(str(target)) is not None,
    }


def default_workspace_path(data_dir: str | Path) -> str | None:
    """Explicit default workspace, Odysseus-style.

    NERDBOT_WORKSPACE_DEFAULT is an opt-in default for deployments that want
    zero-setup workspace binding. It is vetted before being returned.
    """
    configured = os.environ.get("NERDBOT_WORKSPACE_DEFAULT", "").strip()
    if not configured:
        return None
    vetted = vet_workspace_candidate(configured)
    return str(vetted) if vetted else None


def git_log(root: Path, limit: int = 20) -> list[dict[str, str]]:
    if not is_git_repo(Path(root)):
        return []
    limit = max(1, min(int(limit or 20), 100))
    fmt = "%H%x1f%h%x1f%an%x1f%ad%x1f%s"
    result = _git(Path(root), "log", f"-{limit}", "--date=iso-strict", f"--pretty=format:{fmt}")
    if result.returncode != 0:
        return []
    commits = []
    for line in result.stdout.splitlines():
        parts = line.split("\x1f")
        if len(parts) != 5:
            continue
        commits.append({"hash": parts[0], "short": parts[1], "author": parts[2], "date": parts[3], "subject": parts[4]})
    return commits


def git_commit_all(root: Path, message: str) -> dict[str, Any]:
    root = Path(root)
    if not is_git_repo(root):
        raise ValueError("workspace is not a git repository")
    msg = (message or "").strip()
    if not msg:
        raise ValueError("commit message is required")
    add = _git(root, "add", "-A")
    if add.returncode != 0:
        raise RuntimeError((add.stderr or add.stdout or "git add failed").strip())
    staged = _git(root, "diff", "--cached", "--name-only")
    if staged.returncode == 0 and not staged.stdout.strip():
        head = _git(root, "rev-parse", "HEAD")
        return {"committed": False, "message": "nothing to commit", "branch": current_branch(root), "head": head.stdout.strip() if head.returncode == 0 else ""}
    commit = _git(root, "commit", "-m", msg)
    if commit.returncode != 0:
        raise RuntimeError((commit.stderr or commit.stdout or "git commit failed").strip())
    head = _git(root, "rev-parse", "HEAD")
    return {"committed": True, "branch": current_branch(root), "head": head.stdout.strip() if head.returncode == 0 else "", "output": (commit.stdout or "").strip()}


def git_discard_uncommitted(root: Path) -> dict[str, Any]:
    root = Path(root)
    if not is_git_repo(root):
        raise ValueError("workspace is not a git repository")
    reset = _git(root, "reset", "--hard", "HEAD")
    if reset.returncode != 0:
        raise RuntimeError((reset.stderr or reset.stdout or "git reset failed").strip())
    clean = _git(root, "clean", "-fd")
    if clean.returncode != 0:
        raise RuntimeError((clean.stderr or clean.stdout or "git clean failed").strip())
    head = _git(root, "rev-parse", "HEAD")
    return {"rolled_back": True, "branch": current_branch(root), "head": head.stdout.strip() if head.returncode == 0 else ""}


# ---------------------------------------------------------------------------
# Workspace gateway — single entry point for all workspace access
# ---------------------------------------------------------------------------

WORKSPACE_ACTIONS = {
    "list", "read", "write", "mkdir", "delete", "rename", "run",
    "git_status", "git_log", "git_diff", "git_commit", "git_rollback", "revert",
    "checkout_create", "checkout_delete",
}


def _resolve_workspace_root(project: Any, data_dir: str | Path) -> Path:
    """Resolve and ensure the project workspace root.

    Args:
        project: Project model/object with config and id.
        data_dir: Nerdbot data directory.

    Returns:
        Canonical workspace root path.

    Raises:
        ValueError: If the workspace cannot be resolved/created.
    """
    return ensure_project_workspace(project, data_dir, initialize_git=False)


def _confine_workspace_path(root: Path, path: str) -> Path:
    """Confine a user/tool-supplied path to the workspace root.

    Args:
        root: Canonical workspace root.
        path: Relative path supplied by caller.

    Returns:
        Resolved absolute path inside root.

    Raises:
        ValueError: If path escapes or is invalid.
    """
    return safe_workspace_path(root, path)


def _required_workspace_permission(action: str) -> str | None:
    """Map a gateway action to the required workspace permission.

    Args:
        action: Gateway action name.

    Returns:
        Permission name, or None for actions that don't require a workspace permission.
    """
    if action in {"list", "read", "git_status", "git_log", "git_diff"}:
        return "workspace.read"
    if action in {"write", "mkdir", "delete", "rename", "git_commit", "git_rollback", "revert", "checkout_create", "checkout_delete"}:
        return "workspace.write"
    if action == "run":
        return "workspace.exec"
    return None


def _check_workspace_permission(actor: WorkspaceActor, action: str) -> tuple[bool, str]:
    """Check whether the actor may perform the action.

    Args:
        actor: Acting user or teammate.
        action: Gateway action name.

    Returns:
        (allowed, reason). Owners are allowed; teammates require permission.
    """
    if actor.kind == "user":
        return True, "owner"
    mate = actor.teammate
    if mate is None:
        return False, "teammate actor missing"
    if bool(getattr(mate, "paused", False)):
        return False, "teammate is paused"
    perm = _required_workspace_permission(action)
    if perm is None:
        return False, f"unknown action {action}"
    perms = set(getattr(mate, "permissions", []) or [])
    if perm not in perms:
        return False, f"missing permission {perm}"
    return True, "allowed"


def _needs_approval(actor: WorkspaceActor, action: str, *, untrusted: bool = False, approved: bool = False) -> bool:
    """Determine whether the action requires approval.

    Exec always requires approval regardless of autonomy level until sandbox exists.
    Write/mutating actions require approval at ask_first or when untrusted content
    was seen in the same turn. An explicitly approved checkpoint may proceed.

    Args:
        actor: Acting user or teammate.
        action: Gateway action name.
        untrusted: Whether untrusted content was involved in the same turn.
        approved: True when resuming an owner-approved checkpoint.

    Returns:
        True if approval is required.
    """
    if actor.kind == "user":
        return False
    if approved:
        # Owner explicitly approved this exact action; allow it to proceed once.
        return False
    if action == "run":
        # Exec always needs approval, regardless of autonomy level, until sandbox exists.
        return True
    if untrusted and action in {"write", "mkdir", "delete", "rename", "git_commit", "git_rollback", "revert", "checkout_create", "checkout_delete"}:
        return True
    level = getattr(actor.teammate, "autonomy_level", "ask_first") if actor.teammate else "ask_first"
    if action in {"write", "mkdir", "delete", "rename", "git_commit", "git_rollback", "revert", "checkout_create", "checkout_delete"}:
        return level == "ask_first"
    return False


def _snapshot_before_write(root: Path, action: str) -> dict[str, Any]:
    """Create a lightweight git snapshot before mutating writes.

    Args:
        root: Workspace root.
        action: Gateway action name.

    Returns:
        Snapshot metadata dict.
    """
    if action not in {"write", "mkdir", "delete", "rename", "run", "git_commit", "git_rollback", "revert", "checkout_create", "checkout_delete"}:
        return {}
    if not is_git_repo(root):
        return {"git": False}
    head = _git(root, "rev-parse", "HEAD")
    status = _git(root, "status", "--porcelain")
    return {
        "git": True,
        "head": head.stdout.strip() if head.returncode == 0 else "",
        "dirty": bool(status.stdout.strip()),
    }


def _emit_workspace_audit(
    conn: Any,
    *,
    actor: WorkspaceActor,
    action: str,
    path: str,
    ok: bool,
    denied: bool,
    reason: str,
    args_summary: str = "",
) -> str:
    """Write a workspace audit row to events (or audit table if available).

    Args:
        conn: SQLite connection.
        actor: Acting user/teammate.
        action: Action name.
        path: Relative/target path.
        ok: Whether action succeeded.
        denied: Whether action was denied.
        reason: Human-readable reason.
        args_summary: Bounded args summary.

    Returns:
        Event/audit id.
    """
    try:
        from . import store as _store
        aid = _store.record_workspace_audit(
            conn,
            project_id=actor.project_id,
            actor_kind=actor.kind,
            actor_id=actor.id,
            action=action,
            path=path,
            ok=ok,
            denied=denied,
            reason=reason,
            args_summary=args_summary,
        )
        with suppress(Exception):
            _store.record_event(conn, actor.project_id, "workspace", actor.id or "workspace", f"workspace.{action}")
        return aid
    except Exception:
        return ""


def _execute_workspace_action(root: Path, action: str, relpath: str, args: dict[str, Any]) -> WorkspaceResult:
    """Execute a confined workspace action.

    Args:
        root: Canonical workspace root.
        action: Action name.
        relpath: Relative path (may be empty for some actions).
        args: Action arguments.

    Returns:
        WorkspaceResult.

    Raises:
        ValueError, FileNotFoundError, RuntimeError: on action failures.
    """
    if action == "list":
        target = _confine_workspace_path(root, relpath or ".") if relpath else root
        listing = list_workspace_files(target)
        return WorkspaceResult(ok=True, action=action, path=relpath, output=f"listed {len(listing.get('files',[]))} files", data=listing)
    if action == "read":
        data = read_workspace_text(root, relpath)
        output = f"sha256: {data.get('sha256','')}\npath: {data.get('path','')}\n\n{data.get('content','')}"
        return WorkspaceResult(ok=True, action=action, path=relpath, output=output, data=data)
    if action == "write":
        data = write_workspace_text(
            root,
            relpath,
            str(args.get("content", "")),
            expected_mtime=args.get("expected_mtime"),
            expected_hash=args.get("expected_hash"),
        )
        return WorkspaceResult(ok=True, action=action, path=relpath, output=f"wrote {relpath}", data=data)
    if action == "mkdir":
        data = create_workspace_dir(root, relpath)
        return WorkspaceResult(ok=True, action=action, path=relpath, output=f"mkdir {relpath}", data=data)
    if action == "delete":
        data = delete_workspace_path(root, relpath)
        return WorkspaceResult(ok=True, action=action, path=relpath, output=f"deleted {relpath}", data=data)
    if action == "rename":
        data = rename_workspace_path(root, relpath, str(args.get("to") or args.get("new_path") or ""))
        return WorkspaceResult(ok=True, action=action, path=relpath, output=f"renamed {relpath}", data=data)
    if action == "run":
        from . import runtime as _runtime
        command = str(args.get("command", "")).strip()
        if not command:
            raise ValueError("command is required")
        timeout_s = float(args.get("timeout_s", 60.0))
        timeout_s = max(1.0, min(timeout_s, 600.0))
        result = _runtime.LocalRuntimeAdapter().start_run(command, root, timeout_s=timeout_s)
        return WorkspaceResult(ok=result.exit_code == 0, action=action, path=relpath, output=_runtime.scrub_secrets(result.output or ""), data={"exit_code": result.exit_code, "stdout": _runtime.scrub_secrets(result.stdout or ""), "stderr": _runtime.scrub_secrets(result.stderr or "")})
    if action == "git_status":
        return WorkspaceResult(ok=True, action=action, path=relpath, output="git status", data={"changes": git_status_entries(root), "branch": current_branch(root), "git": is_git_repo(root)})
    if action == "git_log":
        commits = git_log(root, limit=int(args.get("limit", 20)))
        return WorkspaceResult(ok=True, action=action, path=relpath, output=f"{len(commits)} commits", data={"commits": commits})
    if action == "git_diff":
        return WorkspaceResult(ok=True, action=action, path=relpath, output=workspace_diff(root), data={"diff": workspace_diff(root)})
    if action == "git_commit":
        data = git_commit_all(root, str(args.get("message", "")))
        return WorkspaceResult(ok=bool(data.get("committed", False)), action=action, path=relpath, output=str(data.get("message") or "committed"), data=data)
    if action == "git_rollback":
        data = git_discard_uncommitted(root)
        return WorkspaceResult(ok=True, action=action, path=relpath, output="rolled back", data=data)
    if action == "revert":
        import re as _re

        ref = str(args.get("snapshot_ref") or args.get("commit") or args.get("ref") or "")
        if not _re.fullmatch(r"refs/nerdbot/snapshots/[A-Za-z0-9._-]+", ref):
            raise ValueError("invalid snapshot ref")
        # safe_workspace_path rejects absolute paths and any ../ traversal.
        target = safe_workspace_path(root, relpath)
        rel = target.relative_to(root).as_posix()
        force = bool(args.get("force", False))
        expected_hash = args.get("expected_hash")
        current_hash = file_sha256(target) if target.is_file() else ""
        if expected_hash and str(expected_hash) != current_hash and not force:
            raise WorkspaceConflictError(f"file changed since snapshot; current sha256={current_hash}")
        # Read snapshot bytes with list args (never a shell); -- terminates options.
        show = subprocess.run(
            ["git", "show", f"{ref}:{rel}", "--"],
            cwd=str(root),
            capture_output=True,
        )
        if show.returncode != 0:
            if not force and current_hash:
                raise WorkspaceConflictError(f"file changed since snapshot; current sha256={current_hash}")
            if target.exists() and target.is_file():
                target.unlink()
                return WorkspaceResult(
                    ok=True,
                    action=action,
                    path=rel,
                    output=f"reverted {rel} (removed)",
                    data={"path": rel, "removed": True, "snapshot_ref": ref},
                )
            raise ValueError(show.stderr.decode(errors="replace").strip() or "cannot restore snapshot")
        snap_bytes = show.stdout
        snap_hash = hashlib.sha256(snap_bytes).hexdigest()
        if current_hash != snap_hash and not force:
            raise WorkspaceConflictError(f"file changed since snapshot; current sha256={current_hash}")
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(snap_bytes)
        return WorkspaceResult(
            ok=True,
            action=action,
            path=rel,
            output=f"reverted {rel}",
            data={"path": rel, "sha256": file_sha256(target), "snapshot_ref": ref},
        )
    if action == "checkout_create":
        from . import orchestrator as _orchestrator
        conn = args.get("conn")
        task_id = str(args.get("task_id") or "")
        path, branch = _orchestrator.ensure_task_workspace(
            conn,
            task_id,
            data_dir=str(args.get("data_dir") or ".nerdbot-data"),
            seed_from=args.get("seed_from"),
            base_branch=args.get("base_branch"),
        )
        return WorkspaceResult(ok=True, action=action, path=relpath, output=f"checkout {task_id}", data={"path": str(path), "branch": branch})
    if action == "checkout_delete":
        task_id = str(args.get("task_id") or "")
        removed = cleanup_workspace(str(args.get("data_dir") or ".nerdbot-data"), task_id)
        return WorkspaceResult(ok=True, action=action, path=relpath, output=f"cleaned {task_id}", data={"removed": bool(removed)})
    raise ValueError(f"unknown workspace action: {action}")


def do(actor: WorkspaceActor, action: str, path: str = "", **args: Any) -> WorkspaceResult:
    """Single gateway for all workspace access.

    Steps: resolve workspace from project workspace_root (never global), confine path,
    check permission, check approval policy, snapshot if needed, execute, emit audit, return.

    Args:
        actor: User or teammate actor.
        action: One of list/read/write/mkdir/delete/rename/run/git_*.
        path: Relative path within workspace.
        **args: action args; may include conn, data_dir, project, untrusted,
            and workspace_root for a task checkout inside the data directory.

    Returns:
        WorkspaceResult.
    """
    conn = args.get("conn")
    data_dir = args.get("data_dir") or os.environ.get("NERDBOT_DATA_DIR", ".nerdbot-data")
    project = args.get("project")
    untrusted = bool(args.get("untrusted", False))
    approved = bool(args.get("approved", False))
    action = str(action or "").strip()
    relpath = str(path or "").strip().lstrip("/")

    if action not in WORKSPACE_ACTIONS:
        return WorkspaceResult(ok=False, action=action, path=relpath, error=f"unknown action {action}", denied=True)

    try:
        if project is None and conn is not None and actor.project_id:
            from . import store as _store
            project = _store.get_project(conn, actor.project_id)
        if project is None:
            return WorkspaceResult(ok=False, action=action, path=relpath, error="project not found", denied=True)

        # Optional override for task checkouts: still confined to the data dir
        # and audited through this same gateway.
        root_override = args.get("workspace_root")
        if root_override is not None:
            root = Path(root_override).resolve()
            data_root = Path(data_dir).resolve()
            if not root.is_dir() or (root != data_root and data_root not in root.parents):
                raise ValueError("workspace_root is outside the data directory")
        else:
            root = _resolve_workspace_root(project, data_dir)
        # confine (for path-based actions; some git actions don't need relpath)
        if action not in {"git_status", "git_log", "git_diff", "git_commit", "git_rollback", "checkout_create", "checkout_delete"} and relpath:
            _confine_workspace_path(root, relpath)

        allowed, reason = _check_workspace_permission(actor, action)
        if not allowed:
            audit_id = _emit_workspace_audit(conn, actor=actor, action=action, path=relpath, ok=False, denied=True, reason=reason, args_summary=str({k:v for k,v in args.items() if k not in {'conn','project'}})[:500]) if conn is not None else ""
            return WorkspaceResult(ok=False, action=action, path=relpath, error=reason, denied=True, audit_id=audit_id)

        if _needs_approval(actor, action, untrusted=untrusted, approved=approved):
            approval_id = ""
            if conn is not None:
                try:
                    from . import store as _store
                    from .gates import action_digest
                    payload = {"actor_kind": actor.kind, "actor_id": actor.id, "project_id": actor.project_id, "action": action, "path": relpath, "args": {k: v for k, v in args.items() if k not in {"conn", "project", "data_dir"}}}
                    apr = _store.request_approval(
                        conn,
                        action=f"workspace.{action}",
                        requester=actor.id,
                        project_id=actor.project_id,
                        digest=action_digest(f"workspace.{action}", payload),
                        task_id=args.get("task_id"),
                    )
                    _store.set_approval_checkpoint(
                        conn,
                        apr.id,
                        teammate_id=actor.id if actor.kind == "teammate" else "",
                        tool_name=f"workspace.{action}",
                        tool_arguments=json.dumps(payload, separators=(",", ":"), sort_keys=True),
                        run_id=str(args.get("run_id") or ""),
                        task_id=str(args.get("task_id") or ""),
                    )
                    approval_id = apr.id
                except Exception:
                    approval_id = ""
            audit_id = _emit_workspace_audit(conn, actor=actor, action=action, path=relpath, ok=False, denied=True, reason="approval required", args_summary=str({k:v for k,v in args.items() if k not in {'conn','project'}})[:500]) if conn is not None else ""
            data_out: dict[str, Any] = {"approval_required": True}
            if approval_id:
                data_out["approval_id"] = approval_id
            return WorkspaceResult(ok=False, action=action, path=relpath, error="approval required", denied=True, audit_id=audit_id, data=data_out)

        snap = {}
        if actor.kind == "teammate" and action in {"write", "delete", "rename"}:
            snap = create_workspace_snapshot(root, reason=f"{actor.id}:{action}:{relpath}")
            # Non-git: copy pre-write file under .nerdbot-data
            if not snap.get("git") and action in {"write", "delete", "rename"} and relpath:
                try:
                    target = _confine_workspace_path(root, relpath)
                    if target.exists() and target.is_file():
                        backup_dir = Path(args.get("data_dir") or ".nerdbot-data") / "workspace-backups" / (actor.project_id or "unknown")
                        backup_dir.mkdir(parents=True, exist_ok=True)
                        backup = backup_dir / f"{hashlib.sha256(relpath.encode()).hexdigest()[:16]}.bak"
                        backup.write_bytes(target.read_bytes())
                        snap["backup"] = str(backup)
                        snap["backup_hash"] = file_sha256(target)
                except Exception:
                    pass
        else:
            snap = _snapshot_before_write(root, action)
        with bound_workspace(root):
            result = _execute_workspace_action(root, action, relpath, args)
        if snap:
            result.data["snapshot"] = snap
        audit_args = {k: v for k, v in args.items() if k not in {"conn", "project"}}
        if snap:
            audit_args["snapshot"] = snap
        try:
            summary = json.dumps(audit_args)[:500]
        except Exception:
            summary = str(audit_args)[:500]
        result.audit_id = _emit_workspace_audit(conn, actor=actor, action=action, path=relpath, ok=result.ok, denied=False, reason="ok" if result.ok else result.error, args_summary=summary) if conn is not None else ""
        # Autonomy reporting: act_and_report posts summary to thread/task; act_silently logs only.
        if result.ok and actor.kind == "teammate" and conn is not None:
            level = getattr(actor.teammate, "autonomy_level", "ask_first")
            if level == "act_and_report" and action in {"write", "mkdir", "delete", "rename", "git_commit", "git_rollback", "revert"}:
                msg = f"[workspace] {action} {relpath or ''} by {getattr(actor.teammate,'name',actor.id)}: {result.output[:200]}"
                try:
                    from . import store as _store
                    tid = str(args.get("thread_id") or "")
                    if tid:
                        _store.append_message(conn, tid, "assistant", msg[:2000], parts=[{"type":"workspace_action","action":action,"path":relpath}])
                except Exception:
                    pass
        return result
    except Exception as exc:
        audit_id = _emit_workspace_audit(conn, actor=actor, action=action, path=relpath, ok=False, denied=False, reason=str(exc), args_summary=str({k:v for k,v in args.items() if k not in {'conn','project'}})[:500]) if conn is not None else ""
        return WorkspaceResult(ok=False, action=action, path=relpath, error=str(exc), denied=False, audit_id=audit_id)
