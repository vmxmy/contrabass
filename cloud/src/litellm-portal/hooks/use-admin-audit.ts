import { useQuery } from "@tanstack/react-query";
import { AdminAuditSchema } from "../schemas";

export const ADMIN_AUDIT_QUERY_KEY = (page: number, size: number) => ["admin", "audit", page, size] as const;

export function useAdminAudit(page: number, size: number) {
  return useQuery({
    queryKey: ADMIN_AUDIT_QUERY_KEY(page, size),
    queryFn: async () => {
      const params = new URLSearchParams({ page: String(page), size: String(size) });
      const res = await fetch(`/api/admin/audit?${params.toString()}`, { headers: { "content-type": "application/json" } });
      if (!res.ok) {
        const body = await res.json().catch(() => ({ error: "request_failed" })) as Record<string, unknown>;
        throw new Error(typeof body.error === "string" ? body.error : "request_failed");
      }
      return AdminAuditSchema.parse(await res.json());
    },
    staleTime: 30_000,
    refetchOnWindowFocus: false,
  });
}
