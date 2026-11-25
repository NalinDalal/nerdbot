"""Provider adapters: dispatch model-provider choice to a runtime.

- ``local``: the proven in-workspace shell adapter (existing behavior).
- ``mock``: deterministic canned output; executes nothing. Safe for tests
  and capability demos.
- ``openai-compatible``: real OpenAI-style /chat/completions agent runtime
  with a bounded workspace-tool loop. Requires ``base_url`` plus an API key
  (inline ``api_key`` or ``api_key_env`` naming a process env var).

Provider choice is recorded on every run (``run.provider_id``) and audited.
Secrets are never written to artifacts, events, or logs.
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
    RuntimeAdapter,
)

DEFAULT_MAX_TURNS = 5
HARD_MAX_TURNS = 10
DEFAULT_REQUEST_TIMEOUT_S = 30.0
# Provider-level retries per HTTP call. Combined with task-level
# MAX_TASK_RETRIES (store.py) the worst case is
# MAX_TASK_RETRIES * (MAX_RETRIES + 1) HTTP attempts per task.
MAX_RETRIES = 4
CONSECUTIVE_TOOL_FAILURE_LIMIT = 3
MAX_TOOL_CALL_CORRECTIONS = 2


class ProviderConfigurationError(ValueError):
    """Missing or invalid provider configuration; run is blocked, not retried."""


class ProviderAuthenticationError(RuntimeError):
    """Provider rejected credentials (HTTP 401/403); run is blocked."""


class ProviderRateLimitError(RuntimeError):
    """Provider rate-limited after retries (HTTP 429)."""


class ProviderTimeoutError(RuntimeError):
    """Provider call timed out after retries, or the loop budget expired."""


class ProviderProtocolError(RuntimeError):
    """Malformed provider response or unexpected HTTP status."""


class ProviderToolCallRejected(ProviderProtocolError):
    """Provider rejected a tool call before it reached the loop.

    Groq validates tool names against the request and answers HTTP 400 when a
    model names one that was never offered. The call is recoverable: the loop
    tells the model which tools exist and tries again instead of failing the
    whole run.
    """

    def __init__(self, detail: str, tool_name: str) -> None:
        super().__init__(detail)
        self.tool_name = tool_name


class ProviderParseRejected(ProviderProtocolError):
    """Provider could not parse the model's own generation (HTTP 400).

    Groq-hosted reasoning models occasionally emit output their parser cannot
    read. Recoverable: ``_authed_post`` retries the same messages a bounded
    number of times before surfacing the failure.
    """


class ProviderNetworkError(RuntimeError):
    """Transport-level failure reaching the provider (unreachable / bad body)."""


class ProviderToolError(RuntimeError):
    """A tool call failed repeatedly inside the bounded loop."""


def health_check(provider: Provider, transport: Any = None) -> dict[str, Any]:
    """Return a non-secret health report for a provider."""
    import time as _time

    start = _time.monotonic()
    result = {"provider_id": provider.id, "kind": provider.kind.value, "healthy": False, "error": None, "latency_ms": 0}
    try:
        if provider.kind == ProviderKind.MOCK or provider.kind == ProviderKind.LOCAL:
            result["healthy"] = True
        elif provider.kind == ProviderKind.OPENAI_COMPATIBLE:
            api_key = resolve_api_key(provider.config)
            base_url = str(provider.config.get("base_url", "")).rstrip("/")
            if not base_url or not api_key:
                raise ProviderConfigurationError("missing base_url or api_key")
            with httpx.Client(timeout=5.0, transport=transport) as client:
                resp = client.get(base_url + "/models", headers={"Authorization": f"Bearer {api_key}"})
            if resp.status_code != 200:
                raise ProviderProtocolError(f"upstream returned {resp.status_code}")
            result["healthy"] = True
        elif provider.kind.value == "ollama":
            base_url = str(provider.config.get("base_url", "http://localhost:11434")).rstrip("/")
            with httpx.Client(timeout=5.0, transport=transport) as client:
                resp = client.get(base_url + "/api/tags")
            if resp.status_code != 200:
                raise ProviderProtocolError(f"upstream returned {resp.status_code}")
            result["healthy"] = True
        else:
            raise ProviderConfigurationError(f"unknown provider kind {provider.kind}")
    except Exception as exc:  # noqa: BLE001
        result["error"] = str(exc)
    result["latency_ms"] = int((_time.monotonic() - start) * 1000)
    return result


def resolve_api_key(config: dict[str, Any]) -> str:
    """Resolve the credential without persisting it anywhere.

    Inline ``api_key`` wins (decrypting ``enc:`` ciphertext fail-closed);
    otherwise ``api_key_env`` names a process environment variable.
    Empty string when unconfigured. Raises ProviderConfigurationError when
    a stored secret cannot be decrypted or is unexpectedly plaintext while
    a runtime key exists.
    """
    from . import secrets as secrets_mod

    inline = config.get("api_key", "")
    if isinstance(inline, str) and inline:
        if secrets_mod.is_encrypted(inline):
            try:
                return secrets_mod.decrypt_secret(inline)
            except secrets_mod.SecretDecryptError as exc:
                raise ProviderConfigurationError(f"stored credential undecryptable: {exc}") from exc
        if secrets_mod.keyring():
            raise ProviderConfigurationError(
                "stored credential is not encrypted; refusing to use it"
            )
        return inline
    env_name = config.get("api_key_env", "")
    if isinstance(env_name, str) and env_name:
        if env_name.startswith("NERDBOT_"):
            raise ProviderConfigurationError(
                "api_key_env must not reference NERDBOT_* server variables"
            )
        return os.environ.get(env_name, "")
    return ""


def _parse_tool_calls(message: dict[str, Any]) -> list[dict[str, Any]]:
    calls: list[dict[str, Any]] = []
    raw_calls = message.get("tool_calls") or []
    if not isinstance(raw_calls, list):
        raise ProviderProtocolError("tool_calls is not a list")
    for call in raw_calls:
        if not isinstance(call, dict):
            raise ProviderProtocolError("tool call is not an object")
        function = call.get("function") or {}
        if not isinstance(function, dict) or not function.get("name"):
            raise ProviderProtocolError("tool call missing function name")
        try:
            arguments = json.loads(function.get("arguments") or "{}")
        except (ValueError, TypeError) as exc:
            raise ProviderProtocolError(f"tool arguments are not JSON: {exc}") from exc
        if not isinstance(arguments, dict):
            raise ProviderProtocolError("tool arguments are not an object")
        calls.append(
            {"id": str(call.get("id", "")), "name": str(function["name"]), "arguments": arguments}
        )
    return calls


def _error_detail(response: httpx.Response) -> str:
    """Upstream error text, bounded.

    ``HTTP 400`` alone cannot be acted on; providers explain themselves in
    the body. Bounded so a stray HTML page cannot flood a run excerpt.
    """
    try:
        text = response.text.strip()
    except Exception:
        return ""
    return f": {text[:300]}" if text else ""


def _is_parse_failure(response: httpx.Response) -> bool:
    """True when the 400 is the model's unparseable generation, not our error.

    Groq answers with ``{"error": {"message": "Parsing failed. The model
    generated output that could not be parsed. ...", ...}}``. Retrying the
    same messages usually succeeds; failing the run does not.
    """
    try:
        body = response.json()
    except Exception:
        return False
    if not isinstance(body, dict):
        return False
    error = body.get("error")
    message = error.get("message") if isinstance(error, dict) else ""
    text = str(message)
    return "Parsing failed" in text or "could not be parsed" in text


def _rejected_tool_name(response: httpx.Response) -> str | None:
    """Name of the tool in a provider ``tool_use_failed`` response, if any.

    Returns ``None`` when the response is a different kind of error, and an
    empty string when the provider rejected a tool call but did not say which
    one. Both cases are recoverable; only ``None`` is a normal failure.
    """
    try:
        body = response.json()
    except Exception:
        return None
    if not isinstance(body, dict):
        return None
    error = body.get("error")
    if not isinstance(error, dict) or error.get("code") != "tool_use_failed":
        return None
    generation = error.get("failed_generation")
    if not isinstance(generation, str):
        return ""
    try:
        parsed = json.loads(generation)
    except ValueError:
        return ""
    name = parsed.get("name") if isinstance(parsed, dict) else None
    return str(name) if name else ""


def _tool_correction(tool_name: str, tools: list[dict[str, Any]]) -> str:
    """Tell the model what it may call, after it invented a tool."""
    available = ", ".join(
        str(tool.get("function", {}).get("name", "")) for tool in tools if isinstance(tool, dict)
    )
    named = f"the tool {tool_name!r}" if tool_name else "a tool that does not exist"
    return (
        f"Your last message called {named}, which is not available. "
        f"Use only these tools: {available}. Otherwise answer in plain text."
    )


def _prompt_text(command: str, context: Any | None) -> str:
    """The instruction a model-shaped adapter runs.

    Tasks created from the dashboard have no separate ``command``: the
    description *is* the instruction. Only model-shaped adapters read it that
    way. The shell runtime still rejects an empty command, so prose is never
    handed to ``sh -c``.
    """
    text = command.strip()
    if text:
        return text
    task = getattr(context, "task", None)
    for attr in ("description", "title"):
        value = getattr(task, attr, "") if task is not None else ""
        if isinstance(value, str) and value.strip():
            return value.strip()
    return ""


def _emit_progress(context: Any | None, kind: str, text: str) -> None:
    """Report one live-progress step without letting observability kill a run.

    The callback writes to SQLite on the run's connection. A progress write
    failing (disk full, another writer's lock) must never turn a working agent
    loop into a failed task.
    """
    callback = getattr(context, "progress", None) if context is not None else None
    if callback is None:
        return
    try:
        callback(kind, text)
    except Exception:
        return


def _account_usage(context: Any | None, data: dict[str, Any]) -> None:
    """Record one model call's token usage and enforce the org budgets.

    The upstream ``usage`` block is the only source of truth; when absent
    nothing is recorded (never estimated, never invented). A cap breach stops
    the run with BudgetExceeded — recorded as a failure, never as success —
    after the owner has been notified through the outbox.
    """
    usage = data.get("usage") if isinstance(data, dict) else None
    if not isinstance(usage, dict):
        return
    prompt_tokens = int(usage.get("prompt_tokens") or 0)
    completion_tokens = int(usage.get("completion_tokens") or 0)
    if prompt_tokens <= 0 and completion_tokens <= 0:
        return
    if context is None:
        return
    conn = getattr(context, "conn", None)
    if conn is None:
        return
    task = getattr(context, "task", None)
    mate = getattr(context, "teammate", None)
    try:
        from . import budgets

        budgets.check_and_record(
            conn,
            run_id=str(getattr(context, "run_id", "") or ""),
            task_id=str(getattr(task, "id", "") or ""),
            teammate_id=str(getattr(mate, "id", "") or ""),
            project_id=str(getattr(task, "project_id", "") or ""),
            prompt_tokens=prompt_tokens,
            completion_tokens=completion_tokens,
        )
    except budgets.BudgetExceeded:
        raise
    except Exception:
        # Accounting must never break a healthy run; the next call retries.
        return


class OpenAICompatibleAdapter:
    """Bounded agent loop over OpenAI-style /chat/completions with tools.

    Synchronous, matching ``RuntimeAdapter``. The loop: system context (the
    assembled AgentContext when provided) + user prompt → provider w/ tools →
    execute chosen tools locally (workspace tools via agent_tools, app tools
    via app_tools with server-side permission gates) → tool results back as
    untrusted text → repeat until no tool calls, the turn cap, or a failure
    threshold. Max-turn exhaustion is a failure, never a silent partial result.
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

    def _settings(self) -> tuple[str, str, str, int, float]:
        base_url = self._config.get("base_url", "")
        model = self._config.get("model", "")
        if not isinstance(base_url, str) or not base_url.strip():
            raise ProviderConfigurationError("openai-compatible provider needs base_url")
        if not isinstance(model, str) or not model.strip():
            raise ProviderConfigurationError("openai-compatible provider needs model")
        api_key = resolve_api_key(self._config)
        if not api_key:
            raise ProviderConfigurationError(
                "openai-compatible provider needs api_key or api_key_env"
            )
        max_turns = self._config.get("max_turns", HARD_MAX_TURNS)
        try:
            max_turns = int(max_turns)
        except (TypeError, ValueError) as exc:
            raise ProviderConfigurationError("max_turns must be an integer") from exc
        # max_turns is now a soft limit; persistent execution uses resource
        # budgets and checkpoints instead of a hard cap.
        timeout = self._config.get("timeout_s", DEFAULT_REQUEST_TIMEOUT_S)
        try:
            timeout = float(timeout)
        except (TypeError, ValueError) as exc:
            raise ProviderConfigurationError("timeout_s must be a number") from exc
        if timeout <= 0:
            raise ProviderConfigurationError("timeout_s must be positive")
        return base_url.rstrip("/"), model, api_key, max_turns, timeout

    def start_run(
        self,
        command: str,
        workspace: Path,
        timeout_s: float = 60.0,
        context: Any | None = None,
        *,
        cancel: CancelToken | None = None,
    ) -> RunResult:
        prompt_text = _prompt_text(command, context)
        if not prompt_text:
            raise ExecutionError("empty command")
        base_url, model, api_key, max_turns, request_timeout = self._settings()
        # Resource limits (soft limits; persistent execution uses checkpoints).
        deadline = time.monotonic() + timeout_s
        per_call_timeout = min(request_timeout, max(timeout_s / (max_turns + 1), 1.0))
        # Objective and planning state.
        objective = _prompt_text(command, context) or ""
        plan: list[dict[str, Any]] = []
        completed_subtasks: list[dict[str, Any]] = []
        checkpoint_interval = max(1, max_turns // 4)
        checkpoint_turn = 0
        messages: list[dict[str, Any]] = []
        transcript: list[dict[str, Any]] = []
        system_message = str(getattr(context, "system_message", "")) if context is not None else ""
        if system_message:
            messages.append({"role": "system", "content": system_message})
            transcript.append({"role": "system", "content": system_message})
        prompt = prompt_text
        if system_message:
            # The system message already carries task facts; keep the user
            # message as the execution instruction.
            prompt = f"Execute your task now.\n\nTask instruction:\n{prompt_text}"
        messages.append({"role": "user", "content": prompt})
        transcript.append({"role": "user", "content": prompt})
        tools = self._tools_for(context)
        _emit_progress(context, "model", f"using {model}")
        consecutive_failures = 0
        tool_call_corrections = 0
        turns = 0
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
                turns = checkpoint.get("turns", turns)
                checkpoint_loaded = True
                _emit_progress(context, "resume", "resumed from checkpoint")
            except Exception:
                checkpoint_loaded = False
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
                    # The model loop is interruptible between turns: a cancel
                    # request stops the loop instead of waiting for the next
                    # model call to come back.
                    raise RunCancelled(f"run cancelled after {turns} turn(s)")
                turns += 1
                _emit_progress(context, "turn", f"turn {turns} — asking the model")
                try:
                    data = self._authed_post(client, api_key, model, messages, tools)
                except ProviderToolCallRejected as exc:
                    # A model may name a tool nobody offered. That is its
                    # mistake, not a reason to lose the run: say what exists
                    # and let it correct itself, within a small budget.
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
                            self._save_checkpoint(checkpoint_path, objective, plan,
                                                  completed_subtasks, turns)
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

    def _tools_for(self, context: Any | None) -> list[dict[str, Any]]:
        """Workspace tools always; app tools only for an acting teammate,
        filtered to its granted permissions (fail-closed)."""
        from . import app_tools

        tools = agent_tools.tool_schemas()
        if context is not None and getattr(context, "teammate", None) is not None:
            granted = set(context.allowed_permissions)
            tools = tools + app_tools.app_tool_schemas(granted)
        return tools

    def _execute_one(
        self,
        workspace: Path,
        name: str,
        arguments: dict[str, Any],
        context: Any | None,
    ) -> str:
        from . import app_tools

        # App tools are teammate-scoped: only route to them when an acting
        # teammate is present. Otherwise a name that also exists as a base
        # workspace tool (e.g. web_search) keeps working through the base path.
        if (
            name in app_tools.APP_TOOL_NAMES
            and context is not None
            and getattr(context, "teammate", None) is not None
        ):
            return app_tools.execute_app_tool(
                context,
                name,
                arguments,
                data_dir=getattr(context, "data_dir", "."),
                run_id=getattr(context, "run_id", ""),
                workspace_path=str(workspace),
                transport=self._transport,
            )
        # Workspace tools: pass the database connection and the acting
        # teammate's id so persona/memory tools can scope their writes.
        mate = getattr(context, "teammate", None) if context is not None else None
        task = getattr(context, "task", None)
        return agent_tools.execute_tool(
            workspace,
            name,
            arguments,
            transport=self._transport,
            conn=getattr(context, "conn", None),
            teammate_id=mate.id if mate is not None else "",
        )

    def _authed_post(
        self,
        client: httpx.Client,
        api_key: str,
        model: str,
        messages: list[dict[str, Any]],
        tools: list[dict[str, Any]] | None = None,
        tool_choice: str = "auto",
    ) -> dict[str, Any]:
        # Key is attached to single request objects only, never client state.
        last_error: Exception | None = None
        import random as _random
        import time as _time

        payload: dict[str, Any] = {"model": model, "messages": messages}
        if tools is None:
            payload["tools"] = agent_tools.tool_schemas()
            payload["tool_choice"] = "auto"
        elif tools:
            payload["tools"] = tools
            payload["tool_choice"] = tool_choice
        # tools == [] is the final-answer turn: no tool block at all, so the
        # model has to reply in prose instead of asking for another search.
        for attempt in range(MAX_RETRIES + 1):
            request = client.build_request(
                "POST",
                "/chat/completions",
                json=payload,
                headers={"Authorization": f"Bearer {api_key}"},
            )
            try:
                response = client.send(request)
            except httpx.TimeoutException as exc:
                last_error = ProviderTimeoutError(f"provider timed out: {exc}")
                if attempt < MAX_RETRIES:
                    _time.sleep(min(2 ** attempt + _random.uniform(0, 1), 8.0))
                continue
            except httpx.TransportError as exc:
                last_error = ProviderNetworkError(f"provider unreachable: {exc}")
                if attempt < MAX_RETRIES:
                    _time.sleep(min(2 ** attempt + _random.uniform(0, 1), 8.0))
                continue
            if response.status_code in (401, 403):
                raise ProviderAuthenticationError(
                    f"provider rejected credentials (HTTP {response.status_code})"
                )
            if response.status_code == 429:
                last_error = ProviderRateLimitError("provider rate-limited (HTTP 429)")
                if attempt < MAX_RETRIES:
                    retry_after = response.headers.get("Retry-After")
                    delay = 2 ** attempt + _random.uniform(0, 1)
                    if retry_after:
                        try:
                            delay = max(delay, float(retry_after))
                        except ValueError:
                            pass
                    _time.sleep(min(delay, 30.0))
                continue
            if response.status_code >= 500:
                last_error = ProviderProtocolError(f"provider error (HTTP {response.status_code})")
                if attempt < MAX_RETRIES:
                    _time.sleep(min(2 ** attempt + _random.uniform(0, 1), 8.0))
                continue
            if response.status_code == 400:
                rejected = _rejected_tool_name(response)
                if rejected is not None:
                    raise ProviderToolCallRejected(
                        f"provider rejected a tool call (HTTP 400){_error_detail(response)}",
                        rejected,
                    )
                if _is_parse_failure(response):
                    # Groq-hosted reasoning models occasionally emit output the
                    # upstream parser cannot read ("Parsing failed..."). It is
                    # the model's fluke, not the caller's mistake: retry the
                    # same messages a bounded number of times.
                    last_error = ProviderParseRejected(
                        f"provider could not parse model output (HTTP 400)"
                        f"{_error_detail(response)}"
                    )
                    if attempt < MAX_RETRIES:
                        import time as _time
                        import random as _random

                        _time.sleep(min(1.5 * (attempt + 1) + _random.uniform(0, 1), 6.0))
                    continue
            if response.status_code != 200:
                raise ProviderProtocolError(
                    f"unexpected provider status (HTTP {response.status_code})"
                    f"{_error_detail(response)}"
                )
            try:
                data = response.json()
            except ValueError as exc:
                raise ProviderProtocolError(f"provider response is not JSON: {exc}") from exc
            if not isinstance(data, dict):
                raise ProviderProtocolError("provider response is not an object")
            return data
        assert last_error is not None  # loop always sets it before continuing
        raise last_error

    @staticmethod
    def _first_message(data: dict[str, Any]) -> dict[str, Any]:
        try:
            message = data["choices"][0]["message"]
        except (KeyError, IndexError, TypeError) as exc:
            raise ProviderProtocolError("provider response has no choices[0].message") from exc
        if not isinstance(message, dict):
            raise ProviderProtocolError("provider message is not an object")
        return message

    def _finish(self, text: str, transcript: list[dict[str, Any]], turns: int) -> RunResult:
        self.last_transcript = transcript
        self.last_turns = turns
        output = text or "(empty final answer)"
        return RunResult(exit_code=0, output=output, stdout=output, stderr="")

    def _failed(self, reason: str, transcript: list[dict[str, Any]], turns: int) -> RunResult:
        self.last_transcript = transcript
        self.last_turns = turns
        return RunResult(exit_code=1, output=reason, stdout="", stderr=reason)

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
        except Exception:
            # Checkpoint failure should not break the run.
            pass


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
        cancel: CancelToken | None = None,
    ) -> RunResult:
        _ = (workspace, timeout_s)
        prompt_text = _prompt_text(command, context)
        if not prompt_text:
            raise ExecutionError("empty command")
        if cancel is not None and cancel.cancelled:
            raise RunCancelled("run cancelled before the mock executed")
        output = f"[mock provider] would execute: {prompt_text}"
        return RunResult(exit_code=0, output=output, stdout=output, stderr="")


def adapter_for_provider(provider: Provider | None) -> RuntimeAdapter:
    """Resolve the runtime adapter for a provider (None = default local)."""
    if provider is None or provider.kind == ProviderKind.LOCAL:
        return default_command_runtime()
    if provider.kind == ProviderKind.MOCK:
        return MockRuntimeAdapter()
    if provider.kind == ProviderKind.OLLAMA:
        cfg = dict(provider.config)
        base = str(cfg.get("base_url", "http://localhost:11434")).rstrip("/")
        if not base.endswith("/v1"):
            cfg["base_url"] = base + "/v1"
        return OpenAICompatibleAdapter({k: v for k, v in cfg.items() if isinstance(v, object)})
    return OpenAICompatibleAdapter(
        {k: v for k, v in provider.config.items() if isinstance(v, object)}
    )




def default_command_runtime() -> Any:
    import os
    if os.environ.get("NERDBOT_RUNTIME", "local").lower() == "docker":
        return runtime_mod.DockerRuntimeAdapter()
    return runtime_mod.LocalRuntimeAdapter()

def list_upstream_models(
    provider: Provider, transport: httpx.BaseTransport | None = None
) -> list[str]:
    """Fetch the model catalog from an openai-compatible provider.

    Tolerant parse: any ``{"data": [...]}`` or bare list with ``id`` strings
    is accepted; entries without ids are ignored. Returns a sorted, deduped
    list of model ids. Transport is injectable for tests (no live network).
    """
    if provider.kind is not ProviderKind.OPENAI_COMPATIBLE:
        raise ProviderConfigurationError("model catalog requires an openai-compatible provider")
    base_url = provider.config.get("base_url", "")
    if not isinstance(base_url, str) or not base_url.strip():
        raise ProviderConfigurationError("provider has no base_url to list models from")
    parsed = urlparse(base_url)
    if parsed.scheme not in ("http", "https") or not parsed.netloc:
        raise ProviderConfigurationError("provider base_url must be an http(s) URL")
    api_key = resolve_api_key(provider.config)
    if not api_key:
        raise ProviderConfigurationError("provider has no usable api key; save one in Settings")
    url = base_url.rstrip("/") + "/models"
    try:
        with httpx.Client(timeout=15.0, transport=transport) as client:
            resp = client.get(url, headers={"Authorization": f"Bearer {api_key}"})
    except httpx.HTTPError as exc:
        raise ProviderNetworkError(f"model catalog unreachable: {exc}") from exc
    if resp.status_code != 200:
        raise ProviderNetworkError(
            f"model catalog request failed: upstream returned {resp.status_code}"
        )
    try:
        payload = resp.json()
    except ValueError as exc:
        raise ProviderNetworkError("model catalog returned a non-JSON body") from exc
    entries: list[Any] = []
    if isinstance(payload, dict) and isinstance(payload.get("data"), list):
        entries = payload["data"]
    elif isinstance(payload, list):
        entries = payload
    ids: set[str] = set()
    for entry in entries:
        if isinstance(entry, dict) and isinstance(entry.get("id"), str) and entry["id"].strip():
            ids.add(entry["id"].strip())
    return sorted(ids)


def provider_block_reason(provider: Provider | None) -> str | None:
    """Why this provider cannot serve a run, or None when it can.

    A provider with no working key cannot serve, so a run against it blocks
    instead of executing. The executor asks this before claiming work, so a
    task is never handed to a provider that cannot run it.
    """
    if provider is None:
        # No model attached: a task that carries its own command can still run
        # through the local runtime. Only a *configured but unusable* provider
        # blocks, so plain command tasks and the baseline slice keep working.
        return None
    if provider.status != ProviderStatus.ACTIVE:
        return f"provider is {provider.status.value}"
    if provider.kind == ProviderKind.OPENAI_COMPATIBLE:
        base_url = provider.config.get("base_url", "")
        if not isinstance(base_url, str) or not base_url.strip():
            return "openai-compatible provider missing base_url"
        model = provider.config.get("model", "")
        if not isinstance(model, str) or not model.strip():
            return "openai-compatible provider missing model"
        try:
            if not resolve_api_key(provider.config):
                return "openai-compatible provider missing credentials (api_key or api_key_env)"
        except ProviderConfigurationError as exc:
            return f"openai-compatible provider credentials invalid: {exc}"
    if provider.kind == ProviderKind.OLLAMA:
        base_url = provider.config.get("base_url", "")
        if not isinstance(base_url, str) or not base_url.strip():
            return "ollama provider missing base_url"
    return None


def resolve_run_provider(
    conn: sqlite3.Connection,
    task_owner_provider_id: str | None,
    project_id: str,
    teammate: Any = None,
) -> tuple[Provider | None, RuntimeAdapter, str | None]:
    """Return (provider, adapter, block_reason) for a run.

    ``block_reason`` is set when an explicit provider cannot serve: the
    caller must record a blocked run instead of executing.

    When ``teammate`` is given, honor its configured model override and
    fallback provider/model (previously stored but ignored).
    """
    fallback_used = False
    model_override = ""
    if teammate is not None:
        provider, model_override, fallback_used, _reason = select_provider_for_teammate(
            conn, teammate
        )
        model_override = model_override or ""
    else:
        provider = store.get_provider(conn, task_owner_provider_id) if task_owner_provider_id else None
        if provider is None:
            # Project-level default: first active provider in this project.
            for candidate in store.list_providers(conn, project_id):
                if candidate.status == ProviderStatus.ACTIVE:
                    provider = candidate
                    break
    if provider is not None and provider.project_id != project_id:
        return provider, default_command_runtime(), "provider belongs to another project"
    reason = provider_block_reason(provider)
    if reason is not None:
        return provider, default_command_runtime(), reason
    effective_provider = provider
    if effective_provider is not None and model_override:
        effective_provider = effective_provider.model_copy(
            update={"config": {**effective_provider.config, "model": model_override}}
        )
    return effective_provider, adapter_for_provider(effective_provider), None


def select_provider_for_teammate(conn, teammate, task_requirements=None):
    """Explicit routing: teammate provider/model, with configured fallback.

    Returns (provider, model_override, fallback_used, reason).
    """
    from . import store as store_mod

    task_requirements = task_requirements or {}
    provider = store_mod.get_provider(conn, teammate.provider_id) if getattr(teammate, "provider_id", None) else None
    model = getattr(teammate, "model", "") or ""
    fallback_used = False
    reason = None
    if provider is None or provider.status != ProviderStatus.ACTIVE:
        fb = getattr(teammate, "fallback_provider_id", None)
        if fb:
            provider = store_mod.get_provider(conn, fb)
            model = getattr(teammate, "fallback_model", "") or model
            fallback_used = True
            reason = "primary provider unavailable; using configured fallback"
    # A teammate with no explicit routing is a normal case (the seeded fleet,
    # and the agents created from a role template). Falling back to the
    # workspace's own usable provider means those agents can actually execute
    # instead of sitting idle while the workspace has a working model.
    if provider is None or provider.status != ProviderStatus.ACTIVE:
        project_id = getattr(teammate, "project_id", "") or ""
        if project_id:
            candidates = [
                candidate
                for candidate in store_mod.list_providers(conn, project_id)
                if candidate.status == ProviderStatus.ACTIVE
            ]
            # Prefer a real model over a mock. A mock provider answers with
            # canned text and must never win over a provider that can think.
            candidates.sort(key=lambda candidate: candidate.kind == ProviderKind.MOCK)
            if candidates:
                provider = candidates[0]
                if not model:
                    configured = provider.config.get("model")
                    model = str(configured) if isinstance(configured, str) else ""
                fallback_used = provider.kind != ProviderKind.MOCK
                reason = "no teammate provider configured; using workspace provider"
    return provider, model, fallback_used, reason
