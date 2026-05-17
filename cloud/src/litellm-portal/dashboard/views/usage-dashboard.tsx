import React, { useEffect, useMemo, useState } from "react";
import { Tabs } from "@cloudflare/kumo/components/tabs";
import { useDashboard } from "../use-dashboard";
import { DASHBOARD_WINDOWS, type DashboardWindow } from "../dashboard-schemas";
import type { UserPreferences } from "../../schemas";
import { useMe } from "../../hooks/use-me";
import { usePreferences } from "../../hooks/use-preferences";
import { useAdminUsers } from "../../hooks/use-admin-users";
import { KpiBand } from "../panels/kpi-band";
import { AlertPanel, type AlertItem } from "../panels/alert-panel";
import { TrendChart } from "../charts/trend-chart";
import { buildChartAriaDescription } from "../charts/build-chart-aria";
import { t } from "@lingui/core/macro";
import { ModelDonut } from "../charts/model-donut";
import { RankBar } from "../charts/rank-bar";
import { UserTable, type UserRow } from "../panels/user-table";
import { Panel, WindowSelector } from "../components/panel";
import { MemberOverlay } from "./member-overlay";

type DashboardScopeValue = "self" | "global";

type UsageDashboardProps = {
  initialScope?: DashboardScopeValue;
  initialWindow?: DashboardWindow;
};

type DashboardSummary = NonNullable<ReturnType<typeof useDashboard>["data"]>["summary"];

function isDashboardWindow(value: unknown): value is DashboardWindow {
  return typeof value === "string" && (DASHBOARD_WINDOWS as readonly string[]).includes(value);
}

function initialWindowFromPreferences(preferences: UserPreferences | undefined, fallback: DashboardWindow | undefined): DashboardWindow {
  if (fallback) return fallback;
  if (isDashboardWindow(preferences?.defaultUsageWindow)) return preferences.defaultUsageWindow;
  return "30d";
}

function initialScopeFromPreferences(
  isAdmin: boolean,
  preferences: UserPreferences | undefined,
  fallback: DashboardScopeValue | undefined,
): DashboardScopeValue {
  if (!isAdmin) return "self";
  if (fallback) return fallback;
  return preferences?.defaultTab === "admin" ? "global" : "self";
}

function alertsFromSummary(summary: DashboardSummary): AlertItem[] {
  if (!summary) return [];
  const alerts: AlertItem[] = [];
  if (summary.totalBudget > 0 && summary.totalSpend / summary.totalBudget >= 0.8) {
    alerts.push({
      tone: "danger",
      title: "配额预警",
      text: `团队已用 ${Math.round((summary.totalSpend / summary.totalBudget) * 100)}%`,
    });
  }
  if (summary.riskCount > 0) {
    alerts.push({ tone: "warning", title: "风险项", text: `${summary.riskCount} 个用户超预算` });
  }
  return alerts;
}

function DashboardStatus({ tone, children }: { tone?: "danger"; children: React.ReactNode }) {
  const className = tone === "danger" ? "text-kumo-danger" : "text-kumo-subtle";
  return <p className={`py-12 text-center text-sm ${className}`}>{children}</p>;
}

function GlobalUserDetails() {
  const [member, setMember] = useState<{ userId: string; maxBudget: number | null } | null>(null);
  const { data: usersData } = useAdminUsers(1, 50);

  const userRows: UserRow[] = useMemo(() => (usersData?.users ?? []).map((user) => ({
    userId: user.userId,
    email: user.email ?? user.userId,
    spend: user.spend ?? 0,
    maxBudget: user.maxBudget,
    role: (user.role?.toLowerCase().includes("admin") ? "admin" : "user") as UserRow["role"],
  })), [usersData]);

  return (
    <>
      <Panel title="用户明细">
        <UserTable rows={userRows} onSelect={setMember} />
      </Panel>
      {member ? (
        <MemberOverlay userId={member.userId} maxBudget={member.maxBudget} onClose={() => setMember(null)} />
      ) : null}
    </>
  );
}

