/**
 * @vitest-environment happy-dom
 */
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

vi.mock("@cloudflare/kumo/components/toast", () => ({
  Toasty: ({ children }: { children: React.ReactNode }) => children,
}));

vi.mock("../hooks", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../hooks")>();
  return { ...actual, useOpsUserDetail: vi.fn() };
});

vi.mock("@tanstack/react-router", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tanstack/react-router")>();
  return { ...actual, useParams: () => ({ userId: "u9" }) };
});

import { I18nProvider } from "@lingui/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { setupI18n } from "../../i18n/setup";
import { ME_QUERY_KEY } from "../../hooks/use-me";
import { useOpsUserDetail } from "../hooks";
import type { Me } from "../../schemas";
import { OpsUserDetailScreen } from "./user-detail";

const i18n = setupI18n("zh-CN");
const owner: Me = { email: "o@x.com", userId: "u1", company: "C", domain: "x.com", role: "admin", tenantRole: null, tenantTeamId: null };

function renderScreen() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  qc.setQueryData(ME_QUERY_KEY, owner);
  return render(
    <QueryClientProvider client={qc}>
      <I18nProvider i18n={i18n}><OpsUserDetailScreen /></I18nProvider>
    </QueryClientProvider>,
  );
}

afterEach(() => cleanup());

describe("OpsUserDetailScreen", () => {
  it("renders user email and id", () => {
    (useOpsUserDetail as unknown as ReturnType<typeof vi.fn>).mockReturnValue({
      data: {
        userId: "u9",
        email: "a@x.com",
        platformRole: "user",
        teamId: "t1",
        tenantRole: "member",
        spend: null,
        maxBudget: 50,
        keyCount: 2,
      },
      isLoading: false,
      isError: false,
      error: null,
    });
    renderScreen();
    expect(screen.getByText(/a@x.com/)).toBeTruthy();
    expect(screen.getByText(/u9/)).toBeTruthy();
  });

  it("renders the unified PanelError on a failed request (§A.2)", () => {
    (useOpsUserDetail as unknown as ReturnType<typeof vi.fn>).mockReturnValue({
      data: undefined, isLoading: false, isError: true, error: new Error("boom"),
    });
    const { container } = renderScreen();
    expect(container.querySelector("[data-panel-error]")).not.toBeNull();
  });
});
