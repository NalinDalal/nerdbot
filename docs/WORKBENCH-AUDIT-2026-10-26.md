# Workbench audit — 2026-10-26

Scope: the workspace workbench (`dashboard/src/views-workbench.tsx`), its shared
design system (`components.tsx`, `styles.css`, `tailwind.config.js`), its pure
rules (`workbench.ts`), and the browser specs that prove it.

## Verification

| Check | Command | Result |
|------|---------|--------|
| Lint | `npm run lint` | pass, 0 warnings |
| Types | `npx tsc --noEmit` | pass |
| Build | `npm run build` | pass (898 kB JS / 40 kB CSS) |
| Unit | `npm test` | 126 passed / 13 files |
| Browser | `npx playwright test` | 4 passed (1 responsive + 3 state specs) |

The build prints a >500 kB chunk warning. It is a pre-existing size warning,
not an error; splitting the xterm and bot-face chunks is the obvious next win.

## Findings fixed

### 1. Font sizes silently dropped across the whole dashboard

337 occurrences used `text-[var(--step-*)]`. Tailwind resolves that arbitrary
value as a **color** utility, so the generated rule was:

```css
.text-\[var\(--step-minus-2\)\] { color: var(--step-minus-2); }
```

Every element therefore inherited the body size (18.4 px), and the fluid type
scale existed only in the token block. Replaced every occurrence with the
configured `text-step--3 / --2 / --1 / 0 / 1 / 2 / 4` utilities. Verified in the
browser: panel titles now compute at 12.98 px, body at 17.2 px, headings at
their intended steps.

Added `--step-minus-3` (micro/count text) and its Tailwind size, replacing the
12 remaining `text-[10px]` one-offs.

`docs/DESIGN.md` now documents the scale and forbids `text-[var(--step-*)]` so
the bug cannot be reintroduced by copying an old class.

### 2. Shared form constants won the cascade

`FORM_INPUT` / `FORM_SELECT` carry their own padding and font size, so appended
`py-0` and `text-step-*` lost. The project selector and the file/command inputs
were 18.4 px inside a 24 px box, clipping the selected value. Fixed with
`!py-0` / `!text-step--*` at the four call sites, plus `min-w-[10rem]` on the
project select so a short name never collapses it.

### 3. Terminal header overflowed at 1280

The panel header's title/meta group could not shrink, so `Terminal` + `Connected`
clipped by 32 px. The header is now `flex-1 min-w-0` with an `overflow-hidden`
meta wrapper and a truncating status label. Measured: zero leaks at 1280.

### 4. Inconsistent status vocabulary

`StatusBadge` had its own local label map and `runStatusLabel` had another;
`queued`, `stopped`, `expired`, and `active` were missing or disagreed. One
`statusLabel` map now backs `taskStatusLabel`, `runStatusLabel`, and
`StatusBadge`, with tone derived from the same `statusTone` helper. A neutral
`Badge` also rendered a dot with no color, making it invisible; neutral badges
now omit the dot and named tones get their color.

### 5. Missing states and unsafe affordances

- Files, Bots, Changes, Terminal, and run context each render loading
  (`LoadingState`), empty (`PanelEmpty`/`EmptyState`), and error (`ErrorState`)
  states; `LoadingState` is now `role="status"` and `ErrorState` is
  `role="alert"` so the states are announced.
- "Workspace not found" and "Not a Git repository" empty states now offer an
  **Open project** action instead of being dead ends.
- Run is disabled while a live run owns the workspace, with a toast if it is
  invoked anyway — no more two tasks writing the same checkout.
- Mobile: tabs, inputs, shared `Button`, icon buttons, and panel headers meet a
  44 px touch target below `lg`.

### 6. Dead code removed

- `styles.css`: `.muted`, `.text-soft`, `.faint-text`, `--max-width-narrow`
  (all unreferenced).
- `dashboard/screenshot.test.ts`, `tests/workbench-screenshot.spec.ts`,
  `tests/dom-audit.spec.ts`, `tests/debug.spec.ts` — duplicated/broken
  scaffolding superseded by the two specs below.
- `playwright.config.ts`: `reuseExistingService` → `reuseExistingServer`
  (the typo meant the dev server was never reused).

Left in place deliberately, with their intent documented in code/tests:
`tourLook`, `HUMEURS`, `POUR_TESTS`, `isDefaultFace` (bot parity API), and
`ExecutionRollup` / `taskApprovalStates` (outside the workbench surface).

## Evidence

- `dashboard/tests/workbench-responsive.spec.ts` measures the document and
  every non-scrolling element at 1440/1280/1024/768/640/390/375, and clicks
  each of the four mobile panes at widths below 1024.
  Report: `dashboard/out/audit/responsive.json` — 23 measurements, 0 leaks.
  Screenshots: `dashboard/out/screenshots/workbench-<width>x900.png`.
- `dashboard/tests/workbench-states.spec.ts` mocks the API to prove the empty,
  loading, and error states (including terminal failure and a run whose task
  view cannot be read).
- `dashboard/src/workbench.test.ts` covers the pure rules (initial file,
  next file, diff counting, shortcuts, terminal labels).

## Residual risks

- The Tailwind config overrides the default spacing scale for keys 1–24
  (`p-3` = 8 px, `h-8` = 24 px). This is internally consistent but surprising
  to anyone expecting stock Tailwind; renaming it is a larger migration.
- `useAsync` keeps last-good data across key changes; the workbench tags
  workspace responses with `projectId` to prevent cross-project rendering, but
  other surfaces should adopt the same tag before reusing the hook.
- The >500 kB chunk warning noted above.
