/**
 * @vitest-environment happy-dom
 */
import React, { useEffect } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { I18nProvider } from "@lingui/react";
import { setupI18n } from "./i18n/setup";
import { UserPreferencesSchema } from "./schemas";
import { PREFERENCES_CACHE_KEY, useLegacyThemeMigration, useUpdatePreferences } from "./hooks/use-preferences";

const i18n = setupI18n("zh-CN");
const originalFetch = globalThis.fetch;

function installLocalStorage() {
  const store = new Map<string, string>();
  Object.defineProperty(window, "localStorage", {
    configurable: true,
    value: {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => store.set(key, value),
      removeItem: (key: string) => store.delete(key),
      clear: () => store.clear(),
    },
  });
}

function renderWithQuery(ui: React.ReactElement) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <I18nProvider i18n={i18n}>{ui}</I18nProvider>
    </QueryClientProvider>,
  );
}

function LegacyThemeMigrationProbe() {
  useLegacyThemeMigration();
  return <div>migration probe</div>;
}

function FailedPreferenceUpdateProbe() {
  const updatePreferences = useUpdatePreferences();
  useEffect(() => {
    updatePreferences.mutate({ theme: "dark" });
  }, []);
  return <div>update probe</div>;
}

afterEach(() => {
  cleanup();
  installLocalStorage();
  globalThis.fetch = originalFetch;
  window.localStorage.clear();
  vi.restoreAllMocks();
});

describe("theme migration", () => {
  it("patches legacy localStorage theme once and removes the legacy key", async () => {
    installLocalStorage();
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    window.localStorage.setItem("litellm-portal-mode", "dark");
    globalThis.fetch = vi.fn(async (input, init) => {
      calls.push({ url: String(input), init });
      return Response.json(UserPreferencesSchema.parse({ theme: "dark" }));
    }) as typeof fetch;

    const { rerender } = renderWithQuery(<LegacyThemeMigrationProbe />);

    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]?.url).toBe("/api/me/preferences");
    expect(calls[0]?.init?.method).toBe("PATCH");
    expect(calls[0]?.init?.body).toBe(JSON.stringify({ theme: "dark" }));
    expect(window.localStorage.getItem("litellm-portal-mode")).toBeNull();

    rerender(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })}>
        <I18nProvider i18n={i18n}><LegacyThemeMigrationProbe /></I18nProvider>
      </QueryClientProvider>,
    );

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(calls).toHaveLength(1);
  });
});

describe("preferences optimistic updates", () => {
  it("removes first-time optimistic localStorage cache when PATCH fails", async () => {
    installLocalStorage();
    let resolveFetch: ((response: Response) => void) | undefined;
    const responsePromise = new Promise<Response>((resolve) => {
      resolveFetch = resolve;
    });
    const fetchMock = vi.fn(() => responsePromise);
    globalThis.fetch = fetchMock as typeof fetch;

    renderWithQuery(<FailedPreferenceUpdateProbe />);

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(window.localStorage.getItem(PREFERENCES_CACHE_KEY)).toContain("\"theme\":\"dark\""));
    if (resolveFetch === undefined) {
      throw new Error("fetch promise was not captured");
    }
    resolveFetch(Response.json({ error: "nope" }, { status: 500 }));

    await waitFor(() => expect(window.localStorage.getItem(PREFERENCES_CACHE_KEY)).toBeNull());
  });
});
