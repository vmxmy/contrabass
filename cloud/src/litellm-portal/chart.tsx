import React, { useEffect, useMemo, useState } from "react";
import { TimeseriesChart, ChartPalette, type TimeseriesData } from "@cloudflare/kumo/components/chart";
import * as echarts from "echarts/core";
import { LineChart } from "echarts/charts";
import {
  AriaComponent,
  BrushComponent,
  GridComponent,
  ToolboxComponent,
  TooltipComponent,
} from "echarts/components";
import { SVGRenderer } from "echarts/renderers";
import { Loader } from "@cloudflare/kumo/components/loader";

echarts.use([
  LineChart,
  GridComponent,
  TooltipComponent,
  BrushComponent,
  ToolboxComponent,
  AriaComponent,
  SVGRenderer,
]);

export type UsageBucket = {
  start?: string;
  end?: string;
  label: string;
  totalTokens: number;
  promptTokens: number;
  completionTokens: number;
  requests: number;
  spend: number;
};

export type UsageTimeseries = {
  available: boolean;
  grain: string;
  window: string;
  windowLabel: string;
  start: string;
  end: string;
  source: string;
  timezone: string;
  limited: boolean;
  maxPages: number | null;
  buckets: UsageBucket[];
  totals: {
    totalTokens: number;
    promptTokens: number;
    completionTokens: number;
    requests: number;
    spend: number;
  };
  topModels?: Array<{ model: string; spend: number; totalTokens: number; requests: number }>;
};

type UsageChartProps = {
  data: UsageTimeseries | null;
  error?: string | null;
  loading?: boolean;
  onTimeRangeChange?: (from: number, to: number) => void;
};

const TOKEN_SERIES_NAME = "Tokens";
const DEFAULT_TIMEZONE = "Asia/Shanghai";

function isDarkMode(): boolean {
  return typeof document !== "undefined" && document.documentElement.dataset.mode === "dark";
}

function usePortalDarkMode(): boolean {
  const [darkMode, setDarkMode] = useState(isDarkMode);

  useEffect(() => {
    if (typeof document === "undefined" || typeof MutationObserver === "undefined") return;
    const observer = new MutationObserver(() => setDarkMode(isDarkMode()));
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-mode"] });
    return () => observer.disconnect();
  }, []);

  return darkMode;
}

function bucketTimestamp(bucket: UsageBucket): number | null {
  const timestamp = Date.parse(bucket.start ?? bucket.end ?? "");
  return Number.isFinite(timestamp) ? timestamp : null;
}

function formatCompactNumber(value: number): string {
  if (Math.abs(value) >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}m`;
  if (Math.abs(value) >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  return String(value);
}

function formatTick(value: number, grain: string, timezone: string): string {
  const options: Intl.DateTimeFormatOptions = grain === "minute" || grain === "hour"
    ? { timeZone: timezone, month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }
    : { timeZone: timezone, month: "2-digit", day: "2-digit" };
  return new Intl.DateTimeFormat("zh-CN", options).format(new Date(value));
}

export function UsageChart({ data, error, loading = false, onTimeRangeChange }: UsageChartProps) {
  const isDark = usePortalDarkMode();
  const chartPoints = useMemo(() => {
    if (!data?.buckets?.length) return [];
    return data.buckets
      .map((bucket) => {
        const timestamp = bucketTimestamp(bucket);
        return timestamp == null ? null : [timestamp, Number(bucket.totalTokens || 0)] satisfies [number, number];
      })
      .filter((point): point is [number, number] => point !== null)
      .sort((a, b) => a[0] - b[0]);
  }, [data]);

  const series = useMemo<TimeseriesData[]>(() => {
    if (chartPoints.length === 0) return [];
    return [
      {
        name: TOKEN_SERIES_NAME,
        data: chartPoints,
        color: ChartPalette.categorical(0, isDark),
      },
    ];
  }, [chartPoints, isDark]);

  if (loading) {
    return (
      <div className="flex w-full items-center justify-center py-12" aria-live="polite">
        <Loader aria-label="正在加载用量图表" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex w-full items-center justify-center py-12">
        <p className="text-sm text-kumo-danger">{error}</p>
      </div>
    );
  }

  if (!data || !data.available || series.length === 0) {
    return (
      <div className="flex w-full items-center justify-center py-12">
        <p className="text-sm text-kumo-subtle">暂无可展示的用量数据</p>
      </div>
    );
  }

  const maxTokens = Math.max(...chartPoints.map(([, tokens]) => tokens), 1);
  const timezone = data.timezone || DEFAULT_TIMEZONE;

  return (
    <div className="w-full">
      <TimeseriesChart
        echarts={echarts}
        type="line"
        data={series}
        height={300}
        gradient
        isDarkMode={isDark}
        xAxisTickCount={6}
        xAxisTickFormat={(value) => formatTick(value, data.grain, timezone)}
        yAxisTickFormat={formatCompactNumber}
        tooltipValueFormat={(value) => `${Number(value || 0).toLocaleString("zh-CN")} tokens`}
        onTimeRangeChange={onTimeRangeChange}
        ariaDescription={`Token 用量趋势图，时间范围为 ${data.windowLabel}，共 ${chartPoints.length} 个 ${data.grain} 粒度数据点。可在图表中横向拖拽选择时间范围。`}
      />
      <div className="mt-2 flex flex-wrap items-center justify-center gap-x-4 gap-y-1 text-xs text-kumo-subtle">
        <span>峰值 {maxTokens.toLocaleString("zh-CN")} tokens</span>
        <span>横向拖拽图表可按预设范围重新取数</span>
      </div>
    </div>
  );
}
