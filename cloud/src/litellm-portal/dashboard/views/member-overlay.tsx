import React from "react";
import { useDashboard } from "../use-dashboard";
import { KpiBand } from "../panels/kpi-band";
import { TrendChart } from "../charts/trend-chart";
import { ModelDonut } from "../charts/model-donut";
export function MemberOverlay({
  userId, maxBudget, onClose,
}: {
  userId: string; maxBudget: number | null; onClose: () => void;
}) {
  const { data } = useDashboard({ kind: "member", userId }, "30d");
  const { data: globalData } = useDashboard({ kind: "global" }, "30d");
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
                {(() => {
                  const memberPoints: Array<[number, number]> = data.trend.map((b) => [b.startMs, b.totalTokens]);
                  const userCount = globalData?.summary?.userCount ?? 0;
                  const teamAvgPoints: Array<[number, number]> | null =
                    globalData && userCount > 0
                      ? globalData.trend
                          .map((b, i): [number, number] | null => {
                            const memberBucket = data.trend[i];
                            if (!memberBucket) return null;
                            return [memberBucket.startMs, b.totalTokens / userCount];
                          })
                          .filter((p): p is [number, number] => p !== null)
                      : null;
                  return (
                    <TrendChart
                      series={[
                        { name: "个人", points: memberPoints },
                        ...(teamAvgPoints ? [{ name: "团队人均", points: teamAvgPoints, dashed: true }] : []),
                      ]}
                    />
                  );
                })()}
              </div>
              <div className="rounded-xl border border-kumo-line bg-kumo-base p-5">
                <ModelDonut slices={data.models.map((m) => ({ model: m.model, value: m.spend }))} />
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
