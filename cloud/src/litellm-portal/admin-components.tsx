import { Badge } from "@cloudflare/kumo/components/badge";
import { Banner } from "@cloudflare/kumo/components/banner";
import { Button } from "@cloudflare/kumo/components/button";
import { Collapsible } from "@cloudflare/kumo/components/collapsible";
import { DropdownMenu } from "@cloudflare/kumo/components/dropdown";
import { Empty } from "@cloudflare/kumo/components/empty";
import { Grid, GridItem } from "@cloudflare/kumo/components/grid";
import { LayerCard } from "@cloudflare/kumo/components/layer-card";
import { Loader, SkeletonLine } from "@cloudflare/kumo/components/loader";
import { Pagination } from "@cloudflare/kumo/components/pagination";
import { Table } from "@cloudflare/kumo/components/table";
import { Text } from "@cloudflare/kumo/components/text";
import { Tooltip } from "@cloudflare/kumo/components/tooltip";
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { UsageTimeseries } from "./chart";
import { fmt, fmtInt } from "./lib/format";

type UsageWindowOption = {
  key: string;
  label: string;
};

type PortalConfig = {
  usageWindows?: Record<string, UsageWindowOption[]>;
  defaultUsageWindows?: Record<string, string>;
};

type UsageWindowSelection = {
  grain: string;
  windowKey: string;
  label: string;
};

type UsagePreset = UsageWindowSelection & {
  durationMs: number;
};

type GrainMode = "auto" | string;

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const WEEK_MS = 7 * DAY_MS;
const MONTH_MS = 30 * DAY_MS;
const RANGE_MATCH_TOLERANCE = 0.2;

const fallbackUsageWindows: Record<string, UsageWindowOption[]> = {
  minute: [{ key: "6h", label: "近 6 小时" }],
  hour: [{ key: "48h", label: "近 48 小时" }],
  day: [{ key: "30d", label: "近 30 天" }],
  month: [{ key: "12mo", label: "近 12 个月" }],
};

const fallbackDefaultUsageWindows: Record<string, string> = {
  minute: "6h",
  hour: "48h",
  day: "30d",
  month: "12mo",
};

const usageGrainLabels: Record<string, string> = {
  minute: "分钟",
  hour: "小时",
  day: "天",
  month: "月",
};

function portalConfig(): Required<PortalConfig> {
  const config = typeof window !== "undefined" ? window.__PORTAL_CONFIG : undefined;
  return {
    usageWindows: config?.usageWindows ?? fallbackUsageWindows,
    defaultUsageWindows: config?.defaultUsageWindows ?? fallbackDefaultUsageWindows,
  };
}

function text(value: unknown): string {
  return value == null || value === "" ? "—" : String(value);
}

function StatTile({
  accent,
  label,
  children,
}: {
  accent: "info" | "brand" | "success" | "warning";
  label: string;
  children: React.ReactNode;
}) {
  const dot = accent === "brand"
    ? "bg-kumo-brand"
    : accent === "success"
      ? "bg-kumo-success"
      : accent === "warning"
        ? "bg-kumo-warning"
        : "bg-kumo-info";
  return (
    <LayerCard className="p-6">
      <div className="flex items-center gap-2">
        <span className={`inline-block h-2 w-2 rounded-full ${dot}`} />
        <Text variant="secondary" size="xs" className="font-semibold uppercase tracking-wider">{label}</Text>
      </div>
      {children}
    </LayerCard>
  );
}

function usageWindowDuration(windowKey: string): number | null {
  const match = /^(\d+)(h|d|mo)$/.exec(windowKey);
  if (!match) return null;
  const amount = Number(match[1]);
  if (!Number.isFinite(amount)) return null;
  if (match[2] === "h") return amount * HOUR_MS;
  if (match[2] === "d") return amount * DAY_MS;
  return amount * MONTH_MS;
}

function defaultWindowFor(grain: string, config: Required<PortalConfig>): string {
  return config.defaultUsageWindows[grain] ?? config.usageWindows[grain]?.[0]?.key ?? "30d";
}

function usageWindowPresets(config: Required<PortalConfig>): UsagePreset[] {
  return Object.entries(config.usageWindows).flatMap(([grain, windows]) =>
    windows.map((window) => ({
      grain,
      windowKey: window.key,
      label: window.label,
      durationMs: usageWindowDuration(window.key) ?? DAY_MS,
    })),
  );
}

function presetForWindow(windowKey: string, config: Required<PortalConfig>): UsagePreset | undefined {
  return usageWindowPresets(config).find((preset) => preset.windowKey === windowKey);
}

function supportsWindowForGrain(grain: string, windowKey: string, config: Required<PortalConfig>): boolean {
  return Boolean(config.usageWindows[grain]?.some((window) => window.key === windowKey));
}

function selectionForRange(from: number, to: number, config: Required<PortalConfig>): UsageWindowSelection | null {
  const selectedMs = Math.abs(to - from);
  if (!Number.isFinite(selectedMs) || selectedMs <= 0) return null;
  const candidates = usageWindowPresets(config);
  let best: UsagePreset | null = null;
  let bestDelta = Number.POSITIVE_INFINITY;
  for (const preset of candidates) {
    const delta = Math.abs(preset.durationMs - selectedMs) / preset.durationMs;
    if (delta < bestDelta) {
      best = preset;
      bestDelta = delta;
    }
  }
  return best && bestDelta <= RANGE_MATCH_TOLERANCE
    ? { grain: best.grain, windowKey: best.windowKey, label: best.label }
    : null;
}

function controlPillClass(active: boolean, disabled = false): string {
  if (disabled) {
    return "rounded-full border border-kumo-line px-3 py-1.5 text-sm text-kumo-disabled opacity-60";
  }
  return active
    ? "rounded-full bg-kumo-brand px-3 py-1.5 text-sm font-semibold text-white shadow-sm"
    : "rounded-full border border-kumo-line px-3 py-1.5 text-sm font-medium text-kumo-subtle transition-colors hover:border-kumo-brand hover:text-kumo-brand";
}

