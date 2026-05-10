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

## Typography

### Hierarchy
| Token | Size | Weight | Line Height | Use |
|---|---|---|---|---|
| Page title | 30px → 36px desktop | 600 | 1.2 | Platform name |
| Section title | 18px | 600 | 1.33 | Card headers, panel titles |
| Metric value | 28px | 600 | 1.2 | KPI numbers, mono |
| Metric label | 12px | 600 | 1.4 | uppercase, tracking-wider |
| Body | 14px → 16px | 400 | 1.5 | Descriptions, running text |
| Caption | 13px | 400 | 1.5 | Meta, timestamps |
| Table header | 12px | 600 | 1.4 | uppercase, tracking-wider |
| Mono data | 14px → 18px | 500 | 1.4 | All numbers, prices, tokens |

### Principles
- **Headings at weight 600**, never 700+. Signals calm authority, not urgency.
- **Every number in monospace** — prices, token counts, budgets, RPM/TPM.
- **Metric labels are 12px uppercase with tracking-wider** — visually subordinate without being tiny.
- **Page title uses negative letter-spacing** (`tracking-tight`); body stays at 0.

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

Portal 已安装 `@cloudflare/kumo@^2.1.0`，CSS token 体系全面对齐 DESIGN.md 规范，但 React 组件层仅使用 2 个组件：

| 维度 | 当前使用 | Kumo 可提供 |
|------|---------|------------|
| CSS tokens | 全面覆盖（surface / text / semantic / hairline） | 已对齐，无需改动 |
| React 组件 | `Badge` + `Collapsible`（仅 `app.tsx`） | Button、Select、Dialog、Tooltip、Dropdown、Switch、Progress、Tabs、Accordion 等 |
| Base UI Primitives | 未使用 | 37 个无样式可访问原语（Popover、Dialog、Slider 等），可从 `@cloudflare/kumo/primitives/*` 导入做二次封装 |
| 无障碍 | `html.ts` 中 vanilla JS 手动处理 ARIA，无焦点管理 | Kumo 组件开箱处理键盘导航、focus trap/return、ARIA 属性 |
| 暗色模式 | 未实现 | 语义 token 天然支持，通过 `data-mode="dark"` 或 CSS `light-dark()` 切换 |
| 主题 | 仅 Kumo 默认 | 内置 FedRAMP 主题，支持自定义 token 覆盖 |

### 架构约束

Portal 是 Cloudflare Worker，HTML 以模板字符串形式在 `html.ts` 中生成（~580 行）。React 仅挂载到 2 个 DOM 容器（`#models-root`、`#usage-chart-root`）。`html.ts` 中的交互逻辑（表格渲染、复制按钮、select 控件、状态 pills）均为 vanilla JS 手写 DOM 操作，不享受 Kumo 组件的无障碍和主题能力。

### 升级优先级

按投入产出比排序：

1. **Select 控件 → Kumo Select**：用量面板的 grain/window 选择器是原生 `<select>`，替换为 Kumo Select 可获得一致的视觉和无障碍支持。需将控件迁入 React 组件。
2. **暗色模式**：语义 token 已就绪，仅需添加 `data-mode` 切换器和少量 CSS 变量映射。零架构改动。
3. **复制反馈 → Kumo Tooltip/Toast**：当前 API Key 的「复制」按钮用 `setTimeout` 替换文本，应改为 Kumo Tooltip 或轻量 Toast 反馈。
4. **加载态 → Kumo Progress/Skeleton**：当前自定义骨架屏（`animate-pulse bg-kumo-fill`），可统一为 Kumo 的 Progress 或 Skeleton 组件。
5. **错误展示 → Kumo Dialog/Alert**：底部 `error-banner` 可升级为 Kumo Dialog 或 Alert 组件，提供更好的焦点管理和屏幕阅读器支持。
6. **表格行展开 → Kumo Accordion/Collapsible**：模型列表的展开/收起已使用 Collapsible，可扩展到表格行详情展开。

### 导入规范

```ts
// 推荐：granular import（tree-shaking 友好）
import { Button } from "@cloudflare/kumo/components/button";
import { Badge } from "@cloudflare/kumo/components/badge";
import { Select } from "@cloudflare/kumo/components/select";

// 高级场景：Base UI primitives 二次封装
import { Popover } from "@cloudflare/kumo/primitives/popover";
```

### 参考资源

- GitHub: [cloudflare/kumo](https://github.com/cloudflare/kumo)
- npm: [@cloudflare/kumo](https://www.npmjs.com/package/@cloudflare/kumo)（当前 latest 2.1.0，与本项目安装版本一致）
- 文档站: [kumo-ui.com](https://kumo-ui.com)
- CLI: `npx @cloudflare/kumo ls` 列出组件 / `npx @cloudflare/kumo doc Button` 查看文档

### Chart / Bundle 决策

当前 Token 用量图仍保留 Recharts。2026-05-10 本地 spike 显示：通过 `@cloudflare/kumo/components/chart` 引入 `TimeseriesChart` 与 ECharts core 后，最小 React chart bundle 约 806.9KB minified；升级前 portal bundle 基线约 680.0KB minified。本轮迁移 Select、ClipboardText、Table、Banner、Loader/Skeleton 后，`pnpm run analyze:litellm-portal-bundle` 显示 portal app bundle 约 855.0KB minified。由于 Kumo Chart 入口会再带入更大的图表栈，本轮不叠加图表库迁移，后续需等 granular chart entrypoint 或单独 bundle budget change。
