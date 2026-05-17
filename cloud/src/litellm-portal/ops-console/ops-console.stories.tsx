/**
 * Storybook stories for the LiteLLM Ops Console components.
 *
 * Mirrors tenant-portal.stories.tsx exactly:
 *   - CSF3 format with Meta / StoryObj from @storybook/react
 *   - Per-story decorators provide QueryClient (seeded with inline fixtures)
 *     and Lingui I18nProvider — no network calls, no Cloudflare bindings.
 *   - Each screen covered in: loading / empty / loaded / error variants.
 *   - Shell covered in: Owner / non-Owner identity variants.
 *
 * The two param-driven screens (tenant detail, user detail) and the audit
 * detail card are exercised through their exported `*Body` / `*Card`
 * components so the stories stay router-free — exactly analogous to how the
 * tenant-portal stories render screens directly without a RouterProvider.
 *
 * Stories are intentionally self-contained: they import only from this
 * package and from React — no network calls, no Cloudflare bindings.
 */

import type { Meta, StoryObj } from "@storybook/react";
import React from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { I18nProvider } from "@lingui/react";
import { setupI18n } from "../i18n/setup";
import { ME_QUERY_KEY } from "../hooks/use-me";
import { DASHBOARD_QUERY_KEY } from "../dashboard/use-dashboard";
import {
  OPS_TENANTS_QUERY_KEY,
  OPS_TENANT_DETAIL_QUERY_KEY,
  OPS_USER_DETAIL_QUERY_KEY,
  OPS_AUDIT_EVENT_QUERY_KEY,
  OPS_PLATFORM_SETTINGS_QUERY_KEY,
} from "./hooks";
import type { Me } from "../schemas";
import type {
  OpsTenants,
  OpsTenantDetail,
  OpsUserDetail,
  AuditEventDetail,
  OpsPlatformSettings,
} from "../schemas";
import type { PortalIdentity } from "../types";
import { OpsConsoleShell } from "./shell";
import { OpsTenantOverviewScreen } from "./screens/tenant-overview";
import { OpsProvisioningScreen } from "./screens/provisioning";
import { OpsPlatformSettingsScreen } from "./screens/platform-settings";
import { OpsTenantDetailBody } from "./screens/tenant-detail";
import { OpsUserDetailBody } from "./screens/user-detail";
import { AuditEventDetailCard } from "./screens/audit";
import { OpsGlobalUsageScreen } from "./screens/global-usage";

// ---------------------------------------------------------------------------
// Lingui i18n instance (zh-CN default, matches app default)
// ---------------------------------------------------------------------------

const i18n = setupI18n("zh-CN");

// ---------------------------------------------------------------------------
// Shared fixture data
// ---------------------------------------------------------------------------

const fixtureMeOwner: Me = {
  email: "owner@platform.example.com",
  userId: "u-owner-1",
  company: "Platform Co",
  domain: "platform.example.com",
  role: "admin",
  tenantRole: null,
  tenantTeamId: null,
};

const fixtureMeNonOwner: Me = {
  email: "member@acme.example.com",
  userId: "u-member-1",
  company: "Acme AI",
  domain: "acme.example.com",
  role: "user",
  tenantRole: "member",
  tenantTeamId: "team-acme-1",
};

const identityOwner: PortalIdentity = {
  email: fixtureMeOwner.email,
  userId: fixtureMeOwner.userId,
  domain: fixtureMeOwner.domain,
  litellmUserId: fixtureMeOwner.userId,
  role: "admin",
  tenantRole: null,
  tenantTeamId: null,
};

const identityNonOwner: PortalIdentity = {
  email: fixtureMeNonOwner.email,
  userId: fixtureMeNonOwner.userId,
  domain: fixtureMeNonOwner.domain,
  litellmUserId: fixtureMeNonOwner.userId,
  role: "user",
  tenantRole: "member",
  tenantTeamId: "team-acme-1",
};

const fixtureTenantsLoaded: OpsTenants = {
  tenants: [
    {
      teamId: "team-acme-1",
      alias: "acme-core",
      memberCount: 5,
      cycleSpend: 42.5,
      maxBudget: 200,
      alertWebhookConfigured: true,
      billingPeriodsCount: 3,
    },
    {
      teamId: "team-zen-2",
      alias: null,
      memberCount: 1,
      cycleSpend: null,
      maxBudget: null,
      alertWebhookConfigured: false,
      billingPeriodsCount: 0,
    },
  ],
};