function MetricTile({ label, value, loading = false }: { label: string; value: string; loading?: boolean }) {
  return (
    <div className="rounded-lg bg-kumo-recessed p-5 transition-colors hover:bg-kumo-tint">
      <Text variant="secondary" size="xs">{label}</Text>
      {loading ? (
        <SkeletonLine className="mt-3" minWidth={96} maxWidth={150} blockHeight={24} />
      ) : (
        <Text variant="mono" size="lg" as="p" className="mt-3 font-semibold">{value}</Text>
      )}
    </div>
  );
}

function UsageSummary({ data, loading }: { data: UsageTimeseries | null; loading: boolean }) {
  const totals = data?.totals;
  const source = data?.source === "spend_logs_v2"
    ? "实时请求日志"
    : data?.source === "spend_logs_v2_global"
      ? "全局请求日志"
      : data
        ? "LiteLLM 日聚合"
        : "—";
  return (
    <div className="grid grid-cols-2 gap-4 md:grid-cols-3">
      <MetricTile label="总 Tokens" value={fmtInt(totals?.totalTokens)} loading={loading} />
      <MetricTile label="Prompt" value={fmtInt(totals?.promptTokens)} loading={loading} />
      <MetricTile label="Completion" value={fmtInt(totals?.completionTokens)} loading={loading} />
      <MetricTile label="请求数" value={fmtInt(totals?.requests)} loading={loading} />
      <MetricTile label="花费" value={fmt(totals?.spend)} loading={loading} />
      <MetricTile label="数据来源" value={source} loading={loading} />
    </div>
  );
}

function UsageBucketsTable({ data, loading }: { data: UsageTimeseries | null; loading: boolean }) {
  if (loading) {
    return (
      <div className="space-y-3 p-1" aria-live="polite">
        {Array.from({ length: 4 }, (_, index) => (
          <SkeletonLine key={index} minWidth={220} maxWidth={520} blockHeight={18} />
        ))}
      </div>
    );
  }

  const buckets = data?.buckets?.slice(-10).reverse() ?? [];
  if (buckets.length === 0) {
    return <Empty size="sm" title="暂无用量数据" />;
  }

  return (
    <Table className="w-full text-left text-sm text-kumo-default">
      <Table.Header>
        <Table.Row className="border-b border-kumo-line">
          <Table.Head className="pb-3 pr-3 text-xs font-semibold uppercase tracking-wider text-kumo-subtle">时间</Table.Head>
          <Table.Head className="pb-3 pr-3 text-right text-xs font-semibold uppercase tracking-wider text-kumo-subtle">Tokens</Table.Head>
          <Table.Head className="pb-3 pr-3 text-right text-xs font-semibold uppercase tracking-wider text-kumo-subtle">请求</Table.Head>
          <Table.Head className="pb-3 pr-3 text-right text-xs font-semibold uppercase tracking-wider text-kumo-subtle">花费</Table.Head>
        </Table.Row>
      </Table.Header>
      <Table.Body>
        {buckets.map((bucket) => {
          const isZero = Number(bucket.totalTokens || 0) === 0 && Number(bucket.requests || 0) === 0 && Number(bucket.spend || 0) === 0;
          return (
            <Table.Row key={bucket.start ?? bucket.label} className={`border-b border-kumo-fill transition-colors hover:bg-kumo-tint${isZero ? " opacity-40" : ""}`}>
              <Table.Cell className="py-3 pr-3 text-kumo-default">{bucket.label}</Table.Cell>
              <Table.Cell className="py-3 pr-3 text-right font-mono text-kumo-default">{fmtInt(bucket.totalTokens)}</Table.Cell>
              <Table.Cell className="py-3 pr-3 text-right font-mono text-kumo-default">{fmtInt(bucket.requests)}</Table.Cell>
              <Table.Cell className="py-3 pr-3 text-right font-mono text-kumo-default">{fmt(bucket.spend)}</Table.Cell>
            </Table.Row>
          );
        })}
      </Table.Body>
    </Table>
  );
}

function TopModels({ data, loading }: { data: UsageTimeseries | null; loading: boolean }) {
  if (loading) {
    return (
      <div className="flex flex-col gap-3">
        {Array.from({ length: 3 }, (_, index) => (
          <div key={index} className="rounded-lg bg-kumo-recessed p-5">
            <SkeletonLine minWidth={120} maxWidth={220} blockHeight={18} />
            <SkeletonLine className="mt-3" minWidth={180} maxWidth={260} blockHeight={14} />
          </div>
        ))}
      </div>
    );
  }

  const models = data?.topModels ?? [];
  if (models.length === 0) {
    return <Text variant="secondary">暂无模型用量拆分。</Text>;
  }

  return (
    <div className="flex flex-col gap-3">
      {models.map((model) => (
        <div key={model.model} className="rounded-lg bg-kumo-recessed p-5 transition-colors hover:bg-kumo-tint">
          <Text variant="mono" as="p" className="truncate font-semibold">{model.model}</Text>
          <Text variant="secondary" size="xs" as="p" className="mt-2">
            {fmt(model.spend)} · {fmtInt(model.totalTokens)} tokens · {fmtInt(model.requests)} 请求
          </Text>
        </div>
      ))}
    </div>
  );
}

const LazyUsageChart = React.lazy(async () => {
  const module = await import("./chart");
  return { default: module.UsageChart };
});

function UsageChartFallback() {
  return (
    <div className="flex w-full items-center justify-center py-12" aria-live="polite">
      <Loader aria-label="正在加载用量图表" />
    </div>
  );
}

type PortalRole = "admin" | "user" | "none";

type AdminUsersResponse = {
  users: Array<{
    userId: string;
    email: string;
    spend: number | null;
    maxBudget: number | null;
    teamIds: string[];
    role: string | null;
  }>;
  totalCount: number;
  page: number;
  size: number;
};

type AdminTeam = {
  id: string;
  alias: string | null;
  models: string[];
  spend: number | null;
  tpmLimit: number | null;
  rpmLimit: number | null;
};

type AdminTeamsResponse = {
  teams: AdminTeam[];
};

type AdminAuditEvent = {
  id: string;
  createdAt: string | null;
  action: string;
  actorUserId: string | null;
  actorUserEmail: string | null;
  objectType: string | null;
  objectId: string | null;
};

type AdminAuditResponse = {
  events: AdminAuditEvent[];
  totalCount: number;
  page: number;
  size: number;
};

