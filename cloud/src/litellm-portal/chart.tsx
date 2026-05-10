import React, { useMemo } from "react";
import { Loader } from "@cloudflare/kumo/components/loader";
import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

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
};

export function UsageChart({ data, error, loading = false }: UsageChartProps) {
  const chartData = useMemo(() => {
    if (!data?.buckets?.length) return [];
    return data.buckets.map((bucket) => ({
      label: bucket.label,
      tokens: bucket.totalTokens,
      promptTokens: bucket.promptTokens,
      completionTokens: bucket.completionTokens,
      requests: bucket.requests,
      spend: bucket.spend,
    }));
  }, [data]);

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

  if (!data || !data.available || chartData.length === 0) {
    return (
      <div className="flex w-full items-center justify-center py-12">
        <p className="text-sm text-kumo-subtle">暂无可展示的用量数据</p>
      </div>
    );
  }

  const maxTokens = Math.max(...chartData.map((d) => d.tokens), 1);

  return (
    <div className="w-full">
      <ResponsiveContainer width="100%" height={224}>
        <LineChart
          data={chartData}
          margin={{ top: 8, right: 16, bottom: 8, left: 0 }}
        >
          <CartesianGrid
            strokeDasharray="3 3"
            stroke="var(--color-kumo-line)"
            vertical={false}
          />
          <XAxis
            dataKey="label"
            tick={{ fill: "var(--text-color-kumo-subtle)", fontSize: 11 }}
            axisLine={{ stroke: "var(--color-kumo-line)" }}
            tickLine={{ stroke: "var(--color-kumo-line)" }}
            interval="preserveStartEnd"
            minTickGap={24}
          />
          <YAxis
            tick={{ fill: "var(--text-color-kumo-subtle)", fontSize: 11 }}
            axisLine={false}
            tickLine={false}
            tickFormatter={(value: number) =>
              value >= 1000 ? `${(value / 1000).toFixed(1)}k` : String(value)
            }
            domain={[0, maxTokens]}
            width={48}
          />
          <Tooltip
            contentStyle={{
              backgroundColor: "var(--color-kumo-base)",
              border: "1px solid var(--color-kumo-line)",
              borderRadius: "8px",
              fontSize: "12px",
              color: "var(--text-color-kumo-default)",
            }}
            itemStyle={{ color: "var(--text-color-kumo-brand)" }}
            formatter={(value: number) => [
              value.toLocaleString("zh-CN"),
              "Tokens",
            ]}
            labelFormatter={(label: string) => label}
          />
          <Line
            type="monotone"
            dataKey="tokens"
            stroke="var(--text-color-kumo-brand)"
            strokeWidth={2}
            dot={{ r: 3, fill: "var(--text-color-kumo-brand)" }}
            activeDot={{ r: 5, fill: "var(--text-color-kumo-brand)" }}
            animationDuration={500}
          />
        </LineChart>
      </ResponsiveContainer>
      <p className="mt-1 text-center text-xs text-kumo-subtle">
        峰值 {maxTokens.toLocaleString("zh-CN")} tokens
      </p>
    </div>
  );
}
