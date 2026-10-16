"""Phase 3: issue intake -> isolated workspace -> tested patch -> review -> PR package."""

from __future__ import annotations

import os
from pathlib import Path

import pytest
from click.testing import CliRunner
from fastapi.testclient import TestClient

from nerdbot import orchestrator, store
from nerdbot.api import create_app
from nerdbot.cli.main import cli
from nerdbot.integrations.github import (
    AdapterNotConfiguredError,
    StubGitHubIssueFetcher,
    github_status,
)
from nerdbot.models import ReviewVerdict

TOKEN = "phase3-token"
AUTH = {"Authorization": f"Bearer {TOKEN}"}
FIXTURES = str(Path(__file__).parent / "fixtures" / "calc-app")


@pytest.fixture()
def app_client(tmp_path, monkeypatch):
    monkeypatch.setenv("NERDBOT_TOKEN", TOKEN)
    monkeypatch.setenv("NERDBOT_DB", str(tmp_path / "p3.db"))
    monkeypatch.setenv("NERDBOT_DATA", str(tmp_path / "data"))
    return TestClient(create_app())


def _project(client: TestClient) -> str:
    r = client.post("/projects", json={"repository": "fixture"}, headers=AUTH)
    assert r.status_code == 200, r.text
    return r.json()["id"]


def _teammate(client: TestClient, pid: str, persona: str) -> str:
    r = client.post(
        f"/projects/{pid}/teammates",
        json={"persona": persona, "instructions": "i", "capabilities": ["code"]},
        headers=AUTH,
    )
    assert r.status_code == 200, r.text
    return r.json()["id"]


def test_issue_intake_and_link(app_client: TestClient) -> None:
    pid = _project(app_client)
    mate = _teammate(app_client, pid, "coder")
    r = app_client.post(
        f"/projects/{pid}/issues",
        json={
            "title": "add() is broken",
            "body": "returns difference",
            "acceptance_criteria": ["add(2,3)==5"],
            "repository_url": "fixture://calc-app",
            "base_branch": "main",
            "labels": ["bug"],
            "owner_teammate_id": mate,
            "priority": "high",
        },
        headers=AUTH,
    )
    assert r.status_code == 200, r.text
    issue = r.json()
    assert issue["source"] == "manual" and issue["base_branch"] == "main"

    r = app_client.post(
        f"/projects/{pid}/tasks",
        json={"description": "fix add", "owner_teammate_id": mate, "issue_id": issue["id"]},
        headers=AUTH,
    )
    assert r.status_code == 200, r.text
    tid = r.json()["id"]

    view = app_client.get(f"/tasks/{tid}", headers=AUTH).json()
    assert view["issue"]["id"] == issue["id"]
    assert view["issue"]["acceptance_criteria"] == ["add(2,3)==5"]

    linked = app_client.get(f"/issues/{issue['id']}", headers=AUTH).json()
    assert [t["id"] for t in linked["tasks"]] == [tid]

    r = app_client.post(f"/projects/{pid}/issues", json={"title": "  "}, headers=AUTH)
    assert r.status_code == 400


def test_github_adapter_explicitly_deferred(app_client: TestClient) -> None:
    r = app_client.get("/integrations/github/status", headers=AUTH)
    assert r.status_code == 200
    assert r.json() == github_status()
    assert github_status()["configured"] is False
    with pytest.raises(AdapterNotConfiguredError):
        StubGitHubIssueFetcher().fetch_issue("org/repo", 1)


def test_cli_ingest_issue(tmp_path, monkeypatch) -> None:
    from nerdbot import store as store_mod

    db = str(tmp_path / "cli.db")
    monkeypatch.setenv("NERDBOT_DB", db)
    conn = store_mod.connect(db)
    project = store_mod.create_project(conn, owner="local-owner")
    conn.close()
    runner = CliRunner()
    result = runner.invoke(
        cli,
        ["ingest-issue", "--project", project.id, "--title", "cli issue", "--labels", "a,b"],
    )
    assert result.exit_code == 0, result.output
    conn2 = store_mod.connect(db)
    issues = store_mod.list_issues_for_project(conn2, project.id)
    assert [i.title for i in issues] == ["cli issue"]
    assert issues[0].labels == ["a", "b"]
    conn2.close()


