# UI Direction Prototype (for visual review)

**Status:** Ready for visual review. **Do not apply to production screens until visually approved.**  
**Type:** Small runnable visual prototype, isolated and clearly labeled fixtures. **Separate from production routes and backend contracts.**  
**Date:** 2026-11-10

## How to run
- Open `docs/prototypes/ui-direction-2026-11-10/index.html` directly in a browser, or serve the folder:
  - `python3 -m http.server 8787 --directory docs/prototypes/ui-direction-2026-11-10`
  - Visit `http://127.0.0.1:8787/`
- Use the controls at top to switch view (Populated workspace, Empty workspace, Agent + assignment, Execution outcome, Mobile) and theme (Light/Dark). The assignment screen includes a fixture interaction button ("Start assignment") that demonstrates the state/feedback change.

## Design guidance inputs (read, not assumed)
Read from `https://github.com/NalinDalal/skillset` (raw) and used as direction inputs:
- `skills/ui/ui-core/SKILL.md` — accessible/read successfully. Applied: single clear action per screen, complete/truthful states, realistic content, progressive disclosure, responsive intent, restrained/calm visual language, product-ready review mindset.
- `skills/ui/house-style/SKILL.md` — accessible/read successfully. Applied: "bought not generated" restraint, one accent used sparingly, whitespace over heavy containers/borders, no AI purple/glow slop, feedback matched to action, reduced-motion respected, plain language.
- `curations/impeccable/overlay/SKILL.md` — accessible/read successfully. Applied: house rules above commands (no purple slop, calm + one detail, Tailwind-like restraint in tokens/utilities spirit, no em dashes in visible text).

**Access failures:** none for these three files (HTTP 200, full contents read). External guidance is not vendored in-repo; this prototype is aligned by reading the actual contents, but production compliance should be rechecked as implementation proceeds.

## Required coverage (shown)
- **Populated workspace:** objective/context, one header, single primary action ("Assign work"), one attention queue (decisions/blockers/ready-to-review/running), agents led by identity/role/capabilities/readiness/assignment/outcomes, recent deliverables with openable outcomes, technical details (IDs/exports/access/diagnostics) progressively disclosed.
- **Empty workspace onboarding:** honest empty state (no zero-value counters, no wall of empty panels, no arbitrary blank regions), clear next steps to set objective/create agent/describe assignment/use chat, advanced setup hidden.
- **Agent identity/detail with assignment interaction:** identity/role/capabilities, current assignment and recent outcomes, explicit readiness, assignment form with requirements/done criteria, "Start assignment" fixture interaction showing expected state/feedback and why work cannot start when unavailable (missing model, runner, permission, or required input). Config/IDs/exports progressively disclosed.
- **Result/deliverable presentation:** execution summary, persisted deliverable ready/openable, preview, and technical run details progressively disclosed.
- **Representative mobile and dark states:** mobile-prioritized layout/actions (not desktop cards stacked), dark theme for same product language.

## Observed problems addressed (direction)
- **One workspace title/header:** single page header per view; no repeated title inside overview cards/panels.
- **One primary action hierarchy:** one primary CTA in context ("Assign work" / "Set objective" / "Start assignment" / "Use in next step"); "Open chat" demoted to secondary/quiet where present; repeated "Open chat/Open work" controls removed.
- **One attention queue:** unified "Attention" list instead of duplicate attention/next-action panels.
- **No wall of large empty panels or zero-value counters:** empty workspace uses guided steps and honest copy; no decorative metrics.
- **No arbitrary blank vertical regions:** content grouped by purpose with consistent spacing/dividers.
- **Fewer nested containers; clearer typography and grouping:** sectioned layout, border/divider rhythm instead of card-in-card stacks; restrained surfaces.
- **Agents led by identity, role, capabilities, assignment, and outcomes:** avatar/name/role/status, capability tags, "Now/Last outcome/Why unavailable", not config/resource-first.
- **Configuration/raw IDs/exports/access/diagnostics progressively disclosed:** `<details>` sections keep useful information available without dominating primary flow.
- **Mobile intentionally prioritized:** simplified nav, single-column flow, full-width primary action, compressed metadata.
- **Readable controls, visible focus, accessible contrast, reduced motion:** visible focus outlines, semantic controls/labels, restrained palette with contrast-aware tokens, `prefers-reduced-motion: reduce` disables transitions/animations.

## Interaction changes (prototype direction vs current R1–R3 production evidence)
**Before (reference):** `docs/audit-evidence/r1-r3-handoff/screenshots/` (captured 2026-11-10, isolated fixtures), especially `03-workspace-overview-populated-desktop-light.png`, `04-workspace-overview-empty-desktop-light.png`, `06-agent-detail-config-desktop-light.png`, `08-task-detail-execution-progress-fixture-desktop-light.png`, `15-library-deliverable-detail-desktop-light.png`, `18/19` mobile, `21/22` dark.

| Area | Current (observed) | Prototype direction |
|---|---|---|
| Workspace header/actions | Multiple competing entry points/controls and repeated navigation affordances can dilute intent | Single title/context header; one primary action per state; secondary actions quiet |
| Attention/next actions | Attention and navigation/work entry points can feel split/duplicative | One prioritized attention queue with clear status and next action per item |
| Empty states | Risk of empty panels/low-value scaffolding in dashboard-like layouts | Honest onboarding with purposeful next steps; no zero counters/panel walls |
| Agents | Often presented as configurable resources/lists with technical emphasis | Presented as actors: identity, role, capabilities, readiness (configured vs ready/running/blocked/unavailable), current assignment, recent outcomes |
| Assignment | Assignment/execution narrative fragmented across surfaces | Explicit assignment interaction with prerequisites/readiness, "why work cannot start" messaging, and path to execution/outcome |
| Outcomes/deliverables | Outcomes distributed across tasks/artifacts/library/gallery | Outcome-first presentation: execution summary + persisted deliverable + open action + technical details disclosed progressively |
| Density/containers | Nested cards/containers and admin density in places | Fewer containers, clearer grouping/typography, progressive disclosure for technical detail |
| Mobile/dark | Representative but not consistently prioritized as primary flows | Mobile-first prioritization of queue/action/identity; same language in dark theme |

## What this prototype does not claim
- No production routes, backend contracts, permissions, provider semantics, or Phase 1–9 behavior changed.
- No live/real agent execution performed or fabricated; assignment/execution states are fixture interactions.
- Not visual acceptance of production implementation. Build/smoke tests are not visual acceptance.
- Unified deliverables aggregation, canonical workspace mission persistence, and authoritative availability remain product/backend gaps to address in implementation planning where needed.

## Screenshots (after/prototype)
Located in `docs/prototypes/ui-direction-2026-11-10/screenshots/`:
- `after-01-workspace-populated-desktop-light.png`
- `after-02-workspace-empty-desktop-light.png`
- `after-03-agent-detail-assignment-desktop-light.png`
- `after-04-agent-assignment-interaction-desktop-light.png`
- `after-05-execution-outcome-deliverable-desktop-light.png`
- `after-06-mobile-representative-light.png`
- `after-07-workspace-populated-desktop-dark.png`
- `after-08-workspace-empty-desktop-dark.png`
- `after-09-agent-detail-assignment-desktop-dark.png`
- `after-10-execution-outcome-deliverable-desktop-dark.png`

## Stop point
**Stopped for visual review before applying this direction throughout production screens.**
