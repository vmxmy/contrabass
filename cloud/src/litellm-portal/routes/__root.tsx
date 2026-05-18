/**
 * Root layout route.
 *
 * Renders the shared chrome (header, actions, PortalErrorBanner) and an
 * `<Outlet />` that the child routes fill in.
 *
 * Hash-compat shim: on first mount we detect `window.location.hash === "#admin"`
 * and replace it with `/` so old bookmarks still work. This shim should be
 * removed after ~4 weeks per tasks.md 5.2.
 */

import React, { useEffect } from "react";
import { Link, createRootRouteWithContext, Outlet, useRouter, useRouterState } from "@tanstack/react-router";
import { Sun, Moon } from "@phosphor-icons/react";
import { Button, LinkButton } from "@cloudflare/kumo/components/button";
import { Toasty } from "@cloudflare/kumo/components/toast";
import { Loader } from "@cloudflare/kumo/components/loader";
import { TooltipProvider } from "@cloudflare/kumo/components/tooltip";
import { LinkProvider, type LinkComponentProps } from "@cloudflare/kumo/utils";
import { QueryClient, QueryClientProvider, HydrationBoundary } from "@tanstack/react-query";
import { Trans } from "@lingui/react/macro";
import { PortalErrorBanner } from "../app";
import { useMe } from "../hooks/use-me";
import { applyThemePreference, useLegacyThemeMigration, usePreferences, useUpdatePreferences } from "../hooks/use-preferences";
import type { RouterContext } from "../router";

// ---------------------------------------------------------------------------
// Root route definition (typed context)
// ---------------------------------------------------------------------------

export const rootRoute = createRootRouteWithContext<RouterContext>()({
  component: RootLayout,
});

// ---------------------------------------------------------------------------
// QueryClient singleton (client-side) — created once, never re-created.
// ---------------------------------------------------------------------------

function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 60_000,
        refetchOnWindowFocus: false,
      },
    },
  });
}

// Module-level singleton so HMR / strict-mode double-render don't create two.
let _queryClient: QueryClient | undefined;
function getQueryClient(): QueryClient {
  if (!_queryClient) _queryClient = createQueryClient();
  return _queryClient;
}

// ---------------------------------------------------------------------------
// Header actions (dark-mode toggle + logout)
// ---------------------------------------------------------------------------