def test_workspace_branch_mapping_idempotent(app_client: TestClient) -> None:
    pid = _project(app_client)
    r = app_client.post(f"/projects/{pid}/tasks", json={"description": "ws"}, headers=AUTH)
    tid = r.json()["id"]
    first = app_client.post(f"/tasks/{tid}/workspace", json={"seed_from": FIXTURES}, headers=AUTH)
    assert first.status_code == 200, first.text
    second = app_client.post(f"/tasks/{tid}/workspace", json={}, headers=AUTH)
    assert second.status_code == 200, second.text
    assert first.json() == second.json()
    assert first.json()["branch"] == f"nb/{tid}"
    assert os.path.exists(os.path.join(first.json()["path"], "calc.py"))


def test_run_records_execution_evidence(tmp_path) -> None:
    conn = store.connect(":memory:")
    project = store.create_project(conn, owner="local-owner")
    task = store.create_task(conn, project.id, "t", command="echo out && echo err >&2")
    run, result, art_id = orchestrator.schedule_run(conn, task.id, data_dir=str(tmp_path))
    assert result is not None and result.exit_code == 0
    stored = store.get_run(conn, run.id)
    assert stored is not None
    assert stored.command == "echo out && echo err >&2"
    assert "out" in stored.stdout and "err" in stored.stderr
    assert stored.duration_s >= 0.0
    assert art_id is not None
    artifacts = store.list_artifacts_for_task(conn, task.id)
    assert len(artifacts) == 1 and artifacts[0].type == "test-log"
    conn.close()


def test_failed_run_creates_failure_artifact(tmp_path) -> None:
    conn = store.connect(":memory:")
    project = store.create_project(conn, owner="local-owner")
    task = store.create_task(conn, project.id, "t", command="exit 3")
    run, _, art_id = orchestrator.schedule_run(conn, task.id, data_dir=str(tmp_path))
    assert run.exit_code == 3
    assert art_id is not None
    artifact = store.get_artifact(conn, art_id)
    assert artifact is not None and artifact.verification_status.value == "failed"
    conn.close()


def test_reviewer_rules_and_no_overwrite(app_client: TestClient) -> None:
    pid = _project(app_client)
    dev = _teammate(app_client, pid, "dev")
    rev = _teammate(app_client, pid, "reviewer")
    outsider_pid = _project(app_client)
    outsider = _teammate(app_client, outsider_pid, "x")
    r = app_client.post(
        f"/projects/{pid}/tasks",
        json={"description": "t", "owner_teammate_id": dev, "command": "echo ok"},
        headers=AUTH,
    )
    tid = r.json()["id"]
    run_id = app_client.post(f"/tasks/{tid}/runs", headers=AUTH).json()["run"]["id"]
    before = app_client.get(f"/tasks/{tid}", headers=AUTH).json()["artifacts"]

    # Owner cannot review own work; cross-project reviewer rejected.
    for bad in (dev, outsider):
        r = app_client.post(
            f"/tasks/{tid}/reviews",
            json={"reviewer_teammate_id": bad, "verdict": "accepted"},
            headers=AUTH,
        )
        assert r.status_code == 400, r.text

    r = app_client.post(
        f"/tasks/{tid}/reviews",
        json={
            "reviewer_teammate_id": rev,
            "verdict": "accepted",
            "notes": "clean",
            "risks": ["none"],
            "run_id": run_id,
        },
        headers=AUTH,
    )
    assert r.status_code == 200, r.text
    assert r.json()["review"]["verdict"] == "accepted"

    after = app_client.get(f"/tasks/{tid}", headers=AUTH).json()["artifacts"]
    assert [a["id"] for a in after[: len(before)]] == [a["id"] for a in before]
    assert after[len(before)]["type"] == "review"


