# 0005 — Real Provider Execution via Bounded Agent Loop (Phase 1)

Date: 2026-10-16. Status: accepted and implemented.

## Context

`RuntimeAdapter.start_run` was single-shot; `openai-compatible` was a
refusal stub. A real model call needs multi-turn tool use, but nothing in
the product required a general agent framework first.

## Decisions

1. **One provider kind, one protocol.** `OPENAI_COMPATIBLE` over
   `/chat/completions` with function tools. No provider framework.
2. **Loop lives inside the adapter** (`OpenAICompatibleAdapter`), keeping
   `RuntimeAdapter` and the orchestrator unchanged. Bounds: `max_turns`
   default 5, hard cap 10; 3 consecutive tool failures; per-call timeout
   derived from the task timeout; wall-clock deadline; 4000-char tool
   output cap. Max-turn exhaustion is FAILED, never partial success.
3. **Three workspace-only tools** (`agent_tools.py`): `run_command`
   (reuses `check_command`), `read_file`, `write_file` (strict
   workspace containment). Tool results framed untrusted before the model.
4. **Credential custody:** `api_key` inline or `api_key_env` naming a
   process env var (preferred); key attached to single request objects
   only, never client state, transcripts, artifacts, events, or logs.
   Stored config remains plaintext SQLite (known limitation, M5 follow-up).
5. **Typed errors** map to run outcomes: configuration/auth → BLOCKED,
   rate-limit/timeout/protocol/tool-exhaustion → FAILED with explicit text.
   Retries: 1 + 2 for transport errors and 429/5xx only.
6. **Tests use `httpx.MockTransport`**, never live paid calls. Live proof
   uses a localhost stub server.
7. **Corrections to the design note:** `db/schema.ts` plaintext keys are the
   AI Teammates reference, not NerdBot; NerdBot redacts secrets at API and
   backup output (kept). `lib/model.ts` is reference UI, not backend runtime.

## Consequences

- `httpx` promoted from dev to runtime dependency (already locked).
- `provider.openai-compatible` capability is `ready` (credential-gated).
- Unconfigured providers still record blocked runs; no silent fallback.
- Transcript artifacts (`transcript-<run>.json`) expose model/tool usage.
