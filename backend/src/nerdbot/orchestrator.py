"""Orchestrator: task lifecycle, dependency resolution, retry semantics.

The orchestrator decides which runs start and in what order. It never
executes code itself — execution is delegated to a RuntimeAdapter inside
the task's isolated workspace. Retry creates a new Run for the same Task.
Phase 3 adds the coding workflow: issue-linked tasks, branched workspaces,
test-log artifacts on every outcome, reviewer passes, patch capture,
candidate PR packages, and task roll-ups.
"""

from __future__ import annotations

import hashlib
import json
import sqlite3
import time
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from . import store, workspace
from .models import (
    Approval,
    Issue,
    PRPackage,
    Review,
    ReviewVerdict,
    Run,
    RunStatus,
    Schedule,
    Task,
    TaskStatus,
    TeammateStatus,
    VerificationStatus,
)
from .runtime import (
    BlockedError,
    ExecutionError,
    LocalRuntimeAdapter,
    RunResult,
    RuntimeAdapter,
    frame_untrusted,
)


def dependencies_satisfied(conn: sqlite3.Connection, task: Task) -> bool:
    for dep_id in task.dependencies:
        dep = store.get_task(conn, dep_id)
        if dep is None or dep.status != TaskStatus.DONE:
            return False
    return True


def schedule_run(
    conn: sqlite3.Connection,
    task_id: str,
    adapter: RuntimeAdapter | None = None,
    data_dir: str = ".",
    timeout_s: float = 60.0,
) -> tuple[Run, RunResult | None, str | None]:
    """Schedule and synchronously execute one run for a task.

    Returns ``(run, result, artifact_id)``. Policy blocks and dependency
    failures are recorded on the run/task without raising.
    """
    task = store.get_task(conn, task_id)
    if task is None:
        raise KeyError(f"unknown task {task_id}")
    if task.owner_teammate_id is not None:
        owner = store.get_teammate(conn, task.owner_teammate_id)
        if owner is not None and owner.status != TeammateStatus.ACTIVE:
            run = store.create_run(
                conn, task_id, runtime=(adapter or LocalRuntimeAdapter()).name, session=task.id
            )
            store.set_task_status(conn, task_id, TaskStatus.BLOCKED)
            store.finish_run(
                conn, run.id, RunStatus.BLOCKED, None, f"owner teammate is {owner.status.value}"
            )
            run.status = RunStatus.BLOCKED
            return run, None, None
    if adapter is None:
        owner_provider_id = None
        if task.owner_teammate_id is not None:
            owner = store.get_teammate(conn, task.owner_teammate_id)
            owner_provider_id = owner.provider_id if owner else None
        from . import providers as providers_mod

        provider, adapter, block_reason = providers_mod.resolve_run_provider(
            conn, owner_provider_id, task.project_id
        )
        provider_id = provider.id if provider else None
        if block_reason is not None:
            run = store.create_run(
                conn, task_id, runtime=adapter.name, session=task.id, provider_id=provider_id
            )
            store.set_task_status(conn, task_id, TaskStatus.BLOCKED)
            store.finish_run(conn, run.id, RunStatus.BLOCKED, None, block_reason)
            run.status = RunStatus.BLOCKED
            run.output_excerpt = block_reason
            return run, None, None
    else:
        provider_id = None
    active = adapter
    run = store.create_run(
        conn, task_id, runtime=active.name, session=task.id, provider_id=provider_id
    )
    store.record_event(conn, task.project_id, "run", run.id, f"run.provider.{adapter.name}")
    # Persist the queued -> running transition BEFORE executing so a crash
    # leaves a recoverable non-terminal state instead of silent ambiguity.
    store.mark_run_running(conn, run.id)
    run.status = RunStatus.RUNNING
    store.set_task_status(conn, task_id, TaskStatus.RUNNING)

    if not dependencies_satisfied(conn, task):
        store.finish_run(conn, run.id, RunStatus.BLOCKED, None, "dependencies not satisfied")
        run.status = RunStatus.BLOCKED
        run.output_excerpt = "dependencies not satisfied"
        store.set_task_status(conn, task_id, TaskStatus.BLOCKED)
        return run, None, None

    ws = workspace.create_isolated_workspace(data_dir, task_id)
    workspace.ensure_branch(ws, workspace.branch_name_for_task(task_id))
    if not task.workspace_path:
        store.set_task_workspace(conn, task_id, workspace.branch_name_for_task(task_id), str(ws))
    started = time.monotonic()
    try:
        result = active.start_run(task.command, ws, timeout_s=timeout_s)
    except BlockedError as exc:
        store.finish_run(conn, run.id, RunStatus.BLOCKED, None, f"blocked: {exc.reason}")
        run.status = RunStatus.BLOCKED
        run.output_excerpt = f"blocked: {exc.reason}"
        store.set_task_status(conn, task_id, TaskStatus.BLOCKED)
        return run, None, None
    except ExecutionError as exc:
        failed = _record_test_log(
            conn,
            task_id,
            run,
            ws,
            data_dir,
            exit_code=None,
            stdout="",
            stderr=str(exc),
            duration_s=time.monotonic() - started,
            passed=False,
        )
        store.finish_run(conn, run.id, RunStatus.FAILED, None, str(exc))
        run.status = RunStatus.FAILED
        run.output_excerpt = str(exc)
        store.set_task_status(conn, task_id, TaskStatus.FAILED)
        return run, None, failed
    except Exception as exc:  # explicit failure, never silent success
        message = f"unexpected runtime error: {type(exc).__name__}: {exc}"
        store.finish_run(conn, run.id, RunStatus.FAILED, None, message)
        run.status = RunStatus.FAILED
        run.output_excerpt = message
        store.set_task_status(conn, task_id, TaskStatus.FAILED)
        return run, None, None

    duration_s = time.monotonic() - started
    ok = result.exit_code == 0
    store.finish_run(
        conn,
        run.id,
        RunStatus.SUCCEEDED if ok else RunStatus.FAILED,
        result.exit_code,
        frame_untrusted(result.output),
        stdout=result.stdout,
        stderr=result.stderr,
        duration_s=duration_s,
    )
    run.status = RunStatus.SUCCEEDED if ok else RunStatus.FAILED
    run.exit_code = result.exit_code
    run.output_excerpt = frame_untrusted(result.output)[:4000]
    run.stdout = result.stdout
    run.stderr = result.stderr
    run.duration_s = duration_s
    store.set_task_status(conn, task_id, TaskStatus.DONE if ok else TaskStatus.FAILED)

    artifact_id = _record_test_log(
        conn,
        task_id,
        run,
        ws,
        data_dir,
        exit_code=result.exit_code,
        stdout=result.stdout,
        stderr=result.stderr,
        duration_s=duration_s,
        passed=ok,
    )
    return run, result, artifact_id


