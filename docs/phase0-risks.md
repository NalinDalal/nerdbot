# Phase 0 — P0 Risks, Deferrals, Rejections

## P0 Risks

| # | Risk | Severity | Mitigation | Owner |
|---|---|---|---|---|
| R1 | Plaintext LLM API key at rest (AT pattern) | High | Encrypt `llmApiKey`/`llmApiKey` equivalent at rest (AES-256-GCM, env key) before multi-user exposure | Phase 1 security |
| R2 | No login lockout or rate limiting | High | Per-IP + per-user sliding-window limits; lockout 5 tries / 900s (OCT semantics) | Phase 1 security |
| R3 | No tool guardrails / approvals for shell | High | TS rule list (`rm -rf`, fork bombs, `curl\|sh`, metadata IPs) with `warn\|block` modes; typed failures | Phase 1 runtime adapter |
| R4 | No sandbox idle-stop → cost leak | Medium | Trigger scheduled task listing running sandboxes idle > N hours; lazy wake on demand | Phase 1 |
| R5 | Handoff cycle-guard lost across continuation runs | Medium | Rebuild held set from transcript at run start; persist chain in message metadata | Phase 1 |
| R6 | No `messages` table / orphaned transcripts | Medium | Own DB projection (`messages` table) separate from Trigger transcript checkpoint | Phase 1 |
| R7 | SSRF from future fetch tool into sandbox/metadata endpoints | High | DNS pinning, RFC1918/link-local/metadata blocking, per-hop redirect validation, size budgets | Phase 1 (before C6) |
| R8 | AI Teammates has no LICENSE — code cannot be imported | High | Reference-only; re-implement patterns clean-room; license decision (Q1) before publishing | Owner |
| R9 | Odysseus is AGPL-3.0 — no implementation code may be copied | High | Clean-room re-implementation only; document provenance; no ODY strings/data files in nerdbot | All phases |
| R10 | Moving tree / line drift during implementation | Medium | Re-read target files at start of each phase; pin commit SHAs | All phases |

## Deliberately Deferred

| Capability | Reason | Revisit when |
|---|---|---|
| Browser automation (Playwright/CDP) | Hardest channel to secure; static fetch covers most needs | Phase 4 proves fetch insufficient + G2 controls exist |
| Full RAG / pgvector knowledge base | No demonstrated corpus; `searchFiles` likely suffices | User maintains large document sets |
| OAuth/PKCE connectors | Credential custody + consent flows need G2 audit first | After MCP v1 proves demand |
| ACP coding-agent delegation | Niche for MVP; sandbox + Trigger wait round-trip unproven | Post-G3 experimentation |
| Proactive pushes / care scheduler | Needs schedules (Phase 8) + trust | After schedules stable |
| Org layer (CEOs/departments/boards/approvals) | Out of product scope; Octop's gate is inert (verified) | Only on explicit owner approval |
| 2FA, SSO, roles | Single-user MVP doesn't justify | Multi-user G3+ |
| Desktop/remote desktop | Out of MVP scope | Post-Phase 1 |

## Deliberately Rejected

| Capability | Reason |
|---|---|
| Custom agent loop | Trigger.dev `chat.agent` provides durability; no verified requirement exceeds it |
| Porting Odysseus Python runtime/containment/SQLite stack | AGPL + wrong architecture; adapt patterns only |
| Octop single-process/WS/asyncio architecture | Would fight Trigger.dev; do not port |
| Octop plugin system / UI renderer protocol | High cost, low current need |
| Octop host/member team rooms | AT's originator-anchored handoff is simpler and better |
| DB-backed memory replacement | File-backed memory is debuggable; improve, don't replace |
| Competing agent runtimes without adapter contract | Violates hard distinction |

## License compliance summary

- **Octop (MIT):** Reuse acceptable with attribution preserved. Record in `docs/provenance/` and `THIRD_PARTY_NOTICES`.
- **Odysseus (AGPL-3.0-or-later):** Do NOT copy or import implementation code. Reimplement patterns clean-room in TypeScript. Document the clean-room stance.
- **AI Teammates (no LICENSE):** Reference-only until licensing resolved. Do not import code.
- **Bundled dependencies:** Inspect licenses before reusing anything; record in `THIRD_PARTY_NOTICES`.
