/**
 * @vitest-environment happy-dom
 */
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

vi.mock("@cloudflare/kumo/components/toast", () => ({ Toasty: ({ children }: { children: React.ReactNode }) => children }));
vi.mock("../hooks", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../hooks")>();
  return {
    ...actual,
    useOpsPlatformSettings: vi.fn(),
  };
});

import { I18nProvider } from "@lingui/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { setupI18n } from "../../i18n/setup";
import { ME_QUERY_KEY } from "../../hooks/use-me";
import type { Me } from "../../schemas";
import { useOpsPlatformSettings } from "../hooks";
import { OpsPlatformSettingsScreen } from "./platform-settings";

const i18n = setupI18n("zh-CN");
const owner: Me = { email: "o@x.com", userId: "u1", company: "C", domain: "x.com", role: "admin", tenantRole: null, tenantTeamId: null };

function renderScreen() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  qc.setQueryData(ME_QUERY_KEY, owner);
  return render(
    <QueryClientProvider client={qc}>
      <I18nProvider i18n={i18n}><OpsPlatformSettingsScreen /></I18nProvider>
    </QueryClientProvider>,
  );
}
afterEach(() => { cleanup(); vi.mocked(useOpsPlatformSettings).mockReset(); });

describe("OpsPlatformSettingsScreen", () => {
  it("renders company name and write-ops-enabled badge from useOpsPlatformSettings", () => {
    // #given the platform settings query resolves with write ops on and company "Acme"
    vi.mocked(useOpsPlatformSettings).mockReturnValue({
      data: { writeOpsEnabled: true, companyName: "Acme" },
      isLoading: false,
      isError: false,
      error: null,
    } as ReturnType<typeof useOpsPlatformSettings>);
    // #when
    renderScreen();
    // #then the company name and the enabled badge are shown
    expect(screen.getByText(/Acme/)).toBeTruthy();
    expect(screen.getByText(/写操作已启用/)).toBeTruthy();
  });
});
