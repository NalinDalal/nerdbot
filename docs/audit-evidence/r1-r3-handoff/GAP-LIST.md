# NerdBot Prioritized Gap List (audit evidence, HEAD `6d325a7`)

Prioritization: **P0** = blocks trust/core understanding or verified broken journey; **P1** = major product/UX/capability gap; **P2** = important but non-blocking; **P3** = polish/consistency. Evidence references: `NERDBOT-CURRENT-STATE.md`, `CAPABILITY-MATRIX.md`, `UI-EVIDENCE.md`, and captured artifacts under `docs/audit-evidence/r1-r3-handoff/`.

## D1. Broken functionality (verified or high-confidence defects)

| Priority | Gap | Evidence / impact | Notes |
|---|---|---|---|
| P0 | **Library doc hard deep-link/refresh collision (`/library/:docId`) in same-origin SPA serving:** browser navigation hits API route (`GET /library/{doc_id}`) before SPA fallback → 401 without auth; SPA client-side open works | Reproduced in browser smoke (401 response) and explained by `backend/src/nerdbot/api.py` route ordering/SPA fallback; in-app deliverable click succeeded | Preserved/deep-link expectation partially broken; needs careful routing fix (API namespace, SPA fallback negotiation, or route strategy) without regressing API consumers |
| P1 | **R1–R3 browser-verification gate not fully closed:** partial-source-failure visuals, full conversation-op matrix, comprehensive keyboard/focus/reduced-motion, and some deep-link cases remain unverified in browser | Audit reconciliation in CURRENT-STATE/UI-EVIDENCE; smoke coverage passed but not exhaustive | Not a runtime crash, but release-confidence gap for “verified coherent experience” |
| P1 | **README/product copy drift vs current UX:** README still describes chat-first Home/sidebar behaviors and outdated counts/flows in places | `README.md` “Primary experience”, “First-use walkthrough” vs implemented Home overview + R1–R3 nav | Misleads users/reviewers; documentation defect |

## D2. Hidden existing capabilities (implemented backend/UI exists but buried, confusing, or inaccessible)

| Priority | Gap | Evidence / impact | Notes |
|---|---|---|---|
| P1 | **Rich workspace/admin capabilities buried in Advanced tabs and technical surfaces** (providers, schedules, approvals config, memory, knowledge admin, notifications/webhooks, backup/metrics/events, issues/messages, boards in some contexts) | `views-project/index.tsx` Advanced menu + tab modules; capability matrix | Powerful features hard to discover or contextualize within “operating environment” flow |
| P1 | **Execution/coordination primitives underexposed as coherent user journeys:** delegations, decomposition, board execution, team coordination, research/job drill-downs, artifact/review/PR package outcomes | Routes/models in `api.py`/`models.py`/`store.py`; UI often list/detail-technical or fragmented | Users may not understand or leverage teammate coordination and produced outputs |
| P1 | **Agent configuration depth (persona/soul/goals/wisdom/memory tiers/skills/tool policy/permissions/provider fallback) not presented as understandable teammate profile/history** | `models.Teammate`, persona/memory/skills APIs, agent views | Capability exists but mental model remains “bot config/resource” in places |
| P2 | **Workbench/files/terminal power contextual but discovery/value framing weak** (now correctly non-default) | `/workbench`, workspace Files/terminal APIs, screenshots | Advanced users benefit; most users need task/outcome-oriented framing |
| P2 | **Operational/CLI-driven automation (executor/fire-due/deliveries sweeps, opt-in executor loop) invisible in-product** | `executor.py`, CLI commands, README notes | Users cannot tell when/why autonomous progress happens or stalls |

## D3. Missing backend functionality (or required data/model support)

| Priority | Gap | Evidence / impact | Notes |
|---|---|---|---|
| P1 | **No canonical workspace mission/objective field on Project** (and no persistence/API for it) | `models.Project` lacks mission; overview shows honest empty state (`views-project/overview.tsx`, screenshots) | Prevents “what is this workspace for?” being first-class/truthful without board-objective conflation |
| P1 | **No unified workspace deliverables/outcomes aggregation** across Library, Gallery, task/run artifacts, PR packages, reviews, research reports/exports | No single endpoint; overview intentionally aggregates Library+Gallery only (bounded) | “What has been produced?” incomplete; forces navigation hunting |
| P1 | **No explicit agent availability/workload/assignment model** (only inferred from task/run/teammate status) | Overview derives observed execution; states labeled as observed, not authoritative | Limits trustworthy “who is available / on what now” at scale |
| P2 | **Standardized deep-link/SPa route namespace strategy lacking for API-colliding paths** | `/library/:docId` collision; SPA fallback only after API routes | Architecture-level gap affecting durable links/exportability |
| P2 | **Always-on/background execution semantics depend on external heartbeats/opt-in**, not an integrated managed scheduler in all deployments | Executor/schedule/reminder/delivery sweeps and `NERDBOT_EXECUTOR=1` | Affects “AI teammates actually perform work” reliability/expectations |
| P3 | **Richer cross-entity timeline/provenance model for human-readable operations** (attention, outcomes, who did what when) may require aggregation primitives | Fragmented events/jobs/runs/messages | Can be partly frontend-derived if data sufficient; some cases need backend support |

## D4. Product/interaction design problems

