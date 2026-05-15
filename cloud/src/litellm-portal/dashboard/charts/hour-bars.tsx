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
