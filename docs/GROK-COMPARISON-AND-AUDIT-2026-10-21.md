# Grok comparison and nerdbot architecture audit — 2026-10-21

Evidence statements are labeled: **O** = observed live this session (REA, with Evidence IDs), **D** = documented on official xAI pages (URLs listed), **C** = confirmed by reading nerdbot source this session (file:line), **T** = verified by running the test suite, **inferred** = likely implementation pattern, not proof.

## 1. Baseline (what was verified, what runs)

Commands run today, all green, before any change:

| Check | Result |
|---|---|
| `dashboard` `tsc --noEmit` | OK |
| `dashboard` `eslint src --max-warnings 0` | OK |
| `dashboard` `vitest run` | 49/49 pass |
| `dashboard` `vite build` | OK (1 warning: main chunk 525 kB > 500 kB) |
| repo root `uv run pytest -q` | 351/351 pass |

Working tree clean on `main` at `fcce8f0` before today's session; this report file is the only untracked addition so far.

### Capability inventory

- **Working (verified):** command center landing with cross-project attention banner and inline approvals; project/task/execution views with plan, logs, reviews, patches, PR packages; agent fleet with give-work, permissions editor, memory; teams with agent-to-agent handoff detection (`parent_task_id`); boards with cross-agent messaging and approvals; workspaces/projects; settings and capabilities pages; provider (BYOK) setup; schedules; chat threads with SSE streaming; 351 backend tests covering gates, delegation, fetch hardening, webhooks, providers.
- **Partial:** run cancellation — flips task/delegation state, cannot interrupt an in-flight run; approval gating — enforced server-side for admin/tool actions but not for the agents' `run_command` shell tool; light-theme contrast; a11y (focus management, label association); `views-project.tsx` styling not converged to the design system.
- **Configuration-dependent:** providers/BYOK need user keys; schedules fire only via CLI sweep (`fire-due`) or `/schedules/{id}/fire`; executor background thread requires `NERDBOT_EXECUTOR=1`.
- **Unsupported / not pretending:** Grok-style image/video generation (no provider), shareable public conversation links, reactive push for approvals/runs (clients poll), true sandbox isolation of agent shell access (project is not a security boundary by design).

### Journey map (route verified in `app.tsx` parseHash)

1. **Open the Command Center** — `#/home` composer + recent threads + workspaces + attention banner + per-team rollup.
2. **Start / resume a conversation** — composer threads route to `#/threads/<id>`; recent list on the landing.
3. **Assign work to an agent** — `#/bots` → bot detail → give-work modal (or wizard).
4. **Organize into projects** — `#/p/<projectId>` shell; tabs for tasks, messages, approvals, providers, github, backup, settings.
5. **Delegate between agents** — delegation APIs + `parent_task_id` surfaced in teams.
6. **Monitor runs** — execution panel on `#/p/<projectId>/t/<taskId>` with logs, run state, rollups.
7. **Approve agent actions** — attention banner on home (inline approve-once / forever / deny), approvals tab in project, board approval flows.

## 2. REA setup and inspection status

- **Installed:** `rea-agents` 6.7.0 (used via `npx`, no global pollution). Node v26.10.0, npm 11.19.1 — meets REA's requirement (26+).
- **Setup applied with review:** dry-run plan reviewed first; then `rea setup --client opencode --yes`. Applied exactly two user-owned changes: REA MCP registration added to `~/.config/opencode/opencode.jsonc` (backup at `opencode.jsonc.rea.backup`) and the bundled REA skill installed (v identity "42", aligned).
- **Readiness (`rea doctor`):** node/host OK; native engines (Hopper/Ghidra/IDA/JADX/Kuna) missing — irrelevant for web targets; registration:opencode now configured.
- **MCP connection:** REA MCP server connected in-session, 207 tools.
- **Constraints honored:** investigation limited to authorized access. No credentials recorded, no paywall circumvention, no claims about Grok server internals.

## 3. Grok investigation

