import React, { useEffect, useRef } from "react";
import { echarts } from "./echarts-core";
import { usePortalDarkMode, kumoAxisColors, categorical, TOOLTIP_STYLE } from "./kumo-chart-theme";

export type TrendSeries = { name: string; points: Array<[number, number]>; dashed?: boolean };

export function TrendChart({ series, height = 300, ariaLabel, yAxisFormatter, stacked }: { series: TrendSeries[]; height?: number; ariaLabel?: string; yAxisFormatter?: (value: number) => string; stacked?: boolean }) {
  const dark = usePortalDarkMode();
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (series.length === 0 || ref.current === null) return;
    const chart = echarts.init(ref.current, undefined, { renderer: "svg" });
    const c = kumoAxisColors(dark);
    chart.setOption({
      backgroundColor: "transparent",
      tooltip: { trigger: "axis", order: stacked ? "valueDesc" : "seriesAsc", ...TOOLTIP_STYLE(dark) },
      legend: series.length > 1 ? { textStyle: { color: c.label }, top: 0 } : undefined,
      grid: { left: 50, right: 20, top: series.length > 1 ? 30 : 16, bottom: 28 },
      xAxis: { type: "time", axisLine: { lineStyle: { color: c.axisLine } }, axisLabel: { color: c.label } },
      yAxis: { type: "value", axisLine: { show: false }, splitLine: { lineStyle: { color: c.splitLine } }, axisLabel: { color: c.label, formatter: yAxisFormatter ? (v: number) => yAxisFormatter(v) : undefined } },
      series: series.map((s, i) => ({
        name: s.name, type: "line", smooth: true, showSymbol: false,
        data: s.points,
        stack: stacked ? "total" : undefined,
        lineStyle: { width: 2, type: s.dashed ? "dashed" : "solid" },
        itemStyle: { color: categorical(i, dark) },
        areaStyle: stacked ? { opacity: 0.22 } : series.length === 1 ? { opacity: 0.12 } : undefined,
        emphasis: stacked ? { focus: "series" } : undefined,
      })),
    });
    const onResize = () => chart.resize();
    window.addEventListener("resize", onResize);
    return () => { window.removeEventListener("resize", onResize); chart.dispose(); };
  }, [series, dark]);

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