def _record_test_log(
    conn: sqlite3.Connection,
    task_id: str,
    run: Run,
    ws: Path,
    data_dir: str,
    exit_code: int | None,
    stdout: str,
    stderr: str,
    duration_s: float,
    passed: bool,
) -> str:
    """Persist one test-log artifact per executed run, pass or fail."""
    artifact = store.create_artifact(
        conn,
        task_id,
        run.id,
        "test-log",
        str(ws),
        VerificationStatus.PASSED if passed else VerificationStatus.FAILED,
        summary=f"exit={exit_code} duration_s={duration_s:.2f}",
    )
    return artifact.id


def retry_task(
    conn: sqlite3.Connection,
    task_id: str,
    adapter: RuntimeAdapter | None = None,
    data_dir: str = ".",
    timeout_s: float = 60.0,
) -> tuple[Run, RunResult | None, str | None]:
    """Retry a task by creating a NEW run for the SAME task (no duplication).

    Only tasks in a terminal state (done/failed/blocked) may be retried.
    """
    task = store.get_task(conn, task_id)
    if task is None:
        raise KeyError(f"unknown task {task_id}")
    if task.status not in store.TERMINAL_TASK_STATUSES:
        raise ValueError(
            f"task {task_id} is {task.status.value}; only terminal tasks may be retried"
        )
    before = len(store.list_runs_for_task(conn, task_id))
    store.set_task_status(conn, task_id, TaskStatus.PENDING)
    out = schedule_run(conn, task_id, adapter=adapter, data_dir=data_dir, timeout_s=timeout_s)
    after = len(store.list_runs_for_task(conn, task_id))
    assert after == before + 1, "retry must add exactly one run"
    return out


