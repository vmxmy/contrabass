/**
 * @vitest-environment happy-dom
 */
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  useTenantInvites,
  useCreateTenantInvite,
  useRevokeTenantInvite,
  useTenantWebhook,
  useSetTenantWebhook,
  useClearTenantWebhook,
  useTenantBillingPeriods,
} from "./hooks";

function makeWrapper() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return {
    qc,
    wrapper: ({ children }: { children: React.ReactNode }) =>
      React.createElement(QueryClientProvider, { client: qc }, children),
  };
}

const originalFetch = globalThis.fetch;

afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// useTenantInvites
// ---------------------------------------------------------------------------

describe("useTenantInvites", () => {
  it("GETs /api/tenant/invites and returns parsed data", async () => {
    const calls: { url: string; method: string }[] = [];
    globalThis.fetch = vi.fn(async (input, init) => {
      calls.push({ url: String(input), method: (init as RequestInit)?.method ?? "GET" });
      return Response.json({
        invites: [
          {
            email: "alice@example.com",
            teamId: "team-1",
            teamRole: "user",
            status: "pending",
            invitedBy: "admin@example.com",
            createdAt: "2026-01-01T00:00:00Z",
            consumedAt: null,
          },
        ],
      });
    }) as typeof fetch;

    const { wrapper } = makeWrapper();
    const { result } = renderHook(() => useTenantInvites(), { wrapper });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(calls.length).toBeGreaterThan(0);
    expect(calls[0].url).toBe("/api/tenant/invites");
    expect(calls[0].method).toBe("GET");
    expect(result.current.data?.invites).toHaveLength(1);
    expect(result.current.data?.invites[0].email).toBe("alice@example.com");
    expect(result.current.data?.invites[0].status).toBe("pending");
  });

  it("throws on non-ok response", async () => {
    globalThis.fetch = vi.fn(async () =>
      Response.json({ error: "forbidden" }, { status: 403 }),
    ) as typeof fetch;

    const { wrapper } = makeWrapper();
    const { result } = renderHook(() => useTenantInvites(), { wrapper });

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect((result.current.error as Error).message).toBe("forbidden");
  });
});

// ---------------------------------------------------------------------------
// useTenantWebhook
// ---------------------------------------------------------------------------

