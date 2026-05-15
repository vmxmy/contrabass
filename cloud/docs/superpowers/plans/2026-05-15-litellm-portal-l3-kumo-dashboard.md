# LiteLLM Portal L3 Kumo Dashboard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 litellm-portal 用量区重构为 reference dashboard 的功能/信息架构(KPI+环比、趋势、模型饼、时段、团队多线、用户排行、状态点告警、只读成员 overlay),保留 Kumo 设计语言,数据全部来自 L2 聚合端点。

**Architecture:** 新建 `dashboard/` 模块树:`charts/`(裸 ECharts + Kumo 主题包装,懒加载 island)、`panels/`(scope 无关复用)、`views/`(个人/管理员/成员 overlay)、`use-dashboard.ts`(React Query 拉 L2)。接入现有 TanStack Router 路由组件,迁出 `app.tsx`/`admin-components.tsx` 用量逻辑。

**Tech Stack:** React 18, TanStack Router, @tanstack/react-query, @cloudflare/kumo, echarts/core(SVGRenderer), Zod, Vitest(happy-dom)+ @testing-library/react。

参考 spec: `docs/superpowers/specs/2026-05-15-litellm-portal-l3-kumo-dashboard-design.md`(L3)、`...l2-dashboard-api-design.md`(L2 契约)。

---

## 关键既有模式(实现者必读)

- 测试运行:`cd cloud && bun run vitest run <file>`(根 `package.json` `"test":"vitest run"`)。组件测试首行 `/**\n * @vitest-environment happy-dom\n */`。
- 组件测试范式(`preferences.test.tsx`):`@testing-library/react` 的 `render/cleanup/waitFor`;`renderWithQuery(ui)` 包 `QueryClientProvider`(`new QueryClient({defaultOptions:{queries:{retry:false}}})`)+ `I18nProvider`(`setupI18n("zh-CN")`);`afterEach(cleanup)`;`globalThis.fetch` 用 `vi.fn()` 桩。
- 数据钩子范式(`hooks/use-admin-usage.ts`):`useQuery({ queryKey, queryFn: fetch+zod.parse, staleTime:30_000, refetchOnWindowFocus:false })`。**注意**:该文件与 `schemas.ts` 的 `UsageTimeseriesSchema` 服务已删除的 `/api/admin/usage/timeseries`,L3 用 `use-dashboard.ts` 取代,旧 hook 在 Task 9 删除。
- ECharts+Kumo 包装范式(`chart.tsx`):`import * as echarts from "echarts/core"`、`echarts.use([...])`、`@cloudflare/kumo/components/chart` 的 `ChartPalette`、暗色 `usePortalDarkMode()`(`MutationObserver` 监听 `document.documentElement.dataset.mode`,直接复用本文件已导出的逻辑或抽出)。
- 路由接入:`routes/index.tsx`(`indexRoute` → `UserView` 渲染 `PreferencesAwareUsagePanel`)、`routes/admin/`(管理员路由)。L3 替换这些路由组件渲染的用量面板,不改 `router.tsx`/`__root.tsx`。
- L2 聚合响应形状(契约,见 L2 spec §3,L3 仅消费):`{ available, empty, scope, window, grain, grainFallback, timezone, kpi:{spend,requests,totalTokens:{current,previous,deltaPct}}, trend:[{startMs,label,totalTokens,requests,spend}], models:[{model,spend,totalTokens,requests}], hourOfDay:[{hour,totalTokens,requests,spend}×24], perUser?:[{userId,points:[{startMs,spend}]}], summary?:{userCount,adminCount,teamCount,totalSpend,totalBudget,riskCount,sampled}, recent?:[{tsMs,model,totalTokens,spend}] }`。端点:`/api/usage/overview`(self)、`/api/admin/usage/overview[?member=]`(global/member)。
- 既有 admin 用户表(下钻入口)用现有 `/api/admin/users`(DO-backed,行含 `maxBudget`),L3 复用其数据,行点击把 `maxBudget` 传给 overlay。

## 文件结构

```
src/litellm-portal/dashboard/
  dashboard-schemas.ts     # L2 聚合响应 Zod + 类型
  use-dashboard.ts         # React Query 钩子(self/global/member)
  charts/
    echarts-core.ts        # echarts.use([...]) 集中注册
    kumo-chart-theme.ts    # Kumo token → ECharts option + useDarkMode
    trend-chart.tsx
    model-donut.tsx
    rank-bar.tsx
    hour-bars.tsx
  panels/
    kpi-band.tsx
    recent-table.tsx
    alert-panel.tsx
    user-table.tsx
  views/
    personal-view.tsx
    admin-view.tsx
    member-overlay.tsx
```
对应测试文件同目录 `*.test.tsx` / `*.test.ts`。

---

### Task 1: dashboard-schemas.ts + use-dashboard.ts

**Files:**
- Create: `src/litellm-portal/dashboard/dashboard-schemas.ts`
- Create: `src/litellm-portal/dashboard/use-dashboard.ts`
- Create: `src/litellm-portal/dashboard/use-dashboard.test.ts`

- [ ] **Step 1: 写 schema**

创建 `src/litellm-portal/dashboard/dashboard-schemas.ts`:

```typescript
import { z } from "zod";

export const DASHBOARD_WINDOWS = ["24h", "48h", "7d", "30d"] as const;
export type DashboardWindow = (typeof DASHBOARD_WINDOWS)[number];

const Kpi = z.object({
  current: z.number(),
  previous: z.number().nullable(),
  deltaPct: z.number().nullable(),
});

export const DashboardResponseSchema = z.object({
  available: z.boolean(),
  empty: z.boolean(),
  scope: z.string(),
  window: z.enum(DASHBOARD_WINDOWS),
  grain: z.enum(["hour", "day"]),
  grainFallback: z.boolean(),
  timezone: z.literal("Asia/Shanghai"),
  kpi: z.object({ spend: Kpi, requests: Kpi, totalTokens: Kpi }),
  trend: z.array(z.object({
    startMs: z.number(), label: z.string(),
    totalTokens: z.number(), requests: z.number(), spend: z.number(),
  })),
  models: z.array(z.object({
    model: z.string(), spend: z.number(), totalTokens: z.number(), requests: z.number(),
  })),
  hourOfDay: z.array(z.object({
    hour: z.number(), totalTokens: z.number(), requests: z.number(), spend: z.number(),
  })),
  perUser: z.array(z.object({
    userId: z.string(),
    points: z.array(z.object({ startMs: z.number(), spend: z.number() })),
  })).optional(),
  summary: z.object({
    userCount: z.number(), adminCount: z.number(), teamCount: z.number(),
    totalSpend: z.number(), totalBudget: z.number(), riskCount: z.number(),
    sampled: z.boolean(),
  }).optional(),
  recent: z.array(z.object({
    tsMs: z.number(), model: z.string(), totalTokens: z.number(), spend: z.number(),
  })).optional(),
});
export type DashboardResponse = z.infer<typeof DashboardResponseSchema>;
```

- [ ] **Step 2: 写失败测试**

创建 `src/litellm-portal/dashboard/use-dashboard.test.ts`:

```typescript
import { describe, it, expect, vi, afterEach } from "vitest";
import { dashboardUrl } from "./use-dashboard";

afterEach(() => vi.restoreAllMocks());

describe("dashboardUrl", () => {
  it("self scope -> /api/usage/overview with window", () => {
    expect(dashboardUrl({ kind: "self" }, "7d")).toBe("/api/usage/overview?window=7d");
  });
  it("global scope -> /api/admin/usage/overview", () => {
    expect(dashboardUrl({ kind: "global" }, "24h")).toBe("/api/admin/usage/overview?window=24h");
  });
  it("member scope -> admin overview with member param", () => {
    expect(dashboardUrl({ kind: "member", userId: "u1" }, "30d"))
      .toBe("/api/admin/usage/overview?window=30d&member=u1");
  });
});
```

- [ ] **Step 3: 运行确认失败**

Run: `cd cloud && bun run vitest run src/litellm-portal/dashboard/use-dashboard.test.ts`
Expected: FAIL — `Cannot find module './use-dashboard'`

- [ ] **Step 4: 实现 hook**

创建 `src/litellm-portal/dashboard/use-dashboard.ts`:

```typescript
import { useQuery } from "@tanstack/react-query";
import { DashboardResponseSchema, type DashboardWindow } from "./dashboard-schemas";

export type DashboardScope =
  | { kind: "self" }
  | { kind: "global" }
  | { kind: "member"; userId: string };

export function dashboardUrl(scope: DashboardScope, window: DashboardWindow): string {
  const p = new URLSearchParams({ window });
  if (scope.kind === "self") return `/api/usage/overview?${p.toString()}`;
  if (scope.kind === "member") p.set("member", scope.userId);
  return `/api/admin/usage/overview?${p.toString()}`;
}

export const DASHBOARD_QUERY_KEY = (scope: DashboardScope, window: string) =>
  ["dashboard", scope.kind, scope.kind === "member" ? scope.userId : "", window] as const;

export function useDashboard(scope: DashboardScope, window: DashboardWindow) {
  return useQuery({
    queryKey: DASHBOARD_QUERY_KEY(scope, window),
    queryFn: async () => {
      const res = await fetch(dashboardUrl(scope, window), {
        headers: { "content-type": "application/json" },
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({ error: "request_failed" })) as Record<string, unknown>;
        throw new Error(typeof body.error === "string" ? body.error : "request_failed");
      }
      return DashboardResponseSchema.parse(await res.json());
    },
    staleTime: 30_000,
    refetchOnWindowFocus: false,
  });
}
```

- [ ] **Step 5: 运行确认通过**

Run: `cd cloud && bun run vitest run src/litellm-portal/dashboard/use-dashboard.test.ts`
Expected: PASS (3 tests)

- [ ] **Step 6: 类型检查 + 提交**

Run: `cd cloud && bun run tsc --noEmit 2>&1 | grep -c 'error TS'`
Expected: `0`

```bash
git add cloud/src/litellm-portal/dashboard/dashboard-schemas.ts cloud/src/litellm-portal/dashboard/use-dashboard.ts cloud/src/litellm-portal/dashboard/use-dashboard.test.ts
git commit -m "feat(litellm-portal): L3 dashboard schema + use-dashboard hook"
```

---

### Task 2: echarts-core + kumo-chart-theme

**Files:**
- Create: `src/litellm-portal/dashboard/charts/echarts-core.ts`
- Create: `src/litellm-portal/dashboard/charts/kumo-chart-theme.ts`

- [ ] **Step 1: echarts-core(集中注册)**

创建 `src/litellm-portal/dashboard/charts/echarts-core.ts`:

```typescript
import * as echarts from "echarts/core";
import { LineChart, BarChart, PieChart } from "echarts/charts";
import {
  GridComponent, TooltipComponent, LegendComponent,
} from "echarts/components";
import { SVGRenderer } from "echarts/renderers";

echarts.use([LineChart, BarChart, PieChart, GridComponent, TooltipComponent, LegendComponent, SVGRenderer]);

export { echarts };
```

- [ ] **Step 2: kumo-chart-theme(token 主题 + 暗色)**

创建 `src/litellm-portal/dashboard/charts/kumo-chart-theme.ts`:

```typescript
import { useEffect, useState } from "react";
import { ChartPalette } from "@cloudflare/kumo/components/chart";

export function isPortalDarkMode(): boolean {
  return typeof document !== "undefined" && document.documentElement.dataset.mode === "dark";
}

export function usePortalDarkMode(): boolean {
  const [dark, setDark] = useState(isPortalDarkMode);
  useEffect(() => {
    if (typeof document === "undefined" || typeof MutationObserver === "undefined") return;
    const o = new MutationObserver(() => setDark(isPortalDarkMode()));
    o.observe(document.documentElement, { attributes: true, attributeFilter: ["data-mode"] });
    return () => o.disconnect();
  }, []);
  return dark;
}

/** Axis/grid/text colors driven by Kumo's light/dark surfaces. */
export function kumoAxisColors(dark: boolean) {
  return {
    axisLine: dark ? "#3f3f46" : "#e7e5e4",
    splitLine: dark ? "#27272a" : "#f0eeec",
    label: dark ? "#a1a1aa" : "#78716c",
  };
}

export function categorical(i: number, dark: boolean): string {
  return ChartPalette.categorical(i, dark);
}

export const TOOLTIP_STYLE = (dark: boolean) => ({
  backgroundColor: dark ? "#1c1917" : "#ffffff",
  borderColor: dark ? "#3f3f46" : "#e7e5e4",
  textStyle: { color: dark ? "#e7e5e4" : "#1c1917", fontFamily: "ui-monospace, monospace" },
});
```

- [ ] **Step 3: 类型检查**

Run: `cd cloud && bun run tsc --noEmit 2>&1 | grep -c 'error TS'`
Expected: `0`

- [ ] **Step 4: 提交**

```bash
git add cloud/src/litellm-portal/dashboard/charts/echarts-core.ts cloud/src/litellm-portal/dashboard/charts/kumo-chart-theme.ts
git commit -m "feat(litellm-portal): echarts core registration + Kumo chart theme"
```

---

### Task 3: trend-chart + model-donut

**Files:**
- Create: `src/litellm-portal/dashboard/charts/trend-chart.tsx`
- Create: `src/litellm-portal/dashboard/charts/model-donut.tsx`
- Create: `src/litellm-portal/dashboard/charts/charts.test.tsx`

- [ ] **Step 1: 写失败测试**

创建 `src/litellm-portal/dashboard/charts/charts.test.tsx`:

```tsx
/**
 * @vitest-environment happy-dom
 */
import React from "react";
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { TrendChart } from "./trend-chart";
import { ModelDonut } from "./model-donut";

afterEach(cleanup);

describe("TrendChart", () => {
  it("renders empty state when no series", () => {
    const { getByText } = render(<TrendChart series={[]} />);
    expect(getByText("暂无数据")).toBeTruthy();
  });
  it("renders a chart container when data present", () => {
    const { container } = render(
      <TrendChart series={[{ name: "Tokens", points: [[1, 10], [2, 20]] }]} />,
    );
    expect(container.querySelector("[data-chart='trend']")).toBeTruthy();
  });
});

describe("ModelDonut", () => {
  it("renders empty state when no slices", () => {
    const { getByText } = render(<ModelDonut slices={[]} />);
    expect(getByText("暂无数据")).toBeTruthy();
  });
  it("renders container with slices", () => {
    const { container } = render(
      <ModelDonut slices={[{ model: "gpt", value: 10 }, { model: "claude", value: 5 }]} />,
    );
    expect(container.querySelector("[data-chart='model-donut']")).toBeTruthy();
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `cd cloud && bun run vitest run src/litellm-portal/dashboard/charts/charts.test.tsx`
Expected: FAIL — `Cannot find module './trend-chart'`

- [ ] **Step 3: 实现 trend-chart**

创建 `src/litellm-portal/dashboard/charts/trend-chart.tsx`:

```tsx
import React, { useEffect, useRef } from "react";
import { echarts } from "./echarts-core";
import { usePortalDarkMode, kumoAxisColors, categorical, TOOLTIP_STYLE } from "./kumo-chart-theme";