def recover_incomplete_runs(conn: sqlite3.Connection) -> list[str]:
    """Recover runs left non-terminal by a previous process ending.

    - ``queued`` runs are left untouched: they never started and stay startable.
    - ``running`` runs can never complete after their process died: they are
      moved to ``stopped`` with an explicit recovery note. No new runs are
      created, so completed runs are never duplicated.
    - Owning tasks left in ``running`` with no active run return to
      ``pending`` so they can be explicitly rescheduled.

    Returns the ids of runs moved to ``stopped``.
    """
    rows = conn.execute(
        "SELECT * FROM runs WHERE status = ?", (RunStatus.RUNNING.value,)
    ).fetchall()
    recovered: list[str] = []
    for row in rows:
        run_id = row["id"]
        note = (row["output_excerpt"] or "") + "\n[recovered: process ended before completion]"
        store.finish_run(conn, run_id, RunStatus.STOPPED, row["exit_code"], note.strip())
        recovered.append(run_id)
        task = store.get_task(conn, row["task_id"])
        if task is not None and task.status == TaskStatus.RUNNING:
            active = [
                r
                for r in store.list_runs_for_task(conn, task.id)
                if r.status not in store.TERMINAL_RUN_STATUSES
            ]
            if not active:
                store.set_task_status(conn, task.id, TaskStatus.PENDING)
    return recovered


# -- Phase 3: coding workflow --------------------------------------------------


def artifacts_dir(data_dir: str) -> Path:
    path = Path(data_dir) / "artifacts"
    path.mkdir(parents=True, exist_ok=True)
    return path


def _artifact_file(data_dir: str, artifact_id: str, ext: str, content: str) -> str:
    location = artifacts_dir(data_dir) / f"{artifact_id}.{ext}"
    location.write_text(content, encoding="utf-8")
    return str(location)


def ensure_task_workspace(
    conn: sqlite3.Connection,
    task_id: str,
    data_dir: str = ".",
    seed_from: str | None = None,
    base_branch: str | None = None,
) -> tuple[str, str]:
    """Create the isolated workspace + purposeful branch for a task.

    Seeds fixture/source files, records a baseline commit, and persists the
    branch/path mapping on the task so it survives restarts. Idempotent:
    re-running reuses the workspace and branch without losing work.
    """
    task = store.get_task(conn, task_id)
    if task is None:
        raise KeyError(f"unknown task {task_id}")
    ws = workspace.create_isolated_workspace(data_dir, task_id)
    if seed_from is not None:
        workspace.seed_workspace(ws, seed_from)
    branch = workspace.branch_name_for_task(task_id)
    workspace.ensure_branch(ws, branch)
    workspace.baseline_commit(ws)
    if base_branch is not None and task.issue_id is None:
        pass  # base_branch is advisory for the PR payload; no remote to track
    stored = store.set_task_workspace(conn, task_id, branch, str(ws))
    return str(ws), stored.branch


