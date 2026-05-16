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
