"""CLI: ``nerdbot run`` starts the Product API server."""

from __future__ import annotations

import os

import click
import httpx
import uvicorn

# Test seam: sweep HTTP behavior is injected here (no live network in tests).
_test_transport: httpx.BaseTransport | None = None


@click.group()
def cli() -> None:
    """NerdBot workspace CLI."""


@cli.command("run")
@click.option("--host", default="127.0.0.1", show_default=True)
@click.option("--port", default=8080, show_default=True, type=int)
def run(host: str, port: int) -> None:
    """Run the API server (primary workflow)."""
    from nerdbot.auth import token_status

    status = token_status()
    if status == "closed":
        click.echo(
            "warning: NERDBOT_TOKEN is not set and the dev-default token is"
            " not enabled: the API will reject every bearer token with 503."
            " Set NERDBOT_TOKEN, or NERDBOT_INSECURE_DEV_TOKEN=1 to opt in to"
            " the well-known local dev token."
        )
    elif status == "dev":
        click.echo(
            "warning: running with the well-known dev token"
            " (NERDBOT_INSECURE_DEV_TOKEN=1). Never expose this port."
        )
    db = os.environ.get("NERDBOT_DB", "nerdbot.db")
    data = os.environ.get("NERDBOT_DATA", ".nerdbot-data")
    click.echo(f"nerdbot: db={db} data={data} host={host} port={port}")
    uvicorn.run("nerdbot.api:app", host=host, port=port)


@cli.command("deliveries-sweep")
@click.option("--quiet", is_flag=True, help="Print one summary line only.")
def deliveries_sweep(quiet: bool) -> None:
    """Run one outbox delivery sweep (lease reclaims + due webhook sends).

    Intended to be wired to an OS cron/timer: NerdBot itself never loops.
    Exit code 0 when no delivery ended failed, 1 otherwise. The same
    work is available over HTTP via POST /webhooks/sweep.
    """
    from nerdbot import notify as notify_mod
    from nerdbot import store

    db = os.environ.get("NERDBOT_DB", "nerdbot.db")
    try:
        conn = store.connect(db)
    except OSError as exc:
        raise click.ClickException(f"cannot open database {db!r}: {exc}") from exc
    try:
        results = notify_mod.sweep_due_deliveries(conn, transport=_test_transport)
    except click.ClickException:
        raise
    except Exception as exc:  # unexpected top-level failure: surface it
        raise click.ClickException(f"sweep failed: {exc}") from exc
    finally:
        conn.close()
    failures = 0
    for row in results:
        suffix = ""
        if row.get("error"):
            suffix = f" error={row['error']}"
        if row.get("reclaimed"):
            suffix += " reclaimed"
        if row["status"] == "failed":
            failures += 1
        if not quiet:
            click.echo(
                f"{row['id']} status={row['status']} attempts={row['attempts']}{suffix}"
            )
    click.echo(f"sweep: {len(results)} deliveries, {failures} failed")
    if failures:
        raise click.exceptions.Exit(1)


@cli.command("fire-due")
@click.option("--quiet", is_flag=True, help="Print one summary line only.")
@click.option(
    "--timeout-s", default=300.0, show_default=True, type=float,
    help="Per-firing run wall-clock budget.",
)
def fire_due(quiet: bool, timeout_s: float) -> None:
    """Fire all due schedules once (lock -> task -> run -> notify -> unlock).

    Intended to be wired to an OS cron/timer, e.g. every five minutes — the
    store holds the schedule, cron provides the heartbeat. Exit code 0 when
    no firing errored, 1 otherwise.
    """
    from nerdbot import orchestrator as orchestrator_mod
    from nerdbot import store

    db = os.environ.get("NERDBOT_DB", "nerdbot.db")
    data_dir = os.environ.get("NERDBOT_DATA", ".nerdbot-data")
    try:
        conn = store.connect(db)
    except OSError as exc:
        raise click.ClickException(f"cannot open database {db!r}: {exc}") from exc
    errors = 0
    try:
        fired = orchestrator_mod.fire_due_schedules(
            conn, data_dir=data_dir, timeout_s=timeout_s
        )
    except click.ClickException:
        raise
    except Exception as exc:
        raise click.ClickException(f"schedule firing failed: {exc}") from exc
    finally:
        conn.close()
    for row in fired:
        suffix = ""
        if row.get("error"):
            suffix = f" error={row['error']}"
            errors += 1
        if not quiet:
            click.echo(
                f"{row['schedule_id']} task={row.get('task_id')} status={row.get('status')}{suffix}"
            )
    click.echo(f"fire-due: {len(fired)} fired, {errors} errored")
    if errors:
        raise click.exceptions.Exit(1)


@cli.command("ingest-issue")
@click.option("--project", "project_id", required=True, help="Project id that owns the issue")
@click.option("--title", required=True, help="Issue title")
@click.option("--body", default="", show_default=True, help="Issue body")
@click.option("--base-branch", default="main", show_default=True)
@click.option("--priority", default="medium", show_default=True)
@click.option("--labels", default="", show_default=True, help="Comma-separated labels")
def ingest_issue(
    project_id: str, title: str, body: str, base_branch: str, priority: str, labels: str
) -> None:
    """Manually ingest an issue (no credentials required)."""
    from nerdbot import store

    db = os.environ.get("NERDBOT_DB", "nerdbot.db")
    conn = store.connect(db)
    try:
        principal = os.environ.get("NERDBOT_OWNER", "local-owner")
        project = store.get_project(conn, project_id)
        if project is None or project.owner != principal:
            raise click.ClickException("project not found or not owned by NERDBOT_OWNER")
        issue = store.create_issue(
            conn,
            project_id,
            title=title,
            body=body,
            base_branch=base_branch,
            priority=priority,
            labels=[label.strip() for label in labels.split(",") if label.strip()],
        )
    finally:
        conn.close()
    click.echo(issue.id)


@cli.command("executor-sweep")
@click.option("--quiet", is_flag=True, help="Print one summary line only.")
@click.option(
    "--timeout-s", default=60.0, show_default=True, type=float,
    help="Per-run wall-clock budget.",
)
@click.option(
    "--max-tasks", default=10, show_default=True, type=int,
    help="Max tasks to claim and run in this sweep.",
)
def executor_sweep(quiet: bool, timeout_s: float, max_tasks: int) -> None:
    """Claim pending unowned tasks to available bots and run them.

    One sweep: oldest pending task without an owner is claimed by an active
    teammate in the same project who has a model provider attached and is not
    already busy, then executed in an isolated workspace. Intended to be wired
    to OS cron, or run manually.
    """
    from nerdbot import executor as executor_mod
    from nerdbot import store

    db = os.environ.get("NERDBOT_DB", "nerdbot.db")
    data_dir = os.environ.get("NERDBOT_DATA", ".nerdbot-data")
    try:
        conn = store.connect(db)
    except OSError as exc:
        raise click.ClickException(f"cannot open database {db!r}: {exc}") from exc
    try:
        results = executor_mod.sweep(
            conn, data_dir=data_dir, timeout_s=timeout_s, max_tasks=max_tasks
        )
    finally:
        conn.close()
    for row in results:
        suffix = ""
        if row.get("reason"):
            suffix = f" reason={row['reason']}"
        if not quiet:
            click.echo(
                f"{row['task_id']} bot={row.get('bot_id','-')} run={row.get('run_id','-')} "
                f"status={row['status']}{suffix}"
            )
    click.echo(f"executor-sweep: {len(results)} tasks processed")
    if any(r["status"] in ("run_error", "claim_failed") for r in results):
        raise click.exceptions.Exit(1)