type AdminSummary = {
  userCount?: number | null;
  sampledUserCount?: number | null;
  limited?: boolean;
  teamCount?: number | null;
  adminCount?: number | null;
  unmanagedRoleCount?: number | null;
  noTeamUserCount?: number | null;
  overBudgetUserCount?: number | null;
  overBudgetTeamCount?: number | null;
  riskCount?: number | null;
  totalSpend?: number | null;
  teamSpend?: number | null;
  totalBudget?: number | null;
};

const ADMIN_PAGE_SIZE = 50;

function AdminLoadingSkeleton() {
  return (
    <div className="space-y-3 p-6" aria-live="polite">
      {Array.from({ length: 4 }, (_, index) => (
        <SkeletonLine key={index} minWidth={260} maxWidth={760} blockHeight={20} />
      ))}
    </div>
  );
}

function AdminErrorBanner({ message }: { message: string }) {
  return (
    <div className="p-6">
      <Banner variant="error" title="数据加载失败" description={message} />
    </div>
  );
}

function AdminPager({
  page,
  setPage,
  totalCount,
  perPage,
}: {
  page: number;
  setPage: (next: number) => void;
  totalCount: number;
  perPage: number;
}) {
  if (totalCount <= perPage) return null;
  return (
    <Pagination
      className="border-t border-kumo-line px-6 py-4"
      controls="simple"
      page={page}
      setPage={setPage}
      perPage={perPage}
      totalCount={totalCount}
      labels={{
        navigation: "分页",
        firstPage: "首页",
        previousPage: "上一页",
        nextPage: "下一页",
        lastPage: "末页",
        pageNumber: "页码",
        pageSize: "每页条数",
      }}
    />
  );
}

function normalizeAdminSummary(value: unknown): AdminSummary {
  return value && typeof value === "object" ? value as AdminSummary : {};
}

export function AdminHeroStats() {
  const [summary, setSummary] = useState<AdminSummary>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    fetch("/api/admin/summary", {
      signal: controller.signal,
      headers: { "content-type": "application/json" },
    })
      .then(async (response) => {
        const body = await response.json().catch(() => ({}));
        if (!response.ok) {
          throw new Error(typeof body.error === "string" ? body.error : "全局概览加载失败");
        }
        return normalizeAdminSummary(body);
      })
      .then((body) => {
        setSummary(body);
        setError(null);
      })
      .catch((fetchError: unknown) => {
        if (fetchError instanceof DOMException && fetchError.name === "AbortError") return;
        setSummary({});
        setError(fetchError instanceof Error ? fetchError.message : "全局概览加载失败");
      })
      .finally(() => setLoading(false));

    return () => controller.abort();
  }, []);

  const sampledText = summary.limited
    ? `已采样 ${fmtInt(summary.sampledUserCount)} / 共 ${fmtInt(summary.userCount)} 用户`
    : `覆盖 ${fmtInt(summary.sampledUserCount ?? summary.userCount)} 个用户`;

  return (
    <div className="space-y-4">
      {error ? (
        <Banner variant="error" title="全局概览加载失败" description={error} />
      ) : null}
      <Grid variant="4up" gap="lg" aria-label="全局管理概览">
        <GridItem>
          <StatTile accent="info" label="全局账户">
            {loading ? (
              <SkeletonLine className="mt-4" minWidth={96} maxWidth={160} blockHeight={32} />
            ) : (
              <>
                <Text variant="heading1" as="p" className="mt-4 leading-tight">
                  {fmtInt(summary.userCount)}
                </Text>
                <Text variant="secondary" as="p" className="mt-3">
                  {fmtInt(summary.adminCount)} 个管理员 · {fmtInt(summary.unmanagedRoleCount)} 个未映射角色
                </Text>
              </>
            )}
          </StatTile>
        </GridItem>
        <GridItem>
          <StatTile accent="brand" label="全局花费">
            {loading ? (
              <SkeletonLine className="mt-4" minWidth={110} maxWidth={180} blockHeight={32} />
            ) : (
              <>
                <Text variant="heading1" as="p" className="mt-4 leading-tight">{fmt(summary.totalSpend)}</Text>
                <Text variant="secondary" as="p" className="mt-3">
                  预算 {summary.totalBudget == null ? "—" : fmt(summary.totalBudget)} · 团队花费 {fmt(summary.teamSpend)}
                </Text>
              </>
            )}
          </StatTile>
        </GridItem>
        <GridItem>
          <StatTile accent="success" label="资源覆盖">
            {loading ? (
              <SkeletonLine className="mt-4" minWidth={96} maxWidth={160} blockHeight={32} />
            ) : (
              <>
                <Text variant="heading1" as="p" className="mt-4 leading-tight">
                  {fmtInt(summary.teamCount)}
                </Text>
                <Text variant="secondary" as="p" className="mt-3">
                  {fmtInt(summary.noTeamUserCount)} 个用户未关联团队
                </Text>
              </>
            )}
          </StatTile>
        </GridItem>
        <GridItem>
          <StatTile accent="warning" label="风险雷达">
            {loading ? (
              <SkeletonLine className="mt-4" minWidth={96} maxWidth={160} blockHeight={32} />
            ) : (
              <>
                <Text variant="heading1" as="p" className="mt-4 leading-tight">
                  {fmtInt(summary.riskCount)}
                </Text>
                <div className="mt-3 flex flex-wrap items-center gap-2">
                  <Text variant="secondary">{fmtInt(Number(summary.overBudgetUserCount || 0) + Number(summary.overBudgetTeamCount || 0))} 个超预算对象</Text>
                  {summary.limited ? <Badge variant="warning">样本视图</Badge> : null}
                </div>
              </>
            )}
          </StatTile>
        </GridItem>
      </Grid>
      {!loading ? (
        <p className="text-xs text-kumo-subtle">{sampledText}，风险项由预算、角色映射和团队覆盖情况计算。</p>
      ) : null}
    </div>
  );
}

