# NerdBot UI Evidence (R1–R3 handoff audit)

**Audit date:** 2026-11-10 (HEAD `6d325a7`)  
**Environment:** isolated local run, no production data modified.  
- Backend+SPA: `http://127.0.0.1:8765` (`NERDBOT_DB=/tmp/nerdbot-r3-verify/nerdbot.db`, `NERDBOT_DATA=/tmp/nerdbot-r3-verify/data`, `NERDBOT_INSECURE_DEV_TOKEN=1`, dev token `dev-token-change-me`)  
- Browser: Playwright **1.64.1** + Chromium headless shell (cached `chromium_headless_shell-1248`)  
- **Fixtures (clearly labeled, not real activity):** `[TEST FIXTURE] Populated Workspace` (`prj_78077406edf2`, agent, tasks in running/ready/blocked/failed/done/awaiting_approval states, pending approval, Library doc `[FIXTURE] Project summary report`, Gallery asset `[FIXTURE] Output image.png`), `[TEST FIXTURE] Empty Workspace` (`prj_af929e45caee`), plus seeded `Home` project with agents.

**Durable evidence location (repo):** `docs/audit-evidence/r1-r3-handoff/`  
- Screenshots: `docs/audit-evidence/r1-r3-handoff/screenshots/*.png`  
- Recording: `docs/audit-evidence/r1-r3-handoff/recording/home-workspace-agent-task-deliverable-fixture.webm`  
- Journey notes: `docs/audit-evidence/r1-r3-handoff/recording/journey-notes.txt`  
*(Attachments are committed as repo files for external review; not `/tmp`-only.)*

## 1. Captured screenshots (viewable, labeled)

| # | File | Screen/state | Notes |
|---|---|---|---|
| 01 | `screenshots/01-home-desktop-populated-light.png` | Home | Desktop, light, populated fixture context |
| 02 | `screenshots/02-workspace-list-desktop-light.png` | Workspace list | `/projects` |
| 03 | `screenshots/03-workspace-overview-populated-desktop-light.png` | Workspace overview | Populated fixture, operating dashboard |
| 04 | `screenshots/04-workspace-overview-empty-desktop-light.png` | Workspace overview | Empty fixture, honest empty states |
| 05 | `screenshots/05-agent-directory-desktop-light.png` | Agent directory | `/bots` |
| 06 | `screenshots/06-agent-detail-config-desktop-light.png` | Agent detail/configuration | `/bot/:id` |
| 07 | `screenshots/07-work-activity-desktop-light.png` | Work/Activity (execution/jobs) | `/activity` |
| 08 | `screenshots/08-task-detail-execution-progress-fixture-desktop-light.png` | Task detail / execution progress | **Seeded fixture states, not evidence of successful live agent execution** |
| 09 | `screenshots/09-boards-desktop-light.png` | Boards/team coordination | `/boards` (empty in fixture) |
| 10 | `screenshots/10-teams-coordination-desktop-light.png` | Teams coordination | `/teams` (empty in fixture) |
| 12 | `screenshots/12-global-chat-desktop-light.png` | Global Chat | `/chat` |
| 13 | `screenshots/13-workspace-chat-desktop-light.png` | Workspace Chat | `/chat/:projectId` |
| 14 | `screenshots/14-library-desktop-light.png` | Library | `/library` |
| 15 | `screenshots/15-library-deliverable-detail-desktop-light.png` | Library/deliverable detail | Opened via SPA navigation from workspace |
| 16 | `screenshots/16-settings-desktop-light.png` | Settings | `/settings` |
| 17 | `screenshots/17-workbench-contextual-desktop-light.png` | Contextual Workbench | `/workbench?project=...` (advanced/contextual) |
| 18 | `screenshots/18-home-mobile-light.png` | Home (mobile) | 390×844, light |
| 19 | `screenshots/19-workspace-overview-mobile-light.png` | Workspace overview (mobile) | 390×844, light |
| 20 | `screenshots/20-home-desktop-dark.png` | Home (dark) | Desktop, dark emulation |
| 21 | `screenshots/21-workspace-overview-desktop-dark.png` | Workspace overview (dark, populated) | Desktop, dark |
| 22 | `screenshots/22-workspace-overview-empty-desktop-dark.png` | Workspace overview (dark, empty) | Desktop, dark |

**Requested but not captured as separate populated detail:** board detail (`/board/:id`) — no board fixture existed; boards screen captured empty (gap documented, not simulated).

## 2. Recording (journey)

