import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { recordMetric } from "./metrics";
import { recordAudit } from "./audit";
import { checkClientErrorRateLimit, _clearRateLimitStoreForTests } from "./client-error";
import type { LiteLLMPortalEnv } from "../types";
import { handleLiteLLMPortalRequest } from "../index";
import { _clearRoleCacheForTests } from "../roles";
import { issueSession, SESSION_COOKIE_NAME } from "../auth/session";

const TEST_SESSION_SECRET = "test-session-secret-for-dev-request";
const _cookieCache = new Map<string, string>();

const _testEmails = [
  "test@gz-zhiyun.com",
  "admin@gz-zhiyun.com",
];

beforeAll(async () => {
  const env: LiteLLMPortalEnv = { PORTAL_SESSION_SECRET: TEST_SESSION_SECRET };
  await Promise.all(
    _testEmails.map(async (email) => {
      const value = await issueSession(env, { email, userId: email });
      _cookieCache.set(email, value);
    }),
  );
});

afterEach(() => {
  _clearRateLimitStoreForTests();
  _clearRoleCacheForTests();
});

// --- metrics.ts ---

describe("recordMetric", () => {
  it("is a no-op when METRICS_AE binding is missing", () => {
    const env: LiteLLMPortalEnv = {};
    // Should not throw
    expect(() =>
      recordMetric(env, { route: "/api/me", status: 200, latencyMs: 10, upstreamMs: 5, role: "user", cacheHit: false }),
    ).not.toThrow();
  });

  it("calls writeDataPoint once with correct fields", () => {
    const writeDataPoint = vi.fn();
    const env: LiteLLMPortalEnv = { METRICS_AE: { writeDataPoint } };
    recordMetric(env, { route: "/api/dashboard", status: 200, latencyMs: 42, upstreamMs: 20, role: "admin", cacheHit: true });
    expect(writeDataPoint).toHaveBeenCalledTimes(1);
    const [point] = writeDataPoint.mock.calls[0];
    expect(point.blobs).toContain("/api/dashboard");
    expect(point.blobs).toContain("200");
    expect(point.blobs).toContain("admin");
    expect(point.doubles).toContain(42);
    expect(point.doubles).toContain(20);
    expect(point.indexes).toContain("1"); // cacheHit=true
  });

  it("marks cacheHit=false as index '0'", () => {
    const writeDataPoint = vi.fn();
    const env: LiteLLMPortalEnv = { METRICS_AE: { writeDataPoint } };
    recordMetric(env, { route: "/api/keys", status: 200, latencyMs: 5, upstreamMs: 2, role: "user", cacheHit: false });
    const [point] = writeDataPoint.mock.calls[0];
    expect(point.indexes).toContain("0");
  });
});

// --- audit.ts ---

describe("recordAudit", () => {
  it("is a no-op when AUDIT_AE binding is missing", () => {
    const env: LiteLLMPortalEnv = {};
    expect(() =>
      recordAudit(env, { actor: "admin@test.com", action: "/api/admin/users", target: "", ip: "1.2.3.4", ts: "2026-01-01T00:00:00.000Z" }),
    ).not.toThrow();
  });

  it("calls writeDataPoint with actor and action", () => {
    const writeDataPoint = vi.fn();
    const env: LiteLLMPortalEnv = { AUDIT_AE: { writeDataPoint } };
    recordAudit(env, { actor: "admin@test.com", action: "/api/admin/users", target: "page=2", ip: "1.2.3.4", ts: "2026-01-01T00:00:00.000Z" });
    expect(writeDataPoint).toHaveBeenCalledTimes(1);
    const [point] = writeDataPoint.mock.calls[0];
    expect(point.blobs).toContain("admin@test.com");
    expect(point.blobs).toContain("/api/admin/users");
    expect(point.blobs).toContain("page=2");
    expect(point.blobs).toContain("1.2.3.4");
  });
});

// --- rate limiter ---

describe("checkClientErrorRateLimit", () => {
  it("allows up to 30 events per session in a window", () => {
    for (let i = 0; i < 30; i++) {
      expect(checkClientErrorRateLimit("session-a")).toBe(true);
    }
    expect(checkClientErrorRateLimit("session-a")).toBe(false);
  });

  it("different sessions have independent limits", () => {
    for (let i = 0; i < 30; i++) {
      checkClientErrorRateLimit("session-x");
    }
    expect(checkClientErrorRateLimit("session-y")).toBe(true);
  });

  it("resets after the time window", () => {
    vi.useFakeTimers();
    for (let i = 0; i < 30; i++) {
      checkClientErrorRateLimit("session-b");
    }
    expect(checkClientErrorRateLimit("session-b")).toBe(false);
    vi.advanceTimersByTime(61_000);
    expect(checkClientErrorRateLimit("session-b")).toBe(true);
    vi.useRealTimers();
  });
});

// --- /api/_internal/client-error endpoint ---

