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
import { createRootRouteWithContext, Outlet, useRouter, useRouterState } from "@tanstack/react-router";
import { Tabs } from "@cloudflare/kumo/components/tabs";
import { Switch } from "@cloudflare/kumo/components/switch";
import { Button } from "@cloudflare/kumo/components/button";
import { Toasty } from "@cloudflare/kumo/components/toast";
import { TooltipProvider } from "@cloudflare/kumo/components/tooltip";
import { QueryClient, QueryClientProvider, HydrationBoundary } from "@tanstack/react-query";
import { PortalErrorBanner } from "../app";
import { useMe } from "../hooks/use-me";
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
  const readMode = (): "dark" | "light" =>
    typeof document !== "undefined" && document.documentElement.dataset.mode === "dark"
      ? "dark"
      : "light";
  const [mode, setMode] = React.useState<"dark" | "light">(readMode);

  useEffect(() => {
    document.documentElement.dataset.mode = mode;
    try {
      localStorage.setItem("litellm-portal-mode", mode);
    } catch {
      // ignore — private mode etc.
    }
  }, [mode]);

  const isDark = mode === "dark";
  return (
    <>
      <Switch
        variant="neutral"
        controlFirst={false}
        checked={isDark}
        onCheckedChange={(next: boolean) => setMode(next ? "dark" : "light")}
        aria-label={isDark ? "切换浅色模式" : "切换深色模式"}
        label={isDark ? "深色" : "浅色"}
      />
      <Button
        variant="outline"
        type="button"
        aria-label="退出登录"
        onClick={() => {
          window.location.href = "/cdn-cgi/access/logout";
        }}
      >
        退出登录
      </Button>
    </>
  );
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

// ---------------------------------------------------------------------------
// Root layout component
// ---------------------------------------------------------------------------

function RootLayout() {
  const router = useRouter();
  const { data: me } = useMe();
  const isAdmin = me?.role === "admin";

  // Hash-compat shim: redirect `/#admin` → `/admin` once, replacing history.
  // Remove this block after the compat period (see tasks.md 5.2).
  useEffect(() => {
    if (typeof window !== "undefined" && window.location.hash === "#admin") {
      void router.navigate({ to: "/admin", replace: true });
    }
  }, [router]);

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

      <Outlet />

      <div id="portal-error-root">
        <PortalErrorBanner />
      </div>
    </main>
  );
}

// ---------------------------------------------------------------------------
// App shell that wraps the router provider with QueryClient + HydrationBoundary.
// Exported so server-impl.tsx and the client bootstrap can import it.
// ---------------------------------------------------------------------------

export type AppShellProps = {
  dehydratedState?: unknown;
  children: React.ReactNode;
};

export function AppShell({ dehydratedState, children }: AppShellProps) {
  const queryClient = getQueryClient();
  return (
    <QueryClientProvider client={queryClient}>
      <HydrationBoundary state={dehydratedState}>
        <Toasty>
          <TooltipProvider delay={300}>
            {children}
          </TooltipProvider>
        </Toasty>
      </HydrationBoundary>
    </QueryClientProvider>
  );
}
