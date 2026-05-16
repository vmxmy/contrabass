import { Badge } from "@cloudflare/kumo/components/badge";
import { Banner } from "@cloudflare/kumo/components/banner";
import { Button } from "@cloudflare/kumo/components/button";
import { Collapsible } from "@cloudflare/kumo/components/collapsible";
import { Combobox } from "@cloudflare/kumo/components/combobox";
import { Dialog } from "@cloudflare/kumo/components/dialog";
import { Empty } from "@cloudflare/kumo/components/empty";
import { Field } from "@cloudflare/kumo/components/field";
import { Grid, GridItem } from "@cloudflare/kumo/components/grid";
import { Input } from "@cloudflare/kumo/components/input";
import { LayerCard } from "@cloudflare/kumo/components/layer-card";
import { Loader, SkeletonLine } from "@cloudflare/kumo/components/loader";
import { Meter } from "@cloudflare/kumo/components/meter";
import { Surface } from "@cloudflare/kumo/components/surface";
import { Popover } from "@cloudflare/kumo/components/popover";
import { Select } from "@cloudflare/kumo/components/select";
import { SensitiveInput } from "@cloudflare/kumo/components/sensitive-input";
import { Switch } from "@cloudflare/kumo/components/switch";
import { Table } from "@cloudflare/kumo/components/table";
import { Tabs } from "@cloudflare/kumo/components/tabs";
import { Text } from "@cloudflare/kumo/components/text";
import { Toasty } from "@cloudflare/kumo/components/toast";
import { Tooltip, TooltipProvider } from "@cloudflare/kumo/components/tooltip";
import React, { useCallback, useEffect, useMemo, useState } from "react";
import { QueryClient, QueryClientProvider, HydrationBoundary } from "@tanstack/react-query";
import { fmt, fmtInt } from "./lib/format";
import { useToast } from "./hooks/use-toast";
import { useDashboard } from "./hooks/use-dashboard";
import { applyThemePreference, useLegacyThemeMigration, usePreferences, useUpdatePreferences } from "./hooks/use-preferences";
import type { Dashboard } from "./schemas";
import { IdentityBar } from "./identity-bar";
import { UsageDashboard } from "./dashboard/views/usage-dashboard";

export type InitialDashboardData = {
  me?: { email?: string | null; domain?: string | null; company?: string | null } | null;
  user?: { litellmUserId?: string | null; totalSpend?: number | null; maxBudget?: number | null } | null;
  summary?: {
    totalSpend?: number | null;
    recentSpend?: number | null;
    keyBudget?: number | null;
    keyCount?: number | null;
    availableModelCount?: number | null;
    teamCount?: number | null;
    totalTokens?: number | null;
    requestCount?: number | null;
  } | null;
  models?: { models?: string[]; source?: string } | null;
  teams?: Array<{
    id?: string | null;
    alias?: string | null;
    models?: string[] | null;
    spend?: number | null;
    maxBudget?: number | null;
    tpmLimit?: number | null;
    rpmLimit?: number | null;
  }> | null;
  keys?: {
    totalCount?: number;
    items?: Array<{
      id?: string | null;
      alias?: string | null;
      displayKey?: string | null;
      models?: string[];
      spend?: number | null;
      maxBudget?: number | null;
      expiresAt?: string | null;
    }>;
  } | null;
  usage?: { available?: boolean } | null;
  error?: string | null;
  role?: string | null;
  email?: string | null;
  litellmUserId?: string | null;
};

type ModelAccess = {
  models: string[];
  source: string;
};

type UsageWindowOption = {
  key: string;
  label: string;
};

type PortalConfig = {
  usageWindows?: Record<string, UsageWindowOption[]>;
  defaultUsageWindows?: Record<string, string>;
};

type PortalKey = {
  id?: string | null;
  alias?: string | null;
  displayKey?: string | null;
  models?: string[];
  spend?: number | null;
  maxBudget?: number | null;
  expiresAt?: string | null;
};

