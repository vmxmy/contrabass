/**
 * @vitest-environment happy-dom
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useOpsTenants, useOpsTenantDetail, useOpsUserDetail, useOpsAuditEvent } from "./hooks";

const wrap = () => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
};
const orig = globalThis.fetch;
afterEach(() => { globalThis.fetch = orig; vi.restoreAllMocks(); });

describe("ops-console hooks", () => {
  it("useOpsTenants GETs /api/ops/tenants", async () => {
    globalThis.fetch = vi.fn(async (u: RequestInfo | URL) => {
      expect(String(u)).toContain("/api/ops/tenants");
      return new Response(JSON.stringify({ tenants: [] }), { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;
    const { result } = renderHook(() => useOpsTenants(), { wrapper: wrap() });
    await waitFor(() => expect(result.current.data).toEqual({ tenants: [] }));
  });

  it("useOpsTenantDetail GETs /api/ops/tenants/:id", async () => {
    globalThis.fetch = vi.fn(async (u: RequestInfo | URL) => {
      expect(String(u)).toContain("/api/ops/tenants/team-1");
      return new Response(
        JSON.stringify({ teamId: "team-1", alias: null, maxBudget: null, cycleSpend: null, alertWebhookUrl: null, members: [], billingPeriods: [] }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as unknown as typeof fetch;
    const { result } = renderHook(() => useOpsTenantDetail("team-1"), { wrapper: wrap() });
    await waitFor(() => expect(result.current.data?.teamId).toBe("team-1"));
  });

  it("useOpsUserDetail GETs /api/ops/users/:id", async () => {
    globalThis.fetch = vi.fn(async (u: RequestInfo | URL) => {
      expect(String(u)).toContain("/api/ops/users/u-1");
      return new Response(
        JSON.stringify({ userId: "u-1", email: "a@x.com", platformRole: "user", teamId: null, tenantRole: null, spend: null, maxBudget: null, keyCount: 0 }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as unknown as typeof fetch;
    const { result } = renderHook(() => useOpsUserDetail("u-1"), { wrapper: wrap() });
    await waitFor(() => expect(result.current.data?.userId).toBe("u-1"));
  });

  it("useOpsAuditEvent GETs /api/ops/audit/:id", async () => {
    globalThis.fetch = vi.fn(async (u: RequestInfo | URL) => {
      expect(String(u)).toContain("/api/ops/audit/ev-1");
      return new Response(
        JSON.stringify({ id: "ev-1", ts: null, actorEmail: "o@x.com", action: "x", entityKind: "y", entityId: "z", before: null, after: null, reason: null, impersonation: null }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as unknown as typeof fetch;
    const { result } = renderHook(() => useOpsAuditEvent("ev-1"), { wrapper: wrap() });
    await waitFor(() => expect(result.current.data?.id).toBe("ev-1"));
  });
});
