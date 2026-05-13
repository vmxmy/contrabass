import { Badge } from "@cloudflare/kumo/components/badge";
import { Banner } from "@cloudflare/kumo/components/banner";
import { Button } from "@cloudflare/kumo/components/button";
import { Collapsible } from "@cloudflare/kumo/components/collapsible";
import { Combobox } from "@cloudflare/kumo/components/combobox";
import { Dialog } from "@cloudflare/kumo/components/dialog";
import { DropdownMenu } from "@cloudflare/kumo/components/dropdown";
import { Empty } from "@cloudflare/kumo/components/empty";
import { Field } from "@cloudflare/kumo/components/field";
import { Grid, GridItem } from "@cloudflare/kumo/components/grid";
import { Input } from "@cloudflare/kumo/components/input";
import { LayerCard } from "@cloudflare/kumo/components/layer-card";
import { Loader, SkeletonLine } from "@cloudflare/kumo/components/loader";
import { Meter } from "@cloudflare/kumo/components/meter";
import { Surface } from "@cloudflare/kumo/components/surface";
import { Pagination } from "@cloudflare/kumo/components/pagination";
import { Popover } from "@cloudflare/kumo/components/popover";
import { Select } from "@cloudflare/kumo/components/select";
import { SensitiveInput } from "@cloudflare/kumo/components/sensitive-input";
import { Switch } from "@cloudflare/kumo/components/switch";
import { Table } from "@cloudflare/kumo/components/table";
import { Tabs } from "@cloudflare/kumo/components/tabs";
import { Text } from "@cloudflare/kumo/components/text";
import { Toasty } from "@cloudflare/kumo/components/toast";
import { Tooltip, TooltipProvider } from "@cloudflare/kumo/components/tooltip";
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { QueryClient, QueryClientProvider, HydrationBoundary } from "@tanstack/react-query";
import type { UsageTimeseries } from "./chart";
import { fmt, fmtInt } from "./lib/format";
import { useToast } from "./hooks/use-toast";
import { useDashboard } from "./hooks/use-dashboard";
import { applyThemePreference, useLegacyThemeMigration, usePreferences, useUpdatePreferences } from "./hooks/use-preferences";
import type { Dashboard, UserPreferences } from "./schemas";

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

const sourceLabels: Record<string, string> = {
  team: "来自当前用户所属团队配置",
  team_unrestricted: "当前团队未限制模型，显示 LiteLLM 可用模型",
  configured: "来自 Worker 模型白名单",
  litellm: "来自 LiteLLM 全局模型",
};

function portalConfig(): Required<PortalConfig> {
  const config = typeof window !== "undefined" ? window.__PORTAL_CONFIG : undefined;
  return {
    usageWindows: config?.usageWindows ?? fallbackUsageWindows,
    defaultUsageWindows: config?.defaultUsageWindows ?? fallbackDefaultUsageWindows,
  };
}

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

function usageWindowOptions(grain: string, config: Required<PortalConfig>): UsageWindowOption[] {
  return config.usageWindows[grain] ?? config.usageWindows.day ?? [];
}

function defaultWindowFor(grain: string, config: Required<PortalConfig>): string {
  return config.defaultUsageWindows[grain] ?? usageWindowOptions(grain, config)[0]?.key ?? "";
}

function usageWindowDurationMs(key: string): number | null {
  const match = /^(\d+)(h|d|w|mo)$/.exec(key);
  if (!match) return null;
  const amount = Number(match[1]);
  const unit = match[2];
  const unitMs = unit === "h" ? HOUR_MS : unit === "d" ? DAY_MS : unit === "w" ? WEEK_MS : MONTH_MS;
  return amount * unitMs;
}

function usageWindowPresets(config: Required<PortalConfig>): UsagePreset[] {
  const presets = new Map<string, UsagePreset>();
  for (const [grain, options] of Object.entries(config.usageWindows)) {
    for (const option of options) {
      const durationMs = usageWindowDurationMs(option.key);
      if (!durationMs) continue;
      // Later grain groups intentionally win duplicate windows, e.g. 7d -> day instead of hour.
      presets.set(option.key, {
        grain,
        windowKey: option.key,
        label: option.label,
        durationMs,
      });
    }
  }
  return [...presets.values()].sort((a, b) => a.durationMs - b.durationMs);
}

function presetForWindow(windowKey: string, config: Required<PortalConfig>): UsagePreset | null {
  return usageWindowPresets(config).find((preset) => preset.windowKey === windowKey) ?? null;
}

function supportsWindowForGrain(grain: string, windowKey: string, config: Required<PortalConfig>): boolean {
  return usageWindowOptions(grain, config).some((option) => option.key === windowKey);
}

function selectionForRange(from: number, to: number, config: Required<PortalConfig>): UsageWindowSelection | null {
  const duration = Math.abs(to - from);
  if (!Number.isFinite(duration) || duration <= 0) return null;

  let best: (UsageWindowSelection & { ratio: number }) | null = null;
  for (const preset of usageWindowPresets(config)) {
    const ratio = Math.abs(duration - preset.durationMs) / preset.durationMs;
    if (!best || ratio < best.ratio) {
      best = { grain: preset.grain, windowKey: preset.windowKey, label: preset.label, ratio };
    }
  }

  return best && best.ratio <= RANGE_MATCH_TOLERANCE ? best : null;
}

