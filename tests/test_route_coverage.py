"""Route coverage for the endpoints the architecture audit called untested.

The audit noted that several routes had no test at all: ``/executor/sweep``,
the chat stream, ``/home``, ``/capabilities``, ``/permissions``, and the
backup export/import round trip. An untested route is a route whose
contract nobody has pinned, so this file exercises each one against the
real app.
"""

from __future__ import annotations

import os

import pytest
from fastapi.testclient import TestClient

from nerdbot import store
from nerdbot.api import create_app

TOKEN = "route-coverage-token"
AUTH = {"Authorization": f"Bearer {TOKEN}"}


@pytest.fixture()
def client(tmp_path, monkeypatch):
    monkeypatch.setenv("NERDBOT_TOKEN", TOKEN)
    monkeypatch.setenv("NERDBOT_DB", str(tmp_path / "routes.db"))
    monkeypatch.setenv("NERDBOT_DATA", str(tmp_path / "data"))
    return TestClient(create_app())


# --- /capabilities -------------------------------------------------------


def test_capabilities_lists_the_catalogue(client) -> None:
    r = client.get("/capabilities", headers=AUTH)
    assert r.status_code == 200, r.text
    caps = r.json()["capabilities"]
    assert isinstance(caps, list) and caps, "no capabilities were reported"
    assert all("id" in c for c in caps)


def test_capabilities_requires_authentication(client) -> None:
    assert client.get("/capabilities").status_code in (401, 403)


# --- /permissions --------------------------------------------------------


def test_permissions_lists_the_catalogue(client) -> None:
    r = client.get("/permissions", headers=AUTH)
    assert r.status_code == 200, r.text
    perms = r.json()["permissions"]
    assert isinstance(perms, list) and perms
    names = {p["name"] if isinstance(p, dict) else p for p in perms}
    assert "teammate.create" in names, "the gate catalogue is missing a known permission"


def test_permissions_requires_authentication(client) -> None:
    assert client.get("/permissions").status_code in (401, 403)


# --- /home ---------------------------------------------------------------


def test_home_resolves_or_creates_the_default_workspace(client) -> None:
    r = client.get("/home", headers=AUTH)
    assert r.status_code == 200, r.text
    home = r.json()
    assert home["id"].startswith("prj_")
    assert home["owner"]


def test_home_is_stable_across_calls(client) -> None:
    first = client.get("/home", headers=AUTH).json()["id"]
    second = client.get("/home", headers=AUTH).json()["id"]
    assert first == second, "Home resolved to a different project on the second call"


def test_home_requires_authentication(client) -> None:
    assert client.get("/home").status_code in (401, 403)


# --- chat stream ---------------------------------------------------------


def test_chat_stream_emits_the_answer_and_ends(client) -> None:
    """The SSE endpoint sends text chunks and a [DONE] sentinel."""
    home = client.get("/home", headers=AUTH).json()
    provider = client.post(
        f"/projects/{home['id']}/providers",
        json={"kind": "mock", "name": "mock"},
        headers=AUTH,
    )
    assert provider.status_code == 200, provider.text

    thread = client.post(
        f"/projects/{home['id']}/threads",
        json={"title": "stream"},
        headers=AUTH,
    )
    assert thread.status_code == 200, thread.text
    thread_id = thread.json()["id"]

    with client.stream(
        "POST",
        f"/threads/{thread_id}/chat/stream",
        json={"content": "hello"},
        headers=AUTH,
    ) as resp:
        assert resp.status_code == 200, resp.status_code
        body = "".join(chunk for chunk in resp.iter_text())

    assert "data:" in body, "the stream sent no SSE frames"
    assert "[DONE]" in body, "the stream never terminated"
    assert "hello" in body or "mock" in body.lower()


def test_chat_stream_requires_authentication(client) -> None:
    home = client.get("/home", headers=AUTH).json()
    thread = client.post(
        f"/projects/{home['id']}/threads",
        json={"title": "t"},
        headers=AUTH,
    ).json()["id"]
    r = client.post(f"/threads/{thread}/chat/stream", json={"content": "x"})
    assert r.status_code in (401, 403)


# --- /executor/sweep -----------------------------------------------------


def test_executor_sweep_reports_a_result(client) -> None:
    """The sweep runs and answers with a summary, even with nothing to do."""
    r = client.post("/executor/sweep", headers=AUTH)
    assert r.status_code == 200, r.text
    body = r.json()
    assert "results" in body or "processed" in body or "swept" in body, body


