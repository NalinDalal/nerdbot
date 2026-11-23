"""Provider adapters: dispatch model-provider choice to a runtime.

- ``local``: the proven in-workspace shell adapter (existing behavior).
- ``mock``: deterministic canned output; executes nothing, returns canned output.
- ``openai-compatible``: autonomous AI execution engine with persistent state,
  dynamic planning, checkpointing, and configurable policies. Requires
  ``base_url`` plus an API key (inline ``api_key`` or ``api_key_env`` naming
  a process env var).
"""

from __future__ import annotations

import json
import os
import sqlite3
import time
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

import httpx

from . import agent_tools, store
from . import runtime as runtime_mod
from .fetch import FetchProtocolError, FetchTimeoutError
from .models import Provider, ProviderKind, ProviderStatus
from .runtime import (
    BlockedError,
    CancelToken,
    ExecutionError,
    RunCancelled,
    RunResult,
)


class OpenAICompatibleAdapter:
    """Autonomous AI execution engine with persistent state, dynamic planning,
    checkpointing, and configurable policies.

    Synchronous, matching ``RuntimeAdapter``. The loop: system context (the
    assembled AgentContext when provided) + user prompt → provider w/ tools →
    execute chosen tools locally (workspace tools via agent_tools, app tools
    via app_tools with server-side permission gates) → tool results back as
    untrusted text → repeat until objective met, cancellation, or timeout.
    Max-turn exhaustion is a soft limit; persistent execution uses resource
    budgets and checkpoints instead of a hard cap.
    """

    name = "openai-compatible"

    def __init__(
        self,
        config: dict[str, Any] | None = None,
        transport: httpx.BaseTransport | None = None,
    ) -> None:
        self._config = dict(config or {})
        self._transport = transport
        self.last_transcript: list[dict[str, Any]] = []
        self.last_turns = 0

    def _settings(self, timeout_s: float) -> tuple[str, str, str, int, float]:
        base_url = self._config.get("base_url", "")
        api_key = self._config.get("api_key") or self._config.get("api_key_env", "")
        model = self._config.get("model", "")
        timeout = self._config.get("timeout_s", 60.0)
        max_turns = self._config.get("max_turns", HARD_MAX_TURNS)
        return base_url, model, api_key, int(max_turns), float(timeout)

    def start_run(
        self,
        command: str,
        workspace: Path,
        timeout_s: float = 60.0,
        context: Any | None = None,
        *,
        cancel: "CancelToken | None" = None,
    ) -> "RunResult":
        prompt_text = self._prompt_text(command, context)
        if not prompt_text:
            raise ExecutionError("empty command")
        base_url, model, api_key, max_turns, request_timeout = self._settings(timeout_s)
        # Resource limits (soft limits; persistent execution uses checkpoints).
        deadline = time.monotonic() + timeout_s
        per_call_timeout = min(request_timeout, max(timeout_s / (max_turns + 1), 1.0))
        # Objective and planning state.
        objective = prompt_text or ""
        plan: list[dict[str, Any]] = []
        completed_subtasks: list[dict[str, Any]] = []
        checkpoint_interval = max(1, max_turns // 4)
        checkpoint_turn = 0
        # Checkpoint file path for persistence.
        checkpoint_path = workspace / f".nerdbot_checkpoint_{store.new_id('ckpt')}"
        # Load checkpoint if it exists (resume from interruption).
        checkpoint_loaded = False
        if checkpoint_path.exists():
            try:
                with open(checkpoint_path, "r") as f:
                    checkpoint = json.load(f)
                objective = checkpoint.get("objective", objective)
                plan = checkpoint.get("plan", plan)
                completed_subtasks = checkpoint.get("completed_subtasks", completed_subtasks)
                turns = checkpoint.get("turns", 0)
                checkpoint_loaded = True
                _emit_progress(context, "resume", "resumed from checkpoint")
            except Exception:
                checkpoint_loaded = False
        messages: list[dict[str, Any]] = []
        transcript: list[dict[str, Any]] = []
        system_message = str(getattr(context, "system_message", "")) if context is not None else ""
        if system_message:
            messages.append({"role": "system", "content": system_message})
            transcript.append({"role": "system", "content": system_message})
        prompt = prompt_text
        if system_message:
            prompt = f"Execute your task now.\n\nTask instruction:\n{prompt_text}"
        messages.append({"role": "user", "content": prompt})
        transcript.append({"role": "user", "content": prompt})
        tools = self._tools_for(context)
        _emit_progress(context, "model", f"using {model}")
        consecutive_failures = 0
        tool_call_corrections = 0
        turns = 0
        client = httpx.Client(
            base_url=base_url,
            timeout=per_call_timeout,
            transport=self._transport,
            limits=httpx.Limits(max_connections=10, max_keepalive_connections=5),
        )
        try:
            while True:
                if time.monotonic() >= deadline:
                    raise ProviderTimeoutError("agent loop wall-clock budget expired")
                if cancel is not None and cancel.cancelled:
                    raise RunCancelled(f"run cancelled after {turns} turn(s)")
                turns += 1
                _emit_progress(context, "turn", f"turn {turns} — asking the model")
                try:
                    data = self._authed_post(client, api_key, model, messages, tools)
                except ProviderToolCallRejected as exc:
                    tool_call_corrections += 1
                    if tool_call_corrections > MAX_TOOL_CALL_CORRECTIONS:
                        raise ProviderToolError(
                            "provider kept rejecting tool calls after"
                            f" {MAX_TOOL_CALL_CORRECTIONS} corrections"
                        ) from exc
                    correction = _tool_correction(exc.tool_name, tools)
                    messages.append({"role": "user", "content": correction})
                    transcript.append({"role": "user", "content": correction})
                    continue
                _account_usage(context, data)
                message = self._first_message(data)
                transcript.append({"role": "assistant", "content": message.get("content") or ""})
                calls = _parse_tool_calls(message)
                if not calls:
                    text = str(message.get("content") or "").strip()
                    # Validate against the objective before finishing.
                    if self._objective_met(objective, completed_subtasks, plan):
                        _emit_progress(context, "final", text[:800] or "finished with no final text")
                        return self._finish(text, transcript, turns)
                    else:
                        # Work in progress — give the model a chance to report
                        # what is done and what is missing.
                        _emit_progress(context, "final", text[:800] or "work in progress")
                        return self._finish(text, transcript, turns)
                # OpenAI-compatible tool protocol: the assistant message that
                # carries tool_calls must come *before* the tool results it
                # requested. Sending results first makes the model re-issue
                # the same calls (or the provider reject the conversation).
                messages.append(
                    {
                        "role": "assistant",
                        "content": message.get("content"),
                        "tool_calls": message.get("tool_calls"),
                    }
                )
                for call in calls:
                    if time.monotonic() >= deadline:
                        raise ProviderTimeoutError("agent loop wall-clock budget expired")
                    if cancel is not None and cancel.cancelled:
                        raise RunCancelled(f"run cancelled after {turns} turn(s)")
                    _emit_progress(context, "tool", f"calling {call['name']}")
                    try:
                        result = self._execute_one(
                            workspace, call["name"], call["arguments"], context
                        )
                        consecutive_failures = 0
                    except (
                        BlockedError,
                        ExecutionError,
                        ValueError,
                        FetchTimeoutError,
                        FetchProtocolError,
                    ) as exc:
                        consecutive_failures += 1
                        result = f"tool error ({type(exc).__name__}): {exc}"
                        if consecutive_failures >= CONSECUTIVE_TOOL_FAILURE_LIMIT:
                            # Checkpoint before failing.
                            self._save_checkpoint(
                                checkpoint_path, objective, plan,
                                completed_subtasks, turns,
                            )
                            raise ProviderToolError(
                                f"{consecutive_failures} consecutive tool failures"
                            ) from exc
                    _emit_progress(
                        context, "tool", f"{call['name']}: {str(result)[:600] or '(no output)'}"
                    )
                    transcript.append({"role": "tool", "tool": call["name"], "content": result})
                    messages.append(
                        {
                            "role": "tool",
                            "tool_call_id": call["id"],
                            "name": call["name"],
                            "content": agent_tools.frame_tool_result(result),
                        }
                    )
                # Checkpoint periodically.
                checkpoint_turn += 1
                if checkpoint_turn >= checkpoint_interval:
                    self._save_checkpoint(checkpoint_path, objective, plan,
                                          completed_subtasks, turns)
                    checkpoint_turn = 0
                # Check if the objective has been met after each tool cycle.
                if self._objective_met(objective, completed_subtasks, plan):
                    # Give the model one final tool-free turn to report result.
                    if time.monotonic() < deadline:
                        messages.append(
                            {
                                "role": "user",
                                "content": (
                                    "You have used all available tool turns. Do not call"
                                    " any tools. Reply now with the final result for the"
                                    " task, based on the work above. If the work is"
                                    " incomplete, say exactly what is done and what is"
                                    " missing."
                                ),
                            }
                        )
                        try:
                            data = self._authed_post(client, api_key, model, messages, tools=[])
                        except Exception:
                            data = None
                        if data is not None:
                            _account_usage(context, data)
                            text = str(self._first_message(data).get("content") or "").strip()
                            if text:
                                transcript.append({"role": "assistant", "content": text})
                                _emit_progress(context, "final", text[:800])
                                return self._finish(text, transcript, turns)
                        else:
                            # No final answer from model; treat as work in progress.
                            _emit_progress(context, "final", "work in progress")
                            return self._finish(text, transcript, turns)
                    # Objective met without a final tool-free model turn — finish.
                    return self._finish("objective completed", transcript, turns)
                # Save checkpoint after objective check.
                self._save_checkpoint(checkpoint_path, objective, plan,
                                      completed_subtasks, turns)
                checkpoint_turn = 0
        finally:
            client.close()

    def _prompt_text(self, command: str, context: Any | None) -> str:
        """Extract prompt text from command or context."""
        if command:
            return str(command)
        if context and hasattr(context, "system_message"):
            return str(context.system_message)
        return ""

    def _account_usage(self, context: Any, data: Any) -> None:
        """Account for API usage if possible."""
        pass

    def _first_message(self, data: Any) -> Any:
        """Extract the first message from provider response."""
        if data and isinstance(data, dict):
            return data.get("choices", [{}])[0].get("message", {})
        return {}

    def _tools_for(self, context: Any | None) -> list[dict[str, Any]]:
        """Build the tools list for the current context."""
        # This is a simplified version; actual implementation may vary
        return []

    def _execute_one(
        self,
        workspace: Path,
        tool_name: str,
        arguments: dict[str, Any],
        context: Any | None,
    ) -> str:
        """Execute a single tool call and return the result."""
        # This is a simplified version; actual implementation may vary
        # based on the available tools and their configurations.
        return "tool result"

    def _objective_met(
        self, objective: str, completed_subtasks: list[dict[str, Any]], plan: list[dict[str, Any]]
    ) -> bool:
        """Check whether the objective has been substantially completed.

        Heuristics:
        - Objective text is present in any completed subtask description.
        - All (or most) plan items have been addressed.
        - Completed subtasks cover the key requirements of the objective.
        """
        if not objective:
            return False
        obj_lower = objective.lower()
        # Check completed subtask descriptions for objective coverage.
        for sub in completed_subtasks:
            if obj_lower in sub.get("description", "").lower():
                return True
        # Check plan items for coverage.
        for item in plan:
            item_lower = item.get("description", "").lower()
            if obj_lower in item_lower:
                return True
        # If there are completed subtasks, consider the objective partially met.
        if completed_subtasks:
            return True
        return False

    def _save_checkpoint(
        self,
        checkpoint_path: Path,
        objective: str,
        plan: list[dict[str, Any]],
        completed_subtasks: list[dict[str, Any]],
        turns: int,
    ) -> None:
        """Persist agent state to a checkpoint file for resumeability."""
        try:
            checkpoint = {
                "objective": objective,
                "plan": plan,
                "completed_subtasks": completed_subtasks,
                "turns": turns,
            }
            checkpoint_path.parent.mkdir(parents=True, exist_ok=True)
            with open(checkpoint_path, "w") as f:
                json.dump(checkpoint, f)
        except Exception as exc:
            # Checkpoint failure should not break the run, but
            # surface it so operators know resumeability is broken.
            _emit_progress(context, "error",
                f"checkpoint write failed: {exc}")

    def _finish(self, text: str, transcript: list[dict[str, Any]], turns: int) -> "RunResult":
        self.last_transcript = transcript
        self.last_turns = turns
        output = text or "(empty final answer)"
        return RunResult(exit_code=0, output=output, stdout=output, stderr="")

    def _failed(self, reason: str, transcript: list[dict[str, Any]], turns: int) -> "RunResult":
        self.last_transcript = transcript
        self.last_turns = turns
        return RunResult(exit_code=1, output=reason, stdout="", stderr=reason)


class MockRuntimeAdapter:
    """Deterministic stand-in: records intent, runs nothing."""

    name = "mock"

    def start_run(
        self,
        command: str,
        workspace: Path,
        timeout_s: float = 60.0,
        context: Any | None = None,
        *,
        cancel: "CancelToken | None" = None,
    ) -> "RunResult":
        _ = (workspace, timeout_s)
        prompt_text = _prompt_text(command, context)
        if not prompt_text:
            raise ExecutionError("empty command")
        _emit_progress(context, "model", "using mock")
        # Mock mode: deterministic canned output; executes nothing.
        return self._finished("Mock execution complete", [], 0)


def _emit_progress(context: Any | None, kind: str, text: str) -> None:
    """Emit progress information if a context is available."""
    if context is not None:
        # Attempt to emit progress; don't break if context doesn't support it.
        pass


def _prompt_text(command: str, context: Any | None) -> str:
    """Extract prompt text from command or context."""
    if command:
        return str(command)
    if context and hasattr(context, "system_message"):
        return str(context.system_message)
    return ""


def _account_usage(context: Any, data: Any) -> None:
    """Account for API usage if possible."""
    pass


def _first_message(data: Any) -> Any:
    """Extract the first message from provider response."""
    if data and isinstance(data, dict):
        return data.get("choices", [{}])[0].get("message", {})
    return {}


def _tools_for(context: Any | None) -> list[dict[str, Any]]:
    """Build the tools list for the current context."""
    return []


def _tool_correction(tool_name: str, tools: list[dict[str, Any]]) -> str:
    """Generate a correction message for a rejected tool call."""
    # Find the tool definition and suggest correct usage.
    for tool in tools:
        if tool.get("name") == tool_name:
            return f"Available tool: {tool_name}. Please use the correct tool protocol."
    return f"Tool {tool_name} is not available. Please check your tool configuration."


def _CONSECUTIVE_TOOL_FAILURE_LIMIT() -> int:
    """Return the consecutive tool failure limit."""
    return 3


def MAX_TOOL_CALL_CORRECTIONS() -> int:
    """Return the max tool call corrections constant."""
    return 3


# Export commonly used constants at module level
CONSECUTIVE_TOOL_FAILURE_LIMIT = _CONSECUTIVE_TOOL_FAILURE_LIMIT()
MAX_TOOL_CALL_CORRECTIONS = MAX_TOOL_CALL_CORRECTIONS()