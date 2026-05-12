import { useQuery } from "@tanstack/react-query";
import { UsageTimeseriesSchema } from "../schemas";

export const ADMIN_USAGE_QUERY_KEY = (grain: string, windowKey: string) =>
  ["admin", "usage", "timeseries", grain, windowKey] as const;

export function useAdminUsage(grain: string, windowKey: string) {
  return useQuery({
    queryKey: ADMIN_USAGE_QUERY_KEY(grain, windowKey),
    queryFn: async () => {
      const params = new URLSearchParams({ grain, window: windowKey });
      const res = await fetch(`/api/admin/usage/timeseries?${params.toString()}`, { headers: { "content-type": "application/json" } });
      if (!res.ok) {
        const body = await res.json().catch(() => ({ error: "request_failed" })) as Record<string, unknown>;
        throw new Error(typeof body.error === "string" ? body.error : "request_failed");
      }
      return UsageTimeseriesSchema.parse(await res.json());
    },
    staleTime: 30_000,
    refetchOnWindowFocus: false,
  });
}
