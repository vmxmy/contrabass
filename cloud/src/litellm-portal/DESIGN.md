---
version: alpha
name: LiteLLM Portal — Kumo Dashboard

description: |
  An institutional AI management dashboard built on Cloudflare Kumo.
  The base canvas is kumo-canvas (off-white); the single brand voltage
  is kumo-brand, used scarcely on primary CTAs, chart strokes, and
  inline accent moments. Type runs system-ui at modest weights —
  headings sit at weight 600 not 700, signaling calm authority.
  Page rhythm rotates between bright white sections, soft gray
  elevation bands (kumo-elevated / kumo-recessed), and full-bleed
  data surfaces. Depth comes from card-on-card layering and
  hairline borders, never decorative shadows.

colors:
  # Brand
  brand: "kumo-brand"
  brand-hover: "kumo-brand-hover"
  chart: "kumo-chart-wave"

  # Surfaces (lightest → deepest)
  canvas: "kumo-canvas"          # Page floor
  base: "kumo-base"             # Card surface
  elevated: "kumo-elevated"     # Card header / soft band
  recessed: "kumo-recessed"     # Embedded data surfaces
  tint: "kumo-tint"             # Hover / active tint
  fill: "kumo-fill"             # Subtle fill, skeletons

  # Text
  ink: "kumo-strong"            # Headings, primary data
  body: "kumo-default"          # Running text
  subtle: "kumo-subtle"         # Labels, captions, meta
  muted: "kumo-inactive"        # Disabled / placeholder

  # Hairlines
  line: "kumo-line"             # 1px dividers on cards
  hairline: "kumo-hairline"     # Subtle 1px, ghost dividers
  border: "kumo-fill"           # Form borders

  # Semantics — TEXT ONLY, never background fills
  success: "kumo-success"       # Healthy, normal, on-track
  warning: "kumo-warning"       # Near limit, caution
  danger: "kumo-danger"         # Over limit, expired, error
  info: "kumo-info"             # Neutral status, badges

  # Semantic tints — for badge/pill backgrounds ONLY
  success-tint: "kumo-success-tint"
  warning-tint: "kumo-warning-tint"
  danger-tint: "kumo-danger-tint"
  info-tint: "kumo-info-tint"

rounded:
  none: 0px
  xs: 4px    # Inline tags, small pills
  sm: 8px    # Compact rows, metric tiles
  md: 12px   # Form inputs, small cards
  lg: 16px   # Standard cards
  xl: 20px   # Feature cards, hero panels
  pill: 100px # Buttons, badges, status pills

spacing:
  # Base unit: 4px
  xxs: 4px
  xs: 8px
  sm: 12px
  base: 16px
  md: 20px
  lg: 24px
  xl: 32px
  xxl: 48px
  section: 80px  # Desktop section vertical gap
  section-mobile: 48px

components:
  # Page shell
  page-shell:
    backgroundColor: "{colors.canvas}"
    textColor: "{colors.body}"
    padding: "48px 16px" # mobile → 80px 40px desktop

  # KPI metric card
  metric-card:
    backgroundColor: "{colors.base}"
    textColor: "{colors.ink}"
    rounded: "{rounded.xl}"
    padding: 20px
    border: "1px solid {colors.line}"
    shadow: none

  metric-card-header:
    typography: "12px / 600 / uppercase / {colors.subtle} / tracking-wider"
    marginBottom: 12px

  metric-card-value:
    typography: "28px / 600 / {colors.ink} / font-mono"
    marginBottom: 8px

  metric-card-meta:
    typography: "14px / 400 / {colors.subtle}"

  # Primary data panel (hero surface)
  data-panel:
    backgroundColor: "{colors.base}"
    rounded: "{rounded.xl}"
    border: "1px solid {colors.line}"
    shadow: none

  data-panel-header:
    backgroundColor: "{colors.elevated}"
    padding: 20px
    borderBottom: "1px solid {colors.line}"

  data-panel-body:
    padding: 24px

  # Embedded metric tile (lives inside data-panel)
  metric-tile:
    backgroundColor: "{colors.recessed}"
    rounded: "{rounded.sm}"
    padding: 16px

  # Chart surface
  chart-surface:
    backgroundColor: "{colors.recessed}"
    rounded: "{rounded.sm}"
    padding: 16px
    border: "1px solid {colors.line}"

  # Table
  table:
    width: 100%
    textAlign: left
    fontSize: 14px
    color: "{colors.body}"
    borderCollapse: collapse

  table-header:
    borderBottom: "1px solid {colors.line}"
    padding: "12px 12px 8px 0"
    fontWeight: 600
    color: "{colors.subtle}"
    fontSize: 12px
    textTransform: uppercase
    letterSpacing: 0.05em

  table-cell:
    borderBottom: "1px solid {colors.hairline}"
    padding: "12px 12px 12px 0"

  table-row-hover:
    backgroundColor: "{colors.tint}"

  # Status pills
  status-pill-success:
    backgroundColor: "{colors.success-tint}"
    textColor: "{colors.success}"
    rounded: "{rounded.pill}"
    padding: "3px 10px"
    fontSize: 12px
    fontWeight: 600

  status-pill-warning:
    backgroundColor: "{colors.warning-tint}"
    textColor: "{colors.warning}"
    rounded: "{rounded.pill}"
    padding: "3px 10px"
    fontSize: 12px
    fontWeight: 600

  status-pill-danger:
    backgroundColor: "{colors.danger-tint}"
    textColor: "{colors.danger}"
    rounded: "{rounded.pill}"
    padding: "3px 10px"
    fontSize: 12px
    fontWeight: 600

  status-pill-info:
    backgroundColor: "{colors.info-tint}"
    textColor: "{colors.info}"
    rounded: "{rounded.pill}"
    padding: "3px 10px"
    fontSize: 12px
    fontWeight: 600

  # Buttons
  button-primary:
    backgroundColor: "{colors.brand}"
    textColor: "white"
    rounded: "{rounded.pill}"
    padding: "10px 20px"
    fontSize: 14px
    fontWeight: 600

  button-secondary:
    backgroundColor: "{colors.elevated}"
    textColor: "{colors.ink}"
    rounded: "{rounded.pill}"
    padding: "10px 20px"
    fontSize: 14px
    fontWeight: 600
    border: "1px solid {colors.line}"

  # Form inputs
  select:
    backgroundColor: "{colors.elevated}"
    textColor: "{colors.ink}"
    rounded: "{rounded.md}"
    padding: "10px 14px"
    height: 40px
    border: "1px solid {colors.line}"

  # Model badge
  model-badge:
    backgroundColor: "{colors.fill}"
    textColor: "{colors.subtle}"
    rounded: "{rounded.pill}"
    padding: "4px 12px"
    fontSize: 13px
    fontFamily: monospace

  model-badge-reasoning:
    backgroundColor: "kumo-badge-red"
    textColor: "kumo-badge-red"

  model-badge-standard:
    backgroundColor: "kumo-badge-blue"
    textColor: "kumo-badge-blue"

  model-badge-embedding:
    backgroundColor: "kumo-badge-green"
    textColor: "kumo-badge-green"

  model-badge-vision:
    backgroundColor: "kumo-badge-purple"
    textColor: "kumo-badge-purple"