### What was observed live (unauthenticated grok.com, Brave profile with CDP)

All items below carry REA Evidence IDs (full records retained in the REA ledger):

| # | Observation | Evidence | Classification |
|---|---|---|---|
| O1 | Landing page: skip-link, cookie consent dialog, top nav (Home, Imagine, Settings, Sign in, Sign up), heading "What should we explore?", composer with `combobox "Ask Grok anything"`, Attach, Submit, and a `Model: Fast` selector | `ev_8375e903044bb41de2ce1b0441401c276cf9288f65886a620197f6a8689a0611` (a11y tree) | Observed |
| O2 | Model picker menu: `Fast [checked]`, `Auto – Requires sign-in`, `Expert – Requires sign-in`, `Heavy – Requires sign-in`, plus Premium upsell item with inline "Sign in" button | screenshot artifact `ev_7b1762e7323899ae6066a48262d441d4ead0015ded52bfdcbe7de0a9593cf67f` run + a11y capture (digest `3ea9cb4f…93`) | Observed |
| O3 | Anonymous submit gate: sending a message renders it in place (no redirect) with heading "Continue your conversation", "Sign up to continue seamlessly with Grok's full power", benefits list (AI images & videos, **Skills & Connectors**, generate files, chat history), "Sign up for free" button. URL stays `grok.com/` (SPA gate) | scenario capture in this session (accessibility artifact) | Observed |
| O4 | `/imagine` surface: "What should we imagine?" with a template gallery — Text Edit (Beta), Photo Edit, E-Commerce Photos, Hero Product Reveal, Character Sprite, Mascot Maker, Loop, Smart Resize, Profile Picture; URLs like `/imagine/template/imagine-photo-edit` | accessibility artifacts in this session | Observed |
| O5 | Settings (anonymous): a menu with Theme `Light [unchecked] / Dark / System [checked]` group, Language, Feedback — nothing else | accessibility artifact | Observed |
| O6 | Unauthenticated bundle: 4 scripts only (Cloudflare challenge + inline), 0 route candidates, 0 endpoint candidates, 0 source maps; the app bundle loads only after sign-in | `ev_1584d8504fdfc644db4979ad8c5500a2a17ecb89cfec68261fc46f5729354f46`; completeness `complete`, 10,122 AST nodes visited | Observed |
| O7 | WebMCP discovery: domain available, 0 page-declared tools | `discover_webmcp_tools` this session | Observed |

### What was NOT investigated and why

No logged-in session exists. Per your note, signing in would not unlock features behind the subscription paywall, and bypassing that paywall is out of scope. So: **no live observation of logged-in chat, streaming behavior, history, projects surface, multi-agent mode, or the Grok Bot desktop app.** Everything else in this report is labeled D below.

### Documented layer (official pages fetched)

- `https://x.ai/grok` (product page): chat with stepwise reasoning; multi-agent mode (parallel agents, auditable reasoning, merged cited answer); live web/X search; Imagine (2K images, 15 s videos); memory across chats; Canvas; custom instructions; shareable conversations; SuperGrok tier.
- `https://x.ai/news/introducing-grok-bot` (launch post, Aug 11 2026): Bots share **one persistent cloud computer** per user; message like a teammate; multiple Bots in parallel and in **group chats that coordinate autonomously — pass work, assign ownership, only pull you in for judgment calls**; **"show a Bot how it's done"** → saved as a routine, runs on its own; progressive trust and **memory updates**; proactive follow-ups; included in SuperGrok tiers / $30–$200 direct tiers; desktop + iOS, same thread across devices.
- `https://x.ai/bot`: Auto Review for sensitive actions before they run; per-Bot job templates (Sales Outbound, Talent Scout, Expense Manager, Chief of Staff); marketplace of bot presets at `/bot/marketplace`; "your Bots share that machine so they can hand work off"; enterprise DLP/certs/proxies; training opt-out.
- `https://x.ai/build`: Grok Build CLI — plan mode where **every edit is blocked until you approve**, per-step comment, approved changes as diffs; skills with `/skillify`; plugin marketplaces; Q&A multiple-choice for ambiguous tasks answers flowing into the plan; subagents in parallel **with their own worktrees**; memory; hooks; MCP; headless CI mode.
- `https://docs.x.ai/grok/user-guide` (Grok Business): personal vs team workspaces with a workspace selector, team-scoped sharing, SuperGrok benefits inside team workspace.

