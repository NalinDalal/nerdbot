# Implementation Plan

> Status snapshot updated 2026-11-10 (Stage A). Earlier P0–P4 items are historical
> intent; many have partial/complete implementations, but end-to-end verification
> and UX coherence remain uneven. Do not treat this as a live backlog without
> cross-checking current code/tests.

## Historical priorities (P0–P4)
- P0: fix contradictory status, truncation, raw IDs on primary surfaces. **Partially addressed** (shared status labels/tones, some ID hiding), residual raw IDs/consistency issues remain.
- P1: Home/Work/task/agent details request→result. **Largely implemented** across chat, task/work, agent/workspace surfaces; quality/clarity varies.
- P2: 5-dest nav, settings, contextual workspaces. **Implemented in current shell** (Chat/Workspaces/Team/Activity/Settings + Advanced drawer/mobile bottom nav), but IA/journey complexity persists.
- P3: orchestration, delegation, durable state, permissions. **Implemented foundations present**; execution reliability/recovery follow-ups remain (see `NERDBOT_PHASE9_STAGE_A.md`).
- P4: integrations, scheduling, notifications, polish. **Implemented in parts** (providers, search/research, schedules/reminders/jobs, outbox/notifications, library/gallery), with manual-trigger/operational and verification caveats.

## Recently completed (preserve; include in audits)
- Phase 4 library/gallery polish and flows — `bdc0a94` (**local, not pushed**).
  Implementation complete; targeted tests passed 2026-11-10 (`tests/test_phase4_library_gallery.py`, `tests/test_phase4_integrations.py`).
- Phase 5 conversation management and unified Jobs polish — **working tree, uncommitted**.
  Implementation complete; targeted tests + dashboard `tsc` passed 2026-11-10.
  Not end-to-end/browser-verified in this pass.

## Stage A (current gate — before visual redesign)
1. Audit all roadmap phases and identify genuinely unfinished work. **Done (this pass).**
2. Produce backend capability inventory. **Done.**
3. Produce frontend accessibility audit. **Done.**
4. Identify broken, duplicated, and confusing user journeys. **Done.**
5. Propose final product information architecture. **Done (proposal).**
6. Present prioritized implementation plan. **Done (proposal).**

**Next concrete step:** review Stage A findings, decide scope/sequence, then authorize redesign/implementation work (no visual redesign started).
