import { afterEach, describe, expect, it, vi } from "vitest";

import worker, { handleLiteLLMPortalRequest, type LiteLLMPortalEnv } from "./index";
import { scanBudgetThresholds, sendEmail } from "./notifications";
import { KVUserPrefsStore, sha256Hex } from "./preferences";
import type { KVNamespace } from "./types";
import { _clearRoleCacheForTests } from "./roles";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.useRealTimers();
  _clearRoleCacheForTests();
});

describe("user preferences API", () => {
  it("returns defaults, stores partial updates under sha256(email), and inherits global defaults", async () => {
    const kv = new MemoryKV();
    const env = portalEnv({ USER_PREFS_KV: kv });
    globalThis.fetch = litellmIdentityFetch("liqingying@gz-zhiyun.com", "internal_user");

    await new KVUserPrefsStore(kv).patchGlobalDefaults({ defaultUsageWindow: "7d", language: "en" });

    const initial = await handleLiteLLMPortalRequest(
      devRequest("https://portal.test/api/me/preferences", "liqingying@gz-zhiyun.com"),
      env,
    );
    expect(initial.status).toBe(200);
    await expect(initial.json()).resolves.toMatchObject({
      theme: "auto",
      defaultUsageWindow: "7d",
      language: "en",
      notifications: { budgetThreshold: 0.8, budgetThresholdEnabled: true },
    });

    const patched = await handleLiteLLMPortalRequest(
      devRequest("https://portal.test/api/me/preferences", "liqingying@gz-zhiyun.com", {
        method: "PATCH",
        body: JSON.stringify({ theme: "dark", notifications: { budgetThresholdEnabled: false } }),
      }),
      env,
    );

    expect(patched.status).toBe(200);
    await expect(patched.json()).resolves.toMatchObject({
      theme: "dark",
      defaultUsageWindow: "7d",
      notifications: { budgetThresholdEnabled: false, budgetThreshold: 0.8 },
    });

    const hashedKey = await sha256Hex("liqingying@gz-zhiyun.com");
    expect(kv.dump().has(hashedKey)).toBe(true);
    expect(kv.dump().has("liqingying@gz-zhiyun.com")).toBe(false);
  });
});

describe("MailChannels notifications", () => {
  it("posts rendered template content to MailChannels", async () => {
    const requests: Array<{ url: string; body: string }> = [];
    globalThis.fetch = vi.fn(async (input, init) => {
      requests.push({ url: String(input), body: String(init?.body ?? "") });
      return new Response(null, { status: 202 });
    }) as typeof fetch;

    await sendEmail("user@gz-zhiyun.com", "budgetThreshold", {
      spend: 81,
      maxBudget: 100,
      threshold: 0.8,
      ratio: 0.81,
    });

    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe("https://api.mailchannels.net/tx/v1/send");
    const body = JSON.parse(requests[0]?.body ?? "{}") as Record<string, unknown>;
    expect(body).toMatchObject({
      from: { email: "no-reply@ziikoo.com", name: "智云AI管理平台" },
      subject: "预算提醒：当前用量已达到 81%",
    });
    expect(JSON.stringify(body)).toContain("user@gz-zhiyun.com");
    expect(JSON.stringify(body)).toContain("$81.00");
  });
});