def submit_review(
    conn: sqlite3.Connection,
    task_id: str,
    reviewer_teammate_id: str,
    verdict: ReviewVerdict,
    notes: str = "",
    risks: list[str] | None = None,
    run_id: str = "",
    data_dir: str = ".",
) -> tuple[Review, str]:
    """Record a reviewer pass as its own review row + review artifact.

    Review artifacts are separate rows/files; implementation (test-log,
    patch) artifacts are never modified here.
    """
    review = store.create_review(
        conn, task_id, reviewer_teammate_id, verdict, notes=notes, risks=risks, run_id=run_id
    )
    content = (
        f"# Review {review.id}\n\nverdict: {verdict.value}\nreviewer: {reviewer_teammate_id}\n"
        f"task: {task_id}\nrun: {run_id or '(none)'}\n\n## Notes\n{notes or '(none)'}\n\n"
        f"## Risks\n" + "\n".join(f"- {risk}" for risk in (risks or [])) + "\n"
    )
    location = _artifact_file(data_dir, f"{review.id}-review", "md", content)
    verification = {
        ReviewVerdict.ACCEPTED: VerificationStatus.PASSED,
        ReviewVerdict.NEEDS_WORK: VerificationStatus.UNVERIFIED,
        ReviewVerdict.REJECTED: VerificationStatus.FAILED,
    }[verdict]
    artifact = store.create_artifact(
        conn,
        task_id,
        run_id,
        "review",
        location,
        verification,
        summary=f"verdict={verdict.value}",
    )
    return review, artifact.id


def capture_patch(
    conn: sqlite3.Connection, task_id: str, run_id: str, data_dir: str = "."
) -> tuple[str, str]:
    """Diff the task workspace against its baseline; persist a patch artifact."""
    task = store.get_task(conn, task_id)
    if task is None:
        raise KeyError(f"unknown task {task_id}")
    ws = (
        Path(task.workspace_path)
        if task.workspace_path
        else workspace.workspace_path_for_task(data_dir, task_id)
    )
    if not ws.exists():
        raise ValueError(f"workspace for task {task_id} does not exist")
    diff = workspace.workspace_diff(ws)
    location = _artifact_file(data_dir, f"patch-{run_id}", "diff", diff or "(no changes)\n")
    files_changed = sum(1 for line in diff.splitlines() if line.startswith("diff --git "))
    artifact = store.create_artifact(
        conn,
        task_id,
        run_id,
        "patch",
        location,
        VerificationStatus.UNVERIFIED,
        summary=f"files_changed={files_changed} chars={len(diff)}",
    )
    return artifact.id, diff


def package_digest(canonical: dict[str, Any]) -> str:
    return hashlib.sha256(
        json.dumps(canonical, sort_keys=True, separators=(",", ":")).encode("utf-8")
    ).hexdigest()


def latest_review(conn: sqlite3.Connection, task_id: str) -> Review | None:
    reviews = store.list_reviews_for_task(conn, task_id)
    return reviews[-1] if reviews else None


def latest_pr_package(conn: sqlite3.Connection, task_id: str) -> PRPackage | None:
    packages = store.list_pr_packages_for_task(conn, task_id)
    return packages[-1] if packages else None


def latest_run(conn: sqlite3.Connection, task_id: str) -> Run | None:
    runs = store.list_runs_for_task(conn, task_id)
    return runs[-1] if runs else None


def test_evidence_for_task(conn: sqlite3.Connection, task_id: str) -> list[dict[str, Any]]:
    evidence: list[dict[str, Any]] = []
    for artifact in store.list_artifacts_for_task(conn, task_id):
        if artifact.type != "test-log":
            continue
        evidence.append(
            {
                "artifact_id": artifact.id,
                "run_id": artifact.run_id,
                "status": artifact.verification_status.value,
                "summary": artifact.summary,
            }
        )
    return evidence