---

## Overview

LiteLLM Portal reads like an **institutional AI operations dashboard** — quiet, white-canvas, editorially-spaced, and almost monochromatic. The single brand voltage is **kumo-brand**, used scarcely: chart strokes, primary CTAs, and inline accent links. Beyond that one blue, the system is canvas + ink + soft gray elevation bands + recessed data surfaces.

The page rhythm rotates three modes:
1. **Bright white KPI band** — four metric cards on canvas
2. **Soft gray data panel** — the token-usage hero surface with embedded metric tiles
3. **White information cards** — teams, models, API keys in a grid

**Key Characteristics:**
- Single accent: kumo-brand carries every primary action and chart stroke. Used scarcely.
- Generous editorial pacing — 80px between major bands, 24px inside panels, 20px inside cards.
- Pill geometry for every interactive element; xl-radius for every container card. Sharp corners absent.
- Semantic colors (success/warning/danger) are **text-only** — never used as button or card backgrounds.
- Numbers render in monospace at all times.
- Hairline borders create depth; decorative shadows are forbidden.

## Colors

### Surface Hierarchy
| Token | Kumo mapping | Role |
|---|---|---|
| Canvas | `bg-kumo-canvas` | Page floor |
| Base | `bg-kumo-base` | Card surface |
| Elevated | `bg-kumo-elevated` | Card headers, soft bands, select backgrounds |
| Recessed | `bg-kumo-recessed` | Embedded data surfaces, chart containers, metric tiles |
| Tint | `bg-kumo-tint` | Row hover states |
| Fill | `bg-kumo-fill` | Skeletons, placeholder fills |

### Text Hierarchy
| Token | Kumo mapping | Role |
|---|---|---|
| Ink | `text-kumo-strong` | Headlines, primary numbers, emphasis |
| Body | `text-kumo-default` | Running text, table data |
| Subtle | `text-kumo-subtle` | Labels, captions, meta, secondary numbers |
| Muted | `text-kumo-inactive` | Disabled, placeholder |

### Hairlines
| Token | Kumo mapping | Role |
|---|---|---|
| Line | `ring-kumo-line` / `border-kumo-line` | Card borders, dividers |
| Hairline | `border-kumo-fill` | Subtle table row separators |

### Semantics — TEXT ONLY
| Token | Kumo mapping | Role |
|---|---|---|
| Success | `text-kumo-success` | Healthy budget, normal status |
| Warning | `text-kumo-warning` | Budget >80%, approaching limit |
| Danger | `text-kumo-danger` | Over budget, expired, error |
| Info | `text-kumo-info` | Neutral status, info badges |

### Semantic Tints — BACKGROUND ONLY for pills/badges
| Token | Kumo mapping | Role |
|---|---|---|
| Success tint | `bg-kumo-success-tint` | "正常" status pill background |
| Warning tint | `bg-kumo-warning-tint` | "即将超支" status pill background |
| Danger tint | `bg-kumo-danger-tint` | "超预算" status pill background |
| Info tint | `bg-kumo-info-tint` | Info badge background |

### Ops Fixed Steel — SANCTIONED raw-hex exception
| Token | Value | Rationale |
|---|---|---|
| Ops fixed steel | `OPS_STEEL_BRAND #475569` / `OPS_STEEL_BRAND_HOVER #334155` | SANCTIONED raw-hex exception (§F.6 / V2.0 §1.3): Ops-only fixed brand voltage, Ops ignores tenant branding (Phase-2 invariant). The ONLY approved raw hex; all else via Kumo tokens (guarded). |

## Typography

### Hierarchy
| Token | Size | Weight | Line Height | Use |
|---|---|---|---|---|
| Page title | 28px → 32px desktop | 600 | 1.2 | Platform name |
| Section title | 18px | 600 | 1.33 | Card headers, panel titles |
| Metric value | 28px | 600 | 1.2 | KPI numbers, mono |
| Label | 12px | 600 | 1.4 | uppercase, tracking-wider — metric labels & table headers |
| Body | 14px → 16px | 400 | 1.5 | Descriptions, running text |
| Caption | 13px | 400 | 1.5 | Meta, timestamps |
| Mono data | 14px → 18px | 500 | 1.4 | All numbers, prices, tokens |

