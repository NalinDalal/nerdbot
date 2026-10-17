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
4. **Residual closed:** TOCTOU rebinding window eliminated via
   `fetch.PinnedTransport` — single connection-time resolution (all
   addresses must pass policy), TCP to the first address only, SNI/Host
   preserved, default TLS verification intact, every redirect hop
   re-pinned. Shared by `fetch_url`, webhook delivery, and GitHub fetch.
5. **Wall-clock budgets enforced.** Audit found per-connection timeouts
   alone cannot bound a fetch: a dribbling (slowloris) server stays inside
   every individual socket op. Two deadlines added with an injectable
   clock: per-exchange read deadline in `_socket_roundtrip` (fires even
   when each op is legal — also protects webhook/GitHub delivery), and a
   whole-fetch budget of `timeout_s × (max_redirects + 1)` checked before
   each redirect hop. IPv4-mapped IPv6 (`::ffff:10.0.0.x`) is now
   unwrapped explicitly before classification instead of relying on
   version-dependent stdlib semantics. Non-canonical IPv4 encodings
   (hex/decimal/octal prefixes) normalize at resolution and are blocked by
   the all-pass rule; pinned by tests.

## Consequences

- Model can now call `fetch_url` within existing turn/timeout budgets.
- `tools.fetch_url` capability is `ready`; web search (ranking/snippets)
  remains absent — this is fetch-only, not search. A bounded, credential-
  free search provider is the remaining Phase 3 item and needs an owner
  decision (e.g. DuckDuckGo HTML/lite endpoint through the same
  `PinnedTransport` + policy, bounded result count, no credentials, typed
  errors for provider failures/rate limits) before Phase 4 slices start.
- Known accepted limitations (documented, fail-safe): no content-type
  filter (binary is bounded-text-decoded); zone-ID IPv6 literals fail
  closed via resolver/protocol errors rather than an explicit allowlist.