def test_full_coding_workflow_end_to_end(app_client: TestClient) -> None:
    # 1. ingest issue
    pid = _project(app_client)
    dev = _teammate(app_client, pid, "dev")
    reviewer = _teammate(app_client, pid, "reviewer")
    r = app_client.post(
        f"/projects/{pid}/issues",
        json={
            "title": "add() broken",
            "acceptance_criteria": ["add(2,3)==5"],
            "base_branch": "main",
        },
        headers=AUTH,
    )
    issue_id = r.json()["id"]

    # 2. task linked to issue + teammate
    r = app_client.post(
        f"/projects/{pid}/tasks",
        json={
            "description": "fix add()",
            "owner_teammate_id": dev,
            "issue_id": issue_id,
            "command": "python -m pytest -q calc_suite.py",
        },
        headers=AUTH,
    )
    tid = r.json()["id"]

    # 3. isolated workspace/branch seeded from fixture
    r = app_client.post(f"/tasks/{tid}/workspace", json={"seed_from": FIXTURES}, headers=AUTH)
    assert r.status_code == 200, r.text
    assert r.json()["branch"] == f"nb/{tid}"

    # 4/5. red run: tests fail, failure artifact recorded
    red = app_client.post(f"/tasks/{tid}/runs", headers=AUTH).json()
    assert red["task_status"] == "failed"
    red_run = red["run"]["id"]

    # fix + green run via retry (new run, terminal run untouched)
    fix = (
        "python -c \"import pathlib; p = pathlib.Path('calc.py'); "
        "p.write_text(p.read_text().replace('return a - b', 'return a + b'))\""
    )
    app_client.patch(f"/tasks/{tid}", json={"command": fix}, headers=AUTH)
    app_client.post(f"/tasks/{tid}/retry", headers=AUTH)
    app_client.patch(
        f"/tasks/{tid}", json={"command": "python -m pytest -q calc_suite.py"}, headers=AUTH
    )
    green = app_client.post(f"/tasks/{tid}/retry", headers=AUTH).json()
    green_run = green["run"]["id"]
    assert green_run != red_run
    assert green["run"]["exit_code"] == 0
    assert "2 passed" in (green["run"].get("output_excerpt") or "")

    # 6. reviewer pass
    r = app_client.post(
        f"/tasks/{tid}/reviews",
        json={
            "reviewer_teammate_id": reviewer,
            "verdict": "accepted",
            "notes": "one-line fix, covered",
            "risks": ["none"],
            "run_id": green_run,
        },
        headers=AUTH,
    )
    assert r.status_code == 200, r.text

    # 7. patch diff artifact
    r = app_client.post(f"/tasks/{tid}/patch", json={"run_id": green_run}, headers=AUTH)
    assert r.status_code == 200, r.text
    patch_id = r.json()["artifact_id"]
    patch = app_client.get(f"/artifacts/{patch_id}", headers=AUTH).json()
    with open(patch["location"], encoding="utf-8") as fh:
        diff_text = fh.read()
    assert "return a + b" in diff_text

    # 8. candidate PR payload
    r = app_client.post(
        f"/tasks/{tid}/pr-package",
        json={"title": "Fix add()", "body": "one-line fix", "labels": ["bug"]},
        headers=AUTH,
    )
    assert r.status_code == 200, r.text
    package = r.json()
    assert package["head_branch"] == f"nb/{tid}" and package["base_branch"] == "main"
    assert package["digest"] and package["patch_artifact_id"] == patch_id
    assert package["review_evidence"]["verdict"] == "accepted"
    assert any(e["status"] == "passed" for e in package["test_evidence"])

    # 9. approval bound to digest
    r = app_client.post(f"/tasks/{tid}/package-approval", json={}, headers=AUTH)
    assert r.status_code == 200, r.text
    assert r.json()["digest"] == package["digest"]
    aid = r.json()["id"]
    r = app_client.post(f"/approvals/{aid}/decision", json={"decision": "approved"}, headers=AUTH)
    assert r.json()["decision"] == "approved"

    # 10. roll-up
    rollup = app_client.post(f"/tasks/{tid}/rollup", headers=AUTH).json()
    assert rollup["branch"] == f"nb/{tid}"
    assert rollup["patch_artifacts"] == [patch_id]
    assert rollup["review"]["verdict"] == "accepted"
    assert rollup["pr_package"]["digest"] == package["digest"]
    assert rollup["approval_status"] == "approved"
    assert rollup["issue"]["id"] == issue_id

    # 13. wrong token rejected on new routes
    bad = {"Authorization": "Bearer wrong"}
    assert app_client.post(f"/projects/{pid}/issues", json={}, headers=bad).status_code == 403
    assert app_client.post(f"/tasks/{tid}/reviews", json={}, headers=bad).status_code == 403
    assert app_client.post(f"/tasks/{tid}/pr-package", json={}).status_code == 401