// TODO(CONTRABASS-3 follow-up): Migrate AdminUsersTable to a dedicated useAdminUsers() RPC hook.
export function AdminUsersTable() {
  const [data, setData] = useState<AdminUsersResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(1);
  const requestIdRef = useRef(0);

  useEffect(() => {
    const controller = new AbortController();
    const requestId = ++requestIdRef.current;
    setLoading(true);
    setError(null);

    const params = new URLSearchParams({ page: String(page), size: String(ADMIN_PAGE_SIZE) });
    fetch(`/api/admin/users?${params.toString()}`, {
      signal: controller.signal,
      headers: { "content-type": "application/json" },
    })
      .then(async (response) => {
        const body = await response.json().catch(() => ({}));
        if (!response.ok) {
          throw new Error(typeof body.error === "string" ? body.error : "全员账户加载失败");
        }
        return body as AdminUsersResponse;
      })
      .then((body) => {
        if (requestId !== requestIdRef.current) return;
        setData(body);
        setError(null);
      })
      .catch((fetchError: unknown) => {
        if (fetchError instanceof DOMException && fetchError.name === "AbortError") return;
        if (requestId !== requestIdRef.current) return;
        setData(null);
        setError(fetchError instanceof Error ? fetchError.message : "全员账户加载失败");
      })
      .finally(() => {
        if (requestId === requestIdRef.current) setLoading(false);
      });

    return () => controller.abort();
  }, [page]);

  return (
    <div>
      {loading ? (
        <AdminLoadingSkeleton />
      ) : error ? (
        <AdminErrorBanner message={error} />
      ) : !data || data.users.length === 0 ? (
        <Empty size="sm" title="暂无用户数据" />
      ) : (
        <div className="overflow-x-auto">
          <Table className="w-full text-left text-sm text-kumo-default">
            <Table.Header>
              <Table.Row className="border-b border-kumo-line">
                <Table.Head className="bg-kumo-base p-5 text-xs font-semibold uppercase tracking-wider text-kumo-subtle">邮箱</Table.Head>
                <Table.Head className="bg-kumo-base p-5 text-xs font-semibold uppercase tracking-wider text-kumo-subtle">角色</Table.Head>
                <Table.Head className="bg-kumo-base p-5 text-right text-xs font-semibold uppercase tracking-wider text-kumo-subtle">累计消费</Table.Head>
                <Table.Head className="bg-kumo-base p-5 text-right text-xs font-semibold uppercase tracking-wider text-kumo-subtle">团队数</Table.Head>
                <Table.Head className="bg-kumo-base p-5 text-right text-xs font-semibold uppercase tracking-wider text-kumo-subtle">最大预算</Table.Head>
                <Table.Head className="bg-kumo-base p-5 text-xs font-semibold uppercase tracking-wider text-kumo-subtle"><span className="sr-only">操作</span></Table.Head>
              </Table.Row>
            </Table.Header>
            <Table.Body>
              {data.users.map((user) => (
                <Table.Row key={user.userId} className="border-b border-kumo-fill transition-colors hover:bg-kumo-tint">
                  <Table.Cell className="py-3 pl-5 pr-3 font-mono text-kumo-default">
                    <Tooltip content={user.email}>
                      <span className="block max-w-[200px] truncate">{text(user.email)}</span>
                    </Tooltip>
                  </Table.Cell>
                  <Table.Cell className="py-3 pr-3 text-kumo-subtle">{text(user.role)}</Table.Cell>
                  <Table.Cell className="py-3 pr-3 text-right font-mono text-kumo-default">{fmt(user.spend)}</Table.Cell>
                  <Table.Cell className="py-3 pr-3 text-right font-mono text-kumo-default">{fmtInt(user.teamIds.length)}</Table.Cell>
                  <Table.Cell className="py-3 pr-3 text-right font-mono text-kumo-default">{user.maxBudget == null ? "—" : fmt(user.maxBudget)}</Table.Cell>
                  <Table.Cell className="py-3 pr-5 text-right">
                    <DropdownMenu>
                      <DropdownMenu.Trigger aria-label="更多操作" className="rounded px-2 py-1 text-sm text-kumo-subtle hover:bg-kumo-fill hover:text-kumo-default">
                        ⋯
                      </DropdownMenu.Trigger>
                      <DropdownMenu.Content>
                        <DropdownMenu.Item onClick={() => {}}>查看详情</DropdownMenu.Item>
                      </DropdownMenu.Content>
                    </DropdownMenu>
                  </Table.Cell>
                </Table.Row>
              ))}
            </Table.Body>
          </Table>
        </div>
      )}
      {data ? (
        <AdminPager
          page={page}
          setPage={setPage}
          totalCount={data.totalCount}
          perPage={ADMIN_PAGE_SIZE}
        />
      ) : null}
    </div>
  );
}

