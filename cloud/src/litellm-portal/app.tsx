import { Badge } from "@cloudflare/kumo/components/badge";
import { Banner } from "@cloudflare/kumo/components/banner";
import { Button } from "@cloudflare/kumo/components/button";
import { ClipboardText } from "@cloudflare/kumo/components/clipboard-text";
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
  week: [{ key: "12w", label: "近 12 周" }],
  month: [{ key: "12mo", label: "近 12 个月" }],
};

const fallbackDefaultUsageWindows: Record<string, string> = {
  minute: "6h",
  hour: "48h",
  day: "30d",
  week: "12w",
  month: "12mo",
};

const usageGrainLabels: Record<string, string> = {
  minute: "分钟",
  hour: "小时",
  day: "天",
  week: "周",
  month: "月",
};

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
  const [grain, setGrain] = useState("day");
  const [windowKey, setWindowKey] = useState(defaultWindowFor("day", config));
  const [data, setData] = useState<UsageTimeseries | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const requestIdRef = useRef(0);

  const windows = usageWindowOptions(grain, config);

  useEffect(() => {
    if (!windows.some((option) => option.key === windowKey)) {
      setWindowKey(defaultWindowFor(grain, config));
    }
  }, [config, grain, windowKey, windows]);

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

  const selectedWindowLabel = windows.find((option) => option.key === windowKey)?.label ?? "当前窗口";
  const windowText = data
    ? `${data.windowLabel} · ${usageGrainLabels[data.grain] ?? data.grain} · ${text(data.start).slice(0, 10)} 至 ${text(data.end).slice(0, 10)}${data.limited ? " · 已达到分页上限" : ""}`
    : `可切换分钟、小时、天、周、月粒度，用于排查突增和查看管理趋势。当前：${selectedWindowLabel} · ${usageGrainLabels[grain] ?? grain}`;

  return (
    <article id="usage-panel" className="overflow-hidden rounded-xl bg-kumo-base ring-1 ring-kumo-line" aria-busy={loading}>
      <div className="grid gap-6 border-b border-kumo-line bg-kumo-elevated p-6 md:grid-cols-[2fr_1fr]">
        <div className="space-y-2">
          <p className="text-lg font-semibold text-kumo-strong">Token 用量趋势</p>
          <p className="text-sm leading-relaxed text-kumo-subtle">{windowText}</p>
        </div>
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          <Select
            label="时间粒度"
            size="lg"
            value={grain}
            renderValue={(value) => usageGrainLabels[String(value)] ?? String(value)}
            onValueChange={(value) => setGrain(String(value))}
          >
            {grains.map((item) => (
              <Select.Option key={item} value={item}>
                {usageGrainLabels[item] ?? item}
              </Select.Option>
            ))}
          </Select>
          <Select
            label="时间范围"
            size="lg"
            value={windowKey}
            renderValue={(value) => windows.find((option) => option.key === String(value))?.label ?? String(value)}
            onValueChange={(value) => setWindowKey(String(value))}
          >
            {windows.map((option) => (
              <Select.Option key={option.key} value={option.key}>
                {option.label}
              </Select.Option>
            ))}
          </Select>
        </div>
      </div>
      <div className="grid grid-cols-1 md:grid-cols-[2fr_1fr]">
        <div className="space-y-8 p-8">
          {error ? (
            <Banner variant="error" title="用量数据加载失败" description={error} />
          ) : null}
          <UsageSummary data={data} loading={loading} />
          <UsageChart data={data} error={error} loading={loading} />
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
      <div className="border-b border-kumo-line bg-kumo-elevated p-6">
        <p className="text-lg font-semibold text-kumo-strong">API Keys</p>
        <p className="text-sm text-kumo-subtle">仅列出当前 LiteLLM 用户拥有的密钥。</p>
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
                      <ClipboardText
                        text={displayKey}
                        size="sm"
                        tooltip={{ text: "复制", copiedText: "已复制", side: "top" }}
                        labels={{ copyAction: "复制 API Key 显示值" }}
                      />
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

const DURATION_OPTIONS = [
  { value: "", label: "永不过期" },
  { value: "7d", label: "7 天" },
  { value: "30d", label: "30 天" },
  { value: "90d", label: "90 天" },
  { value: "365d", label: "365 天" },
];

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
    if (result) {
      resetForm();
      window.dispatchEvent(new CustomEvent("litellm-portal:refresh"));
    } else {
      resetForm();
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
      <Dialog size="base" className="p-8">
        <Dialog.Title className="text-lg font-semibold text-kumo-strong">
          {result ? "Key 已创建" : "创建新 API Key"}
        </Dialog.Title>

        {result ? (
          <div className="mt-4 space-y-4">
            <Banner
              variant="warning"
              title="请立即复制"
              description="关闭此对话框后将无法再次查看完整 Key。"
            />
            <div className="rounded-lg bg-kumo-recessed p-4">
              <p className="mb-1 text-xs font-medium text-kumo-subtle">Key 名称</p>
              <p className="font-semibold text-kumo-strong">{result.keyAlias || "—"}</p>
              <p className="mt-3 mb-1 text-xs font-medium text-kumo-subtle">完整 Key</p>
              <div className="flex items-center gap-2">
                <code className="flex-1 break-all font-mono text-sm text-kumo-brand">{result.rawKey}</code>
                <Button variant="secondary" size="sm" onClick={handleCopy}>
                  复制
                </Button>
              </div>
              {result.expires ? (
                <p className="mt-3 text-xs text-kumo-subtle">过期时间：{result.expires}</p>
              ) : null}
            </div>
            <Dialog.Close
              render={(props) => (
                <Button {...props} variant="primary" onClick={handleClose} className="w-full">
                  已复制，关闭
                </Button>
              )}
            />
          </div>
        ) : (
          <div className="mt-4 space-y-5">
            {error ? (
              <Banner variant="error" title="创建失败" description={error} />
            ) : null}
            <div className="space-y-1.5">
              <label className="text-sm font-medium text-kumo-default" htmlFor="create-key-alias">
                名称 <span className="text-kumo-danger">*</span>
              </label>
              <Input
                id="create-key-alias"
                size="lg"
                placeholder="例如：production-api"
                value={alias}
                onChange={(e: React.ChangeEvent<HTMLInputElement>) => setAlias(e.target.value)}
              />
            </div>

            {models.length > 0 ? (
              <div className="space-y-1.5">
                <label className="text-sm font-medium text-kumo-default">允许模型</label>
                <Select
                  label="允许模型"
                  size="lg"
                  value={selectedModels}
                  onValueChange={(value) => setSelectedModels(Array.isArray(value) ? value.map(String) : [String(value)])}
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
              <label className="text-sm font-medium text-kumo-default" htmlFor="create-key-budget">
                预算上限（USD）
              </label>
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
            </div>

            <div className="space-y-1.5">
              <label className="text-sm font-medium text-kumo-default">有效期</label>
              <Select
                label="有效期"
                size="lg"
                value={duration || ""}
                onValueChange={(value) => setDuration(String(value))}
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

const createKeyRoot = document.getElementById("create-key-root");
if (createKeyRoot) {
  createRoot(createKeyRoot).render(<CreateKeyButton />);
}