Where a D item describes behavior of a page behind login, treat it as an xAI claim about their product, not something I verified running. Confidence in the D layer is high on *what the product claims to offer* and clearly lower on *how the anonymous experience would handle it day to day*.

## 4. Grok vs nerdbot gap matrix

Nerdbot's "verified current behavior" column cites code/tests read this session (backend audit + spot checks). Classifications: missing / weaker-UX / partial / equivalent / nerdbot-advantage. Recommendation: adopt / adapt / defer / reject (against value, coherence, reliability, cost).

| Capability | Grok behavior | Nerdbot verified today | Gap | Recommendation |
|---|---|---|---|---|
| Conversation streaming + in-composer model/mode switch | Composer holds model picker inline (`Model: Fast` → Fast/Auto/Expert/Heavy menu) — O2 | Streaming works (`sendChatStream`); model switching only via a configure-model modal, not inline in the composer (C) | weaker-UX | **Adapt**: put a small model chip beside the composer input (one API call, no new framework). |
| Honest failure vs fake success | n/a (SaaS) | `useWorkspaceSummary` swallows every fetch error into `[]` so an outage renders as a "healthy" empty command center (C, verified) | partial (nerdbot bug) | **Adopt**: fix — one error banner when fan-out fails. Highest honesty-per-line-of-code win. |
| Interruption / cancellation | Not observed (streaming cancelled implicitly by session). n/a | CommandCenter aborts streams correctly; `ThreadPane.stop` only resets local state — the stream keeps writing after Stop (C, verified) | weaker-UX (bug) | **Adopt**: thread the same AbortController into ThreadPane. Small, test-friendly. |
| Approvals on consequential actions | Auto Review gates sensitive actions before they run — D | Approval gates enforced server-side, digest-bound, with once/forever semantics — C, T (42 gate tests) — **but** `run_command` (shell) is never approval-gated and board member add/remove skips the gate — C | partial | **Adopt (nerdbot direction better; close the two holes)**: route board-membership changes through `gates.require`; decide and document a shell-tool policy (permission-gated, explicit "trusted" tier) instead of pretending gate coverage. |
| Teammates that run 24/7 with own cloud computer | Bots keep working when laptop closed; shared persistent machine — D | Runs execute synchronously in-request, default 60 s wall clock, no mid-flight cancel, orphans recovered only at startup — C | missing | **Defer** (architectural; large backend work). Adopt incrementally later: process-detached runs with explicit run lifecycle. |
| Multi-bot coordination (group chat, pass work, only pull you in for judgment calls) | Group threads where Bots coordinate and assign ownership — D | Teams + delegations + agent-to-agent handoff detection via `parent_task_id`; boards pass work; approvals pull the owner in — C, T | equivalent (direction), weaker-UX (visibility) | **Strengthen**: surface handoff/delegation trees in the command center rollup; already exists partly. No new concept needed. |
| Routines ("show me how it's done" → repeatable) | Watch-and-learn into runnable routines — D | Schedules exist (create/fire/CLI sweep) but nothing learns a workflow — C, T | partial | **Defer**: product-shape question. Schedules + task templates cover the deterministic slice; "learned routines" needs model capability nerdbot's providers may not guarantee. |
| Templates for named jobs | Marketplace of bot job presets (Sales Outbound…) — D | Fleet directory shows live execution and delegation (722634a) but no preset templates — C | weaker-UX (optional polish) | **Defer**: nice-to-have; add 3–4 local task presets only if day-to-day use shows demand. Do not copy the marketplace framing. |
| Memory across chats / learns your preferences | Memory across chats; Bots update memory ("Noted for next time…") — D | Memory endpoints exist per teammate; added/edited via bot detail — C, T | equivalent, weaker-UX | **Strengthen**: show memory entries in context where work is delegated (progressive disclosure), not as a separate admin page. |
| File generation / file analysis | Generate files; file & PDF analysis — D | Workspace files view (bounded, 1 MB cap), artifacts recorded — C, T | partial | **Keep**; defer anything beyond listing real artifacts. |
| Image/video generation | Imagine with templates, 2K/15 s — D, O4 | No image/video provider — C (verified inventory) | missing | **Reject (now)**: needs an external provider + new product surface; not core to the personal AI-company value. Revisit only if a concrete provider and use case arrive. |
| Plan mode with per-step approval | Plan viewer; edits blocked until approved; comment per step; approved = clean diff — D | Tasks carry plans + packaged approvals + reviews with digest binding — C, T | equivalent | **Keep.** Possibly adopt the *comment-on-a-step* micro-interaction later. |
| Subagents with isolated worktrees | Parallel subagents, each in own worktree — D | Delegations create child runs inside the same project workspace; no per-delegation worktree — C | partial | **Adapt** (cheap, real): per-child workspace directory only if evidence shows collision problems; otherwise keep as documented limit. |
| Skills (reusable saved workflows, `/skillify`) | Skills + plugins marketplaces; capture session as skill — D | None — C | missing | **Defer**: valid long-term; depends on providers supporting tool-composition reliably. |
| Shareable conversation links | Public share links; team-only sharing in business — D | None — C | missing | **Reject (now)**: new security surface for an owner-only tool with minimal value. |
| Projects / workspaces separation | Business workspaces: personal vs team selector, team-scoped sharing — D | Projects + workspaces with tasks/conversations/agents/files — C, T | equivalent, nerdbot-advantage (real execution and evidence attached to records, not just chat) | **Keep, strengthen** (do not copy the license-based model). |
| Theme switching | Light/Dark/System in settings menu — O5 | Theme resolution incl. system preference exists — C — but light-theme contrast fails in several tokens (audit) | weaker-UX | **Adopt**: fix token contrast (part of the a11y pass). |
| Accessibility baseline | Skip-link, semantic roles, live-region alerts — O1/O3 | Modals lack focus management; several unlabeled inputs; ~30 unstyled buttons in legacy project view — C | weaker-UX | **Adopt**: a11y pass listed below. |
| Loading/error discipline on long-running work | Progress cues in-app (not observed live) | Polling flashes; `ExecutionView` has **no error path** and polls forever ("Loading task…" dead-UI bug when fetch fails) — C | weaker-UX (bug) | **Adopt**: error state + backoff on polling paths. |