- **File:** `recording/home-workspace-agent-task-deliverable-fixture.webm` (Playwright video capture)
- **Requested flow:** Home → workspace → agent/work assignment → execution detail → deliverable
- **Journey notes (`recording/journey-notes.txt`):**
  - Opened agent work/assignment affordance (fixture UI flow; **no live execution triggered**).
  - Opened task/execution detail (**seeded fixture states, not evidence of successful live agent execution**).
  - Opened deliverable from workspace.
- **Gaps shown/not simulated:** no actual running execution with a real provider; assignment/action not completed as a full live delegation/execution loop; board/team coordination populated states not available in fixtures.

## 3. Frontend route and capability mapping (inventory)

| Route/surface | Primary components/views | Key APIs consumed (representative) | Reachable actions (representative) | Exposure of backend capability |
|---|---|---|---|---|
| `/` Home | `views-home-overview.tsx`, shared summary (`views-home.tsx`) | projects/counts, approvals/jobs/threads/teammates/tasks/runs (`useWorkspaceSummary`, list APIs) | Triage attention, open workspaces/agents/work/chat/library, resume conversations | **Clearly exposed:** cross-workspace overview signals; **Partial:** deliverables/outcomes depth and next-actions limited to available data |
| `/projects`, `/p/:id` | `views-projects.tsx`, `views-project/index.tsx`, `views-project/overview.tsx`, tabs: tasks/teammates/files/knowledge/providers/issues/schedules/approvals/messages/notifications/memory/backup/metrics/events/boards | project tasks/runs/teammates/approvals/library/gallery + tab-specific APIs | Navigate workspace sections, manage work/agents/config, open chat/workbench | **Clearly exposed:** R3 overview, core tabs; **Buried:** many capabilities in Advanced tabs; **Confusing:** mixed mental models (overview vs admin/IDE) |
| `/p/:id/t/:taskId` | `views-task.tsx` | task, runs, events/stream, artifacts, workspace files/diff, approvals/actions | Inspect run, control/retry/cancel (where enabled), view artifacts/diff | **Clearly exposed:** task/run detail; **Partial:** execution progress depends on live/fixture state |
| `/bots`, `/bot/:id` | `views-bot.tsx` | teammates, tasks/runs, skills/memory/persona/provider bindings | Browse agents, inspect/configure, open work context | **Exposed but mixed:** identity/config visible; **Gap:** teammate-as-independent-actor narrative/history not consistently prominent |
| `/activity` (`/work` redirect) | `views-work.tsx` | jobs, tasks/runs/approvals/schedules/reminders aggregation | Monitor/triage execution and jobs | **Clearly exposed:** unified activity/jobs; **Partial:** cross-entity storytelling/outcomes |
| `/chat`, `/chat/:projectId` | `views-chat.tsx` | threads/messages/stream, projects/teammates/providers, attachments/context APIs | Converse, manage threads, scope to workspace | **Clearly exposed:** chat; **Risk:** can still dominate workflows outside overview intent |
| `/library`, `/library/:docId` | `views-library.tsx` | library list/doc/version/access/export | Read/edit/manage docs and deliverables | **Exposed:** library; **Defect:** hard deep-link collision for `/library/:docId` in same-origin served mode |
| `/gallery` | `views-gallery.tsx` | gallery assets/content | Browse/manage assets | **Exposed:** basic gallery |
| `/teams`, `/team/:id` | `views-teams.tsx` | teams/members/projects/teammates | Coordinate groups | **Buried/secondary:** often empty/technical |
| `/boards`, `/board/:id` | `views-boards.tsx` | boards/members/messages/execution | Board coordination/decomposition views | **Buried/partial** |
| `/approvals` | `views-approvals.tsx` | approvals inbox/decision APIs | Review/decide pending actions | **Exposed:** global inbox; also contextual |
| `/settings`, `/capabilities` | `views-settings.tsx`, capabilities view | providers/projects/capabilities/permissions/config APIs | Configure providers/workspaces/system; inspect capabilities | **Exposed but technical:** admin/diagnostic density |
| `/workbench` | `views-workbench.tsx` | workspace tree/file/diff/terminal/tasks | Edit/run in workspace context | **Contextual/advanced (correctly non-default now) but IDE-like** |

**Backend capabilities mapping (summary):** Clearly exposed = Home overview, workspace overview, tasks/runs, chat, agents list/detail, library/gallery basics, approvals inbox, settings/providers. Buried = schedules/reminders, notifications/webhooks, backup/metrics/events, memory/skills/knowledge admin, boards/objectives/decomposition, delegation internals, many workspace advanced tabs. Confusing/duplicated historically reduced but residual (agent/team/bot naming, project/workspace terminology, overview vs deep admin surfaces). Inaccessible/no UI = some operational/low-level endpoints and fine-grained execution internals not meaningfully surfaced as user journeys.