type PortalTeam = {
  id?: string | null;
  alias?: string | null;
  models?: string[] | null;
  spend?: number | null;
  maxBudget?: number | null;
  tpmLimit?: number | null;
  rpmLimit?: number | null;
};

type PortalStats = {
  email?: string | null;
  litellmUserId?: string | null;
  totalSpend?: number | null;
  maxBudget?: number | null;
  keyBudget?: string | number | null;
  recentSpend?: number | null;
  usageAvailable?: boolean;
  requestCount?: number | null;
  totalTokens?: number | null;
  modelCount?: number | null;
  keyCount?: number | null;
  teamCount?: number | null;
};

declare global {
  interface Window {
    __PORTAL_CONFIG?: PortalConfig;
    __INITIAL_DATA__?: InitialDashboardData;
  }
}

const PREVIEW_LIMIT = 12;
const MODEL_CELL_PREVIEW_LIMIT = 3;

const sourceLabels: Record<string, string> = {
  team: "来自当前用户所属团队配置",
  team_unrestricted: "当前团队未限制模型，显示 LiteLLM 可用模型",
  configured: "来自 Worker 模型白名单",
  litellm: "来自 LiteLLM 全局模型",
};

function normalizeModelAccess(value: unknown): ModelAccess {
  if (!value || typeof value !== "object") {
    return { models: [], source: "" };
  }
  const record = value as Partial<ModelAccess>;
  return {
    models: Array.isArray(record.models) ? record.models.filter((item): item is string => typeof item === "string") : [],
    source: typeof record.source === "string" ? record.source : "",
  };
}

function normalizeKeys(value: unknown): PortalKey[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is PortalKey => item !== null && typeof item === "object");
}

function normalizeTeams(value: unknown): PortalTeam[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is PortalTeam => item !== null && typeof item === "object");
}

function sourceLabel(source: string): string {
  return sourceLabels[source] ?? "模型清单已按服务端权限过滤";
}

function text(value: unknown): string {
  return value == null || value === "" ? "—" : String(value);
}

function keyLabel(key: PortalKey): string {
  return text(key.alias ?? key.displayKey ?? key.id);
}

function modelBadgeColor(model: string): string {
  const lower = model.toLowerCase();
  if (
    lower.includes("gpt-4") ||
    lower.includes("claude-3-opus") ||
    lower.includes("deepseek-r1") ||
    lower.includes("o1") ||
    lower.includes("o3")
  ) {
    return "bg-kumo-badge-red text-kumo-badge-red";
  }
  if (
    lower.includes("gpt-3.5") ||
    lower.includes("claude-3-haiku") ||
    lower.includes("claude-3-sonnet") ||
    lower.includes("claude-3.5-sonnet") ||
    lower.includes("deepseek-v3") ||
    lower.includes("gemini")
  ) {
    return "bg-kumo-badge-blue text-kumo-badge-blue";
  }
  if (lower.includes("embedding") || lower.includes("text-embedding") || lower.includes("bge-")) {
    return "bg-kumo-badge-green text-kumo-badge-green";
  }
  if (lower.includes("vision") || lower.includes("dall") || lower.includes("image") || lower.includes("flux")) {
    return "bg-kumo-badge-purple text-kumo-badge-purple";
  }
  return "bg-kumo-badge-neutral text-kumo-badge-neutral";
}

function statusTone(spend: unknown, maxBudget: unknown): "danger" | "warning" | "success" | null {
  if (maxBudget == null) return null;
  const ratio = Number(spend || 0) / Number(maxBudget);
  if (ratio >= 1) return "danger";
  if (ratio >= 0.8) return "warning";
  return "success";
}

function budgetLabel(tone: "danger" | "warning" | "success"): string {
  if (tone === "danger") return "超预算";
  if (tone === "warning") return "即将超支";
  return "正常";
}

