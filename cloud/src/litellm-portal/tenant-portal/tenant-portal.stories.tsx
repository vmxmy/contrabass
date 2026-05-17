/**
 * Storybook stories for LiteLLM Tenant Portal components.
 *
 * Mirrors the portal.stories.tsx idiom exactly:
 *   - CSF3 format with Meta / StoryObj from @storybook/react
 *   - Per-story decorators provide QueryClient (seeded with inline fixtures)
 *     and Lingui I18nProvider — no network calls, no Cloudflare bindings.
 *   - Each screen covered in: loading / empty / loaded / error variants.
 *   - Shell covered in: tenant_admin / member / pure-Owner identity variants.
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
import { DASHBOARD_QUERY_KEY } from "../hooks/use-dashboard";
import {
  TENANT_INVITES_QUERY_KEY,
  TENANT_WEBHOOK_QUERY_KEY,
  TENANT_BILLING_QUERY_KEY,
} from "./hooks";
import type { Me, Dashboard } from "../schemas";
import type {
  AdminInviteList,
  TeamAlertWebhookResult,
  TenantBillingPeriods,
} from "../schemas";
import { TenantPortalShell } from "./shell";
import { TenantOverviewScreen } from "./screens/overview";
import { TenantUsageScreen } from "./screens/usage";
import { TenantKeysScreen } from "./screens/keys";
import { TenantMembersScreen } from "./screens/members";
import { TenantAlertsScreen } from "./screens/alerts";
import { TenantBillingScreen } from "./screens/billing";
import type { PortalIdentity } from "../types";
import type { TenantBrand } from "./shell";

// ---------------------------------------------------------------------------
// Lingui i18n instance (zh-CN default, matches app default)
// ---------------------------------------------------------------------------

const i18n = setupI18n("zh-CN");

// ---------------------------------------------------------------------------
// Shared fixture data
// ---------------------------------------------------------------------------

const fixtureMeTenantAdmin: Me = {
  email: "admin@acme.example.com",
  userId: "u-admin-1",
  company: "Acme AI",
  domain: "acme.example.com",
  role: "user",
  tenantRole: "tenant_admin",
  tenantTeamId: "team-acme-1",
};

const fixtureMeMember: Me = {
  email: "member@acme.example.com",
  userId: "u-member-1",
  company: "Acme AI",
  domain: "acme.example.com",
  role: "user",
  tenantRole: "member",
  tenantTeamId: "team-acme-1",
};

const fixtureMePureOwner: Me = {
  email: "owner@acme.example.com",
  userId: "u-owner-1",
  company: "Acme AI",
  domain: "acme.example.com",
  role: "admin",
  tenantRole: null,
  tenantTeamId: null,
};

const fixtureDashboard: Dashboard = {
  me: { email: "admin@acme.example.com" },
  user: { litellmUserId: "u-admin-1", totalSpend: 42.5, maxBudget: 200 },
  summary: {
    recentSpend: 10.0,
    keyBudget: null,
    availableModelCount: 5,
    keyCount: 3,
    teamCount: 1,
    totalTokens: 123_456,
    requestCount: 88,
  },
  models: { models: ["gpt-4", "claude-3-opus", "deepseek-v3"], source: "team" },
  teams: [
    {
      id: "team-acme-1",
      alias: "acme-core",
      models: ["gpt-4", "claude-3-opus"],
      spend: 42.5,
      maxBudget: 200,
      tpmLimit: null,
      rpmLimit: null,
    },
  ],
  keys: {
    totalCount: 1,
    items: [
      {
        id: "key-1",
        alias: "prod-key",
        displayKey: "sk-lit...abc",
        models: [],
        spend: 5,
        maxBudget: 50,
        expiresAt: null,
      },
    ],
  },
  usage: { available: true },
};

const fixtureInvitesLoaded: AdminInviteList = {
  invites: [
    { email: "alice@acme.example.com", teamRole: "user", status: "pending" },
    { email: "bob@acme.example.com", teamRole: "admin", status: "consumed" },
    { email: "carol@acme.example.com", teamRole: "user", status: "revoked" },
  ],
};

const fixtureWebhookConfigured: TeamAlertWebhookResult = {
  teamId: "team-acme-1",
  url: "https://hooks.example.com/notify",
  updatedAt: "2025-05-01T08:00:00Z",
};

const fixtureWebhookEmpty: TeamAlertWebhookResult = {
  teamId: "team-acme-1",
  url: null,
  updatedAt: null,
};

const fixtureBillingPeriods: TenantBillingPeriods = {
  periods: ["2025-04", "2025-03", "2025-02"],
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
// Shell — TenantPortalShell
// ---------------------------------------------------------------------------

const identityTenantAdmin: PortalIdentity = {
  email: fixtureMeTenantAdmin.email,
  userId: fixtureMeTenantAdmin.userId,
  domain: fixtureMeTenantAdmin.domain,
  litellmUserId: fixtureMeTenantAdmin.userId,
  role: fixtureMeTenantAdmin.role,
  tenantRole: "tenant_admin",
  tenantTeamId: "team-acme-1",
};

const identityMember: PortalIdentity = {
  email: fixtureMeMember.email,
  userId: fixtureMeMember.userId,
  domain: fixtureMeMember.domain,
  litellmUserId: fixtureMeMember.userId,
  role: fixtureMeMember.role,
  tenantRole: "member",
  tenantTeamId: "team-acme-1",
};

const identityPureOwner: PortalIdentity = {
  email: fixtureMePureOwner.email,
  userId: fixtureMePureOwner.userId,
  domain: fixtureMePureOwner.domain,
  litellmUserId: fixtureMePureOwner.userId,
  role: "admin",
  tenantRole: null,
  tenantTeamId: null,
};

const fixtureBrand: TenantBrand = {
  name: "Acme AI",
  logoUrl: null,
  primaryColor: "#1d4ed8",
};

const shellMeta: Meta<typeof TenantPortalShell> = {
  title: "LiteLLM Portal/TenantPortalShell",
  component: TenantPortalShell,
  parameters: { layout: "fullscreen" },
  tags: ["autodocs"],
  decorators: [makeDecorator()],
};

export default shellMeta;

export const ShellTenantAdmin: StoryObj<typeof TenantPortalShell> = {
  name: "Shell — tenant_admin (full 6-item nav)",
  args: {
    identity: identityTenantAdmin,
    brand: fixtureBrand,
    children: <div className="p-6 text-kumo-default">Screen content here</div>,
  },
};

export const ShellMember: StoryObj<typeof TenantPortalShell> = {
  name: "Shell — member (3-item nav)",
  args: {
    identity: identityMember,
    brand: fixtureBrand,
    children: <div className="p-6 text-kumo-default">Screen content here</div>,
  },
};

export const ShellPureOwner: StoryObj<typeof TenantPortalShell> = {
  name: "Shell — pure Owner (Phase-2 notice, no nav)",
  args: {
    identity: identityPureOwner,
    brand: fixtureBrand,
    children: <div className="p-6 text-kumo-default">Screen content here</div>,
  },
};

// ---------------------------------------------------------------------------
// Overview screen — TenantOverviewScreen
// ---------------------------------------------------------------------------

export const OverviewScreenMeta: Meta<typeof TenantOverviewScreen> = {
  title: "LiteLLM Portal/TenantOverviewScreen",
  component: TenantOverviewScreen,
  parameters: { layout: "padded" },
  tags: ["autodocs"],
};

export const OverviewLoading: StoryObj<typeof TenantOverviewScreen> = {
  name: "Overview — Loading (no cache)",
  decorators: [makeDecorator()],
};

export const OverviewLoaded: StoryObj<typeof TenantOverviewScreen> = {
  name: "Overview — Loaded (tenant_admin)",
  decorators: [
    makeDecorator([
      [ME_QUERY_KEY, fixtureMeTenantAdmin],
      [DASHBOARD_QUERY_KEY, fixtureDashboard],
      [TENANT_WEBHOOK_QUERY_KEY, fixtureWebhookConfigured],
    ]),
  ],
};

export const OverviewLoadedMember: StoryObj<typeof TenantOverviewScreen> = {
  name: "Overview — Loaded (member, no team tiles)",
  decorators: [
    makeDecorator([
      [ME_QUERY_KEY, fixtureMeMember],
      [DASHBOARD_QUERY_KEY, fixtureDashboard],
    ]),
  ],
};

export const OverviewEmpty: StoryObj<typeof TenantOverviewScreen> = {
  name: "Overview — Empty (no models, no webhook)",
  decorators: [
    makeDecorator([
      [ME_QUERY_KEY, fixtureMeTenantAdmin],
      [
        DASHBOARD_QUERY_KEY,
        {
          ...fixtureDashboard,
          models: { models: [], source: "team" },
          summary: { ...fixtureDashboard.summary, requestCount: 0, totalTokens: 0 },
        } satisfies Dashboard,
      ],
      [TENANT_WEBHOOK_QUERY_KEY, fixtureWebhookEmpty],
    ]),
  ],
};

export const OverviewError: StoryObj<typeof TenantOverviewScreen> = {
  name: "Overview — Error (dashboard fetch failed)",
  decorators: [makeDecorator([[ME_QUERY_KEY, fixtureMeTenantAdmin]])],
};

// ---------------------------------------------------------------------------
// Usage screen — TenantUsageScreen
// ---------------------------------------------------------------------------

export const UsageScreenMeta: Meta<typeof TenantUsageScreen> = {
  title: "LiteLLM Portal/TenantUsageScreen",
  component: TenantUsageScreen,
  parameters: { layout: "padded" },
  tags: ["autodocs"],
};

export const UsageLoading: StoryObj<typeof TenantUsageScreen> = {
  name: "Usage — Loading (no cache)",
  decorators: [makeDecorator([[ME_QUERY_KEY, fixtureMeTenantAdmin]])],
};

export const UsageLoaded: StoryObj<typeof TenantUsageScreen> = {
  name: "Usage — Loaded (tenant_admin)",
  decorators: [
    makeDecorator([
      [ME_QUERY_KEY, fixtureMeTenantAdmin],
      [DASHBOARD_QUERY_KEY, fixtureDashboard],
    ]),
  ],
};

export const UsageEmpty: StoryObj<typeof TenantUsageScreen> = {
  name: "Usage — Empty (member, no usage)",
  decorators: [
    makeDecorator([
      [ME_QUERY_KEY, fixtureMeMember],
      [DASHBOARD_QUERY_KEY, { ...fixtureDashboard, usage: { available: false } } satisfies Dashboard],
    ]),
  ],
};

export const UsageError: StoryObj<typeof TenantUsageScreen> = {
  name: "Usage — Error (no me data)",
  decorators: [makeDecorator()],
};

// ---------------------------------------------------------------------------
// Keys screen — TenantKeysScreen
// ---------------------------------------------------------------------------

export const KeysScreenMeta: Meta<typeof TenantKeysScreen> = {
  title: "LiteLLM Portal/TenantKeysScreen",
  component: TenantKeysScreen,
  parameters: { layout: "padded" },
  tags: ["autodocs"],
};

export const KeysLoading: StoryObj<typeof TenantKeysScreen> = {
  name: "Keys — Loading (no cache)",
  decorators: [makeDecorator([[ME_QUERY_KEY, fixtureMeTenantAdmin]])],
};

export const KeysLoaded: StoryObj<typeof TenantKeysScreen> = {
  name: "Keys — Loaded (1 key)",
  decorators: [
    makeDecorator([
      [ME_QUERY_KEY, fixtureMeTenantAdmin],
      [DASHBOARD_QUERY_KEY, fixtureDashboard],
    ]),
  ],
};

export const KeysEmpty: StoryObj<typeof TenantKeysScreen> = {
  name: "Keys — Empty (no keys)",
  decorators: [
    makeDecorator([
      [ME_QUERY_KEY, fixtureMeTenantAdmin],
      [
        DASHBOARD_QUERY_KEY,
        { ...fixtureDashboard, keys: { totalCount: 0, items: [] } } satisfies Dashboard,
      ],
    ]),
  ],
};

export const KeysError: StoryObj<typeof TenantKeysScreen> = {
  name: "Keys — Error (no me/dashboard data)",
  decorators: [makeDecorator()],
};

// ---------------------------------------------------------------------------
// Members screen — TenantMembersScreen
// ---------------------------------------------------------------------------

export const MembersScreenMeta: Meta<typeof TenantMembersScreen> = {
  title: "LiteLLM Portal/TenantMembersScreen",
  component: TenantMembersScreen,
  parameters: { layout: "padded" },
  tags: ["autodocs"],
};

export const MembersLoading: StoryObj<typeof TenantMembersScreen> = {
  name: "Members — Loading (invites pending)",
  decorators: [makeDecorator([[ME_QUERY_KEY, fixtureMeTenantAdmin]])],
};

export const MembersLoaded: StoryObj<typeof TenantMembersScreen> = {
  name: "Members — Loaded (3 invites)",
  decorators: [
    makeDecorator([
      [ME_QUERY_KEY, fixtureMeTenantAdmin],
      [TENANT_INVITES_QUERY_KEY, fixtureInvitesLoaded],
    ]),
  ],
};

export const MembersEmpty: StoryObj<typeof TenantMembersScreen> = {
  name: "Members — Empty (no invites)",
  decorators: [
    makeDecorator([
      [ME_QUERY_KEY, fixtureMeTenantAdmin],
      [TENANT_INVITES_QUERY_KEY, { invites: [] } satisfies AdminInviteList],
    ]),
  ],
};

export const MembersError: StoryObj<typeof TenantMembersScreen> = {
  name: "Members — Error (invites fetch failed)",
  decorators: [makeDecorator([[ME_QUERY_KEY, fixtureMeTenantAdmin]])],
};

export const MembersForbidden: StoryObj<typeof TenantMembersScreen> = {
  name: "Members — Forbidden (member role)",
  decorators: [
    makeDecorator([
      [ME_QUERY_KEY, fixtureMeMember],
      [TENANT_INVITES_QUERY_KEY, fixtureInvitesLoaded],
    ]),
  ],
};

// ---------------------------------------------------------------------------
// Alerts screen — TenantAlertsScreen
// ---------------------------------------------------------------------------

export const AlertsScreenMeta: Meta<typeof TenantAlertsScreen> = {
  title: "LiteLLM Portal/TenantAlertsScreen",
  component: TenantAlertsScreen,
  parameters: { layout: "padded" },
  tags: ["autodocs"],
};

export const AlertsLoading: StoryObj<typeof TenantAlertsScreen> = {
  name: "Alerts — Loading (webhook pending)",
  decorators: [makeDecorator([[ME_QUERY_KEY, fixtureMeTenantAdmin]])],
};

export const AlertsLoaded: StoryObj<typeof TenantAlertsScreen> = {
  name: "Alerts — Loaded (webhook configured)",
  decorators: [
    makeDecorator([
      [ME_QUERY_KEY, fixtureMeTenantAdmin],
      [TENANT_WEBHOOK_QUERY_KEY, fixtureWebhookConfigured],
    ]),
  ],
};

export const AlertsEmpty: StoryObj<typeof TenantAlertsScreen> = {
  name: "Alerts — Empty (no webhook)",
  decorators: [
    makeDecorator([
      [ME_QUERY_KEY, fixtureMeTenantAdmin],
      [TENANT_WEBHOOK_QUERY_KEY, fixtureWebhookEmpty],
    ]),
  ],
};

export const AlertsError: StoryObj<typeof TenantAlertsScreen> = {
  name: "Alerts — Error (webhook fetch failed)",
  decorators: [makeDecorator([[ME_QUERY_KEY, fixtureMeTenantAdmin]])],
};

export const AlertsForbidden: StoryObj<typeof TenantAlertsScreen> = {
  name: "Alerts — Forbidden (member role)",
  decorators: [
    makeDecorator([
      [ME_QUERY_KEY, fixtureMeMember],
      [TENANT_WEBHOOK_QUERY_KEY, fixtureWebhookConfigured],
    ]),
  ],
};

// ---------------------------------------------------------------------------
// Billing screen — TenantBillingScreen
// ---------------------------------------------------------------------------

export const BillingScreenMeta: Meta<typeof TenantBillingScreen> = {
  title: "LiteLLM Portal/TenantBillingScreen",
  component: TenantBillingScreen,
  parameters: { layout: "padded" },
  tags: ["autodocs"],
};

export const BillingLoading: StoryObj<typeof TenantBillingScreen> = {
  name: "Billing — Loading (periods pending)",
  decorators: [makeDecorator([[ME_QUERY_KEY, fixtureMeTenantAdmin]])],
};

export const BillingLoaded: StoryObj<typeof TenantBillingScreen> = {
  name: "Billing — Loaded (3 periods)",
  decorators: [
    makeDecorator([
      [ME_QUERY_KEY, fixtureMeTenantAdmin],
      [TENANT_BILLING_QUERY_KEY, fixtureBillingPeriods],
    ]),
  ],
};

export const BillingEmpty: StoryObj<typeof TenantBillingScreen> = {
  name: "Billing — Empty (no periods)",
  decorators: [
    makeDecorator([
      [ME_QUERY_KEY, fixtureMeTenantAdmin],
      [TENANT_BILLING_QUERY_KEY, { periods: [] } satisfies TenantBillingPeriods],
    ]),
  ],
};

export const BillingError: StoryObj<typeof TenantBillingScreen> = {
  name: "Billing — Error (periods fetch failed)",
  decorators: [makeDecorator([[ME_QUERY_KEY, fixtureMeTenantAdmin]])],
};

export const BillingForbidden: StoryObj<typeof TenantBillingScreen> = {
  name: "Billing — Forbidden (member role)",
  decorators: [
    makeDecorator([
      [ME_QUERY_KEY, fixtureMeMember],
      [TENANT_BILLING_QUERY_KEY, fixtureBillingPeriods],
    ]),
  ],
};