def test_executor_sweep_requires_authentication(client) -> None:
    assert client.post("/executor/sweep").status_code in (401, 403)


# --- backup export / import ----------------------------------------------


def test_backup_export_import_round_trip(client) -> None:
    """Export a project, remove a row, and restore it from the manifest."""
    src = client.post("/projects", json={"repository": "src"}, headers=AUTH).json()
    task = client.post(
        f"/projects/{src['id']}/tasks",
        json={"description": "a task worth backing up", "command": "echo hi"},
        headers=AUTH,
    ).json()

    exported = client.get(f"/projects/{src['id']}/backup", headers=AUTH)
    assert exported.status_code == 200, exported.text
    manifest = exported.json()
    assert manifest, "the export was empty"
    assert manifest["tables"]["tasks"], "the export did not carry the task"

    # Remove the row so the restore has something real to bring back.
    conn = store.connect(os.environ["NERDBOT_DB"])
    try:
        conn.execute("DELETE FROM tasks WHERE id = ?", (task["id"],))
        conn.commit()
    finally:
        conn.close()
    assert client.get(f"/projects/{src['id']}/tasks", headers=AUTH).json()["tasks"] == []

    imported = client.post(
        f"/projects/{src['id']}/backup/import",
        json={"manifest": manifest},
        headers=AUTH,
    )
    assert imported.status_code == 200, imported.text
    assert imported.json()["rejected"] == [], imported.json()["rejected"]

    tasks = client.get(f"/projects/{src['id']}/tasks", headers=AUTH).json()["tasks"]
    assert any("a task worth backing up" in t["description"] for t in tasks), (
        "the restored task did not arrive"
    )


def test_backup_import_refuses_a_manifest_for_another_project(client) -> None:
    """A manifest is bound to its project: importing it elsewhere is refused."""
    src = client.post("/projects", json={"repository": "src"}, headers=AUTH).json()
    manifest = client.get(f"/projects/{src['id']}/backup", headers=AUTH).json()

    dst = client.post("/projects", json={"repository": "dst"}, headers=AUTH).json()
    r = client.post(
        f"/projects/{dst['id']}/backup/import",
        json={"manifest": manifest},
        headers=AUTH,
    )
    assert r.status_code == 400, r.text
    assert "project_id" in r.text


def test_backup_import_rejects_a_row_from_another_project(client) -> None:
    """Even when the manifest names the target project, a row that belongs
    elsewhere is rejected with a reason rather than imported."""
    src = client.post("/projects", json={"repository": "src"}, headers=AUTH).json()
    foreign = client.post(
        f"/projects/{src['id']}/tasks",
        json={"description": "belongs to src"},
        headers=AUTH,
    ).json()
    manifest = client.get(f"/projects/{src['id']}/backup", headers=AUTH).json()

    dst = client.post("/projects", json={"repository": "dst"}, headers=AUTH).json()
    # Retarget the manifest, but leave the task row pointing at src.
    manifest["project_id"] = dst["id"]
    for row in manifest["tables"]["tasks"]:
        row["project_id"] = src["id"]

    r = client.post(
        f"/projects/{dst['id']}/backup/import",
        json={"manifest": manifest},
        headers=AUTH,
    )
    assert r.status_code == 200, r.text
    rejected = r.json()["rejected"]
    assert any(row["id"] == foreign["id"] for row in rejected), rejected
    assert all("project" in row["reason"] for row in rejected), rejected

    tasks = client.get(f"/projects/{dst['id']}/tasks", headers=AUTH).json()["tasks"]
    assert not any(t["id"] == foreign["id"] for t in tasks), (
        "a task from another project was imported"
    )


def test_backup_export_requires_ownership(client) -> None:
    other = client.post("/projects", json={"repository": "other"}, headers=AUTH).json()
    r = client.get(f"/projects/{other['id']}/backup", headers={"Authorization": "Bearer nope"})
    assert r.status_code in (401, 403, 404), r.status_code


def test_backup_import_rejects_a_malformed_manifest(client) -> None:
    pid = client.post("/projects", json={"repository": "r"}, headers=AUTH).json()["id"]
    r = client.post(
        f"/projects/{pid}/backup/import",
        json={"manifest": {"not": "a manifest"}},
        headers=AUTH,
    )
    assert r.status_code >= 400, r.text