function BudgetInfoPopover() {
  return (
    <Popover>
      <Popover.Trigger
        render={
          <button
            type="button"
            className="inline-flex h-4 w-4 items-center justify-center rounded-full text-[10px] font-bold leading-none text-kumo-subtle ring-1 ring-kumo-line hover:bg-kumo-tint hover:text-kumo-default focus:outline-none focus-visible:ring-2 focus-visible:ring-kumo-focus"
            aria-label="预算阈值说明"
          >
            ?
          </button>
        }
      />
      <Popover.Content className="max-w-xs p-4">
        <Popover.Title className="mb-2 text-sm font-semibold text-kumo-strong">预算阈值说明</Popover.Title>
        <Popover.Description className="space-y-1 text-xs text-kumo-subtle">
          <p><span className="font-semibold text-kumo-success">正常</span>：花费低于预算的 80%</p>
          <p><span className="font-semibold text-kumo-warning">即将超支</span>：花费达到预算的 80%–99%</p>
          <p><span className="font-semibold text-kumo-danger">超预算</span>：花费已达到或超过预算</p>
        </Popover.Description>
      </Popover.Content>
    </Popover>
  );
}

function BudgetBadge({ spend, maxBudget }: { spend: unknown; maxBudget: unknown }) {
  const tone = statusTone(spend, maxBudget);
  if (!tone) return null;
  const variant = tone === "danger" ? "error" : tone === "warning" ? "warning" : "success";
  return (
    <>
      <Badge variant={variant} className="ml-2">
        {budgetLabel(tone)}
      </Badge>
      <BudgetInfoPopover />
    </>
  );
}

function ModelBadges({ models }: { models: string[] }) {
  if (models.length === 0) {
    return <Badge variant="secondary">团队暂未配置可用模型</Badge>;
  }

  return (
    <>
      {models.map((model) => (
        <Badge
          key={model}
          variant="secondary"
          className={`rounded-full px-2.5 py-1 font-mono text-xs ${modelBadgeColor(model)}`}
        >
          {model}
        </Badge>
      ))}
    </>
  );
}

function ModelsCell({ models }: { models: string[] }) {
  const [open, setOpen] = useState(false);
  if (models.length === 0) return <span className="text-kumo-subtle">—</span>;
  const visible = models.slice(0, MODEL_CELL_PREVIEW_LIMIT);
  const rest = models.slice(MODEL_CELL_PREVIEW_LIMIT);

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-1.5">
        <ModelBadges models={visible} />
      </div>
      {rest.length > 0 ? (
        <Collapsible.Root open={open} onOpenChange={setOpen}>
          <Collapsible.DefaultTrigger className="text-xs font-semibold text-kumo-brand hover:text-kumo-brand-hover">
            {open ? "收起模型" : `展开全部，另有 ${rest.length} 个`}
          </Collapsible.DefaultTrigger>
          {open ? (
            <div className="mt-2 flex max-w-xl flex-wrap gap-1.5 rounded-lg bg-kumo-recessed p-3" role="region" aria-label="API Key 完整模型列表">
              <ModelBadges models={models} />
            </div>
          ) : null}
        </Collapsible.Root>
      ) : null}
    </div>
  );
}

function deleteKeyErrorMessage(value: unknown): string {
  const record = value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
  const code = typeof record.error === "string" ? record.error : "";
  if (code === "key_not_found") return "Key 不存在或不属于当前用户。";
  if (code === "key_id_required") return "缺少要删除的 Key ID。";
  if (code === "user_not_found") return "当前登录用户尚未在 LiteLLM 注册，请联系管理员。";
  if (code.startsWith("litellm_request_failed_")) return "LiteLLM 删除 Key 失败，请稍后重试。";
  return typeof record.message === "string" && record.message.length > 0
    ? record.message
    : code || "删除失败";
}

import { useDeleteKey } from "./hooks/use-delete-key";
import { useCreateKey } from "./hooks/use-create-key";

