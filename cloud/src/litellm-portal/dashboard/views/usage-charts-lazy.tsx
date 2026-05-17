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