function HeaderActions() {
  const { data: preferences } = usePreferences();
  const updatePreferences = useUpdatePreferences();
  const theme = preferences?.theme ?? "auto";
  const [resolvedMode, setResolvedMode] = React.useState<"dark" | "light">(() => initialResolvedTheme(theme));

  useEffect(() => {
    const syncTheme = () => {
      applyThemePreference(theme);
      setResolvedMode(resolvedTheme(theme));
    };
    syncTheme();
    if (theme !== "auto" || typeof window === "undefined") return;
    const media = window.matchMedia?.("(prefers-color-scheme: dark)");
    if (!media) return;
    media.addEventListener("change", syncTheme);
    return () => media.removeEventListener("change", syncTheme);
  }, [theme]);

  const isDark = resolvedMode === "dark";
  return (
    <>
      <LinkButton href="/manage/preferences" variant="ghost"><Trans>偏好设置</Trans></LinkButton>
      <LinkButton href="/manage" variant="ghost"><Trans>管理</Trans></LinkButton>
      <Button
        variant="ghost"
        size="sm"
        aria-label={isDark ? "切换浅色模式" : "切换深色模式"}
        onClick={() => updatePreferences.mutate({ theme: isDark ? "light" : "dark" })}
      >
        {isDark ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
      </Button>
      <form method="POST" action="/logout" style={{ display: "inline" }}>
        <Button variant="outline" type="submit" aria-label="退出登录">
          <Trans>退出登录</Trans>
        </Button>
      </form>
    </>
  );
}


function resolvedTheme(theme: "auto" | "dark" | "light"): "dark" | "light" {
  if (theme !== "auto") return theme;
  if (typeof window !== "undefined" && window.matchMedia?.("(prefers-color-scheme: dark)").matches) {
    return "dark";
  }
  if (typeof document !== "undefined" && document.documentElement.dataset.mode === "dark") {
    return "dark";
  }
  return "light";
}

function initialResolvedTheme(theme: "auto" | "dark" | "light"): "dark" | "light" {
  // Hydration's first render must not read browser-only state. For "auto",
  // SSR and client both start at light; the effect above syncs the real system
  // preference immediately after hydration.
  return theme === "dark" ? "dark" : "light";
}

const KumoRouterLink = React.forwardRef<HTMLAnchorElement, LinkComponentProps>(function KumoRouterLink(
  { href, to, ...props },
  ref,
) {
  return <Link ref={ref} to={href ?? to ?? "/"} {...props} />;
});


const LazyPortalCommandPalette = React.lazy(async () => {
  const module = await import("./portal-command-palette");
  return { default: module.PortalCommandPalette };
});

function CommandPaletteFallback() {
  return (
    <div className="sr-only" aria-live="polite">
      <Loader aria-label="正在加载命令面板" />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Root layout component
// ---------------------------------------------------------------------------

/**
 * Outer root layout. Splits the chrome by URL surface:
 *
 * - `/ops*` → render a bare `<Outlet />`. The Operations Console owns its own
 *   full-page chrome (`OpsConsoleShell`); wrapping it in the generic platform
 *   header/command-palette would double-wrap it under a second header (C-NEW-1).
 * - everything else → the generic `PortalRootLayout` (header, actions,
 *   command palette, error banner).
 *
 * The branch is component-IDENTITY, pure-derived from the pathname only — the
 * same single `useRouterState` hook runs on every render of THIS component, so
 * there is no rules-of-hooks hazard (the per-surface hook sequences live in
 * the two distinct child components, each unmounted/remounted cleanly across
 * a surface switch). Because the pathname is identical on the server
 * (`createMemoryHistory`) and the client for a given URL, SSR and hydration
 * take the SAME branch for the SAME path (#418-safe).
 */
function RootLayout() {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const isOpsSurface = pathname === "/ops" || pathname.startsWith("/ops/");
  if (isOpsSurface) {
    return <Outlet />;
  }
  return <PortalRootLayout />;
}

function PortalRootLayout() {
  const router = useRouter();
  const { data: me } = useMe();

  // Hash-compat shim: redirect `/#admin` -> `/` once, replacing history.
  // Remove this block after the compat period (see tasks.md 5.2).
  useEffect(() => {
    if (typeof window !== "undefined" && window.location.hash === "#admin") {
      void router.navigate({ to: "/", replace: true });
    }
  }, [router]);

  const platformName = me?.company ?? "智云AI管理平台";

  return (
    <main className="container mx-auto px-4 py-10 lg:px-10 lg:py-16">
      <header className="mb-12 flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="space-y-4">
          <div className="space-y-3">
            <h1 className="text-3xl font-semibold tracking-tight text-kumo-strong lg:text-4xl">
              {platformName}
            </h1>
            <p className="max-w-3xl text-base leading-relaxed text-kumo-subtle">
              面向智云团队的 AI 能力自助台：仪表盘聚焦用量趋势、预算与模型分布，管理操作集中到独立管理区。
            </p>
          </div>
        </div>
        <div id="header-actions-root" className="flex flex-wrap items-center gap-3 sm:self-auto">
          <HeaderActions />
        </div>
      </header>

      {me ? (
        <React.Suspense fallback={<CommandPaletteFallback />}>
          <LazyPortalCommandPalette />
        </React.Suspense>
      ) : null}

      <Outlet />

      <div id="portal-error-root">
        <PortalErrorBanner />
      </div>
    </main>
  );
}

function PreferencesBootstrap() {
  useLegacyThemeMigration();
  return null;
}

// ---------------------------------------------------------------------------
// App shell that wraps the router provider with QueryClient + HydrationBoundary.
// Exported so server-impl.tsx and the client bootstrap can import it.
// ---------------------------------------------------------------------------

export type AppShellProps = {
  dehydratedState?: unknown;
  // SSR passes a per-request, already-seeded QueryClient so renderToString
  // renders WITH the prefetched data (me/dashboard). Without this the server
  // rendered against the empty singleton (HydrationBoundary populates too late
  // for the first render) while the client hydrated WITH the data — a
  // server/client first-render divergence (React #418, e.g. the header title
  // falling back server-side but resolving me.company client-side).
  queryClient?: QueryClient;
  children: React.ReactNode;
};

export function AppShell({ dehydratedState, queryClient: providedClient, children }: AppShellProps) {
  const queryClient = providedClient ?? getQueryClient();
  return (
    <QueryClientProvider client={queryClient}>
      <HydrationBoundary state={dehydratedState}>
        <PreferencesBootstrap />
        <Toasty>
          <TooltipProvider delay={300}>
            <LinkProvider component={KumoRouterLink}>
              {children}
            </LinkProvider>
          </TooltipProvider>
        </Toasty>
      </HydrationBoundary>
    </QueryClientProvider>
  );
}