// TODO(CONTRABASS-3 follow-up): Migrate AdminTeamsTable to a dedicated useAdminTeams() RPC hook.
export function AdminTeamsTable() {
  const [data, setData] = useState<AdminTeamsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const controller = new AbortController();
    fetch("/api/admin/teams", {
      signal: controller.signal,
      headers: { "content-type": "application/json" },
    })
      .then(async (response) => {
        const body = await response.json().catch(() => ({}));
        if (!response.ok) {
          throw new Error(typeof body.error === "string" ? body.error : "全部团队加载失败");
        }
        return body as AdminTeamsResponse;
      })
      .then((body) => setData(body))
      .catch((fetchError: unknown) => {
        if (fetchError instanceof DOMException && fetchError.name === "AbortError") return;
        setError(fetchError instanceof Error ? fetchError.message : "全部团队加载失败");
      })
      .finally(() => setLoading(false));

    return () => controller.abort();
  }, []);

  return (
    <div>
      {loading ? (
        <AdminLoadingSkeleton />
      ) : error ? (
        <AdminErrorBanner message={error} />
      ) : !data || data.teams.length === 0 ? (
        <Empty size="sm" title="暂无团队数据" />
      ) : (
        <div className="overflow-x-auto">
          <Table className="w-full text-left text-sm text-kumo-default">
            <Table.Header>
              <Table.Row className="border-b border-kumo-line">
                <Table.Head className="bg-kumo-base p-5 text-xs font-semibold uppercase tracking-wider text-kumo-subtle">ID</Table.Head>
                <Table.Head className="bg-kumo-base p-5 text-xs font-semibold uppercase tracking-wider text-kumo-subtle">别名</Table.Head>
                <Table.Head className="bg-kumo-base p-5 text-xs font-semibold uppercase tracking-wider text-kumo-subtle">可用模型</Table.Head>
                <Table.Head className="bg-kumo-base p-5 text-right text-xs font-semibold uppercase tracking-wider text-kumo-subtle">消费</Table.Head>
                <Table.Head className="bg-kumo-base p-5 text-right text-xs font-semibold uppercase tracking-wider text-kumo-subtle">TPM</Table.Head>
                <Table.Head className="bg-kumo-base p-5 text-right text-xs font-semibold uppercase tracking-wider text-kumo-subtle">RPM</Table.Head>
                <Table.Head className="bg-kumo-base p-5 text-xs font-semibold uppercase tracking-wider text-kumo-subtle"><span className="sr-only">操作</span></Table.Head>
              </Table.Row>
            </Table.Header>
            <Table.Body>
              {data.teams.map((team) => (
                <Table.Row key={team.id} className="border-b border-kumo-fill transition-colors hover:bg-kumo-tint">
                  <Table.Cell className="py-3 pl-5 pr-3 font-mono text-xs text-kumo-subtle">
                    <Tooltip content={team.id}>
                      <span className="block max-w-[120px] truncate">{text(team.id)}</span>
                    </Tooltip>
                  </Table.Cell>
                  <Table.Cell className="py-3 pr-3 text-kumo-default">{text(team.alias)}</Table.Cell>
                  <Table.Cell className="py-3 pr-3 text-kumo-subtle">{team.models.length > 0 ? team.models.join(", ") : "—"}</Table.Cell>
                  <Table.Cell className="py-3 pr-3 text-right font-mono text-kumo-default">{fmt(team.spend)}</Table.Cell>
                  <Table.Cell className="py-3 pr-3 text-right font-mono text-kumo-default">{team.tpmLimit == null ? "—" : fmtInt(team.tpmLimit)}</Table.Cell>
                  <Table.Cell className="py-3 pr-3 text-right font-mono text-kumo-default">{team.rpmLimit == null ? "—" : fmtInt(team.rpmLimit)}</Table.Cell>
                  <Table.Cell className="py-3 pr-5 text-right">
                    <DropdownMenu>
                      <DropdownMenu.Trigger aria-label="更多操作" className="rounded px-2 py-1 text-sm text-kumo-subtle hover:bg-kumo-fill hover:text-kumo-default">
                        ⋯
                      </DropdownMenu.Trigger>
                      <DropdownMenu.Content>
                        <DropdownMenu.Item onClick={() => {}}>查看详情</DropdownMenu.Item>
                      </DropdownMenu.Content>
                    </DropdownMenu>
                  </Table.Cell>
                </Table.Row>
              ))}
            </Table.Body>
          </Table>
        </div>
      )}
    </div>
  );
}

