"""Live check: a gated action, a restart, and the decision that carries it out.

Starts the product for real (uvicorn, its own database), has a bot ask for a
privileged action through a scripted model on localhost, restarts the server,
and then decides. The point is the restart: the request and the action it is
holding must survive it, and the owner's answer must still do the work —
once.

Run it with:  uv run python scripts/live_approval_check.py
"""

from __future__ import annotations

import json
import os
import signal
import subprocess
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
from typing import Any

TOKEN = "live-approval-token"
BASE = "http://127.0.0.1:8093"
AUTH = {"Authorization": f"Bearer {TOKEN}"}


def call(
    method: str, path: str, body: dict[str, Any] | None = None
) -> tuple[int, dict[str, Any]]:
    data = json.dumps(body or {}).encode()
    req = urllib.request.Request(
        f"{BASE}{path}",
        data=data,
        headers={"Content-Type": "application/json", **AUTH},
        method=method,
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            return resp.status, json.loads(resp.read().decode() or "{}")
    except urllib.error.HTTPError as exc:
        return exc.code, json.loads(exc.read().decode() or "{}")


class ScriptedModel:
    """A model that asks for one privileged action, then finishes."""

    def __init__(self) -> None:
        self.script = [
            {
                "choices": [
                    {
                        "message": {
                            "role": "assistant",
                            "content": "",
                            "tool_calls": [
                                {
                                    "id": "c1",
                                    "type": "function",
                                    "function": {
                                        "name": "create_teammate",
                                        "arguments": json.dumps({"persona": "engineer"}),
                                    },
                                }
                            ],
                        }
                    }
                ]
            },
            {"choices": [{"message": {"role": "assistant", "content": "done"}}]},
        ]
        self._server = HTTPServer(("127.0.0.1", 0), self._make_handler())
        threading.Thread(target=self._server.serve_forever, daemon=True).start()

    @property
    def base_url(self) -> str:
        host, port = self._server.server_address[:2]
        return f"http://{host}:{port}/v1"

    def _make_handler(self):  # type: ignore[no-untyped-def]
        outer = self

        class Handler(BaseHTTPRequestHandler):
            def do_POST(self) -> None:  # noqa: N802
                length = int(self.headers.get("Content-Length") or 0)
                json.loads(self.rfile.read(length) or b"{}")
                body = json.dumps(outer.script[0]).encode()
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def log_message(self, *args: Any) -> None:
                return

        return Handler


def start_server(db: Path, data: Path) -> subprocess.Popen[bytes]:
    from cryptography.fernet import Fernet

    env = {
        **os.environ,
        "NERDBOT_TOKEN": TOKEN,
        "NERDBOT_DB": str(db),
        "NERDBOT_DATA": str(data),
        # The provider carries an inline key, which is encrypted at rest.
        "NERDBOT_SECRET_KEY": Fernet.generate_key().decode("ascii"),
    }
    nerdbot = Path(sys.executable).parent / "nerdbot"
    proc = subprocess.Popen(
        [str(nerdbot), "run", "--port", "8093"],
        env=env,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    for _ in range(80):
        time.sleep(0.25)
        try:
            status, _ = call("GET", "/health")
            if status == 200:
                return proc
        except Exception:
            continue
    raise SystemExit("the server did not come up")


def stop_server(proc: subprocess.Popen[bytes]) -> None:
    proc.send_signal(signal.SIGTERM)
    try:
        proc.wait(timeout=10)
    except subprocess.TimeoutExpired:  # pragma: no cover
        proc.kill()


def main() -> int:
    model = ScriptedModel()
    tmp = Path(tempfile.mkdtemp(prefix="live-approval-"))
    db = tmp / "live.db"
    data = tmp / "data"

    proc = start_server(db, data)
    try:
        _, project = call("POST", "/projects", {"repository": "live"})
        pid = project["id"]
        _, provider = call(
            "POST",
            f"/projects/{pid}/providers",
            {
                "kind": "openai-compatible",
                "name": "scripted",
                "config": {
                    "base_url": model.base_url,
                    "model": "scripted",
                    "api_key": "sk-live",
                    "max_turns": 2,
                },
            },
        )
        _, bot = call(
            "POST",
            f"/projects/{pid}/teammates",
            {
                "persona": "ceo",
                "permissions": ["teammate.create"],
                "provider_id": provider["id"],
            },
        )
        _, task = call(
            "POST",
            f"/projects/{pid}/tasks",
            {
                "description": "make a teammate",
                "command": "make a teammate",
                "owner_teammate_id": bot["id"],
            },
        )
        status, run = call("POST", f"/tasks/{task['id']}/runs")
        assert status == 200, run
        print(f"run status after the gated call: {run['run']['status']}")
        assert run["run"]["status"] == "awaiting_approval", run

        # --- the server restarts -------------------------------------------
        stop_server(proc)
        proc = start_server(db, data)
        print("server restarted on the same database")

        status, inbox = call("GET", "/approvals?state=pending")
        assert status == 200, inbox
        pending = inbox["approvals"]
        print(f"pending after the restart: {len(pending)}")
        assert len(pending) == 1, pending
        item = pending[0]
        assert item["tool_name"] == "create_teammate", item
        assert item["run_id"] == run["run"]["id"], item
        assert item["task_id"] == task["id"], item
        assert item["teammate_id"] == bot["id"], item

        _, mates = call("GET", f"/projects/{pid}/teammates")
        assert [m["persona"] for m in mates["teammates"]] == ["ceo"], mates
        print("the action has not been performed yet")

        # --- the owner says yes --------------------------------------------
        status, decided = call(
            "POST", f"/approvals/{item['id']}/decision", {"decision": "approved"}
        )
        assert status == 200, decided
        print(f"decision outcome: {decided['resume']['outcome']}")
        assert decided["resume"]["outcome"] == "carried_out", decided

        _, mates = call("GET", f"/projects/{pid}/teammates")
        personas = [m["persona"] for m in mates["teammates"]]
        print(f"teammates now: {personas}")
        assert personas.count("engineer") == 1, mates

        _, view = call("GET", f"/tasks/{task['id']}")
        print(f"task status: {view['task']['status']}")
        assert view["task"]["status"] == "done", view["task"]

        # --- the same answer again changes nothing --------------------------
        status, again = call(
            "POST", f"/approvals/{item['id']}/decision", {"decision": "approved"}
        )
        assert status == 200, again
        assert again["idempotent"] is True, again
        _, mates = call("GET", f"/projects/{pid}/teammates")
        assert [m["persona"] for m in mates["teammates"]].count("engineer") == 1, mates
        print("a second, identical decision performed nothing")

        print("\nLIVE CHECK PASSED")
        return 0
    finally:
        stop_server(proc)


if __name__ == "__main__":
    raise SystemExit(main())
