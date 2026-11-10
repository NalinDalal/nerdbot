# NerdBot IA Decision (Stage A → Stage B handoff)

Status: **approved direction, implementation in progress** (P0 verification + IA resolved before redesign).  
Sources of truth: `docs/PRODUCT-REDESIGN-SPEC.md` (product direction, as provided by user), `NERDBOT_STAGE_A_AUDIT` findings in conversation (current-state assessment), and current implementation in repo.

## Goals and constraints

- Preserve all working functionality (including Phase 4 library/gallery and Phase 5 conversation management/jobs polish). Move, do not delete.
- Resolve navigation and concept placement before Stage B visual redesign work.
- Keep backend contracts, project isolation, provider bindings, approvals/permissions enforcement, and truthful execution states intact.
- No fabricated progress/activity; no frontend-only permission enforcement.

## Primary navigation (approved)

1. **Chat** — global entry and conversation workspace (project-optional by default).
2. **Workspaces** — sustained work contexts (projects) and their files/tasks/knowledge/assets/automation.
3. **Team** — people/agents you work with (individual agents and coordinated groups).
4. **Activity** — execution, jobs, schedules/reminders, and attention items requiring action.
5. **Library** — durable documents/notes/reports and saved knowledge artifacts.
6. **Settings** — global configuration, providers/credentials, permissions/autonomy, integrations, diagnostics.

This is **six** primary destinations (not reduced to five). Rationale: **Library** is a first-class, user-facing destination in the current product (Phase 4) with distinct jobs (save, organize, edit, version, export, reference documents/reports) that are not equivalent to Chat (ephemeral/interactive), Workspaces (context container), or Activity (execution state). Keeping it primary preserves discoverability and avoids burying a completed capability inside contextual tabs.

## Concept resolutions

| Concept pair/question | Decision | Why | Where it lives |
|---|---|---|---|
| **Projects vs Workspaces** | **Workspace is the user-facing term.** "Project" remains the internal/domain/storage identifier and API concept. | Reduces jargon and matches the "place to do sustained work" mental model while preserving backend contracts/routes/data. | Primary: **Workspaces** (`/projects` route retained/aliased as workspace index; workspace detail `/p/:id`). UI copy prefers "Workspace"; internal IDs/fields may remain `project_*`. |
| **Global vs project Chat** | **Chat is global by default, with explicit scope.** A conversation can be Home/default-scoped or Workspace-scoped; scope is always visible and changeable only via explicit move (preserving Phase 5 semantics: move clears workspace-scoped provider binding). | Supports "start immediately" and "resume sustained work" without forcing project-first navigation. | Primary: **Chat**. Workspace detail may include a contextual **Chat** tab/view filtered to that workspace, but canonical conversation management lives in Chat. |
| **Activity vs Work** | **Activity is the user-facing destination name.** "Work/Jobs/Tasks" are content sections within Activity, not separate top-level destinations. | Unifies execution monitoring (task runs, research jobs, schedules, reminders, approvals-needed attention) in one place and avoids `/work` vs `/activity` duplication. | Primary: **Activity** (`/activity` canonical; `/work` compatibility redirect retained). Sections: Needs attention, Running, Queued/Scheduled, Completed/Failed; unified Jobs + task/run drill-down. |
| **Team vs Teams** | **Team is the primary destination label; Teams are a coordination construct within it.** Individual agents/bots and groups/teams are managed under one people/agent area. | Users think in terms of "who can help me" (agents) and "how they coordinate" (teams/groups). Avoids duplicate top-level concepts. | Primary: **Team**. Subsections/views: Agents (directory/detail), Teams/Groups (directory/detail), assignments/capabilities/memory as contextual. Existing routes (`/bots`, `/teams`) preserved as deep links/compatibility and progressively consolidated. |
| **Boards** | **Contextual/Advanced within Workspace (and optionally Team coordination), not primary.** | Boards overlap tasks/teams/workspace execution containers in current UX; valuable for structured workflows but not a universal starting point. | Advanced/contextual: Workspace detail (e.g. Boards tab/section) and/or Team coordination view; existing `/boards*` routes preserved. |
| **Approvals** | **Canonical resolution in Activity ("Needs attention") with contextual surfaces where decisions block work.** Dedicated approvals view remains accessible as deep link/advanced page. | Approvals are execution blockers/decisions, so they belong with attention flow; users also need to resolve them inline from task/run contexts. | Primary surfacing: **Activity**. Contextual: Chat/task/run banners or panels. Preserved routes: `/approvals` (and inbox APIs). |
| **Workbench** | **Advanced/power-user contextual tool within Workspace, not primary.** | Workbench is a dense execution/file/terminal surface useful for some workflows but not the default mental model for most users. | Workspace contextual/Advanced: open from Workspace (and deep link `/workbench` preserved). |
| **Capabilities** | **Advanced diagnostics/configuration within Settings, not primary.** | Capabilities are system introspection/reference, not a frequent user job. | Settings > Advanced/Diagnostics (route `/capabilities` preserved as deep link). |