describe("cron budget threshold scanner", () => {
  it("fails closed when the preferences KV binding is missing", async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new Error("fetch_should_not_run");
    }) as typeof fetch;

    await expect(scanBudgetThresholds(portalEnv({ USER_PREFS_KV: undefined }))).resolves.toEqual({
      scannedUsers: 0,
      emailedUsers: 0,
      skippedUsers: 0,
      failedUsers: 0,
    });
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("scheduled handler emails threshold users once per calendar day", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-13T09:00:00.000Z"));
    const kv = new MemoryKV();
    await new KVUserPrefsStore(kv).patchForEmail("over@gz-zhiyun.com", {
      notifications: { budgetThresholdEnabled: true, budgetThreshold: 0.8 },
    });
    const mailBodies: string[] = [];
    globalThis.fetch = vi.fn(async (input, init) => {
      const url = String(input);
      if (url === "https://litellm.test/user/list?page=1&page_size=100") {
        return Response.json({
          users: [
            { user_id: "over", user_email: "over@gz-zhiyun.com", spend: 81, max_budget: 100 },
            { user_id: "under", user_email: "under@gz-zhiyun.com", spend: 10, max_budget: 100 },
          ],
          total_count: 2,
        });
      }
      if (url === "https://api.mailchannels.net/tx/v1/send") {
        mailBodies.push(String(init?.body ?? ""));
        return new Response(null, { status: 202 });
      }
      return new Response("not found", { status: 404 });
    }) as typeof fetch;

    const waitUntilPromises: Promise<unknown>[] = [];
    const ctx: ExecutionContext = {
      waitUntil: (promise: Promise<unknown>) => waitUntilPromises.push(promise),
      passThroughOnException: () => undefined,
      props: {},
    };
    const controller: ScheduledController = {
      scheduledTime: Date.now(),
      cron: "0 9 * * *",
      noRetry: () => undefined,
    };

    await worker.scheduled?.(controller, portalEnv({ USER_PREFS_KV: kv }), ctx);
    await Promise.all(waitUntilPromises);
    await worker.scheduled?.(controller, portalEnv({ USER_PREFS_KV: kv }), ctx);
    await Promise.all(waitUntilPromises);

    expect(mailBodies).toHaveLength(1);
    expect(mailBodies[0]).toContain("over@gz-zhiyun.com");
    expect(mailBodies[0]).not.toContain("under@gz-zhiyun.com");
  });

  it("does not send budget notifications to users outside the portal allowlist", async () => {
    const kv = new MemoryKV();
    globalThis.fetch = vi.fn(async (input) => {
      const url = String(input);
      if (url === "https://litellm.test/user/list?page=1&page_size=100") {
        return Response.json({
          users: [{ user_id: "outside", user_email: "outside@example.com", spend: 99, max_budget: 100 }],
          total_count: 1,
        });
      }
      if (url === "https://api.mailchannels.net/tx/v1/send") {
        throw new Error("mailchannels_should_not_be_called");
      }
      return new Response("not found", { status: 404 });
    }) as typeof fetch;

    await expect(scanBudgetThresholds(portalEnv({ USER_PREFS_KV: kv }), new Date("2026-05-13T09:00:00.000Z"))).resolves.toEqual({
      scannedUsers: 1,
      emailedUsers: 0,
      skippedUsers: 1,
      failedUsers: 0,
    });
  });

  it("continues scanning when one MailChannels send fails", async () => {
    const kv = new MemoryKV();
    const mailBodies: string[] = [];
    globalThis.fetch = vi.fn(async (input, init) => {
      const url = String(input);
      if (url === "https://litellm.test/user/list?page=1&page_size=100") {
        return Response.json({
          users: [
            { user_id: "first", user_email: "first@gz-zhiyun.com", spend: 81, max_budget: 100 },
            { user_id: "second", user_email: "second@gz-zhiyun.com", spend: 90, max_budget: 100 },
          ],
          total_count: 2,
        });
      }
      if (url === "https://api.mailchannels.net/tx/v1/send") {
        const body = String(init?.body ?? "");
        if (body.includes("first@gz-zhiyun.com")) {
          return new Response("temporarily unavailable", { status: 503 });
        }
        mailBodies.push(body);
        return new Response(null, { status: 202 });
      }
      return new Response("not found", { status: 404 });
    }) as typeof fetch;

    await expect(scanBudgetThresholds(portalEnv({ USER_PREFS_KV: kv }), new Date("2026-05-13T09:00:00.000Z"))).resolves.toMatchObject({
      scannedUsers: 2,
      emailedUsers: 1,
      skippedUsers: 0,
      failedUsers: 1,
    });
    expect(mailBodies).toHaveLength(1);
    expect(mailBodies[0]).toContain("second@gz-zhiyun.com");
  });
});

class MemoryKV implements KVNamespace {
  private readonly values = new Map<string, string>();

  async get(key: string): Promise<string | null> {
    return this.values.get(key) ?? null;
  }

  async put(key: string, value: string): Promise<void> {
    this.values.set(key, value);
  }

  async delete(key: string): Promise<void> {
    this.values.delete(key);
  }

  dump(): Map<string, string> {
    return new Map(this.values);
  }
}

function portalEnv(overrides: Partial<LiteLLMPortalEnv> = {}): LiteLLMPortalEnv {
  return {
    CLOUDFLARE_ACCESS_AUD: "access-aud",
    CLOUDFLARE_ACCESS_TEAM_DOMAIN: "https://gz-zhiyun.cloudflareaccess.com",
    LITELLM_ALLOWED_MODELS: "gpt-4o-mini",
    LITELLM_BASE_URL: "https://litellm.test",
    LITELLM_MASTER_KEY: "litellm-master",
    LITELLM_PORTAL_ALLOWED_EMAIL_DOMAIN: "gz-zhiyun.com",
    LITELLM_PORTAL_DEV_AUTH: "true",
    ...overrides,
  };
}

function devRequest(url: string, email: string, init: RequestInit = {}): Request {
  const headers = new Headers(init.headers);
  headers.set("x-litellm-portal-dev-email", email);
  if (init.body !== undefined) {
    headers.set("content-type", "application/json");
  }
  return new Request(url, { ...init, headers });
}

function litellmIdentityFetch(email: string, role: string): typeof fetch {
  return vi.fn(async (input) => {
    if (String(input) === `https://litellm.test/user/list?user_email=${encodeURIComponent(email)}`) {
      return Response.json({ users: [{ user_id: email, user_email: email, user_role: role }] });
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
}