### Principles
- **Headings at weight 600**, never 700+. Signals calm authority, not urgency.
- **Every number in monospace** — prices, token counts, budgets, RPM/TPM.
- **Labels are 12px uppercase with tracking-wider** — the single subordinate tier for both metric labels and table headers; visually subordinate without being tiny.
- **Page title uses negative letter-spacing** (`tracking-tight`); body stays at 0.
- **Type scale: 7 tiers.** Largest heading (Page title 32px desktop) : body (16px) = 2.0× — at the V2.0 §1.1 ceiling, intentional for an institutional ops dashboard (mobile 28px : 14px = 2.0× likewise). Weight is unchanged (≤ 600); only the page-title px was lowered to hold the ≤ 2× ratio. Enforced by `a11y/type-scale.test.ts` (reads this table as the token source).

## Layout

### Spacing System
Base unit: 4px.

| Token | Value | Use |
|---|---|---|
| xxs | 4px | Inline gaps |
| xs | 8px | Tight component gaps |
| sm | 12px | Button padding-y, tight card gaps |
| base | 16px | Standard padding |
| md | 20px | Card internal padding |
| lg | 24px | Panel body padding |
| xl | 32px | Section internal gaps |
| xxl | 48px | Major internal spacing |
| section | 80px | Desktop section vertical gap |
| section-mobile | 48px | Mobile section vertical gap |

### Whitespace Philosophy
Generous institutional pacing — closer to a financial dashboard than a devtool.
- 80px between major bands on desktop; 48px on mobile.
- Cards inside bands sit 16–20px apart.
- Card headers get `p-5` (20px); card bodies get `p-5` or `p-6` (24px) depending on content density.

### Grid & Container
- Max content width: container-centered with `px-4` mobile → `lg:px-10` desktop.
- KPI cards: 4-up on xl, 2-up on md, 1-up on mobile.
- Data panel: single full-width hero surface.
- Info grid: `1fr 2fr` on md+ (teams + models), stack on mobile.
- API Keys: full-width, overflow-x-auto for safety.

## Elevation & Depth

| Level | Treatment | Use |
|---|---|---|
| Flat | No shadow, no border | Canvas floor |
| Hairline border | 1px `ring-kumo-line` | Every card outline |
| Elevated band | `bg-kumo-elevated` + bottom border | Card headers, soft section breaks |
| Recessed surface | `bg-kumo-recessed` | Embedded tiles, charts, tables |
| Hover lift | `hover:bg-kumo-tint` | Interactive rows/tiles |

**Shadows are forbidden.** The system uses surface color changes (canvas → base → elevated → recessed) to create depth, never drop shadows.

## Shapes

| Token | Value | Use |
|---|---|---|
| xs | 4px | Inline tags |
| sm | 8px | Metric tiles, compact surfaces |
| md | 12px | Form inputs, select elements |
| lg | 16px | Standard cards |
| xl | 20px | Feature cards, data panels |
| pill | 100px | Buttons, badges, status pills, model tags |

Pill for interactive; xl for containers; sm for embedded tiles. Sharp corners absent.

## Components

### KPI Metric Card
- Background `bg-kumo-base`, rounded `rounded-xl`, padding `p-5`.
- 1px hairline: `ring-1 ring-kumo-line`.
- Top: 12px uppercase label in `text-kumo-subtle` with `tracking-wider`.
- Middle: 28px mono value in `text-kumo-strong`.
- Bottom: 14px meta in `text-kumo-subtle`.
- Optional: colored status dot (brand/info/success) before label.

### Data Panel (Hero Surface)
- Full-width. Background `bg-kumo-base`, rounded `rounded-xl`, ring `ring-1 ring-kumo-line`.
- Header: `bg-kumo-elevated` + `p-5` + bottom border (`border-b border-kumo-line`).
- Body: `p-6`.
- Left column: 6 metric tiles (2×3 grid) + chart + table.
- Right column: top-models list, separated by `md:border-l border-kumo-line`.

### Metric Tile (Embedded)
- Background `bg-kumo-recessed`, rounded `rounded-sm`, padding `p-4`.
- Label: 12px `text-kumo-subtle`.
- Value: 18px mono `text-kumo-strong`.
- Hover: `hover:bg-kumo-tint` for subtle feedback.

### Chart Surface
- Background `bg-kumo-recessed`, rounded `rounded-sm`, padding `p-4`, ring `ring-1 ring-kumo-line`.
- SVG stroke: `text-kumo-chart-wave` (semantic chart color).
- No decorative grid styling beyond hairline rules.

### Time Preset Rail
- Primary usage time control is a native `button` rail, not a Select.
- Render only configured server windows; no arbitrary date ranges in the client.
- Active preset uses `bg-kumo-brand text-kumo-inverse ring-kumo-brand`.
- Secondary grain rail uses `自动` + manual grain chips; invalid manual grains stay disabled.
- Status pill mirrors state as `自动粒度：天` or `手动粒度：小时`.
- Desktop layout: preset rail and grain rail sit side-by-side with `lg:grid-cols-[1fr_auto]`; mobile wraps into stacked rails.

### Table
- Full width, `text-sm text-kumo-default`.
- Header: 12px uppercase `text-kumo-subtle` with `tracking-wider`, `border-b border-kumo-line`.
- Cells: `border-b border-kumo-fill`, right-align for numbers.
- Rows: `hover:bg-kumo-tint`.
- Empty state: centered `text-kumo-subtle`.