function DeleteKeyButton({
  apiKey,
}: {
  apiKey: PortalKey;
}) {
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const keyId = typeof apiKey.id === "string" ? apiKey.id : "";
  const label = keyLabel(apiKey);
  const deleteKey = useDeleteKey();

  const handleOpenChange = useCallback((nextOpen: boolean) => {
    setOpen(nextOpen);
    if (!nextOpen) {
      setError(null);
    }
  }, []);

  const handleDelete = useCallback(async () => {
    if (!keyId) {
      setError("缺少要删除的 Key ID。");
      return;
    }
    setError(null);
    deleteKey.mutate(keyId, {
      onSuccess: () => { setOpen(false); },
      onError: (err: unknown) => {
        setError(deleteKeyErrorMessage(err));
      },
    });
  }, [keyId, deleteKey]);

  return (
    <Dialog.Root role="alertdialog" open={open} onOpenChange={handleOpenChange}>
      <Dialog.Trigger
        render={(props) => (
          <Button {...props} variant="secondary-destructive" size="xs" disabled={!keyId}>
            删除
          </Button>
        )}
      />
      <Dialog size="sm" className="space-y-5 p-6">
        <Dialog.Title>
          <Text variant="heading3" as="h2">删除 API Key？</Text>
        </Dialog.Title>
        <Dialog.Description>
          <Text variant="secondary">将删除「{label}」。删除后该 Key 会立即失效，此操作不可撤销。</Text>
        </Dialog.Description>
        {error ? (
          <Banner variant="error" title="删除失败" description={error} />
        ) : null}
        <div className="flex justify-end gap-2">
          <Dialog.Close
            render={(props) => (
              <Button {...props} variant="secondary" size="sm" disabled={deleteKey.isPending}>
                取消
              </Button>
            )}
          />
          <Button variant="destructive" size="sm" loading={deleteKey.isPending} onClick={handleDelete}>
            确认删除
          </Button>
        </div>
      </Dialog>
    </Dialog.Root>
  );
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
    <article className="overflow-hidden rounded-xl bg-kumo-base ring-1 ring-kumo-line">
      <div className="border-b border-kumo-line bg-kumo-elevated p-6">
        <Text variant="heading3" as="p">团队权限</Text>
        <Text variant="secondary" as="p">只展示当前账号所属团队的信息。</Text>
      </div>
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
    </article>
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
    <article className="overflow-hidden rounded-xl bg-kumo-base ring-1 ring-kumo-line">
      <div className="border-b border-kumo-line bg-kumo-elevated p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="space-y-1">
            <Text variant="heading3" as="p">团队可用模型</Text>
            <Text variant="secondary" as="p">{sourceLabel(modelAccess.source)}</Text>
          </div>
          <Badge variant="outline" className="rounded-full">
            {modelAccess.models.length || "—"} 个模型
          </Badge>
        </div>
      </div>

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
    </article>
  );
}

