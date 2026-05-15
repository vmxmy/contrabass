import type { SyncMessage } from "./durable/schemas";

export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

export interface AnalyticsEngineDataset {
  writeDataPoint(point: { blobs?: string[]; doubles?: number[]; indexes?: string[] }): void;
}

export type KVNamespace = {
  get(key: string, opts?: { type?: string }): Promise<string | null>;
  put(key: string, value: string, opts?: { expirationTtl?: number }): Promise<void>;
  delete(key: string): Promise<void>;
};

export type LiteLLMPortalEnv = {
  LITELLM_ALLOWED_MODELS?: string;
  LITELLM_BASE_URL?: string;
  LITELLM_MASTER_KEY?: string;
  LITELLM_PORTAL_ALLOWED_EMAIL_DOMAIN?: string;
  LITELLM_PORTAL_ALLOWED_EMAILS?: string;
  LITELLM_PORTAL_COMPANY_NAME?: string;
  LITELLM_PORTAL_DEV_AUTH?: string;
  LITELLM_PORTAL_DISPLAY_NAME?: string;
  LITELLM_PORTAL_WRITE_OPS_ENABLED?: string;
  METRICS_AE?: AnalyticsEngineDataset;
  AUDIT_AE?: AnalyticsEngineDataset;
  USER_PREFS_KV?: KVNamespace;
  ROLE_INVALIDATION_WEBHOOK_TOKEN?: string;
  RATE_LIMIT_DO?: DurableObjectNamespace;
  /** HMAC secret used to sign portal session cookies (HS256). 7-day TTL. */
  PORTAL_SESSION_SECRET?: string;
  /** HMAC secret used to sign 15-minute magic-link tokens. */
  PORTAL_MAGIC_LINK_SECRET?: string;
  /** Cloudflare Email Service Workers binding (paid plan, no recipient
   *  whitelist). Configure in wrangler.toml with `[[send_email]] name="EMAIL"
   *  remote = true`. Sender domain must be onboarded in Email Sending dashboard. */
  EMAIL?: SendEmail;
  /** From address for outbound mail. Must be on a Cloudflare-Email-Sending
   *  verified domain. Defaults to noreply@ziikoo.com. */
  PORTAL_MAIL_FROM?: string;
  /** Comma-separated list of allowed email domains for magic-link login.
   *  Match is case-insensitive. Example: "gz-zhiyun.com,partner.example". */
  PORTAL_ALLOWED_EMAIL_DOMAINS?: string;
  /** Comma-separated list of emails granted role=admin on first login or
   *  during the one-shot LiteLLM import. Survives removal from this var. */
  BOOTSTRAP_ADMIN_EMAILS?: string;
  /** Singleton IndexDO owning team list, email→user index, magic-link nonces,
   *  bootstrap admins, and audit log. See openspec change
   *  `portal-do-config-source-of-truth` capability `portal-config-source-of-truth`. */
  INDEX_DO?: DurableObjectNamespace;
  /** Per-team TeamConfigDO (id = teamId) owning team metadata, members, keys,
   *  spend snapshot, and sync metadata. See openspec change
   *  `portal-do-config-source-of-truth`. */
  TEAM_CONFIG_DO?: DurableObjectNamespace;
  /** Producer binding for the `litellm-sync` Cloudflare Queue. Each admin
   *  write enqueues a SyncMessage after the DO commit; a consumer Worker
   *  materializes the desired state into LiteLLM with retries + DLQ. */
  LITELLM_SYNC_QUEUE?: Queue<SyncMessage>;
  /** Producer binding for the `litellm-sync-dlq` dead-letter queue. The
   *  consumer forwards messages here on terminal failure. */
  LITELLM_SYNC_DLQ?: Queue<SyncMessage>;
};

export type PortalPrincipal = {
  email: string;
  userId: string;
  domain: string;
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
