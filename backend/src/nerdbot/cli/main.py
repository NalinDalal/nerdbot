"""CLI: ``nerdbot run`` starts the Product API server."""

from __future__ import annotations

import os

import click
import uvicorn


@click.group()
def cli() -> None:
    """NerdBot workspace CLI."""


@cli.command("run")
@click.option("--host", default="127.0.0.1", show_default=True)
@click.option("--port", default=8088, show_default=True, type=int)
def run(host: str, port: int) -> None:
    """Run the API server (primary workflow)."""
    db = os.environ.get("NERDBOT_DB", "nerdbot.db")
    data = os.environ.get("NERDBOT_DATA", ".nerdbot-data")
    click.echo(f"nerdbot: db={db} data={data} host={host} port={port}")
    uvicorn.run("nerdbot.api:app", host=host, port=port)


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