// TODO(CONTRABASS-3 follow-up): Migrate AdminGlobalUsage to a dedicated useAdminUsage() RPC hook.
export function AdminGlobalUsage() {
  const config = useMemo(() => portalConfig(), []);
  const grains = useMemo(() => Object.keys(config.usageWindows), [config]);
  const presets = useMemo(() => usageWindowPresets(config), [config]);
  const defaultPreset = useMemo(() => {
    const defaultDayWindow = defaultWindowFor("day", config);
    return presetForWindow(defaultDayWindow, config) ?? presets.find((p) => p.grain === "day") ?? presets[0];
  }, [config, presets]);

  const [grainMode, setGrainMode] = useState<GrainMode>("auto");
  const [grain, setGrain] = useState(defaultPreset?.grain ?? "day");
  const [windowKey, setWindowKey] = useState(defaultPreset?.windowKey ?? defaultWindowFor("day", config));
  const [data, setData] = useState<UsageTimeseries | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [rangeHint, setRangeHint] = useState<string | null>(null);
  const requestIdRef = useRef(0);

  const activePreset = useMemo(
    () => presets.find((p) => p.windowKey === windowKey) ?? defaultPreset,
    [defaultPreset, presets, windowKey],
  );
  const selectedWindowLabel = activePreset?.label ?? "当前窗口";
  const grainStatus = `${grainMode === "auto" ? "自动粒度" : "手动粒度"}：${usageGrainLabels[grain] ?? grain}`;

  const applyPreset = useCallback((preset: UsageWindowSelection, source: "click" | "brush" = "click") => {
    const manualGrain = grainMode !== "auto" ? grainMode : null;
    const canKeepManual = manualGrain ? supportsWindowForGrain(manualGrain, preset.windowKey, config) : false;
    const nextGrain = canKeepManual && manualGrain ? manualGrain : preset.grain;
    const nextMode: GrainMode = canKeepManual && manualGrain ? manualGrain : "auto";

    setGrainMode(nextMode);
    setGrain(nextGrain);
    setWindowKey(preset.windowKey);

    const nextStatus = `${nextMode === "auto" ? "自动粒度" : "手动粒度"}：${usageGrainLabels[nextGrain] ?? nextGrain}`;
    if (source === "brush") {
      setRangeHint(`已按图表选择切换到 ${preset.label} · ${nextStatus}`);
      return;
    }
    if (manualGrain && !canKeepManual) {
      setRangeHint(`${preset.label} 不支持手动粒度「${usageGrainLabels[manualGrain] ?? manualGrain}」，已切回 ${nextStatus}`);
      return;
    }
    setRangeHint(null);
  }, [config, grainMode]);

  const handleAutoGrainClick = useCallback(() => {
    const preset = activePreset;
    if (!preset) return;
    setGrainMode("auto");
    setGrain(preset.grain);
    setRangeHint(null);
  }, [activePreset]);

  const handleManualGrainClick = useCallback((nextGrain: string) => {
    if (!supportsWindowForGrain(nextGrain, windowKey, config)) return;
    setGrainMode(nextGrain);
    setGrain(nextGrain);
    setRangeHint(null);
  }, [config, windowKey]);

  const handleChartRangeChange = useCallback((from: number, to: number) => {
    const selection = selectionForRange(from, to, config);
    if (!selection) {
      setRangeHint("图表选择已捕获；请选择更接近预设的范围以自动取数。");
      return;
    }
    applyPreset(selection, "brush");
  }, [applyPreset, config]);

  useEffect(() => {
    if (!grain || !windowKey) return;
    const controller = new AbortController();
    const requestId = ++requestIdRef.current;
    setLoading(true);
    setError(null);

    const params = new URLSearchParams({ grain, window: windowKey });
    fetch(`/api/admin/usage/timeseries?${params.toString()}`, {
      signal: controller.signal,
      headers: { "content-type": "application/json" },
    })
      .then(async (response) => {
        const body = await response.json().catch(() => ({}));
        if (!response.ok) {
          throw new Error(typeof body.error === "string" ? body.error : "全局用量加载失败");
        }
        return body as UsageTimeseries;
      })
      .then((body) => {
        if (requestId !== requestIdRef.current) return;
        setData(body);
        setError(null);
      })
      .catch((fetchError: unknown) => {
        if (fetchError instanceof DOMException && fetchError.name === "AbortError") return;
        if (requestId !== requestIdRef.current) return;
        setData(null);
        setError(fetchError instanceof Error ? fetchError.message : "全局用量加载失败");
      })
      .finally(() => {
        if (requestId === requestIdRef.current) setLoading(false);
      });

    return () => controller.abort();
  }, [grain, windowKey]);

  const windowText = data
    ? `${data.windowLabel} · ${usageGrainLabels[data.grain] ?? data.grain} · ${text(data.start).slice(0, 10)} 至 ${text(data.end).slice(0, 10)}${data.limited ? " · 已达到分页上限" : ""}`
    : `全局用量沿用个人视图的预设和粒度规则。当前：${selectedWindowLabel} · ${grainStatus}`;

  return (
    <div aria-busy={loading}>
      <div className="border-b border-kumo-line bg-kumo-elevated p-6">
        <div className="space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <Text variant="heading3" as="p">全局 Token 用量趋势</Text>
            <span className="rounded-full bg-kumo-info-tint px-2.5 py-1 text-xs font-semibold text-kumo-info">Brush native</span>
            <span className="rounded-full bg-kumo-success-tint px-2.5 py-1 text-xs font-semibold text-kumo-success">{grainStatus}</span>
          </div>
          <Text variant="secondary" as="p" className="leading-relaxed">{windowText}</Text>
          {rangeHint ? (
            <p className="text-xs font-medium text-kumo-brand" aria-live="polite">{rangeHint}</p>
          ) : null}
        </div>
        <div className="mt-5 grid gap-4 lg:grid-cols-[1fr_auto]" aria-label="全局用量筛选">
          <div className="space-y-2">
            <Text variant="secondary" size="xs" as="p" className="font-semibold uppercase tracking-wider">时间范围预设</Text>
            <div className="flex flex-wrap gap-2" role="group" aria-label="时间范围预设">
              {presets.map((preset) => (
                <button
                  key={preset.windowKey}
                  type="button"
                  className={controlPillClass(preset.windowKey === windowKey)}
                  aria-pressed={preset.windowKey === windowKey}
                  onClick={() => applyPreset(preset)}
                >
                  {preset.label}
                </button>
              ))}
            </div>
          </div>
          <div className="space-y-2 xl:w-[380px]">
            <Text variant="secondary" size="xs" as="p" className="font-semibold uppercase tracking-wider">时间粒度</Text>
            <div className="flex flex-wrap gap-2" role="group" aria-label="时间粒度">
              <button
                type="button"
                className={controlPillClass(grainMode === "auto")}
                aria-pressed={grainMode === "auto"}
                onClick={handleAutoGrainClick}
              >
                自动
              </button>
              {grains.map((item) => {
                const disabled = !supportsWindowForGrain(item, windowKey, config);
                const disabledHint = disabled
                  ? `${selectedWindowLabel} 不支持${usageGrainLabels[item] ?? item}粒度`
                  : undefined;
                return (
                  <Tooltip key={item} content={disabledHint}>
                    <button
                      type="button"
                      className={controlPillClass(grainMode === item, disabled)}
                      aria-pressed={grainMode === item}
                      disabled={disabled}
                      onClick={() => handleManualGrainClick(item)}
                    >
                      {usageGrainLabels[item] ?? item}
                    </button>
                  </Tooltip>
                );
              })}
            </div>
          </div>
        </div>
      </div>
      <div className="grid grid-cols-1 md:grid-cols-[2fr_1fr]">
        <div className="space-y-8 p-8">
          {error ? (
            <Banner variant="error" title="全局用量加载失败" description={error} />
          ) : null}
          <UsageSummary data={data} loading={loading} />
          <React.Suspense fallback={<UsageChartFallback />}>
            <LazyUsageChart data={data} error={error} loading={loading} onTimeRangeChange={handleChartRangeChange} />
          </React.Suspense>
          <div className="overflow-x-auto">
            <UsageBucketsTable data={data} loading={loading} />
          </div>
        </div>
        <div className="border-t border-kumo-line p-8 md:border-l md:border-t-0">
          <Text bold as="p" className="mb-5">高频模型</Text>
          <TopModels data={data} loading={loading} />
        </div>
      </div>
      {activePreset ? (
        <p className="px-8 pb-6 text-xs text-kumo-subtle">
          数据来源：/api/admin/usage/timeseries · {activePreset.label} · {usageGrainLabels[grain] ?? grain}粒度
        </p>
      ) : null}
    </div>
  );
}

