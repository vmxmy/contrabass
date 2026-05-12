import { useQuery } from "@tanstack/react-query";
import { DashboardSchema } from "../schemas";
import { client } from "../rpc";

export const DASHBOARD_QUERY_KEY = ["dashboard"] as const;

export function useDashboard() {
  return useQuery({
    queryKey: DASHBOARD_QUERY_KEY,
    queryFn: async () => {
      const res = await client.api.dashboard.$get();
      if (!res.ok) {
        const body = await res.json().catch(() => ({ error: "request_failed" })) as Record<string, unknown>;
        throw new Error(typeof body.error === "string" ? body.error : "request_failed");
      }
      // Defensive Zod parse guards against schema drift at the hook boundary.
      return DashboardSchema.parse(await res.json());
    },
    staleTime: 60_000,
    refetchOnWindowFocus: false,
  });
}