describe("POST /api/_internal/client-error", () => {
  function makeEnv(extras: Partial<LiteLLMPortalEnv> = {}): LiteLLMPortalEnv {
    return { LITELLM_BASE_URL: "https://litellm.test", PORTAL_SESSION_SECRET: TEST_SESSION_SECRET, ...extras };
  }

  it("accepts a valid payload and returns ok", async () => {
    const response = await handleLiteLLMPortalRequest(
      new Request("https://portal.test/api/_internal/client-error", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ events: [{ message: "boom", sessionId: "s1", ts: "2026-01-01T00:00:00Z" }] }),
      }),
      makeEnv(),
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true });
  });

  it("returns 400 for missing events", async () => {
    const response = await handleLiteLLMPortalRequest(
      new Request("https://portal.test/api/_internal/client-error", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ events: [] }),
      }),
      makeEnv(),
    );
    expect(response.status).toBe(400);
  });

  it("returns 400 for invalid JSON", async () => {
    const response = await handleLiteLLMPortalRequest(
      new Request("https://portal.test/api/_internal/client-error", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "not-json",
      }),
      makeEnv(),
    );
    expect(response.status).toBe(400);
  });

  it("returns 429 after exceeding rate limit", async () => {
    // exhaust the rate limit for session "rate-test-session"
    for (let i = 0; i < 30; i++) {
      checkClientErrorRateLimit("rate-test-session");
    }
    const response = await handleLiteLLMPortalRequest(
      new Request("https://portal.test/api/_internal/client-error", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ events: [{ message: "flood", sessionId: "rate-test-session", ts: "2026-01-01T00:00:00Z" }] }),
      }),
      makeEnv(),
    );
    expect(response.status).toBe(429);
  });
});

// --- metrics middleware integration ---

describe("metrics middleware", () => {
  it("calls writeDataPoint once per /api/* request", async () => {
    const writeDataPoint = vi.fn();
    const env: LiteLLMPortalEnv = {
      LITELLM_BASE_URL: "https://litellm.test",
      PORTAL_SESSION_SECRET: TEST_SESSION_SECRET,
      METRICS_AE: { writeDataPoint },
    };
    globalThis.fetch = vi.fn(async (input) => {
      const url = String(input);
      if (url.includes("/user/list")) return Response.json({ users: [] });
      return Response.json({});
    }) as typeof fetch;

    await handleLiteLLMPortalRequest(
      new Request("https://portal.test/api/me", {
        headers: { Cookie: `${SESSION_COOKIE_NAME}=${_cookieCache.get("test@gz-zhiyun.com") ?? ""}` },
      }),
      env,
    );
    expect(writeDataPoint).toHaveBeenCalledTimes(1);
    const [point] = writeDataPoint.mock.calls[0];
    expect(point.blobs).toContain("/api/me");
  });

  it("does NOT call AUDIT_AE for /api/me (non-admin route)", async () => {
    const writeDataPointAudit = vi.fn();
    const env: LiteLLMPortalEnv = {
      LITELLM_BASE_URL: "https://litellm.test",
      PORTAL_SESSION_SECRET: TEST_SESSION_SECRET,
      AUDIT_AE: { writeDataPoint: writeDataPointAudit },
    };
    globalThis.fetch = vi.fn(async (input) => {
      const url = String(input);
      if (url.includes("/user/list")) return Response.json({ users: [] });
      return Response.json({});
    }) as typeof fetch;

    await handleLiteLLMPortalRequest(
      new Request("https://portal.test/api/me", {
        headers: { Cookie: `${SESSION_COOKIE_NAME}=${_cookieCache.get("test@gz-zhiyun.com") ?? ""}` },
      }),
      env,
    );
    expect(writeDataPointAudit).not.toHaveBeenCalled();
  });

  it("calls AUDIT_AE for /api/admin/* routes", async () => {
    const writeDataPointAudit = vi.fn();
    const env: LiteLLMPortalEnv = {
      LITELLM_BASE_URL: "https://litellm.test",
      PORTAL_SESSION_SECRET: TEST_SESSION_SECRET,
      LITELLM_MASTER_KEY: "test-master-key",
      AUDIT_AE: { writeDataPoint: writeDataPointAudit },
    };
    globalThis.fetch = vi.fn(async (input) => {
      const url = String(input);
      if (url.includes("/user/list")) return Response.json({ users: [{ user_email: "admin@gz-zhiyun.com", user_role: "proxy_admin", user_id: "admin-uid" }] });
      if (url.includes("/user/info")) return Response.json({ user_id: "admin-uid", user_email: "admin@gz-zhiyun.com", user_role: "proxy_admin" });
      return Response.json({ users: [], totalCount: 0, page: 1, size: 50 });
    }) as typeof fetch;

    await handleLiteLLMPortalRequest(
      new Request("https://portal.test/api/admin/users", {
        headers: { Cookie: `${SESSION_COOKIE_NAME}=${_cookieCache.get("admin@gz-zhiyun.com") ?? ""}` },
      }),
      env,
    );
    expect(writeDataPointAudit).toHaveBeenCalledTimes(1);
    const [point] = writeDataPointAudit.mock.calls[0];
    expect(point.blobs).toContain("admin@gz-zhiyun.com");
    expect(point.blobs).toContain("/api/admin/users");
  });
});