// TODO(CONTRABASS-3 follow-up): Migrate AdminAuditFeed to a dedicated useAdminAudit() RPC hook.
export function AdminAuditFeed() {
  const [data, setData] = useState<AdminAuditResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(1);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const requestIdRef = useRef(0);

  useEffect(() => {
    const controller = new AbortController();
    const requestId = ++requestIdRef.current;
    setLoading(true);
    setError(null);

    const params = new URLSearchParams({ page: String(page), size: String(ADMIN_PAGE_SIZE) });
    fetch(`/api/admin/audit?${params.toString()}`, {
      signal: controller.signal,
      headers: { "content-type": "application/json" },
    })
      .then(async (response) => {
        const body = await response.json().catch(() => ({}));
        if (!response.ok) {
          throw new Error(typeof body.error === "string" ? body.error : "审计日志加载失败");
        }
        return body as AdminAuditResponse;
      })
      .then((body) => {
        if (requestId !== requestIdRef.current) return;
        setData(body);
        setError(null);
      })
      .catch((fetchError: unknown) => {
        if (fetchError instanceof DOMException && fetchError.name === "AbortError") return;
        if (requestId !== requestIdRef.current) return;
        setData(null);
        setError(fetchError instanceof Error ? fetchError.message : "审计日志加载失败");
      })
      .finally(() => {
        if (requestId === requestIdRef.current) setLoading(false);
      });

    return () => controller.abort();
  }, [page]);

  const toggleRow = useCallback((id: string) => {
    setExpandedId((prev) => (prev === id ? null : id));
  }, []);

  return (
    <div>
      {loading ? (
        <AdminLoadingSkeleton />
      ) : error ? (
        <AdminErrorBanner message={error} />
      ) : !data || data.events.length === 0 ? (
        <Empty size="sm" title="暂无审计日志" />
      ) : (
        <div className="overflow-x-auto">
          <Table className="w-full text-left text-sm text-kumo-default">
            <Table.Header>
              <Table.Row className="border-b border-kumo-line">
                <Table.Head className="bg-kumo-base p-5 text-xs font-semibold uppercase tracking-wider text-kumo-subtle">创建时间</Table.Head>
                <Table.Head className="bg-kumo-base p-5 text-xs font-semibold uppercase tracking-wider text-kumo-subtle">操作</Table.Head>
                <Table.Head className="bg-kumo-base p-5 text-xs font-semibold uppercase tracking-wider text-kumo-subtle">操作者</Table.Head>
                <Table.Head className="bg-kumo-base p-5 text-xs font-semibold uppercase tracking-wider text-kumo-subtle">对象类型</Table.Head>
                <Table.Head className="bg-kumo-base p-5 text-xs font-semibold uppercase tracking-wider text-kumo-subtle">对象 ID</Table.Head>
                <Table.Head className="bg-kumo-base p-5 text-xs font-semibold uppercase tracking-wider text-kumo-subtle">详情</Table.Head>
                <Table.Head className="bg-kumo-base p-5 text-xs font-semibold uppercase tracking-wider text-kumo-subtle"><span className="sr-only">操作</span></Table.Head>
              </Table.Row>
            </Table.Header>
            <Table.Body>
              {data.events.map((event) => (
                <React.Fragment key={event.id}>
                  <Table.Row className="border-b border-kumo-fill transition-colors hover:bg-kumo-tint">
                    <Table.Cell className="py-3 pl-5 pr-3 font-mono text-xs text-kumo-subtle">{event.createdAt ? event.createdAt.slice(0, 19).replace("T", " ") : "—"}</Table.Cell>
                    <Table.Cell className="py-3 pr-3 text-kumo-default">{text(event.action)}</Table.Cell>
                    <Table.Cell className="py-3 pr-3 text-kumo-default">
                      <Tooltip content={event.actorUserEmail ?? event.actorUserId}>
                        <span className="block max-w-[160px] truncate">{text(event.actorUserEmail ?? event.actorUserId)}</span>
                      </Tooltip>
                    </Table.Cell>
                    <Table.Cell className="py-3 pr-3 text-kumo-subtle">{text(event.objectType)}</Table.Cell>
                    <Table.Cell className="py-3 pr-3 font-mono text-xs text-kumo-subtle">
                      <Tooltip content={event.objectId}>
                        <span className="block max-w-[120px] truncate">{text(event.objectId)}</span>
                      </Tooltip>
                    </Table.Cell>
                    <Table.Cell className="py-3 pr-3">
                      <button
                        type="button"
                        className="text-xs font-semibold text-kumo-brand hover:text-kumo-brand-hover"
                        onClick={() => toggleRow(event.id)}
                        aria-expanded={expandedId === event.id}
                      >
                        {expandedId === event.id ? "收起" : "展开"}
                      </button>
                    </Table.Cell>
                    <Table.Cell className="py-3 pr-5 text-right">
                      <DropdownMenu>
                        <DropdownMenu.Trigger aria-label="更多操作">
                          <Button variant="ghost" size="xs">⋯</Button>
                        </DropdownMenu.Trigger>
                        <DropdownMenu.Content>
                          <DropdownMenu.Item onClick={() => {}}>查看详情</DropdownMenu.Item>
                        </DropdownMenu.Content>
                      </DropdownMenu>
                    </Table.Cell>
                  </Table.Row>
                  {expandedId === event.id ? (
                    <Table.Row className="border-b border-kumo-fill bg-kumo-recessed">
                      <Table.Cell colSpan={7} className="px-5 py-4">
                        <div className="space-y-3 text-xs">
                          <div>
                            <Text variant="secondary" size="xs" className="mb-1 font-semibold uppercase tracking-wider">变更后</Text>
                            <pre className="overflow-x-auto rounded-lg bg-kumo-base p-3 font-mono text-kumo-default ring-1 ring-kumo-line">{JSON.stringify(event, null, 2)}</pre>
                          </div>
                        </div>
                      </Table.Cell>
                    </Table.Row>
                  ) : null}
                </React.Fragment>
              ))}
            </Table.Body>
          </Table>
        </div>
      )}
      {data ? (
        <AdminPager
          page={page}
          setPage={setPage}
          totalCount={data.totalCount}
          perPage={ADMIN_PAGE_SIZE}
        />
      ) : null}
    </div>
  );
}

export function AdminCard({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <LayerCard className="overflow-hidden p-0">
      <Collapsible.Root defaultOpen>
        <div className="flex items-center justify-between border-b border-kumo-line bg-kumo-elevated px-6 py-5">
          <Text variant="heading3" as="p">{title}</Text>
          <Collapsible.DefaultTrigger className="text-sm font-medium text-kumo-brand hover:text-kumo-brand-hover">
            <span className="sr-only">折叠或展开</span>
          </Collapsible.DefaultTrigger>
        </div>
        <Collapsible.Panel>
          {children}
        </Collapsible.Panel>
      </Collapsible.Root>
    </LayerCard>
  );
}