export function UsageDashboard({ initialScope, initialWindow }: UsageDashboardProps = {}) {
  const { data: me } = useMe();
  const { data: preferences } = usePreferences();
  const isAdmin = me?.role === "admin";
  const [scope, setScope] = useState<DashboardScopeValue>(() => initialScope ?? "self");
  const [win, setWin] = useState<DashboardWindow>(() => initialWindow ?? "30d");
  const [appliedDefaults, setAppliedDefaults] = useState(false);

  useEffect(() => {
    if (appliedDefaults || me === undefined || preferences === undefined) return;
    setScope(initialScopeFromPreferences(isAdmin, preferences, initialScope));
    setWin(initialWindowFromPreferences(preferences, initialWindow));
    setAppliedDefaults(true);
  }, [appliedDefaults, initialScope, initialWindow, isAdmin, me, preferences]);

  useEffect(() => {
    if (!isAdmin && scope !== "self") setScope("self");
  }, [isAdmin, scope]);

  const resolvedScope: DashboardScopeValue = isAdmin ? scope : "self";
  const dashboardScope = resolvedScope === "global" ? { kind: "global" as const } : { kind: "self" as const };
  const { data, isError } = useDashboard(dashboardScope, win);

  const trendSeries = resolvedScope === "global"
    ? (data?.perUser ?? []).map((user) => ({
        name: user.userId,
        points: user.points.map((point) => [point.startMs, point.spend] as [number, number]),
      }))
    : data
      ? [{ name: "Tokens", points: data.trend.map((bucket) => [bucket.startMs, bucket.totalTokens] as [number, number]) }]
      : [];

  const rankRows = (data?.perUser ?? []).map((user) => ({
    label: user.userId,
    value: user.points.reduce((sum, point) => sum + point.spend, 0),
  }));

  const trendAriaLabel = buildChartAriaDescription(
    { windowLabel: win, points: trendSeries[0]?.points.length ?? 0, grain: data?.grain ?? "" },
    { template: t`Token 用量趋势图，时间范围为 '{'window'}'，共 '{'points'}' 个 '{'grain'}' 粒度数据点。` },
  );

  return (
    <section className="space-y-4" aria-label="用量仪表盘">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        {isAdmin ? (
          <Tabs
            className="w-fit"
            variant="segmented"
            value={resolvedScope}
            onValueChange={(next) => setScope(next === "global" ? "global" : "self")}
            tabs={[
              { value: "self", label: "个人" },
              { value: "global", label: "全局" },
            ]}
          />
        ) : null}
        <WindowSelector value={win} onChange={setWin} />
      </div>

      {isError ? (
        <DashboardStatus tone="danger">加载失败，请稍后重试</DashboardStatus>
      ) : !data ? (
        <DashboardStatus>加载中…</DashboardStatus>
      ) : !data.available ? (
        <DashboardStatus>数据同步中</DashboardStatus>
      ) : (
        <>
          {resolvedScope === "global" ? <AlertPanel alerts={alertsFromSummary(data.summary)} /> : null}
          <KpiBand kpi={data.kpi} />
          {data.grainFallback ? <p className="mb-3 text-xs text-kumo-subtle">已自动调整为推荐粒度</p> : null}
          <Panel title={resolvedScope === "global" ? "团队消费趋势" : "消费趋势"}>
            {data.empty ? (
              <DashboardStatus>该时间段暂无数据</DashboardStatus>
            ) : (
              <TrendChart series={trendSeries} ariaLabel={trendAriaLabel} />
            )}
          </Panel>
          {resolvedScope === "global" ? (
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
              <Panel title="用户消费排行">
                <RankBar rows={rankRows} />
              </Panel>
              <Panel title="模型使用分布">
                <ModelDonut slices={data.models.map((model) => ({ model: model.model, value: model.spend }))} />
              </Panel>
            </div>
          ) : (
            <Panel title="常用模型占比">
              <ModelDonut slices={data.models.map((model) => ({ model: model.model, value: model.spend }))} />
            </Panel>
          )}
          {resolvedScope === "global" ? <GlobalUserDetails /> : null}
        </>
      )}
    </section>
  );
}
