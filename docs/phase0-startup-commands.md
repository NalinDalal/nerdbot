# Phase 0 — Startup Commands, Configs, Licenses, Dependency Inventories

## Octop (`~/octop`) — MIT

**Primary workflow:** `nerdbot run` — single-process FastAPI/uvicorn serving Web dashboard, CLI, IM channels, cron. Data under `~/.nerdbot/`.

| Item | Value |
|---|---|
| Language | Python 3.12+ |
| Package manager | uv (isolated venv under `~/.nerdbot/venv`) |
| Build backend | hatchling |
| Web framework | FastAPI + uvicorn |
| Agent runtime | octop-harness (LangGraph-based) |
| Control-plane DB | SQLite (WAL, default) or PostgreSQL |
| Frontend | React 18 + TypeScript + Vite + Ant Design |
| Scheduling | APScheduler |
| Lint/type/test | ruff + mypy + pytest |
| Config file | `~/.nerdbot/config.json` |
| Env vars | `NERDBOT_PORT`, `NERDBOT_DATABASE_URL`, `NERDBOT_DEFAULT_PASSWORD`, `NERDBOT_DATA`, etc. |
| Startup | `nerdbot init` (bootstrap DB/admin/JWT), then `nerdbot run` (port 8088) |
| Dev commands | `make install`, `make test`, `make lint`, `make typecheck`, `make format`, `make all` |
| Key deps | fastapi, uvicorn, pydantic, langchain-core, click, rich, questionary, apscheduler, argon2-cffi, pyjwt, octop-harness[all], octop-memory, octop-gateway, octop-browser, cryptography, mcp, psycopg[binary], playwright, boto3, edge-tts, websockets |

**License file:** `~/octop/LICENSE` — MIT, Copyright (c) 2026 NerdBot. Attribution required if code reused.

## Odysseus (`~/odysseus`) — AGPL-3.0-or-later (DO NOT COPY IMPLEMENTATION CODE)

**Primary workflow:** `docker compose up -d --build`, then open `http://localhost:7011`.

| Item | Value |
|---|---|
| Language | Python (FastAPI) + TypeScript frontend |
| Package manager | pip + npm |
| Web framework | FastAPI + uvicorn |
| Persistence | SQLAlchemy + SQLite (`app.db` under `DATA_DIR`), ChromaDB for vectors |
| Agent loop | 38k-line ReAct loop (`src/agent_loop.py`) |
| Frontend | vanilla ES-module SPA (`static/`) |
| Config | `.env` copied from `.env.example` |
| Startup | `cp .env.example .env && docker compose up -d --build` |
| Native | `python app.py` |
| Key deps | fastapi, uvicorn, httpx, httpcore, pydantic, SQLAlchemy, pypdf, Pillow, faster-whisper, pdfplumber, beautifulsoup4, chromadb-client, fastembed, markdown, nh3, icalendar, python-dateutil, caldav, cryptography, bcrypt, mcp<2, pyotp, qrcode[pil], croniter, pytest, pytest-asyncio, httpx2 |

**License file:** `~/odysseus/LICENSE` — GNU AGPL v3. **No implementation code may be copied or imported.** Patterns may be re-implemented clean-room in TypeScript.

## AI Teammates (`~/ai-teammates`) — Reference-only, no LICENSE

**Primary workflow:** `npm install && docker compose up -d && npm run db:push && npm run dev` (Next.js on :3000) + `npx trigger.dev@4.7.3 dev` (terminal 2).

| Item | Value |
|---|---|
| Language | TypeScript (Next.js 16 + React 19 + AI SDK 7) |
| Package manager | npm |
| Agent runtime | Trigger.dev `chat.agent` (durable hosted runs) |
| Sandbox | Daytona per-bot Linux sandbox (shell + noVNC desktop) |
| ORM/DB | Drizzle ORM + Postgres (`db:push`, no migrations) |
| Auth | Custom scrypt + session cookie |
| Observability | Sentry |
| Config | `.env.local` (from `.env.example`) |
| Startup | `npm install`, `docker compose up -d`, `npx trigger.dev@4.7.3 login`, `npm run db:push`, `npm run dev`, `npx trigger.dev@4.7.3 dev` |
| Key deps | next, react, react-dom, ai, @ai-sdk/openai-compatible, @trigger.dev/sdk, @trigger.dev/build, drizzle-orm, drizzle-zod, pg, zod, nanoid, motion, lucide-react, shadcn/ui components, @sentry/nextjs, @sentry/node |

**License:** No LICENSE file present in repo. Treat as reference-only until licensing resolved. Do not import code.

## NerdBot Audit (`~/nerdbot-audit`) — Read-only reports

| File | Purpose |
|---|---|
| `final-architecture.md` | Proposed architecture decision summary, capability matrix, risks, Q1–Q6 |
| `octop.md` | Octop vs AI Teammates capability audit, reusable capabilities ranked P0–P2 |
| `odysseus.md` | Odysseus architecture review vs AI Teammates |
| `implementation-roadmap.md` | 10-phase dependency-aware roadmap, security gates G1–G3 |
| `gpt-brief.md` | Brief: synthesize best of all three codebases |

Not a git repository. No commits to pin.
