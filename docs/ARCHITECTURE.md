# NerdBot — Architecture Boundary Document

Phase 1 target state. Defines the eight extension seams and their contracts.
No reference repository is modified. All code lives in `~/nerdbot`.

## Core domain model (standardized before feature migration)

| Entity | Key fields | Identity rule |
|---|---|---|
| Project | id, owner, repository, config | Durable container for teammates, tasks, workspaces |
| Teammate | id, project, persona, instructions, capabilities, memory_scope | Durable identity — survives runs |
| Task | id, project, description, status, owner, dependencies | Owned unit of work; can have multiple runs |
| Run | id, task, runtime, session, status, started_at, finished_at | One execution; retry must not duplicate the task |
| Memory | id, scope, content, source, confidence, timestamp | Provenanced and scoped |
| Artifact | id, task, type, location, verification_status | Attaches to a task |
| Approval | id, run, action, requester, decision | Gates a run action |
| Event | id, project, entity, event_type, timestamp | Project-scoped occurrence |

Hard distinctions:
- Teammate = durable identity
- Run = one execution
- Task can have multiple runs
- Retry must not duplicate tasks
- Memory must have provenance and scope
- Artifacts and tests attach to tasks
- User/chat transcript is not the canonical task log

## Eight extension seams

### 1. Product API
**Owner:** `backend/src/nerdbot/api/`
**Contract:** REST + SSE endpoints for projects, teammates, tasks, runs, artifacts, approvals, events.
**Boundary:** HTTP layer only. No business logic. Delegates to orchestrators and repositories.
**Tech:** FastAPI (Octop convention), SQLModel/Pydantic schemas.

### 2. Teammates
**Owner:** `backend/src/nerdbot/teammates/`
**Contract:** `TeammateRepository` (get/create/update/list by project), `TeammateConfig` (persona, instructions, capabilities, memory_scope, permissions).
**Boundary:** Teammate is data, not code. Configuration stored in DB; assembled server-side each run.
**Tech:** SQLite repo + domain models.

### 3. Orchestrator
**Owner:** `backend/src/nerdbot/orchestrator/`
**Contract:** `create_task`, `schedule_run`, `resolve_dependencies`, `retry_task` (new run, no duplication), `get_task_status`.
**Boundary:** Decides which runs to start, in what order, based on task dependencies. Does not execute code.
**Tech:** In-process scheduler (Octop: APScheduler pattern; nerdbot: simple async scheduler).

### 4. Memory
**Owner:** `backend/src/nerdbot/memory/`
**Contract:** `MemoryRepository` (store/recall by scope), `MemoryEntry` (content, source, confidence, timestamp), fail-closed reads (read error → error, not empty).
**Boundary:** Scoped memory (project/teammate/task). Provenance recorded on every write.
**Tech:** SQLite repo (Octop: octop-memory pattern; nerdbot: native SQLite).

### 5. Runtime adapters
**Owner:** `backend/src/nerdbot/runtime/`
**Contract:** `RuntimeAdapter` interface: `start_run(task, teammate) -> Run`, `poll_run(run_id) -> status`, `stop_run(run_id)`, `get_artifacts(run_id)`. Octop is the initial adapter candidate.
**Boundary:** Provider and workspace integration isolated behind this contract. No runtime leaks into the orchestrator.
**Tech:** Adapter pattern; Octop-backed initial implementation.

### 6. Workspace
**Owner:** `workspace_manager/`
**Contract:** `WorkspaceManager` (create_isolated_workspace(task), get_workspace_path(task), cleanup_workspace(task)). Isolated Git workspaces or equivalent per task.
**Boundary:** File I/O goes through the workspace manager, not directly to disk.
**Tech:** Git workspaces + sandboxed file operations.

### 7. Integrations
**Owner:** `backend/src/nerdbot/integrations/`
**Contract:** MCP/OAuth connectors behind the runtime adapter contract. Config as JSONB on teammate row. Secrets redacted before logs.
**Boundary:** External service access only through adapters; never direct from the API layer.
**Tech:** Adapter implementations; OAuth/MCP deferred to Phase 2+.

### 8. Persistence
**Owner:** `backend/src/nerdbot/persistence/`
**Contract:** `DatabasePool` (SQLite default, PostgreSQL later), schema migrations, repositories for all domain entities.
**Boundary:** Single connection pool; WAL mode for SQLite; all access through repositories.
**Tech:** SQLite (default) + PostgreSQL option (Octop pattern).

## Data flow (Phase 1 slice)

```
User creates Project  →  Product API  →  ProjectRepository (SQLite)
User creates Teammate  →  Product API  →  TeammateRepository (SQLite)
User creates Task      →  Product API  →  TaskRepository + dependency resolution
Orchestrator schedules Run  →  RuntimeAdapter.start_run()  →  Octop-backed execution
Run produces Artifact  →  ArtifactRepository (SQLite)  →  verification status
User reviews result    →  Product API GET /tasks/{id}  →  aggregated view
```

## License and provenance

- Octop (MIT): patterns adapted with attribution; see `docs/provenance/PROVENANCE.md`
- Odysseus (AGPL): concepts only, clean-room TypeScript/Python re-implementation; no code copy
- AI Teammates: reference-only, no code imported

## Quality rules

- All behavior-changing code needs tests
- Test assertions prove actual results, not only mocks
- Security-sensitive code gets targeted tests
- `make test && make lint && make typecheck` must be green before any merge-ready outcome