def generate_pr_package(
    conn: sqlite3.Connection,
    task_id: str,
    title: str,
    body: str = "",
    labels: list[str] | None = None,
    data_dir: str = ".",
) -> PRPackage:
    """Assemble a validated, reviewable PR candidate. Never pushes anywhere."""
    task = store.get_task(conn, task_id)
    if task is None:
        raise KeyError(f"unknown task {task_id}")
    runs = store.list_runs_for_task(conn, task_id)
    run_id = runs[-1].id if runs else ""
    patch_artifact_id = ""
    patch_summary = "no patch captured"
    for artifact in store.list_artifacts_for_task(conn, task_id):
        if artifact.type == "patch":
            patch_artifact_id = artifact.id
            patch_summary = artifact.summary
    test_evidence = test_evidence_for_task(conn, task_id)
    review = latest_review(conn, task_id)
    review_evidence: dict[str, Any] = {}
    if review is not None:
        review_evidence = {
            "review_id": review.id,
            "verdict": review.verdict.value,
            "reviewer": review.reviewer_teammate_id,
            "risks": review.risks,
        }
    base_branch = "main"
    if task.issue_id is not None:
        issue = store.get_issue(conn, task.issue_id)
        if issue is not None and issue.base_branch:
            base_branch = issue.base_branch
    canonical = {
        "task_id": task_id,
        "title": title,
        "body": body,
        "base_branch": base_branch,
        "head_branch": task.branch,
        "labels": labels or [],
        "patch_artifact_id": patch_artifact_id,
        "patch_summary": patch_summary,
        "test_evidence": test_evidence,
        "review_evidence": review_evidence,
    }
    digest = package_digest(canonical)
    package = store.create_pr_package(
        conn,
        task_id,
        title,
        body=body,
        base_branch=base_branch,
        head_branch=task.branch,
        labels=labels,
        patch_summary=patch_summary,
        test_evidence=test_evidence,
        review_evidence=review_evidence,
        patch_artifact_id=patch_artifact_id,
        digest=digest,
    )
    merge_ready = (
        bool(patch_artifact_id)
        and any(e["status"] == VerificationStatus.PASSED.value for e in test_evidence)
        and review_evidence.get("verdict") == ReviewVerdict.ACCEPTED.value
    )
    location = _artifact_file(
        data_dir,
        package.id,
        "json",
        json.dumps({**canonical, "id": package.id, "digest": digest}, indent=2, sort_keys=True),
    )
    store.create_artifact(
        conn,
        task_id,
        run_id,
        "pr-package",
        location,
        VerificationStatus.PASSED if merge_ready else VerificationStatus.UNVERIFIED,
        summary=f"merge_ready={merge_ready} digest={digest[:12]}",
    )
    return package


def request_package_approval(
    conn: sqlite3.Connection, task_id: str, requester: str, ttl_s: float = 600.0
) -> Approval:
    """Gate a PR package behind a digest-bound, one-use approval."""
    package = latest_pr_package(conn, task_id)
    if package is None:
        raise ValueError(f"task {task_id} has no PR package to approve")
    run = latest_run(conn, task_id)
    if run is None:
        raise ValueError(f"task {task_id} has no runs; cannot bind approval")
    return store.request_approval(
        conn,
        run.id,
        "pr-package.merge-ready",
        requester,
        ttl_s=ttl_s,
        task_id=task_id,
        digest=package.digest,
    )


def build_rollup(conn: sqlite3.Connection, task_id: str, data_dir: str = ".") -> dict[str, Any]:
    """Task roll-up naming branch, patch, tests, review, PR package, approval."""
    task = store.get_task(conn, task_id)
    if task is None:
        raise KeyError(f"unknown task {task_id}")
    issue = store.get_issue(conn, task.issue_id) if task.issue_id else None
    artifacts = store.list_artifacts_for_task(conn, task_id)
    patches = [a.id for a in artifacts if a.type == "patch"]
    review = latest_review(conn, task_id)
    package = latest_pr_package(conn, task_id)
    approvals = store.list_approvals_for_task(conn, task_id)
    approval_status = approvals[-1].decision.value if approvals else "none"
    rollup: dict[str, Any] = {
        "task_id": task.id,
        "status": task.status.value,
        "issue": issue.model_dump(mode="json") if issue else None,
        "branch": task.branch,
        "workspace_path": task.workspace_path,
        "runs": [r.id for r in store.list_runs_for_task(conn, task_id)],
        "patch_artifacts": patches,
        "test_evidence": test_evidence_for_task(conn, task_id),
        "review": review.model_dump(mode="json") if review else None,
        "pr_package": package.model_dump(mode="json") if package else None,
        "approval_status": approval_status,
    }
    location = _artifact_file(
        data_dir, f"rollup-{task_id}", "json", json.dumps(rollup, indent=2, sort_keys=True)
    )
    run_id = rollup["runs"][-1] if rollup["runs"] else ""
    store.create_artifact(
        conn,
        task_id,
        run_id,
        "rollup",
        location,
        VerificationStatus.UNVERIFIED,
        summary=f"approval={approval_status}",
    )
    return rollup


