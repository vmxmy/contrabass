import { useQuery } from "@tanstack/react-query";
import { AdminUsersSchema } from "../schemas";

export const ADMIN_USERS_QUERY_KEY = (page: number, size: number) => ["admin", "users", page, size] as const;

export function useAdminUsers(page: number, size: number) {
  return useQuery({
    queryKey: ADMIN_USERS_QUERY_KEY(page, size),
    queryFn: async () => {
      const params = new URLSearchParams({ page: String(page), size: String(size) });
      const res = await fetch(`/api/admin/users?${params.toString()}`, { headers: { "content-type": "application/json" } });
      if (!res.ok) {
        const body = await res.json().catch(() => ({ error: "request_failed" })) as Record<string, unknown>;
        throw new Error(typeof body.error === "string" ? body.error : "request_failed");
      }
      return AdminUsersSchema.parse(await res.json());
    },
    staleTime: 30_000,
    refetchOnWindowFocus: false,
  });
}