### Status Pills
- Success: `bg-kumo-success-tint text-kumo-success` + pill.
- Warning: `bg-kumo-warning-tint text-kumo-warning` + pill.
- Danger: `bg-kumo-danger-tint text-kumo-danger` + pill.
- Info: `bg-kumo-info-tint text-kumo-info` + pill.
- **Never use semantic colors as button or card backgrounds.**

### Model Badges
- Default: `bg-kumo-fill text-kumo-subtle` + pill + mono.
- Reasoning models (gpt-4, claude-opus, deepseek-r1): `bg-kumo-badge-red text-kumo-badge-red`.
- Standard models (gpt-3.5, claude-haiku, deepseek-v3): `bg-kumo-badge-blue text-kumo-badge-blue`.
- Embedding models: `bg-kumo-badge-green text-kumo-badge-green`.
- Vision/multimodal: `bg-kumo-badge-purple text-kumo-badge-purple`.

### Select / Form Input
- Background `bg-kumo-elevated`, text `text-kumo-default`.
- Rounded `rounded-md` (12px), height 40px.
- Border `ring-1 ring-kumo-line`, focus `focus-visible:ring-2 focus-visible:ring-kumo-brand`.
- Usage time controls intentionally avoid Select; reserve Select for create-key model/duration inputs.

## Focus & Accessibility (Phase 3 §A.1)

