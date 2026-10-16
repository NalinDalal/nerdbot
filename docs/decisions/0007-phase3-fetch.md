# 0007 — Hardened Web-Fetch Tool for the Agent Loop (Phase 3)

Date: 2026-10-16. Status: accepted and implemented.

## Context

The agent loop could only touch the workspace. Web research needed one
fetch primitive with SSRF protections designed and tested before any
network access.

## Decisions

1. **`fetch.py` with default-deny SSRF policy.** http/https only, no
   userinfo, localhost/local-suffix hostnames rejected, literal IPs must
   be globally public (covers cloud metadata ranges), every resolved
   address must be public (all-pass against DNS rebinding), redirects
   followed manually (max 3) with each hop re-validated, 1MB/15s caps,
   no Authorization headers, cookies, or credentials ever attached.
2. **Same tool contract** (`agent_tools.execute_tool` + `tool_schemas`):
   bounded output, untrusted framing, typed errors (`FetchBlockedError`,
   `FetchTooLargeError`, `FetchTimeoutError`, `FetchProtocolError`).
   Fetch failures inside the loop are tool-error text (recoverable);
   three consecutive failures end the run.
3. **Tests use `httpx.MockTransport` + fake resolver only.** No live
   network in the suite.
4. **Known residual risk:** pre-request DNS validation with a separate
   connect-time resolution leaves a TOCTOU rebinding window. Accepted
   because no secrets or credentials are ever forwarded, bounding impact
   to plain-HTTP reads; a pinning transport is tracked follow-up work.

## Consequences

- Model can now call `fetch_url` within existing turn/timeout budgets.
- `tools.fetch_url` capability is `ready`; web search (ranking/snippets)
  remains absent — this is fetch-only, not search.
