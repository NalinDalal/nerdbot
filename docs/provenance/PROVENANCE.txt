# Provenance — Adopted Ideas and Code Sources

This file records every idea, pattern, or code fragment adopted from reference repositories, per the license requirements. No reference repository has been modified. Work occurs only in `~/nerdbot`.

## Reference repositories (pinned)

| Repository | Path | Commit SHA | License | Use policy |
|---|---|---|---|---|
| Octop | `~/octop` | `ecec9f7017b42a5cbdd9fcfae7851effc387374c` | MIT | Reuse with attribution |
| Odysseus | `~/odysseus` | `c3819e3cbf56c4f899eacc66b21115a77d9c570d` | AGPL-3.0-or-later | Concepts only; clean-room re-implementation; no code copy |
| AI Teammates | `~/ai-teammates` | `6bea24c7a043dea100bed930f8bbc6da1e14e43a` | None present | Reference-only; do not import code |
| NerdBot Audit | `~/nerdbot-audit` | N/A (not a git repo) | N/A | Read-only reports |

## Adoption log (to be filled as code is written)

| # | Idea / pattern | Source | File / location | License | Action (copy / adapt / build) | Attribution required? | nerdbot location |
|---|---|---|---|---|---|---|---|
| 1 | Persisted handoff chain in message metadata | Octop `infra/agents/teams/handoff_guard.py` | `teams/handoff_guard.py:23-34,80-122` | MIT | Adapt | If copied verbatim; none if rewritten | `backend/orchestrator/` |
| 2 | Tool guardrail rule semantics (`rm -rf`, fork bombs, `curl\|sh`, metadata IPs) | Octop `infra/agents/security/tool_guard_rules.py` + YAML rules | MIT | Adapt as TS list | If copied verbatim; none if re-expressed | `backend/runtime/` |
| 3 | Cron tool-description grammar (NL scheduling via tool descriptions) | Octop `infra/cron/tools.py:26-49` | MIT | Adapt | None if rewritten | `backend/orchestrator/` |
| 4 | Citation-marker trick (`<!--…-citations:…-->`) | Octop `infra/knowledge/citations.py:10-62` | MIT | Adapt | None | `backend/workspace/` |
| 5 | `thread_messages` display projection separate from checkpoint | Octop `infra/history/{recorder,projection}.py` | MIT | Adapt | None | `backend/persistence/` |
| 6 | Login lockout 5/900s | Octop `config.py:130-131` | MIT | Adapt | None | `backend/auth/` |
| 7 | MCP config fingerprint caching + redaction | Octop `infra/connectors/mcp_tool_cache.py`, `crypto.py` | MIT | Adapt | None | `backend/integrations/` |
| 8 | Typed tool-failure union (`{ok} | {blocked,kind} | {error}`) | Odysseus `src/tool_execution.py` | AGPL | Adapt clean-room | None (no copied material) | `backend/runtime/` |
| 9 | Untrusted-context framing (`<<<UNTRUSTED_SOURCE_DATA>>>`) | Odysseus `src/prompt_security.py:30-34` | AGPL | Adapt clean-room | None (no copied material) | `backend/runtime/` |
| 10 | SSRF-guarded fetch (DNS pinning, redirect validation, size budgets) | Odysseus `src/outbound_fetch.py`, `src/url_security.py` | AGPL | Adapt clean-room | None (no copied material) | `backend/integrations/` |
| 11 | Sealed approvals (owner/session/run/digest binding, TTL) | Odysseus `src/tool_approvals.py:38,97,315-350` | AGPL | Adapt clean-room | None (no copied material) | `backend/orchestrator/` |
| 12 | Fail-closed memory mutation | Odysseus `src/memory.py` | AGPL | Adapt clean-room | None (no copied material) | `backend/memory/` |
| 13 | Compaction at 85% of window | Odysseus `src/context_compactor.py:95,474` | AGPL | Adapt clean-room | None (no copied material) | `backend/memory/` |
| 14 | Originator-anchored group handoff | AI Teammates `trigger/chat.ts:69-93` | No LICENSE | Reference only | Re-implement natively | N/A | `backend/orchestrator/` |
| 15 | Per-bot sandbox with `MEMORY.md` | AI Teammates `lib/sandbox-tools.ts` | No LICENSE | Reference only | Re-implement natively | N/A | `workspace_manager/` |
| 16 | Trigger.dev `chat.agent` durable runs | AI Teammates `trigger/chat.ts` | No LICENSE | Integrate (dependency) | N/A | Standard package notices | `backend/runtime/` |
| 17 | scrypt + `timingSafeEqual` auth | AI Teammates `lib/auth.ts` | No LICENSE | Reference only | Re-implement natively | N/A | `backend/auth/` |

## Clean-room statement for Odysseus-derived code

All code in `~/nerdbot` that is inspired by Odysseus (AGPL-3.0-or-later) has been re-implemented from behavioral description only. No source files, strings, constants, or data structures from `~/odysseus` have been copied, translated, or derived by mechanical transformation. Where a detail mattered, the cited file was read to *understand the behavior*, then fresh TypeScript was written. This stance is documented here and in `THIRD_PARTY_NOTICES`.

## Open questions

- Q1: License for `~/nerdbot` product (MIT / Apache-2.0 / other)? Affects `NOTICE` mechanics for Octop reuse.
- Q6: Backfill policy for new `messages` projection — none (dev data is disposable per existing policy).
