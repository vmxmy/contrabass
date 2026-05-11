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

---

## 管理员视图（只读）

### 触发条件

当 LiteLLM 返回的 `user_role` 字段值为 `proxy_admin` 或 `proxy_admin_viewer` 时，portal 在普通用户区块之外额外渲染管理员区（`AdminSection`）。其余角色仅显示自身 Key、用量和团队信息，看不到全局数据。

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

Role 解析**只在 Worker 端进行**（`roles.ts:resolveIdentity`），使用 `master_key` 调用 LiteLLM `/v2/user/info`；SPA 收到的只是已投影的 `PortalRole`，无法自行提升权限。`/api/admin/*` 系列路由在 `index.ts` 中由 `requireAdmin` 中间件统一守卫，任何未携带有效管理员身份的请求均返回 `403 admin_required`，后端不依赖前端的展示逻辑来保护数据。

### 5 分钟内存缓存

`roles.ts` 顶层维护一个模块级 `Map`（`roleCache`），TTL 为 5 分钟（`ROLE_CACHE_MS = 5 * 60 * 1000`）。缓存键为用户 email，值包含 `role`、`litellmUserId` 和过期时间戳。

关键设计决策：

- 缓存存活在 Worker isolate 私有内存中，不跨 isolate 共享，不写 KV / D1。
- **fail-closed**：`resolveIdentity` 若捕获异常（LiteLLM 不可达等），返回 `role: "none"` 且**不写入缓存**，确保下次请求重新尝试鉴权，而非以失败结果放行。

### Revocation 注意

当用户从 admin 降级到普通角色时，已缓存该用户身份的 Worker isolate 在 5 分钟内仍会放行 /api/admin/* 请求。如需紧急吊销，应同时旋转 LITELLM_MASTER_KEY 或重启 Worker。

### /api/admin/* 路由清单

以下路由均为只读，由 `admin.ts` 中的四个 handler 实现：

| 路由 | Handler | 说明 |
|---|---|---|
| `GET /api/admin/users` | `adminListUsers` | 分页列出所有用户（支持 `page` / `size` 查询参数） |
| `GET /api/admin/teams` | `adminListTeams` | 列出所有团队（含脱敏后的公开字段） |
| `GET /api/admin/audit` | `adminListAuditEvents` | 分页列出审计事件（支持 `page` / `size`） |
| `GET /api/admin/usage/timeseries` | `adminGlobalUsageTimeseries` | 全局 Token 用量时序数据（复用 `parseUsageTimeseriesRequest` 参数规范） |

未匹配路径或角色不足时，`requireAdmin` 中间件统一返回 `403 { error: "admin_required" }`。

### 只读边界

本期 portal 管理员视图**不提供任何写操作**。修改用户角色、删除 API Key、调整 budget、变更团队归属等操作均需通过 LiteLLM 原生管理 UI 完成。portal 管理员区的职责仅限于：

- 查看全局用户列表与消费分布
- 查看团队列表
- 查看操作审计日志
- 查看全局 Token 用量时序图

### 可参考代码位置

| 文件 | 关键标识符 | 说明 |
|---|---|---|
| `roles.ts` | `resolveIdentity`, `projectRole` | Role 解析与缓存逻辑 |
| `admin.ts` | `adminListUsers`, `adminListTeams`, `adminListAuditEvents`, `adminGlobalUsageTimeseries` | 4 个只读 handler |
| `index.ts` | `requireAdmin` | 中间件守卫，统一 403 兜底 |
| `app.tsx` | `AdminSection` + 4 个子组件 | 前端管理员区渲染入口 |

---

2026-05-12 `litellm-portal-admin-view` 新增管理员视图章节：role 投影表、trust 边界、5 分钟缓存策略、/api/admin/* 路由清单及只读边界说明。