## Additional placements (preserve & contextualize)

| Feature/capability | Placement | Notes |
|---|---|---|
| **Library (docs/versions/export/access/save flows, Phase 4)** | Primary **Library** + contextual "Save to Library" / "Insert reference" affordances in Chat and Workspace. | Preserve all implemented Phase 4 behavior, provenance/taint indicators, and permissions/access controls. |
| **Gallery/assets (Phase 4)** | Within **Workspace** (and attach/reference flows in Chat/Library as supported). May appear as a Library-adjacent filter/view if useful later, but not a separate primary destination. | Preserve upload/preview/storage metadata/manage behavior. |
| **Conversation management (Phase 5)** | Primary **Chat**: rename, pin, archive/unarchive, safe soft-delete, restore path, move (explicit, clears provider binding), export, search/filter, recents, scope clarity. | No data-loss semantics changes; make restore and move side effects explicit in UX. |
| **Unified Jobs (Phase 5/polished)** | Primary **Activity**: task runs, research jobs, schedules, reminders with statuses/timestamps/drill-down/actions/links/empty-error states. | Keep source-specific actions truthful; link to source chat/task/doc/workspace. |
| **Research jobs & reports** | Created/observed from **Chat** and/or **Activity**; durable reports saved to **Library**. | Preserve cancel/retry/events/stream and citation/report behavior. |
| **Schedules & reminders** | Configured contextually (Workspace/Agent/Settings as applicable) and monitored in **Activity**. | Preserve manual-trigger/operational semantics where they exist; make them explicit. |
| **Providers/models/credentials** | Global defaults in **Settings**; workspace-specific bindings visible in **Workspaces** where required by existing contracts. | Preserve encrypted secret handling and project-scoped provider binding rules. |
| **Memory & skills** | **Team/Agent** detail and **Settings** (global/reusable) as appropriate; contextual use in Chat/Activity. | Preserve scopes, provenance, permissions, and existing APIs. |
| **Knowledge sources/RAG, files/terminal/diffs/artifacts** | **Workspace** contextual surfaces. | Preserve isolation, path safety, and approval gates. |
| **Backup/metrics/events/notifications/webhooks/integrations** | **Settings > Advanced/Diagnostics/Integrations** (and Activity for notification outcomes where relevant). | Preserve operational controls; avoid exposing internals as primary UX. |

## Route and compatibility strategy (implementation guidance)

- Keep existing routes and deep links working during migration (`/`, `/chat*`, `/projects`, `/p/:id*`, `/bots`, `/teams`, `/boards`, `/activity`, `/work` redirect, `/library*`, `/gallery`, `/settings`, `/approvals`, `/capabilities`, `/workbench`, etc.).
- Introduce canonical routes/aliases aligned to IA incrementally (e.g. workspace naming in UI, Library as primary nav target) without breaking bookmarks or backend contracts.
- Progressive consolidation: prefer shared views/components and contextual embedding over feature removal.

## Stage B implications (design foundation)

- One shell supporting 6 primary destinations + responsive/mobile behavior + Advanced disclosure.
- Shared tokens/components for typography, spacing, light/dark themes, nav, buttons/inputs/tabs/menus/dialogs/popovers, lists/timelines, empty/loading/error states, notifications/status feedback.
- One reusable teammate avatar/animation system (building on existing bot face engine) with reduced-motion respect.
- Apply `skills/ui/ui-core/SKILL.md`, `skills/ui/house-style/SKILL.md`, and impeccable command quality bar; avoid generic dashboard styling/unnecessary cards/excessive borders/decorative gradients/inconsistent components.

## Open implementation notes (to resolve during slices)

- Exact placement of **Gallery** (Workspace section vs Library-adjacent view) based on user workflows; keep capability intact.
- How to present **Boards** within Workspace without reintroducing nav sprawl.
- Approval inbox UX: integrate into Activity by default while retaining `/approvals` as a focused view/deep link.
- Terminology migration ("Project" → "Workspace") across UI copy, docs, and tests without breaking selectors/contracts unnecessarily.
