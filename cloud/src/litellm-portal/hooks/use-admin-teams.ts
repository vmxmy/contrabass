import { useQuery } from "@tanstack/react-query";
import { AdminTeamsSchema } from "../schemas";

export const ADMIN_TEAMS_QUERY_KEY = ["admin", "teams"] as const;

export function useAdminTeams() {
  return useQuery({
    queryKey: ADMIN_TEAMS_QUERY_KEY,
    queryFn: async () => {
      const res = await fetch("/api/admin/teams", { headers: { "content-type": "application/json" } });
      if (!res.ok) {
        const body = await res.json().catch(() => ({ error: "request_failed" })) as Record<string, unknown>;
        throw new Error(typeof body.error === "string" ? body.error : "request_failed");
      }
      return AdminTeamsSchema.parse(await res.json());
    },
    staleTime: 30_000,
    refetchOnWindowFocus: false,
  });
}
