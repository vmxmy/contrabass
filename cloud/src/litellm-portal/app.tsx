import { Badge } from "@cloudflare/kumo/components/badge";
import { Banner } from "@cloudflare/kumo/components/banner";
import { Button } from "@cloudflare/kumo/components/button";
import { Collapsible } from "@cloudflare/kumo/components/collapsible";
import { Dialog } from "@cloudflare/kumo/components/dialog";
import { Input } from "@cloudflare/kumo/components/input";
import { Loader, SkeletonLine } from "@cloudflare/kumo/components/loader";
import { Select } from "@cloudflare/kumo/components/select";
import { Table } from "@cloudflare/kumo/components/table";
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { UsageChart, type UsageTimeseries } from "./chart";

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

declare global {
  interface Window {
    __PORTAL_CONFIG?: PortalConfig;
    __litellmPortalModelAccess?: Partial<ModelAccess>;
    __litellmPortalKeys?: PortalKey[];
    __litellmPortalError?: string | null;
  }
}

const MODEL_EVENT = "litellm-portal:models";
const KEYS_EVENT = "litellm-portal:keys";
const ERROR_EVENT = "litellm-portal:error";
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

const sourceLabels: Record<string, string> = {
  team: "来自当前用户所属团队配置",
  team_unrestricted: "当前团队未限制模型，显示 LiteLLM 可用模型",
  configured: "来自 Worker 模型白名单",
  litellm: "来自 LiteLLM 全局模型",
};

const numberFormatter = new Intl.NumberFormat("zh-CN");

