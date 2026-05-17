/**
 * @vitest-environment happy-dom
 */
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";

const usageSpy = vi.fn();
vi.mock("../../dashboard/views/usage-dashboard", () => ({
  UsageDashboard: (props: { initialScope?: string }) => {
    usageSpy(props);
    return <div data-testid="usage-dashboard" />;
  },
}));
vi.mock("@cloudflare/kumo/components/toast", () => ({ Toasty: ({ children }: { children: React.ReactNode }) => children }));

import { I18nProvider } from "@lingui/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { setupI18n } from "../../i18n/setup";
import { ME_QUERY_KEY } from "../../hooks/use-me";
import type { Me } from "../../schemas";
import { OpsGlobalUsageScreen } from "./global-usage";

const i18n = setupI18n("zh-CN");
const owner: Me = { email: "o@x.com", userId: "u1", company: "C", domain: "x.com", role: "admin", tenantRole: null, tenantTeamId: null };
afterEach(() => { cleanup(); usageSpy.mockReset(); });

describe("OpsGlobalUsageScreen", () => {
  it("mounts UsageDashboard with initialScope=global", () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    qc.setQueryData(ME_QUERY_KEY, owner);
    render(
      <QueryClientProvider client={qc}>
        <I18nProvider i18n={i18n}><OpsGlobalUsageScreen /></I18nProvider>
      </QueryClientProvider>,
    );
    expect(usageSpy).toHaveBeenCalledWith(expect.objectContaining({ initialScope: "global" }));
  });
});
