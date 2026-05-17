import React, { useEffect, useRef } from "react";
import { echarts } from "./echarts-core";
import { usePortalDarkMode, kumoAxisColors, categorical, TOOLTIP_STYLE } from "./kumo-chart-theme";

export type RankRow = { label: string; value: number };
export type RankBarProps = { rows: RankRow[]; height?: number };

export function RankBar({ rows, height = 280 }: RankBarProps) {
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
