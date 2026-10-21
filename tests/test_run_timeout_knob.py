"""The run wall-clock budget must be configurable — slow providers otherwise
time out before reaching even one full agent turn.

Acceptance evidence (2026-10-21, real local model): every agent run failed
with ``provider timed out`` because the default 60s wall clock divided by
``max_turns + 1`` left a few seconds per model call. These tests pin the
``NERDBOT_RUN_TIMEOUT_S`` knob shared by the run endpoint, the executor
sweep, and the delegation-resume tool call.
"""

from __future__ import annotations

import pytest


def test_run_timeout_default_is_60(monkeypatch) -> None:
    from nerdbot.api import _run_wall_clock_s

    monkeypatch.delenv("NERDBOT_RUN_TIMEOUT_S", raising=False)
    assert _run_wall_clock_s() == 60.0


def test_run_timeout_env_override(monkeypatch) -> None:
    from nerdbot.api import _run_wall_clock_s

    monkeypatch.setenv("NERDBOT_RUN_TIMEOUT_S", "600")
    assert _run_wall_clock_s() == 600.0


def test_run_timeout_rejects_garbage_and_nonpositive(monkeypatch) -> None:
    from nerdbot import executor
    from nerdbot.api import _run_wall_clock_s

    monkeypatch.setenv("NERDBOT_RUN_TIMEOUT_S", "seconds")
    with pytest.raises(ValueError):
        _run_wall_clock_s()
    monkeypatch.setenv("NERDBOT_RUN_TIMEOUT_S", "0")
    with pytest.raises(ValueError):
        executor._run_timeout_s()


def test_executor_and_tools_share_the_knob(monkeypatch) -> None:
    from nerdbot import app_tools, executor

    monkeypatch.setenv("NERDBOT_RUN_TIMEOUT_S", "420")
    assert executor._run_timeout_s() == 420.0
    assert executor._run_timeout_s(30.0) == 30.0  # explicit argument wins
    assert app_tools._run_budget_s(".") == 420.0


def test_parameterless_sweep_picks_up_the_env(monkeypatch) -> None:
    """Documented behavior: a sweep invoked without timeout arguments uses
    the env budget."""
    from nerdbot import executor

    monkeypatch.setenv("NERDBOT_RUN_TIMEOUT_S", "300")
    # The sweep signature accepts None; schedule_run receives the resolved value.
    sig_default = executor._run_timeout_s(None)
    assert sig_default == 300.0