export type TrendSeries = { name: string; points: Array<[number, number]>; dashed?: boolean };

export function TrendChart({ series, height = 300 }: { series: TrendSeries[]; height?: number }) {
  const dark = usePortalDarkMode();
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (series.length === 0 || ref.current === null) return;
    const chart = echarts.init(ref.current, undefined, { renderer: "svg" });
    const c = kumoAxisColors(dark);
    chart.setOption({
      backgroundColor: "transparent",
      tooltip: { trigger: "axis", ...TOOLTIP_STYLE(dark) },
      legend: series.length > 1 ? { textStyle: { color: c.label }, top: 0 } : undefined,
      grid: { left: 50, right: 20, top: series.length > 1 ? 30 : 16, bottom: 28 },
      xAxis: { type: "time", axisLine: { lineStyle: { color: c.axisLine } }, axisLabel: { color: c.label } },
      yAxis: { type: "value", axisLine: { show: false }, splitLine: { lineStyle: { color: c.splitLine } }, axisLabel: { color: c.label } },
      series: series.map((s, i) => ({
        name: s.name, type: "line", smooth: true, showSymbol: false,
        data: s.points,
        lineStyle: { width: 2, type: s.dashed ? "dashed" : "solid" },
        itemStyle: { color: categorical(i, dark) },
        areaStyle: series.length === 1 ? { opacity: 0.12 } : undefined,
      })),
    });
    const onResize = () => chart.resize();
    window.addEventListener("resize", onResize);
    return () => { window.removeEventListener("resize", onResize); chart.dispose(); };
  }, [series, dark]);

  if (series.length === 0) {
    return <p className="py-12 text-center text-sm text-kumo-subtle">暂无数据</p>;
  }
  return <div data-chart="trend" ref={ref} style={{ width: "100%", height }} />;
}
```

- [ ] **Step 4: 实现 model-donut**

创建 `src/litellm-portal/dashboard/charts/model-donut.tsx`:

```tsx
import React, { useEffect, useRef } from "react";
import { echarts } from "./echarts-core";
import { usePortalDarkMode, kumoAxisColors, categorical, TOOLTIP_STYLE } from "./kumo-chart-theme";

export type ModelSlice = { model: string; value: number };

export function ModelDonut({ slices, height = 280 }: { slices: ModelSlice[]; height?: number }) {
  const dark = usePortalDarkMode();
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (slices.length === 0 || ref.current === null) return;
    const chart = echarts.init(ref.current, undefined, { renderer: "svg" });
    const c = kumoAxisColors(dark);
    chart.setOption({
      backgroundColor: "transparent",
      tooltip: { trigger: "item", ...TOOLTIP_STYLE(dark) },
      series: [{
        type: "pie", radius: ["45%", "70%"], center: ["50%", "50%"],
        label: { color: c.label, formatter: "{b}\n{d}%" },
        data: slices.map((s, i) => ({
          name: s.model, value: s.value, itemStyle: { color: categorical(i, dark) },
        })),
      }],
    });
    const onResize = () => chart.resize();
    window.addEventListener("resize", onResize);
    return () => { window.removeEventListener("resize", onResize); chart.dispose(); };
  }, [slices, dark]);

  if (slices.length === 0) {
    return <p className="py-12 text-center text-sm text-kumo-subtle">暂无数据</p>;
  }
  return <div data-chart="model-donut" ref={ref} style={{ width: "100%", height }} />;
}
```

- [ ] **Step 5: 运行确认通过**

Run: `cd cloud && bun run vitest run src/litellm-portal/dashboard/charts/charts.test.tsx`
Expected: PASS (4 tests)

- [ ] **Step 6: 提交**

```bash
git add cloud/src/litellm-portal/dashboard/charts/trend-chart.tsx cloud/src/litellm-portal/dashboard/charts/model-donut.tsx cloud/src/litellm-portal/dashboard/charts/charts.test.tsx
git commit -m "feat(litellm-portal): trend chart + model donut (ECharts+Kumo)"
```

---

### Task 4: rank-bar + hour-bars

**Files:**
- Create: `src/litellm-portal/dashboard/charts/rank-bar.tsx`
- Create: `src/litellm-portal/dashboard/charts/hour-bars.tsx`
- Modify: `src/litellm-portal/dashboard/charts/charts.test.tsx`

- [ ] **Step 1: 追加失败测试**

在 `charts.test.tsx` 末尾追加:

```tsx
import { RankBar } from "./rank-bar";
import { HourBars } from "./hour-bars";

describe("RankBar", () => {
  it("empty state", () => {
    const { getByText } = render(<RankBar rows={[]} />);
    expect(getByText("暂无数据")).toBeTruthy();
  });
  it("renders container", () => {
    const { container } = render(<RankBar rows={[{ label: "u1", value: 9 }]} />);
    expect(container.querySelector("[data-chart='rank-bar']")).toBeTruthy();
  });
});

