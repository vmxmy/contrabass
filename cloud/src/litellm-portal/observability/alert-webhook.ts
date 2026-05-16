import { z } from "zod";

export const BudgetAlertPayloadSchema = z.object({
  type: z.literal("budget_threshold"),
  teamId: z.string(),
  teamAlias: z.string().nullable(),
  currentSpend: z.number(),
  maxBudget: z.number(),
  ratio: z.number(),
  threshold: z.number(),
  cycleKey: z.string(),
  firedAt: z.string(),
}).strict();

export type BudgetAlertPayload = z.infer<typeof BudgetAlertPayloadSchema>;

function isPrivateIPv4(host: string): boolean {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  if ([a, Number(m[3]), Number(m[4])].some((n) => n > 255) || a > 255) return true; // malformed → unsafe
  if (a === 10) return true;
  if (a === 127) return true;
  if (a === 0) return true;
  if (a === 169 && b === 254) return true; // link-local + cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  return false;
}

function isUnsafeIPv6(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, "").toLowerCase();
  if (h === "::1" || h === "::") return true;
  if (h.startsWith("fe80:") || h.startsWith("fe80::")) return true; // link-local
  if (h.startsWith("fc") || h.startsWith("fd")) return true; // unique-local fc00::/7
  return false;
}

/** Best-effort SSRF guard. Workers cannot DNS-resolve at config time, so this
 *  is a literal-IP + hostname denylist. https-only; blocks loopback, private,
 *  link-local, cloud metadata, userinfo, and bare single-label hosts. */
export function isSafeWebhookHost(rawUrl: string): boolean {
  let u: URL;
  try {
    u = new URL(rawUrl);
  } catch {
    return false;
  }
  if (u.protocol !== "https:") return false;
  if (u.username || u.password) return false;
  const host = u.hostname.toLowerCase();
  if (host.length === 0) return false;
  if (host === "localhost" || host.endsWith(".localhost")) return false;
  if (host === "metadata.google.internal") return false;
  if (host.includes(":") || u.hostname.startsWith("[")) return isUnsafeIPv6(host) ? false : true;
  if (isPrivateIPv4(host)) return false;
  // Reject bare single-label hosts (e.g. "intranet") — require an FQDN.
  if (!host.includes(".")) return false;
  return true;
}

/** POST a budget alert. Never throws; returns a result the caller logs and
 *  continues from (the snapshot loop's per-team isolation is the safety net). */
export async function postAlertWebhook(
  url: string,
  payload: BudgetAlertPayload,
  timeoutMs = 5000,
): Promise<{ ok: boolean; status: number | null; error?: string }> {
  const parsed = BudgetAlertPayloadSchema.safeParse(payload);
  if (!parsed.success) {
    return { ok: false, status: null, error: "invalid_payload" };
  }
  if (!isSafeWebhookHost(url)) {
    return { ok: false, status: null, error: "blocked_host" };
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      method: "POST",
      redirect: "manual",
      headers: { "content-type": "application/json", "user-agent": "zhiyun-portal-alert/1" },
      body: JSON.stringify(parsed.data),
      signal: controller.signal,
    });
    return { ok: response.ok, status: response.status };
  } catch (err) {
    return { ok: false, status: null, error: err instanceof Error ? err.message : "fetch_failed" };
  } finally {
    clearTimeout(timer);
  }
}
