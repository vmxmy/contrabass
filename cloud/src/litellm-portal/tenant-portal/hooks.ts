import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AdminInviteListSchema,
  AdminCreateInviteResultSchema,
  AdminRevokeInviteResultSchema,
  TeamAlertWebhookResultSchema,
  TenantBillingPeriodsSchema,
  type AdminInviteList,
  type AdminCreateInviteResult,
  type AdminRevokeInviteResult,
  type TeamAlertWebhookResult,
  type TenantBillingPeriods,
  type TenantCreateInviteBody,
} from "../schemas";

// ---------------------------------------------------------------------------
// Query keys
// ---------------------------------------------------------------------------

export const TENANT_INVITES_QUERY_KEY = ["tenant", "invites"] as const;
export const TENANT_WEBHOOK_QUERY_KEY = ["tenant", "alert-webhook"] as const;
export const TENANT_BILLING_QUERY_KEY = ["tenant", "billing"] as const;

// ---------------------------------------------------------------------------
// Shared fetch helper (mirrors use-preferences / use-admin-* idiom)
// ---------------------------------------------------------------------------

function extractError(json: unknown, fallback: string): string {
  if (json !== null && typeof json === "object" && "error" in json) {
    const value = (json as Record<string, unknown>).error;
    if (typeof value === "string") return value;
  }
  return fallback;
}

// ---------------------------------------------------------------------------
// useTenantInvites — GET /api/tenant/invites
// ---------------------------------------------------------------------------

export function useTenantInvites() {
  return useQuery<AdminInviteList>({
    queryKey: TENANT_INVITES_QUERY_KEY,
    queryFn: async () => {
      const res = await fetch("/api/tenant/invites", {
        headers: { "content-type": "application/json" },
      });
      const json = await res.json().catch(() => ({})) as unknown;
      if (!res.ok) {
        throw new Error(extractError(json, "tenant_invites_request_failed"));
      }
      return AdminInviteListSchema.parse(json);
    },
    staleTime: 60_000,
    refetchOnWindowFocus: false,
  });
}

// ---------------------------------------------------------------------------
// useCreateTenantInvite — POST /api/tenant/invites
// ---------------------------------------------------------------------------

export type CreateTenantInviteInput = {
  reason: string;
  email: string;
  teamRole?: "admin" | "user";
};

export function useCreateTenantInvite() {
  const queryClient = useQueryClient();

  return useMutation<AdminCreateInviteResult, Error, CreateTenantInviteInput>({
    mutationFn: async (input) => {
      const body: TenantCreateInviteBody = {
        reason: input.reason,
        email: input.email,
        teamRole: input.teamRole ?? "user",
      };
      const res = await fetch("/api/tenant/invites", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const json = await res.json().catch(() => ({})) as unknown;
      if (!res.ok) {
        throw new Error(extractError(json, "tenant_invite_create_failed"));
      }
      return AdminCreateInviteResultSchema.parse(json);
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: TENANT_INVITES_QUERY_KEY });
    },
  });
}

// ---------------------------------------------------------------------------
// useRevokeTenantInvite — DELETE /api/tenant/invites/:email
// ---------------------------------------------------------------------------

export type RevokeTenantInviteInput = {
  email: string;
  reason: string;
  confirmEmail: string;
  dryRun?: boolean;
};

export function useRevokeTenantInvite() {
  const queryClient = useQueryClient();

  return useMutation<AdminRevokeInviteResult, Error, RevokeTenantInviteInput>({
    mutationFn: async (input) => {
      const url = `/api/tenant/invites/${encodeURIComponent(input.email)}${input.dryRun === true ? "?dryRun=true" : ""}`;
      const res = await fetch(url, {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ reason: input.reason, confirmEmail: input.confirmEmail }),
      });
      const json = await res.json().catch(() => ({})) as unknown;
      if (!res.ok) {
        throw new Error(extractError(json, "tenant_invite_revoke_failed"));
      }
      return AdminRevokeInviteResultSchema.parse(json);
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: TENANT_INVITES_QUERY_KEY });
    },
  });
}

// ---------------------------------------------------------------------------
// useTenantWebhook — GET /api/tenant/alert-webhook
// ---------------------------------------------------------------------------

export function useTenantWebhook() {
  return useQuery<TeamAlertWebhookResult>({
    queryKey: TENANT_WEBHOOK_QUERY_KEY,
    queryFn: async () => {
      const res = await fetch("/api/tenant/alert-webhook", {
        headers: { "content-type": "application/json" },
      });
      const json = await res.json().catch(() => ({})) as unknown;
      if (!res.ok) {
        throw new Error(extractError(json, "tenant_webhook_request_failed"));
      }
      return TeamAlertWebhookResultSchema.parse(json);
    },
    staleTime: 60_000,
    refetchOnWindowFocus: false,
  });
}