describe("useTenantWebhook", () => {
  it("GETs /api/tenant/alert-webhook and returns parsed data", async () => {
    const calls: { url: string; method: string }[] = [];
    globalThis.fetch = vi.fn(async (input, init) => {
      calls.push({ url: String(input), method: (init as RequestInit)?.method ?? "GET" });
      return Response.json({
        teamId: "team-1",
        url: "https://hooks.example.com/notify",
        updatedAt: "2026-01-01T00:00:00Z",
      });
    }) as typeof fetch;

    const { wrapper } = makeWrapper();
    const { result } = renderHook(() => useTenantWebhook(), { wrapper });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(calls[0].url).toBe("/api/tenant/alert-webhook");
    expect(calls[0].method).toBe("GET");
    expect(result.current.data?.teamId).toBe("team-1");
    expect(result.current.data?.url).toBe("https://hooks.example.com/notify");
  });

  it("returns null url when webhook is not set", async () => {
    globalThis.fetch = vi.fn(async () =>
      Response.json({ teamId: "team-1", url: null, updatedAt: null }),
    ) as typeof fetch;

    const { wrapper } = makeWrapper();
    const { result } = renderHook(() => useTenantWebhook(), { wrapper });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.url).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// useTenantBillingPeriods
// ---------------------------------------------------------------------------

describe("useTenantBillingPeriods", () => {
  it("GETs /api/tenant/billing and returns parsed data", async () => {
    const calls: { url: string; method: string }[] = [];
    globalThis.fetch = vi.fn(async (input, init) => {
      calls.push({ url: String(input), method: (init as RequestInit)?.method ?? "GET" });
      return Response.json({ periods: ["2026-01", "2026-02"] });
    }) as typeof fetch;

    const { wrapper } = makeWrapper();
    const { result } = renderHook(() => useTenantBillingPeriods(), { wrapper });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(calls[0].url).toBe("/api/tenant/billing");
    expect(calls[0].method).toBe("GET");
    expect(result.current.data?.periods).toEqual(["2026-01", "2026-02"]);
  });

  it("throws on non-ok response", async () => {
    globalThis.fetch = vi.fn(async () =>
      Response.json({ error: "billing_archive_unavailable" }, { status: 503 }),
    ) as typeof fetch;

    const { wrapper } = makeWrapper();
    const { result } = renderHook(() => useTenantBillingPeriods(), { wrapper });

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect((result.current.error as Error).message).toBe("billing_archive_unavailable");
  });
});

// ---------------------------------------------------------------------------
// useCreateTenantInvite
// ---------------------------------------------------------------------------

describe("useCreateTenantInvite", () => {
  beforeEach(() => {
    globalThis.fetch = vi.fn(async (input, init) => {
      const url = String(input);
      if (url === "/api/tenant/invites" && (init as RequestInit)?.method === "POST") {
        return Response.json(
          {
            invite: {
              email: "bob@example.com",
              teamId: "team-1",
              teamRole: "user",
              status: "pending",
              invitedBy: "admin@example.com",
              createdAt: "2026-01-01T00:00:00Z",
              consumedAt: null,
            },
            dryRun: false,
          },
          { status: 201 },
        );
      }
      return Response.json({ invites: [] });
    }) as typeof fetch;
  });

  it("POSTs to /api/tenant/invites with correct body and invalidates invites query", async () => {
    const calls: { url: string; method: string; body: unknown }[] = [];
    globalThis.fetch = vi.fn(async (input, init) => {
      const url = String(input);
      const method = (init as RequestInit)?.method ?? "GET";
      const body = (init as RequestInit)?.body;
      calls.push({ url, method, body: typeof body === "string" ? JSON.parse(body) : body });
      if (url === "/api/tenant/invites" && method === "POST") {
        return Response.json(
          {
            invite: {
              email: "bob@example.com",
              teamId: "team-1",
              teamRole: "user",
              status: "pending",
              invitedBy: "admin@example.com",
              createdAt: "2026-01-01T00:00:00Z",
              consumedAt: null,
            },
            dryRun: false,
          },
          { status: 201 },
        );
      }
      return Response.json({ invites: [] });
    }) as typeof fetch;

    const { wrapper } = makeWrapper();
    const { result } = renderHook(() => useCreateTenantInvite(), { wrapper });

    result.current.mutate({
      reason: "user_request",
      email: "bob@example.com",
      teamRole: "user",
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    const postCall = calls.find((c) => c.method === "POST" && c.url === "/api/tenant/invites");
    expect(postCall).toBeDefined();
    expect(postCall?.body).toMatchObject({
      reason: "user_request",
      email: "bob@example.com",
      teamRole: "user",
    });
    expect(result.current.data?.invite.email).toBe("bob@example.com");
  });
});

// ---------------------------------------------------------------------------
// useRevokeTenantInvite
// ---------------------------------------------------------------------------

describe("useRevokeTenantInvite", () => {
  it("DELETEs /api/tenant/invites/:email with reason+confirmEmail body", async () => {
    const calls: { url: string; method: string; body: unknown }[] = [];
    globalThis.fetch = vi.fn(async (input, init) => {
      const url = String(input);
      const method = (init as RequestInit)?.method ?? "GET";
      const body = (init as RequestInit)?.body;
      calls.push({ url, method, body: typeof body === "string" ? JSON.parse(body) : body });
      if (url === "/api/tenant/invites/bob%40example.com" && method === "DELETE") {
        return Response.json({ email: "bob@example.com", status: "revoked", dryRun: false });
      }
      return Response.json({ invites: [] });
    }) as typeof fetch;

    const { wrapper } = makeWrapper();
    const { result } = renderHook(() => useRevokeTenantInvite(), { wrapper });

    result.current.mutate({ email: "bob@example.com", reason: "user_request", confirmEmail: "bob@example.com" });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    const deleteCall = calls.find((c) => c.method === "DELETE");
    expect(deleteCall).toBeDefined();
    expect(deleteCall?.url).toBe("/api/tenant/invites/bob%40example.com");
    expect(deleteCall?.body).toMatchObject({ reason: "user_request", confirmEmail: "bob@example.com" });
    expect(result.current.data?.status).toBe("revoked");
  });
});

// ---------------------------------------------------------------------------
// useSetTenantWebhook
// ---------------------------------------------------------------------------

describe("useSetTenantWebhook", () => {
  it("PUTs /api/tenant/alert-webhook and invalidates webhook query", async () => {
    const calls: { url: string; method: string; body: unknown }[] = [];
    globalThis.fetch = vi.fn(async (input, init) => {
      const url = String(input);
      const method = (init as RequestInit)?.method ?? "GET";
      const body = (init as RequestInit)?.body;
      calls.push({ url, method, body: typeof body === "string" ? JSON.parse(body) : body });
      if (url === "/api/tenant/alert-webhook" && method === "PUT") {
        return Response.json({ teamId: "team-1", url: "https://hooks.example.com/notify", updatedAt: "2026-01-01T00:00:00Z" });
      }
      return Response.json({ teamId: "team-1", url: null, updatedAt: null });
    }) as typeof fetch;

    const { wrapper } = makeWrapper();
    const { result } = renderHook(() => useSetTenantWebhook(), { wrapper });

    result.current.mutate({ reason: "user_request", url: "https://hooks.example.com/notify" });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    const putCall = calls.find((c) => c.method === "PUT");
    expect(putCall).toBeDefined();
    expect(putCall?.url).toBe("/api/tenant/alert-webhook");
    expect(putCall?.body).toMatchObject({ reason: "user_request", url: "https://hooks.example.com/notify" });
    expect(result.current.data?.url).toBe("https://hooks.example.com/notify");
  });
});

// ---------------------------------------------------------------------------
// useClearTenantWebhook
// ---------------------------------------------------------------------------

describe("useClearTenantWebhook", () => {
  it("DELETEs /api/tenant/alert-webhook with reason body", async () => {
    const calls: { url: string; method: string; body: unknown }[] = [];
    globalThis.fetch = vi.fn(async (input, init) => {
      const url = String(input);
      const method = (init as RequestInit)?.method ?? "GET";
      const body = (init as RequestInit)?.body;
      calls.push({ url, method, body: typeof body === "string" ? JSON.parse(body) : body });
      if (url === "/api/tenant/alert-webhook" && method === "DELETE") {
        return Response.json({ teamId: "team-1", url: null, updatedAt: null });
      }
      return Response.json({ teamId: "team-1", url: "https://hooks.example.com/notify", updatedAt: "2026-01-01T00:00:00Z" });
    }) as typeof fetch;

    const { wrapper } = makeWrapper();
    const { result } = renderHook(() => useClearTenantWebhook(), { wrapper });

    result.current.mutate({ reason: "routine_maintenance" });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    const deleteCall = calls.find((c) => c.method === "DELETE");
    expect(deleteCall).toBeDefined();
    expect(deleteCall?.url).toBe("/api/tenant/alert-webhook");
    expect(deleteCall?.body).toMatchObject({ reason: "routine_maintenance" });
    expect(result.current.data?.url).toBeNull();
  });
});