const fixtureTenantsEmpty: OpsTenants = { tenants: [] };

const fixtureTenantDetail: OpsTenantDetail = {
  teamId: "team-acme-1",
  alias: "acme-core",
  maxBudget: 200,
  cycleSpend: 42.5,
  alertWebhookUrl: "https://hooks.example.com/notify",
  members: [
    {
      userId: "u-admin-1",
      email: "admin@acme.example.com",
      tenantRole: "tenant_admin",
      spend: 30,
    },
    {
      userId: "u-member-1",
      email: "member@acme.example.com",
      tenantRole: "member",
      spend: 12.5,
    },
  ],
  billingPeriods: ["2025-04", "2025-03"],
};

const fixtureTenantDetailEmpty: OpsTenantDetail = {
  teamId: "team-zen-2",
  alias: null,
  maxBudget: null,
  cycleSpend: null,
  alertWebhookUrl: null,
  members: [],
  billingPeriods: [],
};

const fixtureUserDetail: OpsUserDetail = {
  userId: "u-admin-1",
  email: "admin@acme.example.com",
  platformRole: "user",
  teamId: "team-acme-1",
  tenantRole: "tenant_admin",
  spend: 30,
  maxBudget: 200,
  keyCount: 4,
};

const fixtureAuditEvent: AuditEventDetail = {
  id: "ev-1",
  ts: "2026-05-17T00:00:00Z",
  actorEmail: "owner@platform.example.com",
  action: "ops_impersonation_start",
  entityKind: "team",
  entityId: "team-acme-1",
  before: null,
  after: '{"viaImpersonation":true}',
  reason: "ops_enter_tenant",
  impersonation: {
    realActor: "owner@platform.example.com",
    effectiveTeam: "team-acme-1",
    viaImpersonation: true,
  },
};

const fixturePlatformSettingsEnabled: OpsPlatformSettings = {
  writeOpsEnabled: true,
  companyName: "Platform Co",
};

const fixturePlatformSettingsDisabled: OpsPlatformSettings = {
  writeOpsEnabled: false,
  companyName: "Platform Co",
};

// ---------------------------------------------------------------------------
// Decorator factory — seeds React Query cache with the given entries,
// wraps in QueryClientProvider + Lingui I18nProvider.
// ---------------------------------------------------------------------------

type SeedEntry = [unknown[], unknown];

function makeDecorator(seeds: SeedEntry[] = []) {
  return function Decorator(Story: React.ComponentType) {
    const qc = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: Infinity } },
    });
    for (const [key, data] of seeds) {
      qc.setQueryData(key, data);
    }
    return (
      <QueryClientProvider client={qc}>
        <I18nProvider i18n={i18n}>
          <Story />
        </I18nProvider>
      </QueryClientProvider>
    );
  };
}

// ---------------------------------------------------------------------------
// Shell — OpsConsoleShell
// ---------------------------------------------------------------------------

const shellMeta: Meta<typeof OpsConsoleShell> = {
  title: "LiteLLM Ops Console/OpsConsoleShell",
  component: OpsConsoleShell,
  parameters: { layout: "fullscreen" },
  tags: ["autodocs"],
  decorators: [makeDecorator()],
};

export default shellMeta;

export const ShellOwner: StoryObj<typeof OpsConsoleShell> = {
  name: "Shell — Owner (full ops nav)",
  args: {
    identity: identityOwner,
    children: <div className="p-6 text-kumo-default">Screen content here</div>,
  },
};

export const ShellNonOwner: StoryObj<typeof OpsConsoleShell> = {
  name: "Shell — non-Owner (forbidden card)",
  args: {
    identity: identityNonOwner,
    children: <div className="p-6 text-kumo-default">Screen content here</div>,
  },
};

// ---------------------------------------------------------------------------
// Tenant Overview screen — OpsTenantOverviewScreen
// ---------------------------------------------------------------------------

export const TenantOverviewScreenMeta: Meta<typeof OpsTenantOverviewScreen> = {
  title: "LiteLLM Ops Console/OpsTenantOverviewScreen",
  component: OpsTenantOverviewScreen,
  parameters: { layout: "padded" },
  tags: ["autodocs"],
};