// ---------------------------------------------------------------------------
// useSetTenantWebhook — PUT /api/tenant/alert-webhook
// ---------------------------------------------------------------------------

export type SetTenantWebhookInput = {
  reason: string;
  url: string;
};

export function useSetTenantWebhook() {
  const queryClient = useQueryClient();

  return useMutation<TeamAlertWebhookResult, Error, SetTenantWebhookInput>({
    mutationFn: async (input) => {
      const res = await fetch("/api/tenant/alert-webhook", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ reason: input.reason, url: input.url }),
      });
      const json = await res.json().catch(() => ({})) as unknown;
      if (!res.ok) {
        throw new Error(extractError(json, "tenant_webhook_set_failed"));
      }
      return TeamAlertWebhookResultSchema.parse(json);
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: TENANT_WEBHOOK_QUERY_KEY });
    },
  });
}

// ---------------------------------------------------------------------------
// useClearTenantWebhook — DELETE /api/tenant/alert-webhook
// ---------------------------------------------------------------------------

export type ClearTenantWebhookInput = {
  reason: string;
};

export function useClearTenantWebhook() {
  const queryClient = useQueryClient();

  return useMutation<TeamAlertWebhookResult, Error, ClearTenantWebhookInput>({
    mutationFn: async (input) => {
      const res = await fetch("/api/tenant/alert-webhook", {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ reason: input.reason }),
      });
      const json = await res.json().catch(() => ({})) as unknown;
      if (!res.ok) {
        throw new Error(extractError(json, "tenant_webhook_clear_failed"));
      }
      return TeamAlertWebhookResultSchema.parse(json);
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: TENANT_WEBHOOK_QUERY_KEY });
    },
  });
}

// ---------------------------------------------------------------------------
// useTenantBillingPeriods — GET /api/tenant/billing
// ---------------------------------------------------------------------------

export function useTenantBillingPeriods() {
  return useQuery<TenantBillingPeriods>({
    queryKey: TENANT_BILLING_QUERY_KEY,
    queryFn: async () => {
      const res = await fetch("/api/tenant/billing", {
        headers: { "content-type": "application/json" },
      });
      const json = await res.json().catch(() => ({})) as unknown;
      if (!res.ok) {
        throw new Error(extractError(json, "tenant_billing_request_failed"));
      }
      return TenantBillingPeriodsSchema.parse(json);
    },
    staleTime: 5 * 60_000,
    refetchOnWindowFocus: false,
  });
}

// ---------------------------------------------------------------------------
// downloadTenantBilling — GET /api/tenant/billing/:yearMonth → file download
// SSR-safe: only touches DOM when invoked (never at module top-level).
// DOM APIs are accessed via globalThis casts to avoid requiring the DOM lib
// (tsconfig lib: ["ES2022"] with @cloudflare/workers-types, no DOM).
// ---------------------------------------------------------------------------

type BrowserURL = {
  createObjectURL(blob: Blob): string;
  revokeObjectURL(url: string): void;
};

type BrowserDocument = {
  createElement(tag: "a"): {
    href: string;
    download: string;
    click(): void;
  };
  body: {
    appendChild(node: unknown): void;
    removeChild(node: unknown): void;
  };
};

function browserURL(): BrowserURL | undefined {
  return (globalThis as unknown as { URL?: BrowserURL }).URL;
}

function browserDocument(): BrowserDocument | undefined {
  return (globalThis as unknown as { document?: BrowserDocument }).document;
}

export async function downloadTenantBilling(yearMonth: string): Promise<void> {
  const res = await fetch(`/api/tenant/billing/${encodeURIComponent(yearMonth)}`, {
    headers: { "content-type": "application/json" },
  });
  if (!res.ok) {
    const json = await res.json().catch(() => ({})) as unknown;
    throw new Error(extractError(json, "tenant_billing_download_failed"));
  }
  const blob = await res.blob();
  const urlApi = browserURL();
  const doc = browserDocument();
  if (urlApi === undefined || doc === undefined) return;
  const objectUrl = urlApi.createObjectURL(blob);
  const anchor = doc.createElement("a");
  anchor.href = objectUrl;
  anchor.download = `billing-${yearMonth}.csv`;
  doc.body.appendChild(anchor);
  anchor.click();
  doc.body.removeChild(anchor);
  urlApi.revokeObjectURL(objectUrl);
}
