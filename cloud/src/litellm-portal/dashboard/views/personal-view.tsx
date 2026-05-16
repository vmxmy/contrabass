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
    return <p className="py-12 text-center text-sm text-kumo-danger">加载失败，请稍后重试</p>;
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