def test_backup_validate_reports_a_malformed_manifest(client) -> None:
    """Validation answers 200 with the list of problems, not an error."""
    pid = client.post("/projects", json={"repository": "r"}, headers=AUTH).json()["id"]
    r = client.post(
        f"/projects/{pid}/backup/validate",
        json={"manifest": {"not": "a manifest"}},
        headers=AUTH,
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["valid"] is False, body
    assert body["errors"], "a malformed manifest was reported as valid"


# --- declared request bodies --------------------------------------------


def test_malformed_request_bodies_are_rejected(client) -> None:
    """A write with a wrong field type is refused, not silently coerced."""
    pid = client.post("/projects", json={"repository": "r"}, headers=AUTH).json()["id"]

    bad_task = client.post(
        f"/projects/{pid}/tasks",
        json={"description": "ok", "dependencies": "not-a-list"},
        headers=AUTH,
    )
    assert bad_task.status_code == 422, bad_task.text

    bad_project = client.post("/projects", json={"repository": ["a", "list"]}, headers=AUTH)
    assert bad_project.status_code == 422, bad_project.text


def test_unknown_fields_are_ignored(client) -> None:
    """A client sending extra keys is not broken by the typed bodies."""
    r = client.post(
        "/projects",
        json={"repository": "r", "something_new": "ignored"},
        headers=AUTH,
    )
    assert r.status_code == 200, r.text
    assert r.json()["id"].startswith("prj_")


def test_a_null_optional_field_is_not_rejected(client) -> None:
    """A browser client may send null for "not chosen". That must not be a
    422, and it must not store the literal text "None" either."""
    pid = client.post("/projects", json={"repository": "r"}, headers=AUTH).json()["id"]
    r = client.post(
        f"/projects/{pid}/tasks",
        json={"description": "d", "command": None, "owner_teammate_id": None},
        headers=AUTH,
    )
    assert r.status_code == 200, r.text
    task = next(
        t for t in client.get(f"/projects/{pid}/tasks", headers=AUTH).json()["tasks"]
        if t["id"] == r.json()["id"]
    )
    assert task["command"] == "", repr(task["command"])
    assert task["owner_teammate_id"] is None


def test_a_null_optional_field_on_every_typed_body_is_accepted(client) -> None:
    """Every modelled body accepts nulls for its optional fields."""
    pid = client.post("/projects", json={"repository": "r"}, headers=AUTH).json()["id"]
    assert client.post(
        f"/projects/{pid}/teammates",
        json={
            "persona": None,
            "instructions": None,
            "capabilities": None,
            "permissions": None,
            "memory_scope": None,
            "provider_id": None,
        },
        headers=AUTH,
    ).status_code == 200
    assert client.post(
        f"/projects/{pid}/providers",
        json={"kind": None, "name": None, "config": None, "capabilities": None},
        headers=AUTH,
    ).status_code == 200
    assert client.post(
        f"/projects/{pid}/threads",
        json={"title": None, "provider_id": None},
        headers=AUTH,
    ).status_code == 200


def test_a_semantically_invalid_value_still_answers_400(client) -> None:
    """The typed bodies do not turn the existing 400s into 422s."""
    pid = client.post("/projects", json={"repository": "r"}, headers=AUTH).json()["id"]
    r = client.post(
        f"/projects/{pid}/providers",
        json={"kind": "not-a-kind"},
        headers=AUTH,
    )
    assert r.status_code == 400, r.text
    assert "invalid provider kind" in r.text


def test_invalid_decision_still_answers_400(client) -> None:
    r = client.post(
        "/approvals/apr_does_not_exist/decision",
        json={"decision": "maybe"},
        headers=AUTH,
    )
    assert r.status_code == 400, r.text
    assert "invalid decision" in r.text


# --- sqlite busy timeout -------------------------------------------------


def test_connections_set_a_busy_timeout(tmp_path, monkeypatch) -> None:
    """A second writer waits for the lock instead of failing outright."""
    from nerdbot import store

    monkeypatch.setenv("NERDBOT_DB", str(tmp_path / "busy.db"))
    conn = store.connect(str(tmp_path / "busy.db"))
    try:
        timeout = conn.execute("PRAGMA busy_timeout").fetchone()[0]
        assert timeout == store.BUSY_TIMEOUT_MS, timeout
        assert timeout > 0
    finally:
        conn.close()
