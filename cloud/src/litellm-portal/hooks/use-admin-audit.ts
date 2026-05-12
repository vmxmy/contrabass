import { useQuery } from "@tanstack/react-query";
import { AdminAuditSchema } from "../schemas";

export type AdminAuditParams = {
  page?: number;
  size?: number;
  window?: string;
};

export const ADMIN_AUDIT_QUERY_KEY = (params: Required<AdminAuditParams>) => ["admin", "audit", params.page, params.size, params.window] as const;

export function useAdminAudit(params: AdminAuditParams = {}) {
  const queryParams = { page: params.page ?? 1, size: params.size ?? 50, window: params.window ?? "" };

  return useQuery({
    queryKey: ADMIN_AUDIT_QUERY_KEY(queryParams),
    queryFn: async () => {
      const searchParams = new URLSearchParams({ page: String(queryParams.page), size: String(queryParams.size) });
      if (queryParams.window) searchParams.set("window", queryParams.window);
      const res = await fetch(`/api/admin/audit?${searchParams.toString()}`, { headers: { "content-type": "application/json" } });
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