export const TenantOverviewLoading: StoryObj<typeof OpsTenantOverviewScreen> = {
  name: "Tenant Overview — Loading (no cache)",
  decorators: [makeDecorator()],
};

export const TenantOverviewLoaded: StoryObj<typeof OpsTenantOverviewScreen> = {
  name: "Tenant Overview — Loaded (2 tenants)",
  decorators: [makeDecorator([[OPS_TENANTS_QUERY_KEY, fixtureTenantsLoaded]])],
};

export const TenantOverviewEmpty: StoryObj<typeof OpsTenantOverviewScreen> = {
  name: "Tenant Overview — Empty (no tenants)",
  decorators: [makeDecorator([[OPS_TENANTS_QUERY_KEY, fixtureTenantsEmpty]])],
};

export const TenantOverviewError: StoryObj<typeof OpsTenantOverviewScreen> = {
  name: "Tenant Overview — Error (tenants fetch failed)",
  decorators: [
    makeDecorator([
      [OPS_TENANTS_QUERY_KEY, undefined],
    ]),
  ],
};

// ---------------------------------------------------------------------------
// Provisioning screen — OpsProvisioningScreen
// ---------------------------------------------------------------------------

export const ProvisioningScreenMeta: Meta<typeof OpsProvisioningScreen> = {
  title: "LiteLLM Ops Console/OpsProvisioningScreen",
  component: OpsProvisioningScreen,
  parameters: { layout: "padded" },
  tags: ["autodocs"],
};

export const ProvisioningDefault: StoryObj<typeof OpsProvisioningScreen> = {
  name: "Provisioning — Default (create team / invite / role forms)",
  decorators: [makeDecorator()],
};

// ---------------------------------------------------------------------------
// Platform Settings screen — OpsPlatformSettingsScreen
// ---------------------------------------------------------------------------

export const PlatformSettingsScreenMeta: Meta<typeof OpsPlatformSettingsScreen> = {
  title: "LiteLLM Ops Console/OpsPlatformSettingsScreen",
  component: OpsPlatformSettingsScreen,
  parameters: { layout: "padded" },
  tags: ["autodocs"],
};

export const PlatformSettingsLoading: StoryObj<typeof OpsPlatformSettingsScreen> = {
  name: "Platform Settings — Loading (no cache)",
  decorators: [makeDecorator()],
};

export const PlatformSettingsEnabled: StoryObj<typeof OpsPlatformSettingsScreen> = {
  name: "Platform Settings — Loaded (write ops enabled)",
  decorators: [
    makeDecorator([
      [OPS_PLATFORM_SETTINGS_QUERY_KEY, fixturePlatformSettingsEnabled],
    ]),
  ],
};

export const PlatformSettingsDisabled: StoryObj<typeof OpsPlatformSettingsScreen> = {
  name: "Platform Settings — Loaded (write ops disabled)",
  decorators: [
    makeDecorator([
      [OPS_PLATFORM_SETTINGS_QUERY_KEY, fixturePlatformSettingsDisabled],
    ]),
  ],
};

export const PlatformSettingsError: StoryObj<typeof OpsPlatformSettingsScreen> = {
  name: "Platform Settings — Error (settings fetch failed)",
  decorators: [makeDecorator([[OPS_PLATFORM_SETTINGS_QUERY_KEY, undefined]])],
};

// ---------------------------------------------------------------------------
// Tenant Detail body — OpsTenantDetailBody
// ---------------------------------------------------------------------------

export const TenantDetailMeta: Meta<typeof OpsTenantDetailBody> = {
  title: "LiteLLM Ops Console/OpsTenantDetailBody",
  component: OpsTenantDetailBody,
  parameters: { layout: "padded" },
  tags: ["autodocs"],
};

export const TenantDetailLoading: StoryObj<typeof OpsTenantDetailBody> = {
  name: "Tenant Detail — Loading (no cache)",
  args: { teamId: "team-acme-1" },
  decorators: [makeDecorator()],
};

export const TenantDetailLoaded: StoryObj<typeof OpsTenantDetailBody> = {
  name: "Tenant Detail — Loaded (2 members)",
  args: { teamId: "team-acme-1" },
  decorators: [
    makeDecorator([
      [OPS_TENANT_DETAIL_QUERY_KEY("team-acme-1"), fixtureTenantDetail],
    ]),
  ],
};

