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
from .fetch import FetchProtocolError, FetchTimeoutError
from .models import Provider, ProviderKind, ProviderStatus
from .runtime import (
    BlockedError,
    CancelToken,
    ExecutionError,
    LocalRuntimeAdapter,
    RunCancelled,
    RunResult,
    RuntimeAdapter,
)

DEFAULT_MAX_TURNS = 5
HARD_MAX_TURNS = 10
DEFAULT_REQUEST_TIMEOUT_S = 30.0
MAX_RETRIES = 2
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


class ProviderNetworkError(RuntimeError):
    """Transport-level failure reaching the provider (unreachable / bad body)."""


class ProviderToolError(RuntimeError):
    """A tool call failed repeatedly inside the bounded loop."""


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
    return str(getattr(task, "description", "") or "").strip()


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
        max_turns = self._config.get("max_turns", DEFAULT_MAX_TURNS)
        try:
            max_turns = int(max_turns)
        except (TypeError, ValueError) as exc:
            raise ProviderConfigurationError("max_turns must be an integer") from exc
        max_turns = max(1, min(max_turns, HARD_MAX_TURNS))
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
        deadline = time.monotonic() + timeout_s
        per_call_timeout = min(request_timeout, max(timeout_s / (max_turns + 1), 1.0))
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
        consecutive_failures = 0
        tool_call_corrections = 0
        turns = 0
        client = httpx.Client(
            base_url=base_url,
            timeout=per_call_timeout,
            transport=self._transport,
        )
        try:
            for _ in range(max_turns):
                if time.monotonic() >= deadline:
                    raise ProviderTimeoutError("agent loop wall-clock budget expired")
                if cancel is not None and cancel.cancelled:
                    # The model loop is interruptible between turns: a cancel
                    # request stops the loop instead of waiting for the next
                    # model call to come back.
                    raise RunCancelled(f"run cancelled after {turns} turn(s)")
                turns += 1
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
                message = self._first_message(data)
                transcript.append({"role": "assistant", "content": message.get("content") or ""})
                calls = _parse_tool_calls(message)
                if not calls:
                    text = str(message.get("content") or "").strip()
                    return self._finish(text, transcript, turns)
                for call in calls:
                    if time.monotonic() >= deadline:
                        raise ProviderTimeoutError("agent loop wall-clock budget expired")
                    if cancel is not None and cancel.cancelled:
                        raise RunCancelled(f"run cancelled after {turns} turn(s)")
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
                            raise ProviderToolError(
                                f"{consecutive_failures} consecutive tool failures"
                            ) from exc
                    transcript.append({"role": "tool", "tool": call["name"], "content": result})
                    messages.append(
                        {
                            "role": "tool",
                            "tool_call_id": call["id"],
                            "name": call["name"],
                            "content": agent_tools.frame_tool_result(result),
                        }
                    )
                messages.append(
                    {
                        "role": "assistant",
                        "content": message.get("content"),
                        "tool_calls": message.get("tool_calls"),
                    }
                )
            return self._failed(
                f"max turns exceeded ({max_turns}); no final answer", transcript, turns
            )
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

        if name in app_tools.APP_TOOL_NAMES:
            if context is None or getattr(context, "teammate", None) is None:
                raise ValueError(f"tool {name!r} requires an acting teammate")
            return app_tools.execute_app_tool(
                context,
                name,
                arguments,
                data_dir=getattr(context, "data_dir", "."),
                run_id=getattr(context, "run_id", ""),
                workspace_path=str(workspace),
            )
        return agent_tools.execute_tool(
            workspace,
            name,
            arguments,
            transport=self._transport,
        )

    def _authed_post(
        self,
        client: httpx.Client,
        api_key: str,
        model: str,
        messages: list[dict[str, Any]],
        tools: list[dict[str, Any]] | None = None,
    ) -> dict[str, Any]:
        # Key is attached to single request objects only, never client state.
        last_error: Exception | None = None
        for _ in range(MAX_RETRIES + 1):
            request = client.build_request(
                "POST",
                "/chat/completions",
                json={
                    "model": model,
                    "messages": messages,
                    "tools": tools if tools is not None else agent_tools.tool_schemas(),
                    "tool_choice": "auto",
                },
                headers={"Authorization": f"Bearer {api_key}"},
            )
            try:
                response = client.send(request)
            except httpx.TimeoutException as exc:
                last_error = ProviderTimeoutError(f"provider timed out: {exc}")
                continue
            except httpx.TransportError as exc:
                last_error = ProviderTimeoutError(f"provider unreachable: {exc}")
                continue
            if response.status_code in (401, 403):
                raise ProviderAuthenticationError(
                    f"provider rejected credentials (HTTP {response.status_code})"
                )
            if response.status_code == 429:
                last_error = ProviderRateLimitError("provider rate-limited (HTTP 429)")
                continue
            if response.status_code >= 500:
                last_error = ProviderProtocolError(f"provider error (HTTP {response.status_code})")
                continue
            if response.status_code == 400:
                rejected = _rejected_tool_name(response)
                if rejected is not None:
                    raise ProviderToolCallRejected(
                        f"provider rejected a tool call (HTTP 400){_error_detail(response)}",
                        rejected,
                    )
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
        return LocalRuntimeAdapter()
    if provider.kind == ProviderKind.MOCK:
        return MockRuntimeAdapter()
    return OpenAICompatibleAdapter(
        {k: v for k, v in provider.config.items() if isinstance(v, object)}
    )


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
        return None
    if provider.status != ProviderStatus.ACTIVE:
        return f"provider is {provider.status.value}"
    if provider.kind == ProviderKind.OPENAI_COMPATIBLE:
        base_url = provider.config.get("base_url", "")
        if (
            not isinstance(base_url, str)
            or not base_url.strip()
            or not resolve_api_key(provider.config)
        ):
            return "openai-compatible provider not configured"
    return None


def resolve_run_provider(
    conn: sqlite3.Connection, task_owner_provider_id: str | None, project_id: str
) -> tuple[Provider | None, RuntimeAdapter, str | None]:
    """Return (provider, adapter, block_reason) for a run.

    ``block_reason`` is set when an explicit provider cannot serve: the
    caller must record a blocked run instead of executing.
    """
    provider = store.get_provider(conn, task_owner_provider_id) if task_owner_provider_id else None
    if provider is not None and provider.project_id != project_id:
        return provider, LocalRuntimeAdapter(), "provider belongs to another project"
    reason = provider_block_reason(provider)
    if reason is not None:
        return provider, LocalRuntimeAdapter(), reason
    return provider, adapter_for_provider(provider), None