## 5. Top architecture / design problems in nerdbot (verified this session)

Ordered by value-per-effort. All claims below were confirmed by reading source or running code; audit sub-agent findings were spot-checked for the items marked ✔.

1. **Stop button lies (correctness bug).** `ThreadPane` `stop()` resets local state but its `api.sendChatStream` call passes no signal, so the SSE stream continues and keeps appending chunks after "Stop". ✔ (`views-chat.tsx:347-367`; abortRef exists only in CommandCenter.)
2. **Command Center can look healthy during an outage.** Every fetch in `useWorkspaceSummary` does `.catch(() => [])` (`views-home.tsx:109-143` ✔) — a down/unauthorized backend renders the same as an empty workspace.
3. **AttentionBanner rendered twice on home.** Parent `ConversationView` renders it (`views-chat.tsx:110`) and `CommandCenter` renders it again (`:1001`) — duplicate approval actions on screen. ✔
4. **Approval model has two holes.** Board member add/remove uses only a permission check, not the digest-bound `gates.require` every other admin surface uses (`boards.py:193-221` ✔). The agents' most powerful tool, `run_command` (shell), is outside the approval system entirely (`agent_tools.py`, `runtime.py:47-54` deny-list only ✔). Execution approvals ledger (`/runs/{id}/approvals`) exists but is not consumed at execution time.
5. **`views-project.tsx` is the last non-converged view:** 1713 lines, 14 tabs, 154 compat class usages (`.row`/`.muted`/`.card`/`.primary`…), 60 inline `style` objects, ~30 unstyled raw `<button>`s, references an undefined `--line` token. All other views are 100% Tailwind + tokens. Eight compat aliases (`.grid3`, `.stat*`, `.search-input`, …) are used nowhere — dead CSS.
6. **No fetch cancellation.** `useAsync` supports a `cancelled` flag but never passes `AbortSignal`; route changes leave ghost requests. Also `ExecutionView` polls every 3 s with no error state — on failure it shows "Loading task…" forever.
7. **Checks run in module-scope everywhere** (types rollups, `ExecutionView` 3 s, messages 5 s, approvals 8 s) with skeleton flashes on reload; `/projects/{id}/events` is unbounded; no push channel except chat SSE.
8. **Duplication inventory (all ≥2 sites):** navigation helper re-implemented 15+ times as `window.location.hash = …`; identical table/log/input style constants in `views-task` vs `views-boards` vs restyled copies elsewhere; `Modal` and `Dialog` in `components.tsx` overlap (`Dialog` is unused and references classes defined in no stylesheet); status taxonomy spread across 4-5 parallel tables; per-team status tallying 4×; inline busy/try/catch form pattern 14+×; backend triplicates run-timeout env parsing (`api.py`, `executor.py`, `app_tools.py`) and duplicates deny-list + `sh -c` logic.
9. **A11y:** no focus management or Escape for keyboard users in `Modal`/`ContextPanel` (Escape handler on a non-focusable backdrop ✔); project tabs lack `aria-controls`/arrow keys; `Field` renders a `<span>` label never `htmlFor`-linked; `--faint` at 2.5–3.5:1 contrast in both themes.
10. **Backend contract hygiene:** ~90 routes take `dict[str, Any]` bodies with `str(body.get(...))` coercion (one Pydantic request model total); `update_task`/thread PATCH use raw SQL bypassing the state machine; per-request `executescript(SCHEMA)` + migration; SQLite WAL without `busy_timeout`; several untested routes (`/executor/sweep`, `/tasks/{id}/claim`, chat `/stream`, `/home`, `/capabilities`, `/permissions`, backup import/export).
11. **Dead code:** `components.tsx` `Input`, `Select`, `Dialog`, `isTerminalTaskStatus`, `isAwaitingApproval`; `forms.tsx` `FormModal`; `views-home` `teamRollupLine`; `.skeleton` CSS; `@tanstack/react-table` used by exactly one static table; `react-hook-form` used by one unused form helper (`FormModal`).

