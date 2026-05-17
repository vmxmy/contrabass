import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  OpsTenantsSchema,
  OpsTenantDetailSchema,
  OpsUserDetailSchema,
  AuditEventDetailSchema,
  type OpsTenants,
  type OpsTenantDetail,
  type OpsUserDetail,
  type AuditEventDetail,
} from "../schemas";

export const OPS_TENANTS_QUERY_KEY = ["ops", "tenants"] as const;
export const OPS_TENANT_DETAIL_QUERY_KEY = (teamId: string) => ["ops", "tenant", teamId] as const;
export const OPS_USER_DETAIL_QUERY_KEY = (userId: string) => ["ops", "user", userId] as const;
export const OPS_AUDIT_EVENT_QUERY_KEY = (eventId: string) => ["ops", "audit", eventId] as const;

function extractError(json: unknown, fallback: string): string {
  if (json !== null && typeof json === "object" && "error" in json) {
    const v = (json as Record<string, unknown>).error;
    if (typeof v === "string") return v;
  }
  return fallback;
}

async function getJson<T>(url: string, parse: (j: unknown) => T, fallbackErr: string): Promise<T> {
  const res = await fetch(url, { headers: { "content-type": "application/json" } });
  const json = (await res.json().catch(() => ({}))) as unknown;
  if (!res.ok) throw new Error(extractError(json, fallbackErr));
  return parse(json);
}

export function useOpsTenants() {
  return useQuery<OpsTenants>({
    queryKey: OPS_TENANTS_QUERY_KEY,
    queryFn: () => getJson("/api/ops/tenants", (j) => OpsTenantsSchema.parse(j), "ops_tenants_request_failed"),
    staleTime: 30_000,
    refetchOnWindowFocus: false,
  });
}

export function useOpsTenantDetail(teamId: string) {
  return useQuery<OpsTenantDetail>({
    queryKey: OPS_TENANT_DETAIL_QUERY_KEY(teamId),
    queryFn: () =>
      getJson(`/api/ops/tenants/${encodeURIComponent(teamId)}`, (j) => OpsTenantDetailSchema.parse(j), "ops_tenant_detail_request_failed"),
    enabled: teamId.length > 0,
    staleTime: 30_000,
    refetchOnWindowFocus: false,
  });
}

export function useOpsUserDetail(userId: string) {
  return useQuery<OpsUserDetail>({
    queryKey: OPS_USER_DETAIL_QUERY_KEY(userId),
    queryFn: () =>
      getJson(`/api/ops/users/${encodeURIComponent(userId)}`, (j) => OpsUserDetailSchema.parse(j), "ops_user_detail_request_failed"),
    enabled: userId.length > 0,
    staleTime: 30_000,
    refetchOnWindowFocus: false,
  });
}

export function useOpsAuditEvent(eventId: string) {
  return useQuery<AuditEventDetail>({
    queryKey: OPS_AUDIT_EVENT_QUERY_KEY(eventId),
    queryFn: () =>
      getJson(`/api/ops/audit/${encodeURIComponent(eventId)}`, (j) => AuditEventDetailSchema.parse(j), "ops_audit_event_request_failed"),
    enabled: eventId.length > 0,
    staleTime: 30_000,
    refetchOnWindowFocus: false,
  });
}

export type StartImpersonationInput = { teamId: string; reason: string };

export function useStartImpersonation() {
  const queryClient = useQueryClient();
  return useMutation<{ ok: true; effectiveTeamId: string }, Error, StartImpersonationInput>({
    mutationFn: async (input) => {
      const res = await fetch("/api/ops/impersonation", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ teamId: input.teamId, reason: input.reason }),
      });
      const json = (await res.json().catch(() => ({}))) as unknown;
      if (!res.ok) throw new Error(extractError(json, "ops_impersonation_start_failed"));
      return json as { ok: true; effectiveTeamId: string };
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: OPS_TENANTS_QUERY_KEY });
    },
  });
}

export function useStopImpersonation() {
  const queryClient = useQueryClient();
  return useMutation<{ ok: true }, Error, void>({
    mutationFn: async () => {
      const res = await fetch("/api/ops/impersonation", {
        method: "DELETE",
        headers: { "content-type": "application/json" },
      });
      const json = (await res.json().catch(() => ({}))) as unknown;
      if (!res.ok) throw new Error(extractError(json, "ops_impersonation_stop_failed"));
      return json as { ok: true };
    },
    onSuccess: () => {
      void queryClient.invalidateQueries();
    },
  });
}
