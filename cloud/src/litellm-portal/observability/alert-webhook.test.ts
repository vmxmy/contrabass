import { describe, it, expect, vi, afterEach } from "vitest";
import { isSafeWebhookHost, postAlertWebhook, type BudgetAlertPayload } from "./alert-webhook";

const origFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = origFetch;
  vi.restoreAllMocks();
});

const goodPayload: BudgetAlertPayload = {
  type: "budget_threshold",
  teamId: "t1",
  teamAlias: "Acme",
  currentSpend: 90,
  maxBudget: 100,
  ratio: 0.9,
  threshold: 0.8,
  cycleKey: "2026-05",
  firedAt: new Date().toISOString(),
};

describe("isSafeWebhookHost", () => {
  it("allows a normal public https FQDN", () => {
    expect(isSafeWebhookHost("https://hooks.example.com/budget")).toBe(true);
  });

  it.each([
    ["http (not https)", "http://hooks.example.com/x"],
    ["userinfo in URL", "https://user:pass@hooks.example.com/x"],
    ["localhost", "https://localhost/x"],
    ["loopback v4", "https://127.0.0.1/x"],
    ["cloud metadata", "https://169.254.169.254/latest"],
    ["rfc1918 10/8", "https://10.0.0.5/x"],
    ["rfc1918 192.168", "https://192.168.1.10/x"],
    ["rfc1918 172.16", "https://172.16.0.1/x"],
    ["cgnat 100.64", "https://100.64.0.1/x"],
    ["ipv6 loopback", "https://[::1]/x"],
    ["ipv6 ULA fc00", "https://[fc00::1]/x"],
    ["ipv6 link-local", "https://[fe80::1]/x"],
    ["bare single-label host", "https://intranet/x"],
    ["garbage", "not-a-url"],
  ])("blocks %s", (_label, url) => {
    expect(isSafeWebhookHost(url)).toBe(false);
  });
});

describe("postAlertWebhook", () => {
  it("rejects an invalid payload without calling fetch", async () => {
    const spy = vi.fn();
    globalThis.fetch = spy as unknown as typeof fetch;
    const res = await postAlertWebhook("https://hooks.example.com/x", { bad: true } as unknown as BudgetAlertPayload);
    expect(res).toEqual({ ok: false, status: null, error: "invalid_payload" });
    expect(spy).not.toHaveBeenCalled();
  });

  it("rejects a blocked host without calling fetch", async () => {
    const spy = vi.fn();
    globalThis.fetch = spy as unknown as typeof fetch;
    const res = await postAlertWebhook("https://127.0.0.1/x", goodPayload);
    expect(res).toEqual({ ok: false, status: null, error: "blocked_host" });
    expect(spy).not.toHaveBeenCalled();
  });

  it("returns ok on 2xx", async () => {
    globalThis.fetch = vi.fn(async () => new Response("ok", { status: 200 })) as unknown as typeof fetch;
    const res = await postAlertWebhook("https://hooks.example.com/x", goodPayload);
    expect(res).toEqual({ ok: true, status: 200 });
  });

  it("treats non-2xx as not ok", async () => {
    globalThis.fetch = vi.fn(async () => new Response("nope", { status: 500 })) as unknown as typeof fetch;
    const res = await postAlertWebhook("https://hooks.example.com/x", goodPayload);
    expect(res.ok).toBe(false);
    expect(res.status).toBe(500);
  });

  it("never throws on network failure", async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new Error("boom");
    }) as unknown as typeof fetch;
    const res = await postAlertWebhook("https://hooks.example.com/x", goodPayload);
    expect(res.ok).toBe(false);
    expect(res.status).toBeNull();
  });
});
