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
6. **`search.py`: credential-free DuckDuckGo Lite search** (owner-selected
   2026-10-17). `GET https://lite.duckduckgo.com/lite/?q=<urlencoded query>`:
   rides `fetch.fetch_url_text` (pinned transport, bounded budget, no
   credentials/cookies ever sent); defensive HTMLParser for result rows
   (max 5 default, hard cap 10, ≤400-char query); `uddg` redirect wrappers
   unwrapped; typed `SearchProviderError` for rate limits (HTTP 429 via
   `FetchProtocolError.status`), provider failures, and timeouts; empty
   result pages are valid zero results, never fabricated. Tool contract
   identical to `fetch_url`: bounded output, untrusted framing in the loop.
7. **Post-review fixes** (OpenCode security review, 2026-10-17):
   - `SearchProviderError` re-parented to `ValueError` so the agent loop
     treats rate limits/failures as recoverable tool error text instead of
     aborting the run (loop-level test proves a 429 completes the run).
   - NAT64 (`64:ff9b::/96`) and 6to4 (`2002::/16`) embedded IPv4 targets
     are classified by their IPv4 half; trailing-dot FQDNs are normalized
     before the local-host gate; DDG unwrap requires exact host match.
   - Response header block capped (`HEADERS_MAX_BYTES` = 128KB) in the
     pinned path — per-line caps exist in http.client, total cap added.
   - Whole-fetch budget re-checked AFTER each response, so budget
     expiration during the final response still aborts the fetch.
   - Accepted residual (documented): DNS resolution time itself remains
     outside the wall-clock budget (`getaddrinfo` has no deadline on this
     platform); worst-case total overshoot ≈ one resolver timeout × hops
     plus one in-flight exchange. Direction considered; not implementable
     portably without a thread-pool resolver — revisit only if needed.

## Consequences

- Model can now call `fetch_url` and `web_search` within existing
  turn/timeout budgets; `tools.web_search` is capability `ready`.
- Known accepted limitations (documented, fail-safe): no content-type
  filter (binary is bounded-text-decoded); zone-ID IPv6 literals fail
  closed via resolver/protocol errors rather than an explicit allowlist;
  the Lite HTML structure assumption is defensive — a page that parses to
  zero anchors is a legitimate empty search, never a fabricated success.