export function ApiKeysCard() {
  const { data, isLoading } = useDashboard();
  const keys = normalizeKeys(data?.keys?.items);
  const loaded = !isLoading;

  return (
    <section className="overflow-hidden rounded-xl bg-kumo-base ring-1 ring-kumo-line">
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-kumo-line bg-kumo-elevated p-6">
        <div>
          <Text variant="heading3" as="p">API Keys</Text>
          <Text variant="secondary" as="p">仅列出当前 LiteLLM 用户拥有的密钥。</Text>
        </div>
        <CreateKeyButton />
      </div>
      <div className="overflow-x-auto">
        {!loaded ? (
          <div className="space-y-3 p-6" aria-live="polite">
            {Array.from({ length: 4 }, (_, index) => (
              <SkeletonLine key={index} minWidth={260} maxWidth={760} blockHeight={20} />
            ))}
          </div>
        ) : keys.length === 0 ? (
          <Empty size="sm" title="暂无 API Key" />
        ) : (
          <Table className="w-full text-left text-sm text-kumo-default">
            <Table.Header>
              <Table.Row className="border-b border-kumo-line">
                <Table.Head className="bg-kumo-base p-5 text-xs font-semibold uppercase tracking-wider text-kumo-subtle">名称</Table.Head>
                <Table.Head className="bg-kumo-base p-5 text-xs font-semibold uppercase tracking-wider text-kumo-subtle">Key</Table.Head>
                <Table.Head className="bg-kumo-base p-5 text-xs font-semibold uppercase tracking-wider text-kumo-subtle">模型</Table.Head>
                <Table.Head className="bg-kumo-base p-5 text-right text-xs font-semibold uppercase tracking-wider text-kumo-subtle">花费</Table.Head>
                <Table.Head className="bg-kumo-base p-5 text-right text-xs font-semibold uppercase tracking-wider text-kumo-subtle">预算</Table.Head>
                <Table.Head className="bg-kumo-base p-5 text-xs font-semibold uppercase tracking-wider text-kumo-subtle">过期时间</Table.Head>
                <Table.Head className="bg-kumo-base p-5 text-right text-xs font-semibold uppercase tracking-wider text-kumo-subtle">操作</Table.Head>
              </Table.Row>
            </Table.Header>
            <Table.Body>
              {keys.map((key, index) => {
                const displayKey = text(key.displayKey);
                const spend = Number(key.spend || 0);
                const spendColor = spend > 100 ? "text-kumo-danger" : spend > 10 ? "text-kumo-warning" : "text-kumo-default";
                const models = Array.isArray(key.models) ? key.models : [];
                return (
                  <Table.Row key={key.id ?? key.alias ?? index} className="border-b border-kumo-fill transition-colors hover:bg-kumo-tint">
                    <Table.Cell className="py-3 pl-5 pr-3 text-kumo-default">{text(key.alias)}</Table.Cell>
                    <Table.Cell className="py-3 pr-3 text-kumo-default">
                      <code className="font-mono text-sm text-kumo-subtle">{displayKey}</code>
                    </Table.Cell>
                    <Table.Cell className="py-3 pr-3 text-kumo-default">
                      <ModelsCell models={models} />
                    </Table.Cell>
                    <Table.Cell className={`py-3 pr-3 text-right font-mono ${spendColor}`}>{fmt(key.spend)}</Table.Cell>
                    <Table.Cell className="py-3 pr-3 text-right font-mono text-kumo-default">
                      {key.maxBudget == null ? "—" : fmt(key.maxBudget)}
                      <BudgetBadge spend={key.spend} maxBudget={key.maxBudget} />
                    </Table.Cell>
                    <Table.Cell className="py-3 pr-5 text-kumo-default">{text(key.expiresAt)}</Table.Cell>
                    <Table.Cell className="py-3 pr-5 text-right">
                      <DeleteKeyButton apiKey={key} />
                    </Table.Cell>
                  </Table.Row>
                );
              })}
            </Table.Body>
          </Table>
        )}
      </div>
    </section>
  );
}

export function PortalErrorBanner({ initialData }: { initialData?: InitialDashboardData | null }) {
  const [message, setMessage] = useState<string | null>(() => {
    const err = initialData?.error;
    return typeof err === "string" && err.length > 0 ? err : null;
  });

  if (!message) return null;

  return (
    <div className="mt-6" role="alert" aria-live="assertive">
      <Banner variant="error" title="页面数据加载失败" description={message} />
    </div>
  );
}

const NEVER_EXPIRES_VALUE = "never";

const DURATION_OPTIONS = [
  { value: NEVER_EXPIRES_VALUE, label: "永不过期" },
  { value: "7d", label: "7 天" },
  { value: "30d", label: "30 天" },
  { value: "90d", label: "90 天" },
  { value: "365d", label: "365 天" },
];

function durationFromSelectValue(value: unknown): string {
  const selected = typeof value === "string" ? value : NEVER_EXPIRES_VALUE;
  return selected === NEVER_EXPIRES_VALUE ? "" : selected;
}

