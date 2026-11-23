# Nerdbot Design System Reference

*Premium-quality, reference-locked design decisions for the nerdbot dashboard UI.*

> **Primary source foundation:** Editorial monochrome SaaS landing page style + premium fintech website aesthetics.
> **Avoid:** Tailwind defaults (indigo/violet), pure white canvas, averaged palettes, generic AI design patterns.
> **Preserve:** Signature traits from primary reference; adapt everything to nerdbot's audience and constraints.

---

## 1. Color Tokens

| Token | Value | Role | Source Rule |
|-------|-------|------|-------------|
| `--color-background` | `#FAFAF5` (off-white/cream) | Global canvas | Editorial SaaS: warm canvas vs cold pure white; easier on eyes for long sessions |
| `--color-foreground` | `#1E293B` (slate-800) | Primary text | Same style: softer than pure black (#000000); readable at size |
| `--color-muted` | `#64748B` (slate-500) | Secondary text, hints, disabled | Same style; lower contrast than foreground, still accessible |
| `--color-accent` | `#EA580C` (muted amber/orange) | **CTAs only** — primary interactive elements | Fintech style: restrained accent use creates emphasis; never on backgrounds or non-interactive elements |
| `--color-surface` | `#FFFFFF` (white) | Card/panel backgrounds | Standard; contrast against `--color-background` |
| `--color-border` | `#E2E8F0` (slate-200) | Dividers, input borders | Same style palette; consistent, thin |
| `--color-danger` | `#EF4444` (red-500) | Error states, destructive actions | Standard; use sparingly; always with accessible contrast |
| `--color-success` | `#22C55E` (green-500) | Success states, carried-out outcomes | Standard; paired with `--color-accent` for variety |

**Color usage rules:**
- `--color-accent` appears **only** on: primary buttons, active states, focus-visible outlines, status "bad" indicators
- `--color-background` never pure white in hero sections or wide panels — use `--color-background` (the off-white) for those areas
- `--color-muted` on: disabled elements, text smaller than `text-base`, hover/faint labels
- Never use Tailwind's `indigo`, `violet`, `emerald`, `rose` as primary palette colors

---

## 2. Typography Scale

| Token | Value | Line-Height | Usage |
|-------|-------|-----------|-------|
| `--type-display-5xl` | `3.8rem` (≈ 44px) | 1.1 | Page headlines, major section titles |
| `--type-heading-2xl` | `2.25rem` (≈ 36px) | 1.2 | Section titles, card headlines |
| `--type-heading-xl` | `1.875rem` (≈ 30px) | 1.25 | Sub-section titles |
| `--type-heading-lg` | `1.5rem` (≈ 24px) | 1.35 | Heading within components |
| `--type-body-lg` | `1.125rem` (≈ 18px) | 1.45 | Body text, default paragraph size |
| `--type-body` | `1rem` (≈ 16px) | 1.5 | Default body text |
| `--type-sm` | `0.875rem` (≈ 14px) | 1.45 | Meta text, meta information |
| `--type-xs` | `0.75rem` (≈ 12px) | 1.45 | Tooltips, secondary metadata |

**Typography rules:**
- `text-wrap: balance` on all heading/text-wrap classes (`heading-5xl`, `heading-2xl`, etc.)
- `text-wrap: pretty` only on prose body, not on headings or meta text
- Base font family: `Inter`, system-ui, `sans-serif`
- Heading font weight: `semibold` (600)
- Body font weight: `normal` (400)
- Line-height scale: proportional (1.1–1.45), never arbitrary numbers

---

## 3. Component Specifications

### 3.1 Buttons

| Variant | Background | Color | Border | Hover | Active | Focus-Visible |
|---------|-----------|-------|--------|-------|--------|--------------|
| **Primary** | `--color-accent` (`#EA580C`) | White (`#FFFFFF`) | None | `transform: translateY(-1px) scale(1.01)` + transition 150ms ease | `transform: translateY(0) scale(0.99)` | `outline: 2px solid var(--color-accent);` `outline-offset: 2px` |
| **Secondary** | `transparent` | `--color-foreground` | `2px solid var(--color-border)` | `background: var(--color-background)` + transition | `background: var(--color-muted)` | `outline: 2px solid var(--color-muted);` `outline-offset: 2px` |
| **Link** | `transparent` | `currentColor` (varies) | None | `text-decoration: underline` + `text-underline-offset: 4px` | `text-decoration: underline` | `outline: none` |
| **Ghost** | `transparent` | `--color-muted` | None | `color: var(--color-foreground)` | `color: var(--color-accent)` | `outline: 2px solid transparent` |

**Button CSS (shared):**
```css
button {
  transition: var(--transition-fast, 150ms ease);
  cursor: pointer;
  font-family: var(--font-body, "Inter", system-ui, sans-serif);
  font-weight: 500;
}

button:focus-visible {
  outline: 2px solid var(--focus-outline-color, var(--color-muted));
  outline-offset: 2px;
}
```

### 3.2 Badges / Pills

| Style | Background | Color | Border | Shape | Usage |
|-------|-----------|-------|--------|-------|-------|
| **Default** | `var(--color-surface)` | `--color-foreground` | `1px solid var(--color-border)` | Pill (`rounded-full`) | General status, tags |
| **Secondary** | `var(--color-surface)` | `--color-muted` | `1px solid var(--color-border)` | Pill | Muted info, secondary status |
| **Accent** | `var(--color-accent)` with 10% opacity | White (`#FFFFFF`) | None | Pill | Primary CTA-like badges (rare) |
| **Danger** | `#FEE2E2` (red-100) | `--color-danger` | None | Pill | Error, failed states |
| **Success** | `#DCFCE7` (green-100) | `--color-success` | None | Pill | Success, carried-out outcomes |

**Badge CSS:**
```css
.badge {
  display: inline-flex;
  align-items: center;
  padding: 0.25rem 0.75rem;
  font-size: var(--type-sm);
  font-weight: 500;
  border-radius: var(--radius-lg, 0.5rem);
  line-height: normal;
}
```

### 3.3 Empty States

| Element | Content | Style |
|---------|---------|-------|
| **Illustrative element** | Geometric shape (rounded rect + subtle gradient) or simple diagram | `bg-[var(--color-background)]` with `max-w-md`; centered |
| **Headline** | Short, directive headline | `--type-heading-xl`; `text-[var(--color-foreground)]` |
| **Subheadline** | Brief explanatory text | `--type-body`; `text-[var(--color-muted)]` |
| **CTA button** | Secondary action | `Button` variant `secondary` |
| **Spacing** | Vertical rhythm | `mt-6` below headline, `space-y-2` between headline + subhead + button |

**Empty state CSS container:**
```css
.empty-state {
  min-height: 200px;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  text-align: center;
  padding: 3rem 1rem;
}
```

### 3.4 Data Tables

| Feature | Style |
|---------|-------|
| **Table container** | `overflow-x: auto;` `rounded-lg` `shadow-sm` `mt-4` |
| **Header row** | `bg-[var(--color-background)]` `text-[var(--color-muted)]` `text-xs` `font-medium` `uppercase tracking-[0.1em]` |
| **Row striping** | `even:bg-[var(--color-surface)]` (alternating row colors) |
| **Hover row** | `hover:var(--color-background)` on `odd` rows; `hover:bg-[var(--color-surface)]` on `even` rows |
| **Focused row** | `ring-2 ring-[var(--color-accent)] ring-offset-background` when `tr:focus-visible` |
| **Cells** | `py-3` `px-4` `text-[var(--color-foreground)]` `text-sm` |
| **Actions column** | Right-aligned; contains buttons with compact padding |

### 3.5 Modals

| Aspect | Specification |
|--------|--------------|
| **Overlay** | `fixed` `inset-0` `bg-black/30` `backdrop-blur-sm` `z-50` |
| **Modal box** | `fixed` `right-0 top-0 left-0 bottom-0 max-w-lg` `mx-auto` `bg-[var(--color-surface)]` `rounded-lg` `shadow-lg` `z-50` `overflow-y-auto` |
| **Padding** | `p-6` consistently on all sides |
| **Header** | `flex items-between justify-between mb-4` `border-b border-[var(--color-border)]` `pb-4` |
| **Labels** | `block mb-2` `font-medium` `text-[var(--color-foreground)]` `text-sm` |
| **Inputs/Selects** | `w-full` `mt-1` `block` `padding` `py-2` `px-3` `border` `border-[var(--color-border)]` `rounded` `focus:border-[var(--color-accent)]` `focus:outline-none` |
| **Error text** | `mt-2 text-sm text-[var(--color-danger)]` `block` |
| **Actions bar** | `mt-6` `flex justify-end gap-3` `pt-6` `border-t border-[var(--color-border)]` |

### 3.6 Status Indicators (Dots/Badges)

| Status | Color | Background | Shape | Example |
|--------|-------|-----------|-------|---------|
| **Running** | `--color-accent` | `--color-surface` | Circle or pill | `●` running |
| **Blocked** | `#FCA5A5` (red-300) | White | Pill | `⛔` blocked |
| **Awaiting approval** | `#FBBF24` (amber-300) | White | Pill | `⏳` pending |
| **Done** | `--color-success` | White | Pill | `✓` done |
| **Idle** | `--color-muted` | White | Pill | `•` idle |

---

## 4. Motion & Micro-Interaction Rules

| Property | Value | When Used |
|----------|-------|-----------|
| `--transition-fast` | `150ms ease` | Button hover, focus-visible, card hover, accordion open/close |
| `--transition-slow` | `300ms ease-out` | Page transitions, modal open/close (if built) |
| **Hover scale** | `transform: scale(1.01)` + `translateY(-1px)` on buttons, interactive cards | Creates "lift" feedback without being cartoonish |
| **Focus-visible** | `outline: 2px solid var(--color-accent);` `outline-offset: 2px;` | All focusable elements (buttons, inputs, selects, tabs) |
| **Reduce motion** | `@media (prefers-reduced-motion: reduce) { * { transition: none !important; } }` | Respect user preferences; disable all non-essential transitions |
| **Hover intent** | No auto-dismiss on hover for dropdowns/menus; require `mousedown` or explicit action | Accessibility best practice |

**Motion rules:**
- Always set `transition-behavior: allow-when-anchored;` when animating transform of elements that might be anchor targets
- Never animate `color` or `background-color` on focus-visible (use `outline` instead)
- Use `opacity` and `transform` for most animations; avoid `left`/`top`/`width`/`height` when possible
- Set `animation-duration` to at least 150ms; nothing faster feels "snappy" in a productive tool

---

## 5. Spacing & Layout Rhythm

| Token | Value | Usage |
|-------|-------|-------|
| `--space-0` | `0` | No margin/padding |
| `--space-1` | `0.25rem` (4px) | Tight spacing |
| `--space-2` | `0.5rem` (8px) | Default compact spacing |
| `--space-3` | `0.75rem` (12px) | Standard spacing |
| `--space-4` | `1rem` (16px) | Section spacing, card padding |
| `--space-6` | `1.5rem` (24px) | Large section gap, empty state margin |
| `--space-8` | `2rem` (32px) | Page max-width margin |

**Layout rules:**
- `max-w-2xl` (28rem) `mx-auto` for centered content sections
- `space-y-6` for vertical rhythm between unrelated elements
- `space-x-6` for horizontal rhythm between related items
- `mx-auto` on any full-width container that should be bounded
- `px-4` / `px-6` on inner content within bounded sections

---

## 6. Component Decision Ledger (for implementation)

| Decision | Source (reference) | Rule to preserve | Why |
|----------|-------------------|------------------|-----|
| **Canvas `--color-background`** | Editorial SaaS style | Off-white/cream, NOT pure white (#FAFAF5 not #FFFFFF) | Warmer for long sessions; distinguishes from generic white dashboards |
| **Accent `--color-accent`** | Fintech style | Used ONLY on CTAs, never on backgrounds or non-interactive elements | Rarity creates emphasis; prevents "accent creep" collapsing the palette |
| **Radius `--radius-lg`** | Consistent across components | `0.5rem` uniform across all cards, buttons, modals, inputs | Uniformity; avoids "mixed radius" generic look |
| **Typography scale** | Craft reference | Proper hierarchy: `text-xs → text-3xl` with `text-wrap: balance` on headings | Readability; prevents the "all caps/same size" AI-slop look |
| **Micro-motion** | Premium UI standard | `150ms ease` on interactive states; `focus-visible` outlines; `prefers-reduced-motion` respect | Polished feel without distraction; accessibility |
| **Data table striping** | Current + premium SaaS pattern | `even: bg-[var(--color-surface)]` + `hover` states | Scannability without visual overload |
| **Empty state** | Craft + design system | Headline + subheadline + secondary CTA; illustrative geometric element | Guides user on what to do next, not just informs "nothing here" |
| **Badge/pill shape** | Consistent across status types | `rounded-full` uniform; color only on `accent`/`danger`/`success` | Predictable scannability |

**Implementation rule:** Before shipping any visual change, verify against this ledger. If a choice has no source, research or remove it. Do not average preferences into a "safe middle."

---

## 6. Quick-Start Implementation Checklist

**Start here (no breaking changes):**

- [ ] Add CSS variables to `dashboard/src/index.css` (or Tailwind config) per the token section
- [ ] Update `Button` component to use `--color-accent` primary, consistent hover/focus states
- [ ] Create `EmptyState` component with headline + subhead + secondary CTA pattern
- [ ] Add striped rows + hover states to any data tables in the codebase
- [ ] Standardize `Badge`/`StatusDot` component to pills with uniform `--radius-lg`
- [ ] Add `focus-visible` outlines to all interactive elements that lack them
- [ ] Replace generic "No X yet" messages with the EmptyState component where appropriate
- [ ] Set `transition: 150ms ease` as `--transition-fast` and apply to buttons, cards, inputs
- [ ] Verify color contrast: `--color-foreground` (`#1E293B`) vs `--color-background` (`#FAFAF5`) meets WCAG AA

**After quick wins, iterate:**

- [ ] Refine typography scale across all text elements (headings, body, meta)
- [ ] Add micro-motion to modal open/close, form interactions
- [ ] Review and polish all status badges, status dots across the product
- [ ] Audit and improve data table presentations in tasks, projects, teammates views
- [ ] Final pass: verify no Tailwind defaults (indigo/violet) remain as primary colors

---

## 7. References That Informed This System

| Reference | What It Contributed |
|-----------|---------------------|
| **Editorial monochrome SaaS landing** (style search) | Canvas color, typographic hierarchy, restraint with accent, product-screenshot panels |
| **Premium fintech website** (style search) | Disciplined accent use, product panel treatment, dark technical style as option |
| **Developer tool website** (style search) | Product screenshots in frames, thin borders, compact information density, no gradients |
| **Linear changelog dark** (style search) | Developer tool aesthetic, dark mode, typography hierarchy |
| **Craft references** (typography.md, color.md, motion.md) | Type scale foundation, color token roles, motion rules |
| **Nerdbot existing code** | Functional structure, component hierarchy, existing Tailwind classes |

---

## Implementation Priority

1. **Week 1:** CSS variables + token approach + quick wins (buttons, badges, empty states, tables)
2. **Week 2:** Typography rhythm across all text elements + micro-motion application
3. **Week 3:** Full component audit + polish inconsistent areas + accessibility verification
4. **Ongoing:** Reference-lock each new visual decision against the ledger above

---

*This design system is living — update the ledger whenever a major visual decision is made, and ensure every team member understands the "why" behind each token rule. The goal is not to clone a reference but to synthesize a unique direction adapted to nerdbot's audience, constraints, and workflow.*