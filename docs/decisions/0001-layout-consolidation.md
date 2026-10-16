# 0001 — Single implementation under `backend/src/nerdbot`

Date: 2026-10-16. Status: accepted.

## Context

Two parallel scaffolding efforts landed in `~/nerdbot` at the same time:

- `backend/src/nerdbot/` — flat modules (`models`, `store`, `auth`,
  `workspace`, `runtime`, `orchestrator`, `api`, `cli`) with token auth,
  guardrailed local runtime adapter, and 8 passing tests.
- Top-level `nerdbot/` + `workspace_manager/` + `api/` + `persistence/`
  packages — a second implementation with a different API contract
  (auth disabled when token empty, different routes/status codes).

Both a `nerdbot.py`-style module and a `nerdbot/` package cannot coexist:
`import nerdbot.*` resolution becomes directory-dependent and no test run
can be trusted.

## Decision

Canonical: `backend/src/nerdbot/` (installed as the `nerdbot` distribution
via `pyproject.toml`, `packages = ["backend/src/nerdbot"]`).

Removed: top-level `nerdbot/` package, `api/` and `persistence/` shadow
packages, `domain.py`/`persistence.py`/service-package stubs,
`workspace_manager/*.py` (broken import), `tests/integration/test_api.py`
(tested only the removed contract), and the other effort's `cli/main.py`
(imported deleted modules). `workspace_manager/` and `dashboard/` remain
as empty seam placeholders per `ARCHITECTURE.md`.

## Rationale

- The kept tree is the only one with tests proving the Phase 1 slice,
  strict bearer-token auth (Phase 1 exit requirement), typed
  policy-vs-execution failures, untrusted-output framing, fail-closed
  memory reads, and retry-without-duplication.
- `ruff check`, `mypy --strict`, and `pytest` are all green on the kept tree.
- A live `nerdbot run` server executed project → teammate → task → run →
  artifact end-to-end (observed, exit 0, artifact `passed`).

## Consequences

- Package split (`teammates/`, `orchestrator/`, `memory/`, `runtime/`
  subpackages) is deferred until the flat modules outgrow one file each.
- `PROVENANCE.md` "nerdbot location" column still names planned package
  paths; treat this record as the mapping to actual flat-module paths
  until provenance is updated.
