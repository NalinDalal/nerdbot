"""Live smoke test: cancel a run against a real uvicorn server.

Starts the product, starts a long-running task, cancels the run from
another connection, and checks that the run is cancelled and that the
command's process group is really gone.
"""

from __future__ import annotations

import contextlib
import json
import os
import shutil
import signal
import subprocess
import sys
import tempfile
import time
import urllib.request
from pathlib import Path

TOKEN = "live-cancel-token"
BASE = "http://127.0.0.1:8099"


def post(path: str, body: dict | None = None) -> tuple[int, dict]:
    data = json.dumps(body or {}).encode()
    req = urllib.request.Request(
        f"{BASE}{path}",
        data=data,
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {TOKEN}",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            return resp.status, json.loads(resp.read().decode())
    except urllib.error.HTTPError as exc:
        return exc.code, json.loads(exc.read().decode())


def get(path: str) -> tuple[int, dict]:
    req = urllib.request.Request(
        f"{BASE}{path}", headers={"Authorization": f"Bearer {TOKEN}"}
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            return resp.status, json.loads(resp.read().decode())
    except urllib.error.HTTPError as exc:
        return exc.code, json.loads(exc.read().decode())


def main() -> int:
    tmp = tempfile.mkdtemp(prefix="nerdbot-live-cancel-")
    os.environ["NERDBOT_TOKEN"] = TOKEN
    os.environ["NERDBOT_DB"] = str(Path(tmp) / "live.db")
    os.environ["NERDBOT_DATA"] = str(Path(tmp) / "data")
    os.environ["NERDBOT_EXECUTOR"] = "0"

    repo = Path(__file__).resolve().parents[1]
    marker = Path(tmp) / "grandchild.pid"
    server = subprocess.Popen(
        [
            str(repo / ".venv" / "bin" / "python"),
            "-m",
            "uvicorn",
            "nerdbot.api:create_app",
            "--factory",
            "--host",
            "127.0.0.1",
            "--port",
            "8099",
            "--log-level",
            "warning",
        ],
        cwd=str(repo),
        env={**os.environ},
    )
    try:
        deadline = time.time() + 30
        while time.time() < deadline:
            try:
                status, _ = get("/health")
                if status == 200:
                    break
            except Exception:
                time.sleep(0.2)
        else:
            print("FAIL: server never came up")
            return 1

        _, project = post("/projects", {"repository": "live-cancel"})
        pid = project["id"]
        command = f"sleep 120 & echo $! > {marker}; wait"
        _, task = post(
            f"/projects/{pid}/tasks", {"description": "long", "command": command}
        )
        task_id = task["id"]

        import threading

        outcome: dict[str, object] = {}

        def start() -> None:
            outcome["response"] = post(f"/tasks/{task_id}/runs")

        runner = threading.Thread(target=start, daemon=True)
        runner.start()

        run_id = ""
        deadline = time.time() + 20
        while time.time() < deadline and not run_id:
            _, view = get(f"/tasks/{task_id}")
            for run in view["runs"]:
                if run["status"] == "running":
                    run_id = run["id"]
            if not run_id:
                time.sleep(0.05)
        if not run_id:
            print("FAIL: the run never started")
            return 1
        print(f"live run started: {run_id}")

        deadline = time.time() + 10
        while time.time() < deadline and not marker.exists():
            time.sleep(0.05)
        if not marker.exists():
            print("FAIL: the command never started")
            return 1
        grandchild = int(marker.read_text().strip())
        print(f"grandchild pid: {grandchild}")

        started = time.time()
        status, body = post(f"/runs/{run_id}/cancel")
        print(f"cancel -> {status} {json.dumps(body)[:160]}")
        runner.join(timeout=30)
        elapsed = time.time() - started
        if runner.is_alive():
            print("FAIL: the run never stopped")
            return 1

        _, view = get(f"/tasks/{task_id}")
        run = next(r for r in view["runs"] if r["id"] == run_id)
        print(f"run status: {run['status']}  task status: {view['task']['status']}")
        print(f"stopped in {elapsed:.2f}s")

        time.sleep(0.5)
        try:
            os.kill(grandchild, 0)
            alive = True
        except ProcessLookupError:
            alive = False
        print(f"grandchild alive after cancel: {alive}")

        ok = (
            status == 200
            and run["status"] == "cancelled"
            and view["task"]["status"] == "cancelled"
            and not alive
            and elapsed < 15
        )
        print("RESULT:", "PASS" if ok else "FAIL")
        return 0 if ok else 1
    finally:
        server.send_signal(signal.SIGINT)
        try:
            server.wait(timeout=10)
        except subprocess.TimeoutExpired:
            server.kill()
            with contextlib.suppress(subprocess.TimeoutExpired):
                server.wait(timeout=5)
        # The command runs in its own session, so the server going down does
        # not take it with it. If the run was still in flight (an early
        # failure before the cancel landed), kill the grandchild explicitly
        # rather than leaving a `sleep 120` behind.
        with contextlib.suppress(OSError, ValueError):
            os.kill(int(marker.read_text().strip()), signal.SIGKILL)
        # The temp dir holds the throwaway database and data dir. Remove it:
        # this check must not leave runtime state behind.
        shutil.rmtree(tmp, ignore_errors=True)


if __name__ == "__main__":
    sys.exit(main())