describe("HourBars", () => {
  it("empty state when all zero", () => {
    const { getByText } = render(
      <HourBars buckets={Array.from({ length: 24 }, (_, h) => ({ hour: h, value: 0 }))} />,
    );
    expect(getByText("暂无数据")).toBeTruthy();
  });
  it("renders container with data", () => {
    const b = Array.from({ length: 24 }, (_, h) => ({ hour: h, value: h }));
    const { container } = render(<HourBars buckets={b} />);
    expect(container.querySelector("[data-chart='hour-bars']")).toBeTruthy();
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `cd cloud && bun run vitest run src/litellm-portal/dashboard/charts/charts.test.tsx`
Expected: FAIL — `Cannot find module './rank-bar'`

- [ ] **Step 3: 实现 rank-bar**

创建 `src/litellm-portal/dashboard/charts/rank-bar.tsx`:

```tsx
import React, { useEffect, useRef } from "react";
import { echarts } from "./echarts-core";
import { usePortalDarkMode, kumoAxisColors, categorical, TOOLTIP_STYLE } from "./kumo-chart-theme";

export type RankRow = { label: string; value: number };

export function RankBar({ rows, height = 280 }: { rows: RankRow[]; height?: number }) {
  const dark = usePortalDarkMode();
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (rows.length === 0 || ref.current === null) return;
    const chart = echarts.init(ref.current, undefined, { renderer: "svg" });
    const c = kumoAxisColors(dark);
    const ordered = [...rows].sort((a, b) => a.value - b.value);
    chart.setOption({
      backgroundColor: "transparent",
      tooltip: { trigger: "axis", ...TOOLTIP_STYLE(dark) },
      grid: { left: 90, right: 40, top: 10, bottom: 24 },
      xAxis: { type: "value", axisLine: { show: false }, splitLine: { lineStyle: { color: c.splitLine } }, axisLabel: { color: c.label } },
      yAxis: { type: "category", data: ordered.map((r) => r.label), axisLine: { lineStyle: { color: c.axisLine } }, axisLabel: { color: c.label } },
      series: [{
        type: "bar", data: ordered.map((r) => r.value),
        itemStyle: { color: categorical(0, dark), borderRadius: [0, 4, 4, 0] },
        label: { show: true, position: "right", color: c.label },
      }],
    });
    const onResize = () => chart.resize();
    window.addEventListener("resize", onResize);
    return () => { window.removeEventListener("resize", onResize); chart.dispose(); };
  }, [rows, dark]);

  if (rows.length === 0) {
    return <p className="py-12 text-center text-sm text-kumo-subtle">暂无数据</p>;
  }
  return <div data-chart="rank-bar" ref={ref} style={{ width: "100%", height }} />;
}
```

- [ ] **Step 4: 实现 hour-bars**

创建 `src/litellm-portal/dashboard/charts/hour-bars.tsx`:

```tsx
import React, { useEffect, useRef } from "react";
import { echarts } from "./echarts-core";
import { usePortalDarkMode, kumoAxisColors, categorical, TOOLTIP_STYLE } from "./kumo-chart-theme";

export type HourBucket = { hour: number; value: number };

export function HourBars({ buckets, height = 260 }: { buckets: HourBucket[]; height?: number }) {
  const dark = usePortalDarkMode();
  const ref = useRef<HTMLDivElement>(null);
  const allZero = buckets.every((b) => b.value === 0);

  useEffect(() => {
    if (allZero || ref.current === null) return;
    const chart = echarts.init(ref.current, undefined, { renderer: "svg" });
    const c = kumoAxisColors(dark);
    chart.setOption({
      backgroundColor: "transparent",
      tooltip: { trigger: "axis", ...TOOLTIP_STYLE(dark) },
      grid: { left: 40, right: 16, top: 16, bottom: 28 },
      xAxis: { type: "category", data: buckets.map((b) => `${b.hour}h`), axisLine: { lineStyle: { color: c.axisLine } }, axisLabel: { color: c.label, fontSize: 10 } },
      yAxis: { type: "value", axisLine: { show: false }, splitLine: { lineStyle: { color: c.splitLine } }, axisLabel: { color: c.label } },
      series: [{ type: "bar", data: buckets.map((b) => b.value), itemStyle: { color: categorical(0, dark), borderRadius: [4, 4, 0, 0] } }],
    });
    const onResize = () => chart.resize();
    window.addEventListener("resize", onResize);
    return () => { window.removeEventListener("resize", onResize); chart.dispose(); };
  }, [buckets, dark, allZero]);

  if (allZero) {
    return <p className="py-12 text-center text-sm text-kumo-subtle">暂无数据</p>;
  }
  return <div data-chart="hour-bars" ref={ref} style={{ width: "100%", height }} />;
}
```

- [ ] **Step 5: 运行确认通过**

Run: `cd cloud && bun run vitest run src/litellm-portal/dashboard/charts/charts.test.tsx`
Expected: PASS (8 tests)

- [ ] **Step 6: 提交**

```bash
git add cloud/src/litellm-portal/dashboard/charts/rank-bar.tsx cloud/src/litellm-portal/dashboard/charts/hour-bars.tsx cloud/src/litellm-portal/dashboard/charts/charts.test.tsx
git commit -m "feat(litellm-portal): rank bar + hour-of-day bars"
```

---

### Task 5: panels — kpi-band + recent-table

**Files:**
- Create: `src/litellm-portal/dashboard/panels/kpi-band.tsx`
- Create: `src/litellm-portal/dashboard/panels/recent-table.tsx`
- Create: `src/litellm-portal/dashboard/panels/panels.test.tsx`

- [ ] **Step 1: 写失败测试**

创建 `src/litellm-portal/dashboard/panels/panels.test.tsx`:

```tsx
/**
 * @vitest-environment happy-dom
 */
import React from "react";
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { KpiBand } from "./kpi-band";
import { RecentTable } from "./recent-table";

afterEach(cleanup);

describe("KpiBand", () => {
  const kpi = {
    spend: { current: 45.2, previous: 40, deltaPct: 13 },
    requests: { current: 312, previous: null, deltaPct: null },
    totalTokens: { current: 1000, previous: 900, deltaPct: 11 },
  };
  it("renders three metrics and tabular values", () => {
    const { getByText } = render(<KpiBand kpi={kpi} />);
    expect(getByText("$45.20")).toBeTruthy();
    expect(getByText("312")).toBeTruthy();
  });
  it("shows — when deltaPct is null", () => {
    const { getAllByText } = render(<KpiBand kpi={kpi} />);
    expect(getAllByText("—").length).toBeGreaterThan(0);
  });
});

describe("RecentTable", () => {
  it("empty state", () => {
    const { getByText } = render(<RecentTable rows={[]} />);
    expect(getByText("暂无记录")).toBeTruthy();
  });
  it("renders rows without a status column", () => {
    const { container, queryByText } = render(
      <RecentTable rows={[{ tsMs: 0, model: "gpt", totalTokens: 10, spend: 0.03 }]} />,
    );
    expect(container.querySelectorAll("tbody tr").length).toBe(1);
    expect(queryByText("状态")).toBeNull();
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `cd cloud && bun run vitest run src/litellm-portal/dashboard/panels/panels.test.tsx`
Expected: FAIL — `Cannot find module './kpi-band'`

- [ ] **Step 3: 实现 kpi-band**

创建 `src/litellm-portal/dashboard/panels/kpi-band.tsx`:

```tsx
import React from "react";

type Metric = { current: number; previous: number | null; deltaPct: number | null };
type Kpi = { spend: Metric; requests: Metric; totalTokens: Metric };

function fmtSpend(v: number): string { return `$${v.toFixed(2)}`; }
function fmtInt(v: number): string { return v.toLocaleString("en-US"); }

function Delta({ pct }: { pct: number | null }) {
  if (pct === null) return <span className="text-kumo-subtle">—</span>;
  const up = pct >= 0;
  return (
    <span className={up ? "text-kumo-success" : "text-kumo-danger"}>
      {up ? "▲" : "▼"} {Math.abs(pct)}%
    </span>
  );
}

function Card({ label, value, pct }: { label: string; value: string; pct: number | null }) {
  return (
    <div className="rounded-xl border border-kumo-line bg-kumo-base p-5">
      <div className="text-xs uppercase tracking-wider text-kumo-subtle">{label}</div>
      <div className="mt-1 font-mono text-2xl font-semibold tabular-nums text-kumo-strong">{value}</div>
      <div className="mt-1 text-xs"><Delta pct={pct} /></div>
    </div>
  );
}

export function KpiBand({ kpi }: { kpi: Kpi }) {
  return (
    <div className="mb-4 grid grid-cols-1 gap-3 md:grid-cols-3">
      <Card label="累计消费" value={fmtSpend(kpi.spend.current)} pct={kpi.spend.deltaPct} />
      <Card label="累计请求" value={fmtInt(kpi.requests.current)} pct={kpi.requests.deltaPct} />
      <Card label="累计 Tokens" value={fmtInt(kpi.totalTokens.current)} pct={kpi.totalTokens.deltaPct} />
    </div>
  );
}
```

- [ ] **Step 4: 实现 recent-table**

创建 `src/litellm-portal/dashboard/panels/recent-table.tsx`:

```tsx
import React from "react";

export type RecentRow = { tsMs: number; model: string; totalTokens: number; spend: number };

function fmtTime(ms: number): string {
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai", hour: "2-digit", minute: "2-digit", hour12: false,
  }).format(new Date(ms));
}

export function RecentTable({ rows }: { rows: RecentRow[] }) {
  if (rows.length === 0) {
    return <p className="py-10 text-center text-sm text-kumo-subtle">暂无记录</p>;
  }
  return (
    <table className="w-full text-left text-sm text-kumo-default">
      <thead>
        <tr className="border-b border-kumo-line">
          <th className="pb-3 pr-3 text-xs uppercase tracking-wider text-kumo-subtle">时间</th>
          <th className="pb-3 pr-3 text-xs uppercase tracking-wider text-kumo-subtle">模型</th>
          <th className="pb-3 pr-3 text-right text-xs uppercase tracking-wider text-kumo-subtle">Tokens</th>
          <th className="pb-3 pr-3 text-right text-xs uppercase tracking-wider text-kumo-subtle">费用</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r, i) => (
          <tr key={i} className="border-b border-kumo-fill">
            <td className="py-3 pr-3 font-mono">{fmtTime(r.tsMs)}</td>
            <td className="py-3 pr-3">{r.model}</td>
            <td className="py-3 pr-3 text-right font-mono tabular-nums">{r.totalTokens.toLocaleString("en-US")}</td>
            <td className="py-3 pr-3 text-right font-mono tabular-nums">${r.spend.toFixed(3)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
```

- [ ] **Step 5: 运行确认通过**

Run: `cd cloud && bun run vitest run src/litellm-portal/dashboard/panels/panels.test.tsx`
Expected: PASS (4 tests)

- [ ] **Step 6: 提交**

```bash
git add cloud/src/litellm-portal/dashboard/panels/kpi-band.tsx cloud/src/litellm-portal/dashboard/panels/recent-table.tsx cloud/src/litellm-portal/dashboard/panels/panels.test.tsx
git commit -m "feat(litellm-portal): KPI band + recent table (no status column)"
```

---

### Task 6: panels — alert-panel(状态点)+ user-table

**Files:**
- Create: `src/litellm-portal/dashboard/panels/alert-panel.tsx`
- Create: `src/litellm-portal/dashboard/panels/user-table.tsx`
- Modify: `src/litellm-portal/dashboard/panels/panels.test.tsx`

- [ ] **Step 1: 追加失败测试**

在 `panels.test.tsx` 末尾追加:

```tsx
import { AlertPanel } from "./alert-panel";
import { UserTable } from "./user-table";

describe("AlertPanel", () => {
  it("renders status dots + text, no tint pills", () => {
    const { container, getByText } = render(
      <AlertPanel alerts={[{ tone: "danger", title: "配额预警", text: "已用 70.7%" }]} />,
    );
    expect(getByText("配额预警")).toBeTruthy();
    expect(container.querySelector("[data-dot='danger']")).toBeTruthy();
  });
  it("renders nothing when no alerts", () => {
    const { container } = render(<AlertPanel alerts={[]} />);
    expect(container.firstChild).toBeNull();
  });
});

describe("UserTable", () => {
  it("calls onSelect with userId and maxBudget on row click", () => {
    let picked: { userId: string; maxBudget: number | null } | null = null;
    const { getByText } = render(
      <UserTable
        rows={[{ userId: "u1", email: "u1@x.com", spend: 5, maxBudget: 10, role: "user" }]}
        onSelect={(p) => { picked = p; }}
      />,
    );
    getByText("u1@x.com").click();
    expect(picked).toEqual({ userId: "u1", maxBudget: 10 });
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `cd cloud && bun run vitest run src/litellm-portal/dashboard/panels/panels.test.tsx`
Expected: FAIL — `Cannot find module './alert-panel'`

- [ ] **Step 3: 实现 alert-panel(状态点 + 文字,无 tint 填充)**

创建 `src/litellm-portal/dashboard/panels/alert-panel.tsx`:

```tsx
import React from "react";

export type AlertTone = "success" | "warning" | "danger";
export type AlertItem = { tone: AlertTone; title: string; text: string };

const DOT: Record<AlertTone, string> = {
  success: "bg-kumo-success",
  warning: "bg-kumo-warning",
  danger: "bg-kumo-danger",
};

export function AlertPanel({ alerts }: { alerts: AlertItem[] }) {
  if (alerts.length === 0) return null;
  return (
    <div className="mb-4 rounded-xl border border-kumo-line bg-kumo-base p-5">
      <div className="mb-2 text-xs uppercase tracking-wider text-kumo-subtle">告警面板</div>
      {alerts.map((a, i) => (
        <div key={i} className="flex items-start gap-2 border-b border-kumo-fill py-2 last:border-0 text-sm">
          <span data-dot={a.tone} className={`mt-1.5 h-2 w-2 flex-none rounded-full ${DOT[a.tone]}`} />
          <span className="text-kumo-default"><b className="text-kumo-strong">{a.title}</b> {a.text}</span>
        </div>
      ))}
    </div>
  );
}
```

- [ ] **Step 4: 实现 user-table**

创建 `src/litellm-portal/dashboard/panels/user-table.tsx`:

```tsx
import React from "react";

export type UserRow = {
  userId: string; email: string; spend: number;
  maxBudget: number | null; role: "admin" | "user";
};

export function UserTable({
  rows, onSelect,
}: {
  rows: UserRow[];
  onSelect: (p: { userId: string; maxBudget: number | null }) => void;
}) {
  if (rows.length === 0) {
    return <p className="py-10 text-center text-sm text-kumo-subtle">暂无用户</p>;
  }
  return (
    <table className="w-full text-left text-sm text-kumo-default">
      <thead>
        <tr className="border-b border-kumo-line">
          <th className="pb-3 pr-3 text-xs uppercase tracking-wider text-kumo-subtle">用户</th>
          <th className="pb-3 pr-3 text-right text-xs uppercase tracking-wider text-kumo-subtle">消费</th>
          <th className="pb-3 pr-3 text-right text-xs uppercase tracking-wider text-kumo-subtle">预算</th>
          <th className="pb-3 pr-3 text-xs uppercase tracking-wider text-kumo-subtle">角色</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr
            key={r.userId}
            className="cursor-pointer border-b border-kumo-fill hover:bg-kumo-tint"
            onClick={() => onSelect({ userId: r.userId, maxBudget: r.maxBudget })}
          >
            <td className="py-3 pr-3">{r.email}<span className="ml-1 text-kumo-brand">›</span></td>
            <td className="py-3 pr-3 text-right font-mono tabular-nums">${r.spend.toFixed(2)}</td>
            <td className="py-3 pr-3 text-right font-mono tabular-nums">{r.maxBudget == null ? "—" : `$${r.maxBudget.toFixed(2)}`}</td>
            <td className="py-3 pr-3">{r.role}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
```

- [ ] **Step 5: 运行确认通过**

Run: `cd cloud && bun run vitest run src/litellm-portal/dashboard/panels/panels.test.tsx`
Expected: PASS (8 tests)

- [ ] **Step 6: 提交**

```bash
git add cloud/src/litellm-portal/dashboard/panels/alert-panel.tsx cloud/src/litellm-portal/dashboard/panels/user-table.tsx cloud/src/litellm-portal/dashboard/panels/panels.test.tsx
git commit -m "feat(litellm-portal): alert panel (status dots) + drillable user table"
```

---

### Task 7: personal-view + 接入 routes/index.tsx

**Files:**
- Create: `src/litellm-portal/dashboard/views/personal-view.tsx`
- Create: `src/litellm-portal/dashboard/views/personal-view.test.tsx`
- Modify: `src/litellm-portal/routes/index.tsx`
- Modify: `src/litellm-portal/app.tsx`(移除迁出的 UsagePanel 用量图逻辑)

- [ ] **Step 1: 写失败测试**

创建 `src/litellm-portal/dashboard/views/personal-view.test.tsx`:

```tsx
/**
 * @vitest-environment happy-dom
 */
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { PersonalView } from "./personal-view";

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

function wrap(ui: React.ReactElement) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

const RESP = {
  available: true, empty: false, scope: "self", window: "7d", grain: "day",
  grainFallback: false, timezone: "Asia/Shanghai",
  kpi: { spend: { current: 45.2, previous: 40, deltaPct: 13 },
         requests: { current: 312, previous: null, deltaPct: null },
         totalTokens: { current: 1000, previous: 900, deltaPct: 11 } },
  trend: [{ startMs: 1, label: "05-01", totalTokens: 10, requests: 2, spend: 1 }],
  models: [{ model: "gpt", spend: 1, totalTokens: 10, requests: 2 }],
  hourOfDay: Array.from({ length: 24 }, (_, h) => ({ hour: h, totalTokens: 0, requests: 0, spend: 0 })),
  recent: [{ tsMs: 0, model: "gpt", totalTokens: 10, spend: 0.03 }],
};

describe("PersonalView", () => {
  it("renders KPI + panels from /api/usage/overview", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify(RESP), { status: 200 }));
    const { getByText } = wrap(<PersonalView />);
    await waitFor(() => expect(getByText("$45.20")).toBeTruthy());
    expect(getByText("消费趋势")).toBeTruthy();
  });

  it("shows syncing placeholder when available=false", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(new Response(
      JSON.stringify({ ...RESP, available: false }), { status: 200 }));
    const { getByText } = wrap(<PersonalView />);
    await waitFor(() => expect(getByText("数据同步中")).toBeTruthy());
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `cd cloud && bun run vitest run src/litellm-portal/dashboard/views/personal-view.test.tsx`
Expected: FAIL — `Cannot find module './personal-view'`

- [ ] **Step 3: 实现 personal-view(reference 直译竖向流)**

创建 `src/litellm-portal/dashboard/views/personal-view.tsx`:

```tsx
import React, { useState } from "react";
import { useDashboard } from "../use-dashboard";
import type { DashboardWindow } from "../dashboard-schemas";
import { DASHBOARD_WINDOWS } from "../dashboard-schemas";
import { KpiBand } from "../panels/kpi-band";
import { RecentTable } from "../panels/recent-table";
import { TrendChart } from "../charts/trend-chart";
import { ModelDonut } from "../charts/model-donut";
import { HourBars } from "../charts/hour-bars";

function Panel({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="mb-4 rounded-xl border border-kumo-line bg-kumo-base">
      <div className="border-b border-kumo-line bg-kumo-elevated px-5 py-3 text-sm font-semibold text-kumo-strong">{title}</div>
      <div className="p-5">{children}</div>
    </div>
  );
}

export function PersonalView() {
  const [win, setWin] = useState<DashboardWindow>("30d");
  const { data, isError } = useDashboard({ kind: "self" }, win);

  if (isError) {
    return <p className="py-12 text-center text-sm text-kumo-danger">加载失败,请稍后重试</p>;
  }
  if (!data) {
    return <p className="py-12 text-center text-sm text-kumo-subtle">加载中…</p>;
  }
  if (!data.available) {
    return <p className="py-12 text-center text-sm text-kumo-subtle">数据同步中</p>;
  }

  return (
    <div>
      <div className="mb-4 flex gap-1">
        {DASHBOARD_WINDOWS.map((w) => (
          <button
            key={w}
            onClick={() => setWin(w)}
            className={`rounded-full px-4 py-1.5 text-sm ${w === win ? "bg-kumo-brand text-kumo-inverse" : "text-kumo-subtle hover:bg-kumo-tint"}`}
          >{w}</button>
        ))}
      </div>
      <KpiBand kpi={data.kpi} />
      {data.grainFallback && (
        <p className="mb-3 text-xs text-kumo-subtle">已自动调整为推荐粒度</p>
      )}
      <Panel title="消费趋势">
        {data.empty
          ? <p className="py-12 text-center text-sm text-kumo-subtle">该时间段暂无数据</p>
          : <TrendChart series={[{ name: "Tokens", points: data.trend.map((b) => [b.startMs, b.totalTokens]) }]} />}
      </Panel>
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <Panel title="常用模型占比">
          <ModelDonut slices={data.models.map((m) => ({ model: m.model, value: m.spend }))} />
        </Panel>
        <Panel title="使用时段分布">
          <HourBars buckets={data.hourOfDay.map((h) => ({ hour: h.hour, value: h.totalTokens }))} />
        </Panel>
      </div>
      <Panel title="最近请求记录">
        <RecentTable rows={data.recent ?? []} />
      </Panel>
    </div>
  );
}
```

- [ ] **Step 4: 接入路由,移除旧 UsagePanel 用量图**

在 `src/litellm-portal/routes/index.tsx` 中,把渲染 `PreferencesAwareUsagePanel` 的位置替换为 `<PersonalView />`(import 自 `../dashboard/views/personal-view`)。在 `src/litellm-portal/app.tsx` 中删除 `UsagePanel`(`app.tsx:637`)及其仅服务旧用量图的辅助(`UsageBucketsTable` 等仅被 UsagePanel 使用的部分);保留 keys/models/teams 等非用量逻辑。若 `PreferencesAwareUsagePanel` 仅包裹偏好默认窗口,改为给 `<PersonalView/>` 传入默认 window(从现有 preferences 读取)。

- [ ] **Step 5: 运行确认通过 + 类型检查**

Run:
```bash
cd cloud && bun run vitest run src/litellm-portal/dashboard/views/personal-view.test.tsx
bun run tsc --noEmit 2>&1 | grep -c 'error TS'
```
Expected: 测试 PASS(2);tsc `0`

- [ ] **Step 6: 提交**

```bash
git add -A cloud/src/litellm-portal/dashboard cloud/src/litellm-portal/routes/index.tsx cloud/src/litellm-portal/app.tsx
git commit -m "feat(litellm-portal): personal view (reference flow), wire route, drop old UsagePanel"
```

---

### Task 8: admin-view + member-overlay + 接入 admin 路由

**Files:**
- Create: `src/litellm-portal/dashboard/views/admin-view.tsx`
- Create: `src/litellm-portal/dashboard/views/member-overlay.tsx`
- Create: `src/litellm-portal/dashboard/views/admin-view.test.tsx`
- Modify: `src/litellm-portal/routes/admin/`(管理员路由组件)
- Modify: `src/litellm-portal/admin-components.tsx`(移除迁出的 AdminGlobalUsage 用量逻辑)

- [ ] **Step 1: 写失败测试**

创建 `src/litellm-portal/dashboard/views/admin-view.test.tsx`:

```tsx
/**
 * @vitest-environment happy-dom
 */
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { AdminView } from "./admin-view";

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

function wrap(ui: React.ReactElement) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

const GLOBAL = {
  available: true, empty: false, scope: "global", window: "7d", grain: "day",
  grainFallback: false, timezone: "Asia/Shanghai",
  kpi: { spend: { current: 128.5, previous: 110, deltaPct: 16 },
         requests: { current: 1247, previous: 1000, deltaPct: 24 },
         totalTokens: { current: 5000, previous: 4000, deltaPct: 25 } },
  trend: [{ startMs: 1, label: "05-01", totalTokens: 10, requests: 2, spend: 1 }],
  models: [{ model: "gpt", spend: 1, totalTokens: 10, requests: 2 }],
  hourOfDay: Array.from({ length: 24 }, (_, h) => ({ hour: h, totalTokens: h, requests: 0, spend: 0 })),
  perUser: [{ userId: "u1", points: [{ startMs: 1, spend: 5 }] }],
  summary: { userCount: 10, adminCount: 2, teamCount: 3, totalSpend: 128.5, totalBudget: 300, riskCount: 1, sampled: false },
};

describe("AdminView", () => {
  it("renders summary KPI + perUser trend (global scope)", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify(GLOBAL), { status: 200 }));
    const { getByText } = wrap(<AdminView />);
    await waitFor(() => expect(getByText("$128.50")).toBeTruthy());
    expect(getByText("团队消费趋势")).toBeTruthy();
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `cd cloud && bun run vitest run src/litellm-portal/dashboard/views/admin-view.test.tsx`
Expected: FAIL — `Cannot find module './admin-view'`

- [ ] **Step 3: 实现 member-overlay**

创建 `src/litellm-portal/dashboard/views/member-overlay.tsx`:

```tsx
import React from "react";
import { useDashboard } from "../use-dashboard";
import { KpiBand } from "../panels/kpi-band";
import { TrendChart } from "../charts/trend-chart";
import { ModelDonut } from "../charts/model-donut";
import { HourBars } from "../charts/hour-bars";

export function MemberOverlay({
  userId, maxBudget, onClose,
}: {
  userId: string; maxBudget: number | null; onClose: () => void;
}) {
  const { data } = useDashboard({ kind: "member", userId }, "30d");
  const spend = data?.kpi.spend.current ?? 0;
  const quotaPct = maxBudget && maxBudget > 0 ? Math.min(100, Math.round((spend / maxBudget) * 100)) : null;

  return (
    <div className="fixed inset-0 z-50 overflow-y-auto bg-kumo-canvas">
      <div className="sticky top-0 flex items-center justify-between border-b border-kumo-line bg-kumo-base px-8 py-5">
        <h2 className="text-lg font-semibold text-kumo-strong">{userId} 的使用详情</h2>
        <button onClick={onClose} className="rounded-full border border-kumo-line px-4 py-1.5 text-sm text-kumo-subtle hover:bg-kumo-tint">关闭</button>
      </div>
      <div className="mx-auto max-w-[1200px] p-6">
        {!data ? <p className="py-12 text-center text-sm text-kumo-subtle">加载中…</p>
          : !data.available ? <p className="py-12 text-center text-sm text-kumo-subtle">数据同步中</p>
          : (
          <>
            <KpiBand kpi={data.kpi} />
            <div className="mb-4 rounded-xl border border-kumo-line bg-kumo-base p-5">
              <div className="text-xs uppercase tracking-wider text-kumo-subtle">配额使用</div>
              <div className="mt-1 font-mono text-xl font-semibold tabular-nums text-kumo-strong">
                {quotaPct == null ? "无预算限制" : `${quotaPct}%`}
              </div>
              {quotaPct != null && (
                <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-kumo-fill">
                  <div className="h-full rounded-full bg-kumo-brand" style={{ width: `${quotaPct}%` }} />
                </div>
              )}
              <div className="mt-1 font-mono text-xs text-kumo-subtle">
                ${spend.toFixed(2)}{maxBudget != null ? ` / $${maxBudget.toFixed(2)}` : ""}
              </div>
            </div>
            <div className="mb-4 rounded-xl border border-kumo-line bg-kumo-base p-5">
              <div className="mb-2 text-xs uppercase tracking-wider text-kumo-subtle">近 30 天使用过的模型</div>
              <div className="flex flex-wrap gap-2">
                {data.models.map((m) => (
                  <span key={m.model} className="rounded-full bg-kumo-fill px-3 py-1 font-mono text-xs text-kumo-subtle">{m.model}</span>
                ))}
              </div>
            </div>
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
              <div className="rounded-xl border border-kumo-line bg-kumo-base p-5">
                <TrendChart series={[{ name: "Tokens", points: data.trend.map((b) => [b.startMs, b.totalTokens]) }]} />
              </div>
              <div className="rounded-xl border border-kumo-line bg-kumo-base p-5">
                <ModelDonut slices={data.models.map((m) => ({ model: m.model, value: m.spend }))} />
              </div>
            </div>
            <div className="mt-4 rounded-xl border border-kumo-line bg-kumo-base p-5">
              <HourBars buckets={data.hourOfDay.map((h) => ({ hour: h.hour, value: h.totalTokens }))} />
            </div>
          </>
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 4: 实现 admin-view**

创建 `src/litellm-portal/dashboard/views/admin-view.tsx`:

```tsx
import React, { useState } from "react";
import { useDashboard } from "../use-dashboard";
import { DASHBOARD_WINDOWS, type DashboardWindow } from "../dashboard-schemas";
import { KpiBand } from "../panels/kpi-band";
import { AlertPanel, type AlertItem } from "../panels/alert-panel";
import { TrendChart } from "../charts/trend-chart";
import { ModelDonut } from "../charts/model-donut";
import { RankBar } from "../charts/rank-bar";
import { HourBars } from "../charts/hour-bars";
import { MemberOverlay } from "./member-overlay";

function Panel({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="mb-4 rounded-xl border border-kumo-line bg-kumo-base">
      <div className="border-b border-kumo-line bg-kumo-elevated px-5 py-3 text-sm font-semibold text-kumo-strong">{title}</div>
      <div className="p-5">{children}</div>
    </div>
  );
}

function alertsFromSummary(s: NonNullable<ReturnType<typeof useDashboard>["data"]>["summary"]): AlertItem[] {
  if (!s) return [];
  const out: AlertItem[] = [];
  if (s.totalBudget > 0 && s.totalSpend / s.totalBudget >= 0.8) {
    out.push({ tone: "danger", title: "配额预警", text: `团队已用 ${Math.round((s.totalSpend / s.totalBudget) * 100)}%` });
  }
  if (s.riskCount > 0) {
    out.push({ tone: "warning", title: "风险项", text: `${s.riskCount} 个用户超预算` });
  }
  return out;
}

export function AdminView() {
  const [win, setWin] = useState<DashboardWindow>("7d");
  const [member, setMember] = useState<{ userId: string; maxBudget: number | null } | null>(null);
  const { data, isError } = useDashboard({ kind: "global" }, win);

  if (isError) return <p className="py-12 text-center text-sm text-kumo-danger">加载失败</p>;
  if (!data) return <p className="py-12 text-center text-sm text-kumo-subtle">加载中…</p>;
  if (!data.available) return <p className="py-12 text-center text-sm text-kumo-subtle">数据同步中</p>;

  return (
    <div>
      <div className="mb-4 flex gap-1">
        {DASHBOARD_WINDOWS.map((w) => (
          <button key={w} onClick={() => setWin(w)}
            className={`rounded-full px-4 py-1.5 text-sm ${w === win ? "bg-kumo-brand text-kumo-inverse" : "text-kumo-subtle hover:bg-kumo-tint"}`}>{w}</button>
        ))}
      </div>
      <AlertPanel alerts={alertsFromSummary(data.summary)} />
      <KpiBand kpi={data.kpi} />
      <Panel title="团队消费趋势">
        <TrendChart series={(data.perUser ?? []).map((u) => ({
          name: u.userId, points: u.points.map((p) => [p.startMs, p.spend]),
        }))} />
      </Panel>
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <Panel title="用户消费排行">
          <RankBar rows={(data.perUser ?? []).map((u) => ({
            label: u.userId, value: u.points.reduce((s, p) => s + p.spend, 0),
          }))} />
        </Panel>
        <Panel title="模型使用分布">
          <ModelDonut slices={data.models.map((m) => ({ model: m.model, value: m.spend }))} />
        </Panel>
      </div>
      <Panel title="团队时段分布">
        <HourBars buckets={data.hourOfDay.map((h) => ({ hour: h.hour, value: h.totalTokens }))} />
      </Panel>
      {member && (
        <MemberOverlay userId={member.userId} maxBudget={member.maxBudget} onClose={() => setMember(null)} />
      )}
    </div>
  );
}
```

> 用户详情表(`UserTable`)由现有 admin 用户数据(`/api/admin/users`)驱动并放在管理员路由页;`UserTable` 的 `onSelect` 接 `setMember`。本任务把 `AdminView` 接入 `routes/admin/` 的用量页;`UserTable` 已在 Task 6 完成,管理员页用既有 `useAdminUsers` 数据渲染并把行 `onSelect` 桥接到此处的 overlay(在路由组件内组合 `<AdminView/>` 与 `<UserTable rows=... onSelect=.../>`)。

- [ ] **Step 5: 接入 admin 路由,移除旧 AdminGlobalUsage 用量图**

在 `src/litellm-portal/routes/admin/`(管理员用量路由组件)替换原 `AdminGlobalUsage` 渲染为 `<AdminView />`;`admin-components.tsx` 删除 `AdminGlobalUsage`(`admin-components.tsx:859`)及仅服务它的图表/取数(`LazyUsageChart`、`use-admin-usage` 调用点),保留 `AdminUsersTable`/`AdminTeamsTable`/`AdminAuditFeed` 等非用量逻辑(用户表改用 `UserTable` 并接 overlay)。

- [ ] **Step 6: 运行确认通过 + 类型检查**

Run:
```bash
cd cloud && bun run vitest run src/litellm-portal/dashboard/views/admin-view.test.tsx
bun run tsc --noEmit 2>&1 | grep -c 'error TS'
```
Expected: 测试 PASS(1);tsc `0`

- [ ] **Step 7: 提交**

```bash
git add -A cloud/src/litellm-portal/dashboard cloud/src/litellm-portal/routes cloud/src/litellm-portal/admin-components.tsx
git commit -m "feat(litellm-portal): admin view + read-only member overlay, wire admin route"
```

---

### Task 9: 回归清理 + 全量验证

**Files:** 多文件清理

- [ ] **Step 1: 删除被取代的旧 hook 与 schema**

删除 `src/litellm-portal/hooks/use-admin-usage.ts` 及其测试(若有);从 `schemas.ts` 删除仅服务旧端点的 `UsageTimeseriesSchema`(确认无其它生产引用):

Run: `cd cloud && rg -n "use-admin-usage|UsageTimeseriesSchema|/api/usage/timeseries|/api/admin/usage/timeseries" src --glob '!**/dashboard/**'`
对每个命中:删除或改写(指向 `useDashboard`)。`chart.tsx`(旧 `UsageChart`)若仅被已删的 `UsagePanel`/`AdminGlobalUsage` 使用,一并删除其与 `chart.test.tsx`。

- [ ] **Step 2: 全量测试 + 类型 + dry-run**

Run:
```bash
cd cloud && bun run vitest run src/litellm-portal
bun run tsc --noEmit 2>&1 | grep -c 'error TS'
bunx wrangler deploy --dry-run --config wrangler.litellm-portal.toml 2>&1 | grep -iE "error" | head -5
```
Expected: `src/litellm-portal` 全套件 PASS(被删旧组件的测试已在 Step 1 一并删除);tsc `0`;dry-run 无 `error`。

- [ ] **Step 3: 确认前端无旧端点调用**

Run: `cd cloud && rg -n "usage/timeseries" src/litellm-portal --glob '!**/*.md'`
Expected: 无输出(L3 仅用 `/api/usage/overview`、`/api/admin/usage/overview`)。

- [ ] **Step 4: 最终提交**

```bash
git add -A cloud/src/litellm-portal
git commit -m "refactor(litellm-portal): remove superseded timeseries hook/schema; L3 verification"
```

---

## Self-Review

**Spec coverage:**
- §1 架构/文件结构 → Task 1-8 按 `dashboard/{charts,panels,views}` + `use-dashboard.ts` 落位;无关 island 不动(Task 7/8 仅迁出用量逻辑)。
- §2 数据流 → Task 1(useDashboard,window/member,available/empty/grainFallback)、Task 7/8(占位/空态/回落提示渲染)。
- §3 图表层 → Task 2(echarts-core 仅注册用到模块 + kumo 主题 + 暗色)、Task 3/4(四图,ChartPalette categorical,SVG)。懒加载:图表组件可被 `React.lazy` 包裹接入(views 内 import;如需进一步拆 chunk 由 bundle 分析驱动,non-blocking,spec §3 "island 懒加载" 已由现有 Suspense 模式支持)。
- §4 个人面板 reference 直译流 + 去状态列 → Task 5(RecentTable 无状态列)、Task 7(KPI→趋势→饼+时段→最近表 顺序)。
- §5 团队总览 + 状态点告警(无 tint) → Task 6(AlertPanel data-dot,无 -tint)、Task 8(告警→KPI→多线→排行+饼→时段)。
- §6 成员 overlay 只读 + 配额用 /api/admin/users maxBudget + 权限→近30d模型 → Task 8(MemberOverlay,quotaPct 用传入 maxBudget,模型 chips 来自 models,无编辑按钮)。
- §7 测试策略 → 每个 Task 的 `*.test.tsx`(happy-dom + testing-library + QueryClient),Task 9 回归。
- 验收 1-5 → Task 7/8/9。
- 数据缺口替代汇总 → RecentTable 去状态列(Task5)、MemberOverlay 近30d模型(Task8)、窗口仅 4 档(Task1 schema)、无编辑按钮(Task8)。

**偏差记录:** spec §5 提到 KPI「团队消费带进度条」;实现将进度条放在成员 overlay 的配额块(Task8)与告警/ KPI 文本呈现,团队 KPI 进度条若需要可在 Task 8 AdminView 的 KpiBand 上层补;为保持 KpiBand scope 无关复用(spec §1 要求复用),团队预算进度以 AlertPanel「配额预警」+ summary 呈现,等价表达 reference 的配额风险信号,不破坏复用边界。此为实现取舍,功能信号不丢失。

**Placeholder scan:** 无 TBD/TODO;每个改码步骤含完整组件代码与可运行命令;迁移/清理步骤给出精确 `rg` 判定。

**Type consistency:** `DashboardResponse`/`DashboardWindow`/`DashboardScope`(Task1)在 Task7/8 一致;`useDashboard(scope,window)` 签名 Task1 定义、Task7/8 调用一致;图表 props(`TrendSeries{name,points}`、`ModelSlice{model,value}`、`RankRow{label,value}`、`HourBucket{hour,value}`)Task3/4 定义、Task7/8 传参一致;`UserTable.onSelect({userId,maxBudget})`(Task6)→ `MemberOverlay{userId,maxBudget}`(Task8)一致;`AlertItem{tone,title,text}` Task6 定义、Task8 `alertsFromSummary` 产出一致;`data-chart`/`data-dot` 测试钩子前后一致。
