import { Badge } from "@cloudflare/kumo/components/badge";
import { Button } from "@cloudflare/kumo/components/button";
import { Collapsible } from "@cloudflare/kumo/components/collapsible";
import { Empty } from "@cloudflare/kumo/components/empty";
import { Grid, GridItem } from "@cloudflare/kumo/components/grid";
import { LayerCard } from "@cloudflare/kumo/components/layer-card";
import { Meter } from "@cloudflare/kumo/components/meter";
import { Surface } from "@cloudflare/kumo/components/surface";
import { Switch } from "@cloudflare/kumo/components/switch";
import { Table } from "@cloudflare/kumo/components/table";
import { Text } from "@cloudflare/kumo/components/text";
import { Toasty } from "@cloudflare/kumo/components/toast";
import { TooltipProvider } from "@cloudflare/kumo/components/tooltip";
import React, { useEffect, useMemo, useState } from "react";
import { PanelCard } from "./ui";
import { QueryClient, QueryClientProvider, HydrationBoundary } from "@tanstack/react-query";
import { fmt, fmtInt } from "./lib/format";
import { useDashboard } from "./hooks/use-dashboard";
import { applyThemePreference, useLegacyThemeMigration, usePreferences, useUpdatePreferences } from "./hooks/use-preferences";
import type { Dashboard } from "./schemas";
import { IdentityBar } from "./identity-bar";
import { UsageDashboard } from "./dashboard/views/usage-dashboard";
import {
  text, keyLabel, sourceLabel, modelBadgeColor, statusTone, budgetLabel,
  normalizeModelAccess, normalizeKeys, normalizeTeams,
  PREVIEW_LIMIT, PortalStats,
} from "./app/utils";
import { BudgetInfoPopover, BudgetBadge } from "./app/budget-badge";
import { ModelBadges, ModelsCell } from "./app/model-badges";
import { DeleteKeyButton } from "./app/delete-key-button";
import { CreateKeyButton } from "./app/create-key-button";
import { PortalErrorBanner } from "./app/portal-error-banner";
import { ApiKeysCard } from "./app/keys-card";

export type InitialDashboardData = Dashboard;

declare global {
  interface Window {
    __PORTAL_CONFIG?: import("./app/utils").PortalConfig;
    __INITIAL_DATA__?: InitialDashboardData;
  }
}

export function HeaderActions() {
  const { data: preferences } = usePreferences();
  const updatePreferences = useUpdatePreferences();
  const theme = preferences?.theme ?? "auto";
  const [resolvedMode, setResolvedMode] = useState<"dark" | "light">(() => initialResolvedTheme(theme));

  useEffect(() => {
    const syncTheme = () => {
      applyThemePreference(theme);
      setResolvedMode(resolvedTheme(theme));
    };
    syncTheme();
    if (theme !== "auto" || typeof window === "undefined") return;
    const media = window.matchMedia?.("(prefers-color-scheme: dark)");
    if (!media) return;
    media.addEventListener("change", syncTheme);
    return () => media.removeEventListener("change", syncTheme);
  }, [theme]);

  const isDark = resolvedMode === "dark";
  return (
    <>
      <Switch
        variant="neutral"
        controlFirst={false}
        checked={isDark}
        transitioning={updatePreferences.isPending}
        onCheckedChange={(next: boolean) => updatePreferences.mutate({ theme: next ? "dark" : "light" })}
        aria-label={isDark ? "切换浅色模式" : "切换深色模式"}
        label={isDark ? "深色" : "浅色"}
      />
      <Button
        variant="outline"
        type="button"
        aria-label="退出登录"
        onClick={() => { window.location.href = "/cdn-cgi/access/logout"; }}
      >
        退出登录
      </Button>
    </>
  );
}

function resolvedTheme(theme: "auto" | "dark" | "light"): "dark" | "light" {
  if (theme !== "auto") return theme;
  if (typeof window !== "undefined" && window.matchMedia?.("(prefers-color-scheme: dark)").matches) {
    return "dark";
  }
  if (typeof document !== "undefined" && document.documentElement.dataset.mode === "dark") {
    return "dark";
  }
  return "light";
}

