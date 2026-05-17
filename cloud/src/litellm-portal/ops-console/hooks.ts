import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  OpsTenantsSchema,
  OpsTenantDetailSchema,
  OpsUserDetailSchema,
  AuditEventDetailSchema,
  OpsPlatformSettingsSchema,
  type OpsTenants,
  type OpsTenantDetail,
  type OpsUserDetail,
  type AuditEventDetail,
  type OpsPlatformSettings,
} from "../schemas";
import {
  AdminCreateTeamResultSchema,
  AdminCreateInviteResultSchema,
  AdminRevokeInviteResultSchema,
  SetTenantRoleResultSchema,
  type AdminCreateTeamResult,
  type AdminCreateInviteResult,
  type AdminRevokeInviteResult,
  type SetTenantRoleResult,
} from "../schemas";
import { extractError } from "../errors/extract-error";

export const OPS_TENANTS_QUERY_KEY = ["ops", "tenants"] as const;
export const OPS_TENANT_DETAIL_QUERY_KEY = (teamId: string) => ["ops", "tenant", teamId] as const;
export const OPS_USER_DETAIL_QUERY_KEY = (userId: string) => ["ops", "user", userId] as const;
export const OPS_AUDIT_EVENT_QUERY_KEY = (eventId: string) => ["ops", "audit", eventId] as const;
export const OPS_PLATFORM_SETTINGS_QUERY_KEY = ["ops", "platform-settings"] as const;

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

export function useOpsPlatformSettings() {
  return useQuery<OpsPlatformSettings>({
    queryKey: OPS_PLATFORM_SETTINGS_QUERY_KEY,
    queryFn: () =>
      getJson("/api/ops/platform-settings", (j) => OpsPlatformSettingsSchema.parse(j), "ops_platform_settings_request_failed"),
    staleTime: 60_000,
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

export type OpsCreateTeamInput = { reason: string; alias: string; models?: string[]; maxBudget?: number | null };
export function useOpsCreateTeam() {
  const queryClient = useQueryClient();
  return useMutation<AdminCreateTeamResult, Error, OpsCreateTeamInput>({
    mutationFn: async (input) => {
      const res = await fetch("/api/admin/teams", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          reason: input.reason, alias: input.alias,
          models: input.models ?? [],
          ...(input.maxBudget != null ? { maxBudget: input.maxBudget } : {}),
        }),
      });
      const json = (await res.json().catch(() => ({}))) as unknown;
      if (!res.ok) throw new Error(extractError(json, "ops_create_team_failed"));
      return AdminCreateTeamResultSchema.parse(json);
    },
    onSuccess: () => { void queryClient.invalidateQueries({ queryKey: OPS_TENANTS_QUERY_KEY }); },
  });
}

export type OpsCreateInviteInput = { reason: string; email: string; teamId: string; teamRole?: "admin" | "user" };
export function useOpsCreateInvite() {
  return useMutation<AdminCreateInviteResult, Error, OpsCreateInviteInput>({
    mutationFn: async (input) => {
      const res = await fetch("/api/admin/invites", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ reason: input.reason, email: input.email, teamId: input.teamId, teamRole: input.teamRole ?? "user" }),
      });
      const json = (await res.json().catch(() => ({}))) as unknown;
      if (!res.ok) throw new Error(extractError(json, "ops_create_invite_failed"));
      return AdminCreateInviteResultSchema.parse(json);
    },
  });
}

export type OpsRevokeInviteInput = { email: string; reason: string; confirmEmail: string };
export function useOpsRevokeInvite() {
  return useMutation<AdminRevokeInviteResult, Error, OpsRevokeInviteInput>({
    mutationFn: async (input) => {
      const res = await fetch(`/api/admin/invites/${encodeURIComponent(input.email)}`, {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ reason: input.reason, confirmEmail: input.confirmEmail }),
      });
      const json = (await res.json().catch(() => ({}))) as unknown;
      if (!res.ok) throw new Error(extractError(json, "ops_revoke_invite_failed"));
      return AdminRevokeInviteResultSchema.parse(json);
    },
  });
}

export type OpsSetTenantRoleInput = { teamId: string; userId: string; tenantRole: "tenant_admin" | "member"; reason: string };
export function useOpsSetTenantRole() {
  const queryClient = useQueryClient();
  return useMutation<SetTenantRoleResult, Error, OpsSetTenantRoleInput>({
    mutationFn: async (input) => {
      const res = await fetch(
        `/api/admin/teams/${encodeURIComponent(input.teamId)}/members/${encodeURIComponent(input.userId)}/tenant-role`,
        {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ reason: input.reason, tenantRole: input.tenantRole }),
        },
      );
      const json = (await res.json().catch(() => ({}))) as unknown;
      if (!res.ok) throw new Error(extractError(json, "ops_set_tenant_role_failed"));
      return SetTenantRoleResultSchema.parse(json);
    },
    onSuccess: (_d, vars) => {
      void queryClient.invalidateQueries({ queryKey: OPS_TENANT_DETAIL_QUERY_KEY(vars.teamId) });
    },
  });
}
