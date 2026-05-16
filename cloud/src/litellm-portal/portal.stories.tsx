/**
 * Storybook stories for LiteLLM Portal compound components.
 *
 * Each component has at least three variants:
 *   - loading   (no initialData / data still resolving)
 *   - empty     (data loaded but no items)
 *   - loaded    (realistic data)
 *
 * Stories are intentionally self-contained: they import only from this
 * package and from React — no network calls, no Cloudflare bindings.
 */

import type { Meta, StoryObj } from "@storybook/react";
import React from "react";

import {
  HeroStats,
  TeamsAccessCard,
  ApiKeysCard,
  HeaderActions,
  type InitialDashboardData,
} from "./app";
import { AdminSection } from "./admin-components";

// ---------------------------------------------------------------------------
// Shared fixture data
// ---------------------------------------------------------------------------

const sampleInitialData: InitialDashboardData = {
  me: { email: "alice@example.com", domain: "example.com", company: "Acme AI" },
  user: { litellmUserId: "usr_abc123", totalSpend: 12.34, maxBudget: 50 },
  summary: {
    totalSpend: 12.34,
    recentSpend: 3.21,
    keyBudget: 20,
    keyCount: 3,
    availableModelCount: 8,
    teamCount: 2,
    totalTokens: 1_234_567,
    requestCount: 4_200,
  },
  teams: [
    {
      id: "team_abc",
      alias: "core-team",
      models: ["gpt-4", "claude-3-opus", "deepseek-v3"],
      spend: 5.5,
      maxBudget: 100,
      tpmLimit: 50_000,
      rpmLimit: 500,
    },
    {
      id: "team_def",
      alias: "ops-team",
      models: [],
      spend: null,
      maxBudget: null,
      tpmLimit: null,
      rpmLimit: null,
    },
  ],
  keys: {
    totalCount: 2,
    items: [
      {
        id: "key_xyz",
        alias: "production-api",
        displayKey: "sk-...xyz",
        models: ["gpt-4"],
        spend: 7.2,
        maxBudget: 25,
        expiresAt: "2026-12-31",
      },
      {
        id: "key_uvw",
        alias: "staging",
        displayKey: "sk-...uvw",
        models: [],
        spend: 0,
        maxBudget: null,
        expiresAt: null,
      },
    ],
  },
  usage: { available: true },
  role: "user",
  email: "alice@example.com",
  litellmUserId: "usr_abc123",
};

// ---------------------------------------------------------------------------
// HeroStats
// ---------------------------------------------------------------------------

const heroStatsMeta: Meta<typeof HeroStats> = {
  title: "LiteLLM Portal/HeroStats",
  component: HeroStats,
  parameters: { layout: "padded" },
  tags: ["autodocs"],
};

export default heroStatsMeta;

export const HeroStatsLoading: StoryObj<typeof HeroStats> = {
  name: "Loading (no data)",
  args: {
    initialData: null,
  },
};

export const HeroStatsEmpty: StoryObj<typeof HeroStats> = {
  name: "Empty (new user)",
  args: {
    initialData: {
      me: { email: "new@example.com" },
      user: {},
      summary: {},
    },
  },
};

export const HeroStatsLoaded: StoryObj<typeof HeroStats> = {
  name: "Loaded (real data)",
  args: {
    initialData: sampleInitialData,
  },
};

// ---------------------------------------------------------------------------
// TeamsAccessCard
// ---------------------------------------------------------------------------

export const TeamsAccessCardMeta: Meta<typeof TeamsAccessCard> = {
  title: "LiteLLM Portal/TeamsAccessCard",
  component: TeamsAccessCard,
  parameters: { layout: "padded" },
  tags: ["autodocs"],
};

export const TeamsAccessCardLoading: StoryObj<typeof TeamsAccessCard> = {
  name: "Loading",
  args: { initialData: undefined },
};

export const TeamsAccessCardEmpty: StoryObj<typeof TeamsAccessCard> = {
  name: "Empty (no teams)",
  args: {
    initialData: {
      teams: [],
    },
  },
};

export const TeamsAccessCardLoaded: StoryObj<typeof TeamsAccessCard> = {
  name: "Loaded",
  args: {
    initialData: sampleInitialData,
  },
};

// ---------------------------------------------------------------------------
// ApiKeysCard
// ---------------------------------------------------------------------------

export const ApiKeysCardMeta: Meta<typeof ApiKeysCard> = {
  title: "LiteLLM Portal/ApiKeysCard",
  component: ApiKeysCard,
  parameters: { layout: "padded" },
  tags: ["autodocs"],
};

export const ApiKeysCardLoading: StoryObj<typeof ApiKeysCard> = {
  name: "Loading (skeleton)",
  args: { initialData: undefined },
};

export const ApiKeysCardEmpty: StoryObj<typeof ApiKeysCard> = {
  name: "Empty (no keys)",
  args: {
    initialData: {
      keys: { totalCount: 0, items: [] },
    },
  },
};

export const ApiKeysCardLoaded: StoryObj<typeof ApiKeysCard> = {
  name: "Loaded (2 keys)",
  args: {
    initialData: sampleInitialData,
  },
};

// ---------------------------------------------------------------------------
// AdminSection (wraps AdminCard + AdminHeroStats)
// ---------------------------------------------------------------------------

export const AdminSectionMeta: Meta<typeof AdminSection> = {
  title: "LiteLLM Portal/AdminSection",
  component: AdminSection,
  parameters: { layout: "padded" },
  tags: ["autodocs"],
};

export const AdminSectionHidden: StoryObj<typeof AdminSection> = {
  name: "Hidden (non-admin role)",
  args: { role: "user" },
};

export const AdminSectionNone: StoryObj<typeof AdminSection> = {
  name: "Hidden (role=none)",
  args: { role: "none" },
};

export const AdminSectionVisible: StoryObj<typeof AdminSection> = {
  name: "Visible (admin role)",
  args: { role: "admin" },
};

// ---------------------------------------------------------------------------
// HeaderActions
// ---------------------------------------------------------------------------

export const HeaderActionsMeta: Meta<typeof HeaderActions> = {
  title: "LiteLLM Portal/HeaderActions",
  component: HeaderActions,
  parameters: { layout: "centered" },
  tags: ["autodocs"],
};

export const HeaderActionsDefault: StoryObj<typeof HeaderActions> = {
  name: "Default (light mode)",
  args: {},
};

export const HeaderActionsDarkMode: StoryObj<typeof HeaderActions> = {
  name: "Dark mode (simulated)",
  decorators: [
    (Story) => {
      React.useEffect(() => {
        document.documentElement.dataset["mode"] = "dark";
        return () => {
          delete document.documentElement.dataset["mode"];
        };
      }, []);
      return <Story />;
    },
  ],
};

export const HeaderActionsInHeader: StoryObj<typeof HeaderActions> = {
  name: "In header context",
  decorators: [
    (Story) => (
      <header className="flex items-center justify-end gap-3 border-b border-kumo-line bg-kumo-base px-6 py-4">
        <Story />
      </header>
    ),
  ],
};
