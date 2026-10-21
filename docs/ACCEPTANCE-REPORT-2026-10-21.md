# NerdBot — Real Acceptance Report (2026-10-21)

Ran against the real application (`nerdbot run` → `http://localhost:8080`,
token-gated), a disposable DB/data dir under the system temp dir (the
operator's real workspace was never touched), a real provider: **Ollama
serving locally-stored real model weights** (`llama3.2:3b`, then
`qwen3:4b`) configured through the product's BYOK provider flow. UI
interactions were driven in a real headless Chromium (Playwright). Screens:
`ui-01…ui-14*.png` captured in the acceptance temp dir.

Where a capability depends on an external service, the failure is reported
BLOCKED with the real error, never papered over.

## Results

| Capability | Result | Actual test performed | Evidence of real execution | Failure / limitation | Required fix |
|---|---|---|---|---|---|
| Personal assistant: conversation | **PASS** | Created thread in UI, 3 turns through `POST /threads/{id}/chat` + `/chat/stream` (real model) | Transcript in `thr_2e06d9f707c2` (`msg_f579…`, `msg_3c82…`); streamed SSE chunks; reply cites project facts | 60s `CHAT_TIMEOUT_S` too small for slow local models on non-stream path (one 502 "chat timed out") | Make chat timeout provider-derived or env-configurable |
| Personal assistant: context retention | **PASS** | Referenced its own previous answer in a follow-up turn | Reply: "My previous answer stated I cannot access your active projects, files, or workspace." | — | — |
| Personal assistant: grounded answers | **PASS** (with quality caveat) | Wrote project memory via `/memory`; asked to summarize | Reply cited the `calc.py` bug verbatim from the UNTRUSTED frame; `memory_used` provenance returned | Small local model contradicts itself mid-reply; knowledge chunks (KB store) are NOT wired into chat — only memory + thread summaries | Wire `knowledge.read` recall into the chat prompt builder |
| Personal assistant: performs actions from chat | **FAIL** | Asked chat to act/plan/create; inspected `chat.py` ("No tools here") and `views-chat.tsx` (threads/stream/summarize/provider-select only) | Agent tools exist and work (see tool execution row) but are unreachable from the assistant surface | A chat that cannot create a task/note/train cannot be a personal assistant | Expose the existing agent tool loop (or at minimum create-task/create-note) on the chat surface, keeping approval gates |
| Personal assistant: web research | **BLOCKED** | `web_search("python addition operator")` from the running app | Tool returned an honest failure: `SearchProviderError: search provider failed: unexpected status (HTTP 202)`; DDG Lite now serves an anti-bot challenge (no `uddg` links in the body) | Integration is external and today broken | Pluggable search provider (e.g. SearXNG / API-based), keeping the fail-loud behavior |
| Workspace access: shared project | **PASS** | Owner seeded the same real files (`shared-src/`) into `tsk_099dafc3c2b9` and `tsk_b4a5030c1fa4`; bot read `src/calc.py`; human read it back via `/workspace/file?path=src/calc.py` | Bot's reply and human curl both saw `return a - b  # BUG` pre-fix; same content, same project metadata | Child (delegated) workspaces start empty unless the parent passes content in the instruction — by design (isolated checkouts); improvement noted | Optional: owner-visible "seed child workspace" action |
| Workspace access: isolation | **PASS** | Per-task Git workspaces verified for 3 tasks; `git branch nb/<task>`; diff/patch via API | `patch-run_a8d4d3d59ec6.diff` (230 chars, files_changed=1) | Model replaced the whole file rather than editing (model quality, not safety) | — |
| Workspace access: boundary enforcement | **PASS** | Acting-header bot (Researcher) tried to read another project's board | Live 403: `"acting teammate belongs to another project"`; board *creation* by that bot was also refused (permission gate) | — | — |
| Persistent bots | **PASS** | Researcher/Engineer/Coordinator survived 6 server restarts with personas, permissions, provider attachments; re-invoked repeatedly (`POST /runs` ×3 on Engineer's task) | Same IDs (`tm_4ad29574…`, `tm_70bd7a9…`, `tm_e940ac…`) resolving across restarts; `provider_id` attached via `PATCH /teammates` persisted | Task owners without an attached provider silently fall back to the local shell adapter — a natural-language instruction was executed as `sh -c` (failed loudly, exit 2) | Refuse-with-error or prompt instead of raw shell for non-shell instructions on the local adapter; auto-attach provider in bot creation UI |
| Persistent memory | **PASS** (project scope) | Wrote project memory before a restart; recall still grounded post-restart | Chat reply cited memory twice across restarts; `memory_used` provenance ids | Bot-scope durable memory exercised in repo tests (`store.recall_memory`), not in the live run | — |
| Tool execution | **PASS** | Engineer's agent loop with `read_file`/`write_file` against the real model | `transcript-run_a8d4d3d59ec6.json`: turn 2 tool call → `"wrote 27 bytes to 'src/calc.py'"`; the file on disk really changed | Local models often end the loop with an empty final message ("(empty final answer)") — work is done and captured, but the summary is lost | One follow-up "final answer" turn when the loop ends post-tool with empty content |
| Bot collaboration (model-driven delegation) | **PARTIAL** | Coordinator agent run: first attempt emitted pseudo-JSON as text (no tool channel); retry with terse instruction → **real `delegate_task` tool call** → child task `tsk_72facd026e2c` + pending delegation `del_e4c3e7ef16e5` | Transcript `run_bf7e61e8523c` (fail) vs `run_ac283926961d` (real tool call); delegation row in `/delegations` | 3B local model is unreliable at complex multi-tool orchestration; the loop also stops with empty content | None imposed (product works with capable providers); optional empty-answer follow-up turn |
| Bot collaboration (human-driven handoff, child executes for real) | **PASS** | Owner accepted the pending delegation on the Engineer's behalf (dashboard endpoint) → `POST /executor/sweep` ran the child with its own agent loop → delegation `completed`, result flowed back to the parent; parent's next run read it via `check_delegations` | Sweep result: `{'task_id':'tsk_72facd026e2c','status':'succeeded','delegation_id':'del_e4c3e7ef16e5','exit_code':0}`; delegation row `completed`; parent transcript shows the real record; child's own workspace contains the fix | — | — |
| Git changes visible to human | **PASS** | Captured patch artifact; read diff and file via the API and the UI workspace panel | `art_6b4e7c5637c1`; `GET /workspace/diff` shows the real `git diff` (+`def add(a, b): return a + b`) | — | — |
| Results consumed across bots | **PASS** | Parent (`check_delegations`) returned the completed delegation and result; artifact + patch transferable | Transcript `run_49d370196696` tool result | — | — |
| Approvals | **PASS** | `POST /runs/{id}/approvals {action:"deploy"}` → pending → approved → re-decide refused | `apr_1d3d74971a9f approved deploy`; `"already decided (one-use)"` on second decision | — | — |
| Rejection / cancellation / timeouts / bounded retries | **PASS** | Declined delegation `del_728237fd0f71` → child `tsk_08bc6f83a7ab` stayed BLOCKED; cancelled owner-follow-up `del_5c5ab158fc17`; bounded retry created attempt 2 (`tsk_0a25516d0102`); delegation deadlines (15 min) enforced by `expire_overdue` in await/check paths | Delegation tree in the UI shows `completed / declined→blocked / cancelled→blocked` side by side | — | — |
| Run/plan cancellation & interruption | **PASS** | Task cancellation cancels pending handoffs (live: poisoned children blocked); terminal runs refuse re-runs | Repo suite: `test_dashboard_flow_contract.py`, `test_ghost_run_leak.py` | Run *interruption* mid-model-loop is not exposed (runs are synchronous) | Document or add an async execution mode for long runs |
| UI integration (browser-driven) | **PASS** after fix | Headless Chromium: login, workstation, project, chat send/stream, task detail (runs, handoffs table, delegation tree, workspace browser, artifacts), zero page errors, zero 5xx | Screenshots `ui-01…ui-14`; DOM text captures in the transcript above | At first run the Connect screen defaulted the API base to `127.0.0.1:8080` while served from `localhost:8080` → hardcoded CORS failures ("Network error") | FIXED this session: same-origin default (`app.tsx` `defaultApiBase`) + test |
| Frontend/backend serving as documented | **PASS** | `nerdbot run` on :8080 serves `/health`, the built dashboard `index.html`, and assets (465KB bundle, 200) | `curl` evidence above; browser flow | README documents `uv run nerdbot run`; the active repo venv path is `.venv/bin/nerdbot run` (equivalent) | — |

## Bugs found by acceptance testing and fixed this session

1. **Ghost run leak** — `POST /tasks/{id}/runs` on a `done` task created a
   run row, then failed the status transition (400 to the client) but left a
   permanent `running`-marked row. Fixed in `orchestrator.schedule_run`
   (refuse before `create_run`); pinned by `tests/test_ghost_run_leak.py`
   (2 tests).
2. **Fixed 60s run wall clock** — every slow-provider run died with
   `provider timed out` (`per_call = 60/(max_turns+1) ≈ 5s`). Added
   `NERDBOT_RUN_TIMEOUT_S` shared by the run endpoint, retries, executor
   sweeps, and delegation-resume (`api.py`, `executor.py`, `app_tools.py`);
   pinned by `tests/test_run_timeout_knob.py` (5 tests); README documents it.
3. **UI CORS / wrong API base default** — dashboard served at
   `localhost:8080` defaulted to `127.0.0.1:8080` → every fetch CORS-blocked.
   Fixed with same-origin default + `defaultApiBase` exported and tested
   (`app.connect.test.ts`, 2 tests).
4. **SQLite cross-thread crash under load** — the live server 500'd on
   `GET /projects/{id}/runs` and `/teammates/{id}/tasks`
   (`sqlite3.ProgrammingError: SQLite objects created in a thread…`): the
   sync dependency and sync endpoint ran in different threadpool threads.
   Fixed with `check_same_thread=False` on per-request connections
   (`store.connect`), verified by concurrent live requests returning 200.

## Current gates (after fixes)

- Backend: `pytest 351 passed` · `ruff` clean · `mypy` clean (33 files)
- Dashboard: `vitest 42 passed` · `tsc --noEmit` clean · `vite build` OK

## Top three consequential gaps

1. **The assistant's chat surface cannot act.** Tools, workspace, tasks and
   memory all exist, but a human chatting is limited to text.
   *Smallest plan:* add a `create_task` / `create_note` action row to the
   chat reply (frontend) + a chat-side minimal action endpoint reusing
   `store.create_task`; later, mount the full agent tool loop on threads.
   *Proving tests:* a chat thread that creates a task end-to-end (HTTP test
   + `test_dashboard_flow_contract.py`-style assertions).
2. **Real-model execution quality: runs end with empty final answers, and
   the local shell adapter can execute natural-language commands as shell.**
   *Smallest plan:* (a) one "final answer" follow-up turn in
   `providers.OpenAICompatibleAdapter` when the last turn is tool-result-only
   with empty content; (b) the local adapter treats non-command-shaped
   instructions as a blocked run with an explanatory message.
   *Proving tests:* scripted-transport test that the follow-up turn is
   requested and recorded; a test that a sentence-like command on the local
   adapter is blocked with guidance instead of `sh -c`.
3. **Web research depends on one scrapable endpoint that is now broken**
   (DDG Lite serves an anti-bot 202). *Smallest plan:* provider-configurable
   search backend (SearXNG/Brave/OpenAI-compatible) with the same fail-loud
   error path. *Proving tests:* stubbed transport search returning results;
   live skipe test remains BLOCKED until credentials/config exist.

## Capabilities requiring external configuration

- A hosted OpenAI-compatible provider (or larger local model) for reliable
  multi-tool orchestration — 3B models demonstrably half-work.
- `NERDBOT_SECRET_KEY` for encrypted API keys in production
  (`keyless` mode works only for no-secret providers).
- A working search backend for `web_search` (external integration).
- `OLLAMA_KEY`-style `api_key_env` entries for credential-less local
  endpoints (what this run used).
