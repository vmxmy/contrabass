/**
 * @vitest-environment happy-dom
 */
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
vi.mock("@cloudflare/kumo/components/toast", () => ({ Toasty: ({ children }: { children: React.ReactNode }) => children }));
vi.mock("../../../ops-console/hooks", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../ops-console/hooks")>();
  return { ...actual, useOpsAuditEvent: vi.fn() };
});
vi.mock("@tanstack/react-router", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tanstack/react-router")>();
  return { ...actual, useParams: () => ({ eventId: "ev-1" }) };
});
import { I18nProvider } from "@lingui/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { setupI18n } from "../../../i18n/setup";
import { useOpsAuditEvent } from "../../../ops-console/hooks";
import { ManageAuditEventPage } from "./$eventId.lazy";

const i18n = setupI18n("zh-CN");
afterEach(() => cleanup());

describe("ManageAuditEventPage (做实)", () => {
  it("renders the real audit event detail, not 待实现", () => {
    (useOpsAuditEvent as unknown as ReturnType<typeof vi.fn>).mockReturnValue({
      data: { id: "ev-1", ts: "2026-05-17T00:00:00Z", actorEmail: "o@x.com", action: "ops_impersonation_start", entityKind: "team", entityId: "t1", before: null, after: null, reason: "support" },
      isLoading: false, isError: false, error: null,
    });
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <I18nProvider i18n={i18n}><ManageAuditEventPage /></I18nProvider>
      </QueryClientProvider>,
    );
    expect(screen.queryByText(/待实现/)).toBeNull();
    expect(screen.getByText(/ops_impersonation_start/)).toBeTruthy();
  });
});