export function AdminSection({ role }: { role: PortalRole }) {
  if (role !== "admin") return null;

  return (
    <section className="space-y-8" aria-label="全局管理（只读）">
      <div className="flex flex-wrap items-center gap-3">
        <Text variant="heading2" as="h2">全局管理（只读）</Text>
        <Badge variant="secondary" className="rounded-full bg-kumo-warning-tint text-kumo-warning">仅管理员可见</Badge>
      </div>
      <AdminHeroStats />
      <AdminCard title="全局用量趋势">
        <AdminGlobalUsage />
      </AdminCard>
      <div className="space-y-4">
        <div>
          <Text variant="secondary" as="p" className="font-semibold uppercase tracking-wider">资源与权限</Text>
          <Text variant="secondary" as="p" className="mt-1">账户、团队和模型范围保持和个人视图相同的数据语言。</Text>
        </div>
        <AdminCard title="全员账户">
          <AdminUsersTable />
        </AdminCard>
        <AdminCard title="全部团队">
          <AdminTeamsTable />
        </AdminCard>
      </div>
      <div className="space-y-4">
        <div>
          <Text variant="secondary" as="p" className="font-semibold uppercase tracking-wider">审计与风险</Text>
          <Text variant="secondary" as="p" className="mt-1">用于核对近期变更和风险线索，当前保持只读。</Text>
        </div>
        <AdminCard title="审计日志">
        <AdminAuditFeed />
        </AdminCard>
      </div>
    </section>
  );
}

type TabKey = "user" | "admin";

let portalRolePromise: Promise<PortalRole> | null = null;
function fetchPortalRoleOnce(): Promise<PortalRole> {
  if (portalRolePromise) return portalRolePromise;
  portalRolePromise = fetch("/api/me", { headers: { "content-type": "application/json" } })
    .then(async (response): Promise<PortalRole> => {
      if (!response.ok) return "none";
      const body = await response.json().catch(() => ({}));
      if (body && (body.role === "admin" || body.role === "user" || body.role === "none")) {
        return body.role as PortalRole;
      }
      return "none";
    })
    .catch((): PortalRole => "none");
  return portalRolePromise;
}

function usePortalRole(initialRole?: PortalRole): { role: PortalRole; ready: boolean } {
  const [role, setRole] = useState<PortalRole>(initialRole ?? "none");
  const [ready, setReady] = useState(initialRole !== undefined);
  useEffect(() => {
    if (initialRole !== undefined) return;
    let cancelled = false;
    fetchPortalRoleOnce().then((next) => {
      if (cancelled) return;
      setRole(next);
      setReady(true);
    });
    return () => {
      cancelled = true;
    };
  }, [initialRole]);
  return { role, ready };
}

export function readTabFromHash(role: PortalRole): TabKey {
  void role;
  const hash = typeof window !== "undefined" ? window.location.hash : "";
  if (hash === "#admin") return "admin";
  if (hash === "#user") return "user";
  return "user";
}


export function PortalTabs({ tab, onSelect }: { tab: TabKey; onSelect: (next: TabKey) => void }) {
  return (
    <Tabs
      className="mb-10"
      variant="segmented"
      value={tab}
      onValueChange={(next) => onSelect(next as TabKey)}
      tabs={[
        { value: "user", label: "个人视图" },
        { value: "admin", label: "全局管理" },
      ]}
    />
  );
}

type AppProps = {
  initialData?: InitialDashboardData | null;
  role?: PortalRole;
  dehydratedState?: unknown;
};

function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 60_000,
        refetchOnWindowFocus: false,
      },
    },
  });
}

export function App({ initialData, role: initialRole, dehydratedState }: AppProps) {
  const [queryClient] = useState(createQueryClient);
  const { role, ready } = usePortalRole(initialRole);
  const [tab, setTab] = useState<TabKey>(() => readTabFromHash(initialRole ?? "none"));

  const handleTabSelect = useCallback((next: TabKey) => {
    setTab(next);
    if (typeof history !== "undefined") {
      history.replaceState(null, "", "#" + next);
    }
  }, []);

  const isAdmin = role === "admin";
  const showUserPanel = tab === "user" || !isAdmin;
  const showAdminPanel = isAdmin && tab === "admin";
  const platformName = initialData?.me?.company ?? "智云AI管理平台";

  return (
    <QueryClientProvider client={queryClient}>
      <HydrationBoundary state={dehydratedState}>
        <Toasty>
          <TooltipProvider delay={300}>
    <main className="container mx-auto px-4 py-10 lg:px-10 lg:py-16">
      <header className="mb-12 flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="space-y-4">
          <span className="inline-flex w-fit items-center rounded-full bg-kumo-info-tint/70 px-2.5 py-1 text-xs font-semibold text-kumo-info">Cloudflare Access 已保护</span>
          <div className="space-y-3">
            <Text variant="heading1" as="h1">{platformName}</Text>
            <Text variant="secondary" as="p" className="max-w-3xl leading-relaxed">面向智云团队的 AI 能力自助台：只读查看个人 API Key、团队可用模型、预算与近 30 天用量，数据权限自动绑定当前登录邮箱。</Text>
          </div>
        </div>
        <div id="header-actions-root" className="flex flex-wrap items-center gap-3 sm:self-auto">
          <HeaderActions />
        </div>
      </header>

      {ready && isAdmin && (
        <nav id="portal-tabs-root">
          <PortalTabs tab={tab} onSelect={handleTabSelect} />
        </nav>
      )}

      {showUserPanel && (
        <div id="user-panel">
          <div id="hero-stats-root" className="mb-14">
            <HeroStats />
          </div>

          <section id="usage-panel-root" className="mb-14">
            <UsagePanel />
          </section>

          <section className="mb-10 grid grid-cols-1 gap-5 md:grid-cols-[1fr_2fr]">
            <div id="teams-root">
              <TeamsAccessCard />
            </div>
            <div id="models-root">
              <ModelAccessCard />
            </div>
          </section>

          <div id="keys-root">
            <ApiKeysCard />
          </div>
        </div>
      )}

      {isAdmin && (
        <div id="admin-root" hidden={!showAdminPanel}>
          <AdminSection role={role} />
        </div>
      )}

      <div id="portal-error-root">
        <PortalErrorBanner initialData={initialData} />
      </div>
    </main>
          </TooltipProvider>
        </Toasty>
      </HydrationBoundary>
    </QueryClientProvider>
  );
}
