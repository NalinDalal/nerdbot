# Current Architecture

Backend: FastAPI + SQLite (store.py), models, providers (OpenAI-compat/local/mock), executor/runs, orchestrator/decomposition/delegation, agent_tools/app_tools, approvals (approval_flow), auth (token), fetch, schedules, notify, metrics, backup, capabilities, permissions, gates, fleet, faces, knowledge, chat, workspace.

Frontend: React+Vite+TS+Tailwind, served by API. api.ts client, types.ts, views-*.tsx, components.tsx, forms.tsx, markdown.tsx.

Tests: 462 backend (pytest) pass; 108 frontend (vitest) pass; ruff/mypy/tsc clean. Baseline recorded 2026-10-23.
