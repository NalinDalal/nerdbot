"""The Home command center reads one organisation snapshot.

These assertions pin the contract the dashboard depends on: counts are
server-computed, recent work is ordered, the fleet is described, and a
workspace with no model is surfaced as attention rather than silently
appearing healthy.
"""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from nerdbot.api import create_app

TOKEN = "organization-overview-token"
AUTH = {"Authorization": f"Bearer {TOKEN}"}


@pytest.fixture()
def client(tmp_path, monkeypatch):
    monkeypatch.setenv("NERDBOT_TOKEN", TOKEN)
    monkeypatch.setenv("NERDBOT_DB", str(tmp_path / "org.db"))
    monkeypatch.setenv("NERDBOT_DATA", str(tmp_path / "data"))
    return TestClient(create_app())


def test_overview_describes_workspace_work_and_fleet(client: TestClient) -> None:
    project = client.post(
        "/projects", json={"repository": "command-center"}, headers=AUTH
    )
    assert project.status_code == 200, project.text
    project_id = project.json()["id"]

    teammate = client.post(
        f"/projects/{project_id}/teammates",
        json={"persona": "researcher", "name": "Ada", "capabilities": ["research"]},
        headers=AUTH,
    )
    assert teammate.status_code == 200, teammate.text
    teammate_id = teammate.json()["id"]

    task = client.post(
        f"/projects/{project_id}/tasks",
        json={
            "description": "Collect sources",
            "owner_teammate_id": teammate_id,
            "command": "echo sources",
        },
        headers=AUTH,
    )
    assert task.status_code == 200, task.text

    # A finished execution must not break the snapshot: run timestamps are
    # datetimes on the model and the overview orders them as ISO strings.
    ran = client.post(
        f"/projects/{project_id}/tasks",
        json={"description": "Write findings", "command": "echo findings"},
        headers=AUTH,
    )
    assert ran.status_code == 200, ran.text
    run = client.post(f"/tasks/{ran.json()['id']}/runs", headers=AUTH)
    assert run.status_code == 200, run.text
    assert run.json()["task_status"] == "done"

    response = client.get("/organization/overview", headers=AUTH)
    assert response.status_code == 200, response.text
    body = response.json()

    assert body["project_count"] == 1
    assert body["active_projects"] == 1
    assert body["provider_ready_projects"] == 0
    assert body["agents"] == {
        "total": 1,
        "active": 1,
        "working": 0,
        "idle": 1,
        "inactive": 0,
    }
    assert body["tasks"]["total"] == 2
    assert body["tasks"]["active"] == 1
    assert body["tasks"]["queued"] == 1
    assert body["tasks"]["completed"] == 1
    assert body["tasks"]["cancelled"] == 0

    assert len(body["recent_tasks"]) == 2
    recent = body["recent_tasks"][0]
    assert recent["title"] == "Collect sources"
    assert recent["status"] == "pending"
    assert recent["project_name"] == "command-center"
    assert recent["owner_name"] == "Ada"
    assert recent["href"].startswith(f"/p/{project_id}/t/")

    assert any(item["kind"] == "run" for item in body["activity"])

    assert [agent["name"] for agent in body["agents_list"]] == ["Ada"]
    assert body["agents_list"][0]["href"] == f"/agents/{teammate_id}"

    # No provider row exists in this fixture, so the workspace is a real
    # attention item: the UI must not imply it can execute.
    assert any(item["kind"] == "provider" for item in body["attention"])
    assert body["deliverables"]["total"] == 0

    counts = body["projects"][0]["counts"]
    assert counts["ready"] == 0
    assert counts["awaiting_approval"] == 0
    assert counts["failed"] == 0
    assert counts["cancelled"] == 0

    # The reverse-proxy shape: the same route answers under /api.
    prefixed = client.get("/api/organization/overview", headers=AUTH)
    assert prefixed.status_code == 200, prefixed.text
    assert prefixed.json()["project_count"] == 1

    # The unified job feed must actually include task runs. It previously
    # called a store helper that did not exist and swallowed the failure,
    # leaving the Work page permanently empty.
    jobs = client.get("/jobs", headers=AUTH)
    assert jobs.status_code == 200, jobs.text
    task_run_jobs = [job for job in jobs.json()["jobs"] if job["source_type"] == "task_run"]
    assert task_run_jobs
    assert task_run_jobs[0]["task_id"] == ran.json()["id"]