function initialResolvedTheme(theme: "auto" | "dark" | "light"): "dark" | "light" {
  // Keep SSR and the client's first hydration render deterministic; browser
  // state is applied by HeaderActions' effect after hydration.
  return theme === "dark" ? "dark" : "light";
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

function statsFromDashboard(data: Dashboard | undefined): PortalStats {
  if (!data) return {};
  return {
    email: data.me?.email,
    litellmUserId: data.user?.litellmUserId,
    totalSpend: data.user?.totalSpend,
    maxBudget: data.user?.maxBudget,
    keyBudget: data.summary?.keyBudget ?? undefined,
    recentSpend: data.summary?.recentSpend,
    usageAvailable: data.usage?.available,
    requestCount: data.summary?.requestCount,
    totalTokens: data.summary?.totalTokens,
    modelCount: data.summary?.availableModelCount,
    keyCount: data.summary?.keyCount,
    teamCount: data.summary?.teamCount,
  };
}

export function HeroStats() {
  const { data } = useDashboard();
  const stats = statsFromDashboard(data);

  const email = text(stats.email);
  const recentDisplay = stats.usageAvailable ? fmt(stats.recentSpend) : "暂无数据";
  const budgetText = stats.maxBudget == null
    ? `预算 ${text(stats.keyBudget)}`
    : `预算 ${fmt(stats.maxBudget)}`;

  return (
    <Grid variant="4up" gap="lg">
      <GridItem>
        <StatTile accent="info" label="当前身份">
          <Text variant="heading2" as="p" className="mt-4 truncate">{email}</Text>
          <Text variant="mono" as="p" className="mt-3 truncate">
            {stats.litellmUserId == null ? "—" : `LiteLLM: ${stats.litellmUserId}`}
          </Text>
        </StatTile>
      </GridItem>
      <GridItem>
        <StatTile accent="brand" label="累计花费">
          <Text variant="heading1" as="p" className="mt-4 leading-tight">{fmt(stats.totalSpend)}</Text>
          {stats.maxBudget != null ? (
            <Meter
              className="mt-3"
              value={Number(stats.totalSpend || 0)}
              max={stats.maxBudget}
              customValue={`${fmt(stats.totalSpend)} / ${fmt(stats.maxBudget)}`}
            />
          ) : null}
          <div className="mt-2 flex min-h-[20px] items-center gap-2">
            <Text variant="secondary">{budgetText}</Text>
            <BudgetBadge spend={stats.totalSpend} maxBudget={stats.maxBudget} />
          </div>
        </StatTile>
      </GridItem>
      <GridItem>
        <StatTile accent="success" label="近 30 天">
          <Text variant="heading1" as="p" className="mt-4 leading-tight">{recentDisplay}</Text>
          <Text variant="secondary" as="p" className="mt-3">
            {fmtInt(stats.requestCount)} 次请求 · {fmtInt(stats.totalTokens)} tokens
          </Text>
        </StatTile>
      </GridItem>
      <GridItem>
        <StatTile accent="success" label="权限范围">
          <Text variant="heading1" as="p" className="mt-4 leading-tight">
            {fmtInt(stats.modelCount)} 模型
          </Text>
          <Text variant="secondary" as="p" className="mt-3">
            {fmtInt(stats.keyCount)} 个 Key · {fmtInt(stats.teamCount)} 个团队
          </Text>
        </StatTile>
      </GridItem>
    </Grid>
  );
}

export function TeamsAccessCard() {
  const { data, isLoading } = useDashboard();
  const teams = normalizeTeams(data?.teams);
  const loaded = !isLoading;

  return (
    <PanelCard title="团队权限" subtitle="只展示当前账号所属团队的信息。" padded={false}>
      {!loaded ? (
        <div className="p-6 text-sm text-kumo-subtle">Loading…</div>
      ) : teams.length === 0 ? (
        <Empty size="sm" title="当前 LiteLLM 用户未关联团队" />
      ) : (
        <div className="overflow-x-auto">
          <Table className="w-full text-sm">
            <Table.Header>
              <Table.Row>
                <Table.Head className="text-xs font-semibold uppercase tracking-wider text-kumo-subtle">团队</Table.Head>
                <Table.Head className="text-right text-xs font-semibold uppercase tracking-wider text-kumo-subtle">模型</Table.Head>
                <Table.Head className="text-right text-xs font-semibold uppercase tracking-wider text-kumo-subtle">花费</Table.Head>
                <Table.Head className="text-right text-xs font-semibold uppercase tracking-wider text-kumo-subtle">预算</Table.Head>
                <Table.Head className="text-right text-xs font-semibold uppercase tracking-wider text-kumo-subtle">RPM</Table.Head>
                <Table.Head className="text-right text-xs font-semibold uppercase tracking-wider text-kumo-subtle">TPM</Table.Head>
              </Table.Row>
            </Table.Header>
            <Table.Body>
              {teams.map((team, index) => {
                const modelsCount = Array.isArray(team.models) ? team.models.length : 0;
                return (
                  <Table.Row key={team.id ?? team.alias ?? index}>
                    <Table.Cell className="text-kumo-default">{text(team.alias ?? team.id)}</Table.Cell>
                    <Table.Cell className="text-right font-mono text-kumo-default">{modelsCount || "未限制"}</Table.Cell>
                    <Table.Cell className="text-right font-mono text-kumo-default">{team.spend == null ? "—" : fmt(team.spend)}</Table.Cell>
                    <Table.Cell className="text-right text-kumo-default">
                      {team.maxBudget == null ? (
                        <span className="font-mono">—</span>
                      ) : (
                        <div className="flex flex-col items-end gap-1">
                          <Meter
                            value={Number(team.spend || 0)}
                            max={team.maxBudget}
                            customValue={`${fmt(team.spend)} / ${fmt(team.maxBudget)}`}
                          />
                          <BudgetBadge spend={team.spend} maxBudget={team.maxBudget} />
                        </div>
                      )}
                    </Table.Cell>
                    <Table.Cell className="text-right font-mono text-kumo-default">{team.rpmLimit == null ? "—" : fmtInt(team.rpmLimit)}</Table.Cell>
                    <Table.Cell className="text-right font-mono text-kumo-default">{team.tpmLimit == null ? "—" : fmtInt(team.tpmLimit)}</Table.Cell>
                  </Table.Row>
                );
              })}
            </Table.Body>
          </Table>
        </div>
      )}
    </PanelCard>
  );
}

export function ModelAccessCard() {
  const { data } = useDashboard();
  const modelAccess = normalizeModelAccess(data?.models);
  const [open, setOpen] = useState(modelAccess.models.length > 0 && modelAccess.models.length <= PREVIEW_LIMIT);

  const previewModels = useMemo(() => modelAccess.models.slice(0, PREVIEW_LIMIT), [modelAccess.models]);
  const remainingCount = Math.max(modelAccess.models.length - previewModels.length, 0);
  const triggerText = open
    ? `收起模型列表（${modelAccess.models.length} 个）`
    : `展开全部 ${modelAccess.models.length} 个模型${remainingCount > 0 ? `，还有 ${remainingCount} 个` : ""}`;

  return (
    <PanelCard
      title="团队可用模型"
      subtitle={sourceLabel(modelAccess.source)}
      actions={
        <Badge variant="outline" className="rounded-full">
          {modelAccess.models.length || "—"} 个模型
        </Badge>
      }
      padded={false}
    >
      <div className="space-y-5 p-6">
        <div className="flex flex-wrap gap-3" aria-label="可用模型预览">
          <ModelBadges models={previewModels.length > 0 ? previewModels : modelAccess.models} />
        </div>

        {modelAccess.models.length > PREVIEW_LIMIT ? (
          <Collapsible.Root open={open} onOpenChange={setOpen}>
            <Collapsible.DefaultTrigger className="text-sm font-medium text-kumo-brand hover:text-kumo-brand-hover">
              {triggerText}
            </Collapsible.DefaultTrigger>
            {open ? (
              <Surface className="mt-4 space-y-4 rounded-lg p-5" role="region" aria-label="全部可用模型">
                <div className="flex max-h-80 flex-wrap gap-3 overflow-y-auto pr-1">
                  <ModelBadges models={modelAccess.models} />
                </div>
              </Surface>
            ) : null}
          </Collapsible.Root>
        ) : (
          <Text variant="secondary" as="p">
            模型数量较少，已直接展示完整清单。
          </Text>
        )}
      </div>
    </PanelCard>
  );
}

function PreferencesBootstrap() {
  useLegacyThemeMigration();
  return null;
}

export type AppProps = {
  initialData?: InitialDashboardData | null;
  role?: "admin" | "admin_viewer" | "user" | "none";
  dehydratedState?: unknown;
};

export function App({ initialData, dehydratedState }: AppProps) {
  const [queryClient] = useState(createQueryClient);
  const platformName = initialData?.me?.company ?? "智云AI管理平台";

  return (
    <QueryClientProvider client={queryClient}>
      <HydrationBoundary state={dehydratedState}>
        <PreferencesBootstrap />
        <Toasty>
          <TooltipProvider delay={300}>
            <main className="container mx-auto px-4 py-10 lg:px-10 lg:py-16">
              <header className="mb-12 flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
                <div className="space-y-4">
                  <div className="space-y-3">
                    <Text variant="heading1" as="h1">{platformName}</Text>
                    <Text variant="secondary" as="p" className="max-w-3xl leading-relaxed">面向智云团队的 AI 能力自助台：仪表盘聚焦用量趋势、预算与模型分布，管理操作集中到独立管理区。</Text>
                  </div>
                </div>
                <div id="header-actions-root" className="flex flex-wrap items-center gap-3 sm:self-auto">
                  <HeaderActions />
                </div>
              </header>

              <IdentityBar />

              <section id="usage-panel-root" className="mb-14">
                <UsageDashboard />
              </section>

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

type ErrorBoundaryState = { hasError: boolean; errorMessage: string };

export class ErrorBoundary extends React.Component<
  { children: React.ReactNode },
  ErrorBoundaryState
> {
  constructor(props: { children: React.ReactNode }) {
    super(props);
    this.state = { hasError: false, errorMessage: "" };
  }

  static getDerivedStateFromError(error: unknown): ErrorBoundaryState {
    const message = error instanceof Error ? error.message : String(error);
    return { hasError: true, errorMessage: message };
  }

  componentDidCatch(error: unknown, info: React.ErrorInfo): void {
    const message = error instanceof Error ? error.message : String(error);
    const stack = error instanceof Error ? error.stack : undefined;
    queueClientError(message, stack ?? info.componentStack ?? undefined);
  }

  render() {
    if (this.state.hasError) {
      return (
        <div role="alert" className="container mx-auto px-4 py-10">
          <div className="rounded-lg border border-kumo-danger-subtle bg-kumo-danger-tint/30 p-6 text-kumo-danger">
            <h2 className="mb-2 text-lg font-semibold">页面渲染出错</h2>
            <p className="text-sm text-kumo-subtle">{this.state.errorMessage || "未知错误，请刷新页面重试。"}</p>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

const clientErrorQueue: Array<{ message: string; stack?: string; sessionId: string; ts: string }> = [];
const CLIENT_ERROR_BATCH_SIZE = 5;
const CLIENT_ERROR_FLUSH_MS = 10_000;
let clientErrorFlushTimer: ReturnType<typeof setTimeout> | null = null;

function getPortalSessionId(): string {
  if (typeof sessionStorage === "undefined") return "unknown";
  const key = "_portal_session_id";
  const existing = sessionStorage.getItem(key);
  if (existing) return existing;
  const id = crypto.randomUUID();
  sessionStorage.setItem(key, id);
  return id;
}

function flushClientErrors(): void {
  const events = clientErrorQueue.splice(0);
  if (events.length === 0) return;
  void fetch("/api/_internal/client-error", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ events }),
  }).catch(() => {
    // best-effort
  });
}

function queueClientError(message: string, stack?: string): void {
  clientErrorQueue.push({
    message,
    stack,
    sessionId: getPortalSessionId(),
    ts: new Date().toISOString(),
  });
  if (clientErrorQueue.length >= CLIENT_ERROR_BATCH_SIZE) {
    if (clientErrorFlushTimer !== null) {
      clearTimeout(clientErrorFlushTimer);
      clientErrorFlushTimer = null;
    }
    flushClientErrors();
    return;
  }
  if (clientErrorFlushTimer === null) {
    clientErrorFlushTimer = setTimeout(() => {
      clientErrorFlushTimer = null;
      flushClientErrors();
    }, CLIENT_ERROR_FLUSH_MS);
  }
}

if (typeof window !== "undefined") {
  window.addEventListener("error", (event) => {
    queueClientError(event.message, event.error instanceof Error ? event.error.stack : undefined);
  });
  window.addEventListener("unhandledrejection", (event) => {
    const reason = event.reason;
    const message = reason instanceof Error ? reason.message : String(reason ?? "unhandled_rejection");
    const stack = reason instanceof Error ? reason.stack : undefined;
    queueClientError(message, stack);
  });
}

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

export {
  text, keyLabel, sourceLabel, modelBadgeColor, statusTone, budgetLabel,
  normalizeModelAccess, normalizeKeys, normalizeTeams,
} from "./app/utils";
export { BudgetInfoPopover, BudgetBadge } from "./app/budget-badge";
export { ModelBadges, ModelsCell } from "./app/model-badges";
export { DeleteKeyButton } from "./app/delete-key-button";
export { CreateKeyButton } from "./app/create-key-button";
export { PortalErrorBanner } from "./app/portal-error-banner";
export { ApiKeysCard } from "./app/keys-card";