def test_restart_preserves_coding_state(tmp_path, monkeypatch) -> None:
    db = str(tmp_path / "p3restart.db")
    data = str(tmp_path / "data")
    monkeypatch.setenv("NERDBOT_TOKEN", TOKEN)
    monkeypatch.setenv("NERDBOT_DB", db)
    monkeypatch.setenv("NERDBOT_DATA", data)
    client = TestClient(create_app())
    pid = _project(client)
    dev = _teammate(client, pid, "dev")
    reviewer = _teammate(client, pid, "reviewer")
    issue_id = client.post(f"/projects/{pid}/issues", json={"title": "i"}, headers=AUTH).json()[
        "id"
    ]
    tid = client.post(
        f"/projects/{pid}/tasks",
        json={
            "description": "t",
            "owner_teammate_id": dev,
            "issue_id": issue_id,
            "command": "python -m pytest -q calc_suite.py",
        },
        headers=AUTH,
    ).json()["id"]
    ws = client.post(f"/tasks/{tid}/workspace", json={"seed_from": FIXTURES}, headers=AUTH).json()
    run_id = client.post(f"/tasks/{tid}/runs", headers=AUTH).json()["run"]["id"]
    client.post(
        f"/tasks/{tid}/reviews",
        json={"reviewer_teammate_id": reviewer, "verdict": "needs_work", "notes": "n"},
        headers=AUTH,
    )
    package_id = client.post(f"/tasks/{tid}/pr-package", json={"title": "T"}, headers=AUTH).json()[
        "id"
    ]
    with TestClient(create_app()):
        pass  # lifespan recovery runs cleanly on reload

    reloaded = TestClient(create_app())
    view = reloaded.get(f"/tasks/{tid}", headers=AUTH).json()
    assert view["issue"]["id"] == issue_id
    assert view["task"]["branch"] == ws["branch"] == f"nb/{tid}"
    assert view["task"]["workspace_path"] == ws["path"]
    assert [r["id"] for r in view["runs"]] == [run_id]
    assert view["reviews"][0]["verdict"] == "needs_work"
    assert [p["id"] for p in view["pr_packages"]] == [package_id]
    assert any(a["type"] == "test-log" for a in view["artifacts"])
    types = [
        e["event_type"]
        for e in reloaded.get(f"/projects/{pid}/events", headers=AUTH).json()["events"]
    ]
    for expected in (
        "issue.ingested",
        "workspace.created",
        "run.created",
        "run.status.running",
        "review.completed",
        "package.generated",
    ):
        assert expected in types, f"missing {expected}"


def test_package_digest_stable() -> None:
    from nerdbot.orchestrator import package_digest

    canonical = {"task_id": "t", "title": "T", "test_evidence": [{"a": 1}]}
    assert package_digest(canonical) == package_digest(dict(canonical))
    changed = dict(canonical, title="other")
    assert package_digest(changed) != package_digest(canonical)


def test_review_verdict_mapping(tmp_path) -> None:
    conn = store.connect(":memory:")
    project = store.create_project(conn, owner="local-owner")
    dev = store.create_teammate(conn, project.id, persona="dev")
    rev = store.create_teammate(conn, project.id, persona="rev")
    task = store.create_task(conn, project.id, "t", owner_teammate_id=dev.id, command="echo ok")
    data = str(tmp_path)
    _, art_rejected = orchestrator.submit_review(
        conn, task.id, rev.id, ReviewVerdict.REJECTED, notes="bad", data_dir=data
    )
    assert store.get_artifact(conn, art_rejected) is not None
    assert store.get_artifact(conn, art_rejected).verification_status.value == "failed"  # type: ignore[union-attr]
    location = store.get_artifact(conn, art_rejected).location  # type: ignore[union-attr]
    assert "bad" in Path(location).read_text(encoding="utf-8")
    conn.close()
