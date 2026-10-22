# 0014 — A Task Runs on Its Description, and a Bad Tool Call Is Not a Dead Run

Date: 2026-10-23. Status: accepted and implemented.

## Context

The first bot task created from the dashboard could not run. Three separate
gaps showed up in one attempt, and each one was ours:

1. **The task had no prompt.** `schedule_run` hands `task.command` to the
   adapter, and the model adapter treats it as the user message. The dashboard
   has no command field: `POST /projects/{id}/tasks` sends a description and an
   owner. So every task created in the UI reached the model adapter with an
   empty command and failed with `empty command`. The flow looked wired and was
   not.
2. **The retry budget was spent by runs that never ran.** Six runs were
   `blocked` because the provider had no key. `retry_task` counted every run,
   so after the key was fixed the task was refused with `retry limit reached`
   without a single real attempt.
3. **A hallucinated tool name killed the run.** Groq validates tool calls
   against `request.tools` and answers HTTP 400 `tool_use_failed` when a model
   names something that was not offered. The adapter only saw "unexpected
   provider status (HTTP 400)" and failed the run. The model had read
   `persona.read_catalog` in its standing instructions and called it; the
   teammate had no permission for it, so it was correctly absent from the tool
   schemas. The model's mistake was real, but it was recoverable.

## The decision

**A model adapter reads the description when there is no command.** `_prompt_text`
prefers `command`, then falls back to `context.task.description`. Only
model-shaped adapters (openai-compatible, mock) do this. The shell runtime keeps
rejecting an empty command, so prose is never handed to `sh -c`; a description
is an instruction, not a script.

**A blocked run is not an attempt.** `retry_task` counts only runs whose status
is not `blocked`. A blocked run never started work: the owner was inactive, a
dependency was missing, the provider was not configured. The documented intent
was already that blocked tasks may be retried, and counting the blocked runs
against the cap made that allowance useless in exactly the case it exists for.
Real failures, successes, stops and cancels still count.

**A rejected tool call is corrected, not fatal.** When a provider answers 400
with `code: tool_use_failed`, the adapter raises `ProviderToolCallRejected` with
the attempted name. The loop appends a user message naming the tools that do
exist and continues, at most twice; a third rejection fails the run explicitly.
A model that keeps inventing tools cannot loop forever.

**Provider error bodies are quoted, bounded.** A bare `HTTP 400` cannot be
acted on. `_error_detail` appends up to 300 characters of the response body to
the protocol error, so a run excerpt says *why* the provider refused.

## Consequences

- The dashboard's task form needs no new field. Existing tasks with no command
  become runnable without a data migration.
- Retry accounting now distinguishes "the environment was wrong" from "the work
  failed". A task that fails ten times is still capped.
- The correction message is visible in the transcript artifact, so a run that
  recovered from a bad tool call is auditable rather than silently patched up.
- Provider bodies are quoted, not trusted: they are bounds-checked and length
  capped, and they never include request headers or the credential.