function selectedModelsFromValue(value: unknown): string[] {
  if (!Array.isArray(value)) return typeof value === "string" ? [value] : [];
  return value.filter((item): item is string => typeof item === "string");
}

function createKeyErrorMessage(value: unknown): string {
  const record = value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
  const code = typeof record.error === "string" ? record.error : "";
  if (code === "key_alias_conflict") {
    const keyAlias = typeof record.keyAlias === "string" && record.keyAlias.length > 0 ? record.keyAlias : "";
    return keyAlias ? `名称「${keyAlias}」已存在，请换一个名称。` : "Key 名称已存在，请换一个名称。";
  }
  if (code === "key_alias_required") return "请输入 Key 名称";
  if (code === "user_not_found") return "当前登录用户尚未在 LiteLLM 注册，请联系管理员。";
  if (code.startsWith("litellm_request_failed_")) return "LiteLLM 创建 Key 失败，请稍后重试。";
  return typeof record.message === "string" && record.message.length > 0
    ? record.message
    : code || "创建失败";
}

type CreateKeyResult = {
  rawKey: string;
  keyAlias: string | null;
  expires: string | null;
  keyId: string;
};

export function CreateKeyButton({ onRefresh }: { onRefresh?: () => void } = {}) {
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [alias, setAlias] = useState("");
  const [selectedModels, setSelectedModels] = useState<string[]>([]);
  const [budget, setBudget] = useState("");
  const [duration, setDuration] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [aliasError, setAliasError] = useState<string | null>(null);
  const [result, setResult] = useState<CreateKeyResult | null>(null);
  const durationSelectValue = duration || NEVER_EXPIRES_VALUE;
  const createKey = useCreateKey();
  const { data: dashboardData } = useDashboard();
  const models = dashboardData?.models?.models ?? [];

  const resetForm = useCallback(() => {
    setAlias("");
    setSelectedModels([]);
    setBudget("");
    setDuration("");
    setError(null);
    setAliasError(null);
    setResult(null);
  }, []);

  const handleSubmit = useCallback(() => {
    const trimmed = alias.trim();
    if (!trimmed) {
      setAliasError("请输入 Key 名称");
      return;
    }
    setError(null);
    setAliasError(null);
    const input: Parameters<typeof createKey.mutate>[0] = { keyAlias: trimmed };
    if (selectedModels.length > 0) input.models = selectedModels;
    if (budget) {
      const parsed = Number(budget);
      if (Number.isFinite(parsed) && parsed >= 0) input.maxBudget = parsed;
    }
    if (duration) input.duration = duration;

    createKey.mutate(input, {
      onSuccess: (data) => {
        setResult({
          rawKey: data.rawKey,
          keyAlias: data.keyAlias,
          expires: data.expires,
          keyId: data.keyId,
        });
        toast.success("Key 已创建", data.keyAlias ?? trimmed);
        onRefresh?.();
      },
      onError: (err: unknown) => {
        const msg = createKeyErrorMessage(err);
        setAliasError(msg);
        toast.error("创建失败", msg);
      },
    });
  }, [alias, selectedModels, budget, duration, createKey, toast, onRefresh]);

  const handleOpenChange = useCallback((nextOpen: boolean) => {
    setOpen(nextOpen);
    if (!nextOpen) {
      resetForm();
    }
  }, [resetForm]);

  return (
    <Dialog.Root open={open} onOpenChange={handleOpenChange}>
      <Dialog.Trigger
        render={(props) => (
          <Button {...props} variant="primary" size="sm">
            创建 Key
          </Button>
        )}
      />
      <Dialog size="base" className="space-y-6 p-8">
        <Dialog.Title>
          <Text variant="heading3" as="h2">{result ? "Key 已创建" : "创建新 API Key"}</Text>
        </Dialog.Title>
        <Dialog.Description>
          <Text variant="secondary">
            {result
              ? "请立即复制完整 Key，关闭后无法再次查看。"
              : "创建一个新的 API Key，绑定到当前登录用户。"}
          </Text>
        </Dialog.Description>

        {result ? (
          <div className="space-y-5">
            <Banner
              variant="alert"
              title="请立即复制"
              description="关闭此对话框后将无法再次查看完整 Key。"
            />

            <Surface className="rounded-xl p-5 ring-1 ring-kumo-line">
              <div className="space-y-1">
                <Text variant="secondary" size="xs" className="font-semibold uppercase tracking-wider">Key 名称</Text>
                <Text variant="heading3" as="p">{result.keyAlias || "—"}</Text>
              </div>
              <div className="mt-4 space-y-2">
                <SensitiveInput
                  label="完整 Key"
                  size="lg"
                  readOnly
                  defaultValue={result.rawKey}
                />
              </div>
              {result.expires ? (
                <div className="mt-4 space-y-1">
                  <Text variant="secondary" size="xs" className="font-semibold uppercase tracking-wider">过期时间</Text>
                  <Text variant="mono" as="p">{result.expires}</Text>
                </div>
              ) : null}
            </Surface>

            <div className="flex justify-end">
              <Dialog.Close
                render={(props) => (
                  <Button {...props} variant="primary" size="lg">
                    已复制，关闭
                  </Button>
                )}
              />
            </div>
          </div>
        ) : (
          <div className="space-y-5">
            {error ? (
              <Banner variant="error" title="创建失败" description={error} />
            ) : null}

            <Field
              label="名称"
              required={true}
              error={aliasError ? { message: aliasError, match: true } : undefined}
            >
              <Input
                id="create-key-alias"
                size="lg"
                placeholder="例如：production-api"
                value={alias}
                onChange={(e: React.ChangeEvent<HTMLInputElement>) => setAlias(e.target.value)}
              />
            </Field>

            {models.length > 0 ? (
              <Combobox
                multiple
                items={models}
                value={selectedModels}
                onValueChange={(value) => setSelectedModels(value as string[])}
                label="允许模型"
                required={false}
                description="留空则继承当前用户可用模型"
                size="lg"
              >
                <Combobox.TriggerMultipleWithInput
                  placeholder="选择模型…"
                  renderItem={(item) => (
                    <Combobox.Chip value={item as string}>{item as string}</Combobox.Chip>
                  )}
                  value={selectedModels}
                />
                <Combobox.Content>
                  <Combobox.List>
                    {(item) => (
                      <Combobox.Item key={item as string} value={item as string}>
                        {item as string}
                      </Combobox.Item>
                    )}
                  </Combobox.List>
                  <Combobox.Empty>无匹配模型</Combobox.Empty>
                </Combobox.Content>
              </Combobox>
            ) : null}

            <Field
              label="预算上限（USD）"
              required={false}
              description="留空表示不限"
            >
              <Input
                id="create-key-budget"
                size="lg"
                type="number"
                min="0"
                step="0.01"
                placeholder="留空表示不限"
                value={budget}
                onChange={(e: React.ChangeEvent<HTMLInputElement>) => setBudget(e.target.value)}
              />
            </Field>

            <div className="space-y-1.5">
              <Select
                label="有效期"
                className="w-full"
                size="lg"
                value={durationSelectValue}
                onValueChange={(value) => setDuration(durationFromSelectValue(value))}
              >
                {DURATION_OPTIONS.map((opt) => (
                  <Select.Option key={opt.value} value={opt.value}>
                    {opt.label}
                  </Select.Option>
                ))}
              </Select>
            </div>

            <div className="flex justify-end gap-3 pt-2">
              <Dialog.Close
                render={(props) => (
                  <Button {...props} variant="secondary" size="lg">
                    取消
                  </Button>
                )}
              />
              <Button variant="primary" size="lg" loading={createKey.isPending} onClick={handleSubmit}>
                创建
              </Button>
            </div>
          </div>
        )}
      </Dialog>
    </Dialog.Root>
  );
}

export type AppProps = {
  initialData?: InitialDashboardData | null;
  role?: "admin" | "user" | "none";
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
