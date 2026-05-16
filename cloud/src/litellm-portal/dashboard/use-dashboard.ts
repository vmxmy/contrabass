import { useQuery } from "@tanstack/react-query";
import { DashboardResponseSchema, type DashboardWindow } from "./dashboard-schemas";

/** Client-side scope. `self` carries no userId — the server derives it from the session.
 *  Distinct from the server-side DashboardScope in ../dashboard-schemas.ts (which has userId on self). */
export type DashboardScope =
  | { kind: "self" }
  | { kind: "global" }
  | { kind: "member"; userId: string };

export function dashboardUrl(scope: DashboardScope, window: DashboardWindow): string {
  const p = new URLSearchParams({ window });
  if (scope.kind === "self") return `/api/usage/overview?${p.toString()}`;
  if (scope.kind === "member") p.set("member", scope.userId);
  return `/api/admin/usage/overview?${p.toString()}`;
}

export const DASHBOARD_QUERY_KEY = (scope: DashboardScope, window: string) =>
  ["dashboard", scope.kind, scope.kind === "member" ? scope.userId : "", window] as const;

export function useDashboard(scope: DashboardScope, window: DashboardWindow) {
  return useQuery({
    queryKey: DASHBOARD_QUERY_KEY(scope, window),
    queryFn: async () => {
      const res = await fetch(dashboardUrl(scope, window), {
        headers: { "content-type": "application/json" },
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({ error: "request_failed" })) as Record<string, unknown>;
        throw new Error(typeof body.error === "string" ? body.error : "request_failed");
      }
      return DashboardResponseSchema.parse(await res.json());
    },
    staleTime: 30_000,
    refetchOnWindowFocus: false,
  });
}
