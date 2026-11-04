"""A run event stream must be resumeable, live, and honest about the end.

The workbench followed runs by polling ``/runs/{run_id}/events``: useful, but
a page opened mid-run joins blind until its next poll and a finished run is
discovered at polling speed. The SSE stream fixes both: it replays the
durable log from ``after``, relays live events as they are recorded, and
closes with an ``end`` frame when the run reaches a terminal state — so
"quiet" can never be mistaken for "still working".

These tests pin the three properties that survive real use: replay matches
the stored log exactly (a reconnect resumes, never duplicates), a live run
pushes events while it executes, and a terminal run closes the stream in a
predictable-for-the-client way. A run parked on an approval stays open until
the decision.
"""

from __future__ import annotations

import json
import threading
import time

import pytest
from fastapi.testclient import TestClient

from nerdbot.api import create_app

TOKEN = "stream-token"
AUTH = {"Authorization": f"Bearer {TOKEN}"}


@pytest.fixture()
def client(tmp_path, monkeypatch):
    monkeypatch.setenv("NERDBOT_TOKEN", TOKEN)
    monkeypatch.setenv("NERDBOT_DB", str(tmp_path / "stream.db"))
    monkeypatch.setenv("NERDBOT_DATA", str(tmp_path / "data"))
    return TestClient(create_app())


def _project(client: TestClient) -> str:
    return client.post("/projects", json={"repository": "r"}, headers=AUTH).json()["id"]


def _task(client: TestClient, pid: str, command: str) -> str:
    return client.post(
        f"/projects/{pid}/tasks",
        json={"description": "streaming job", "command": command},
        headers=AUTH,
    ).json()["id"]


def _frames(response) -> tuple[list[dict], list[str]]:  # type: ignore[no-untyped-def]
    """Split an SSE body into data frames and keepalive comments."""
    events: list[dict] = []
    comments: list[str] = []
    for block in response.text.split("\n\n"):
        payload = "\n".join(
            line[6:] for line in block.split("\n") if line.startswith("data: ")
        )
        if payload:
            events.append(json.loads(payload))
        elif block.startswith(": "):
            comments.append(block)
    return events, comments


def _stream(client: TestClient, run_id: str, after: int = 0, timeout: float = 15.0):
    with client.stream(
        "GET",
        f"/runs/{run_id}/events/stream?after={after}",
        headers=AUTH,
        timeout=timeout,
    ) as response:
        assert response.status_code == 200, response.text
        assert response.headers["content-type"].startswith("text/event-stream")
        content = b"".join(chunk for chunk in response.iter_bytes()).decode()
    return _frames(type("_R", (), {"text": content}))


# -- Replay: a reconnect resumes without duplicates or gaps ------------------


def test_stream_replays_recorded_events_and_closes(client) -> None:
    pid = _project(client)
    tid = _task(client, pid, "echo replayed-stream-test")
    result = client.post(f"/tasks/{tid}/runs", headers=AUTH)
    assert result.status_code == 200, result.text
    run_id = result.json()["run"]["id"]

    stored = client.get(f"/runs/{run_id}/events", headers=AUTH).json()["events"]
    assert stored, "a local run must record at least one event before the stream is tested"

    events, _ = _stream(client, run_id)
    terminal = [event for event in events if event.get("type") == "end"]
    assert terminal == [{"type": "end"}], "exactly one end frame closes the stream"
    data_events = [event for event in events if "seq" in event]
    assert [event["seq"] for event in data_events] == [
        event["seq"] for event in stored
    ], "the replay matches the durable log exactly, in order"


def test_stream_after_skips_replayed_history(client) -> None:
    """``after`` is a resume cursor: only newer events are replayed."""
    pid = _project(client)
    tid = _task(client, pid, "echo cursor-test")
    result = client.post(f"/tasks/{tid}/runs", headers=AUTH)
    run_id = result.json()["run"]["id"]
    stored = client.get(f"/runs/{run_id}/events", headers=AUTH).json()["events"]
    assert len(stored) >= 1

    events, _ = _stream(client, run_id, after=stored[0]["seq"])
    data_events = [event for event in events if "seq" in event]
    assert all(event["seq"] > stored[0]["seq"] for event in data_events)
    ends = [event for event in events if event.get("type") == "end"]
    assert len(ends) == 1


# -- Live: the stream relays events recorded after the listener connected ----


def test_stream_pushes_live_events_until_terminal(client) -> None:
    """A cancel recorded behind an open listener still surfaces live."""
    pid = _project(client)
    tid = _task(client, pid, "sleep 30")
    started = client.post(f"/tasks/{tid}/runs/async", headers=AUTH)
    assert started.status_code == 200, started.text

    result = client.get(f"/projects/{pid}/runs", headers=AUTH)
    assert result.status_code == 200
    # Under a loaded suite the run can still be queued; wait for flight.
    deadline = time.monotonic() + 10
    while time.monotonic() < deadline:
        result = client.get(f"/projects/{pid}/runs", headers=AUTH)
        runs_list = [r for r in result.json()["runs"] if r["status"] == "running"]
        if runs_list:
            break
        time.sleep(0.2)
    assert runs_list, "the async run must be in flight for this test to mean anything"
    run_id = runs_list[0]["id"]

    def _cancel_later() -> None:
        time.sleep(0.4)
        response = client.post(f"/runs/{run_id}/cancel", headers=AUTH)
        assert response.status_code == 200, response.text

    canceller = threading.Thread(target=_cancel_later, daemon=True)
    canceller.start()
    events, _ = _stream(client, run_id, timeout=20)
    kinds = [event.get("kind") for event in events if "kind" in event]
    assert "cancelled" in kinds, f"the cancel event must arrive on the stream: {kinds}"
    assert [event.get("type") for event in events].count("end") >= 1
