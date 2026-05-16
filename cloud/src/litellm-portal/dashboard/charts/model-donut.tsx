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