| Priority | Gap | Evidence / impact | Notes |
|---|---|---|---|
| P0 | **Product cohesion incomplete:** app still feels like merged generations (operating overviews + legacy admin tabs + workbench/IDE + chat/productivity surfaces) rather than one polished AI teammate operating environment | Screenshots across Home, workspace overview vs Advanced/Workbench/Settings/Teams/Boards; UI-EVIDENCE findings | Core to stated product intent (Odysseus/Octop depth + Grok-like bot identity + real work) |
| P1 | **Agents not consistently experienced as independent teammates** (identity, current assignment, recent outputs, work history, accountability) outside select views/cards | Agent directory/detail/config screenshots; overview improvements partial | Weakens trust and delegation mental model |
| P1 | **Work assignment/delegation and “teammate doing real work” narrative not seamless end-to-end in UI** (from intent to execution to reviewable outcome) | Recording notes (assignment affordance opened but no live execution loop completed); fragmented task/run/artifact/deliverable surfaces | Backend capability exists in parts, but journey clarity is limited |
| P1 | **Deliverables/outcomes not first-class everywhere:** produced work scattered across Library/Gallery/tasks/artifacts/reports | Partial aggregation in workspace overview; separate destinations | Users struggle to answer “what shipped?” |
| P1 | **Navigation/scope/terminology complexity:** Projects/Workspaces, Bots/Teammates/Agents, Teams/Boards, Work/Activity, global vs workspace chat — improved but residual | IA docs, app routes/nav, mixed labels in deep surfaces | Cognitive load and misorientation risk |
| P2 | **Chat can still re-center interaction model** for users expecting conversational control, despite non-chat Home/workspace overview | Global/workspace chat prominence and capabilities | Needs careful balance, not removal |
| P2 | **Technical language and IDs/configuration concepts leak into primary user tasks** in many non-overview surfaces | Settings/Capabilities/Advanced tabs/task metadata | Reduces accessibility for non-technical operator intent |

## D5. Visual design problems

| Priority | Gap | Evidence / impact | Notes |
|---|---|---|---|
| P1 | **Inconsistent visual system across surfaces** (spacing, density, typography hierarchy, controls, table/card/list patterns, status treatments) | Cross-screen screenshots (overview vs Work/Agents/Library/Settings/Teams/Boards/Workbench) | Undermines “one polished product” feel |
| P1 | **Excessive containers/borders/administrative density** on legacy/advanced screens reducing clarity and emphasis | Workspace advanced tabs, settings/capabilities, tables/forms | Contrasts with clearer overview direction |
| P2 | **Uneven dark/mobile polish and information density** (not fully audited, but likely variance) | Representative dark/mobile screenshots captured for key pages only | Requires systematic responsive/theme pass |
| P2 | **Status/progress/identity visualization not yet unified** (agent faces, run states, attention, outcomes appear with different visual languages) | Bot faces exist; status badges/dots/sections vary by view | Opportunity to reinforce teammate/work semantics coherently |
| P3 | **Motion and micro-interaction consistency unverified** | Reduced-motion smoke only; no holistic motion audit | Should align with accessibility and product tone |

## D6. Verification gaps

| Priority | Gap | Evidence / impact | Notes |
|---|---|---|---|
| P0 | **No live end-to-end proof in this audit of “AI teammate actually performs work” to successful reviewable outcome with real provider/execution loop** (only fixture states and implementation evidence) | Recording notes, task screenshot labeled fixture; no provider run executed | Critical to validate core product promise, not just UI/data plumbing |
| P1 | **Browser fault-injection for partial-source-failure states not captured** (Home/workspace overview resilience) | Unit-tested; no visual evidence of degraded-source UI | Needed to confirm truthful degraded behavior in product experience |
| P1 | **Full conversation lifecycle browser coverage incomplete** (rename/pin/archive/unarchive/move/delete/restore/export/search/filter, scope indicators, provider-binding side effects) | Smoke-level route/nav only | Regressions possible in key interaction flows |
| P1 | **Comprehensive accessibility verification missing** (keyboard traversal/order, visible focus across all controls/states, screen reader semantics, contrast, reduced-motion behavior beyond smoke) | Only minimal smoke checks executed | Required for quality and inclusivity claims |
| P1 | **Deep-link/route integrity audit incomplete** across SPA/API namespace collisions and legacy paths | Confirmed `/library/:docId` hard-nav issue; other collisions unknown | Impacts shareability, refresh, external entry |
| P2 | **Approval decision→resume/carry-out flow not browser-exercised end-to-end in this audit** (despite fixture visibility and backend implementation/tests) | Pending approval surfaced; decision not taken | High-value safety/workflow path needs E2E evidence |
| P2 | **Cross-browser/device and performance verification not performed** | Single headless Chromium run | Layout/behavior may differ elsewhere |
| P3 | **Design-guidance compliance cannot be definitively audited** because skillset guidance files are not vendored locally and were not fetched as source text in-repo | External reference only (`NalinDalal/skillset`) | Treat as evidence limitation; align once guidance is accessible |

## Suggested execution order (for follow-up, not performed)
1. **P0 integrity & promise:** fix `/library/:docId` hard-link routing; obtain live-provider E2E evidence for assign→execute→approve/recover→deliverable; close critical R1–R3 verification gaps.
2. **P1 coherence foundations:** introduce canonical workspace mission + unified deliverables aggregation (smallest backend/API changes), elevate agents/outcomes in UX, reduce buried/technical fragmentation on key journeys.
3. **P1/P2 systematization:** unify visual/interaction patterns, terminology, and navigation semantics across legacy surfaces; harden deep links and accessibility.
4. **Ongoing:** automated browser coverage for critical flows, explicit availability/workload semantics, and operational visibility of automation/sweeps.
