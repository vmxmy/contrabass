export type ModelAccess = {
  models: string[];
  source: string;
};

export type UsageWindowOption = {
  key: string;
  label: string;
};

export type PortalConfig = {
  usageWindows?: Record<string, UsageWindowOption[]>;
  defaultUsageWindows?: Record<string, string>;
};

export type PortalKey = {
  id?: string | null;
  alias?: string | null;
  displayKey?: string | null;
  models?: string[];
  spend?: number | null;
  maxBudget?: number | null;
  expiresAt?: string | null;
};

export type PortalTeam = {
  id?: string | null;
  alias?: string | null;
  models?: string[] | null;
  spend?: number | null;
  maxBudget?: number | null;
  tpmLimit?: number | null;
  rpmLimit?: number | null;
};

export type PortalStats = {
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

export const PREVIEW_LIMIT = 12;
export const MODEL_CELL_PREVIEW_LIMIT = 3;

export const sourceLabels: Record<string, string> = {
  team: "来自当前用户所属团队配置",
  team_unrestricted: "当前团队未限制模型，显示 LiteLLM 可用模型",
  configured: "来自 Worker 模型白名单",
  litellm: "来自 LiteLLM 全局模型",
};

export function normalizeModelAccess(value: unknown): ModelAccess {
  if (!value || typeof value !== "object") {
    return { models: [], source: "" };
  }
  const record = value as Partial<ModelAccess>;
  return {
    models: Array.isArray(record.models) ? record.models.filter((item): item is string => typeof item === "string") : [],
    source: typeof record.source === "string" ? record.source : "",
  };
}

export function normalizeKeys(value: unknown): PortalKey[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is PortalKey => item !== null && typeof item === "object");
}

export function normalizeTeams(value: unknown): PortalTeam[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is PortalTeam => item !== null && typeof item === "object");
}

export function sourceLabel(source: string): string {
  return sourceLabels[source] ?? "模型清单已按服务端权限过滤";
}

export function text(value: unknown): string {
  return value == null || value === "" ? "—" : String(value);
}

export function keyLabel(key: PortalKey): string {
  return text(key.alias ?? key.displayKey ?? key.id);
}

export function modelBadgeColor(model: string): string {
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

export function statusTone(spend: unknown, maxBudget: unknown): "danger" | "warning" | "success" | null {
  if (maxBudget == null) return null;
  const ratio = Number(spend || 0) / Number(maxBudget);
  if (ratio >= 1) return "danger";
  if (ratio >= 0.8) return "warning";
  return "success";
}

export function budgetLabel(tone: "danger" | "warning" | "success"): string {
  if (tone === "danger") return "超预算";
  if (tone === "warning") return "即将超支";
  return "正常";
}

export function deleteKeyErrorMessage(value: unknown): string {
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

export const NEVER_EXPIRES_VALUE = "never";

export const DURATION_OPTIONS = [
  { value: NEVER_EXPIRES_VALUE, label: "永不过期" },
  { value: "7d", label: "7 天" },
  { value: "30d", label: "30 天" },
  { value: "90d", label: "90 天" },
  { value: "365d", label: "365 天" },
];

export function durationFromSelectValue(value: unknown): string {
  const selected = typeof value === "string" ? value : NEVER_EXPIRES_VALUE;
  return selected === NEVER_EXPIRES_VALUE ? "" : selected;
}

export function selectedModelsFromValue(value: unknown): string[] {
  if (!Array.isArray(value)) return typeof value === "string" ? [value] : [];
  return value.filter((item): item is string => typeof item === "string");
}

export function createKeyErrorMessage(value: unknown): string {
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