export const TenantDetailEmpty: StoryObj<typeof OpsTenantDetailBody> = {
  name: "Tenant Detail — Empty (no members)",
  args: { teamId: "team-zen-2" },
  decorators: [
    makeDecorator([
      [OPS_TENANT_DETAIL_QUERY_KEY("team-zen-2"), fixtureTenantDetailEmpty],
    ]),
  ],
};

export const TenantDetailError: StoryObj<typeof OpsTenantDetailBody> = {
  name: "Tenant Detail — Error (detail fetch failed)",
  args: { teamId: "team-acme-1" },
  decorators: [
    makeDecorator([[OPS_TENANT_DETAIL_QUERY_KEY("team-acme-1"), undefined]]),
  ],
};

// ---------------------------------------------------------------------------
// User Detail body — OpsUserDetailBody
// ---------------------------------------------------------------------------

export const UserDetailMeta: Meta<typeof OpsUserDetailBody> = {
  title: "LiteLLM Ops Console/OpsUserDetailBody",
  component: OpsUserDetailBody,
  parameters: { layout: "padded" },
  tags: ["autodocs"],
};

export const UserDetailLoading: StoryObj<typeof OpsUserDetailBody> = {
  name: "User Detail — Loading (no cache)",
  args: { userId: "u-admin-1" },
  decorators: [makeDecorator()],
};

export const UserDetailLoaded: StoryObj<typeof OpsUserDetailBody> = {
  name: "User Detail — Loaded (tenant admin)",
  args: { userId: "u-admin-1" },
  decorators: [
    makeDecorator([
      [OPS_USER_DETAIL_QUERY_KEY("u-admin-1"), fixtureUserDetail],
    ]),
  ],
};

export const UserDetailError: StoryObj<typeof OpsUserDetailBody> = {
  name: "User Detail — Error (detail fetch failed)",
  args: { userId: "u-admin-1" },
  decorators: [
    makeDecorator([[OPS_USER_DETAIL_QUERY_KEY("u-admin-1"), undefined]]),
  ],
};

// ---------------------------------------------------------------------------
// Audit detail card — AuditEventDetailCard
// ---------------------------------------------------------------------------

export const AuditDetailMeta: Meta<typeof AuditEventDetailCard> = {
  title: "LiteLLM Ops Console/AuditEventDetailCard",
  component: AuditEventDetailCard,
  parameters: { layout: "padded" },
  tags: ["autodocs"],
};

export const AuditDetailLoading: StoryObj<typeof AuditEventDetailCard> = {
  name: "Audit Detail — Loading (no cache)",
  args: { eventId: "ev-1" },
  decorators: [makeDecorator()],
};

export const AuditDetailLoaded: StoryObj<typeof AuditEventDetailCard> = {
  name: "Audit Detail — Loaded (impersonation event)",
  args: { eventId: "ev-1" },
  decorators: [
    makeDecorator([[OPS_AUDIT_EVENT_QUERY_KEY("ev-1"), fixtureAuditEvent]]),
  ],
};

export const AuditDetailError: StoryObj<typeof AuditEventDetailCard> = {
  name: "Audit Detail — Error (event fetch failed)",
  args: { eventId: "ev-1" },
  decorators: [
    makeDecorator([[OPS_AUDIT_EVENT_QUERY_KEY("ev-1"), undefined]]),
  ],
};

// ---------------------------------------------------------------------------
// Global Usage screen — OpsGlobalUsageScreen
// ---------------------------------------------------------------------------

export const GlobalUsageScreenMeta: Meta<typeof OpsGlobalUsageScreen> = {
  title: "LiteLLM Ops Console/OpsGlobalUsageScreen",
  component: OpsGlobalUsageScreen,
  parameters: { layout: "padded" },
  tags: ["autodocs"],
};

export const GlobalUsageLoading: StoryObj<typeof OpsGlobalUsageScreen> = {
  name: "Global Usage — Loading (no cache)",
  decorators: [makeDecorator([[ME_QUERY_KEY, fixtureMeOwner]])],
};

export const GlobalUsageSeeded: StoryObj<typeof OpsGlobalUsageScreen> = {
  name: "Global Usage — Seeded (owner, global scope)",
  decorators: [
    makeDecorator([
      [ME_QUERY_KEY, fixtureMeOwner],
      [DASHBOARD_QUERY_KEY({ kind: "global" }, "30d"), undefined],
    ]),
  ],
};