function controlPillClass(active: boolean, disabled = false): string {
  const base = "rounded-full px-3 py-1.5 text-xs font-semibold ring-1 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-kumo-focus";
  if (disabled) {
    return `${base} cursor-not-allowed bg-kumo-recessed text-kumo-inactive ring-kumo-line opacity-50`;
  }
  if (active) {
    return `${base} bg-kumo-brand text-kumo-inverse ring-kumo-brand hover:bg-kumo-brand-hover`;
  }
  return `${base} bg-kumo-base text-kumo-default ring-kumo-line hover:bg-kumo-tint`;
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

export function PreferencesAwareUsagePanel() {
  const { data: preferences } = usePreferences();
  return <UsagePanel defaultUsageWindow={preferences?.defaultUsageWindow} />;
}

export function UsagePanel({ defaultUsageWindow }: { defaultUsageWindow?: UserPreferences["defaultUsageWindow"] } = {}) {
  const config = useMemo(() => portalConfig(), []);
  const grains = useMemo(() => Object.keys(config.usageWindows), [config]);
  const presets = useMemo(() => usageWindowPresets(config), [config]);
  const defaultPreset = useMemo(() => {
    const defaultDayWindow = defaultUsageWindow ?? defaultWindowFor("day", config);
    return presetForWindow(defaultDayWindow, config) ?? presets.find((preset) => preset.grain === "day") ?? presets[0];
  }, [config, defaultUsageWindow, presets]);
  const [grainMode, setGrainMode] = useState<GrainMode>("auto");
  const [grain, setGrain] = useState(defaultPreset?.grain ?? "day");
  const [windowKey, setWindowKey] = useState(defaultPreset?.windowKey ?? defaultWindowFor("day", config));
  const [data, setData] = useState<UsageTimeseries | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [rangeHint, setRangeHint] = useState<string | null>(null);
  const requestIdRef = useRef(0);
  const appliedPreferredWindowRef = useRef(false);

  const activePreset = useMemo(
    () => presets.find((preset) => preset.windowKey === windowKey) ?? defaultPreset,
    [defaultPreset, presets, windowKey],
  );
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
    if (appliedPreferredWindowRef.current || defaultUsageWindow === undefined) return;
    appliedPreferredWindowRef.current = true;
    const preset = presetForWindow(defaultUsageWindow, config);
    if (!preset) return;
    setGrainMode("auto");
    setGrain(preset.grain);
    setWindowKey(preset.windowKey);
  }, [config, defaultUsageWindow]);

  useEffect(() => {
    if (!grain || !windowKey) return;
    const controller = new AbortController();
    const requestId = ++requestIdRef.current;
    setLoading(true);
    setError(null);

    const params = new URLSearchParams({ grain, window: windowKey });
    fetch(`/api/usage/timeseries?${params.toString()}`, {
      signal: controller.signal,
      headers: { "content-type": "application/json" },
    })
      .then(async (response) => {
        const body = await response.json().catch(() => ({}));
        if (!response.ok) {
          throw new Error(typeof body.error === "string" ? body.error : "用量数据加载失败");
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
        setError(fetchError instanceof Error ? fetchError.message : "用量数据加载失败");
      })
      .finally(() => {
        if (requestId === requestIdRef.current) {
          setLoading(false);
        }
      });

    return () => controller.abort();
  }, [grain, windowKey]);

  const selectedWindowLabel = activePreset?.label ?? "当前窗口";
  const windowText = data
    ? `${data.windowLabel} · ${usageGrainLabels[data.grain] ?? data.grain} · ${text(data.start).slice(0, 10)} 至 ${text(data.end).slice(0, 10)}${data.limited ? " · 已达到分页上限" : ""}`
    : `点击预设即可取数，系统默认自动匹配粒度；需要细看时再单击粒度芯片。当前：${selectedWindowLabel} · ${grainStatus}`;

  return (
    <article id="usage-panel" className="overflow-hidden rounded-xl bg-kumo-base ring-1 ring-kumo-line" aria-busy={loading}>
      <div className="border-b border-kumo-line bg-kumo-elevated p-6">
        <div className="space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <Text variant="heading3" as="h2">Token 用量趋势</Text>
            <span className="rounded-full bg-kumo-info-tint px-2.5 py-1 text-xs font-semibold text-kumo-info">Brush native</span>
            <span className="rounded-full bg-kumo-success-tint px-2.5 py-1 text-xs font-semibold text-kumo-success">{grainStatus}</span>
          </div>
          <Text variant="secondary" as="p" className="leading-relaxed">{windowText}</Text>
          <Text variant="secondary" size="xs" as="p">
            在图表中横向拖拽会吸附到最接近的时间预设；预设和粒度芯片都支持键盘单次触发。
          </Text>
          {rangeHint ? (
            <p className="text-xs font-medium text-kumo-brand" aria-live="polite">{rangeHint}</p>
          ) : null}
        </div>
        <div className="mt-5 grid gap-4 lg:grid-cols-[1fr_auto]" aria-label="用量筛选">
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
            <Banner variant="error" title="用量数据加载失败" description={error} />
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
    </article>
  );
}

export function HeaderActions() {
  const { data: preferences } = usePreferences();
  const updatePreferences = useUpdatePreferences();
  const theme = preferences?.theme ?? "auto";
  const [resolvedMode, setResolvedMode] = useState<"dark" | "light">(() => resolvedTheme(theme));

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

type PortalRole = "admin" | "user" | "none";

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

function PreferencesBootstrap() {
  useLegacyThemeMigration();
  return null;
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

const LazyAdminSection = React.lazy(async () => {
  const module = await import("./admin-components");
  return { default: module.AdminSection };
});

function AdminSectionFallback() {
  return (
    <div className="flex items-center justify-center py-10" aria-live="polite">
      <Loader aria-label="正在加载管理员视图" />
    </div>
  );
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
        <PreferencesBootstrap />
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
                    <PreferencesAwareUsagePanel />
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

              {isAdmin && showAdminPanel ? (
                <div id="admin-root">
                  <React.Suspense fallback={<AdminSectionFallback />}>
                    <LazyAdminSection role={role} />
                  </React.Suspense>
                </div>
              ) : null}

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
