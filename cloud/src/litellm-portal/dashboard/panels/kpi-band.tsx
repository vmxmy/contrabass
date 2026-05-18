import React from "react";
import { fmtCompact } from "../../lib/format";
import { PanelCard } from "../../ui";

type Metric = { current: number; previous: number | null; deltaPct: number | null };
type Kpi = { spend: Metric; requests: Metric; totalTokens: Metric };

function fmtSpend(v: number): string { return `$${v.toFixed(2)}`; }
function fmtInt(v: number): string { return v.toLocaleString("en-US"); }

function Delta({ pct }: { pct: number | null }) {
  if (pct === null) return <span className="text-kumo-subtle">—</span>;
  const up = pct >= 0;
  return (
    <span className={up ? "text-kumo-success" : "text-kumo-danger"}>
      {up ? "▲" : "▼"} {Math.abs(pct)}%
    </span>
  );
}

function Card({ label, value, pct }: { label: string; value: string; pct: number | null }) {
  return (
    <PanelCard>
      <div className="text-xs uppercase tracking-wider text-kumo-subtle">{label}</div>
      <div className="mt-1 font-mono text-2xl font-semibold tabular-nums text-kumo-strong">{value}</div>
      <div className="mt-1 text-xs"><Delta pct={pct} /></div>
    </PanelCard>
  );
}

export function KpiBand({ kpi }: { kpi: Kpi }) {
  return (
    <div className="mb-4 grid grid-cols-1 gap-3 md:grid-cols-3">
      <Card label="消费额" value={fmtSpend(kpi.spend.current)} pct={kpi.spend.deltaPct} />
      <Card label="请求数" value={fmtInt(kpi.requests.current)} pct={kpi.requests.deltaPct} />
      <Card label="Tokens" value={fmtCompact(kpi.totalTokens.current)} pct={kpi.totalTokens.deltaPct} />
    </div>
  );
}
