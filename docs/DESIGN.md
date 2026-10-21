# Nerdbot Design System

## 1. Visual theme and atmosphere

Dark, calm, focused. Single-owner personal AI workspace running on `http://localhost:8080`.
Density: comfortable (body under 65ch, generous macro whitespace). Variance: low — one accent
color, one gray family, one radius scale. Motion character: fast, physical, quiet, purposeful;
micro only, nothing loops, exits faster than entrances.

## 2. Color palette and roles

| Role | Token | Hex | Function |
|------|-------|-----|----------|
| Canvas | `--bg` | #0a0d10 | App background |
| Surface | `--surface` | #12181c | Elevated container |
| Surface-2 | `--surface-2` | #192128 | Sub-surface / hover |
| Surface-3 | `--surface-3` | #202a33 | Input / secondary surface |
| Border | `--border` | #242e37 | Hairline separation |
| Border-dim | `--border-dim` | #1c242c | Subtle divider |
| Text | `--text` | #e7ecf0 | Primary body |
| Text-inverse | `--text-inverse` | #071014 | Text on accent |
| Muted | `--muted` | #8b98a5 | Secondary text |
| Faint | `--faint` | #5b6a77 | Labels / captions |
| Accent | `--accent` | #2e9e6b | Primary actions, selected state |
| Accent-dim | `--accent-dim` | rgba(46,158,107,0.10) | Focus ring / selected bg |
| Accent-hover | `--accent-hover` | #3ab078 | Primary hover |
| Danger | `--danger` | #d75f5d | Destructive actions, errors |
| Danger-dim | `--danger-dim` | rgba(215,95,93,0.08) | Error surface |
| Warn | `--warn` | #c98f33 | Warnings |
| Warn-dim | `--warn-dim` | rgba(201,143,51,0.08) | Warn surface |
| Info | `--info` | #5aa9e6 | Informational / streaming |
| Info-dim | `--info-dim` | rgba(90,169,230,0.08) | Info surface |
| Success | `--success` | #2e9e6b | Same as accent |

Constraint budget: one accent (`--accent`), one gray family (cool), no purple/blue AI gradients,
no gradient text, no radial halos.

## 3. Typography

Family: Geist (neo-grotesque, free variable font) for display and body; Geist Mono for data,
labels, captions, code. Inter/system-ui is banned (default-AI tell).

Fluid type scale (`clamp()`):

| Step | Token | Use | line-height | letter-spacing |
|------|-------|-----|-------------|----------------|
| --step-minus-1 | clamp(0.8rem, 0.78rem + 0.1vw, 0.85rem) | caption / meta | 1.4 | 0.05em |
| --step-0 | clamp(1rem, 0.98rem + 0.12vw, 1.125rem) | body | 1.6 | default |
| --step-1 | clamp(1.25rem, 1.15rem + 0.35vw, 1.6rem) | lead / small heading | 1.25 | -0.01em |
| --step-2 | clamp(1.5rem, 1.35rem + 0.6vw, 2rem) | h3 | 1.2 | -0.01em |
| --step-3 | clamp(1.9rem, 1.65rem + 1vw, 2.75rem) | h2 | 1.15 | -0.01em |
| --step-4 | clamp(2.4rem, 1.95rem + 1.9vw, 4rem) | h1 | 1.1 | -0.02em |

Hierarchy in blocks: headline (step-4), sentence (step-0), hint (step-minus-1). Never five sizes
of bold. All-caps labels use positive tracking. Align left; never justify. No em dashes in
visible text.

## 4. Component stylings

**Buttons:** flat or barely rounded (8px), solid contrast, no glow/gradient. Pressed state:
scale 0.98. Focus-visible: 2px accent outline, -1px offset. Variants: default, primary,
danger, ghost. One clear action per screen.

**Inputs:** label above, error below, accent focus ring (3px accent-dim shadow). No
placeholder-as-label, no floating labels.

**Badges:** pastel-adjacent pill, tiny, max one per metadata line. Dot conveys status (ok/bad/warn/info).

**Cards:** only when elevation earns hierarchy. 12px radius. Never cards in cards.

**Dialogs:** surface background, 1px border, 12px radius, Escape closes, backdrop click closes,
focus trapped, exits animated (faster than entrance).

**Empty states:** say what happened and what to do next, with a clear CTA.

**Loading states:** skeleton shimmer shaped like content, not spinners; shimmer only while
loading, never loops after load.

**Error states:** explain what happened and give a recovery action.

## 5. Layout principles

- Shell: 260px fixed sidebar + 1fr main; mobile collapses sidebar (max-height on conversation
  sidebar below 760px).
- `height: 100dvh`, never `h-screen`.
- One layout family per section; grid over flex math; no `calc(33%-1rem)` fractions.
- Content max-width 65ch for reading surfaces; conversation messages max-width 64ch.
- Whitespace does the separating, not borders and shadows.
- Sidebar: no multi-level nested scroll.

## 6. Motion and interaction

Curves: `cubic-bezier(0.16, 1, 0.3, 1)` (ease-out) for arrivals, `cubic-bezier(0.2, 0, 0.38, 0.9)`
for departures. Durations: 200ms in, 150ms out, hover <150ms, press <100ms. Properties:
`transform` and `opacity` only (layout animations stutter). One motion per event. Nothing loops.
`prefers-reduced-motion: reduce` → instant state changes. Exits exist and are faster than
entrances. Animations yield to the next input (CSS transitions over keyframes).

## 7. Accessibility

- Contrast AA at dark theme; status never color-only (dot + text badge).
- Focus-visible indicators on all interactive elements.
- Keyboard: no traps, no mouse-only controls, Escape exits transient states.
- ARIA roles/labels on dialogs, tabs, status badges.
- Touch targets ≥44px.
- Reduced motion respected globally.

## 8. Dark mode

Designed, not inverted: one token set per surface; saturation and shadow adjusted for dark.
No literal white/black classes. Theme matches system on first load (single dark theme shipped).

## 9. Responsive behavior

Seven viewports: 1440, 1280, 1024, 768, 640, 390, 375. Hierarchy changes per class, not just
shrinks: desktop full chrome, tablet reduced secondary chrome, mobile one-column with primary
action first. No horizontal overflow; touch targets 44px minimum.

## 10. Icons

One family, one stroke weight. (No icon library installed yet — use text/symbol fallbacks until
one is added via pick-ui-library.)

## 11. Anti-patterns (banned for this project)

- Purple or blue glow gradients; gradient text; radial halos; gradient buttons.
- Glowing buttons, oversized rounded cards (>30px), three equal feature cards.
- Cards in cards; div-fake product UI; floating blobs; particles; glassmorphism.
- Inter / Roboto as defaults; em dashes in visible text; "Item 1, Item 2" placeholder content.
- Scroll-jacking, parallax, staggered entrances on every load, idle pulses, infinite marquees.
- "Learn More" as the primary CTA; version labels / beta badges unless launching.
- Section-number eyebrows; decorative middle dots; filler words (elevate, seamless, unleash).

## Implementation notes

- Styling: raw CSS with CSS custom properties (tokens). Tailwind not installed; adding it would
  be a dependency change without a concrete need since the token system is already centralized
  in `styles.css` and consumed by class names.
- Fonts: Geist / Geist Mono loaded from Google Fonts in `index.html`.
- Shared primitives live in `components.tsx` (Button, Input, Select, Badge, Card, Dialog) and
  are consumed by `views-chat.tsx` and the route views.