## 4. Design cohesion and quality audit (observed from code + screenshots)

**Functional correctness (observed):** core navigations and fixture-backed states rendered; R1–R3 smoke flows passed. Several behaviors remain unverified or conditional (live execution, full chat ops, approval resume).  
**Accessibility (smoke only):** keyboard focus movement and reduced-motion render smoke passed; no comprehensive focus-visible/order/ARIA/screen-reader/theme-contrast audit.  
**Visual/product quality:** mixed.

### Findings
- **Where it feels stitched together:** multiple generations coexist — newer Home/workspace operating overviews alongside legacy tabbed/admin sections, dense technical forms, and IDE-like Workbench. Transition from overview to deep tabs can feel like a different product.
- **Inconsistent patterns:** varying card densities, table/list treatments, status chips/badges, spacing rhythms, and header/action patterns across Work/Agents/Library/Settings/Workbench/Advanced tabs.
- **Chat or IDE conventions dominating:** Chat remains a full product surface (appropriate) but conversational/list paradigms and Workbench/file-terminal/editor affordances can overshadow “teammate operating environment” framing outside overview.
- **Agents feel like resources in places:** directories/config screens emphasize IDs/status/config fields and management actions over role, current mission, recent outcomes, and accountability narrative (improved partially in workspace overview agent cards).
- **Work and outcomes hard to understand:** execution/deliverables are distributed across tasks, runs, artifacts, library/gallery, jobs; overview aggregates only a subset, so users must hunt for complete outcomes.
- **Visual noise / excessive containers:** some screens retain bordered containers, segmented panels, and technical metadata density; overview is comparatively clearer but not yet the system-wide language.

### Responsive/theme/motion observations
- Mobile and dark screenshots captured for key surfaces (Home, workspace populated/empty) show layouts render, but not all screens/components audited for overflow, tap targets, or dark-theme contrast parity.
- Reduced motion handled in principle in components/styles (and smoke render under emulation), but no thorough motion audit.

## 5. Design guidance (skillset) — accessibility and adherence

**Requested references:** `https://github.com/NalinDalal/skillset`  
- `skills/ui/ui-core/SKILL.md`  
- `skills/ui/house-style/SKILL.md`  
- `curations/impeccable/overlay/SKILL.md`

**Accessibility in repo:** **Not vendored/present** locally (`skills/`, `curations/` not found). Referenced by `docs/PRODUCT-EXPERIENCE-REASSESSMENT.md` and commit instructions; treated as external guidance. **Unable to verify exact current contents from this environment without network fetch beyond available context** — this is an evidence limitation (external dependency).  
**Followed/divergence (inferred from implementation and guidance intent stated in reassessment):** partial alignment in R1–R3 slices (clearer hierarchy, reduced default IDE dominance, more whitespace/sectioning in overview, avoidance of nonfunctional objective control, truthful states). Divergences remain: inconsistent component/system language across legacy surfaces, technical-primary labels/IDs in places, residual admin-density and containerization, uneven agent-as-teammate presentation, and incomplete end-to-end cohesion. A definitive compliance audit requires the source guidance text to be accessible during review.

## 6. Reconciliation of verification claims (R1–R3)

| Claim / area | Status in this audit | Evidence |
|---|---|---|
| R1–R3 browser smoke journeys (Home/workspace/task/back, approval/deliverable links via SPA, chat routes, aliases, basic mobile/dark/reduced-motion/focus smoke) | **Executed (smoke, isolated fixtures)** | `dashboard/verify-r1-r3.mjs` run 20/20 PASS; screenshots/recording captured |
| Library document hard-navigation/API route collision | **Confirmed defect/constraint** | Direct GET `/library/:docId` returned API 401 in served SPA mode; SPA click navigation succeeded |
| Partial-source-failure browser behavior | **Not visually fault-injected; logic unit-tested** | `overview.test.ts` partial-error coverage; implementation uses per-source settled handling |
| Conversation-operation coverage (Phase 5 full matrix) | **Partially smoke-verified only** | Routes/nav checked; rename/pin/archive/move/delete/restore/export/search/filter not fully exercised in browser |
| Keyboard/focus and reduced-motion | **Smoke-level only** | Tab focus moved; reduced-motion emulation render ok; no comprehensive audit |
| Mission persistence | **Unimplemented (explicit)** | No `Project` mission field; honest UI empty state |
| Partial deliverables aggregation | **Partial by design (Library+Gallery only)** | Overview code/tests and UI copy/screenshots |

**Do not overstate:** passing smoke tests/builds does not prove design quality, full accessibility, or complete functional correctness of unexercised flows. “Pre-existing” not asserted without baseline evidence except where noted.