function portalConfig(): Required<PortalConfig> {
  return {
    usageWindows: window.__PORTAL_CONFIG?.usageWindows ?? fallbackUsageWindows,
    defaultUsageWindows: window.__PORTAL_CONFIG?.defaultUsageWindows ?? fallbackDefaultUsageWindows,
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

function initialModelAccess(): ModelAccess {
  return normalizeModelAccess(window.__litellmPortalModelAccess);
}

function sourceLabel(source: string): string {
  return sourceLabels[source] ?? "模型清单已按服务端权限过滤";
}

function text(value: unknown): string {
  return value == null || value === "" ? "—" : String(value);
}

function fmt(value: unknown): string {
  return "$" + Number(value || 0).toFixed(2);
}

function fmtInt(value: unknown): string {
  return numberFormatter.format(Number(value || 0));
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

function BudgetBadge({ spend, maxBudget }: { spend: unknown; maxBudget: unknown }) {
  const tone = statusTone(spend, maxBudget);
  if (!tone) return null;
  const className = tone === "danger"
    ? "bg-kumo-danger-tint text-kumo-danger"
    : tone === "warning"
      ? "bg-kumo-warning-tint text-kumo-warning"
      : "bg-kumo-success-tint text-kumo-success";
  return (
    <span className={`ml-2 inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-semibold ${className}`}>
      {budgetLabel(tone)}
    </span>
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

function MetricTile({ label, value, loading = false }: { label: string; value: string; loading?: boolean }) {
  return (
    <div className="rounded-lg bg-kumo-recessed p-5 transition-colors hover:bg-kumo-tint">
      <p className="text-xs font-medium text-kumo-subtle">{label}</p>
      {loading ? (
        <SkeletonLine className="mt-3" minWidth={96} maxWidth={150} blockHeight={24} />
      ) : (
        <p className="mt-3 font-mono text-lg font-semibold text-kumo-strong">{value}</p>
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
  const source = data?.source === "spend_logs_v2" ? "实时请求日志" : data ? "LiteLLM 日聚合" : "—";
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
    return <p className="py-3 text-sm text-kumo-subtle">暂无用量数据。</p>;
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
    return <span className="text-sm text-kumo-subtle">暂无模型用量拆分。</span>;
  }

  return (
    <div className="flex flex-col gap-3">
      {models.map((model) => (
        <div key={model.model} className="rounded-lg bg-kumo-recessed p-5 transition-colors hover:bg-kumo-tint">
          <p className="truncate font-mono text-sm font-semibold text-kumo-strong">{model.model}</p>
          <p className="mt-2 text-xs text-kumo-subtle">
            {fmt(model.spend)} · {fmtInt(model.totalTokens)} tokens · {fmtInt(model.requests)} 请求
          </p>
        </div>
      ))}
    </div>
  );
}

export function UsagePanel() {
  const config = useMemo(() => portalConfig(), []);
  const grains = useMemo(() => Object.keys(config.usageWindows), [config]);
  const presets = useMemo(() => usageWindowPresets(config), [config]);
  const defaultPreset = useMemo(() => {
    const defaultDayWindow = defaultWindowFor("day", config);
    return presetForWindow(defaultDayWindow, config) ?? presets.find((preset) => preset.grain === "day") ?? presets[0];
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
            <p className="text-lg font-semibold text-kumo-strong">Token 用量趋势</p>
            <span className="rounded-full bg-kumo-info-tint px-2.5 py-1 text-xs font-semibold text-kumo-info">Brush native</span>
            <span className="rounded-full bg-kumo-success-tint px-2.5 py-1 text-xs font-semibold text-kumo-success">{grainStatus}</span>
          </div>
          <p className="text-sm leading-relaxed text-kumo-subtle">{windowText}</p>
          <p className="text-xs text-kumo-subtle">
            在图表中横向拖拽会吸附到最接近的时间预设；预设和粒度芯片都支持键盘单次触发。
          </p>
          {rangeHint ? (
            <p className="text-xs font-medium text-kumo-brand" aria-live="polite">{rangeHint}</p>
          ) : null}
        </div>
        <div className="mt-5 grid gap-4 lg:grid-cols-[1fr_auto]" aria-label="用量筛选">
          <div className="space-y-2">
            <p className="text-xs font-semibold uppercase tracking-wider text-kumo-subtle">时间范围预设</p>
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
            <p className="text-xs font-semibold uppercase tracking-wider text-kumo-subtle">时间粒度</p>
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
                return (
                  <button
                    key={item}
                    type="button"
                    className={controlPillClass(grainMode === item, disabled)}
                    aria-pressed={grainMode === item}
                    disabled={disabled}
                    title={disabled ? `${selectedWindowLabel} 不支持${usageGrainLabels[item] ?? item}粒度` : undefined}
                    onClick={() => handleManualGrainClick(item)}
                  >
                    {usageGrainLabels[item] ?? item}
                  </button>
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
          <UsageChart data={data} error={error} loading={loading} onTimeRangeChange={handleChartRangeChange} />
          <div className="overflow-x-auto">
            <UsageBucketsTable data={data} loading={loading} />
          </div>
        </div>
        <div className="border-t border-kumo-line p-8 md:border-l md:border-t-0">
          <p className="mb-5 text-sm font-semibold text-kumo-default">高频模型</p>
          <TopModels data={data} loading={loading} />
        </div>
      </div>
    </article>
  );
}

export function ModelAccessCard() {
  const initial = initialModelAccess();
  const [modelAccess, setModelAccess] = useState<ModelAccess>(initial);
  const [open, setOpen] = useState(initial.models.length > 0 && initial.models.length <= PREVIEW_LIMIT);

  useEffect(() => {
    const updateModels = (event: Event) => {
      const next = normalizeModelAccess(event instanceof CustomEvent ? event.detail : window.__litellmPortalModelAccess);
      setModelAccess(next);
      setOpen(next.models.length > 0 && next.models.length <= PREVIEW_LIMIT);
    };

    window.addEventListener(MODEL_EVENT, updateModels);
    if (window.__litellmPortalModelAccess) {
      updateModels(new Event(MODEL_EVENT));
    }

    return () => window.removeEventListener(MODEL_EVENT, updateModels);
  }, []);

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
            <p className="text-lg font-semibold text-kumo-strong">
              团队可用模型
            </p>
            <p className="text-sm text-kumo-subtle">
              {sourceLabel(modelAccess.source)}
            </p>
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
              <div className="mt-4 space-y-4 rounded-lg bg-kumo-recessed p-5" role="region" aria-label="全部可用模型">
                <div className="flex max-h-80 flex-wrap gap-3 overflow-y-auto pr-1">
                  <ModelBadges models={modelAccess.models} />
                </div>
              </div>
            ) : null}
          </Collapsible.Root>
        ) : (
          <p className="text-sm text-kumo-subtle">
            模型数量较少，已直接展示完整清单。
          </p>
        )}
      </div>
    </article>
  );
}

export function ApiKeysCard() {
  const [keys, setKeys] = useState<PortalKey[]>(normalizeKeys(window.__litellmPortalKeys));
  const [loaded, setLoaded] = useState(Array.isArray(window.__litellmPortalKeys));

  useEffect(() => {
    const updateKeys = (event: Event) => {
      const next = normalizeKeys(event instanceof CustomEvent ? event.detail : window.__litellmPortalKeys);
      setKeys(next);
      setLoaded(true);
    };

    window.addEventListener(KEYS_EVENT, updateKeys);
    if (window.__litellmPortalKeys) {
      updateKeys(new Event(KEYS_EVENT));
    }

    return () => window.removeEventListener(KEYS_EVENT, updateKeys);
  }, []);

  return (
    <section className="overflow-hidden rounded-xl bg-kumo-base ring-1 ring-kumo-line">
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-kumo-line bg-kumo-elevated p-6">
        <div>
          <p className="text-lg font-semibold text-kumo-strong">API Keys</p>
          <p className="text-sm text-kumo-subtle">仅列出当前 LiteLLM 用户拥有的密钥。</p>
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
          <p className="p-5 text-sm text-kumo-subtle">暂无 API Key。</p>
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

export function PortalErrorBanner() {
  const [message, setMessage] = useState<string | null>(window.__litellmPortalError ?? null);

  useEffect(() => {
    const updateError = (event: Event) => {
      const detail = event instanceof CustomEvent ? event.detail : window.__litellmPortalError;
      setMessage(typeof detail === "string" && detail.length > 0 ? detail : null);
    };

    window.addEventListener(ERROR_EVENT, updateError);
    if (window.__litellmPortalError) {
      updateError(new Event(ERROR_EVENT));
    }

    return () => window.removeEventListener(ERROR_EVENT, updateError);
  }, []);

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

type CreateKeyResult = {
  rawKey: string;
  keyAlias: string | null;
  expires: string | null;
  keyId: string;
};

export function CreateKeyButton() {
  const [open, setOpen] = useState(false);
  const [alias, setAlias] = useState("");
  const [selectedModels, setSelectedModels] = useState<string[]>([]);
  const [budget, setBudget] = useState("");
  const [duration, setDuration] = useState("");
  const [models, setModels] = useState<string[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<CreateKeyResult | null>(null);
  const durationSelectValue = duration || NEVER_EXPIRES_VALUE;

  useEffect(() => {
    if (!open) return;
    fetch("/api/models", { headers: { "content-type": "application/json" } })
      .then(async (res) => {
        if (!res.ok) return;
        const data = await res.json();
        if (Array.isArray(data.models)) setModels(data.models);
      })
      .catch(() => {});
  }, [open]);

  const resetForm = useCallback(() => {
    setAlias("");
    setSelectedModels([]);
    setBudget("");
    setDuration("");
    setError(null);
    setResult(null);
    setSubmitting(false);
  }, []);

  const handleSubmit = useCallback(async () => {
    const trimmed = alias.trim();
    if (!trimmed) {
      setError("请输入 Key 名称");
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const body: Record<string, unknown> = { keyAlias: trimmed };
      if (selectedModels.length > 0) body.models = selectedModels;
      if (budget) {
        const parsed = Number(budget);
        if (Number.isFinite(parsed) && parsed >= 0) body.maxBudget = parsed;
      }
      if (duration) body.duration = duration;

      const res = await fetch("/api/keys", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(typeof data.error === "string" ? data.error : "创建失败");
        return;
      }
      setResult(data as CreateKeyResult);
    } catch {
      setError("网络请求失败");
    } finally {
      setSubmitting(false);
    }
  }, [alias, selectedModels, budget, duration]);

  const handleClose = useCallback(() => {
    setOpen(false);
    resetForm();
    if (result) {
      window.dispatchEvent(new CustomEvent("litellm-portal:refresh"));
    }
  }, [result, resetForm]);

  const handleCopy = useCallback(async () => {
    if (!result?.rawKey) return;
    try {
      await navigator.clipboard.writeText(result.rawKey);
    } catch {
      const textarea = document.createElement("textarea");
      textarea.value = result.rawKey;
      textarea.style.position = "fixed";
      textarea.style.opacity = "0";
      document.body.appendChild(textarea);
      textarea.select();
      document.execCommand("copy");
      document.body.removeChild(textarea);
    }
  }, [result]);

  return (
    <Dialog.Root>
      <Dialog.Trigger
        render={(props) => (
          <Button {...props} variant="primary" size="sm">
            创建 Key
          </Button>
        )}
      />
      <Dialog size="base" className="space-y-6 p-8">
        <Dialog.Title className="text-lg font-semibold text-kumo-strong">
          {result ? "Key 已创建" : "创建新 API Key"}
        </Dialog.Title>
        <Dialog.Description className="text-sm text-kumo-subtle">
          {result
            ? "请立即复制完整 Key，关闭后无法再次查看。"
            : "创建一个新的 API Key，绑定到当前登录用户。"}
        </Dialog.Description>

        {result ? (
          <div className="space-y-5">
            <Banner
              variant="alert"
              title="请立即复制"
              description="关闭此对话框后将无法再次查看完整 Key。"
            />

            <div className="rounded-xl bg-kumo-recessed p-5 ring-1 ring-kumo-line">
              <div className="space-y-1">
                <p className="text-xs font-semibold uppercase tracking-wider text-kumo-subtle">Key 名称</p>
                <p className="text-sm font-semibold text-kumo-strong">{result.keyAlias || "—"}</p>
              </div>
              <div className="mt-4 space-y-1">
                <p className="text-xs font-semibold uppercase tracking-wider text-kumo-subtle">完整 Key</p>
                <div className="flex items-center gap-3">
                  <code className="flex-1 overflow-hidden rounded-md bg-kumo-base px-3 py-2 font-mono text-sm text-kumo-brand ring-1 ring-kumo-line">
                    {result.rawKey}
                  </code>
                  <Button variant="secondary" size="sm" onClick={handleCopy}>
                    复制
                  </Button>
                </div>
              </div>
              {result.expires ? (
                <div className="mt-4 space-y-1">
                  <p className="text-xs font-semibold uppercase tracking-wider text-kumo-subtle">过期时间</p>
                  <p className="font-mono text-sm text-kumo-default">{result.expires}</p>
                </div>
              ) : null}
            </div>

            <div className="flex justify-end">
              <Dialog.Close
                render={(props) => (
                  <Button {...props} variant="primary" onClick={handleClose}>
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
            <div className="space-y-1.5">
              <Input
                id="create-key-alias"
                label={<>名称 <span className="text-kumo-danger">*</span></>}
                size="lg"
                placeholder="例如：production-api"
                value={alias}
                onChange={(e: React.ChangeEvent<HTMLInputElement>) => setAlias(e.target.value)}
              />
            </div>

            {models.length > 0 ? (
              <div className="space-y-1.5">
                <Select
                  label="允许模型"
                  className="w-full"
                  size="lg"
                  multiple
                  placeholder="继承当前用户可用模型"
                  renderValue={(value) => {
                    const selected = selectedModelsFromValue(value);
                    if (selected.length === 0) return "继承当前用户可用模型";
                    if (selected.length > 3) return `${selected.slice(0, 2).join(", ")} 等 ${selected.length} 个模型`;
                    return selected.join(", ");
                  }}
                  value={selectedModels}
                  onValueChange={(value) => setSelectedModels(selectedModelsFromValue(value))}
                >
                  {models.map((model) => (
                    <Select.Option key={model} value={model}>
                      {model}
                    </Select.Option>
                  ))}
                </Select>
              </div>
            ) : null}

            <div className="space-y-1.5">
              <Input
                id="create-key-budget"
                label="预算上限（USD）"
                size="lg"
                type="number"
                min="0"
                step="0.01"
                placeholder="留空表示不限"
                value={budget}
                onChange={(e: React.ChangeEvent<HTMLInputElement>) => setBudget(e.target.value)}
              />
            </div>

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
                  <Button {...props} variant="secondary" onClick={handleClose}>
                    取消
                  </Button>
                )}
              />
              <Button variant="primary" loading={submitting} onClick={handleSubmit}>
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
  totalCount,
  size,
  onPrev,
  onNext,
}: {
  page: number;
  totalCount: number;
  size: number;
  onPrev: () => void;
  onNext: () => void;
}) {
  const totalPages = Math.max(1, Math.ceil(totalCount / size));
  if (totalPages <= 1) return null;
  return (
    <div className="flex items-center justify-between border-t border-kumo-line px-6 py-4">
      <span className="text-xs text-kumo-subtle">
        第 {page} / {totalPages} 页，共 {totalCount} 条
      </span>
      <div className="flex gap-2">
        <Button variant="secondary" size="sm" disabled={page <= 1} onClick={onPrev}>
          上一页
        </Button>
        <Button variant="secondary" size="sm" disabled={page >= totalPages} onClick={onNext}>
          下一页
        </Button>
      </div>
    </div>
  );
}

function AdminUsersTable() {
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
        <p className="p-6 text-sm text-kumo-subtle">暂无用户数据。</p>
      ) : (
        <div className="overflow-x-auto">
          <Table className="w-full text-left text-sm text-kumo-default">
            <Table.Header>
              <Table.Row className="border-b border-kumo-line">
                <Table.Head className="bg-kumo-base p-5 text-xs font-semibold uppercase tracking-wider text-kumo-subtle">邮箱</Table.Head>
                <Table.Head className="bg-kumo-base p-5 text-xs font-semibold uppercase tracking-wider text-kumo-subtle">角色</Table.Head>
                <Table.Head className="bg-kumo-base p-5 text-right text-xs font-semibold uppercase tracking-wider text-kumo-subtle">累计消费</Table.Head>
                <Table.Head className="bg-kumo-base p-5 text-right text-xs font-semibold uppercase tracking-wider text-kumo-subtle">Key 数</Table.Head>
                <Table.Head className="bg-kumo-base p-5 text-right text-xs font-semibold uppercase tracking-wider text-kumo-subtle">最大预算</Table.Head>
              </Table.Row>
            </Table.Header>
            <Table.Body>
              {data.users.map((user) => (
                <Table.Row key={user.userId} className="border-b border-kumo-fill transition-colors hover:bg-kumo-tint">
                  <Table.Cell className="py-3 pl-5 pr-3 font-mono text-kumo-default">{text(user.email)}</Table.Cell>
                  <Table.Cell className="py-3 pr-3 text-kumo-subtle">{text(user.role)}</Table.Cell>
                  <Table.Cell className="py-3 pr-3 text-right font-mono text-kumo-default">{fmt(user.spend)}</Table.Cell>
                  <Table.Cell className="py-3 pr-3 text-right font-mono text-kumo-default">{fmtInt(user.teamIds.length)}</Table.Cell>
                  <Table.Cell className="py-3 pr-5 text-right font-mono text-kumo-default">{user.maxBudget == null ? "—" : fmt(user.maxBudget)}</Table.Cell>
                </Table.Row>
              ))}
            </Table.Body>
          </Table>
        </div>
      )}
      {data ? (
        <AdminPager
          page={page}
          totalCount={data.totalCount}
          size={ADMIN_PAGE_SIZE}
          onPrev={() => setPage((p) => Math.max(1, p - 1))}
          onNext={() => setPage((p) => p + 1)}
        />
      ) : null}
    </div>
  );
}

function AdminTeamsTable() {
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
        <p className="p-6 text-sm text-kumo-subtle">暂无团队数据。</p>
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
              </Table.Row>
            </Table.Header>
            <Table.Body>
              {data.teams.map((team) => (
                <Table.Row key={team.id} className="border-b border-kumo-fill transition-colors hover:bg-kumo-tint">
                  <Table.Cell className="py-3 pl-5 pr-3 font-mono text-xs text-kumo-subtle">{text(team.id)}</Table.Cell>
                  <Table.Cell className="py-3 pr-3 text-kumo-default">{text(team.alias)}</Table.Cell>
                  <Table.Cell className="py-3 pr-3 text-kumo-subtle">{team.models.length > 0 ? team.models.join(", ") : "—"}</Table.Cell>
                  <Table.Cell className="py-3 pr-3 text-right font-mono text-kumo-default">{fmt(team.spend)}</Table.Cell>
                  <Table.Cell className="py-3 pr-3 text-right font-mono text-kumo-default">{team.tpmLimit == null ? "—" : fmtInt(team.tpmLimit)}</Table.Cell>
                  <Table.Cell className="py-3 pr-5 text-right font-mono text-kumo-default">{team.rpmLimit == null ? "—" : fmtInt(team.rpmLimit)}</Table.Cell>
                </Table.Row>
              ))}
            </Table.Body>
          </Table>
        </div>
      )}
    </div>
  );
}

function AdminGlobalUsage() {
  const config = useMemo(() => portalConfig(), []);
  const grains = useMemo(() => Object.keys(config.usageWindows), [config]);
  const presets = useMemo(() => usageWindowPresets(config), [config]);
  const defaultPreset = useMemo(() => {
    const defaultDayWindow = defaultWindowFor("day", config);
    return presetForWindow(defaultDayWindow, config) ?? presets.find((p) => p.grain === "day") ?? presets[0];
  }, [config, presets]);

  const [grain, setGrain] = useState(defaultPreset?.grain ?? "day");
  const [windowKey, setWindowKey] = useState(defaultPreset?.windowKey ?? defaultWindowFor("day", config));
  const [data, setData] = useState<UsageTimeseries | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const requestIdRef = useRef(0);

  const activePreset = useMemo(
    () => presets.find((p) => p.windowKey === windowKey) ?? defaultPreset,
    [defaultPreset, presets, windowKey],
  );

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

  return (
    <div>
      <div className="border-b border-kumo-line p-6">
        <div className="space-y-3">
          <div className="flex flex-wrap gap-2" role="group" aria-label="时间范围预设">
            {presets.map((preset) => (
              <button
                key={preset.windowKey}
                type="button"
                className={controlPillClass(preset.windowKey === windowKey)}
                aria-pressed={preset.windowKey === windowKey}
                onClick={() => {
                  setWindowKey(preset.windowKey);
                  setGrain(preset.grain);
                }}
              >
                {preset.label}
              </button>
            ))}
          </div>
          <div className="flex flex-wrap gap-2" role="group" aria-label="时间粒度">
            {grains.map((item) => {
              const disabled = !supportsWindowForGrain(item, windowKey, config);
              return (
                <button
                  key={item}
                  type="button"
                  className={controlPillClass(grain === item, disabled)}
                  aria-pressed={grain === item}
                  disabled={disabled}
                  onClick={() => {
                    if (!disabled) setGrain(item);
                  }}
                >
                  {usageGrainLabels[item] ?? item}
                </button>
              );
            })}
          </div>
        </div>
      </div>
      <div className="grid grid-cols-1 p-6 md:grid-cols-[2fr_1fr]">
        <div className="space-y-6">
          {error ? (
            <Banner variant="error" title="全局用量加载失败" description={error} />
          ) : null}
          <UsageSummary data={data} loading={loading} />
          <UsageChart data={data} error={error} loading={loading} />
        </div>
        <div className="mt-6 md:ml-6 md:mt-0">
          <p className="mb-5 text-sm font-semibold text-kumo-default">高频模型</p>
          <TopModels data={data} loading={loading} />
        </div>
      </div>
      {activePreset ? (
        <p className="px-6 pb-4 text-xs text-kumo-subtle">
          数据来源：/api/admin/usage/timeseries · {activePreset.label} · {usageGrainLabels[grain] ?? grain}粒度
        </p>
      ) : null}
    </div>
  );
}

function AdminAuditFeed() {
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
        <p className="p-6 text-sm text-kumo-subtle">暂无审计日志。</p>
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
              </Table.Row>
            </Table.Header>
            <Table.Body>
              {data.events.map((event) => (
                <React.Fragment key={event.id}>
                  <Table.Row className="border-b border-kumo-fill transition-colors hover:bg-kumo-tint">
                    <Table.Cell className="py-3 pl-5 pr-3 font-mono text-xs text-kumo-subtle">{event.createdAt ? event.createdAt.slice(0, 19).replace("T", " ") : "—"}</Table.Cell>
                    <Table.Cell className="py-3 pr-3 text-kumo-default">{text(event.action)}</Table.Cell>
                    <Table.Cell className="py-3 pr-3 text-kumo-default">{text(event.actorUserEmail ?? event.actorUserId)}</Table.Cell>
                    <Table.Cell className="py-3 pr-3 text-kumo-subtle">{text(event.objectType)}</Table.Cell>
                    <Table.Cell className="py-3 pr-3 font-mono text-xs text-kumo-subtle">{text(event.objectId)}</Table.Cell>
                    <Table.Cell className="py-3 pr-5">
                      <button
                        type="button"
                        className="text-xs font-semibold text-kumo-brand hover:text-kumo-brand-hover"
                        onClick={() => toggleRow(event.id)}
                        aria-expanded={expandedId === event.id}
                      >
                        {expandedId === event.id ? "收起" : "展开"}
                      </button>
                    </Table.Cell>
                  </Table.Row>
                  {expandedId === event.id ? (
                    <Table.Row className="border-b border-kumo-fill bg-kumo-recessed">
                      <Table.Cell colSpan={6} className="px-5 py-4">
                        <div className="space-y-3 text-xs">
                          <div>
                            <p className="mb-1 font-semibold uppercase tracking-wider text-kumo-subtle">变更后</p>
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
          totalCount={data.totalCount}
          size={ADMIN_PAGE_SIZE}
          onPrev={() => setPage((p) => Math.max(1, p - 1))}
          onNext={() => setPage((p) => p + 1)}
        />
      ) : null}
    </div>
  );
}

function AdminCard({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <article className="overflow-hidden rounded-xl bg-kumo-base ring-1 ring-kumo-line">
      <Collapsible.Root defaultOpen>
        <div className="flex items-center justify-between border-b border-kumo-line bg-kumo-elevated px-6 py-5">
          <p className="text-lg font-semibold text-kumo-strong">{title}</p>
          <Collapsible.DefaultTrigger className="text-sm font-medium text-kumo-brand hover:text-kumo-brand-hover" />
        </div>
        <Collapsible.Panel>
          {children}
        </Collapsible.Panel>
      </Collapsible.Root>
    </article>
  );
}

export function AdminSection({ role }: { role: PortalRole }) {
  if (role !== "admin") return null;

  return (
    <section className="space-y-8" aria-label="管理员视图（只读）">
      <div className="flex items-center gap-3">
        <h2 className="text-2xl font-semibold text-kumo-strong">管理员视图（只读）</h2>
        <Badge variant="secondary" className="rounded-full bg-kumo-warning-tint text-kumo-warning">仅管理员可见</Badge>
      </div>
      <AdminCard title="全员账户">
        <AdminUsersTable />
      </AdminCard>
      <AdminCard title="全部团队">
        <AdminTeamsTable />
      </AdminCard>
      <AdminCard title="全局用量趋势">
        <AdminGlobalUsage />
      </AdminCard>
      <AdminCard title="审计日志">
        <AdminAuditFeed />
      </AdminCard>
    </section>
  );
}

function AdminSectionLoader() {
  const [role, setRole] = useState<PortalRole>("none");

  useEffect(() => {
    fetch("/api/me", { headers: { "content-type": "application/json" } })
      .then(async (response) => {
        if (!response.ok) return;
        const body = await response.json().catch(() => ({}));
        if (body && (body.role === "admin" || body.role === "user" || body.role === "none")) {
          setRole(body.role as PortalRole);
        }
      })
      .catch(() => {});
  }, []);

  return <AdminSection role={role} />;
}

const usageRoot = document.getElementById("usage-panel-root");
if (usageRoot) {
  createRoot(usageRoot).render(<UsagePanel />);
}

const modelsRoot = document.getElementById("models-root");
if (modelsRoot) {
  createRoot(modelsRoot).render(<ModelAccessCard />);
}

const keysRoot = document.getElementById("keys-root");
if (keysRoot) {
  createRoot(keysRoot).render(<ApiKeysCard />);
}

const errorRoot = document.getElementById("portal-error-root");
if (errorRoot) {
  createRoot(errorRoot).render(<PortalErrorBanner />);
}

const adminRoot = document.getElementById("admin-root");
if (adminRoot) {
  createRoot(adminRoot).render(<AdminSectionLoader />);
}
