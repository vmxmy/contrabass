import React, { useState } from "react";
import { useDashboard } from "../use-dashboard";
import { DASHBOARD_WINDOWS, type DashboardWindow } from "../dashboard-schemas";
import { KpiBand } from "../panels/kpi-band";
import { AlertPanel, type AlertItem } from "../panels/alert-panel";
import { TrendChart } from "../charts/trend-chart";
import { ModelDonut } from "../charts/model-donut";
import { RankBar } from "../charts/rank-bar";
import { HourBars } from "../charts/hour-bars";
import { UserTable, type UserRow } from "../panels/user-table";
import { useAdminUsers } from "../../hooks/use-admin-users";
import { MemberOverlay } from "./member-overlay";

function Panel({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="mb-4 rounded-xl border border-kumo-line bg-kumo-base">
      <div className="border-b border-kumo-line bg-kumo-elevated px-5 py-3 text-sm font-semibold text-kumo-strong">{title}</div>
      <div className="p-5">{children}</div>
    </div>
  );
}

function alertsFromSummary(s: NonNullable<ReturnType<typeof useDashboard>["data"]>["summary"]): AlertItem[] {
  if (!s) return [];
  const out: AlertItem[] = [];
  if (s.totalBudget > 0 && s.totalSpend / s.totalBudget >= 0.8) {
    out.push({ tone: "danger", title: "配额预警", text: `团队已用 ${Math.round((s.totalSpend / s.totalBudget) * 100)}%` });
  }
  if (s.riskCount > 0) {
    out.push({ tone: "warning", title: "风险项", text: `${s.riskCount} 个用户超预算` });
  }
  return out;
}

export function AdminView() {
  const [win, setWin] = useState<DashboardWindow>("7d");
  const [member, setMember] = useState<{ userId: string; maxBudget: number | null } | null>(null);
  const { data, isError } = useDashboard({ kind: "global" }, win);
  const { data: usersData } = useAdminUsers(1, 50);

  const userRows: UserRow[] = (usersData?.users ?? []).map((u) => ({
    userId: u.userId,
    email: u.email ?? u.userId,
    spend: u.spend ?? 0,
    maxBudget: u.maxBudget,
    role: (u.role?.toLowerCase().includes("admin") ? "admin" : "user") as UserRow["role"],
  }));

  if (isError) return <p className="py-12 text-center text-sm text-kumo-danger">加载失败</p>;
  if (!data) return <p className="py-12 text-center text-sm text-kumo-subtle">加载中…</p>;
  if (!data.available) return <p className="py-12 text-center text-sm text-kumo-subtle">数据同步中</p>;

  return (
    <div>
      <div className="mb-4 flex gap-1">
        {DASHBOARD_WINDOWS.map((w) => (
          <button key={w} onClick={() => setWin(w)}
            className={`rounded-full px-4 py-1.5 text-sm ${w === win ? "bg-kumo-brand text-kumo-inverse" : "text-kumo-subtle hover:bg-kumo-tint"}`}>{w}</button>
        ))}
      </div>
      <AlertPanel alerts={alertsFromSummary(data.summary)} />
      <KpiBand kpi={data.kpi} />
      <Panel title="团队消费趋势">
        <TrendChart series={(data.perUser ?? []).map((u) => ({
          name: u.userId, points: u.points.map((p) => [p.startMs, p.spend]),
        }))} />
      </Panel>
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <Panel title="用户消费排行">
          <RankBar rows={(data.perUser ?? []).map((u) => ({
            label: u.userId, value: u.points.reduce((s, p) => s + p.spend, 0),
          }))} />
        </Panel>
        <Panel title="模型使用分布">
          <ModelDonut slices={data.models.map((m) => ({ model: m.model, value: m.spend }))} />
        </Panel>
      </div>
      <Panel title="团队时段分布">
        <HourBars buckets={data.hourOfDay.map((h) => ({ hour: h.hour, value: h.totalTokens }))} />
      </Panel>
      <Panel title="用户明细">
        <UserTable rows={userRows} onSelect={setMember} />
      </Panel>
      {member && (
        <MemberOverlay userId={member.userId} maxBudget={member.maxBudget} onClose={() => setMember(null)} />
      )}
    </div>
  );
}