- The portal-wide focus ring is `focus-visible:ring-2 focus-visible:ring-kumo-brand focus-visible:ring-offset-2 focus-visible:outline-none` (`a11y/focus.ts` `FOCUS_RING`) — the single source for nav links, panel actions and clickable cards. Browser-default outline is no longer relied upon.
- `--kumo-brand` resolves to the tenant brand (Tenant Portal) or fixed steel (Ops). Its non-text contrast (≥ 3:1 WCAG SC 1.4.11) on both the light and dark canvas is enforced by `tenant-portal/branding.ts` for any legal brand.
- Every nav-mapped active navigation link emits `aria-current="page"` (detail routes `$eventId`/`$teamId`/`$userId` have no nav entry → no `aria-current`, by design). The impersonation banner remains `role="alert" aria-live="assertive"` (regression-guarded).
- The rendered usage chart (`dashboard/charts/trend-chart.tsx`) exposes `role="img"` + a locale-driven `aria-label` (built by `buildChartAriaDescription` + the dashboard's `t`-macro template; the chart island stays macro-free) — it had NO accessible name before Phase 3.

### Type-scale manual acceptance (§F.5 / V2.0 §1.1 — Task-10 Step-2 sub-items)

These are human-judgment acceptances run during Task-10 staging review (cross-referenced from the Task-10 Step-2 manual checklist; recorded here as the durable design contract — no automatable assertion):

- **5-second test**: screenshot Tenant `/` (overview) and Ops `/ops` (tenant-overview), light AND dark. Show each to a reviewer for exactly 5s, then hide. The reviewer must, from memory, name (a) the page's primary CTA/action and (b) the main heading. **Pass bar: reviewer correctly names BOTH for all 4 screenshots.** Fail → visual hierarchy not strong enough (revisit §B.1/§B.2 emphasis, NOT the type scale alone).
- **Blur test**: apply heavy Gaussian blur (≈12px) to the same 4 screenshots. The visual centre-of-mass / energy must land on the primary content region (KPI band / hero panel / the tenant table), NOT on chrome/nav/decoration. **Pass bar: blurred focal weight is the content region in all 4.** Fail → de-emphasise chrome / strengthen content surface.

## State Treatments (Phase 3 §A.2)

Every data-panel / card query-state branch uses exactly ONE of four contracts (`components/panel-state.tsx`). Screens MUST NOT hand-write `SkeletonLine`/`Empty`/`Banner variant="error"` for state branches (guard test enforced).

| Contract | Wraps | Use | Shape |
|---|---|---|---|
| `PanelSkeleton` | `SsrSafeSkeleton` (Task 0B; deterministic on SSR + client-first-render, swaps to Kumo `SkeletonLine` post-hydration) — NOT raw Kumo `SkeletonLine` (its unseeded `Math.random` shimmer is a #418 source) | First-paint placeholder | title row (12px) + `lines` content rows (16px), `p-6`, `space-y-3` |
| `PanelEmpty` | Kumo `Empty` size=sm | No rows | required title, optional description/action, centered `py-10` |
| `PanelError` | Kumo `Banner` variant=error | Request failed | title + the humanized message (§F.3): `error.message` is a localized message id resolved via the active i18n, never a raw server code |
| `PanelLoading` | Kumo `Loader` | Inline/partial (buttons, local) | centered `py-6`, `aria-live=polite`, accessible label |

## Error UX Contract (Phase 3 §F.3 / V2.0 §2.4 + §4#6)

Server error CODES never reach the UI. `errors/error-messages.ts` is the single source: `errorMessage(code, …) → localized human message` folding the 3-element rule (what happened · your input is preserved · clear next step). Applied at the SHARED `errors/extract-error.ts` boundary consumed by `tenant-portal/hooks.ts` + `ops-console/hooks.ts`; `PanelError` resolves the id via the active i18n. Unknown codes → a generic safe fallback, NEVER the raw code. Messages MUST NOT leak internal impl (DO names, paths, auth mechanism, stack, snake_case codes, HTTP numbers) — guarded by `errors/error-messages.test.ts`. Adding a new server error code requires adding a mapping (the test's count floor fails CI otherwise).

## Density Scale (Phase 3 §A.2 + §F.1 V2.0 §1.2)

Density is a SHELL decision pushed via `DensityProvider` (`components/density.tsx`); screens read `useDensity()`/`densityClasses()` and never hard-code padding. Names map only to existing spacing tokens — no new numbers. A user preference (`UserPreferences.density`, persisted via the existing preferences channel, SSR-seeded) overrides the shell default via the pure SSR-safe `resolveDensity(pref, shellDefault)` (#418-safe — same channel as the theme toggle).

| Density | Shell default | card | stack | grid | cell (§F.1 table) | row (§F.1 table) |
|---|---|---|---|---|---|---|
| `comfortable` | Tenant Portal (outward, editorial) | `p-6` | `space-y-6` | `gap-4` | `px-4 py-3` | `h-auto` |
| `compact` | Ops Console (inward, B-端 cockpit) | `p-4` | `space-y-4` | `gap-4` | `px-3 py-1.5` | `h-9` (≤36px) |

This is the "同源异质" differentiation on the density axis: §A.2 = the shell-level `p-6`/`p-4` baseline; §F.1 = the B-端 cockpit deepening (compact table cell/row tiers + a user-persisted comfortable↔compact toggle, Tenant stays comfortable). Phase 1/2 had no density difference at all.

## Shell / SideNav (Phase 3 §B.1)

Both shells render one shared `components/side-nav.tsx`; structure is identical, tone differs only by accent + the shell density wrapper.

- **Active/current item:** 2px left accent bar (`bg-kumo-brand` — tenant brand on Tenant, steel on Ops since `OPS_STEEL_ACCENT` sets `--kumo-brand` to steel) + `bg-kumo-tint` + `text-kumo-strong` + `aria-current="page"`.
- **Hover:** `bg-kumo-tint` (normalized — the old `hover:bg-kumo-canvas` was near-invisible on the elevated nav).
- **Icon:** 16px per item, `text-kumo-subtle` at rest, accent color when active (via `currentColor`). Source: hand-authored zero-dependency inline `<svg>` (`components/nav-icons.tsx`) — Kumo@2.1.0 ships NO icon set and `@phosphor-icons/react` is forbidden (C3 / §E-2 resolved); NEVER an icon dependency.
- **Group headings:** 12px uppercase `tracking-wider` `text-kumo-subtle` (Tenant: 我的 / 团队管理; Ops: 租户 / 平台).
- **Focus:** the shared `FOCUS_RING`.
- **Density:** Tenant chrome = comfortable; Ops chrome = compact (shell `DensityProvider`). Hairline is `border-kumo-line` everywhere (the old `border-kumo-default` mis-token is normalized).

## Do's and Don'ts

### Do
- Reserve `text-kumo-brand` for primary CTAs, chart strokes, and inline accent links.
- Set every CTA and badge as `rounded-full` (pill); every card as `rounded-xl`.
- Keep headings at weight 600 max.
- Render every numerical value in `font-mono`.
- Use `bg-kumo-recessed` for embedded data surfaces (tiles, charts).
- Use `bg-kumo-elevated` for card headers and control bands.
- Use `hover:bg-kumo-tint` on interactive rows and tiles.
- Apply semantic colors as **text only**; pair with `-tint` backgrounds for pills.

### Don't
- Don't add drop shadows — the system has zero shadow tiers.
- Don't use sharp corners (`rounded-none`) on any interactive element.
- Don't bold display copy beyond 600.
- Don't use semantic colors (success/warning/danger) as button or card backgrounds.
- Don't mix multiple border styles — `ring-kumo-line` is the standard.
- Don't let cards touch without gap; minimum 16px between adjacent cards.
- Don't use `shadow-xs` — it violates the flat-depth philosophy.

## Responsive Behavior

| Name | Width | Key Changes |
|---|---|---|
| Mobile | < 768px | Single column everywhere; section gap 48px; cards padding 16px; chart height 200px; tables scroll horizontally. |
| Tablet | 768–1024px | KPI 2-up; data panel stacked; info grid stacked; tables scroll. |
| Desktop | 1024–1280px | KPI 4-up; data panel 2fr/1fr; info grid 1fr/2fr; full tables. |
| Wide | > 1280px | Content max-width container; 80px section gaps; 24px panel padding. |

## Iteration Guide

1. New cards default to `bg-kumo-base rounded-xl ring-1 ring-kumo-line`.
2. New headers default to `bg-kumo-elevated p-5 border-b border-kumo-line`.
3. New embedded surfaces default to `bg-kumo-recessed rounded-sm`.
4. New buttons/badges default to `rounded-full`.
5. Hover states use `hover:bg-kumo-tint`, never shadow.
6. Every number gets `font-mono`.
7. kumo-brand stays scarce — one or two brand moments per band.

---

## Kumo 组件集成现状与升级路线

### 当前集成度

Portal 已安装 `@cloudflare/kumo@^2.1.0`，CSS token 体系全面对齐 DESIGN.md 规范，React 岛已经覆盖用量面板、模型、Key 表格、错误提示和创建 Key 弹窗：

| 维度 | 当前使用 | Kumo 可提供 |
|------|---------|------------|
| CSS tokens | 全面覆盖（surface / text / semantic / hairline） | 已对齐，无需改动 |
| React 组件 | `Badge`、`Banner`、`Button`、`Collapsible`、`Dialog`、`Input`、`Loader/SkeletonLine`、`Select`、`Table`、`TimeseriesChart`；用量时间控件使用原生 button rail | Tooltip、Dropdown、Switch、Tabs、Accordion 等后续按需补齐 |
| Base UI Primitives | 未使用 | 37 个无样式可访问原语（Popover、Dialog、Slider 等），可从 `@cloudflare/kumo/primitives/*` 导入做二次封装 |
| 无障碍 | 关键 React 岛使用 Kumo 组件；图表提供 `ariaDescription`；Worker shell 仍保留少量 vanilla DOM 更新 | Kumo 组件开箱处理键盘导航、focus trap/return、ARIA 属性 |
| 暗色模式 | 已通过 `data-mode` + localStorage 持久化；Kumo Chart 接收暗色状态 | 语义 token 天然支持，通过 `data-mode="dark"` 或 CSS `light-dark()` 切换 |
| 主题 | 仅 Kumo 默认 | 内置 FedRAMP 主题，支持自定义 token 覆盖 |

### 架构约束

Portal 是 Cloudflare Worker，HTML 以模板字符串形式在 `html.ts` 中生成。React 通过小岛挂载到 `#usage-panel-root`、`#models-root`、`#keys-root`、`#portal-error-root`，仍避免整页 SPA 化。Worker shell 继续负责首屏骨架、身份/KPI 的轻量 DOM 更新和数据注入；交互密集区域由 React/Kumo 接管。

### 升级优先级

按投入产出比排序：

1. **已完成：Preset Rail + Kumo Chart**：用量时间范围改为一键预设 rail，默认 Auto 粒度，手动粒度为芯片；图表已替换为 Kumo `TimeseriesChart`，并支持横向 brush 映射到同一套预设/粒度规则。
2. **已完成：暗色模式**：通过 `data-mode` 持久化，图表随 `MutationObserver` 同步暗色状态。
3. **已完成：加载态 / 错误 / Key 表格 / 创建 Key**：Loader、Skeleton、Banner、Table、Dialog、Button、Input 已覆盖核心交互。
4. **后续：复制反馈 → Kumo Tooltip/Toast**：新建 Key 的完整密钥复制仍可加 Toast；已有 Key 仅展示 mask，不提供复制。
5. **后续：更多行级详情 → Kumo Accordion/Collapsible**：Key 模型列表已使用 Collapsible，团队/用量明细可按需扩展。
6. **后续：bundle 拆分**：如图表继续增重，应评估 `/portal.js` 拆分或延迟加载 chart island。

### 导入规范

```ts
// 推荐：granular import（tree-shaking 友好）
import { Button } from "@cloudflare/kumo/components/button";
import { Badge } from "@cloudflare/kumo/components/badge";
import { Select } from "@cloudflare/kumo/components/select";
import { TimeseriesChart } from "@cloudflare/kumo/components/chart";

// 高级场景：Base UI primitives 二次封装
import { Popover } from "@cloudflare/kumo/primitives/popover";
```

### 参考资源

- GitHub: [cloudflare/kumo](https://github.com/cloudflare/kumo)
- npm: [@cloudflare/kumo](https://www.npmjs.com/package/@cloudflare/kumo)（当前 latest 2.1.0，与本项目安装版本一致）
- 文档站: [kumo-ui.com](https://kumo-ui.com)
- CLI: `npx @cloudflare/kumo ls` 列出组件 / `npx @cloudflare/kumo doc Button` 查看文档

### Chart / Bundle 决策

2026-05-10 `litellm-portal-kumo-chart-interactions` 已将 Token 用量图从 Recharts 替换为 Kumo `TimeseriesChart`，并移除 `recharts` 依赖。实现采用 granular import：`@cloudflare/kumo/components/chart` + `echarts/core`，仅注册 `LineChart`、`GridComponent`、`TooltipComponent`、`BrushComponent`、`ToolboxComponent`、`AriaComponent`、`SVGRenderer`。

交互上已移除「时间范围 / 时间粒度」两个下拉表单。桌面端使用一键 preset rail + grain chips（`lg:grid-cols-[1fr_auto]`），默认 `自动` 粒度会按配置窗口选择推荐 grain；用户只有在需要时单击手动粒度芯片。手动粒度不支持当前窗口时按钮禁用；若在手动模式切换到不兼容窗口，前端会自动回落到该预设的 Auto grain，并显示非阻断提示。

Kumo/ECharts brush 保持有界：用户在图表中横向拖拽后，前端会把选中区间映射到最接近的服务端预设窗口（例如 7d / 30d / 48h），再复用点击 preset 的 Auto/manual grain 规则请求 `/api/usage/timeseries`；无法匹配预设时只提示，不发起任意窗口查询。

Bundle 实测：`pnpm run analyze:litellm-portal-bundle` 显示 portal app bundle 为 `1,092,618 bytes` minified；`pnpm run build:litellm-portal` dry-run 上传体积为 `1247.58 KiB / gzip 385.83 KiB`。相对上轮 Kumo UX 基线（约 `849.1KB` minified，dry-run `1009.64 KiB / gzip 289.37 KiB`），Kumo Chart/ECharts 原生交互增加约 `235KB` minified / `96KB` gzip。收益是移除 Recharts、统一 Kumo 视觉/ARIA/暗色行为，并获得 chart-native brush + 单次点击时间探索；代价是 bundle 明显增大，后续若继续扩展图表应优先考虑 island 懒加载或独立 chunk。

2026-05-17 `litellm-portal-phase3` 将真实渲染的 ECharts 图表链（`usage-dashboard.tsx → trend-chart/rank-bar/model-donut → echarts-core.ts`）通过 `usage-charts-lazy.tsx` 的 `React.lazy` 边界拆分（route 拓扑不变；esbuild `splitting:true` 已在 `build-litellm-portal-app.mjs` 生效，无 Vite FS 插件）。CI HARD GATE 写在真实 code-split 构建 `build-litellm-portal-app.mjs`（`client.tsx` 入口）：断言 echarts 不在 `main` chunk 且存在于某个非-main split chunk，违反则 `throw`（构建/CI 失败），`ECHARTS_LAZY_GATE: PASS/FAIL` 标记，无 KB 阈值门槛。`analyze-litellm-portal-bundle.mjs` 仍为观测脚本（构建 `app.tsx` 单包，非门槛）。实测 before/after（观测，非门槛）：拆分后 `main` chunk = `10.4KB gzip`（`58.2KB` min，echarts 已移出）；echarts 落入独立 split chunk = `192.5KB gzip`（`566.4KB` min），不再进入首屏下载。**#418 SSR↔hydrate 一致性（关键，spec §E-1 锁定；经实证 Open-Question (b)）**：新 `UsageDashboard` 用的 `dashboard/use-dashboard` 查询键在 SSR 未被 seed（`server-impl.tsx` seed 的是旧 `hooks/use-dashboard` 的 `["dashboard"]` 键），故 `renderPortalSSR("/usage")` 服务端渲染**加载态**（`加载中…`），不渲染 `<TrendChart>`、不进入 lazy Suspense 边界；客户端首帧同样渲染该加载态（同一未 seed 键）⇒ 两端首帧一致，lazy 边界**天然无 #418**（双方首帧均不进入边界）。`client.tsx` 在 `hydrateRoot` 前 fail-soft `try { await warmUsageCharts() } catch {}` 为纵深防御（若未来某改动在 SSR 端 seed 新键则保持 client==server）+ 渲染后 UX（消除查询返回后的骨架闪烁），并非当前防 #418 的机制（构造即安全）。守卫 = `hydration.test.tsx`：2 个平价用例（断言 SSR 串含 `加载中…`、无 `data-chart="trend"`、无 `data-panel-skeleton`，且 hydrate 无 mismatch）+ 1 个负控（客户端 seed 新键使其首帧渲染图表 vs SSR 加载态，证明该 harness 能侦测真实 mismatch、非空过），**非** client-only `router.test.tsx` mount。

2026-05-17 §F.4: per-block React ErrorBoundary (errors/error-boundary.tsx) wraps the lazy chart island + dashboard/audit core blocks — RENDER/RUNTIME isolation, LAYERED ON TOP of the MAJOR-1 client.tsx try/catch (chunk-FETCH floor; unchanged). Orthogonal: fetch-fail → floor; render-throw → inline panel; siblings intact. Transparent on the loading/happy path so the §E-1 #418 loading-parity is unaffected.

2026-05-17 §F.2（V2.0 §2.1）Web-Vitals 性能预算 — **CLS < 0.1 CI HARD GATE**（确定性、可断言；LCP/INP 仅观测，类比 §A.3 bundle delta 的"观测不设门槛"先例）。复用既有 `@playwright/test` 既有 harness，无 Lighthouse/新依赖：`cloud/tests/e2e/perf-budget.spec.ts`（页内 `PerformanceObserver` 采 `layout-shift`/`largest-contentful-paint`，load 后 2.5s 沉降窗口），脚本 `test:e2e:perf`。E2E 服务端 = 与 `deploy:litellm-portal` / `portal-e2e.yml` 同一构建产物（`build:litellm-portal` → `dist/litellm-portal-worker/index.js`，`wrangler dev --no-bundle --local` 提供；Lingui macro 仅由 `build:litellm-portal` 转译，裸 `wrangler dev` 跑 TS 源会 500，故构建产物是 SSR portal 唯一可服务体）— 非新增服务器；`playwright.config.ts` 新增 `reuseExistingServer` 的最小 `webServer`，本地手起 `dev:litellm-portal` 时让位、CI/staging 无人值守时自起。实测（两次确定性复跑，`x-litellm-portal-dev-email` dev-auth 头，LiteLLM stub 未 mock → 路由 SSR 渲染骨架/加载态，正是被测的 CLS 稳定态）：

| route | CLS（HARD GATE < 0.1） | LCP（观测，非门槛） |
|---|---|---|
| `/` | `0.0000` ✅ | `~164–168ms` |
| `/usage` | `0.0000` ✅ | `~144–152ms` |
| `/ops` | `0.0000` ✅ | `0ms`（2.5s 窗口内未发 LCP entry — forbidden/小表面无大内容元素；`Number.isFinite` 仍真，LCP 观测不门控故通过；如实记录） |

CLS=0.0000 三路由全过 → §A.2 `PanelSkeleton` / Task-0B `SsrSafeSkeleton` 定高几何 + Task-3 lazy chart 边界换入**不塌陷布局**（含 loading→resolved 过渡路径）。**INP 不可在无脚本化代表性交互下可靠自动测量** → 转 Task-10 人工 staging 项（具体规程：开 devtools Performance/INP overlay，每路由执行一次代表性交互并记录）。`CLS < 0.1` 是锁定的 §F.2 决策，门槛不放宽；真实 CLS 突破属缺陷，须在源头（骨架几何）修复，不得 gate-relax。

---

## 管理员视图（只读）

### 触发条件

当 LiteLLM 返回的 `user_role` 字段值为 `proxy_admin` 或 `proxy_admin_viewer` 时，portal 会显示顶部 tabs：`个人视图` 与 `全局管理`。管理员默认仍停留在个人视图，只有显式点击或通过 `#admin` 打开时才进入全局管理。其余角色仅显示自身 Key、用量和团队信息，看不到全局数据。

### Role 投影表

Worker 端的 `projectRole`（`roles.ts`）将 LiteLLM 原生角色映射为 portal 内部三级角色：

| LiteLLM `user_role` | Portal `PortalRole` | 说明 |
|---|---|---|
| `proxy_admin` | `admin` | 完整管理员权限 |
| `proxy_admin_viewer` | `admin` | 只读管理员，与 proxy_admin 在 portal 侧行为一致 |
| `internal_user` | `user` | 普通内部用户 |
| `internal_user_viewer` | `user` | 只读内部用户 |
| `team` | `user` | 团队成员 |
| `customer` | `user` | 外部客户 |
| 未注册 / LiteLLM 返回错误 | `none` | 拒绝展示任何敏感数据 |

### Trust 边界

Role 解析**只在 Worker 端进行**（`roles.ts:resolveIdentity`），使用 `master_key` 调用 LiteLLM `/user/list?user_email=...` 并匹配当前 Access 邮箱；SPA 收到的只是已投影的 `PortalRole`，无法自行提升权限。`/api/admin/*` 系列路由在 `index.ts` 中由 `requireAdmin` 中间件统一守卫，任何未携带有效管理员身份的请求均返回 `403 admin_required`，后端不依赖前端的展示逻辑来保护数据。

### 5 分钟内存缓存

`roles.ts` 顶层维护一个模块级 `Map`（`roleCache`），TTL 为 5 分钟（`ROLE_CACHE_MS = 5 * 60 * 1000`）。缓存键为用户 email，值包含 `role`、`litellmUserId` 和过期时间戳。

关键设计决策：

- 缓存存活在 Worker isolate 私有内存中，不跨 isolate 共享，不写 KV / D1。
- **fail-closed**：`resolveIdentity` 若捕获异常（LiteLLM 不可达等），返回 `role: "none"` 且**不写入缓存**，确保下次请求重新尝试鉴权，而非以失败结果放行。

### Revocation 注意

当用户从 admin 降级到普通角色时，已缓存该用户身份的 Worker isolate 在 5 分钟内仍会放行 /api/admin/* 请求。如需紧急吊销，应同时旋转 LITELLM_MASTER_KEY 或重启 Worker。

### /api/admin/* 路由清单

以下路由均为只读，由 `routes.ts` 中的 DO-backed handler 实现（CQRS 改造后，原 `admin.ts` 直读 LiteLLM 的实现已删除；用量/概览数据来自 `UsageDO` / `IndexDO`，请求路径零 `litellmFetch`）：

| 路由 | 实现 | 说明 |
|---|---|---|
| `GET /api/admin/users` | `adminUsersFromDO`（routes.ts） | 分页列出所有用户（`IndexDO`，支持 `page` / `size`） |
| `GET /api/admin/teams` | `adminTeamsFromDO`（routes.ts） | 列出所有团队（`IndexDO`，脱敏公开字段） |
| `GET /api/admin/audit` | `adminAuditApp`（routes.ts） | 分页列出审计事件（支持 `page` / `size`） |
| `GET /api/admin/usage/overview[?member=]` | `adminUsageOverviewApp`（routes.ts → `buildDashboard`） | 全局 / 成员用量聚合（KPI 环比、趋势、模型、时段、多线、summary），`UsageDO` + `IndexDO` |

> 已删除：`/api/admin/summary`、`/api/admin/usage/timeseries`（旧直读 LiteLLM 路径，由 `/api/admin/usage/overview` 取代，见 L2/L3 spec）。

未匹配路径或角色不足时，`requireAdmin` 中间件统一返回 `403 { error: "admin_required" }`。

### 只读边界

本期 portal 管理员视图**不提供任何写操作**。修改用户角色、调整 budget、变更团队归属等操作均需通过 LiteLLM 原生管理 UI 完成；删除 API Key 只在个人视图中按当前用户所有权执行。portal 管理员区的职责仅限于：

- 查看全局概览：用户数、管理员数、团队数、花费、预算和风险项（`/api/admin/usage/overview` 的 `summary`）
- 查看全局用量看板（Kumo dashboard）：KPI 环比、消费趋势、模型占比、时段分布、团队多线、用户排行、状态点告警
- 查看全局用户列表与消费分布，点行进入只读成员下钻 overlay
- 查看团队列表
- 查看操作审计日志

### 可参考代码位置

| 文件 | 关键标识符 | 说明 |
|---|---|---|
| `roles.ts` | `resolveIdentity`, `projectRole` | Role 解析与缓存逻辑 |
| `routes.ts` | `adminUsersFromDO`, `adminTeamsFromDO`, `adminAuditApp`, `adminUsageOverviewApp` | DO-backed 只读 admin handler（CQRS，零 `litellmFetch`） |
| `dashboard.ts` | `buildDashboard`, `buildSummary` | 聚合装配层（`UsageDO` + `IndexDO`） |
| `index.ts` | `requireAdmin` | 中间件守卫，统一 403 兜底 |
| `dashboard/views/` | `usage-dashboard.tsx`, `member-overlay.tsx` | 统一 self/global Kumo 看板与只读成员下钻 |

---

2026-05-12 `litellm-portal-admin-view` 新增管理员视图章节：role 投影表、trust 边界、5 分钟缓存策略、/api/admin/* 路由清单及只读边界说明。

2026-05-12 `litellm-portal-admin-dashboard-alignment` 对齐管理员与个人 dashboard 心智模型：tabs 改为 `个人视图` / `全局管理`，管理员默认进入个人视图；全局管理按「概览 → 趋势 → 资源与权限 → 审计与风险」排序，并新增有界 `/api/admin/summary` 概览数据。

2026-05-17 `litellm-portal-layout-unification` 将个人/全局用量统一到 `/` 的 `UsageDashboard` 范围切换；管理操作迁移到 `/manage/*` 顶部 tab 区，旧 `/admin/*` 与 `/preferences` 路径保留临时重定向。
