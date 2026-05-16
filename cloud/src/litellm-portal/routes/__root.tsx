/**
 * Root layout route.
 *
 * Renders the shared chrome (header, PortalTabs nav, PortalErrorBanner) and
 * an `<Outlet />` that the child routes fill in. This replaces the monolithic
 * `showUserPanel` / `showAdminPanel` hidden-div switching in the old App.
 *
 * Hash-compat shim: on first mount we detect `window.location.hash === "#admin"`
 * and replace it with `/admin` so old bookmarks still work.  This shim should be
 * removed after ~4 weeks per tasks.md 5.2.
 */

import React, { useEffect } from "react";
import { Link, createRootRouteWithContext, Outlet, useRouter, useRouterState } from "@tanstack/react-router";
import { Tabs } from "@cloudflare/kumo/components/tabs";
import { Switch } from "@cloudflare/kumo/components/switch";
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
  const [resolvedMode, setResolvedMode] = React.useState<"dark" | "light">(() => resolvedTheme(theme));

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
      <LinkButton href="/preferences" variant="ghost"><Trans>偏好设置</Trans></LinkButton>
      <Switch
        controlFirst={false}
        checked={isDark}
        transitioning={updatePreferences.isPending}
        onCheckedChange={(next: boolean) => updatePreferences.mutate({ theme: next ? "dark" : "light" })}
        aria-label={isDark ? "切换浅色模式" : "切换深色模式"}
        label={isDark ? <Trans>深色</Trans> : <Trans>浅色</Trans>}
      />
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

// ---------------------------------------------------------------------------
// PortalTabs — uses router state to highlight the active tab
// ---------------------------------------------------------------------------

function PortalTabs() {
  const router = useRouter();
  const pathname = useRouterState({ select: (s) => s.location.pathname });

  // Determine active tab from the current path.
  const activeTab: "user" | "admin" = pathname.startsWith("/admin") ? "admin" : "user";

  function handleTabSelect(next: string) {
    if (next === "admin") {
      void router.navigate({ to: "/admin" });
    } else {
      void router.navigate({ to: "/" });
    }
  }

  return (
    <Tabs
      className="mb-10"
      variant="segmented"
      value={activeTab}
      onValueChange={handleTabSelect}
      tabs={[
        { value: "user", label: "个人视图" },
        { value: "admin", label: "全局管理" },
      ]}
    />
  );
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

function RootLayout() {
  const router = useRouter();
  const { data: me } = useMe();
  const { data: preferences } = usePreferences();
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const isAdmin = me?.role === "admin";
  const appliedDefaultTabRef = React.useRef(false);

  // Hash-compat shim: redirect `/#admin` → `/admin` once, replacing history.
  // Remove this block after the compat period (see tasks.md 5.2).
  useEffect(() => {
    if (typeof window !== "undefined" && window.location.hash === "#admin") {
      void router.navigate({ to: "/admin", replace: true });
    }
  }, [router]);

  useEffect(() => {
    if (appliedDefaultTabRef.current || me === undefined || preferences === undefined) return;
    appliedDefaultTabRef.current = true;
    if (isAdmin && pathname === "/" && preferences.defaultTab === "admin") {
      void router.navigate({ to: "/admin", replace: true });
    }
  }, [isAdmin, me, pathname, preferences, router]);

  const platformName = me?.company ?? "智云AI管理平台";

  return (
    <main className="container mx-auto px-4 py-10 lg:px-10 lg:py-16">
      <header className="mb-12 flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="space-y-4">
          <span className="inline-flex w-fit items-center rounded-full bg-kumo-info-tint/70 px-2.5 py-1 text-xs font-semibold text-kumo-info">
            Cloudflare Access 已保护
          </span>
          <div className="space-y-3">
            <h1 className="text-3xl font-semibold tracking-tight text-kumo-strong lg:text-4xl">
              {platformName}
            </h1>
            <p className="max-w-3xl text-base leading-relaxed text-kumo-subtle">
              面向智云团队的 AI 能力自助台：只读查看个人 API Key、团队可用模型、预算与近 30
              天用量，数据权限自动绑定当前登录邮箱。
            </p>
          </div>
        </div>
        <div id="header-actions-root" className="flex flex-wrap items-center gap-3 sm:self-auto">
          <HeaderActions />
        </div>
      </header>

      {isAdmin && (
        <nav id="portal-tabs-root">
          <PortalTabs />
        </nav>
      )}

      {isAdmin ? (
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
