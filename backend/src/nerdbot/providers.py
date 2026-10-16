"""Provider adapters: dispatch model-provider choice to a runtime.

- ``local``: the proven in-workspace shell adapter (existing behavior).
- ``mock``: deterministic canned output; executes nothing. Safe for tests
  and capability demos.
- ``openai-compatible``: stub. Refuses without credentials and is not
  executed in this phase even with credentials present.

Provider choice is recorded on every run (``run.provider_id``) and audited.
"""

from __future__ import annotations

import sqlite3
from pathlib import Path

from . import store
from .models import Provider, ProviderKind, ProviderStatus
from .runtime import LocalRuntimeAdapter, RunResult, RuntimeAdapter


class ProviderNotConfiguredError(RuntimeError):
    """A stub or misconfigured provider was asked to execute."""


class MockRuntimeAdapter:
    """Deterministic stand-in: records intent, runs nothing."""

    name = "mock"

    def start_run(self, command: str, workspace: Path, timeout_s: float = 60.0) -> RunResult:
        _ = (workspace, timeout_s)
        if not command.strip():
            from .runtime import ExecutionError

            raise ExecutionError("empty command")
        output = f"[mock provider] would execute: {command.strip()}"
        return RunResult(exit_code=0, output=output, stdout=output, stderr="")


class OpenAICompatibleAdapter:
    """Stub for a future credential-backed provider. Never executes here."""

    name = "openai-compatible"

    def __init__(self, config: dict[str, object] | None = None) -> None:
        self._config = config or {}

    def start_run(self, command: str, workspace: Path, timeout_s: float = 60.0) -> RunResult:
        _ = (command, workspace, timeout_s)
        if not self._config.get("api_key") or not self._config.get("base_url"):
            raise ProviderNotConfiguredError(
                "openai-compatible provider needs base_url and api_key; execution deferred"
            )
        raise ProviderNotConfiguredError(
            "openai-compatible execution is deferred to a future phase"
        )


def adapter_for_provider(provider: Provider | None) -> RuntimeAdapter:
    """Resolve the runtime adapter for a provider (None = default local)."""
    if provider is None or provider.kind == ProviderKind.LOCAL:
        return LocalRuntimeAdapter()
    if provider.kind == ProviderKind.MOCK:
        return MockRuntimeAdapter()
    return OpenAICompatibleAdapter(
        {k: v for k, v in provider.config.items() if isinstance(v, object)}
    )


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
    if provider is not None and provider.status != ProviderStatus.ACTIVE:
        return provider, LocalRuntimeAdapter(), f"provider is {provider.status.value}"
    if provider is not None and provider.kind == ProviderKind.OPENAI_COMPATIBLE:
        return provider, LocalRuntimeAdapter(), "openai-compatible provider is a stub"
    return provider, adapter_for_provider(provider), None