Real strengths to retain (do not regress): server-side digest-bound approvals; delegation with parent tracking; honest artifact/run records; tight fetch hardening (SSRF-safe fetch with pinned transport); 351 green tests; the design-system primitives (Page/PageHeader/StatusDot/BotChip) are the right spine.

## 6. Prioritized implementation plan

Dependency order matters: correctness first, then delete dead weight, then converge the legacy view, then a11y, then backend policy work. Each increment keeps `tsc + eslint + vitest + vite build + pytest` green and adds/updates tests where behavior changes.

| # | Increment | Intended user-visible result | Risk |
|---|---|---|---|
| A1 | Fix `ThreadPane` abort (reuse the CommandCenter abortRef pattern); stream stops on Stop; keep draft. | Stop actually stops. | Low. Test: api.test.ts SSE helper already modelled; add a unit test for sendChatStream abort passthrough. |
| A2 | Make `useWorkspaceSummary` failures visible: return per-parcel errors, render a single dismissible error state on the banner area ("couldn't load workspace data — retry"), keep empty state for genuinely empty data. | Command Center never shows a fabricated-healthy screen. | Low |
| A3 | Remove `AttentionBanner` double render (render once, pass data down). | No duplicated approval actions. | Trivial |
| A4 | `ExecutionView`: add error state + stop polling on error; add backoff. | Long-run monitoring stops flashing and fails visibly. | Low |
| B1 | Delete dead code: `Dialog`, `Input`, `Select`, `FormModal`, `teamRollupLine`, unused status helpers, `.skeleton`, 8 unused compat aliases; drop `react-hook-form` only if nothing else uses it after an import check; reconsider `@tanstack/react-table` (static table → plain table). | Smaller bundle (525 kB main chunk shrinks), less confusion. | Low (guard tests: `api.ts`/`app.tsx` exports, no-HTML rule). |
| B2 | Consolidate shared style constants (`TABLE_SHELL`/`TH`/`TD`/`LOG_BLOCK`/`FORM_INPUT`) into `components.tsx` or a `theme-constants.ts`; single `statusTone`/label helpers; one `taskTally` helper used by home/teams/bots. | One status vocabulary, one style vocabulary. | Medium (touches many files; keep diffs mechanical). |
| C1 | Split `views-project.tsx` (1713 lines) into `views-project/` tab modules; replace 154 compat usages with Tailwind tokens one tab at a time; style the ~30 unstyled buttons with the shared `Button`; remove inline `style` objects; drop each compat alias once its last usage goes. Then delete the aliases and the `--line` reference. | Project view looks/behaves like every other view; compat layer gone (its final user's acceptance criterion). | Medium; largest single effort; do per-tab commits. |
| C2 | Center-right: add a small model selector chip in the landing composer (reads providers, reuses configure-model). | Grok-grade inline mode switching. | Low-Medium |
| D1 | A11y pass: `Modal` gets initial focus, Escape, focus restore, `aria-hidden` on backdrop content handled via `dialog` semantics; `Field` gains optional `htmlFor`/`id` wiring; project tabs add id/aria-controls/arrow keys; bump `--faint` contrast tokens (both themes); icon-only buttons get `aria-label` (keep `title`). | Keyboard/screen-reader parity; light theme text readable. | Low-Medium |
| E1 | Backend: `gates.require` on board membership changes; document + decide shell-tool policy in `docs/decisions` (likely: keep `run_command` permission-gated but explicitly not approval-gated, and say why in the ADR) rather than silently leaving the hole. | Approval story is coherent and stated honestly. | Medium (behavior change; needs new tests mirroring gate suites) |
| E2 | Backend: mid-flight run cancellation — best-effort `killpg` of `subprocess` children keyed by run id + a `POST /runs/{id}/cancel`; test cancels a started-but-not-finished child. | Matches the promises the Stop button makes. | Medium; deletes nothing, adds optionality. |
| E3 | Backend (defer unless asked): Pydantic request models for top-10 mutating endpoints; `busy_timeout`; route tests for untested endpoints. | Contract robustness. | Medium-Large |

Explicitly deferred/rejected with reasons: image/video generation (no provider, not core); public share links (security surface, low value); 24/7 detached cloud computer (architecture-limited, revisit with E2 groundwork); learned routines (providers can't currently guarantee it); bot marketplace presets (polish, only on demand).

## 7. Honest limitations

- The Grok comparison rests on the unauthenticated live experience plus official documentation. The logged-in app was not observed; anything about it is an xAI claim.
- REA produced artifact-backed observations (`list_browser_targets`, `inspect_web_page`, `capture_web_screenshot`, `analyze_web_bundle`, `capture_browser_scenario`) but no binary or network-body analysis was needed or performed (bodies were value-free anyway).
- The frontend test env is node-only; `.tsx` component behavior is currently guarded only by `source.test.ts` + types. Component-level tests would harden increments A1/A3/D1 but need a jsdom posture decision first.
- No commit was made beyond writing this report file; nothing has been pushed. The investigation browser profile was created under the opencode temp dir and terminated after use.
