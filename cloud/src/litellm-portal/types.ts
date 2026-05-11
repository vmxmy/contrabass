export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

export type LiteLLMPortalEnv = {
  CLOUDFLARE_ACCESS_AUD?: string;
  CLOUDFLARE_ACCESS_TEAM_DOMAIN?: string;
  LITELLM_ALLOWED_MODELS?: string;
  LITELLM_BASE_URL?: string;
  LITELLM_MASTER_KEY?: string;
  LITELLM_PORTAL_ALLOWED_EMAIL_DOMAIN?: string;
  LITELLM_PORTAL_ALLOWED_EMAILS?: string;
  LITELLM_PORTAL_COMPANY_NAME?: string;
  LITELLM_PORTAL_DEV_AUTH?: string;
  LITELLM_PORTAL_DISPLAY_NAME?: string;
};

export type PortalPrincipal = {
  email: string;
  userId: string;
  domain: string;
};

export type AccessJwtPayload = {
  aud?: string | string[];
  email?: string;
  exp?: number;
  iss?: string;
  nbf?: number;
};

export type AccessJwk = JsonWebKey & {
  kid?: string;
};

export type AccessJwksResponse = {
  keys?: AccessJwk[];
};

export type AuthResult =
  | { ok: true; principal: PortalPrincipal }
  | { ok: false; status: 401 | 403 | 500; error: string };

export type PortalRole = "admin" | "user" | "none";

export type PortalIdentity = PortalPrincipal & {
  litellmUserId: string;
  role: PortalRole;
};

export type IdentityResult =
  | { ok: true; identity: PortalIdentity }
  | { ok: false; status: 401 | 403 | 500 | 502; error: string };

export type LiteLLMKey = {
  id: string;
  alias: string | null;
  displayKey: string | null;
  userId: string;
  teamId: string | null;
  models: string[];
  spend: number;
  maxBudget: number | null;
  createdAt: string | null;
  expiresAt: string | null;
  blocked: boolean | null;
  raw: Record<string, unknown>;
};

export type LiteLLMKeyList = {
  keys: LiteLLMKey[];
  totalCount: number;
};

export type LiteLLMUser = {
  userId: string;
  email: string;
  spend: number | null;
  maxBudget: number | null;
  teamIds: string[];
  role: string | null;
  found: boolean;
  raw: Record<string, unknown> | null;
};

export type LiteLLMTeam = {
  id: string;
  alias: string | null;
  models: string[];
  spend: number | null;
  maxBudget: number | null;
  tpmLimit: number | null;
  rpmLimit: number | null;
  blocked: boolean | null;
  budgetDuration: string | null;
  budgetResetAt: string | null;
};

export type LiteLLMUsageDay = {
  date: string;
  spend: number;
  totalTokens: number;
  promptTokens: number;
  completionTokens: number;
  requests: number;
};

export type LiteLLMModelUsage = {
  model: string;
  spend: number;
  totalTokens: number;
  requests: number;
};

export type LiteLLMUsageAnalytics = {
  available: boolean;
  startDate: string;
  endDate: string;
  totalSpend: number;
  totalTokens: number;
  requestCount: number;
  successfulRequests: number;
  failedRequests: number;
  days: LiteLLMUsageDay[];
  topModels: LiteLLMModelUsage[];
};

export type UsageGrain = "minute" | "hour" | "day" | "month";

export type UsageWindowOption = {
  key: string;
  label: string;
  hours?: number;
  days?: number;
  months?: number;
};

export type UsageBucket = {
  start: string;
  end: string;
  label: string;
  totalTokens: number;
  promptTokens: number;
  completionTokens: number;
  requests: number;
  spend: number;
};

export type UsageTotals = {
  totalTokens: number;
  promptTokens: number;
  completionTokens: number;
  requests: number;
  spend: number;
};

export type UsageTimeseries = {
  available: boolean;
  grain: UsageGrain;
  window: string;
  windowLabel: string;
  start: string;
  end: string;
  source: "spend_logs_v2" | "spend_logs_v2_global" | "user_daily_activity";
  timezone: string;
  limited: boolean;
  maxPages: number | null;
  buckets: UsageBucket[];
  totals: UsageTotals;
  topModels: LiteLLMModelUsage[];
};

export type LiteLLMAuditEvent = {
  id: string;
  createdAt: string | null;
  action: string;
  actorUserId: string | null;
  actorUserEmail: string | null;
  objectType: string | null;
  objectId: string | null;
};
