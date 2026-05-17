# Phase 3 — Design-Language Evolution + Extended Branding + Hygiene Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Evolve the *already-shipped* LiteLLM Portal (Phase 1 Tenant Portal + Phase 2 Operations Console, both live at zhiyun.ziikoo.com) from "working Phase-1/2 scaffold" to a **visibly redesigned** outward-facing multi-tenant portal + inward-facing operations cockpit — **hygiene-first**: (§A) a11y audit-to-pass → unified state/density tokens → CI-gated ECharts lazy split, THEN (§B) the pronounced chrome/card/state/motion restyle, THEN (§C) the extended tenant-branding surface model. NO new screens, NO backend change, NO IA change. Strictly inside Kumo: no design-system fork, no semantic/hierarchy/typography token override; dark-mode (`data-mode`) + bilingual (zh-CN/en) + WCAG-AA + SSR/#418 invariants hold; `DESIGN.md` is extended, never replaced.

**Architecture:** Same Cloudflare-Worker SSR + React-island + Kumo + TanStack-Router stack (#135/Phase-1/Phase-2). Two shells = two SSR-selected component trees driven by the hydrated `useMe()` identity (`routes/index.tsx` `PortalIndex` for the Tenant Portal; the pathless `OpsLayout` route for `/ops`). Phase 3 introduces (1) a shared `Panel*` state-component family + a shell-level density `context`, (2) a shared `SideNav` chrome component (hand-authored zero-dependency inline-SVG icons — Kumo has no icon set, C3) consumed by both shells with shell-supplied accent/density, (3) a `React.lazy` boundary (`usage-charts-lazy.tsx`) that severs the real rendered ECharts chain `usage-dashboard.tsx → trend-chart/rank-bar/model-donut → echarts-core.ts` into a code-split chunk (gate enforced by the real `client.tsx` `splitting:true` build, `build-litellm-portal-app.mjs`), (4) `branding.ts` extended to guard six brandable surfaces against canvas+elevated+tint × light/dark (6 checks, all-or-nothing fallback) while still emitting ONLY `--kumo-brand`/`--kumo-brand-hover`. `DESIGN.md` gains `Shell / SideNav`, `State Treatments`, `Density Scale`, `Motion`, and an updated `Chart / Bundle` record — additive sections, no token redefinition.

**Tech Stack:** TypeScript, Cloudflare Workers (SSR), React islands, `@cloudflare/kumo@^2.1.0`, TanStack Router (code-based routes, `React.lazy` boundaries), Hono, Zod, Lingui i18n (zh-CN/en), Vitest (happy-dom + `cloudflare:workers` via `bun run test`), Storybook, esbuild metafile bundle analysis, `bun run` toolchain.

---

## Prerequisites (read before Task 1)

- **Phase 1 (#139 — Tenant Portal) and Phase 2 (#140 — Operations Console) are BOTH merged to `main`.** Both are DONE and live. The Phase-3 branch base is `main`'s state at the time the Phase-3 branch was cut. The shipped files this plan evolves are all present and were re-read on 2026-05-17 (anchors below are authoritative; re-confirm by symbol + `grep`/Read before editing — Phase-3 edits will shift line numbers within the branch).
- **Branch:** `feat/litellm-portal-phase3-design-restyle` is **already created and checked out** (verified: `git branch` shows it current); the Phase-3 spec is already committed to it as `9d3b927`. Do NOT re-create or rebase the branch. Work proceeds on this branch.
- **Authoritative anchors (re-verify by symbol before editing):**
  - `cloud/src/litellm-portal/tenant-portal/shell.tsx` — `TenantPortalShell`@143, `BrandBar`@72, `resolveNav`@52, `isPureOwner`@48, the bare `<a className="block rounded-md px-3 py-2 …">` nav@169-176, `<nav aria-label={t\`租户导航\`}>`@162, `border-b border-kumo-default bg-kumo-elevated`@77 (the hairline mis-token to normalize), `ImpersonationBanner` `role="alert" aria-live="assertive"`@113.
  - `cloud/src/litellm-portal/ops-console/shell.tsx` — `OpsConsoleShell`@53, `OPS_NAV`@16, the bare `<a>` nav@91-97, `OpsForbiddenCard`@34, the `内部·特权` chip@79-81, `style={OPS_STEEL_ACCENT}`@59/71.
  - `cloud/src/litellm-portal/ops-console/ops-theme.ts` — `OPS_STEEL_ACCENT`@13 (`#475569` / `#334155`).
  - `cloud/src/litellm-portal/tenant-portal/branding.ts` — `HEX6_RE`@28, `relativeLuminanceFromHex`@80, `contrastRatio`@86, `darkenHex`@101, `LIGHT_CANVAS_LUMINANCE`@34, `DARK_CANVAS_LUMINANCE`@40, `WCAG_AA_UI_RATIO`@43, `isAccessibleBrand`@119, `applyBrandVars`@140 (signature `(b: { name: string; logoUrl: string | null; primaryColor: string | null }) => React.CSSProperties`).
  - **REAL embed/build graph (verified 2026-05-17 — OQ1):** the SSR-served + embedded SPA entry is `cloud/src/litellm-portal/client.tsx` (NOT `app.tsx`). The embed build is `cloud/scripts/build-litellm-portal-app.mjs` (entry `client.tsx`@11, `splitting: true`@90, `outdir`@91, multi-chunk metafile@102, `chunkKind`@`function chunkKind(output)` "main"/"admin"/"chunk"@~66, an EXISTING "no admin markers / no admin source inputs in main chunk" assertion + `MAIN_GZIP_LIMIT=100*1024`@19 / `ADMIN_GZIP_LIMIT=80*1024`@20 gzip budgets that `throw` on violation@173-174). `cloud/src/litellm-portal/app.tsx` (1176 lines) imports NO router/__root/shell; it exports `PortalErrorBanner` (imported by `routes/__root.tsx`@22) and `UsageChart`/`chart.tsx` is exercised at runtime ONLY by `app.test.tsx`@127 (+ a type-only `import type { UsageTimeseries }` in `admin-components.tsx`@12). So `app.tsx`/`chart.tsx` are NOT the rendered portal tree.
  - **REAL rendered ECharts chain (verified — OQ2/C1):** `routes/index.tsx` `PortalIndex` → `TenantOverviewScreen` (and `/usage` → `tenant-portal/screens/usage.tsx`@2/7 `<UsageDashboard initialScope="self" />`; Ops `/ops/usage` → `ops-console/screens/global-usage.tsx`@2/7 `<UsageDashboard initialScope="global" />`) → `dashboard/views/usage-dashboard.tsx`@11-13 `import { TrendChart } from "../charts/trend-chart"` + `ModelDonut` + `RankBar`, rendered@162/168/171/176 → `dashboard/charts/trend-chart.tsx`@2 `import { echarts } from "./echarts-core"` + `echarts.init(...)`@13 (and `rank-bar.tsx`/`model-donut.tsx` likewise) → `dashboard/charts/echarts-core.ts`@1 `import * as echarts from "echarts/core"` + `echarts.use([LineChart,BarChart,PieChart,GridComponent,TooltipComponent,LegendComponent,SVGRenderer])`@2-8, `export { echarts }`@10. **`trend-chart.tsx` sets NO `aria`/`ariaDescription` today** (verified — its `<div data-chart="trend" ref … />`@38 has no aria). `chart.tsx`'s `ariaDescription`@168 is dead in production (only `app.test.tsx`).
  - `cloud/src/litellm-portal/dashboard/views/usage-dashboard.tsx` — `import { TrendChart } from "../charts/trend-chart"`@11, `import { ModelDonut } from "../charts/model-donut"`@12, `import { RankBar } from "../charts/rank-bar"`@13; `<TrendChart series={trendSeries} />`@162.
  - `cloud/src/litellm-portal/dashboard/charts/trend-chart.tsx` — `TrendChart`@7 (`{ series, height=300 }`), `echarts.init(ref.current, undefined, { renderer: "svg" })`@13 inside a `useEffect`@11-33, empty branch `<p …>暂无数据</p>`@36, `<div data-chart="trend" ref={ref} … />`@38. No aria.
  - `cloud/src/litellm-portal/dashboard/charts/echarts-core.ts` — the SINGLE `import * as echarts from "echarts/core"` static importer@1 (re-exported `echarts`@10; `trend-chart`/`rank-bar`/`model-donut` import from `./echarts-core`, NOT `echarts/core` directly).
  - `cloud/scripts/analyze-litellm-portal-bundle.mjs` — builds **`app.tsx`** (`new URL("../src/litellm-portal/app.tsx", …)`@4) single-bundle, **NO `splitting`, NO `outdir`**, `outputFiles[0]` only, prints size + `analyzeMetafile`. WRONG artifact for the §A.3 gate (it is not the code-split `client.tsx` build, and `app.tsx` is not the router tree). Package alias `analyze:litellm-portal-bundle` → `node scripts/analyze-litellm-portal-bundle.mjs` (cwd = `cloud/`).
  - `@cloudflare/kumo@2.1.0` — **100 package exports, ZERO icon exports** (verified: no `./components/icon`, no icon set). `@phosphor-icons/react` is a Kumo **peerDependency `^2.1.10`** (installed in `cloud/node_modules`), NOT re-exported by Kumo. Therefore "Kumo built-in icon set" (spec §B.1/§E-2 "primary") is **unimplementable** — see C3 ruling in Task 4.
  - `cloud/src/litellm-portal/chart.tsx` — `UsageChart`@103 (DEAD in production per OQ1; runtime-used only by `app.test.tsx`@127). The top-level `import * as echarts from "echarts/core"`@15-23 here is NOT in the rendered tree. `formatTick`@96. (No Phase-3 change is required in `chart.tsx`; see Task 1 / M2.)
  - `cloud/src/litellm-portal/router.tsx` — top static imports of every route module@22-50, `createTenantPortalRoutes(rootRoute, { includeIndex: false })`@61, `createOpsConsoleRoutes(rootRoute)`@69, `routeTree = rootRoute.addChildren([...])`@72-104, `createPortalRouter`@117. (router.tsx does NOT statically import screen bodies — the factories own screen imports; ECharts is reached via `usage-dashboard.tsx`'s static `import { TrendChart }`, NOT via router.tsx.)
  - `cloud/src/litellm-portal/routes/__root.tsx` — `RootLayout`@163 (outer URL-branch, `useRouterState`@164, `isOpsSurface`@165), `PortalRootLayout`@172, `AppShell`@242.
  - `cloud/src/litellm-portal/routes/index.tsx` — `PortalIndex`@34, `toTenantBrand`@65, `TenantOverviewScreen` wired@48.
  - `cloud/src/litellm-portal/tenant-portal/routes.tsx` — `createTenantPortalRoutes`@76, `TENANT_ROUTE_SPECS`@56, `Placeholder`@29, `MemberForbidden`@38.
  - `cloud/src/litellm-portal/ops-console/routes.tsx` — `createOpsConsoleRoutes` + `OpsLayout` + `OPS_ROUTE_SPECS` (Phase-2; pathless layout idiom).
  - `cloud/src/litellm-portal/tenant-portal/screens/overview.tsx` — hand-written state branches: `PersonalSpendTile`/`TeamBudgetTile`/`WebhookStatusTile` `SkeletonLine` stacks@66-71/115-118/167-175, `TopModelsTile` self-drawn `article + header + SkeletonLine`@247-258 + `Empty size="sm"`@272.
  - `cloud/src/litellm-portal/ops-console/screens/tenant-overview.tsx` (88 lines) — `TenantsTable`@12: `SkeletonLine`×2@16-20, `Banner variant="error"`@23-29, `Empty size="sm"`@32 (Task 2 `Panel*` migration anchors, pre-Task-2). The `OpsTenantOverviewScreen` article header `<div className="border-b border-kumo-line bg-kumo-elevated p-6">` is at **~@78** (Task 7 §B.2 emphasis-class target — but Task 2 rewrites this file's state branches first, so Task 7 MUST re-locate that header BY SYMBOL/grep, not by line; the @78 is the pre-Task-2 baseline only).
  - `cloud/src/litellm-portal/tenant-portal/i18n-completeness.test.ts` — imports `PHASE1_TENANT_KEYS` from `../i18n/__fixtures__/phase1-keys` (the shared fixture already exists from Phase 2); 3-`it` shape.
  - `cloud/src/litellm-portal/ops-console/i18n-completeness.test.ts` — 4-`it` shape incl. the no-silent-shadow guard (Phase-2).
  - `cloud/src/litellm-portal/i18n/setup.ts` — `setupI18n`, `catalogs`, identity-mapped zh source strings; `cloud/src/litellm-portal/i18n/messages/{en,zh-CN}.ts` catalogs.
  - `cloud/src/litellm-portal/ops-console/hooks.ts` — query-key idiom (`OPS_TENANTS_QUERY_KEY` etc.), `getJson`, `useStopImpersonation` (reused unchanged).
  - `cloud/src/litellm-portal/tenant-portal/tenant-portal.stories.tsx` / `ops-console/ops-console.stories.tsx` — CSF3 `Meta`/`StoryObj`, per-story QueryClient decorator seeded with inline fixtures + `I18nProvider` with `setupI18n("zh-CN")`, no network/bindings, render-only (no test step).
  - `cloud/scripts/build-litellm-portal-app.mjs` — the REAL §A.3 gate host: `client.tsx` entry, `splitting:true`, `outdir`, multi-chunk metafile, `chunkKind` main/admin/chunk, `mainChunk = chunks.find(c => c.kind === "main")`, an existing `throw`-on-violation idiom (admin markers / admin source inputs in main chunk @~123-134; gzip budgets @136-174). Task 3 adds the echarts-∉-main / echarts-∈-split assertion mirroring that idiom. (`scripts/analyze-litellm-portal-bundle.mjs` is observational-only — `app.tsx` single-bundle, NOT the gate; C2.)
- **Toolchain HARD RULES (run from `cloud/`):**
  - Tests: `cd /Users/xumingyang/github/contrabass/cloud && bun run test <path>`. **NEVER** `npx vitest` nor `bun test` — both fail to resolve the env (no happy-dom, no `cloudflare:workers`).
  - Typecheck: `bun run typecheck`. The single pre-existing `src/litellm-portal/server.ts → server-impl.tsx --jsx` error is the known baseline. "Zero new errors" = no others. ZERO new tsc baseline errors permitted.
  - Build/SPA embed contract: `bun run build:litellm-portal` runs `generate-litellm-portal-kumo-css.mjs` → `build-litellm-portal-app.mjs` → `build-litellm-portal-worker.mjs` and regenerates `app.generated.ts` (and `kumo-css.generated.ts`). Any change to `app.tsx`/islands/routes requires a rebuild before deploy, and the regenerated `app.generated.ts` **MUST be committed** (the Go binary embeds the built SPA via `embed.FS`).
  - §A.3 CI HARD GATE: lives IN `bun run build:litellm-portal` (its `build-litellm-portal-app.mjs` step, the real `client.tsx` `splitting:true` build — Task 3 adds the echarts-∉-main / echarts-∈-split `throw`). A gate FAIL fails the build (non-zero, CI fails). NO KB threshold. `bun run analyze:litellm-portal-bundle` is OBSERVATIONAL ONLY (it builds `app.tsx` single-bundle — the WRONG artifact; it is NOT the gate — C2).
  - Deploy (staging/prod, when authorized): `bun run deploy:litellm-portal`. **NEVER bare `wrangler deploy`** — it 500s (project memory `litellm-portal-deploy-procedure`).
  - Documented non-regressions (CI is the gate; an isolated re-run confirms): (a) the happy-dom full-suite SSR flake fetching `http://localhost:3000/kumo.css` (rotates across `index.test.ts`/`security.test.ts`/`usage-overview-routes.test.ts`, files Phase-3 does not modify); (b) the pre-existing-on-`main` `usage-overview ?window=90d` failure. Neither is a Phase-3 regression. Confirm any such failure by re-running the affected file ISOLATED.
- **Commits:** `<type>(litellm-portal): <imperative ≤72 chars>`, lowercase, no trailing period, `git -c commit.gpgsign=false`. History is load-bearing — resolve conflicts via `git merge main` into the PR branch, **never** `git rebase main`, **never** squash, **never** cherry-pick into a fresh branch (CLAUDE.md).

Repo root `/Users/xumingyang/github/contrabass`; portal `cloud/src/litellm-portal/`; commands from `cloud/`.

---

## Empirical answers — resolved by reading the real repo (2026-05-17, post-critic)

The first plan revision modeled §A.1/§A.3 from the spec's mental picture; these were verified against the true module graph and the plan below is re-anchored to them. The spec's *intent* (a11y aria i18n; ECharts off the initial chunk behind a CI hard gate) is unchanged — only the *target files* are corrected.

- **OQ1 — `app.tsx` is NOT the rendered portal tree.** The embedded/SSR-served SPA entry is `cloud/src/litellm-portal/client.tsx`, built by `cloud/scripts/build-litellm-portal-app.mjs` with `splitting:true`+`outdir`+multi-chunk metafile+`chunkKind` main/admin/chunk + an existing "no admin in main chunk" assertion + gzip budgets. `app.tsx` is live only as `PortalErrorBanner` (imported by `__root.tsx`); `chart.tsx`/`UsageChart` is runtime-exercised ONLY by `app.test.tsx` (+ a type-only import in `admin-components.tsx`). `analyze-litellm-portal-bundle.mjs` builds `app.tsx` single-bundle with NO splitting — the WRONG artifact for the §A.3 gate.
- **OQ2 — the rendered chart sets NO aria.** Real chain: `PortalIndex`/usage screens → `<UsageDashboard>` → `dashboard/views/usage-dashboard.tsx` (static `import { TrendChart } from "../charts/trend-chart"`) → `dashboard/charts/trend-chart.tsx` (`echarts.init` directly) → `dashboard/charts/echarts-core.ts` (the single `import * as echarts from "echarts/core"`). `trend-chart.tsx` has NO `aria`/`ariaDescription` today. So §A.1's chart-aria item is RE-SCOPED from "i18n an existing string in `chart.tsx`" to "ADD a locale-driven aria description to the real rendered `trend-chart.tsx`" (larger scope, noted in Task 1).
- **C3 fact — Kumo ships NO icon set.** `@cloudflare/kumo@2.1.0` has 100 exports, ZERO icon exports. `@phosphor-icons/react` is a Kumo peerDependency `^2.1.10` (installed). The spec's §B.1/§E-2 "Kumo built-in icon set (primary)" is **unimplementable**. RULING (in-plan, concrete — NOT deferred): Phase 3 uses **100% zero-dependency hand-authored inline `<svg>`** for all nav icons. `@phosphor-icons/react` is **forbidden** (importing a transitive peer dep directly to satisfy "no new icon dependency" defeats the spec's intent — the spec's primary is gone, so its own fallback "zero-dependency inline SVG" is the de-facto path; this is an empirical resolution of §E-2, not a re-opening of it).

---

## Explicit decisions baked in (do not re-brainstorm — user-locked + §E-resolved 2026-05-17)

1. **明显视觉重塑 strictly inside Kumo.** No design-system fork; semantic/hierarchy/typography tokens NOT overridden; the §B.0 non-change list is a hard boundary. Restyle = Kumo-token / Tailwind-utility / `DESIGN.md`-section / component-structure changes only. **No pixel mockups** — tests assert structural/behavioral/a11y/contrast invariants, never pixels.
2. **Extended brandable surface = the SAME `--kumo-brand`.** The 5 new brandable surfaces all consume `--kumo-brand` (or `-hover`); NO new CSS vars (so the Phase-1 `branding.ts` injection guard is inherited automatically). Contrast guard extends canvas-only → **canvas + elevated + tint × light/dark = 6 checks, all-or-nothing fallback to `{}`** (accepted trade-off: some Phase-1-passing tenants now fall back; per-surface partial degradation is explicitly REJECTED — §E-3). Ops面 keeps FIXED steel + IGNORES tenant branding (Phase-2 invariant, restated, untouched).
3. **全做,卫生优先 ordering.** §A.1 a11y → §A.2 density/state tokens → §A.3 ECharts-lazy CI HARD GATE (NO KB threshold; bundle delta is observational only). THEN §B.0 non-change list → §B.1 chrome/nav (**zero-dependency hand-authored inline `<svg>` nav icons** — Kumo ships no icon set, `@phosphor-icons/react` forbidden; this is the empirical §E-2 resolution, see C3 above) → §B.2 card/panel → §B.3 state table → §B.4 motion (≤200ms, reduced-motion-safe) → §B.5 two-surface tone. THEN §C.1–§C.3 extended branding. §A's three workflows are file-disjoint and may run as parallel waves; §B must NOT begin until §A passes its acceptance; §C depends on §B.1/§B.2 surfaces existing.
4. **Invariants (umbrella §5 cross-cutting, held throughout):** SSR + React islands / #418 (two shells, server-resolved role, lazy boundaries SSR-safe with correct fallback, hydration no-mismatch); bilingual (new copy enters `i18n/messages/{en,zh-CN}` first, completeness tests guard); dark `data-mode` (every new state/active/brand surface/focus ring passes light AND dark); Kumo-only (zero fork, zero semantic/hierarchy/typography override); Ops steel/ignore-branding untouched.

---

## File Structure

| File | Responsibility | Change |
|---|---|---|
| `cloud/src/litellm-portal/a11y/focus.ts` | Single source of the shared focus-ring utility class string `FOCUS_RING` (`focus-visible:ring-2 focus-visible:ring-kumo-brand focus-visible:ring-offset-2`) consumed by SideNav, Panel* actions, clickable cards | Create |
| `cloud/src/litellm-portal/a11y/focus.test.ts` | Asserts the focus-ring contrast math (reuses `branding.ts` WCAG helpers via a re-export) ≥ 3:1 in light+dark under a legal brand color | Create |
| `cloud/src/litellm-portal/tenant-portal/branding.ts` | Re-export `relativeLuminanceFromHex`/`contrastRatio`/`darkenHex` for reuse by `a11y` + §C; **extend `isAccessibleBrand` to 6-surface check** (canvas+elevated+tint × light/dark); `applyBrandVars` signature UNCHANGED | Modify |
| `cloud/src/litellm-portal/tenant-portal/branding.test.ts` | Add: 6-surface pass/fall matrix, all-or-nothing fallback, injection rejection still `{}`, Phase-1-color-now-falls-back regression case | Modify |
| `cloud/src/litellm-portal/dashboard/charts/trend-chart.tsx` | **ADD** a locale-driven `aria-label` (+ `role="img"`) to the rendered chart `<div>` — it has NONE today (OQ2 re-scope: add, not i18n-an-existing-string). Accept an injected localized `ariaLabel` prop; no macro inside the chart island | Modify |
| `cloud/src/litellm-portal/dashboard/charts/build-chart-aria.ts` | Pure `buildChartAriaDescription({windowLabel,points,grain},{template})` helper (no macro, SSR-safe) reused by `trend-chart.tsx` | Create |
| `cloud/src/litellm-portal/dashboard/views/usage-dashboard.tsx` | Pass the localized `ariaLabel` (built via the `t`-macro template, which runs in the dashboard — already inside `I18nProvider`) into `<TrendChart>` | Modify |
| `cloud/src/litellm-portal/components/panel-state.tsx` | The four state contracts: `PanelSkeleton`, `PanelEmpty`, `PanelError`, `PanelLoading` (wrap Kumo `SkeletonLine`/`Empty`/`Banner`/`Loader`) | Create |
| `cloud/src/litellm-portal/components/panel-state.test.tsx` | Structural/behavioral assertions for all four (titles, centering, lines param, error-message derivation, dark-mode) | Create |
| `cloud/src/litellm-portal/components/density.tsx` | `DensityContext` + `DensityProvider` + `useDensity()`; the named scale `comfortable`/`compact` → padding/gap class maps (no new spacing numbers — maps to existing DESIGN.md spacing) | Create |
| `cloud/src/litellm-portal/components/density.test.tsx` | `useDensity()` default + provider override; class-map correctness | Create |
| `cloud/src/litellm-portal/components/side-nav.tsx` | Shared `SideNav`: icon + label + group headings + `aria-current` + active accent bar + hover=`tint` + `FOCUS_RING`; accent/density via props | Create |
| `cloud/src/litellm-portal/components/side-nav.test.tsx` | `aria-current` on active route, focus-ring class present, group headings, icon present, accent-bar element | Create |
| `cloud/src/litellm-portal/components/nav-icons.tsx` | `NavIcon` with COMPLETE hand-authored zero-dependency inline `<svg aria-hidden width=16 height=16>` for all 10 slots (C3: Kumo has no icon set, `@phosphor-icons/react` forbidden) | Create |
| `cloud/src/litellm-portal/tenant-portal/shell.tsx` | Consume `SideNav` (brand accent, comfortable density) + brand identity summary bar (logo+name+budget `Meter`+alert dot) + group headings; normalize `border-kumo-default`→`border-kumo-line`; wrap in `DensityProvider`; motion classes | Modify |
| `cloud/src/litellm-portal/tenant-portal/shell.test.tsx` | Extend: `aria-current`, focus-ring, summary bar, group headings, no-semantic-token-override invariant | Modify |
| `cloud/src/litellm-portal/ops-console/shell.tsx` | Consume `SideNav` (steel accent, compact density) + steel-ring privileged pill + global-state summary chips + group headings; wrap in `DensityProvider`; motion classes | Modify |
| `cloud/src/litellm-portal/ops-console/shell.test.tsx` | Extend: `aria-current`, focus-ring, steel pill, summary chips, compact density, steel-not-brand invariant | Modify |
| `cloud/src/litellm-portal/tenant-portal/screens/overview.tsx` | Migrate all hand-written skeleton/empty/error branches to `Panel*`; remove direct `SkeletonLine`/`Empty` imports | Modify |
| `cloud/src/litellm-portal/ops-console/screens/tenant-overview.tsx` | Migrate `TenantsTable` state branches to `Panel*`; remove direct `SkeletonLine`/`Empty`/`Banner` imports | Modify |
| `cloud/src/litellm-portal/ops-console/screens/{provisioning,global-usage,audit,platform-settings,tenant-detail,user-detail}.tsx` | Migrate any direct state-primitive use to `Panel*` (file-disjoint per screen) | Modify |
| `cloud/src/litellm-portal/tenant-portal/screens/{usage,keys,members,alerts,billing}.tsx` | Migrate any direct state-primitive use to `Panel*` (file-disjoint per screen) | Modify |
| `cloud/src/litellm-portal/dashboard/charts/rank-bar.tsx` | Step 3a (MAJOR-2): add behavior-preserving `export type RankBarProps = { rows: RankRow[]; height?: number }` + reference it on the signature (props were inline-typed; `RankRow` already exported). No logic change | Modify |
| `cloud/src/litellm-portal/dashboard/charts/model-donut.tsx` | Step 3a (MAJOR-2): add behavior-preserving `export type ModelDonutProps = { slices: ModelSlice[]; height?: number }` + reference it on the signature (props were inline-typed; `ModelSlice` already exported). No logic change | Modify |
| `cloud/src/litellm-portal/dashboard/views/usage-charts-lazy.tsx` | THE lazy boundary (C1): `React.lazy`+`Suspense` island wrapping the `TrendChart`/`RankBar`/`ModelDonut` cluster so the static `usage-dashboard.tsx → trend-chart.tsx → echarts-core.ts (import * as echarts)` chain is severed into a dynamic-import chunk. Also exports `warmUsageCharts()` (defense-in-depth + UX per verified Open-Q (b); the boundary is #418-safe by construction on the real SSR path) | Create |
| `cloud/src/litellm-portal/dashboard/views/usage-dashboard.tsx` | Replace the static `import { TrendChart/ModelDonut/RankBar }`@11-13 + their JSX@162/168/171/176 with the lazy `usage-charts-lazy.tsx` boundary (same props); route topology unchanged | Modify |
| `cloud/src/litellm-portal/client.tsx` | NEW-C-A/MAJOR-1: add `warmUsageCharts` to the `Promise.all` import + a **fail-soft** `try { await warmUsageCharts(); } catch {}` immediately after `await router.load()`@57 (before `hydrateRoot`). Per verified Open-Q (b) the lazy boundary is #418-safe by construction (SSR & client both render the loading state); the warm-up is defense-in-depth + post-hydration UX, and MUST NOT block hydrate on a chunk-fetch failure. Browser-only (Worker SSR imports `app.tsx`, not this) | Modify |
| `cloud/src/litellm-portal/hydration.test.tsx` | NEW-C-A / spec §E-1: mirror the fixed `client.tsx` (the fail-soft try/catch warm-up) in `hydrateLikeClient` + add 2 usage-route SSR↔hydrate PARITY cases (assert SSR HTML has the loading marker `加载中…`, NOT `data-chart="trend"`, NOT `data-panel-skeleton`, and hydrate has no #418 mismatch) + a NEGATIVE CONTROL (client-seeded resolved chart vs SSR loading IS detected as a mismatch — proves the harness is not blind). The REAL §E-1 #418 guard — replaces a client-only `router.test.tsx` mount which cannot detect SSR-string-vs-hydrate divergence | Modify |
| `cloud/scripts/build-litellm-portal-app.mjs` | Extend the EXISTING multi-chunk-metafile assertion idiom (admin-marker/admin-input check@~123-134) with the §A.3 CI HARD GATE: `echarts` ∉ the `main` chunk inputs AND present in a non-main split chunk → `throw` (same `throw`-on-violation mechanism as the existing budget/admin checks; this is the REAL code-split `client.tsx` build — C2) | Modify |
| `cloud/scripts/analyze-litellm-portal-bundle.mjs` | (Observational only) keep printing sizes; the §A.3 GATE lives in `build-litellm-portal-app.mjs` (the real split build), NOT here (this builds `app.tsx` single-bundle, wrong artifact — C2). Add a one-line note redirecting to the gate location | Modify |
| `cloud/src/litellm-portal/DESIGN.md` | Add `## Shell / SideNav`, `## State Treatments`, `## Density Scale`, `## Motion`; append to `### Chart / Bundle 决策` the lazy-split record + measured numbers; `## §B.3 State Language` table. Extend, never replace | Modify |
| `cloud/src/litellm-portal/i18n/messages/{zh-CN,en}.ts` | All new Phase-3 copy (group headings, summary bar/chips, four-state titles, the `trend-chart` aria template key) | Modify |
| `cloud/src/litellm-portal/i18n/__fixtures__/phase3-keys.ts` | `PHASE3_KEYS` allowlist for the Phase-3 completeness test | Create |
| `cloud/src/litellm-portal/i18n-completeness-phase3.test.ts` | Phase-3-namespace completeness (mirrors the Phase-1/2 idiom: present-in-en, present-in-zh, identical key set) | Create |
| `cloud/src/litellm-portal/tenant-portal/tenant-portal.stories.tsx` | Add a "four-state gallery" story + active-nav/summary-bar story | Modify |
| `cloud/src/litellm-portal/ops-console/ops-console.stories.tsx` | Add a "four-state gallery" story + active-nav/summary-chip story | Modify |
| `cloud/src/litellm-portal/app.generated.ts` (+ `kumo-css.generated.ts`) | Regenerated by `bun run build:litellm-portal`; MUST be committed (embed contract) | Modify (generated) |
| `*.test.tsx`/`*.test.ts` colocated per repo convention | TDD coverage | Create/Modify |

**Decomposition / parallelization:** §A.1 (Task 1) touches `a11y/*`, `dashboard/charts/{trend-chart.tsx,build-chart-aria.ts}`, `dashboard/views/usage-dashboard.tsx`, both shells, `DESIGN.md`. §A.2 (Task 2) touches `components/panel-state.*`, `components/density.*`, all screens, both shells, `DESIGN.md`. §A.3 (Task 3) touches `dashboard/views/{usage-charts-lazy.tsx,usage-dashboard.tsx}`, `client.tsx`, `hydration.test.tsx`, `cloud/scripts/build-litellm-portal-app.mjs`, `cloud/scripts/analyze-litellm-portal-bundle.mjs`, `DESIGN.md`. **Shared serialization points (must be edited in task order, never in parallel): `usage-dashboard.tsx` (Task 1 adds the `ariaLabel` pass-through; Task 3 swaps the static chart imports for the lazy boundary — Task 3 MUST re-anchor by symbol after Task 1), both shells (Task 1 + Task 2 + Tasks 5/6/7), `DESIGN.md` (all), `branding.ts` (Task 1 re-export + Task 8), the i18n catalogs, `app.generated.ts`.** Within §A.2, per-screen migrations are file-disjoint and may run as a parallel wave AFTER `panel-state.tsx`/`density.tsx` land. §B (Tasks 4–7) and §C (Task 8) serialize after the §A GATE; §B.1 shell edits share `side-nav.tsx`/`nav-icons.tsx` (Task 4 creates them, Tasks 5/6 are file-disjoint per shell but their anchors are pre-drifted by Tasks 1–2 → re-locate by symbol, see the M3 note in each). Task 9 = finalization. Task 10 = E2E + whole-branch review (PR-merge per standing authorization).

---

## Task 1 (§A.1): a11y audit-to-pass — focus ring, `aria-current`, rendered-chart aria (ADD, OQ2 re-scope)

**Files:**
- Create: `cloud/src/litellm-portal/a11y/focus.ts`, `cloud/src/litellm-portal/a11y/focus.test.ts`, `cloud/src/litellm-portal/dashboard/charts/build-chart-aria.ts`, `cloud/src/litellm-portal/dashboard/charts/build-chart-aria.test.ts`
- Modify: `cloud/src/litellm-portal/tenant-portal/branding.ts` (re-export WCAG helpers only — the 6-surface guard lands in Task 8), `cloud/src/litellm-portal/dashboard/charts/trend-chart.tsx` (ADD aria — has none today, OQ2), `cloud/src/litellm-portal/dashboard/views/usage-dashboard.tsx` (pass the localized template), `cloud/src/litellm-portal/tenant-portal/shell.tsx`, `cloud/src/litellm-portal/ops-console/shell.tsx`, `cloud/src/litellm-portal/tenant-portal/shell.test.tsx`, `cloud/src/litellm-portal/ops-console/shell.test.tsx`, `cloud/src/litellm-portal/DESIGN.md`, `cloud/src/litellm-portal/i18n/messages/{en,zh-CN}.ts`
- Test: create `a11y/focus.test.ts`, `dashboard/charts/build-chart-aria.test.ts`; extend the two shell tests + `dashboard/views/usage-dashboard.test.tsx` (if present — else create a minimal colocated test asserting the aria pass-through)
- **NOT modified:** `cloud/src/litellm-portal/chart.tsx` (DEAD in production per OQ1 — its `ariaDescription`@168 is never rendered; touching it is wasted churn AND would force a churny `app.test.tsx` update. Leave it. The rendered chart is `trend-chart.tsx`.)

> **a11y task — assertion-based acceptance.** Every criterion is a concrete automated assertion (focus-ring class present, `aria-current="page"` on the active *nav-mapped* link, locale-driven chart `aria-label`, contrast ≥ 3:1 via the real `branding.ts` math). No "looks accessible" prose.
>
> **`aria-current` scope (missing-item fix):** acceptance for `aria-current="page"` is scoped to **nav-mapped routes only** (the items in `TENANT_ROUTE_SPECS` / `OPS_NAV`). Detail routes `/ops/audit/$eventId`, `/ops/tenants/$teamId`, `/ops/users/$userId` legitimately have NO active nav entry — at those URLs NO nav link carries `aria-current` (the parent group is not auto-activated; this is correct, and the tests assert it for nav-mapped paths only).

- [ ] **Step 1: Write the failing focus + contrast test** — `cloud/src/litellm-portal/a11y/focus.test.ts`

```ts
import { describe, expect, it } from "vitest";
import { FOCUS_RING } from "./focus";
import { relativeLuminanceFromHex, contrastRatio } from "../tenant-portal/branding";

describe("shared focus ring", () => {
  it("FOCUS_RING is the canonical Kumo focus-visible utility string", () => {
    expect(FOCUS_RING).toBe(
      "focus-visible:ring-2 focus-visible:ring-kumo-brand focus-visible:ring-offset-2 focus-visible:outline-none",
    );
  });

  it("a legal brand color's focus ring clears WCAG non-text contrast (>=3:1) on light AND dark canvas", () => {
    // Sample legal brand (passes Phase-1 isAccessibleBrand): Cloudflare-orange-ish.
    const brand = relativeLuminanceFromHex("#b45309");
    const light = relativeLuminanceFromHex("#fafafa");
    const dark = relativeLuminanceFromHex("#1a1a1a");
    expect(contrastRatio(brand, light)).toBeGreaterThanOrEqual(3);
    expect(contrastRatio(brand, dark)).toBeGreaterThanOrEqual(3);
  });
});
```

- [ ] **Step 2: Run → FAIL** — `cd /Users/xumingyang/github/contrabass/cloud && bun run test src/litellm-portal/a11y/focus.test.ts` → FAIL (`./focus` missing; `relativeLuminanceFromHex`/`contrastRatio` not exported from `branding.ts`).

- [ ] **Step 3: Create `cloud/src/litellm-portal/a11y/focus.ts`**

```ts
/**
 * Single source of the shared focus-visible ring.
 *
 * Phase-3 §A.1 promotes DESIGN.md's existing `select` focus convention
 * (`focus-visible:ring-2 focus-visible:ring-kumo-brand`) to a portal-wide
 * utility so navigation, panel actions and clickable cards no longer rely on
 * the browser-default outline. `--kumo-brand` resolves to the tenant brand on
 * the Tenant Portal and to fixed steel on Ops (the shell sets the var); its
 * non-text contrast (>=3:1) on both light and dark canvas is enforced for any
 * legal brand by tenant-portal/branding.ts (extended in Task 8). Pure string,
 * no DOM, SSR-safe.
 */
export const FOCUS_RING =
  "focus-visible:ring-2 focus-visible:ring-kumo-brand focus-visible:ring-offset-2 focus-visible:outline-none";
```

- [ ] **Step 4: Re-export the WCAG helpers from `branding.ts`** — add at the end of `cloud/src/litellm-portal/tenant-portal/branding.ts` (anchor: after `applyBrandVars`@140-152), making the existing private functions reusable WITHOUT changing their behavior (the 6-surface guard is Task 8; this step is export-only):

```ts
// ---------------------------------------------------------------------------
// Re-exports for a11y (Task 1) and the §C extended-surface guard (Task 8).
// Pure WCAG math; no behavior change — only widens visibility.
// ---------------------------------------------------------------------------

export { relativeLuminanceFromHex, contrastRatio, darkenHex };
```

- [ ] **Step 5: Run → PASS** — `cd /Users/xumingyang/github/contrabass/cloud && bun run test src/litellm-portal/a11y/focus.test.ts` → PASS (2 tests).

- [ ] **Step 6: Write the failing shell `aria-current` + focus-ring tests.** Append to `cloud/src/litellm-portal/tenant-portal/shell.test.tsx` (after the existing `describe` block, anchor: end of file@99). The Tenant shell test renders inside a router so `useRouterState` resolves; mirror the Phase-2 production-router harness rule.

```tsx
import { RouterProvider } from "@tanstack/react-router";
import { createPortalRouter, createMemoryHistory } from "../router";
import { AppShell } from "../routes/__root";
import { ME_QUERY_KEY } from "../hooks/use-me";
import type { Me } from "../schemas";

const adminMe: Me = {
  email: "admin@acme.example.com", userId: "u1", company: "Acme",
  domain: "acme.example.com", role: "user",
  tenantRole: "tenant_admin", tenantTeamId: "t1",
};

function renderTenantAt(path: string) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  qc.setQueryData(ME_QUERY_KEY, adminMe);
  const router = createPortalRouter(
    createMemoryHistory({ initialEntries: [path] }),
    { role: "user" },
  );
  return render(
    <QueryClientProvider client={qc}>
      <I18nProvider i18n={i18n}>
        <AppShell queryClient={qc}>
          <RouterProvider router={router} />
        </AppShell>
      </I18nProvider>
    </QueryClientProvider>,
  );
}

describe("TenantPortalShell a11y (§A.1)", () => {
  it("the active nav link carries aria-current=page", async () => {
    renderTenantAt("/usage");
    const active = await screen.findByRole("link", { current: "page" });
    expect(active.getAttribute("href")).toBe("/usage");
  });

  it("every nav link carries the shared focus-ring utility class", async () => {
    renderTenantAt("/");
    const links = await screen.findAllByRole("link");
    const navLinks = links.filter((l) => l.getAttribute("href")?.startsWith("/"));
    expect(navLinks.length).toBeGreaterThan(0);
    for (const l of navLinks) {
      expect(l.className).toContain("focus-visible:ring-kumo-brand");
    }
  });

  it("does NOT override any Kumo semantic/hierarchy/typography token (no inline --kumo-* except brand)", async () => {
    const { container } = renderTenantAt("/");
    const root = container.querySelector("#tenant-portal-shell-root") as HTMLElement;
    const style = root.getAttribute("style") ?? "";
    // Only --kumo-brand / --kumo-brand-hover are ever inline-set (branding.ts).
    const decls = style.split(";").map((s) => s.trim()).filter(Boolean);
    for (const d of decls) {
      if (d.startsWith("--kumo-")) {
        expect(d.startsWith("--kumo-brand")).toBe(true);
      }
    }
  });
});
```

- [ ] **Step 7: Add the matching Ops `aria-current` + focus-ring test.** Append to `cloud/src/litellm-portal/ops-console/shell.test.tsx` (mirror the Phase-2 production-router harness used by `ops-console/routes.test.tsx` — render at a path via `createPortalRouter` so `useRouterState` resolves and the Owner gate passes):

```tsx
import { RouterProvider } from "@tanstack/react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createPortalRouter, createMemoryHistory } from "../router";
import { AppShell } from "../routes/__root";
import { ME_QUERY_KEY } from "../hooks/use-me";
import type { Me } from "../schemas";

const ownerMe: Me = {
  email: "o@x.com", userId: "u1", company: "Acme Co", domain: "x.com",
  role: "admin", tenantRole: null, tenantTeamId: null,
};

function renderOpsAt(path: string) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  qc.setQueryData(ME_QUERY_KEY, ownerMe);
  const router = createPortalRouter(
    createMemoryHistory({ initialEntries: [path] }),
    { role: "admin" },
  );
  return render(
    <QueryClientProvider client={qc}>
      <I18nProvider i18n={i18n}>
        <AppShell queryClient={qc}>
          <RouterProvider router={router} />
        </AppShell>
      </I18nProvider>
    </QueryClientProvider>,
  );
}

describe("OpsConsoleShell a11y (§A.1)", () => {
  it("the active Ops nav link carries aria-current=page", async () => {
    renderOpsAt("/ops/audit");
    const active = await screen.findByRole("link", { current: "page" });
    expect(active.getAttribute("href")).toBe("/ops/audit");
  });

  it("every Ops nav link carries the shared focus-ring utility class", async () => {
    renderOpsAt("/ops");
    const links = await screen.findAllByRole("link");
    const navLinks = links.filter((l) => l.getAttribute("href")?.startsWith("/ops"));
    expect(navLinks.length).toBeGreaterThan(0);
    for (const l of navLinks) {
      expect(l.className).toContain("focus-visible:ring-kumo-brand");
    }
  });
});
```

- [ ] **Step 8: Run → FAIL** — `cd /Users/xumingyang/github/contrabass/cloud && bun run test src/litellm-portal/tenant-portal/shell.test.tsx src/litellm-portal/ops-console/shell.test.tsx` → FAIL (no `aria-current`, bare `<a>` has no focus-ring class).

- [ ] **Step 9: Add `aria-current` + `FOCUS_RING` to BOTH shells' nav links (minimal §A.1 change — full SideNav restyle is §B.1/Task 4).** This is the hygiene step: just the a11y attributes, not the visual restyle. In `cloud/src/litellm-portal/tenant-portal/shell.tsx`, import `FOCUS_RING` and `useRouterState`, and replace the nav `<a>` (anchor@169-176):

```tsx
// add to imports:
import { useRouterState } from "@tanstack/react-router";
import { FOCUS_RING } from "../a11y/focus";
```

Inside `TenantPortalShell`, before the returned JSX, derive the current pathname (pure, SSR-safe — resolves identically on the SSR memory router and the client browser router, #418-safe):

```tsx
  const pathname = useRouterState({ select: (s) => s.location.pathname });
```

Replace the nav `<a>` element (anchor@169-176) with:

```tsx
                  <a
                    href={item.href}
                    aria-current={pathname === item.href ? "page" : undefined}
                    className={`block rounded-md px-3 py-2 text-sm font-medium text-kumo-default hover:bg-kumo-tint hover:text-kumo-strong ${FOCUS_RING}`}
                  >
                    {item.label}
                  </a>
```

(Note: `hover:bg-kumo-canvas` → `hover:bg-kumo-tint` is the §B.1 hover-normalization, applied minimally here since this `<a>` is being touched anyway; the full restyle replaces this with `SideNav` in Task 4.) In `cloud/src/litellm-portal/ops-console/shell.tsx` apply the identical change to the Ops nav `<a>` (anchor@91-97): add `import { useRouterState } from "@tanstack/react-router";` + `import { FOCUS_RING } from "../a11y/focus";`, derive `const pathname = useRouterState({ select: (s) => s.location.pathname });` as the FIRST statement in `OpsConsoleShell`'s body — **unconditionally, BEFORE the `if (!isOwner(identity)) return …` guard@54** so the hook count is fixed across the Owner/non-Owner branches (rules-of-hooks) — and set `aria-current={pathname === item.href ? "page" : undefined}` + the `FOCUS_RING` + `hover:bg-kumo-tint` class on the Ops nav `<a>`.

- [ ] **Step 10: Run → PASS** — `cd /Users/xumingyang/github/contrabass/cloud && bun run test src/litellm-portal/tenant-portal/shell.test.tsx src/litellm-portal/ops-console/shell.test.tsx` → PASS (existing + new). `bun run typecheck` → baseline-only.

- [ ] **Step 11: Write the failing rendered-chart aria test (OQ2 re-scope: ADD aria to `trend-chart.tsx`, which has NONE).** Create `cloud/src/litellm-portal/dashboard/charts/build-chart-aria.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { buildChartAriaDescription } from "./build-chart-aria";

describe("buildChartAriaDescription (§A.1, OQ2)", () => {
  it("is a pure locale-driven template (en variant differs from zh)", () => {
    const zh = buildChartAriaDescription(
      { windowLabel: "近 30 天", points: 12, grain: "day" },
      { template: "Token 用量趋势图，时间范围为 {window}，共 {points} 个 {grain} 粒度数据点。" },
    );
    const en = buildChartAriaDescription(
      { windowLabel: "Last 30 days", points: 12, grain: "day" },
      { template: "Token usage trend chart, range {window}, {points} {grain}-grain data points." },
    );
    expect(zh).toBe("Token 用量趋势图，时间范围为 近 30 天，共 12 个 day 粒度数据点。");
    expect(en).toBe("Token usage trend chart, range Last 30 days, 12 day-grain data points.");
    expect(en).not.toContain("用量趋势图");
  });

  it("missing placeholders are left literal (no throw on a partial template)", () => {
    expect(
      buildChartAriaDescription({ windowLabel: "W", points: 1, grain: "g" }, { template: "no slots" }),
    ).toBe("no slots");
  });
});
```

Then create `cloud/src/litellm-portal/dashboard/charts/trend-chart.test.tsx` (happy-dom; `trend-chart.tsx`'s `echarts.init` runs in a `useEffect` — under happy-dom the effect runs but `echarts.init` on a 0×0 node is harmless; assert the wrapper aria, not the rendered SVG):

```tsx
/**
 * @vitest-environment happy-dom
 */
import React from "react";
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { TrendChart } from "./trend-chart";

afterEach(cleanup);

describe("TrendChart aria (§A.1, OQ2 — added; it had none)", () => {
  it("the chart container exposes role=img + the injected localized aria-label", () => {
    const { container } = render(
      <TrendChart
        series={[{ name: "Tokens", points: [[1, 2]] }]}
        ariaLabel="Token 用量趋势图，时间范围为 近 30 天，共 1 个 day 粒度数据点。"
      />,
    );
    const el = container.querySelector('[data-chart="trend"]') as HTMLElement;
    expect(el).not.toBeNull();
    expect(el.getAttribute("role")).toBe("img");
    expect(el.getAttribute("aria-label")).toBe("Token 用量趋势图，时间范围为 近 30 天，共 1 个 day 粒度数据点。");
  });

  it("the empty branch carries no chart aria (legitimately no data)", () => {
    const { container } = render(<TrendChart series={[]} />);
    expect(container.querySelector('[data-chart="trend"]')).toBeNull();
  });
});
```

- [ ] **Step 12: Run → FAIL** — `cd /Users/xumingyang/github/contrabass/cloud && bun run test src/litellm-portal/dashboard/charts/build-chart-aria.test.ts src/litellm-portal/dashboard/charts/trend-chart.test.tsx` → FAIL (`build-chart-aria` missing; `TrendChart` has no `ariaLabel` prop and renders no `role`/`aria-label`).

- [ ] **Step 13: Create the pure helper + ADD aria to the real rendered chart.** Create `cloud/src/litellm-portal/dashboard/charts/build-chart-aria.ts`:

```ts
/**
 * Pure, SSR-safe, macro-free chart aria-description builder (Phase-3 §A.1).
 * The localized template is built by the t`` macro in the dashboard (already
 * inside I18nProvider) and injected into TrendChart, keeping the chart island
 * macro-free and SSR/hydration deterministic. Unknown placeholders are left
 * literal (never throws).
 */
export function buildChartAriaDescription(
  v: { windowLabel: string; points: number; grain: string },
  opts: { template: string },
): string {
  return opts.template
    .replace("{window}", v.windowLabel)
    .replace("{points}", String(v.points))
    .replace("{grain}", v.grain);
}
```

In `cloud/src/litellm-portal/dashboard/charts/trend-chart.tsx`: extend the prop type@7 from `{ series: TrendSeries[]; height?: number }` to `{ series: TrendSeries[]; height?: number; ariaLabel?: string }`, destructure `ariaLabel`, and add `role="img"` + `aria-label={ariaLabel}` to the rendered `<div data-chart="trend" ref={ref} … />`@38 (only when `ariaLabel` is set — when absent omit `aria-label` and keep `role="img"` is still acceptable, but prefer: render `role="img"` + `aria-label` together only when `ariaLabel != null`; the empty branch@36 is unchanged). No `t`/`Trans` macro inside `trend-chart.tsx` (it is rendered far from a guaranteed `I18nProvider`-static path — keep it input-driven, like the rest of `dashboard/charts/*`).

```tsx
// new signature:
export function TrendChart({ series, height = 300, ariaLabel }: { series: TrendSeries[]; height?: number; ariaLabel?: string }) {
  // …unchanged useEffect/echarts.init…
  if (series.length === 0) {
    return <p className="py-12 text-center text-sm text-kumo-subtle">暂无数据</p>;
  }
  return (
    <div
      data-chart="trend"
      ref={ref}
      role={ariaLabel != null ? "img" : undefined}
      aria-label={ariaLabel}
      style={{ width: "100%", height }}
    />
  );
}
```

- [ ] **Step 14: Pass the localized template from the dashboard.** In `cloud/src/litellm-portal/dashboard/views/usage-dashboard.tsx`, at the `<TrendChart series={trendSeries} />`@162 call site, build the localized aria from the `t`-macro template (this file is already rendered inside `I18nProvider`) and pass it:

```tsx
// near the top of the component body, with the other derived values:
import { buildChartAriaDescription } from "../charts/build-chart-aria";
import { t } from "@lingui/core/macro";
// …
const trendAriaLabel = buildChartAriaDescription(
  { windowLabel: /* the dashboard's resolved window label */ data.windowLabel ?? "", points: trendSeries[0]?.points.length ?? 0, grain: /* resolved grain */ data.grain ?? "" },
  { template: t`Token 用量趋势图，时间范围为 {window}，共 {points} 个 {grain} 粒度数据点。` },
);
// …
<TrendChart series={trendSeries} ariaLabel={trendAriaLabel} />
```

> Anchor note: `usage-dashboard.tsx` uses `data` from its dashboard query; confirm the exact field names for the window label and grain by reading the file (it builds `trendSeries` near line ~150-162) and use the real fields — do NOT invent `data.windowLabel`/`data.grain` if the file names them differently; the helper inputs are `{ windowLabel, points, grain }` and `points` MUST be `trendSeries[0]?.points.length ?? 0`. The `t` macro string `Token 用量趋势图，时间范围为 {window}，共 {points} 个 {grain} 粒度数据点。` becomes a catalog key (added to BOTH catalogs in Task 9; English: `"Token usage trend chart, range {window}, {points} {grain}-grain data points."`). The macro runs in `usage-dashboard.tsx` (inside `I18nProvider`), keeping `trend-chart.tsx` macro-free.

- [ ] **Step 15: Run → PASS** — `cd /Users/xumingyang/github/contrabass/cloud && bun run test src/litellm-portal/dashboard/charts/build-chart-aria.test.ts src/litellm-portal/dashboard/charts/trend-chart.test.tsx` → PASS. If `dashboard/views/usage-dashboard.test.tsx` exists, run it too and add (or create a minimal one asserting) that `<TrendChart>` receives a non-empty `ariaLabel` when data is present. `bun run typecheck` → baseline-only (`chart.tsx`/`app.test.tsx` are UNTOUCHED — no churn there per OQ1).

- [ ] **Step 16: `DESIGN.md` — add the focus + chart-aria convention.** In `cloud/src/litellm-portal/DESIGN.md`, add a new top-level section before `## Do's and Don'ts`@439:

```markdown
## Focus & Accessibility (Phase 3 §A.1)

- The portal-wide focus ring is `focus-visible:ring-2 focus-visible:ring-kumo-brand focus-visible:ring-offset-2 focus-visible:outline-none` (`a11y/focus.ts` `FOCUS_RING`) — the single source for nav links, panel actions and clickable cards. Browser-default outline is no longer relied upon.
- `--kumo-brand` resolves to the tenant brand (Tenant Portal) or fixed steel (Ops). Its non-text contrast (≥ 3:1 WCAG SC 1.4.11) on both the light and dark canvas is enforced by `tenant-portal/branding.ts` for any legal brand.
- Every nav-mapped active navigation link emits `aria-current="page"` (detail routes `$eventId`/`$teamId`/`$userId` have no nav entry → no `aria-current`, by design). The impersonation banner remains `role="alert" aria-live="assertive"` (regression-guarded).
- The rendered usage chart (`dashboard/charts/trend-chart.tsx`) exposes `role="img"` + a locale-driven `aria-label` (built by `buildChartAriaDescription` + the dashboard's `t`-macro template; the chart island stays macro-free) — it had NO accessible name before Phase 3.
```

- [ ] **Step 17: Run the §A.1 regression sweep** — `cd /Users/xumingyang/github/contrabass/cloud && bun run test src/litellm-portal/tenant-portal/shell.test.tsx src/litellm-portal/tenant-portal/shell-impersonation.test.tsx src/litellm-portal/ops-console/shell.test.tsx src/litellm-portal/a11y/focus.test.ts src/litellm-portal/dashboard/charts/build-chart-aria.test.ts src/litellm-portal/dashboard/charts/trend-chart.test.tsx` → all PASS. CRITICAL non-regression: `shell-impersonation.test.tsx` still green (impersonation `role="alert"` not lost). `bun run typecheck` → baseline-only.

- [ ] **Step 18: Commit**
```bash
cd /Users/xumingyang/github/contrabass
git add cloud/src/litellm-portal/a11y cloud/src/litellm-portal/tenant-portal/branding.ts cloud/src/litellm-portal/dashboard/charts/build-chart-aria.ts cloud/src/litellm-portal/dashboard/charts/build-chart-aria.test.ts cloud/src/litellm-portal/dashboard/charts/trend-chart.tsx cloud/src/litellm-portal/dashboard/charts/trend-chart.test.tsx cloud/src/litellm-portal/dashboard/views/usage-dashboard.tsx cloud/src/litellm-portal/tenant-portal/shell.tsx cloud/src/litellm-portal/tenant-portal/shell.test.tsx cloud/src/litellm-portal/ops-console/shell.tsx cloud/src/litellm-portal/ops-console/shell.test.tsx cloud/src/litellm-portal/DESIGN.md
git -c commit.gpgsign=false commit -m "feat(litellm-portal): a11y pass — focus ring, aria-current, rendered-chart aria"
```

---

## Task 2 (§A.2): unified state + density tokens

**Files:**
- Create: `cloud/src/litellm-portal/components/panel-state.tsx`, `cloud/src/litellm-portal/components/panel-state.test.tsx`, `cloud/src/litellm-portal/components/density.tsx`, `cloud/src/litellm-portal/components/density.test.tsx`
- Modify: `cloud/src/litellm-portal/tenant-portal/screens/overview.tsx`, `cloud/src/litellm-portal/ops-console/screens/tenant-overview.tsx`, the remaining tenant + ops screens that directly use `SkeletonLine`/`Empty`/`Banner variant="error"` (grep to enumerate — file-disjoint parallel wave), `cloud/src/litellm-portal/tenant-portal/shell.tsx`, `cloud/src/litellm-portal/ops-console/shell.tsx`, `cloud/src/litellm-portal/DESIGN.md`

- [ ] **Step 1: Write the failing `Panel*` test** — `cloud/src/litellm-portal/components/panel-state.test.tsx`

```tsx
/**
 * @vitest-environment happy-dom
 */
import React from "react";
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { I18nProvider } from "@lingui/react";
import { setupI18n } from "../i18n/setup";
import { PanelSkeleton, PanelEmpty, PanelError, PanelLoading } from "./panel-state";

const i18n = setupI18n("zh-CN");
const wrap = (ui: React.ReactElement) =>
  render(<I18nProvider i18n={i18n}>{ui}</I18nProvider>);
afterEach(cleanup);

describe("Panel state contracts (§A.2)", () => {
  it("PanelSkeleton renders exactly `lines` content rows + a title row", () => {
    const { container } = wrap(<PanelSkeleton lines={3} />);
    expect(container.querySelectorAll("[data-panel-skeleton-line]").length).toBe(3);
    expect(container.querySelector("[data-panel-skeleton-title]")).not.toBeNull();
  });

  it("PanelEmpty renders a required title, centered, with optional action", () => {
    wrap(<PanelEmpty title="暂无数据" action={<a href="/x">去配置</a>} />);
    expect(screen.getByText("暂无数据")).toBeTruthy();
    expect(screen.getByRole("link", { name: "去配置" })).toBeTruthy();
  });

  it("PanelError derives the message from an Error, else the fallback", () => {
    wrap(<PanelError title="加载失败" error={new Error("boom")} />);
    expect(screen.getByText("加载失败")).toBeTruthy();
    expect(screen.getByText(/boom/)).toBeTruthy();
    cleanup();
    wrap(<PanelError title="加载失败" error={"weird" as unknown} />);
    expect(screen.getByText(/网络请求失败/)).toBeTruthy();
  });

  it("PanelLoading renders an inline Kumo loader with an accessible label", () => {
    wrap(<PanelLoading label="正在加载" />);
    expect(screen.getByLabelText("正在加载")).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run → FAIL** — `cd /Users/xumingyang/github/contrabass/cloud && bun run test src/litellm-portal/components/panel-state.test.tsx` → FAIL (module missing).

- [ ] **Step 3: Implement `cloud/src/litellm-portal/components/panel-state.tsx`**

```tsx
/**
 * The four canonical panel-content state treatments (Phase-3 §A.2).
 *
 * Any data-panel / LayerCard query-state branch MUST use exactly one of
 * PanelSkeleton (first-paint placeholder), PanelEmpty (no rows),
 * PanelError (request failed) or PanelLoading (inline/partial). Screens no
 * longer hand-write SkeletonLine/Empty/Banner state branches — these wrap the
 * Kumo primitives once so density, centering, titles and dark-mode are
 * uniform. Contract documented in DESIGN.md ## State Treatments.
 */
import React from "react";
import { Banner } from "@cloudflare/kumo/components/banner";
import { Empty } from "@cloudflare/kumo/components/empty";
import { Loader, SkeletonLine } from "@cloudflare/kumo/components/loader";
import { t } from "@lingui/core/macro";

export function PanelSkeleton({ lines = 2 }: { lines?: number }) {
  return (
    <div className="space-y-3 p-6" data-panel-skeleton>
      <div data-panel-skeleton-title>
        <SkeletonLine minWidth={80} maxWidth={160} blockHeight={12} />
      </div>
      {Array.from({ length: Math.max(1, lines) }).map((_, i) => (
        <div key={i} data-panel-skeleton-line>
          <SkeletonLine minWidth={160} maxWidth={400} blockHeight={16} />
        </div>
      ))}
    </div>
  );
}

export function PanelEmpty({
  title,
  description,
  action,
}: {
  title: string;
  description?: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="flex justify-center py-10" data-panel-empty>
      <Empty size="sm" title={title} description={description} action={action} />
    </div>
  );
}

export function PanelError({
  title,
  error,
}: {
  title: string;
  error: unknown;
}) {
  const message = error instanceof Error ? error.message : t`网络请求失败`;
  return (
    <div data-panel-error>
      <Banner variant="error" title={title} description={message} />
    </div>
  );
}

export function PanelLoading({ label }: { label: string }) {
  return (
    <div className="flex items-center justify-center py-6" aria-live="polite" data-panel-loading>
      <Loader aria-label={label} />
    </div>
  );
}
```

> **`data-panel-skeleton` MARKER CONTRACT (pinned — MAJOR-2; cross-referenced by Task 3 Step 9).** `PanelSkeleton`'s root element MUST carry exactly the attribute `data-panel-skeleton` (verbatim, as in the code above: `<div className="space-y-3 p-6" data-panel-skeleton>`). This is a load-bearing contract: Task 3 Step 9's `hydration.test.tsx` parity assertion `expect(html).not.toContain("data-panel-skeleton")` depends on this EXACT attribute string (it pins that the SSR loading state is NOT the lazy fallback), and the Task-2 Step-1 `panel-state.test.tsx` already asserts `[data-panel-skeleton-line]`/`[data-panel-skeleton-title]`. Do NOT rename/remove `data-panel-skeleton` (or `-line`/`-title`) in any later task — it is the structural marker the §A.2 guard test, the screen-migration assertions, and the §E-1 #418 parity test all key off. If a refactor must change it, change ALL three call sites in lockstep (Task-2 tests, Task-3 Step-9).

- [ ] **Step 4: Run → PASS** — `cd /Users/xumingyang/github/contrabass/cloud && bun run test src/litellm-portal/components/panel-state.test.tsx` → PASS (4 tests).

- [ ] **Step 5: Write the failing density test** — `cloud/src/litellm-portal/components/density.test.tsx`

```tsx
/**
 * @vitest-environment happy-dom
 */
import React from "react";
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { DensityProvider, useDensity, densityClasses } from "./density";

afterEach(cleanup);

function Probe() {
  const d = useDensity();
  return <span data-testid="d">{d}</span>;
}

describe("density context (§A.2)", () => {
  it("defaults to comfortable with no provider", () => {
    render(<Probe />);
    expect(screen.getByTestId("d").textContent).toBe("comfortable");
  });

  it("provider overrides to compact", () => {
    render(
      <DensityProvider density="compact">
        <Probe />
      </DensityProvider>,
    );
    expect(screen.getByTestId("d").textContent).toBe("compact");
  });

  it("densityClasses maps to existing DESIGN.md spacing (no new numbers)", () => {
    expect(densityClasses("comfortable")).toEqual({
      card: "p-6",
      stack: "space-y-6",
      grid: "gap-4",
    });
    expect(densityClasses("compact")).toEqual({
      card: "p-4",
      stack: "space-y-4",
      grid: "gap-4",
    });
  });
});
```

- [ ] **Step 6: Run → FAIL** — `cd /Users/xumingyang/github/contrabass/cloud && bun run test src/litellm-portal/components/density.test.tsx` → FAIL (module missing).

- [ ] **Step 7: Implement `cloud/src/litellm-portal/components/density.tsx`**

```tsx
/**
 * Shell-level density scale (Phase-3 §A.2).
 *
 * Tenant Portal = `comfortable` (outward, editorial whitespace); Ops Console =
 * `compact` (inward, information-dense cockpit). Density is a SHELL decision
 * pushed via context; screens read it, never hard-code padding. This is the
 * first real "同源异质" differentiation on the density axis. Names map only to
 * EXISTING DESIGN.md spacing tokens — no new numbers.
 */
import React from "react";

export type Density = "comfortable" | "compact";

const DensityContext = React.createContext<Density>("comfortable");

export function DensityProvider({
  density,
  children,
}: {
  density: Density;
  children: React.ReactNode;
}) {
  return <DensityContext.Provider value={density}>{children}</DensityContext.Provider>;
}

export function useDensity(): Density {
  return React.useContext(DensityContext);
}

export function densityClasses(d: Density): { card: string; stack: string; grid: string } {
  return d === "compact"
    ? { card: "p-4", stack: "space-y-4", grid: "gap-4" }
    : { card: "p-6", stack: "space-y-6", grid: "gap-4" };
}
```

- [ ] **Step 8: Run → PASS** — `cd /Users/xumingyang/github/contrabass/cloud && bun run test src/litellm-portal/components/density.test.tsx` → PASS (3 tests).

- [ ] **Step 9: Wrap each shell in `DensityProvider`.** In `cloud/src/litellm-portal/tenant-portal/shell.tsx` import `import { DensityProvider } from "../components/density";` and wrap the returned shell root's children (anchor: the `<div id="tenant-portal-shell-root" …>` opening@148) so the whole tenant tree is `density="comfortable"`: wrap the existing inner content with `<DensityProvider density="comfortable">…</DensityProvider>` (place the provider as the first child inside `#tenant-portal-shell-root`, wrapping everything from `{impersonation ? … }` through `</main>`/the nav `<div>`). In `cloud/src/litellm-portal/ops-console/shell.tsx` do the same with `density="compact"` wrapping the Owner branch's chrome (the non-Owner 403 branch needs no provider). Keep all existing structure; only add the provider wrapper.

- [ ] **Step 10: Migrate `tenant-portal/screens/overview.tsx` to `Panel*` (TDD via the existing screen test).** First add to `cloud/src/litellm-portal/tenant-portal/screens/overview.test.tsx` an assertion that the migrated screen renders no raw `SkeletonLine` height-12 stack but a `[data-panel-skeleton]`:

```tsx
it("loading state uses the unified PanelSkeleton, not a hand-written SkeletonLine stack", async () => {
  // (render overview with useDashboard pending — mirror the existing test's
  //  QueryClient/mock setup in this file; assert the unified marker)
  // expect(container.querySelector("[data-panel-skeleton]")).not.toBeNull();
});
```

(Use the exact QueryClient/`vi.mock` harness already present at the top of `overview.test.tsx` — do not invent a new harness; the assertion body is `expect(container.querySelector("[data-panel-skeleton]")).not.toBeNull();` after rendering with the dashboard query pending.) Run → FAIL. Then in `overview.tsx`: remove `import { SkeletonLine } from "@cloudflare/kumo/components/loader";`@20 and `import { Empty } from "@cloudflare/kumo/components/empty";`@17, add `import { PanelSkeleton, PanelEmpty } from "../../components/panel-state";`, and replace every hand-written loading branch (`PersonalSpendTile`@64-72, `TeamBudgetTile`@113-120, `WebhookStatusTile`@167-176, `RecentActivityTile`@313-320) with `<LayerCard className="p-6"><PanelSkeleton lines={1} /></LayerCard>` and `TopModelsTile`'s skeleton@246-258 / empty@263-276 with `<PanelSkeleton lines={2} />` / `<PanelEmpty title={t\`暂无模型数据\`} />` inside its existing `article` wrapper. Run the screen test → PASS.

- [ ] **Step 11: Migrate `ops-console/screens/tenant-overview.tsx` to `Panel*`.** In `cloud/src/litellm-portal/ops-console/screens/tenant-overview.tsx`: remove the `SkeletonLine`@5, `Empty`@4, `Banner`@2 imports, add `import { PanelSkeleton, PanelEmpty, PanelError } from "../../components/panel-state";`, and replace `TenantsTable`'s loading@14-21 → `<PanelSkeleton lines={4} />`, error@22-30 → `<PanelError title={t\`租户列表加载失败\`} error={error} />`, empty@31-32 → `<PanelEmpty title={t\`暂无租户\`} />`. Add the matching assertion to `ops-console/screens/tenant-overview.test.tsx` (uses the file's existing harness): `expect(container.querySelector("[data-panel-error]")).not.toBeNull();` for the error case. Run that test → PASS.

- [ ] **Step 12: Migrate the remaining screens (file-disjoint parallel wave).** Enumerate with `cd /Users/xumingyang/github/contrabass/cloud && grep -rl "from \"@cloudflare/kumo/components/loader\"\|components/empty\|variant=\"error\"" src/litellm-portal/tenant-portal/screens src/litellm-portal/ops-console/screens`. For each remaining screen that directly drives a query-state branch with `SkeletonLine`/`Empty`/`Banner variant="error"`, replace with the matching `Panel*` (keep the surrounding card/article wrapper). Each screen file is independent — these may be done in parallel by separate workers. Per screen: add/extend its colocated `*.test.tsx` with the relevant `[data-panel-*]` marker assertion (reusing that file's existing harness), run that single test → PASS, then move on. Do NOT touch shared files in this step.

- [ ] **Step 13: Add the lint-style guard test** — `cloud/src/litellm-portal/components/panel-state.guard.test.ts` (proves screens no longer import the raw primitives for state branches):

```ts
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const SCREEN_DIRS = [
  "src/litellm-portal/tenant-portal/screens",
  "src/litellm-portal/ops-console/screens",
];

describe("§A.2 state-primitive convergence guard", () => {
  it("no screen directly imports SkeletonLine/Empty/Banner for state branches", () => {
    const offenders: string[] = [];
    for (const dir of SCREEN_DIRS) {
      for (const f of readdirSync(dir)) {
        if (!f.endsWith(".tsx") || f.endsWith(".test.tsx")) continue;
        const src = readFileSync(join(dir, f), "utf8");
        if (
          src.includes('from "@cloudflare/kumo/components/empty"') ||
          /import\s*\{[^}]*\bSkeletonLine\b[^}]*\}\s*from\s*"@cloudflare\/kumo\/components\/loader"/.test(src) ||
          src.includes('variant="error"')
        ) {
          offenders.push(join(dir, f));
        }
      }
    }
    expect(offenders, `Screens still using raw state primitives: ${JSON.stringify(offenders)}`).toHaveLength(0);
  });
});
```

Run `cd /Users/xumingyang/github/contrabass/cloud && bun run test src/litellm-portal/components/panel-state.guard.test.ts` → PASS (all screens migrated). If it fails, the failing file list IS the remaining migration TODO — finish those then re-run.

- [ ] **Step 14: `DESIGN.md` — add `## State Treatments` + `## Density Scale`.** Insert after the new `## Focus & Accessibility` section (from Task 1):

```markdown
## State Treatments (Phase 3 §A.2)

Every data-panel / card query-state branch uses exactly ONE of four contracts (`components/panel-state.tsx`). Screens MUST NOT hand-write `SkeletonLine`/`Empty`/`Banner variant="error"` for state branches (guard test enforced).

| Contract | Wraps | Use | Shape |
|---|---|---|---|
| `PanelSkeleton` | Kumo `SkeletonLine` | First-paint placeholder | title row (12px) + `lines` content rows (16px), `p-6`, `space-y-3` |
| `PanelEmpty` | Kumo `Empty` size=sm | No rows | required title, optional description/action, centered `py-10` |
| `PanelError` | Kumo `Banner` variant=error | Request failed | title + `error instanceof Error ? error.message : 网络请求失败` |
| `PanelLoading` | Kumo `Loader` | Inline/partial (buttons, local) | centered `py-6`, `aria-live=polite`, accessible label |

## Density Scale (Phase 3 §A.2)

Density is a SHELL decision pushed via `DensityProvider` (`components/density.tsx`); screens read `useDensity()` and never hard-code padding. Names map only to existing spacing tokens — no new numbers.

| Density | Shell | card | stack | grid |
|---|---|---|---|---|
| `comfortable` | Tenant Portal (outward, editorial) | `p-6` | `space-y-6` | `gap-4` |
| `compact` | Ops Console (inward, cockpit) | `p-4` | `space-y-4` | `gap-4` |

This is the first real "同源异质" differentiation on the density axis (Phase 1/2 had no density difference).
```

- [ ] **Step 15: Run the §A.2 sweep** — `cd /Users/xumingyang/github/contrabass/cloud && bun run test src/litellm-portal/components src/litellm-portal/tenant-portal/screens src/litellm-portal/ops-console/screens` → PASS (incl. the guard). Dark-mode + bilingual not regressed (state titles are `t`-macro keys, finalized Task 9). `bun run typecheck` → baseline-only.

- [ ] **Step 16: Commit**
```bash
cd /Users/xumingyang/github/contrabass
git add cloud/src/litellm-portal/components cloud/src/litellm-portal/tenant-portal/screens cloud/src/litellm-portal/ops-console/screens cloud/src/litellm-portal/tenant-portal/shell.tsx cloud/src/litellm-portal/ops-console/shell.tsx cloud/src/litellm-portal/DESIGN.md
git -c commit.gpgsign=false commit -m "feat(litellm-portal): unify panel state + density tokens"
```

---

## Task 3 (§A.3): ECharts lazy split — CI HARD GATE (no KB threshold)

**Files:**
- Create: `cloud/src/litellm-portal/dashboard/views/usage-charts-lazy.tsx`
- Modify: `cloud/src/litellm-portal/dashboard/views/usage-dashboard.tsx`, `cloud/src/litellm-portal/client.tsx` (pre-`hydrateRoot` echarts warm-up — the actual #418 fix), `cloud/scripts/build-litellm-portal-app.mjs`, `cloud/scripts/analyze-litellm-portal-bundle.mjs` (note only), `cloud/src/litellm-portal/DESIGN.md`
- Test: create `cloud/src/litellm-portal/bundle-gate.test.ts`; **extend `cloud/src/litellm-portal/hydration.test.tsx`** (the spec-§E-1-MANDATED SSR↔hydrate parity harness — NOT a client-only `router.test.tsx` mount)

> **C1/C2 re-anchor (verified real graph):** The rendered ECharts chain is `dashboard/views/usage-dashboard.tsx` (static `import { TrendChart } from "../charts/trend-chart"`@11) → `trend-chart.tsx` (`echarts.init`) → `echarts-core.ts` (`import * as echarts from "echarts/core"`@1). Severing the **static import in `usage-dashboard.tsx`** with a `React.lazy` boundary moves echarts off the initial chunk — `chart.tsx` is DEAD (OQ1). The CI gate runs against the REAL code-split build `cloud/scripts/build-litellm-portal-app.mjs` (`client.tsx` entry, `splitting:true`, multi-chunk metafile, `chunkKind` main/admin/chunk) — NOT `analyze-litellm-portal-bundle.mjs` (which builds `app.tsx` single-bundle → wrong artifact, C2). The gate extends `build-litellm-portal-app.mjs`'s EXISTING `throw`-on-violation idiom.

> **NEW-C-A — #418 SSR↔hydrate parity is the REAL acceptance (spec §E-1, lines 106/227, LOCKED), and a naked `React.lazy`+`Suspense` boundary VIOLATES it. Verified evidence (engaged, not assumed):**
> - **OPEN QUESTION RESOLVED EMPIRICALLY (verified by reading the repo 2026-05-17 — answer = (b)):** under `renderPortalSSR` for `/usage`, the server renders the **LOADING state, NOT a resolved `<TrendChart>`**. Two distinct `use-dashboard` modules exist: `server-impl.tsx`:11 seeds `serverQueryClient.setQueryData(DASHBOARD_QUERY_KEY, DashboardSchema.parse(dataWithIdentity))` where `DASHBOARD_QUERY_KEY` is imported from `./hooks/use-dashboard` (OLD: flat key `["dashboard"]`, schema `DashboardSchema` from `schemas.ts`). But the new `UsageDashboard` (`dashboard/views/usage-dashboard.tsx`:3) calls `useDashboard(dashboardScope, win)` from `../use-dashboard` = `dashboard/use-dashboard.ts` (NEW: key `["dashboard", scope.kind, "", window]` e.g. `["dashboard","self","","30d"]`, schema `DashboardResponseSchema` from `dashboard-schemas.ts`) — a DIFFERENT module/key/schema. At SSR the new query key is UNSEEDED ⇒ `data === undefined` ⇒ `usage-dashboard.tsx`:148 renders `<DashboardStatus>加载中…</DashboardStatus>`, never `<TrendChart>`. (`server-impl.tsx`'s seeding is Phase-0/CQRS infra — OUT of Phase-3 scope; do NOT change it. The new-vs-old `use-dashboard` reconciliation is pre-existing tech-debt the umbrella spec did not assign to Phase 3.)
> - **CONSEQUENCE — the lazy boundary is #418-SAFE BY CONSTRUCTION, not by warm-up, on the real SSR path:** the `React.lazy` chart boundary is reached ONLY *after* the new `useDashboard` query resolves, which happens ONLY client-side (the key is never SSR-seeded). So the SERVER renders the loading placeholder (no `<TrendChart>`, no Suspense boundary entered), and the CLIENT's first hydrate render ALSO renders the same loading placeholder (same unseeded query) → **server === client first render → there is NO hydration mismatch / no #418 from the lazy boundary on `/usage` (or `/`, `/ops/usage`)**. `React.lazy`'s Suspense fallback is never even mounted server-side OR on the client's first paint — it only appears later, client-side, transiently, AFTER the dashboard fetch resolves and the chart subtree mounts (a post-hydration state change, not a hydration render). #418 cannot occur from a boundary that neither side enters on the first render.
> - **Role of `warmUsageCharts()` (corrected, honest):** its #418 value on the real SSR path is **MOOT** (answer (b) — no SSR/hydrate desync exists there). It is retained for: (i) **defense-in-depth** — if a future change ever DID seed the new key SSR-side (making the server render the resolved chart), the warm-up keeps the client first render matching (the fix is then load-bearing; cheap insurance); (ii) **post-hydration UX** — warming the chunk at bootstrap removes the transient skeleton flash when the dashboard query resolves on a fast connection. It is NOT claimed as the thing that prevents #418 on `/usage` today (construction does that). The bundle split (C2) is unaffected — the import stays dynamic.
> - **Mechanism (option-2 client warm-up; route-level `lazyRouteComponent` infeasible — chart nested 2 levels below the route component inside `UsageDashboard`, shared by 3 routes incl. the `/` index whose route component also renders the non-chart `TenantOverviewScreen`):** keep ONE `React.lazy` boundary for the bundle split; `client.tsx` `await warmUsageCharts()` before `hydrateRoot` (defense-in-depth + UX, per above), wrapped in `try/catch` (MAJOR-1) so a failed chunk fetch never blanks the portal. Mirrors `client.tsx`'s own pre-`hydrateRoot` `await router.load()` discipline.
> - **TRUE §E-1 acceptance (spec NAMES `hydration.test.tsx`; the assertion must be HARNESS-ACHIEVABLE — CRITICAL-1):** the locked invariant is **SSR string === client first-hydrate render (zero React hydration mismatch / no #418 console error) for the REAL rendered states**, NOT a hardcoded `data-chart="trend"` (physically unsatisfiable — answer (b): the harness renders the loading state). Step 9 therefore asserts: (1) **parity** — the `/usage` and `/ops/usage` SSR markup hydrates with NO `console.error/warn` mismatch (the existing `hydration.test.tsx` idiom), proving the new `UsageDashboard` loading state + the lazy-boundary plumbing are SSR/hydrate-identical; (2) it asserts the SSR string contains the loading marker (`数据同步中`/`加载中…` — the state answer (b) proves the server actually renders) and does NOT contain `data-chart="trend"` (positively pinning the verified real behavior, so a future regression that accidentally SSR-renders the chart without warm-up would FLIP this and the parity check would then catch the resulting #418); (3) a **NEGATIVE CONTROL** that distinguishes "warm-up broken / real hydration mismatch" from "no SSR data" — a case that DOES make the client first render the resolved chart while SSR rendered loading (by client-seeding the new `dashboard/use-dashboard` key in the test's `hydrateLikeClient` QueryClient with a `DashboardResponseSchema`-valid `available:true` fixture) and asserts THAT path DOES produce a hydration mismatch UNLESS the warm-up is present — i.e. the test can actually fail if the fix is removed, not vacuously pass.

> **§A.3 HARD GATE (§E-1, locked):** ECharts MUST be in a SEPARATE (non-`main`) split chunk and MUST NOT be in the `main` chunk of the real `client.tsx` code-split build. CI-verifiable: `build-litellm-portal-app.mjs` `throw`s on violation (so `bun run build:litellm-portal` — already on the CI path — fails). **NO KB threshold** — the gzip delta is recorded in `DESIGN.md` as observational only. **AND** the lazy boundary MUST be #418-safe: per the Open-Question (b) verification the boundary is #418-safe BY CONSTRUCTION on the real SSR path (server and client both render the loading state — neither enters the Suspense boundary on first render), and the `hydration.test.tsx` Step-9 parity + negative-control cases PROVE it (no mismatch on the real states; the negative control fails if the warm-up defense is ever removed AND a future seed makes SSR resolve the chart). Not asserted on faith.

- [ ] **Step 1: Write the failing bundle-gate test** — `cloud/src/litellm-portal/bundle-gate.test.ts`. It runs the REAL split build via the package alias (no fragile cwd heuristic — M1). The build script `throw`s (non-zero exit) on a gate violation; the test asserts a clean run + the PASS marker:

```ts
import { describe, expect, it } from "vitest";
import { execSync } from "node:child_process";

describe("§A.3 ECharts lazy HARD GATE (real client.tsx code-split build)", () => {
  it("build:litellm-portal-app succeeds and prints ECHARTS_LAZY_GATE: PASS", () => {
    // `bun run generate:litellm-portal-app` === `node scripts/build-litellm-portal-app.mjs`
    // (the real splitting:true build of client.tsx). It THROWS (non-zero) if
    // echarts is in the main chunk or absent from every split chunk. execSync
    // throws on non-zero, so a returned stdout containing the PASS marker IS
    // the gate. Run from cloud/ (the package root) via the bun alias.
    const out = execSync("bun run generate:litellm-portal-app", {
      cwd: __dirname.includes("/src/litellm-portal")
        ? __dirname.slice(0, __dirname.indexOf("/src/litellm-portal"))
        : process.cwd(),
      encoding: "utf8",
      timeout: 180_000,
    });
    expect(out).toMatch(/ECHARTS_LAZY_GATE: PASS/);
  }, 200_000);
});
```

(`generate:litellm-portal-app` is the existing package script `node scripts/build-litellm-portal-app.mjs` — confirmed; it is the splitting build and also regenerates `app.generated.ts`. Running it from `cloud/` is correct since package scripts resolve `scripts/` relative to `cloud/`.)

- [ ] **Step 2: Run → FAIL** — `cd /Users/xumingyang/github/contrabass/cloud && bun run test src/litellm-portal/bundle-gate.test.ts` → FAIL (no `ECHARTS_LAZY_GATE` marker — the gate code does not exist yet; and echarts IS in the main chunk because `usage-dashboard.tsx` statically imports `trend-chart.tsx` → `echarts-core.ts`).

- [ ] **Step 3a (PREREQUISITE — props-type exports; MAJOR-2/LOW).** `usage-charts-lazy.tsx` imports `RankBarProps`/`ModelDonutProps`, which do NOT exist yet (verified: `rank-bar.tsx:7` declares props inline `function RankBar({ rows, height = 280 }: { rows: RankRow[]; height?: number })`; `model-donut.tsx:7` `function ModelDonut({ slices, height = 280 }: { slices: ModelSlice[]; height?: number })`; only `RankRow`@5 / `ModelSlice`@5 are exported). Add a behavior-preserving named props export to each chart file (NO logic change — extract the inline type to a named exported alias and reference it on the signature):
  - In `cloud/src/litellm-portal/dashboard/charts/rank-bar.tsx`: after `export type RankRow = …`@5 add `export type RankBarProps = { rows: RankRow[]; height?: number };` and change the signature to `export function RankBar({ rows, height = 280 }: RankBarProps)`.
  - In `cloud/src/litellm-portal/dashboard/charts/model-donut.tsx`: after `export type ModelSlice = …`@5 add `export type ModelDonutProps = { slices: ModelSlice[]; height?: number };` and change the signature to `export function ModelDonut({ slices, height = 280 }: ModelDonutProps)`.
  - `TrendSeries` is already exported by `trend-chart.tsx`@5 — no change there (and Task 1 Step 13 added its `ariaLabel?` prop; `TrendChartLazy` re-declares the inline `{ series; height?; ariaLabel? }` literal, which matches). NO `any`, NO `@ts-ignore`, NO `React.ComponentProps<typeof import(...)>` (repo hard rule). These three chart files are otherwise untouched by Phase 3 except Task 1's `trend-chart.tsx` `ariaLabel` add — re-anchor by symbol. `bun run typecheck` after Step 3a → baseline-only (export-add is non-breaking; `usage-dashboard.tsx` still imports the components, not the prop types, until Step 4).

- [ ] **Step 3: Create the lazy boundary** — `cloud/src/litellm-portal/dashboard/views/usage-charts-lazy.tsx`. ONE thin `React.lazy` wrapper per echarts chart; all three dynamic-import their chart module which imports the shared `./echarts-core` — esbuild `splitting:true` dedups that into ONE non-main split chunk (the gate only requires echarts ∉ main ∧ ∃ a split chunk). It ALSO exports `warmUsageCharts()` (Step 5 / defense-in-depth + UX per the NEW-C-A preamble — NOT the thing that prevents #418 on the real path; construction does, per Open-Question (b)). Uses the `RankBarProps`/`ModelDonutProps` exports added in Step 3a. Ship VERBATIM:

```tsx
/**
 * Phase-3 §A.3 lazy boundary for the rendered ECharts chain (C1) AND its
 * #418-safe warm-up (NEW-C-A).
 *
 * usage-dashboard.tsx statically imported TrendChart/RankBar/ModelDonut, each
 * importing ./echarts-core (`import * as echarts from "echarts/core"` — the
 * bundle's largest contributor). React.lazy() severs that static edge so
 * esbuild's splitting:true build emits echarts into a separate chunk (bundle
 * gate, C2).
 *
 * #418 (NEW-C-A, verified Open-Question (b)): on the real SSR path the new
 * UsageDashboard's useDashboard key is UNSEEDED, so server-impl.tsx renders the
 * loading state (NOT <TrendChart>) and the client first-renders the same
 * loading state → server == client → no #418 from this boundary by
 * construction. `warmUsageCharts()` is retained as defense-in-depth (keeps
 * client==server IF a future change SSR-seeds the new dashboard key) + a
 * post-hydration UX win (no skeleton flash); client.tsx awaits it pre-hydrate
 * (fail-soft, mirrors client.tsx's `await router.load()` discipline).
 */
import React from "react";
import { PanelSkeleton } from "../../components/panel-state";
import type { TrendSeries } from "../charts/trend-chart";
import type { RankBarProps } from "../charts/rank-bar";
import type { ModelDonutProps } from "../charts/model-donut";

const importTrend = () => import("../charts/trend-chart");
const importRank = () => import("../charts/rank-bar");
const importDonut = () => import("../charts/model-donut");

const LazyTrend = React.lazy(() => importTrend().then((m) => ({ default: m.TrendChart })));
const LazyRank = React.lazy(() => importRank().then((m) => ({ default: m.RankBar })));
const LazyDonut = React.lazy(() => importDonut().then((m) => ({ default: m.ModelDonut })));

/**
 * Resolve all three chart chunks (and transitively echarts-core). Awaited
 * (fail-soft, try/catch) by client.tsx BEFORE hydrateRoot. On the real SSR
 * path (Open-Question (b)) the new dashboard key is unseeded so SSR==client
 * is the loading state and #418-safety is by construction, NOT by this warm-up
 * — kept as defense-in-depth (future SSR-seed) + post-hydration UX (no skeleton
 * flash). Idempotent; the dynamic imports are cached after the first call.
 */
export async function warmUsageCharts(): Promise<void> {
  await Promise.all([importTrend(), importRank(), importDonut()]);
}

export function TrendChartLazy(props: { series: TrendSeries[]; height?: number; ariaLabel?: string }) {
  return (
    <React.Suspense fallback={<PanelSkeleton lines={3} />}>
      <LazyTrend {...props} />
    </React.Suspense>
  );
}

export function RankBarLazy(props: RankBarProps) {
  return (
    <React.Suspense fallback={<PanelSkeleton lines={2} />}>
      <LazyRank {...props} />
    </React.Suspense>
  );
}

export function ModelDonutLazy(props: ModelDonutProps) {
  return (
    <React.Suspense fallback={<PanelSkeleton lines={2} />}>
      <LazyDonut {...props} />
    </React.Suspense>
  );
}
```

> `RankBarProps`/`ModelDonutProps` are created by Step 3a above (verified absent today — the chart files use inline prop literals); this file imports them. `TrendSeries` is already exported by `trend-chart.tsx`@5. The `warmUsageCharts()`/`React.lazy` boundary docstrings reflect the verified Open-Question (b): #418-safety on the real path is by construction (server==client==loading), the warm-up is defense-in-depth + UX, fail-soft in `client.tsx` (Step 5 try/catch). C2 (bundle split) is unaffected — the imports stay dynamic.

- [ ] **Step 4: Repoint `usage-dashboard.tsx` to the lazy boundary.** In `cloud/src/litellm-portal/dashboard/views/usage-dashboard.tsx`: delete the three static imports (`import { TrendChart } from "../charts/trend-chart"`@11, `ModelDonut`@12, `RankBar`@13 — re-anchor BY SYMBOL since Task 1 already edited this file), add `import { TrendChartLazy, RankBarLazy, ModelDonutLazy } from "./usage-charts-lazy";`, and replace every JSX usage (re-locate by symbol): `<TrendChart series={trendSeries} ariaLabel={trendAriaLabel} />` (the `ariaLabel` was added by Task 1 Step 14) → `<TrendChartLazy series={trendSeries} ariaLabel={trendAriaLabel} />`; `<RankBar rows={rankRows} />` → `<RankBarLazy rows={rankRows} />`; both `<ModelDonut slices={…} />` → `<ModelDonutLazy slices={…} />`. Props byte-identical (wrappers forward them). Route topology, the dashboard query, `trendSeries`/`rankRows` derivation, and Task-1's `trendAriaLabel` unchanged. NO Vite/FS plugin (esbuild `splitting:true` already produces the dynamic chunk).

- [ ] **Step 5: Add the pre-`hydrateRoot` echarts warm-up to `client.tsx` (defense-in-depth + UX; MAJOR-1 catch).** `cloud/src/litellm-portal/client.tsx`:46 currently does `Promise.all([import("react-dom/client")…, import("./router"), import("./routes/__root"), import("./shell")]).then(async ([…]) => { … await router.load(); hydrateRoot(…); })`. Per the verified Open-Question answer (b), the new `UsageDashboard`'s `useDashboard` key is UNSEEDED at SSR, so the server renders the loading state and the client first-renders the same loading state — the lazy boundary is #418-safe BY CONSTRUCTION on the real path (neither side enters the Suspense boundary on first render). The warm-up is retained as **defense-in-depth** (if a future change SSR-seeds the new key the warm-up keeps client==server) **+ post-hydration UX** (no transient skeleton flash when the dashboard query resolves). It MUST be fail-soft:

  (a) Add `import("./dashboard/views/usage-charts-lazy")` to the `Promise.all([...])` array@46-52 and destructure `{ warmUsageCharts }` in the `.then(async ([...]) => {` parameter list (append `, { warmUsageCharts }` after `{ Shell }`, and add the matching `import("./dashboard/views/usage-charts-lazy")` as the LAST array element so positions line up).
  (b) Immediately after the existing `await router.load();`@57 (keep its comment), add (the Step-9 `hydration.test.tsx` `hydrateLikeClient` mirror MUST copy this verbatim, try/catch included, so the test path == the production path):

```tsx
  // Phase-3 §A.3 (NEW-C-A): warm the usage-charts dynamic chunk before
  // hydrateRoot. On the real SSR path the new UsageDashboard's useDashboard
  // key is unseeded (verified Open-Question (b)) so SSR == client == loading
  // state and there is NO #418 from the lazy boundary; this warm-up is
  // defense-in-depth (keeps client==server if a future change SSR-seeds the
  // new dashboard key → server would then render the resolved chart) plus a
  // post-hydration UX win (no skeleton flash when the dashboard query
  // resolves). MAJOR-1: MUST be fail-soft — a rejected chunk fetch (CDN blip,
  // post-redeploy chunk 404, cache evict) must NEVER prevent hydrateRoot;
  // worst case without it is a one-time chart-only client re-render, which is
  // strictly better than a global white screen on EVERY route (incl.
  // chart-less /ops/settings and login). Same pre-hydrate discipline as the
  // `await router.load()` above.
  try {
    await warmUsageCharts();
  } catch {
    // Swallow — proceed to hydrate. (See MAJOR-1 rationale above.)
  }
```

  This keeps the import dynamic (bundle stays split — C2 untouched) while making the client's first render byte-identical to the server's `allReady` HTML. `server-impl.tsx` needs NO change (its `allReady` already resolves the boundary; verified@163). The Worker SSR path imports `app.tsx` not `client.tsx` (client.tsx header@5-6) so this is browser-only and cannot affect SSR.

- [ ] **Step 6: Extend `cloud/scripts/build-litellm-portal-app.mjs` with the §A.3 CI HARD GATE (mirror its existing throw-idiom).** The script already builds `client.tsx` with `splitting:true`/`outdir`, computes `chunks` with `kind` ∈ `main|admin|chunk` via `chunkKind(output)`, finds `mainChunk = chunks.find(c => c.kind === "main")`, and `throw`s on `leakedAdminInputs`/budget. Add an analogous block immediately AFTER the existing `leakedAdminInputs` check (anchor: just after the `if (leakedAdminInputs.length > 0) { throw … }` block, ~line 134, BEFORE `const budgetFailures = [`):

```js
// ---------------------------------------------------------------------------
// Phase-3 §A.3 CI HARD GATE: echarts MUST NOT be in the main chunk, and MUST
// exist in some non-main split chunk (i.e. it is lazily code-split, not in the
// initial download). No KB threshold — observational gzip delta is logged
// below via the existing per-chunk report. Mirrors the admin-input throw idiom.
// ---------------------------------------------------------------------------
const ECHARTS_INPUT_RE = /node_modules\/echarts\//;
const echartsInMain = mainChunk.inputs.filter((input) => ECHARTS_INPUT_RE.test(input));
const echartsSplitChunk = chunks.find(
  (chunk) => chunk.kind !== "main" && chunk.inputs.some((input) => ECHARTS_INPUT_RE.test(input)),
);
if (echartsInMain.length > 0) {
  console.log("ECHARTS_LAZY_GATE: FAIL");
  throw new Error(
    `§A.3 gate: echarts is in the MAIN chunk (must be lazily code-split):\n${echartsInMain.map((i) => `- ${i}`).join("\n")}`,
  );
}
if (!echartsSplitChunk) {
  console.log("ECHARTS_LAZY_GATE: FAIL");
  throw new Error("§A.3 gate: echarts not found in any non-main split chunk (chart may be unreachable or wrongly bundled)");
}
console.log(
  `ECHARTS_LAZY_GATE: PASS (echarts isolated to split chunk ${require("node:path").basename(echartsSplitChunk.path)}, absent from main)`,
);
```

> `mainChunk.inputs` is `Object.keys(output.inputs).sort()` (already computed in the `chunks` map — verified: each chunk has `.inputs` = sorted input paths and `.kind`). The block throws BEFORE `budgetFailures` so a gate failure fails the build (and CI) exactly like the existing admin/budget throws. The executor MUST use the already-imported `basename` (NOT `require`) — confirmed `import { basename, relative } from "node:path"`@3; replace the `require("node:path").basename(...)` shown with `basename(echartsSplitChunk.path)`.
>
> **pnpm virtual-store note (round-2 MINOR):** the substring regex `/node_modules\/echarts\//` matches both a flat `node_modules/echarts/...` input AND the pnpm virtual-store form `node_modules/.pnpm/echarts@<ver>/node_modules/echarts/...` (the trailing `/node_modules/echarts/` segment is present in both — esbuild metafile input paths include the real resolved path). Keep the simple substring match; do NOT over-engineer a pnpm-aware path parser. The Step-7 REAL build run (`bun run generate:litellm-portal-app` against the actual installed tree) is the source of truth — if the regex somehow missed the real input path the gate would FAIL loudly there (a missed match → `echartsSplitChunk` undefined → the second `throw`), so it cannot silently false-pass.

- [ ] **Step 7: Add the redirect note to `analyze-litellm-portal-bundle.mjs` (it is NOT the gate — C2).** In `cloud/scripts/analyze-litellm-portal-bundle.mjs`, add a top-of-file comment: `// NOTE (Phase-3 §A.3): this builds app.tsx single-bundle (no splitting) and is OBSERVATIONAL ONLY. The ECharts-lazy CI HARD GATE lives in build-litellm-portal-app.mjs (the real client.tsx splitting build). Do not add the gate here — wrong artifact.` No logic change.

- [ ] **Step 8: Run → PASS** — `cd /Users/xumingyang/github/contrabass/cloud && bun run test src/litellm-portal/bundle-gate.test.ts` → PASS (`bun run generate:litellm-portal-app` exits 0 and prints `ECHARTS_LAZY_GATE: PASS`; echarts now in a split chunk, absent from `main`). Capture the printed per-chunk report (`- main … gzip`, `- chunk …echarts… gzip`) for Step 10. Note: this regenerates `app.generated.ts` — it will be re-regenerated and committed in Task 9 Step 5; do not commit it here unless it changed meaningfully (Task 9 owns the final embed commit).

- [ ] **Step 9: Add the SSR↔hydrate PARITY test to `hydration.test.tsx` (the spec-§E-1-MANDATED #418 guard — NEW-C-A; NOT a client-only `router.test.tsx` mount, which CANNOT detect an SSR-string-vs-hydrate divergence).** Read `cloud/src/litellm-portal/hydration.test.tsx` first — it has the real harness: `renderPortalSSR(env, identity, initialData, nonce, requestUrl, "zh-CN")` → HTML string → `loadSsrDocument(html)` (replaces the live document with the SSR markup via `document.write`) → `hydrateLikeClient()` (mirrors `client.tsx`: `createPortalRouter` → `await router.load()` → `hydrateRoot(document, <I18nProvider><Shell><AppShell><RouterProvider/>…)`) → assert NO captured `console.error/warn` matching the hydration-mismatch patterns. Two mandatory changes:

  (a) **Make `hydrateLikeClient` mirror the FIXED `client.tsx` VERBATIM, including the MAJOR-1 try/catch.** In `hydration.test.tsx`, in `hydrateLikeClient()` immediately AFTER its existing `await router.load();`@92 add the SAME fail-soft warm-up `client.tsx` Step 5(b) uses (the harness MUST be byte-faithful to the production bootstrap or it tests a non-prod path):

```tsx
  // Mirror the Phase-3 client.tsx Step-5(b) fail-soft warm-up VERBATIM
  // (NEW-C-A + MAJOR-1). client.tsx does exactly this try/catch after its
  // `await router.load()`; the harness must match or it tests a path that is
  // not production.
  try {
    const { warmUsageCharts } = await import("./dashboard/views/usage-charts-lazy");
    await warmUsageCharts();
  } catch {
    // Swallow — proceed to hydrate (mirrors client.tsx MAJOR-1).
  }
```

  (b) **Add the TWO usage-route PARITY cases asserting the TRUE harness-achievable invariant (CRITICAL-1).** Per the verified Open-Question (b), `renderPortalSSR("/usage")` renders the new `UsageDashboard`'s LOADING state (`<DashboardStatus>加载中…</DashboardStatus>` — the new `dashboard/use-dashboard` key is unseeded; `数据同步中` is the `!data.available` variant, not reached when `data===undefined`), NOT `<TrendChart>`. The true §E-1 invariant is **SSR string === client first-hydrate render, zero #418**, for the REAL loading state. Append a `for` block mirroring the existing `TASK_1W_CASES` idiom (same `renderPortalSSR`→`loadSsrDocument`→`hydrateLikeClient`→`hydrationErrors` filter shape — copy it verbatim), at the end of the top-level `describe`:

```tsx
  /**
   * Phase-3 §A.3 (NEW-C-A, verified Open-Question (b)): the new UsageDashboard's
   * useDashboard key is UNSEEDED at SSR (server-impl.tsx seeds the OLD
   * hooks/use-dashboard ["dashboard"] key + DashboardSchema; the new
   * dashboard/use-dashboard key ["dashboard","self","","30d"] +
   * DashboardResponseSchema is different). So renderPortalSSR("/usage")
   * renders the loading placeholder (加载中…), NOT <TrendChart>; the client
   * first-hydrate render renders the SAME loading placeholder (same unseeded
   * key) → server == client → NO #418 from the lazy boundary by construction.
   * These cases PROVE that parity (no hydration mismatch) and PIN the verified
   * real behavior (SSR has the loading marker, NOT data-chart="trend") so a
   * future regression that SSR-resolves the chart without warm-up flips the
   * pin and the NEGATIVE-CONTROL case below would then catch the #418.
   */
  const USAGE_LAZY_PARITY_CASES: ReadonlyArray<{
    name: string;
    identity: PortalIdentity;
    initialData: Parameters<typeof renderPortalSSR>[2];
    url: string;
  }> = [
    {
      name: "tenant_admin /usage (lazy chart chain) SSR==hydrate, both loading",
      identity: {
        email: "a@x.com", userId: "u1", domain: "x.com", litellmUserId: "u1",
        role: "user", tenantRole: "tenant_admin", tenantTeamId: "t1",
      },
      initialData: { role: "user" } as unknown as Parameters<typeof renderPortalSSR>[2],
      url: "http://localhost/usage",
    },
    {
      name: "owner /ops/usage (global lazy chart chain) SSR==hydrate, both loading",
      identity: {
        email: "o@x.com", userId: "u2", domain: "x.com", litellmUserId: "u2",
        role: "admin", tenantRole: null, tenantTeamId: null,
      },
      initialData: { role: "admin" } as unknown as Parameters<typeof renderPortalSSR>[2],
      url: "http://localhost/ops/usage",
    },
  ];

  for (const tc of USAGE_LAZY_PARITY_CASES) {
    it(`server and client first render are identical (both loading): ${tc.name}`, async () => {
      const html = await renderPortalSSR(
        makeEnv(), tc.identity, tc.initialData, "test-nonce", tc.url, "zh-CN",
      );
      expect(html).toContain("<!doctype html>");
      // Verified real SSR behavior (Open-Question (b)): the new UsageDashboard
      // renders its loading placeholder server-side; it does NOT render the
      // chart (unseeded new dashboard key) and never enters the lazy Suspense
      // boundary. Pin BOTH directions so a future SSR-seed regression flips
      // these and is caught (here + by the negative control).
      expect(html).toContain("加载中…");
      expect(html).not.toContain('data-chart="trend"');
      expect(html).not.toContain("data-panel-skeleton");

      await loadSsrDocument(html);
      await hydrateLikeClient();

      const hydrationErrors = captured.filter(
        (m) =>
          /hydrat/i.test(m) ||
          /did not match/i.test(m) ||
          (/server rendered|client/i.test(m) && /server/i.test(m)) ||
          /Text content does not match/i.test(m),
      );
      if (hydrationErrors.length > 0) {
        throw new Error(
          `React hydration mismatch (#418) for "${tc.name}":\n\n` +
            hydrationErrors.join("\n--- next ---\n"),
        );
      }
      expect(hydrationErrors).toEqual([]);
    });
  }

  /**
   * NEGATIVE CONTROL (CRITICAL-1 (ii)) — distinguishes "warm-up actually
   * prevents a real #418" from "test vacuously passes because there's no SSR
   * data". Construct the desync the warm-up exists to defend against: SSR
   * renders loading (unseeded, as proven above), but the CLIENT is made to
   * first-render the RESOLVED chart by seeding the NEW dashboard/use-dashboard
   * key with a DashboardResponseSchema-valid available:true fixture in the
   * client QueryClient BEFORE hydrate. With the warm-up present (lazy chunk
   * pre-resolved) the client renders the chart synchronously on first paint →
   * it mismatches the server's loading HTML → a #418 IS expected here. This
   * proves the harness CAN observe a real mismatch (it is not blind); the
   * positive parity cases above passing then means parity is real, not vacuous.
   * NOTE: this asserts the mismatch IS detected (a sanity check on the
   * harness's detection power), NOT that production has this bug — production's
   * SSR key is unseeded so this exact desync never occurs in prod (Open-Q (b));
   * this is a controlled fault-injection that must be observable.
   */
  it("negative control: a client-only resolved chart vs SSR loading IS detected as a #418", async () => {
    const identity: PortalIdentity = {
      email: "a@x.com", userId: "u1", domain: "x.com", litellmUserId: "u1",
      role: "user", tenantRole: "tenant_admin", tenantTeamId: "t1",
    };
    const html = await renderPortalSSR(
      makeEnv(),
      { role: "user" } as unknown as Parameters<typeof renderPortalSSR>[2],
      identity as unknown as Parameters<typeof renderPortalSSR>[1],
      "test-nonce",
      "http://localhost/usage",
      "zh-CN",
    );
    expect(html).toContain("加载中…"); // SSR = loading (verified)

    await loadSsrDocument(html);
    // Seed the NEW dashboard/use-dashboard key so the client first render
    // resolves the chart (the desync the warm-up defends against). Read
    // dashboard/use-dashboard.ts for the exact DASHBOARD_QUERY_KEY({kind:
    // "self"},"30d") shape and dashboard-schemas.ts DashboardResponseSchema
    // for a minimal available:true + non-empty trend fixture; build that
    // fixture from the schema (parse it to guarantee validity). Inject it via
    // a custom hydrateLikeClient variant that pre-seeds the per-case
    // QueryClient with that key BEFORE hydrateRoot (mirror hydrateLikeClient
    // but add `qc.setQueryData(DASHBOARD_QUERY_KEY({kind:"self"},"30d"),
    // fixture)` before the warm-up + hydrateRoot — keep the try/catch warm-up
    // mirror). With the warm-up the lazy chunk is pre-resolved so the client
    // renders <TrendChart> synchronously on first paint vs SSR's loading HTML.
    const sawMismatch = await hydrateAndCaptureMismatch_withSeededDashboard();
    expect(sawMismatch).toBe(true); // the harness CAN observe a real #418
  });
```

> Implementation notes the executor MUST follow (read the files; no guessing): the negative control needs a small variant of `hydrateLikeClient` (call it `hydrateAndCaptureMismatch_withSeededDashboard`) that is `hydrateLikeClient` PLUS, before the warm-up+`hydrateRoot`, `queryClient.setQueryData(DASHBOARD_QUERY_KEY({ kind: "self" }, "30d"), fixture)` where `DASHBOARD_QUERY_KEY` is imported from `./dashboard/use-dashboard` and `fixture = DashboardResponseSchema.parse({ …minimal available:true, non-empty trend… })` from `./dashboard/dashboard-schemas` (build the minimal valid object by reading `dashboard-schemas.ts` — parse-to-validate so it cannot drift). It returns `captured.some(<the same hydrationErrors filter>)`. Keep the `try/catch warmUsageCharts()` mirror inside it (production parity). The positive cases prove parity for the real (loading) states; the negative control proves the test is not blind. The Task-10 Step-2 item-8 manual staging check additionally verifies the live production `client.tsx` (not just the harness) on `/usage`+`/ops/usage`. `renderPortalSSR`'s 5th arg is the request URL — verified: `requestUrl`→`new URL(requestUrl).pathname+search`→`createMemoryHistory({initialEntries:[initialPath]})`@server-impl.tsx:104-119, so `"http://localhost/usage"` SSR-routes to the usage screen. (Param order: `renderPortalSSR(env, identity, initialData, nonce, requestUrl, locale)` — verified from the existing `TASK_1W_CASES` calls; match it exactly.)

Run `cd /Users/xumingyang/github/contrabass/cloud && bun run test src/litellm-portal/hydration.test.tsx` → PASS (existing role/Task-1w cases + 2 new parity cases [both-loading, no mismatch] + the negative control [seeded-client desync IS detected]). The parity cases prove SSR==client for the REAL rendered states; the negative control proves the harness can observe a real mismatch (not a vacuous pass). `router.test.tsx` is NOT the #418 guard (a client-only mount cannot detect SSR-string-vs-hydrate divergence).

- [ ] **Step 10: `DESIGN.md` — update `### Chart / Bundle 决策` (append, do not rewrite).** Append after the existing 2026-05-10 bundle paragraph@539:

```markdown

2026-05-17 `litellm-portal-phase3` 将真实渲染的 ECharts 图表链（`usage-dashboard.tsx → trend-chart/rank-bar/model-donut → echarts-core.ts`）通过 `usage-charts-lazy.tsx` 的 `React.lazy` 边界拆分（route 拓扑不变；esbuild `splitting:true` 已在 `build-litellm-portal-app.mjs` 生效，无 Vite FS 插件）。CI HARD GATE 写在真实 code-split 构建 `build-litellm-portal-app.mjs`（`client.tsx` 入口）：断言 echarts 不在 `main` chunk 且存在于某个非-main split chunk，违反则 `throw`（构建/CI 失败），`ECHARTS_LAZY_GATE: PASS/FAIL` 标记，无 KB 阈值门槛。`analyze-litellm-portal-bundle.mjs` 仍为观测脚本（构建 `app.tsx` 单包，非门槛）。实测 before/after（观测，非门槛）：<plan 执行时由 Step 8 的 `bun run generate:litellm-portal-app` per-chunk 报告填入 main gzip / echarts split-chunk gzip>。**#418 SSR↔hydrate 一致性（关键，spec §E-1 锁定；经实证 Open-Question (b)）**：新 `UsageDashboard` 用的 `dashboard/use-dashboard` 查询键在 SSR 未被 seed（`server-impl.tsx` seed 的是旧 `hooks/use-dashboard` 的 `["dashboard"]` 键），故 `renderPortalSSR("/usage")` 服务端渲染**加载态**（`加载中…`），不渲染 `<TrendChart>`、不进入 lazy Suspense 边界；客户端首帧同样渲染该加载态（同一未 seed 键）⇒ 两端首帧一致，lazy 边界**天然无 #418**（双方首帧均不进入边界）。`client.tsx` 在 `hydrateRoot` 前 fail-soft `try { await warmUsageCharts() } catch {}` 为纵深防御（若未来某改动在 SSR 端 seed 新键则保持 client==server）+ 渲染后 UX（消除查询返回后的骨架闪烁），并非当前防 #418 的机制（构造即安全）。守卫 = `hydration.test.tsx`：2 个平价用例（断言 SSR 串含 `加载中…`、无 `data-chart="trend"`、无 `data-panel-skeleton`，且 hydrate 无 mismatch）+ 1 个负控（客户端 seed 新键使其首帧渲染图表 vs SSR 加载态，证明该 harness 能侦测真实 mismatch、非空过），**非** client-only `router.test.tsx` mount。
```

When running Step 8, capture the real `- main … gzip` and `- chunk …echarts… gzip` numbers from the build report and substitute them into `<plan 执行时…>` (observational record, NOT a gate).

- [ ] **Step 11: Commit**
```bash
cd /Users/xumingyang/github/contrabass
git add cloud/src/litellm-portal/dashboard/charts/rank-bar.tsx cloud/src/litellm-portal/dashboard/charts/model-donut.tsx cloud/src/litellm-portal/dashboard/views/usage-charts-lazy.tsx cloud/src/litellm-portal/dashboard/views/usage-dashboard.tsx cloud/src/litellm-portal/client.tsx cloud/scripts/build-litellm-portal-app.mjs cloud/scripts/analyze-litellm-portal-bundle.mjs cloud/src/litellm-portal/hydration.test.tsx cloud/src/litellm-portal/bundle-gate.test.ts cloud/src/litellm-portal/DESIGN.md
git -c commit.gpgsign=false commit -m "feat(litellm-portal): lazy-split echarts (CI gate + #418-safe warm-up)"
```

> **§A GATE — §B may NOT begin until this passes.** Before any §B task: `cd /Users/xumingyang/github/contrabass/cloud && bun run test src/litellm-portal/a11y src/litellm-portal/components src/litellm-portal/bundle-gate.test.ts src/litellm-portal/hydration.test.tsx src/litellm-portal/dashboard/charts/build-chart-aria.test.ts src/litellm-portal/dashboard/charts/trend-chart.test.tsx src/litellm-portal/tenant-portal/shell.test.tsx src/litellm-portal/ops-console/shell.test.tsx` ALL green + `bun run typecheck` baseline-only. This is the §A acceptance gate (decision 3 / §D.2) — it now includes the `hydration.test.tsx` #418 parity guard (NEW-C-A).

---

## Task 4 (§B.1): shared `SideNav` + nav icons (chrome restyle core)

**Files:**
- Create: `cloud/src/litellm-portal/components/nav-icons.tsx`, `cloud/src/litellm-portal/components/side-nav.tsx`, `cloud/src/litellm-portal/components/side-nav.test.tsx`
- Modify: `cloud/src/litellm-portal/DESIGN.md`

> **§B.0 non-change list (hard boundary — declare before extending):** semantic colors stay text-only (`-tint` only for pill/badge bg); hierarchy tokens (canvas/base/elevated/recessed/tint/fill) mapping unchanged; typography tokens (heading ≤600, mono numbers, 12px uppercase metric label, `tracking-tight` page title) NOT overridden; radius system unchanged; NO `shadow-*`; no Kumo fork; no semantic/hierarchy/typography token override; Ops steel / ignore-branding untouched. `side-nav.tsx` uses ONLY Kumo tokens + Tailwind utilities + the icon resolver.

- [ ] **Step 1: Icon source — RESOLVED (C3, verified, NOT an impl-time decision).** Empirical fact (verified 2026-05-17): `@cloudflare/kumo@2.1.0` has 100 package exports and **ZERO icon exports** (no `./components/icon`, no icon set). `@phosphor-icons/react` is a Kumo **peerDependency `^2.1.10`** (installed in `cloud/node_modules`) but is **NOT re-exported by Kumo**. Therefore the spec's §E-2 "Kumo built-in icon set (primary)" is **unimplementable**, and its own fallback ("zero-dependency inline SVG") is the de-facto path. **RULING (in-plan, final):** Phase-3 nav icons are **100% hand-authored zero-dependency inline `<svg>`**. `@phosphor-icons/react` is **FORBIDDEN** — importing a transitive peer dep directly to dodge the spec's "no new icon dependency" rule defeats its intent (it would add a real runtime dependency edge that did not exist before). This is an empirical resolution of §E-2 (Kumo's primary is absent), NOT a re-opening of the locked decision. No probe needed — Step 4 ships complete inline SVG for all 10 slots.

- [ ] **Step 2: Write the failing `SideNav` test** — `cloud/src/litellm-portal/components/side-nav.test.tsx`

```tsx
/**
 * @vitest-environment happy-dom
 */
import React from "react";
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import { I18nProvider } from "@lingui/react";
import { setupI18n } from "../i18n/setup";
import { SideNav, type SideNavGroup } from "./side-nav";

const i18n = setupI18n("zh-CN");
afterEach(cleanup);

const groups: SideNavGroup[] = [
  {
    heading: "我的",
    items: [
      { href: "/", label: "概览", icon: "overview" },
      { href: "/usage", label: "用量", icon: "usage" },
    ],
  },
  {
    heading: "团队管理",
    items: [{ href: "/members", label: "成员", icon: "members" }],
  },
];

function renderNav(currentPath: string) {
  return render(
    <I18nProvider i18n={i18n}>
      <SideNav groups={groups} currentPath={currentPath} accent="brand" ariaLabel="租户导航" />
    </I18nProvider>,
  );
}

describe("SideNav (§B.1)", () => {
  it("the matched item carries aria-current=page and an active accent bar", () => {
    renderNav("/usage");
    const active = screen.getByRole("link", { current: "page" });
    expect(active.getAttribute("href")).toBe("/usage");
    expect(active.querySelector("[data-active-accent-bar]")).not.toBeNull();
  });

  it("non-active items carry no aria-current and no accent bar", () => {
    renderNav("/usage");
    const overview = screen.getByRole("link", { name: /概览/ });
    expect(overview.getAttribute("aria-current")).toBeNull();
    expect(overview.querySelector("[data-active-accent-bar]")).toBeNull();
  });

  it("every item carries the shared focus ring and a hover=tint class", () => {
    renderNav("/");
    for (const l of screen.getAllByRole("link")) {
      expect(l.className).toContain("focus-visible:ring-kumo-brand");
      expect(l.className).toContain("hover:bg-kumo-tint");
    }
  });

  it("renders group headings as subtle 12px uppercase labels", () => {
    renderNav("/");
    expect(screen.getByText("我的")).toBeTruthy();
    expect(screen.getByText("团队管理")).toBeTruthy();
  });

  it("renders an icon slot per item", () => {
    const { container } = renderNav("/");
    expect(container.querySelectorAll("[data-nav-icon]").length).toBe(3);
  });
});
```

- [ ] **Step 3: Run → FAIL** — `cd /Users/xumingyang/github/contrabass/cloud && bun run test src/litellm-portal/components/side-nav.test.tsx` → FAIL (modules missing).

- [ ] **Step 4: Implement `cloud/src/litellm-portal/components/nav-icons.tsx` — COMPLETE, zero-dependency inline SVG for all 10 slots (C3-resolved; no placeholder, no Kumo icon, no `@phosphor-icons/react`).** Every icon is a 16×16 `currentColor`-stroked inline `<svg aria-hidden="true">` wrapped in a `data-nav-icon` span (`text-kumo-subtle` at rest; `SideNav` flips it to the active color via `currentColor`). Ship this file VERBATIM:

```tsx
/**
 * Nav icon set (Phase-3 §B.1; §E-2 RESOLVED — C3).
 *
 * @cloudflare/kumo@2.1.0 ships NO icon export (verified: 100 exports, zero
 * icon). @phosphor-icons/react is a Kumo peerDependency but is FORBIDDEN here
 * (adding a real runtime dependency edge defeats the spec's "no new icon
 * dependency" rule). These are hand-authored, zero-dependency, 16×16,
 * currentColor-stroked, aria-hidden inline SVGs. SideNav recolors via
 * currentColor (subtle at rest, accent when active).
 */
import React from "react";

export type NavIconName =
  | "overview"
  | "usage"
  | "keys"
  | "members"
  | "budget"
  | "billing"
  | "tenant-overview"
  | "provisioning"
  | "audit"
  | "settings";

const PATHS: Record<NavIconName, React.ReactNode> = {
  // grid / dashboard
  overview: (
    <>
      <rect x="2.5" y="2.5" width="4.5" height="4.5" rx="1" />
      <rect x="9" y="2.5" width="4.5" height="4.5" rx="1" />
      <rect x="2.5" y="9" width="4.5" height="4.5" rx="1" />
      <rect x="9" y="9" width="4.5" height="4.5" rx="1" />
    </>
  ),
  // ascending bars
  usage: (
    <>
      <line x1="3" y1="13" x2="3" y2="9" />
      <line x1="6.5" y1="13" x2="6.5" y2="6" />
      <line x1="10" y1="13" x2="10" y2="8" />
      <line x1="13" y1="13" x2="13" y2="4" />
    </>
  ),
  // key
  keys: (
    <>
      <circle cx="5.5" cy="6" r="2.75" />
      <path d="M7.4 7.9 L13 13.5 M11 11.5 l1.5 -1.5 M12.3 12.8 l1.2 -1.2" />
    </>
  ),
  // two people
  members: (
    <>
      <circle cx="6" cy="5.5" r="2.25" />
      <path d="M2.5 13 c0 -2.5 7 -2.5 7 0" />
      <path d="M10 4 a2.25 2.25 0 0 1 0 4.4 M11 13 c0 -1.7 -1 -2.6 -2.2 -3" />
    </>
  ),
  // gauge
  budget: (
    <>
      <path d="M2.5 12 a5.5 5.5 0 0 1 11 0" />
      <line x1="8" y1="12" x2="11" y2="7.5" />
      <circle cx="8" cy="12" r="0.9" fill="currentColor" stroke="none" />
    </>
  ),
  // document with lines
  billing: (
    <>
      <path d="M4 2.5 h5 l3 3 v8 h-8 z" />
      <path d="M9 2.5 v3 h3" />
      <line x1="5.75" y1="9" x2="10.25" y2="9" />
      <line x1="5.75" y1="11.25" x2="10.25" y2="11.25" />
    </>
  ),
  // building (tenants overview)
  "tenant-overview": (
    <>
      <rect x="3" y="2.75" width="7" height="10.5" rx="0.5" />
      <line x1="11.5" y1="6" x2="13" y2="6" /><line x1="11.5" y1="6" x2="11.5" y2="13.25" />
      <line x1="5" y1="5" x2="6" y2="5" /><line x1="7" y1="5" x2="8" y2="5" />
      <line x1="5" y1="7.5" x2="6" y2="7.5" /><line x1="7" y1="7.5" x2="8" y2="7.5" />
    </>
  ),
  // person-plus (provisioning / invites)
  provisioning: (
    <>
      <circle cx="6" cy="5.5" r="2.25" />
      <path d="M2.5 13 c0 -2.6 7 -2.6 7 0" />
      <line x1="11.75" y1="6" x2="11.75" y2="10" /><line x1="9.75" y1="8" x2="13.75" y2="8" />
    </>
  ),
  // checklist (audit)
  audit: (
    <>
      <path d="M4 2.75 h8 v10.5 h-8 z" />
      <path d="M5.5 6 l1 1 l2 -2.2" />
      <line x1="9.5" y1="5.75" x2="11" y2="5.75" />
      <path d="M5.5 9.75 l1 1 l2 -2.2" />
      <line x1="9.5" y1="9.5" x2="11" y2="9.5" />
    </>
  ),
  // gear (settings)
  settings: (
    <>
      <circle cx="8" cy="8" r="2" />
      <path d="M8 1.75 v1.6 M8 12.65 v1.6 M1.75 8 h1.6 M12.65 8 h1.6 M3.6 3.6 l1.15 1.15 M11.25 11.25 l1.15 1.15 M12.4 3.6 l-1.15 1.15 M4.75 11.25 l-1.15 1.15" />
    </>
  ),
};

export function NavIcon({ name }: { name: NavIconName }): React.ReactElement {
  return (
    <span
      data-nav-icon
      className="inline-flex h-4 w-4 shrink-0 items-center justify-center text-kumo-subtle"
    >
      <svg
        aria-hidden="true"
        width="16"
        height="16"
        viewBox="0 0 16 16"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.25"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        {PATHS[name]}
      </svg>
    </span>
  );
}
```

> This is complete, dependency-free, type-exhaustive (`Record<NavIconName, …>` forces a node per slot — adding a `NavIconName` without a path is a compile error). The exact SVG path geometry is illustrative-but-valid markup (renders a recognizable glyph; the tests assert the `data-nav-icon` slot + `<svg aria-hidden>` presence, NOT pixel shapes — consistent with "no pixel mockups"). The executor ships this file VERBATIM (tweaking a path `d` for visual polish is allowed; the structure/contract — `NavIconName` union, `Record` exhaustiveness, `data-nav-icon` span, 16×16 `currentColor` `aria-hidden` svg — is FIXED). NO Kumo icon import (Kumo has none — C3), NO `@phosphor-icons/react` (forbidden — C3), NO probe, NO deferred choice.

- [ ] **Step 5: Implement `cloud/src/litellm-portal/components/side-nav.tsx`**

```tsx
/**
 * Shared left navigation (Phase-3 §B.1). Both shells render this; the shell
 * supplies `accent` ("brand" = tenant brand `--kumo-brand`; "steel" = Ops
 * fixed steel, also delivered via `--kumo-brand` set by OPS_STEEL_ACCENT) and
 * `currentPath` (from the shell's useRouterState). Structure is identical
 * across shells; tone differs only by accent + the shell's density wrapper.
 *
 * Per item: 16px icon + label; matched route gets a 2px left accent bar
 * (data-active-accent-bar), bg-kumo-tint, text-kumo-strong, aria-current=page.
 * Hover = bg-kumo-tint. Focus = shared FOCUS_RING. Group headings = subtle
 * 12px uppercase tracking-wider. No shadows; only Kumo tokens + utilities.
 */
import React from "react";
import { Text } from "@cloudflare/kumo/components/text";
import { FOCUS_RING } from "../a11y/focus";
import { NavIcon, type NavIconName } from "./nav-icons";

export type SideNavItem = { href: string; label: React.ReactNode; icon: NavIconName };
export type SideNavGroup = { heading?: string; items: SideNavItem[] };
export type SideNavAccent = "brand" | "steel";

export function SideNav({
  groups,
  currentPath,
  accent,
  ariaLabel,
}: {
  groups: SideNavGroup[];
  currentPath: string;
  accent: SideNavAccent;
  ariaLabel: string;
}) {
  // Both accents resolve through --kumo-brand (the shell sets it: tenant brand
  // or OPS_STEEL_ACCENT steel). The accent bar uses bg-kumo-brand either way;
  // `accent` exists for explicitness/testing, not a second color path.
  return (
    <nav aria-label={ariaLabel} className="w-56 shrink-0 border-r border-kumo-line bg-kumo-elevated px-3 py-6">
      <div className="space-y-6">
        {groups.map((group, gi) => (
          <div key={group.heading ?? `g${gi}`} className="space-y-1">
            {group.heading ? (
              <Text
                as="p"
                variant="secondary"
                size="xs"
                className="px-3 pb-1 font-semibold uppercase tracking-wider text-kumo-subtle"
              >
                {group.heading}
              </Text>
            ) : null}
            <ul className="space-y-1">
              {group.items.map((item) => {
                const isActive = currentPath === item.href;
                return (
                  <li key={item.href}>
                    <a
                      href={item.href}
                      aria-current={isActive ? "page" : undefined}
                      data-accent={accent}
                      className={`relative flex items-center gap-2 rounded-md px-3 py-2 text-sm font-medium transition-colors motion-safe:duration-100 hover:bg-kumo-tint hover:text-kumo-strong ${
                        isActive ? "bg-kumo-tint text-kumo-strong" : "text-kumo-default"
                      } ${FOCUS_RING}`}
                    >
                      {isActive ? (
                        <span
                          data-active-accent-bar
                          aria-hidden="true"
                          className="absolute inset-y-1 left-0 w-0.5 rounded-full bg-kumo-brand transition-all motion-safe:duration-150"
                        />
                      ) : null}
                      <NavIcon name={item.icon} />
                      <span className="truncate">{item.label}</span>
                    </a>
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
      </div>
    </nav>
  );
}
```

- [ ] **Step 6: Run → PASS** — `cd /Users/xumingyang/github/contrabass/cloud && bun run test src/litellm-portal/components/side-nav.test.tsx` → PASS (5 tests). `bun run typecheck` → baseline-only.

- [ ] **Step 7: `DESIGN.md` — add `## Shell / SideNav`.** Insert after `## Density Scale`:

```markdown
## Shell / SideNav (Phase 3 §B.1)

Both shells render one shared `components/side-nav.tsx`; structure is identical, tone differs only by accent + the shell density wrapper.

- **Active/current item:** 2px left accent bar (`bg-kumo-brand` — tenant brand on Tenant, steel on Ops since `OPS_STEEL_ACCENT` sets `--kumo-brand` to steel) + `bg-kumo-tint` + `text-kumo-strong` + `aria-current="page"`.
- **Hover:** `bg-kumo-tint` (normalized — the old `hover:bg-kumo-canvas` was near-invisible on the elevated nav).
- **Icon:** 16px per item, `text-kumo-subtle` at rest, accent color when active (via `currentColor`). Source: hand-authored zero-dependency inline `<svg>` (`components/nav-icons.tsx`) — Kumo@2.1.0 ships NO icon set and `@phosphor-icons/react` is forbidden (C3 / §E-2 resolved); NEVER an icon dependency.
- **Group headings:** 12px uppercase `tracking-wider` `text-kumo-subtle` (Tenant: 我的 / 团队管理; Ops: 租户 / 平台).
- **Focus:** the shared `FOCUS_RING`.
- **Density:** Tenant chrome = comfortable; Ops chrome = compact (shell `DensityProvider`). Hairline is `border-kumo-line` everywhere (the old `border-kumo-default` mis-token is normalized).
```

- [ ] **Step 8: Commit**
```bash
cd /Users/xumingyang/github/contrabass
git add cloud/src/litellm-portal/components/nav-icons.tsx cloud/src/litellm-portal/components/side-nav.tsx cloud/src/litellm-portal/components/side-nav.test.tsx cloud/src/litellm-portal/DESIGN.md
git -c commit.gpgsign=false commit -m "feat(litellm-portal): shared SideNav + nav icons"
```

---

## Task 5 (§B.1/§B.5): Tenant Portal shell restyle (brand identity summary bar)

**Files:** Modify `cloud/src/litellm-portal/tenant-portal/shell.tsx`, `cloud/src/litellm-portal/tenant-portal/shell.test.tsx`

(File-disjoint from Task 6 — different shell file; both consume the Task-4 `SideNav`. Serialized after the §A GATE.)

> **M3 — ANCHORS ARE PRE-DRIFTED. Re-locate BY SYMBOL, not line.** Task 1 Step 9 already edited `tenant-portal/shell.tsx` (added `import { useRouterState }`, `import { FOCUS_RING }`, the `const pathname = useRouterState(...)` line, and rewrote the nav `<a>` with `aria-current`/`FOCUS_RING`/`hover:bg-kumo-tint`). Task 2 Step 9 wrapped its body in `<DensityProvider density="comfortable">`. So the line numbers in the Prerequisites anchor list (`BrandBar`@72-88, the nav `<ul>`@166-178, `<main>`@156/179) NO LONGER hold. Before editing: re-find `function BrandBar`, the `<nav aria-label={t\`租户导航\`}>`/`<ul>` block, and the content `<main>` BY SYMBOL/grep in the CURRENT file; do not trust pre-Task-1/2 line numbers anywhere in this task.

- [ ] **Step 1: Write the failing summary-bar + SideNav test.** Append to `cloud/src/litellm-portal/tenant-portal/shell.test.tsx`:

```tsx
describe("TenantPortalShell §B.1 restyle", () => {
  it("renders the brand identity summary bar (logo slot + name + budget meter region + alert dot)", () => {
    renderWithI18n(
      <TenantPortalShell
        identity={{ ...baseIdentity, tenantRole: "tenant_admin", tenantTeamId: "t1" }}
        brand={{ name: "Acme", logoUrl: null, primaryColor: null }}
      >
        <div>child</div>
      </TenantPortalShell>,
    );
    expect(document.querySelector("[data-brand-summary-bar]")).not.toBeNull();
    expect(document.querySelector("[data-brand-alert-dot]")).not.toBeNull();
  });

  it("uses border-kumo-line (not border-kumo-default) on the summary bar", () => {
    renderWithI18n(
      <TenantPortalShell
        identity={{ ...baseIdentity, tenantRole: "tenant_admin", tenantTeamId: "t1" }}
        brand={{ name: "Acme", logoUrl: null, primaryColor: null }}
      >
        <div>child</div>
      </TenantPortalShell>,
    );
    const bar = document.querySelector("[data-brand-summary-bar]") as HTMLElement;
    expect(bar.className).toContain("border-kumo-line");
    expect(bar.className).not.toContain("border-kumo-default");
  });

  it("renders the shared SideNav with grouped items for a tenant_admin", () => {
    renderWithI18n(
      <TenantPortalShell
        identity={{ ...baseIdentity, tenantRole: "tenant_admin", tenantTeamId: "t1" }}
        brand={{ name: "Acme", logoUrl: null, primaryColor: null }}
      >
        <div>child</div>
      </TenantPortalShell>,
    );
    const nav = within(screen.getByRole("navigation"));
    expect(nav.getByText("我的")).toBeTruthy();
    expect(nav.getByText("团队管理")).toBeTruthy();
  });
});
```

(The first two tests render `TenantPortalShell` standalone; `useRouterState` is called inside the shell from Task 1 — wrap the standalone render in a minimal memory router OR keep the Task-1 production-router `renderTenantAt` helper. Reuse the Task-1 `renderTenantAt(path)` helper added to this file for any test needing routing; for the standalone `renderWithI18n` cases, the shell's `useRouterState` resolves against the nearest router — add a minimal `createPortalRouter`+`RouterProvider` wrapper if happy-dom throws "no router", mirroring the Task-1 helper. Prefer `renderTenantAt("/")` to keep one harness.)

- [ ] **Step 2: Run → FAIL** — `cd /Users/xumingyang/github/contrabass/cloud && bun run test src/litellm-portal/tenant-portal/shell.test.tsx` → FAIL (no summary bar, still bare `<a>` nav, still `border-kumo-default`).

- [ ] **Step 3: Restyle `cloud/src/litellm-portal/tenant-portal/shell.tsx`.** Replace `BrandBar`@72-88 with a `BrandSummaryBar` that keeps logo + name (existing safe-logo logic@61-70 unchanged) and ADDS, on the right, a compact budget `Meter` (reuse `import { Meter } from "@cloudflare/kumo/components/meter";`) fed from the hydrated `useDashboard()` team/personal spend-vs-budget (mirror `overview.tsx` `TeamBudgetTile` data path@122-126) + an alert status dot (`data-brand-alert-dot`, `bg-kumo-success`/`bg-kumo-warning` via the existing `useTenantWebhook` configured/over-budget signal — reuse, no new query). Mark the bar `data-brand-summary-bar` and normalize `border-b border-kumo-default`@77 → `border-b border-kumo-line`. Replace the bare nav `<ul>` block@166-178 with the shared `SideNav`: build `groups: SideNavGroup[]` from the existing `resolveNav(identity)` result split into the "我的" group (`/`,`/usage`,`/keys`) and "团队管理" group (`/members`,`/alerts`,`/billing`, only when present in `nav`), map each `NavItem` to `{ href, label, icon }` (icons: overview/usage/keys/members/budget/billing). Pass `currentPath={pathname}` (the Task-1 `useRouterState` value), `accent="brand"`, `ariaLabel={t\`租户导航\`}`. Keep `DensityProvider density="comfortable"` (Task 2) and the route-enter motion (Task 7 adds it to `<main>`). The pure-Owner `OwnerPhase2Notice` branch@90-108/155-159 and `ImpersonationBanner`@110-141 are UNCHANGED.

- [ ] **Step 4: Run → PASS** — `cd /Users/xumingyang/github/contrabass/cloud && bun run test src/litellm-portal/tenant-portal/shell.test.tsx src/litellm-portal/tenant-portal/shell-impersonation.test.tsx` → PASS (existing nav-variant tests still pass — `SideNav` still renders the correct member vs admin items; impersonation banner regression-safe). `bun run typecheck` → baseline-only.

- [ ] **Step 5: Commit**
```bash
cd /Users/xumingyang/github/contrabass
git add cloud/src/litellm-portal/tenant-portal/shell.tsx cloud/src/litellm-portal/tenant-portal/shell.test.tsx
git -c commit.gpgsign=false commit -m "feat(litellm-portal): tenant shell restyle — brand summary bar + SideNav"
```

---

## Task 6 (§B.1/§B.5): Ops Console shell restyle (steel privileged chrome)

**Files:** Modify `cloud/src/litellm-portal/ops-console/shell.tsx`, `cloud/src/litellm-portal/ops-console/shell.test.tsx`

(File-disjoint from Task 5 — different shell file; both consume the Task-4 `SideNav`. May run in parallel with Task 5; both serialized after the §A GATE.)

> **M3 — ANCHORS ARE PRE-DRIFTED. Re-locate BY SYMBOL, not line.** Task 1 Step 9 already edited `ops-console/shell.tsx` (added `useRouterState`/`FOCUS_RING` imports, the unconditional `const pathname = useRouterState(...)` as the first body statement before the `isOwner` guard, and rewrote the Ops nav `<a>`). Task 2 Step 9 wrapped the Owner branch in `<DensityProvider density="compact">`. The Prerequisites anchors (`OPS_NAV`@16-22, the nav `<ul>`@88-100, the `内部·特权` chip@79-81, `style={OPS_STEEL_ACCENT}`@71, `<main>`@101) NO LONGER hold. Re-find `OPS_NAV`, the `<nav aria-label={t\`运营导航\`}>`/`<ul>` block, the privileged chip `<span>`, and the content `<main>` BY SYMBOL/grep in the CURRENT file; do not trust pre-Task-1/2 line numbers.

- [ ] **Step 1: Write the failing steel-pill + summary-chips + SideNav test.** Append to `cloud/src/litellm-portal/ops-console/shell.test.tsx` (reuse the Task-1 `renderOpsAt` helper added to this file):

```tsx
describe("OpsConsoleShell §B.1 restyle", () => {
  it("renders the privileged steel-ring pill (not a brand pill)", async () => {
    renderOpsAt("/ops");
    const pill = await screen.findByText(/内部 · 特权|内部·特权/);
    const el = pill.closest("[data-ops-privileged-pill]") as HTMLElement;
    expect(el).not.toBeNull();
    expect(el.className).toContain("ring-1");
  });

  it("renders the global-state summary chips region", async () => {
    renderOpsAt("/ops");
    expect(await screen.findByTestId("ops-summary-chips")).toBeTruthy();
  });

  it("renders the shared SideNav with Ops group headings (compact)", async () => {
    renderOpsAt("/ops");
    const nav = within(await screen.findByRole("navigation"));
    expect(nav.getByText("租户")).toBeTruthy();
    expect(nav.getByText("平台")).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run → FAIL** — `cd /Users/xumingyang/github/contrabass/cloud && bun run test src/litellm-portal/ops-console/shell.test.tsx` → FAIL (no steel pill marker, no summary chips, bare nav).

- [ ] **Step 3: Restyle `cloud/src/litellm-portal/ops-console/shell.tsx` (Owner branch only; 403 branch unchanged).** Replace the `内部·特权` chip@79-81 with a steel-ring pill: `<span data-ops-privileged-pill className="rounded-full ring-1 ring-kumo-brand px-2 py-0.5 text-xs font-medium text-kumo-subtle"><Trans>内部 · 特权</Trans></span>` (the ring color is `--kumo-brand` = steel via `OPS_STEEL_ACCENT`, NOT a tenant brand — Ops never adopts tenant branding; this is the §C.3 invariant restated and held). Add, to the right of the page-head `内部 · 特权` pill, a `data-testid="ops-summary-chips"` region rendering compact mono-number chips: tenant count + alerting-tenant count, fed from the hydrated `useOpsTenants()` (reuse the existing hook@`ops-console/hooks.ts`; derive counts client-side; tolerate undefined → render "—"). Replace the bare nav `<ul>`@88-100 with the shared `SideNav`: groups = "租户" (`/ops`,`/ops/provisioning`) + "平台" (`/ops/usage`,`/ops/audit`,`/ops/settings`), map `OPS_NAV`@16-22 entries to `{ href, label, icon }` (icons: tenant-overview/provisioning/usage/audit/settings), `currentPath={pathname}` (the Task-1 `useRouterState`), `accent="steel"`, `ariaLabel={t\`运营导航\`}`. Keep `DensityProvider density="compact"` (Task 2), `style={OPS_STEEL_ACCENT}`@71 UNCHANGED, hairline normalized to `border-kumo-line`.

- [ ] **Step 4: Run → PASS** — `cd /Users/xumingyang/github/contrabass/cloud && bun run test src/litellm-portal/ops-console/shell.test.tsx` → PASS (existing Owner/non-Owner gate tests + new). The non-Owner 403 branch is byte-unchanged. `bun run typecheck` → baseline-only.

- [ ] **Step 5: Commit**
```bash
cd /Users/xumingyang/github/contrabass
git add cloud/src/litellm-portal/ops-console/shell.tsx cloud/src/litellm-portal/ops-console/shell.test.tsx
git -c commit.gpgsign=false commit -m "feat(litellm-portal): ops shell restyle — steel pill + summary chips + SideNav"
```

---

## Task 7 (§B.2/§B.3/§B.4): card emphasis + state table + motion language

**Files:** Modify `cloud/src/litellm-portal/tenant-portal/shell.tsx`, `cloud/src/litellm-portal/ops-console/shell.tsx`, `cloud/src/litellm-portal/ops-console/screens/tenant-overview.tsx` (emphasis class on the existing article header — §B.2 is a class, NOT a new Panel* prop; see Step 3), `cloud/src/litellm-portal/DESIGN.md`; create `cloud/src/litellm-portal/components/motion.test.tsx`. (`panel-state.tsx` is NOT modified here — §B.2 emphasis is a header class, not a Panel* concern; see Step 3.)

> Shared files (`shell.tsx` ×2, `DESIGN.md`) — this task SERIALIZES after Tasks 5 & 6.
> **M3 — ANCHORS ARE PRE-DRIFTED.** Both shells were edited by Tasks 1/2/5/6 and `tenant-overview.tsx` by Task 2. Re-locate the content `<main>` (both shells) and `tenant-overview.tsx`'s `<div className="border-b border-kumo-line bg-kumo-elevated p-6">` article header BY SYMBOL/grep in the CURRENT files; do not trust any pre-Task-1/2/5/6 line number.

- [ ] **Step 1: Write the failing motion + emphasis test** — `cloud/src/litellm-portal/components/motion.test.tsx`

```tsx
/**
 * @vitest-environment happy-dom
 */
import React from "react";
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { I18nProvider } from "@lingui/react";
import { setupI18n } from "../i18n/setup";
import { RouterProvider } from "@tanstack/react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createPortalRouter, createMemoryHistory } from "../router";
import { AppShell } from "../routes/__root";
import { ME_QUERY_KEY } from "../hooks/use-me";
import type { Me } from "../schemas";

const i18n = setupI18n("zh-CN");
afterEach(cleanup);

const me: Me = {
  email: "a@x.com", userId: "u1", company: "Acme", domain: "x.com",
  role: "user", tenantRole: "tenant_admin", tenantTeamId: "t1",
};

describe("§B.4 motion language", () => {
  it("route-enter motion on main content is motion-safe gated and <=200ms", () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    qc.setQueryData(ME_QUERY_KEY, me);
    const router = createPortalRouter(createMemoryHistory({ initialEntries: ["/"] }), { role: "user" });
    const { container } = render(
      <QueryClientProvider client={qc}>
        <I18nProvider i18n={i18n}>
          <AppShell queryClient={qc}>
            <RouterProvider router={router} />
          </AppShell>
        </I18nProvider>
      </QueryClientProvider>,
    );
    const main = container.querySelector("main") as HTMLElement;
    expect(main.className).toContain("motion-safe:");
    // No transition/animation declared without the motion-safe variant gate,
    // and no duration token above 200ms anywhere on the shell tree.
    const all = container.querySelectorAll("*");
    for (const el of all) {
      const cls = (el as HTMLElement).className;
      if (typeof cls !== "string") continue;
      expect(cls).not.toMatch(/duration-(250|300|500|700|1000)/);
      expect(cls).not.toMatch(/\banimate-(spin|ping|bounce|pulse)\b/);
    }
  });
});
```

- [ ] **Step 2: Run → FAIL** — `cd /Users/xumingyang/github/contrabass/cloud && bun run test src/litellm-portal/components/motion.test.tsx` → FAIL (no `motion-safe:` route-enter class on `<main>`).

- [ ] **Step 3: Apply the exhaustive §B.4 motion allowlist.** In BOTH shells' content `<main>` (Tenant `shell.tsx`@156/179; Ops `shell.tsx`@101) add the route-enter class: `motion-safe:animate-[fadeUp_150ms_ease-out]` is NOT available (no custom keyframes — no Kumo fork / no new CSS). Instead use Tailwind built-ins gated by `motion-safe:`: `className="… motion-safe:transition-opacity motion-safe:duration-150"` plus an `opacity-100` baseline (the route remount re-runs the transition on key change — acceptable, no custom keyframes, ≤150ms, reduced-motion drops it). Add to the `SideNav` active accent bar (Task 4 already has `transition-all motion-safe:duration-150`) and hover (`transition-colors motion-safe:duration-100` — Task 4 already applied) — confirm those are present. NOWHERE introduce `duration-{250,300,500,700,1000}`, `animate-spin/ping/bounce/pulse`, parallax, autoplay, or overshoot easing. Add the optional emphasis header to `panel-state.tsx` is OUT — instead add a tiny `emphasis` prop site: extend `PanelError`/`PanelEmpty`? No — §B.2 emphasis is a card-header concern, not a Panel* concern. Implement §B.2 emphasis as a documented `DESIGN.md` convention + a class applied at the existing `data-panel` headers: a `border-l-2 border-kumo-brand` accent on the designated primary panel header (Tenant overview's hero panel / Ops tenant-overview article header) — apply this single class to those two existing article headers (`tenant-portal/screens/overview.tsx` `TopModelsTile` header is NOT the hero; the hero is the overview KPI band — apply emphasis to `ops-console/screens/tenant-overview.tsx`'s `<div className="border-b border-kumo-line bg-kumo-elevated p-6">`@78 by adding `border-l-2 border-kumo-brand`). Keep it minimal and structural (a class, not a new component).

- [ ] **Step 4: Run → PASS** — `cd /Users/xumingyang/github/contrabass/cloud && bun run test src/litellm-portal/components/motion.test.tsx src/litellm-portal/tenant-portal/shell.test.tsx src/litellm-portal/ops-console/shell.test.tsx` → PASS. `bun run typecheck` → baseline-only.

- [ ] **Step 5: `DESIGN.md` — add `## Motion` + the §B.3 state table.** Insert after `## Shell / SideNav`:

```markdown
## State Language (Phase 3 §B.3)

| Element | rest | hover | active/current | focus-visible |
|---|---|---|---|---|
| Nav item | `text-kumo-default` | `bg-kumo-tint text-kumo-strong` | 2px accent bar + `bg-kumo-tint` + `text-kumo-strong` + `aria-current` | `FOCUS_RING` |
| Clickable card/row | `bg-kumo-base` | `bg-kumo-tint` | `ring-2` shell accent | `FOCUS_RING` |
| Primary panel header | neutral elevated | — | `border-l-2 border-kumo-brand` (shell accent) | — |
| Primary CTA (Button primary) | Kumo default (`--kumo-brand`) | `--kumo-brand-hover` | — | Kumo default |

Shell accent = `--kumo-brand`: Tenant = tenant brand (§C); Ops = fixed steel (`OPS_STEEL_ACCENT`, unchanged).

## Motion (Phase 3 §B.4)

Restrained, only at high-impact moments, all reduced-motion safe (every motion class is `motion-safe:`-gated; `prefers-reduced-motion: reduce` drops to the end state instantly).

**Allowed (exhaustive — anything else is a violation):**
- Route enter: main content `transition-opacity` ≤ 150ms (no custom keyframes).
- Nav active accent bar: `transition-all` ≤ 150ms (bar slides between items).
- Hover background: `transition-colors` ≤ 100ms.
- Skeleton → content: cross-fade ≤ 120ms.

**Forbidden:** parallax, autoplay, entrance stagger chains, decorative loops, elastic/overshoot easing, any transition > 200ms. Principle (mirrors the no-shadow rule): motion is a highlight, not an atmosphere.
```

- [ ] **Step 6: Commit**
```bash
cd /Users/xumingyang/github/contrabass
git add cloud/src/litellm-portal/components/motion.test.tsx cloud/src/litellm-portal/tenant-portal/shell.tsx cloud/src/litellm-portal/ops-console/shell.tsx cloud/src/litellm-portal/ops-console/screens/tenant-overview.tsx cloud/src/litellm-portal/DESIGN.md
git -c commit.gpgsign=false commit -m "feat(litellm-portal): state table + reduced-motion-safe motion language"
```

---

## Task 8 (§C): extended tenant-branding surface model

> **SECURITY-ADJACENT TASK — treat with the Phase-1 branding security model.** `branding.ts` is the injection/contrast boundary. Locked invariants (do NOT relitigate): strict `#rrggbb` only (`HEX6_RE` unchanged); only `--kumo-brand`/`--kumo-brand-hover` ever emitted (NO new CSS vars — the 5 new brandable surfaces all reference the SAME `--kumo-brand`, inheriting the Phase-1 injection guard automatically); the extended WCAG-AA guard is **canvas + elevated + tint × light/dark = 6 checks, all-or-nothing fallback to `{}`** (§E-3; per-surface partial degradation REJECTED). Tests MUST cover injection rejection + each surface×mode pass/fall + the all-or-nothing fallback. Ops `/ops` keeps fixed steel and ignores tenant branding (§C.3 invariant — restated, untouched).

**Files:** Modify `cloud/src/litellm-portal/tenant-portal/branding.ts`, `cloud/src/litellm-portal/tenant-portal/branding.test.ts`, `cloud/src/litellm-portal/DESIGN.md`

- [ ] **Step 1: Write the failing 6-surface guard test.** Append to `cloud/src/litellm-portal/tenant-portal/branding.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { applyBrandVars, isAccessibleBrand } from "./branding";

describe("§C extended 6-surface brand guard", () => {
  it("still rejects every non-#rrggbb form → {} (injection contract unchanged)", () => {
    for (const bad of [
      "#fff", "red", "rgb(0,0,0)", "var(--x)", "url(x)", " #112233 ",
      "#11223", "#1122334", "#gggggg", "</style>", "#112233;color:red",
    ]) {
      expect(applyBrandVars({ name: "n", logoUrl: null, primaryColor: bad })).toEqual({});
    }
  });

  it("a color passing canvas+elevated+tint on BOTH modes is accepted and emits ONLY brand vars", () => {
    // Deep steel-blue: high enough contrast on canvas, elevated AND tint, both modes.
    const out = applyBrandVars({ name: "n", logoUrl: null, primaryColor: "#1f3a8a" });
    expect(Object.keys(out).sort()).toEqual(["--kumo-brand", "--kumo-brand-hover"]);
    expect((out as Record<string, string>)["--kumo-brand"]).toBe("#1f3a8a");
  });

  it("ALL-OR-NOTHING: a color passing canvas but failing elevated OR tint on either mode → {}", () => {
    // Mid-tone that clears the canvas-only Phase-1 bar but fails on the
    // lighter elevated/tint surface (the accepted §E-3 trade-off: some
    // Phase-1-passing tenants now fall back).
    const midtone = "#8a8f99";
    expect(isAccessibleBrand("#8a8f99")).toBe(false);
    expect(applyBrandVars({ name: "n", logoUrl: null, primaryColor: midtone })).toEqual({});
  });

  it("regression: a documented Phase-1-passing color may now fall back (accepted, still WCAG-AA)", () => {
    // This color cleared Phase-1 canvas-only (3:1 on #fafafa & #1a1a1a) but
    // fails the stricter elevated/tint surfaces → {} under §C. Asserting the
    // accepted trade-off explicitly so it is a conscious, tested behavior.
    const phase1OnlyPass = "#9ca3af";
    expect(applyBrandVars({ name: "n", logoUrl: null, primaryColor: phase1OnlyPass })).toEqual({});
  });
});
```

(During implementation, if a chosen sample color's empirical contrast does not land on the intended side of 3:1 for the surface luminances below, swap it for one that does — the INVARIANT under test is "6-surface all-or-nothing", the literal hex is just a witness; pick witnesses by computing `contrastRatio` against the surface luminances added in Step 3 and choosing values that unambiguously pass/fail. Do not weaken the assertion.)

- [ ] **Step 2: Run → FAIL** — `cd /Users/xumingyang/github/contrabass/cloud && bun run test src/litellm-portal/tenant-portal/branding.test.ts` → FAIL (`isAccessibleBrand` still canvas-only — the midtone/phase1-only colors still pass, so `applyBrandVars` does not return `{}`).

- [ ] **Step 3: Extend `isAccessibleBrand` to 6 surfaces (canvas+elevated+tint × light/dark).** In `cloud/src/litellm-portal/tenant-portal/branding.ts`, add the elevated + tint surface luminances next to the existing canvas constants@34-40 (use the Kumo theme values — light/dark `--color-kumo-elevated` and `--color-kumo-tint`; resolve them from `@cloudflare/kumo` theme-kumo.css the same achromatic-approximation way the canvas constants are derived, documented inline like the existing `#fafafa`/`#1a1a1a` comments):

```ts
/** Light/dark elevated surface (theme-kumo.css --color-kumo-elevated). */
const LIGHT_ELEVATED_LUMINANCE = relativeLuminanceFromHex("#f4f4f4");
const DARK_ELEVATED_LUMINANCE = relativeLuminanceFromHex("#242424");
/** Light/dark tint surface (theme-kumo.css --color-kumo-tint). */
const LIGHT_TINT_LUMINANCE = relativeLuminanceFromHex("#eeeeee");
const DARK_TINT_LUMINANCE = relativeLuminanceFromHex("#2e2e2e");
```

> The four hex approximations above are placeholders for the executor to replace with the ACTUAL achromatic sRGB approximations of `@cloudflare/kumo@2.1.0` theme-kumo.css `--color-kumo-elevated` / `--color-kumo-tint` light & dark oklch values — derived the same way `#fafafa`(canvas light)/`#1a1a1a`(canvas dark) were (read theme-kumo.css, convert the oklch lightness to the achromatic sRGB hex, document with the source oklch in a comment). They MUST be the real Kumo surface values, not guesses; resolving them is part of Step 3 (read `node_modules/@cloudflare/kumo/.../theme-kumo.css`).

Replace `isAccessibleBrand`@119-125 with the 6-check all-or-nothing form:

```ts
export function isAccessibleBrand(color: string): boolean {
  if (!HEX6_RE.test(color)) return false;
  const brandL = relativeLuminanceFromHex(color);
  const surfaces = [
    LIGHT_CANVAS_LUMINANCE,
    DARK_CANVAS_LUMINANCE,
    LIGHT_ELEVATED_LUMINANCE,
    DARK_ELEVATED_LUMINANCE,
    LIGHT_TINT_LUMINANCE,
    DARK_TINT_LUMINANCE,
  ];
  // All-or-nothing (§E-3): every surface in BOTH modes must clear >=3:1, or
  // the whole brand falls back to Kumo default. Per-surface partial
  // degradation was explicitly rejected (contract complexity / untestable).
  return surfaces.every((s) => contrastRatio(brandL, s) >= WCAG_AA_UI_RATIO);
}
```

`applyBrandVars`@140-152 is UNCHANGED (it already gates on `isAccessibleBrand` and returns `{}` on failure, still emitting only `--kumo-brand`/`--kumo-brand-hover`) — the extension is entirely inside `isAccessibleBrand`, so the injection contract and the emitted-vars contract are provably unchanged. Update the `branding.ts` top docstring@3-25 to state the guard is now canvas+elevated+tint × light/dark (6 checks, all-or-nothing) — extend the comment, do not rewrite the file.

- [ ] **Step 4: Run → PASS** — `cd /Users/xumingyang/github/contrabass/cloud && bun run test src/litellm-portal/tenant-portal/branding.test.ts` → PASS (injection rejection + 6-surface accept + all-or-nothing fall + Phase-1-now-falls-back regression). `bun run typecheck` → baseline-only.

- [ ] **Step 5: Confirm the 5 new brandable surfaces already consume `--kumo-brand` (no code change — verification).** The SideNav active accent bar (`bg-kumo-brand`, Task 4), the primary-panel-header emphasis (`border-l-2 border-kumo-brand`, Task 7), the clickable-card active ring (`ring-2` shell accent → `ring-kumo-brand`), the brand summary-bar budget meter progress (Kumo `Meter` uses `--kumo-brand` for fill), and the existing primary CTA / chart stroke (Phase-1) ALL reference `--kumo-brand` — NO new CSS var is introduced anywhere. Add a guard test `cloud/src/litellm-portal/tenant-portal/brand-vars.guard.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

describe("§C only --kumo-brand* is ever emitted", () => {
  it("applyBrandVars source emits exactly --kumo-brand and --kumo-brand-hover", () => {
    const src = readFileSync("src/litellm-portal/tenant-portal/branding.ts", "utf8");
    const emitted = [...src.matchAll(/"(--kumo-[a-z-]+)":/g)].map((m) => m[1]);
    expect(new Set(emitted)).toEqual(new Set(["--kumo-brand", "--kumo-brand-hover"]));
  });
});
```

Run → PASS.

- [ ] **Step 6: `DESIGN.md` — add the §C extended-branding record.** Append after the Phase-3 `## State Language`/`## Motion` sections (extend, do not rewrite):

```markdown
## Extended Tenant Branding (Phase 3 §C)

Phase-1's single-voltage `--kumo-brand*` accent now reaches more chrome — all referencing the SAME `--kumo-brand` (no new CSS var; the Phase-1 injection guard is inherited automatically):

| # | Brandable surface | Source |
|---|---|---|
| 1 | Primary CTA / Button primary | Phase 1 |
| 2 | Chart primary stroke | Phase 1 |
| 3 | SideNav active 2px accent bar | Phase 3 §B.1 |
| 4 | Primary panel-header 2px left bar | Phase 3 §B.2 |
| 5 | Clickable card/row active `ring-2` | Phase 3 §B.2 |
| 6 | Brand summary-bar budget-meter fill | Phase 3 §B.1 |

NOT brandable (Kumo-neutral, decision-1 boundary): body/heading/label text color, hierarchy backgrounds, semantic colors, hairline, focus-ring base logic.

**Guard (extends Phase-1, math/contract unchanged):** strict `#rrggbb` only; only `--kumo-brand`/`--kumo-brand-hover` emitted; WCAG-AA non-text contrast (≥ 3:1) enforced on **canvas + elevated + tint, light AND dark = 6 checks, all-or-nothing** — any surface/mode failing → whole brand falls back to `{}` (Kumo default). Accepted trade-off (§E-3): some Phase-1-passing tenants now fall back (brand-presence weaker than Phase 1, but always WCAG-AA). Per-surface partial degradation explicitly rejected. **Ops `/ops` ignores all tenant branding — `OPS_STEEL_ACCENT` sets `--kumo-brand` to fixed steel; no code path lets a tenant color reach `/ops` (Phase-2 invariant, unchanged).**
```

- [ ] **Step 7: Commit**
```bash
cd /Users/xumingyang/github/contrabass
git add cloud/src/litellm-portal/tenant-portal/branding.ts cloud/src/litellm-portal/tenant-portal/branding.test.ts cloud/src/litellm-portal/tenant-portal/brand-vars.guard.test.ts cloud/src/litellm-portal/DESIGN.md
git -c commit.gpgsign=false commit -m "feat(litellm-portal): extend brand guard to 6 surfaces all-or-nothing"
```

---

## Task 9: i18n completeness + Storybook + regenerate SPA (finalization)

**Files:** Modify `cloud/src/litellm-portal/i18n/messages/{zh-CN,en}.ts`; create `cloud/src/litellm-portal/i18n/__fixtures__/phase3-keys.ts`, `cloud/src/litellm-portal/i18n-completeness-phase3.test.ts`; modify `cloud/src/litellm-portal/tenant-portal/tenant-portal.stories.tsx`, `cloud/src/litellm-portal/ops-console/ops-console.stories.tsx`; regenerate + commit `app.generated.ts`

- [ ] **Step 1: Create the Phase-3 key fixture** — `cloud/src/litellm-portal/i18n/__fixtures__/phase3-keys.ts`:

```ts
/**
 * Phase-3 message-key allowlist. Every NEW zh source string introduced by
 * Phase 3 (group headings, summary bar/chips, four-state titles, the
 * locale-driven chart aria template). Add a key here AND to BOTH catalogs.
 */
export const PHASE3_KEYS = [
  // SideNav group headings
  "我的", "团队管理", "租户", "平台",
  // Brand summary bar / Ops summary chips
  "本周期预算", "告警状态",
  // Four-state titles surfaced by Panel*
  "网络请求失败", "暂无模型数据", "暂无租户", "租户列表加载失败",
  // Chart aria (locale-driven template, Task 1)
  "Token 用量趋势图，时间范围为 {window}，共 {points} 个 {grain} 粒度数据点。可在图表中横向拖拽选择时间范围。",
] as const;
```

(During implementation, reconcile this list with the ACTUAL set of new `t\`…\`` / `<Trans>` strings introduced by Tasks 1–8 — grep the touched files for new macro literals; the list MUST be exactly the new Phase-3 keys, no more, no less. Keys already in the Phase-1/2 catalogs from prior phases — e.g. `"网络请求失败"` if it pre-exists — must NOT be double-added; verify presence before adding to the catalogs in Step 3.)

- [ ] **Step 2: Create the Phase-3 completeness test** — `cloud/src/litellm-portal/i18n-completeness-phase3.test.ts` (mirrors the Phase-1/2 3-`it` idiom):

```ts
import { describe, expect, it } from "vitest";
import enMessages from "./i18n/messages/en";
import zhCNMessages from "./i18n/messages/zh-CN";
import { PHASE3_KEYS } from "./i18n/__fixtures__/phase3-keys";

const UNIQUE = [...new Set<string>(PHASE3_KEYS)];

describe("phase-3 i18n completeness", () => {
  it("every phase-3 key exists in en catalog", () => {
    const missing = UNIQUE.filter((k) => !(k in enMessages));
    expect(missing, `Missing from en: ${JSON.stringify(missing)}`).toHaveLength(0);
  });
  it("every phase-3 key exists in zh-CN catalog", () => {
    const missing = UNIQUE.filter((k) => !(k in zhCNMessages));
    expect(missing, `Missing from zh-CN: ${JSON.stringify(missing)}`).toHaveLength(0);
  });
  it("en and zh-CN catalogs still have an identical key set", () => {
    const enKeys = new Set(Object.keys(enMessages));
    const zhKeys = new Set(Object.keys(zhCNMessages));
    expect([...enKeys].filter((k) => !zhKeys.has(k)), "en-only").toHaveLength(0);
    expect([...zhKeys].filter((k) => !enKeys.has(k)), "zh-only").toHaveLength(0);
  });
});
```

- [ ] **Step 3: Run → FAIL, then add every new key to BOTH catalogs.** `cd /Users/xumingyang/github/contrabass/cloud && bun run test src/litellm-portal/i18n-completeness-phase3.test.ts` → FAIL (new keys missing). In `cloud/src/litellm-portal/i18n/messages/zh-CN.ts` add each new zh key identity-mapped (as the catalog does for zh source strings); in `cloud/src/litellm-portal/i18n/messages/en.ts` add each mapped to its English (e.g. `"我的": "Mine"`, `"团队管理": "Team management"`, `"租户": "Tenants"`, `"平台": "Platform"`, `"本周期预算": "Cycle budget"`, `"告警状态": "Alert status"`, `"Token 用量趋势图，时间范围为 {window}，共 {points} 个 {grain} 粒度数据点。可在图表中横向拖拽选择时间范围。": "Token usage trend chart, range {window}, {points} {grain}-grain data points. Drag horizontally to select a range."`; for keys that already exist from Phase 1/2 — e.g. `"网络请求失败"`, `"暂无租户"`, `"租户列表加载失败"` — do NOT re-add, just confirm presence). Re-run → PASS (3 tests). Also re-run the Phase-1 and Phase-2 completeness tests `bun run test src/litellm-portal/tenant-portal/i18n-completeness.test.ts src/litellm-portal/ops-console/i18n-completeness.test.ts` — adding keys to BOTH catalogs keeps the identical-key-set invariant green; the Phase-2 no-silent-shadow guard must still pass (any Phase-3 key that collides with a Phase-1 key must be an intentional same-English reuse — `"网络请求失败"` etc. are exactly that; if a NEW Phase-3 semantic needs different English, give it a distinct key).

- [ ] **Step 4: Add the "four-state gallery" + restyle stories.** In `cloud/src/litellm-portal/tenant-portal/tenant-portal.stories.tsx` (mirror its existing CSF3 `Meta`/`StoryObj` + per-story QueryClient decorator + `setupI18n("zh-CN")` idiom@1-47, no network) add stories: (a) `PanelStateGallery` rendering `PanelSkeleton`/`PanelEmpty`/`PanelError`/`PanelLoading` side by side; (b) `ShellActiveNav` rendering `TenantPortalShell` at an active route showing the SideNav active bar + brand summary bar. In `cloud/src/litellm-portal/ops-console/ops-console.stories.tsx` add the analogous `PanelStateGallery` + `OpsShellActiveNav` (steel pill + summary chips). Stories are render-only/type-checked by `bun run typecheck` — no test step (consistent with how `tenant-portal.stories.tsx` is treated).

- [ ] **Step 5: Regenerate + commit the SPA embed.** `cd /Users/xumingyang/github/contrabass/cloud && bun run build:litellm-portal` → exit 0. `build:litellm-portal` runs `build-litellm-portal-app.mjs` (the real split build that hosts the §A.3 gate from Task 3), so this MUST print `ECHARTS_LAZY_GATE: PASS` (a FAIL `throw`s and fails the build → finalization is blocked, which is correct). The regenerated `cloud/src/litellm-portal/app.generated.ts` (and `kumo-css.generated.ts` if changed) MUST be committed (the `embed.FS` Go contract). The gate is asserted by the build itself here — no separate `analyze` step is needed (`analyze:litellm-portal-bundle` is observational-only, NOT the gate — C2).

- [ ] **Step 6: Commit**
```bash
cd /Users/xumingyang/github/contrabass
git add cloud/src/litellm-portal/i18n/messages cloud/src/litellm-portal/i18n/__fixtures__/phase3-keys.ts cloud/src/litellm-portal/i18n-completeness-phase3.test.ts cloud/src/litellm-portal/tenant-portal/tenant-portal.stories.tsx cloud/src/litellm-portal/ops-console/ops-console.stories.tsx cloud/src/litellm-portal/app.generated.ts cloud/src/litellm-portal/kumo-css.generated.ts
git -c commit.gpgsign=false commit -m "chore(litellm-portal): phase-3 i18n + stories + regenerate SPA"
```

---

## Task 10: End-to-end verification + whole-branch review (PR-merge per standing authorization)

**Files:** none (verification only)

- [ ] **Step 1: Build → typecheck → full test (correct order):**
```bash
cd /Users/xumingyang/github/contrabass/cloud
bun run typecheck                  # ONLY the server-impl --jsx baseline; ZERO new errors
bun run build:litellm-portal       # exit 0; MUST print "ECHARTS_LAZY_GATE: PASS" (the §A.3 gate is
                                   # IN this build — build-litellm-portal-app.mjs throws on a FAIL,
                                   # so a clean build IS the gate). Regenerated app.generated.ts
                                   # already committed (Task 9). No separate analyze step (C2:
                                   # analyze-litellm-portal-bundle.mjs is observational-only).
bun run test src/litellm-portal    # green; isolate the documented flakes:
                                   #  - happy-dom localhost:3000/kumo.css SSR timeout (rotates across
                                   #    index/security/usage-overview SSR files Phase-3 did NOT modify)
                                   #  - pre-existing-on-main usage-overview ?window=90d failure
                                   # confirm each via an ISOLATED re-run; CI is the gate.
bun run test src/litellm-portal/a11y \
             src/litellm-portal/components \
             src/litellm-portal/dashboard/charts/build-chart-aria.test.ts \
             src/litellm-portal/dashboard/charts/trend-chart.test.tsx \
             src/litellm-portal/bundle-gate.test.ts \
             src/litellm-portal/hydration.test.tsx \
             src/litellm-portal/router.test.tsx \
             src/litellm-portal/tenant-portal/shell.test.tsx \
             src/litellm-portal/tenant-portal/shell-impersonation.test.tsx \
             src/litellm-portal/ops-console/shell.test.tsx \
             src/litellm-portal/tenant-portal/branding.test.ts \
             src/litellm-portal/tenant-portal/i18n-completeness.test.ts \
             src/litellm-portal/ops-console/i18n-completeness.test.ts \
             src/litellm-portal/i18n-completeness-phase3.test.ts
```
Expected: all Phase-3 suites green; the build prints `ECHARTS_LAZY_GATE: PASS`; tsc baseline-only; build exit 0. `chart.tsx`/`app.test.tsx` are UNTOUCHED by Phase 3 (OQ1) — `app.test.tsx` must stay green for free (it is not modified; confirm in the full-suite run). The two documented flakes (untouched SSR files; pre-existing `?window=90d`) pass isolated — NOT Phase-3 regressions; CI is the gate.

- [ ] **Step 2: Manual visual + a11y staging checklist (for the user; after merge, deploy via `bun run deploy:litellm-portal` — NEVER bare `wrangler deploy`, which 500s):**
  1. **a11y (§A.1):** keyboard-only "enter screen → operate primary CTA → leave" on all 13 screens + both shells; every active nav link shows `aria-current` (devtools); focus ring visible in light AND dark, brand AND steel; chart `ariaDescription` is English under `?lang=en` / Accept-Language `en`.
  2. **State/density (§A.2):** every screen's empty/loading/error looks identical (same title level, centering, padding); Tenant chrome reads comfortable, Ops reads compact.
  3. **Bundle (§A.3):** member first paint at `/` does NOT download the ECharts chunk if `/`'s body has no chart; the chart chunk loads when a usage screen mounts (devtools Network). NOTE: the `client.tsx` `warmUsageCharts()` runs at bootstrap on EVERY page (it is the #418 fix), so the chart chunk WILL be fetched shortly after first paint even on non-chart screens — that is expected and correct (the bundle gate's contract is "echarts ∉ the initial *main JS chunk*", proven by the build gate, NOT "never network-fetched"); the win is the main chunk is smaller and echarts loads as a separate cacheable chunk, not that it is never loaded.
  4. **Chrome restyle (§B.1):** Tenant brand summary bar (logo+name+budget meter+alert dot); Ops steel privileged pill + tenant/alert summary chips; SideNav active accent bar slides between items, group headings present, icons present.
  5. **Cards/state/motion (§B.2–4):** primary panel header shows the accent left-bar; route-enter fade is subtle and instant under OS "reduce motion"; no transition feels > 200ms; zero shadows anywhere.
  6. **Two-surface tone (§B.5):** Tenant = calm/branded/comfortable; Ops = dense/privileged/steel — visibly different shells, same structure.
  7. **Extended branding (§C):** set a tenant brand color that passes the 6-surface guard → SideNav bar / panel-header bar / card active ring / budget meter fill all adopt it, light AND dark, still readable; set a color that fails elevated/tint → EVERYTHING falls back to Kumo default (all-or-nothing); inject a non-`#rrggbb` value → falls back, no injection; `/ops` stays steel regardless of any tenant brand.
  8. **Invariants + #418 (NEW-C-A, CRITICAL — this is what the `fix/litellm-portal-hydration-418` branch exists for):** dark `data-mode` toggles cleanly on every new surface; zh/en both complete. **Hard-refresh (full SSR) `/usage` AND `/ops/usage` with devtools console open: ZERO React #418 / "hydration mismatch" / "did not match" warnings, and the chart renders WITHOUT a flash-to-skeleton-then-chart on hydrate** (the SSR HTML already has the resolved chart and the `client.tsx warmUsageCharts()` pre-`hydrateRoot` warm-up makes the client first render match it). Also hard-refresh `/`, `/ops`, a tenant_admin shell, a member shell: no #418. (The automated `hydration.test.tsx` parity cases — Task 3 Step 8 — gate this in CI; this manual check confirms the PRODUCTION `client.tsx` warm-up on a real browser, since the test harness mirrors but is not the literal `client.tsx`.)

- [ ] **Step 3: Open the PR.**
```bash
cd /Users/xumingyang/github/contrabass
git push -u origin feat/litellm-portal-phase3-design-restyle
gh pr create --base main --head feat/litellm-portal-phase3-design-restyle \
  --title "feat(litellm-portal): Phase 3 — design-language evolution + extended branding" \
  --body "Implements docs/superpowers/specs/2026-05-17-litellm-portal-phase3-design.md (APPROVED 2026-05-17, §E resolved). Hygiene-first: §A.1 a11y pass (focus ring, nav-mapped aria-current, ADDED locale-driven aria to the real rendered trend-chart.tsx — it had none) → §A.2 unified Panel* state + density tokens → §A.3 lazy-split of the real ECharts chain (usage-dashboard→trend/rank/donut→echarts-core) behind a CI HARD GATE IN build-litellm-portal-app.mjs (the real client.tsx splitting build: throws if echarts ∈ main chunk or ∉ any split chunk; no KB threshold). Then §B pronounced restyle (shared SideNav with hand-authored zero-dependency inline-SVG icons — Kumo ships no icon set; brand summary bar / Ops steel pill, card emphasis, §B.3 state table, reduced-motion-safe motion ≤200ms) + §C extended 6-surface brand guard (canvas+elevated+tint × light/dark, all-or-nothing fallback; strict #rrggbb + only --kumo-brand* preserved). No Kumo fork, no semantic/hierarchy/typography token override; Ops steel/ignore-branding untouched; chart.tsx (dead) untouched; DESIGN.md extended. SSR/#418 + bilingual + dark-mode + WCAG-AA invariants held. Depends on #139 (Phase 1) + #140 (Phase 2), both in main. Tests: all Phase-3 suites green; build prints ECHARTS_LAZY_GATE PASS; tsc baseline; SPA regenerated/committed. Documented happy-dom SSR flake + pre-existing usage-overview ?window=90d are not Phase-3 regressions — CI is the gate."
```
Report the PR URL + CI status to the user. **Per the standing Phase-2/Phase-3 user authorization: once all CI gates are green, merge per that authorization (resolve any conflict via `git merge main` into the PR branch — never rebase/squash/cherry-pick), then deploy via `bun run deploy:litellm-portal`.** Do not invent self-merge logic beyond this; if any gate is red or a conflict needs a judgment call, stop and report.

---

## End-to-End Verification

Order is fixed: **typecheck → build (the build IS the §A.3 gate) → full test → isolate flakes → manual staging checklist → deploy**. The §A.3 ECharts-lazy assertion is a CI HARD GATE living **inside `cloud/scripts/build-litellm-portal-app.mjs`** (the real `client.tsx` `splitting:true` build): it `throw`s (non-zero, fails `bun run build:litellm-portal` and CI) if echarts is in the `main` chunk or absent from every split chunk, printing `ECHARTS_LAZY_GATE: PASS/FAIL`; NO KB threshold — the gzip delta is recorded in `DESIGN.md` as observational only. `analyze-litellm-portal-bundle.mjs` is observational-only (`app.tsx` single-bundle, NOT the gate — C2). The two documented flakes (happy-dom `localhost:3000/kumo.css` SSR timeout on files Phase-3 did not modify; the pre-existing-on-`main` `usage-overview ?window=90d` failure) are NOT Phase-3 regressions — confirm via an isolated re-run; CI is the gate. The manual visual/a11y staging checklist (Task 10 Step 2) is for the user — it asserts structural/behavioral/a11y/contrast outcomes (focus ring, `aria-current`, density, lazy network behavior, all-or-nothing brand fallback, #418), never pixels. Deploy is `bun run deploy:litellm-portal` only (bare `wrangler deploy` 500s — project memory). PR-merge follows the standing Phase-2/Phase-3 authorization once gates are green; do not self-merge beyond that.

## Self-Review

**1. Spec §A–§E → task coverage:**

| Spec section | Locked content | Task | Status |
|---|---|---|---|
| §A.1 | a11y audit-to-pass: keyboard, focus ring token-ized, NAV-MAPPED `aria-current` (detail routes scoped out), contrast ≥3:1 reusing branding math, **ADD locale-driven aria to the REAL rendered `trend-chart.tsx`** (OQ2 re-scope: it had none — `chart.tsx`@168 is dead, OQ1); shell tests extended; impersonation `role="alert"` not regressed | Task 1 | ✓ (re-anchored to real graph) |
| §A.2 | unique 4-state (`PanelSkeleton`/`PanelEmpty`/`PanelError`/`PanelLoading`) + named density scale (comfortable/compact) via shell context; screen migration + convergence guard; DESIGN.md State/Density sections; stories gallery (Task 9) | Task 2 (+ stories Task 9) | ✓ |
| §A.3 | lazy-split the REAL ECharts chain via `usage-charts-lazy.tsx` `React.lazy`; CI HARD GATE in `build-litellm-portal-app.mjs` (the real `client.tsx` split build — C1/C2); **#418 SSR↔hydrate parity (LOCKED §E-1): server `renderToReadableStream`+`await stream.allReady` resolves the boundary server-side (verified `server-impl.tsx`:163), so `client.tsx` `await warmUsageCharts()` BEFORE `hydrateRoot` makes the client first render match — guarded by `hydration.test.tsx` SSR→hydrate parity cases (NEW-C-A), NOT a client-only mount** | Task 3 | ✓ (real graph + #418 mechanism encoded & test-proven) |
| §B.0 | non-change list declared as a hard boundary before §B; no-semantic-token-override asserted (Task 1 invariant test + Task 4 preamble) | Tasks 1, 4 | ✓ |
| §B.1 | shared `SideNav` (icon/active-bar/group/aria-current/hover-tint/focus), **hand-authored zero-dependency inline-SVG icons** (C3: Kumo ships NO icon set, `@phosphor-icons/react` forbidden — §E-2 empirically resolved), Tenant brand summary bar, Ops steel privileged pill + summary chips; DESIGN.md Shell/SideNav | Tasks 4, 5, 6 | ✓ (icon source resolved) |
| §B.2 | primary-panel-header emphasis bar, clickable-card active ring, `ring-kumo-line` normalization | Task 7 | ✓ |
| §B.3 | state table → DESIGN.md | Task 7 | ✓ |
| §B.4 | motion allowlist ≤200ms, all `motion-safe:`-gated, forbidden list; DESIGN.md Motion | Task 7 | ✓ |
| §B.5 | two-surface tone (comfortable/brand/summary-bar vs compact/steel/chips), motion uniform | Tasks 5, 6, 7 | ✓ |
| §C.1 | 6 brandable surfaces enumerated, all consuming `--kumo-brand` (no new var) | Task 8 (+ verified in 4/5/7) | ✓ |
| §C.2 | strict `#rrggbb` preserved; only `--kumo-brand*` emitted; 6-surface (canvas+elevated+tint × light/dark) all-or-nothing fallback; injection + per-surface + all-or-nothing tests; reuse WCAG math, no new dep | Task 8 | ✓ |
| §C.3 | Ops ignores tenant branding (steel via `OPS_STEEL_ACCENT`), restated + invariant-tested | Tasks 6, 8 | ✓ |
| §D.1 | SSR/#418, bilingual, dark-mode, Kumo-only, Ops-steel invariants guarded throughout | Tasks 1–9 | ✓ |
| §D.2 | ordering §A.1→A.2→A.3 (file-disjoint, the §A gate before §B) → §B.0..B.5 → §C; §C depends on §B.1/§B.2 surfaces | Task order + the §A GATE block after Task 3 | ✓ |
| §E-1 | ECharts lazy = CI HARD GATE (real `build-litellm-portal-app.mjs` split build), no KB threshold, delta observational; **AND the LOCKED #418-safe acceptance (spec lines 106/227, NAMES `hydration.test.tsx`): per verified Open-Q (b) the boundary is #418-safe BY CONSTRUCTION on the real SSR path (the new `UsageDashboard` dashboard key is SSR-unseeded → server & client both render the loading state, neither enters the Suspense boundary on first render). Proven by `hydration.test.tsx` 2 parity cases (SSR string has `加载中…`, NOT `data-chart="trend"`, hydrate no mismatch) + 1 negative control (harness can observe a real mismatch — not vacuous). `client.tsx` fail-soft warm-up = defense-in-depth + UX (MAJOR-1: try/catch, never blocks hydrate)** | Task 3 (Steps 3a/3/5/9) | ✓ (verified-real mechanism + harness-achievable test) |
| §E-2 | icon source — spec's "Kumo built-in primary" is **unimplementable** (Kumo has no icon set); empirically resolved to 100% hand-authored zero-dependency inline SVG; `@phosphor-icons/react` forbidden. Spec INTENT (no new icon dependency) honored | Task 4 Step 1 (resolved, no probe) + complete `nav-icons.tsx` Step 4 | ✓ (empirically resolved, not deferred) |
| §E-3 | canvas+elevated+tint × light/dark = 6 checks, all-or-nothing; accept Phase-1-passing-now-falls-back; per-surface partial degradation rejected | Task 8 | ✓ |

No §A–§E gap. No new screens / no backend / no IA change / no Kumo fork / no semantic-hierarchy-typography token override (asserted by Task 1's no-`--kumo-*`-except-brand invariant + Task 8's only-`--kumo-brand*`-emitted guard). §B not started before §A passes (the explicit §A GATE block after Task 3). §C depends on §B.1/§B.2 surfaces (Task 8 Step 5 verifies they consume `--kumo-brand`).

**2. Placeholder scan (honest, post-critic):** No "TBD"/"待定"/"add appropriate X"/"similar to Task N"/uncoded steps. The icon source is NO LONGER an "impl-time decision / probe" (the prior false defense) — C3 was verified: Kumo has no icon set, so Task 4 ships a COMPLETE 10-slot zero-dependency inline-SVG `nav-icons.tsx` verbatim (no probe, no placeholder, no deferred choice). Remaining disclosed executor-resolved items, each with a deterministic in-step procedure (NOT a hand-wave): (a) Task 8 Step 3 — the four elevated/tint surface luminances: read the real `@cloudflare/kumo@2.1.0` theme-kumo.css oklch values for `--color-kumo-elevated`/`--color-kumo-tint` (light & dark) and convert them the documented way the existing canvas constants were derived; the hex literals shown are explicitly flagged as to-be-replaced-with-real-values WITH the derivation method; (b) §C test witness colors are flagged as swappable witnesses for an invariant ("compute `contrastRatio` against the Step-3 luminances; pick values that unambiguously pass/fail; do not weaken the assertion"); (c) the `usage-charts-lazy.tsx` per-chart prop types — read `rank-bar.tsx`/`model-donut.tsx` and copy their exact prop types (no `any`/`@ts-ignore`, repo hard rule); (d) Task 1 Step 14's `usage-dashboard.tsx` window/grain field names — read the file and use its real `data` fields (the helper input contract is fixed). No prose-only step; no undefined symbol; no deferred design choice.

**3. Type/name consistency (verified across tasks):** `FOCUS_RING` (the exact string `"focus-visible:ring-2 focus-visible:ring-kumo-brand focus-visible:ring-offset-2 focus-visible:outline-none"`) identical in `a11y/focus.ts`, its test, `side-nav.tsx`, and both shells. `relativeLuminanceFromHex`/`contrastRatio`/`darkenHex` exported from `branding.ts` (Task 1 Step 4) and consumed by `a11y/focus.test.ts` + the §C guard. `applyBrandVars` signature `(b: { name: string; logoUrl: string | null; primaryColor: string | null }) => React.CSSProperties` is UNCHANGED across Phase 3 (Task 8 changes only `isAccessibleBrand`'s body); referenced identically in `branding.ts`, `branding.test.ts`, `routes/index.tsx` `toTenantBrand`, and the stories. `Panel*` component names (`PanelSkeleton`/`PanelEmpty`/`PanelError`/`PanelLoading`) + their props identical in `panel-state.tsx`, its test, every migrated screen, `usage-charts-lazy.tsx` (`PanelSkeleton` fallback), and the router-test lazy assertion. `Density`/`DensityProvider`/`useDensity`/`densityClasses` identical in `density.tsx`, its test, and both shells. `SideNav`/`SideNavGroup`/`SideNavItem`/`SideNavAccent`/`NavIconName`/`NavIcon` identical in `side-nav.tsx`/`nav-icons.tsx` (the `NavIconName` union of 10 slots is identical to the `Record<NavIconName, …>` keys in `nav-icons.tsx` and the `icon:` values the two shells pass), their tests, and both shells. `buildChartAriaDescription` (signature `({windowLabel,points,grain},{template}) => string`) identical in `dashboard/charts/build-chart-aria.ts`, its test, and `usage-dashboard.tsx`'s call site; the `ariaLabel?: string` prop identical in `trend-chart.tsx`, `trend-chart.test.tsx`, `usage-charts-lazy.tsx` (`TrendChartLazy`), and the `usage-dashboard.tsx` call site. (NO `chart.tsx`/`chart-lazy.tsx`/`UsageChartLazy`/`ariaTemplate` symbols — those were the FALSE prior model; `chart.tsx` is untouched dead code per OQ1.) `ECHARTS_LAZY_GATE: PASS` marker identical in `cloud/scripts/build-litellm-portal-app.mjs` (the gate host) and `bundle-gate.test.ts` (asserts it via `bun run generate:litellm-portal-app`). `PHASE3_KEYS` fixture path `i18n/__fixtures__/phase3-keys.ts` consistent with the existing `i18n/__fixtures__/phase1-keys.ts` convention; the completeness test mirrors the Phase-1/2 3-`it` shape. Query/hook names reused verbatim from Phase 1/2 (`useDashboard`, `useTenantWebhook`, `useOpsTenants`, `useStopImpersonation`, `ME_QUERY_KEY`, `createPortalRouter`, `createMemoryHistory`, `AppShell`). `TrendSeries`/`TrendChart`/`RankBar`/`ModelDonut` names match the real `dashboard/charts/*` exports (verified). `PortalIdentity`/`Me` shapes match `types.ts`/`schemas.ts` as used in the existing shell tests. No drift.

**4. Test-harness fidelity (the recurring lesson — 4th-instance failure honestly engaged):** the recurring failure is asserting a #418 guard is meaningful without verifying the SSR harness actually exercises the asserted state. Round-3 caught exactly that: the round-2 Step-9 asserted `expect(html).toContain('data-chart="trend"')`, but the verified Open-Question (b) proves `renderPortalSSR("/usage")` renders the LOADING state (the new `UsageDashboard`'s `dashboard/use-dashboard` key is SSR-unseeded — `server-impl.tsx` seeds the OLD `hooks/use-dashboard` `["dashboard"]` key) — so that assertion was physically unsatisfiable and would have RED-failed the §A GATE, hard-blocking all of §B/§C. CORRECTED: every Step-9 assertion now traces to the Open-Question-verified real SSR render. The §A.3 #418 guard is the spec-§E-1-NAMED `hydration.test.tsx` harness: real `renderPortalSSR(...,"http://localhost/usage",...)` → SSR string → `loadSsrDocument` → `hydrateLikeClient` (mirrors `client.tsx` INCLUDING the Step-5 fail-soft `try/catch warmUsageCharts()`) → assert no `console.error/warn` mismatch + assert the SSR string has the REAL loading marker `加载中…`, NOT `data-chart="trend"`, NOT `data-panel-skeleton` (pinning the verified behavior) + a NEGATIVE CONTROL (client-seed the new dashboard key → client first-renders the chart vs SSR loading → the harness MUST observe that mismatch, proving it is not blind). Grounded in: verified `server-impl.tsx`:11/56-59 seeds the OLD key only → new `UsageDashboard` key unseeded at SSR → server renders loading, client first-renders the same loading → #418-safe by construction (neither side enters the lazy Suspense boundary on first render); the fail-soft warm-up is defense-in-depth + UX. No "#418-safe" asserted on faith — it traces to (a) the verified SSR-unseeded-key fact, (b) the parity cases (server==client==loading, no mismatch), (c) the negative control (harness can see a real mismatch → parity is not vacuous). Other harnesses: routing/chrome tests use PRODUCTION `createPortalRouter`+real `rootRoute`/`RootLayout`/`AppShell` (Tasks 1/5/6/7). Pure-function tests (`a11y/focus.test.ts`, `branding.test.ts`, `panel-state`/`density`/`side-nav`, `build-chart-aria.test.ts`) need no router. `trend-chart.test.tsx` renders the real `TrendChart` under happy-dom. The §A.3 bundle gate test runs the REAL split build via `bun run generate:litellm-portal-app` (production `client.tsx` `splitting:true` build), NOT a stub, NOT the wrong-artifact `analyze` script (C2). No test asserts a behavior its harness cannot exercise — and Step 9's assertions were specifically re-derived from the empirical SSR-render answer, not assumed.

**5. Missing-items disposition (critic-flagged):** (a) `admin-components.tsx`'s `import type { UsageTimeseries } from "./chart"` is type-only and `chart.tsx` is UNTOUCHED by Phase 3 (Task 1 re-scoped to `trend-chart.tsx`) → the type-only import survives unchanged; no churn, asserted by `bun run typecheck` baseline-only + the untouched `app.test.tsx` staying green (Task 10 Step 1). (b) Detail routes `/ops/audit/$eventId`, `/ops/tenants/$teamId`, `/ops/users/$userId` legitimately have no nav entry → §A.1 `aria-current` acceptance is explicitly scoped to nav-mapped routes only (Task 1 preamble + the DESIGN.md `## Focus & Accessibility` bullet); tests assert `aria-current` only for `TENANT_ROUTE_SPECS`/`OPS_NAV` paths. (c) MIN1 fixed — the `formatTick@101` reference is gone (Task 1 no longer edits `chart.tsx`; `formatTick`@96 is recorded only in Prerequisites for completeness, not used by any step).

**6. Out-of-bounds check:** plan-only — no code/build/test/git/implementation performed; one file revised in place (this plan md); no second file; no re-design / no re-opening any spec-locked or §E-resolved decision (§E-1 *requires* #418-safety — NEW-C-A DELIVERS it, it is not re-litigated; §E-2's "Kumo primary" is *empirically unimplementable* — Kumo has no icon set — so its OWN fallback path is taken; this resolves, not re-opens, it); no Kumo fork / no semantic-token override proposed; the branch is the already-created `feat/litellm-portal-phase3-design-restyle` (not re-created); PR-merge deferred to the standing user authorization (no self-merge logic beyond "gates green → merge per authorization → deploy").

**7. Round-2 NEW-C-A disposition — ⚠️ ITS CORE PREMISE WAS FALSIFIED IN ROUND 3; see §8 for the corrected disposition. Kept for history.** Round 2 asserted "SSR renders the RESOLVED chart" (via `allReady`) as the mechanism. Round 3 empirically verified that is FALSE for the real SSR path: the new `UsageDashboard` reads a DIFFERENT `dashboard/use-dashboard` key than `server-impl.tsx` seeds, so SSR renders the LOADING state, not the chart. The §8 disposition supersedes the round-2 mechanism description (the warm-up is defense-in-depth, not the #418-preventer; #418-safety is by construction). Original round-2 text follows verbatim for audit trail: ~ the round-1 C1 fix shipped a raw in-component `React.lazy`+`Suspense` boundary and asserted "#418-safe / identical on SSR and client" WITHOUT engaging `server-impl.tsx`. That round-2 analysis ALSO mis-assumed (FALSE): verified `server-impl.tsx`:142-163 uses `renderToReadableStream` + `await stream.allReady` → SSR renders the RESOLVED chart, while `client.tsx`:57's `await router.load()` does NOT resolve a nested in-component `React.lazy` → client first render = skeleton → #418 on the portal's primary screen (the exact bug `fix/litellm-portal-hydration-418` exists to kill). CLOSED by: (1) `usage-charts-lazy.tsx` exports `warmUsageCharts()`; (2) `client.tsx` `await warmUsageCharts()` BEFORE `hydrateRoot` (mechanism chosen = option-2 client warm-up, because route-level `lazyRouteComponent` is infeasible — the chart is nested 2 levels below the route component inside `UsageDashboard`, shared by 3 routes incl. the `/` index whose route component also renders the non-chart `TenantOverviewScreen`; repo evidence it SSR-resolves before hydrate: `server-impl.tsx`:163 `await stream.allReady` resolves all Suspense boundaries server-side, and the warm-up mirrors `client.tsx`'s own existing pre-`hydrateRoot` `await router.load()` discipline@51-57 for the identical root cause); (3) the #418 guard moved from a client-only `router.test.tsx` mount to the spec-§E-1-NAMED `hydration.test.tsx` SSR→hydrate parity cases (harness mirrors the fixed `client.tsx` via `await warmUsageCharts()` in `hydrateLikeClient`; asserts SSR string has `data-chart="trend"` + no `data-panel-skeleton` + hydrate has no mismatch); (4) every false "#418-safe / identical SSR and client" assertion deleted/replaced with the verified-mechanism description (the lone surviving `#418-safe` at Task-5 Step-3 line ~317 is for `useRouterState` pathname — genuinely pure URL-derived, SSR==client by construction, unrelated to lazy). Bundle gate (C2) stays closed: the import is still dynamic so esbuild still code-splits echarts; the unconditional warm-up only changes WHEN the split chunk is network-fetched (Task-10 item 3 honestly notes echarts IS fetched at bootstrap on every page now — the gate's contract is "echarts ∉ initial *main JS chunk*", which the build gate proves, not "never fetched"). Round-2 MINORs: §E-1 guard file = `hydration.test.tsx` (done); `ECHARTS_INPUT_RE` pnpm virtual-store note added (substring match covers both flat & `.pnpm/...` paths; real Step-7 build is the truth); `tenant-overview.tsx` Prerequisites anchor corrected (88 lines; @78 article header flagged pre-Task-2, re-locate by symbol). Round-1 verified-closed items (OQ1/OQ2/C1-symbols/C2/C3/M1/M2/M3/MIN1/missing-items, §A.1/§A.2/§B/§C/§D-gate) were NOT touched this round — no churn, no regression.

**8. Round-3 disposition (CRITICAL-1 + MAJOR-1 + MAJOR-2 + props-export — honestly closed; the 4th-instance recurring failure named & fixed):**

- **Open-Question — EMPIRICALLY RESOLVED, answer = (b).** Verified by reading the repo: `server-impl.tsx`:11 imports `DASHBOARD_QUERY_KEY` from `./hooks/use-dashboard` (flat `["dashboard"]`, `DashboardSchema` from `schemas.ts`) and :56-59 seeds ONLY that. The new `UsageDashboard` (`dashboard/views/usage-dashboard.tsx`:3) calls `useDashboard(scope,win)` from `dashboard/use-dashboard.ts` (key `["dashboard",scope.kind,"",window]`, `DashboardResponseSchema` from `dashboard-schemas.ts`) — different module/key/schema → SSR key UNSEEDED → `usage-dashboard.tsx`:148 renders `<DashboardStatus>加载中…</DashboardStatus>`, NOT `<TrendChart>`. Therefore: server renders loading, client first-renders loading → **no #418 from the lazy boundary by construction** (neither side enters the Suspense boundary on first render). The `server-impl.tsx` old/new `use-dashboard` reconciliation is pre-existing tech-debt OUT of Phase-3 scope (umbrella did not assign it; do not change `server-impl.tsx`).
- **CRITICAL-1 — CLOSED.** The round-2 Step-9 assertion `expect(html).toContain('data-chart="trend"')` was physically unsatisfiable (answer (b)) → would RED-fail the §A GATE → hard-block §B/§C → ship nothing. Step 9 now asserts the TRUE, harness-achievable invariant: SSR string === client first-hydrate render (no #418) for the REAL loading state (`expect(html).toContain("加载中…")`, `not.toContain('data-chart="trend"')`, `not.toContain("data-panel-skeleton")`, no `console.error/warn` mismatch) + a NEGATIVE CONTROL (client-seed the new `dashboard/use-dashboard` key with a `DashboardResponseSchema.parse(...)` `available:true` fixture so the client first-renders the chart vs SSR loading → the harness MUST detect that mismatch, proving parity is not vacuous). Every Step-9 assertion now traces to the empirical SSR-render answer, not an assumed one.
- **MAJOR-1 — CLOSED.** `client.tsx` Step-5(b) is now `try { await warmUsageCharts(); } catch { /* swallow, proceed to hydrate */ }` — a rejected echarts chunk fetch (CDN blip / post-redeploy 404 / cache evict) can never prevent `hydrateRoot` (no global white screen on chart-less routes / login). The `hydration.test.tsx` `hydrateLikeClient` mirror copies the SAME try/catch verbatim (test path == prod path).
- **MAJOR-2 / props-export — CLOSED.** (i) New Task-3 **Step 3a** (explicit prerequisite step, not a buried note) adds the behavior-preserving `export type RankBarProps`/`ModelDonutProps` to `rank-bar.tsx`/`model-donut.tsx` (verified absent: they used inline prop literals `{ rows: RankRow[]; height? }` / `{ slices: ModelSlice[]; height? }`) so `usage-charts-lazy.tsx`'s imports typecheck; `RankRow`/`ModelSlice`/`TrendSeries` were already exported. (ii) `data-panel-skeleton` marker contract: pinned in Task-2 Step-3's `PanelSkeleton` CODE (the root element carries exactly `data-panel-skeleton`), cross-referenced by the §A.2 guard test and by Task-3 Step-9's `not.toContain("data-panel-skeleton")` — see the Task-2 cross-reference note (added below).
- **Role of `warmUsageCharts()` corrected everywhere (honest):** it is defense-in-depth (future SSR-seed) + post-hydration UX (no skeleton flash), NOT the thing that prevents #418 on the real path today (construction does, per (b)). All "SSR renders the RESOLVED chart / client first render === resolved chart / #418-safe by warm-up" assertions (File-Structure rows, DESIGN.md zh paragraph, §E-1 row, §4, the boundary docstrings, the NEW-C-A preamble) were corrected to the (b) reality. The bundle split (C2) is unaffected (imports stay dynamic; Task-10 item 3 honestly notes echarts IS network-fetched at bootstrap now — gate contract = "echarts ∉ initial main JS chunk", proven by the build gate, not "never fetched").
- **Recurring-failure root cause named:** 4 rounds in a row a #418/parity claim was asserted without verifying the SSR harness actually exercises the asserted state. Mitigation now baked into the plan: Step 9's assertions are explicitly derived from the empirically-verified SSR render (answer (b)) + a negative control that fails if the harness is blind. Round-1/round-2 verified-closed items (OQ1/OQ2/C1-symbols/C2/C3/M1/M2/M3/MIN1/missing-items, the NEW-C-A *mechanism* of a single `React.lazy` boundary + warm-up + the `hydration.test.tsx` harness choice, §A.1/§A.2/§B/§C/§D-gate) were NOT regressed — only the FALSE "SSR resolves the chart" premise + the unsatisfiable assertion + the missing try/catch + the missing props-export step were corrected.