# -- Phase 4: schedules and ingress --------------------------------------------


def create_scheduled(
    conn: sqlite3.Connection,
    project_id: str,
    name: str,
    cron: str,
    task_template: dict[str, Any],
    now: datetime | None = None,
) -> Schedule:
    """Validate a schedule and persist it with a computed first firing time."""
    from . import schedules as schedules_mod

    moment = now or datetime.now(UTC)
    next_run = schedules_mod.next_after(cron, moment)
    template_owner = task_template.get("owner_teammate_id")
    if template_owner is not None:
        mate = store.get_teammate(conn, str(template_owner))
        project = store.get_project(conn, project_id)
        if project is None:
            raise KeyError(f"unknown project {project_id}")
        if mate is None or mate.project_id != project_id:
            raise ValueError("schedule owner teammate must belong to the same project")
    return store.create_schedule(conn, project_id, name, cron, task_template, next_run)


def fire_due_schedules(
    conn: sqlite3.Connection,
    now: datetime | None = None,
    data_dir: str = ".",
    timeout_s: float = 60.0,
) -> list[dict[str, Any]]:
    """Fire all due schedules in deterministic order.

    Each firing: lock (overlap protection) → create task → run → outbox
    notification → audit events → unlock with advanced next_run_at.
    A firing that raises is recorded as a schedule error and unlocked;
    other schedules still fire.
    """
    from . import notify as notify_mod
    from . import schedules as schedules_mod

    moment = now or datetime.now(UTC)
    fired: list[dict[str, Any]] = []
    for schedule in store.due_schedules(conn, moment):
        if not store.lock_schedule(conn, schedule.id):
            continue  # overlap: a previous firing is still running
        try:
            template = schedule.task_template
            task = store.create_task(
                conn,
                schedule.project_id,
                description=str(template.get("description", schedule.name)),
                owner_teammate_id=template.get("owner_teammate_id"),
                command=str(template.get("command", "")),
            )
            run, _, artifact_id = schedule_run(
                conn, task.id, data_dir=data_dir, timeout_s=timeout_s
            )
            notify_mod.send_notification(
                conn,
                schedule.project_id,
                "outbox",
                "schedule.fired",
                {
                    "schedule_id": schedule.id,
                    "task_id": task.id,
                    "run_id": run.id,
                    "status": run.status.value,
                    "artifact_id": artifact_id,
                },
            )
            store.record_schedule_fired(
                conn, schedule.id, moment, schedules_mod.next_after(schedule.cron, moment)
            )
            fired.append(
                {
                    "schedule_id": schedule.id,
                    "task_id": task.id,
                    "run_id": run.id,
                    "status": run.status.value,
                }
            )
        except Exception as exc:
            conn.execute("UPDATE schedules SET locked = 0 WHERE id = ?", (schedule.id,))
            conn.commit()
            notify_mod.send_notification(
                conn,
                schedule.project_id,
                "outbox",
                "schedule.error",
                {"schedule_id": schedule.id, "error": f"{type(exc).__name__}: {exc}"},
            )
    return fired


def ingest_inbound(
    conn: sqlite3.Connection,
    project_id: str,
    title: str,
    body: str = "",
    labels: list[str] | None = None,
    source: str = "webhook",
) -> tuple[Issue, Task]:
    """Inbound ingress: one external payload becomes an issue + owned task."""
    issue = store.create_issue(
        conn, project_id, title=title, body=body, source=source, labels=labels or []
    )
    task = store.create_task(conn, project_id, description=f"ingress: {title}", issue_id=issue.id)
    store.record_event(conn, project_id, "ingress", task.id, "ingress.received")
    return issue, task
