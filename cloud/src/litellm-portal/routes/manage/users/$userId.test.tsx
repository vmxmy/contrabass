/**
 * @vitest-environment happy-dom
 */
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
vi.mock("@cloudflare/kumo/components/toast", () => ({ Toasty: ({ children }: { children: React.ReactNode }) => children }));
vi.mock("../../../ops-console/hooks", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../ops-console/hooks")>();
  return { ...actual, useOpsUserDetail: vi.fn() };
});
vi.mock("@tanstack/react-router", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tanstack/react-router")>();
  return { ...actual, useParams: () => ({ userId: "u1" }) };
});
import { I18nProvider } from "@lingui/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { setupI18n } from "../../../i18n/setup";
import { useOpsUserDetail } from "../../../ops-console/hooks";
import { ManageUserDetailPage } from "./$userId.lazy";

const i18n = setupI18n("zh-CN");
afterEach(() => cleanup());

describe("ManageUserDetailPage (做实)", () => {
  it("renders the real user detail, not 待实现", () => {
    (useOpsUserDetail as unknown as ReturnType<typeof vi.fn>).mockReturnValue({
      data: {
        userId: "u1",
        email: "person@example.com",
        platformRole: "user",
        teamId: "t1",
        tenantRole: "member",
        spend: 1,
        maxBudget: 10,
        keyCount: 2,
      },
      isLoading: false, isError: false, error: null,
    });
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <I18nProvider i18n={i18n}><ManageUserDetailPage /></I18nProvider>
      </QueryClientProvider>,
    );
    expect(screen.queryByText(/待实现/)).toBeNull();
    expect(screen.getByText(/person@example\.com/)).toBeTruthy();
  });
});
