/**
 * TenantOverviewScreen — Overview / Home screen for the Tenant Portal.
 *
 * Identity gate: `adminOnly: false` — all authenticated tenant users see this
 * screen. The variant (team-admin vs member) is derived from
 * `useMe().data?.tenantRole` with no state+effect (react-useeffect rule).
 *
 * Team-only tiles (team budget ring, webhook status, top models) are HIDDEN
 * for `member` role to avoid leaking team-scoped data in the client. The
 * authoritative scope boundary is the server — this is a client UX gate only.
 *
 * Tiles are composed exclusively from existing exported components in app.tsx
 * and the existing useTenantWebhook hook. No new query/metric/chart logic.
 */
import React from "react";
import { Badge } from "@cloudflare/kumo/components/badge";
import { Empty } from "@cloudflare/kumo/components/empty";
import { LayerCard } from "@cloudflare/kumo/components/layer-card";
import { Meter } from "@cloudflare/kumo/components/meter";
import { Text } from "@cloudflare/kumo/components/text";
import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { useMe } from "../../hooks/use-me";
import { useDashboard } from "../../hooks/use-dashboard";
import { useTenantWebhook } from "../hooks";
import { SsrSafeSkeleton } from "../../components/ssr-safe-skeleton";
import { fmt, fmtInt } from "../../lib/format";

// ---------------------------------------------------------------------------
// TeamIdentityTile — shows company/brand name and team identity
// ---------------------------------------------------------------------------

function TeamIdentityTile({ company }: { company: string }) {
  const name = company.trim() === "" ? "Portal" : company;
  return (
    <LayerCard className="p-6">
      <div className="flex items-center gap-2">
        <span className="inline-block h-2 w-2 rounded-full bg-kumo-brand" />
        <Text
          variant="secondary"
          size="xs"
          className="font-semibold uppercase tracking-wider"
        >
          <Trans>团队</Trans>
        </Text>
      </div>
      <Text variant="heading2" as="p" className="mt-4 truncate">
        {name}
      </Text>
      <Text variant="secondary" as="p" className="mt-2 text-xs">
        <Trans>当前租户团队</Trans>
      </Text>
    </LayerCard>
  );
}

// ---------------------------------------------------------------------------
// PersonalSpendTile — personal user spend/budget ring (all roles)
// ---------------------------------------------------------------------------

function PersonalSpendTile() {
  const { data, isLoading } = useDashboard();

  if (isLoading) {
    return (
      <LayerCard className="space-y-3 p-6">
        <SsrSafeSkeleton minWidth={80} maxWidth={120} blockHeight={12} />
        <SsrSafeSkeleton minWidth={120} maxWidth={200} blockHeight={32} />
      </LayerCard>
    );
  }

  const totalSpend = data?.user?.totalSpend ?? 0;
  const maxBudget = data?.user?.maxBudget ?? null;

  return (
    <LayerCard className="p-6">
      <div className="flex items-center gap-2">
        <span className="inline-block h-2 w-2 rounded-full bg-kumo-info" />
        <Text
          variant="secondary"
          size="xs"
          className="font-semibold uppercase tracking-wider"
        >
          <Trans>个人花费</Trans>
        </Text>
      </div>
      <Text variant="heading1" as="p" className="mt-4 leading-tight">
        {fmt(totalSpend)}
      </Text>
      {maxBudget != null ? (
        <Meter
          className="mt-3"
          value={Number(totalSpend)}
          max={maxBudget}
          customValue={t`${fmt(totalSpend)} / ${fmt(maxBudget)}`}
        />
      ) : null}
      <Text variant="secondary" as="p" className="mt-2 text-xs">
        <Trans>累计花费</Trans>
      </Text>
    </LayerCard>
  );
}

// ---------------------------------------------------------------------------
// TeamBudgetTile — team spend-vs-budget ring (tenant_admin only)
// ---------------------------------------------------------------------------

function TeamBudgetTile() {
  const { data, isLoading } = useDashboard();

  if (isLoading) {
    return (
      <LayerCard className="space-y-3 p-6" id="tenant-overview-team-budget-tile">
        <SsrSafeSkeleton minWidth={80} maxWidth={120} blockHeight={12} />
        <SsrSafeSkeleton minWidth={120} maxWidth={200} blockHeight={32} />
      </LayerCard>
    );
  }

  const teams = data?.teams ?? [];
  const firstTeam = teams[0];
  const teamSpend = firstTeam?.spend ?? 0;
  const teamBudget = firstTeam?.maxBudget ?? null;
  const teamName = firstTeam?.alias ?? firstTeam?.id ?? null;

  return (
    <LayerCard className="p-6" id="tenant-overview-team-budget-tile">
      <div className="flex items-center gap-2">
        <span className="inline-block h-2 w-2 rounded-full bg-kumo-brand" />
        <Text
          variant="secondary"
          size="xs"
          className="font-semibold uppercase tracking-wider"
        >
          <Trans>团队预算</Trans>
        </Text>
      </div>
      <Text variant="heading1" as="p" className="mt-4 leading-tight">
        {fmt(teamSpend)}
      </Text>
      {teamBudget != null ? (
        <Meter
          className="mt-3"
          value={Number(teamSpend)}
          max={teamBudget}
          customValue={t`${fmt(teamSpend)} / ${fmt(teamBudget)}`}
        />
      ) : null}
      {teamName != null ? (
        <Text variant="secondary" as="p" className="mt-2 text-xs">
          {teamName}
        </Text>
      ) : null}
    </LayerCard>
  );
}

// ---------------------------------------------------------------------------
// WebhookStatusTile — alert/webhook configured-or-not (tenant_admin only)
// ---------------------------------------------------------------------------

function WebhookStatusTile() {
  const { data, isLoading, isError } = useTenantWebhook();

  if (isLoading) {
    return (
      <LayerCard
        className="space-y-3 p-6"
        id="tenant-overview-webhook-tile"
      >
        <SsrSafeSkeleton minWidth={80} maxWidth={120} blockHeight={12} />
        <SsrSafeSkeleton minWidth={120} maxWidth={200} blockHeight={20} />
      </LayerCard>
    );
  }

  if (isError) {
    return (
      <LayerCard className="p-6" id="tenant-overview-webhook-tile">
        <div className="flex items-center gap-2">
          <span className="inline-block h-2 w-2 rounded-full bg-kumo-warning" />
          <Text
            variant="secondary"
            size="xs"
            className="font-semibold uppercase tracking-wider"
          >
            <Trans>告警 Webhook</Trans>
          </Text>
        </div>
        <Text variant="secondary" as="p" className="mt-4 text-sm">
          <Trans>加载失败</Trans>
        </Text>
      </LayerCard>
    );
  }

  const isConfigured = data?.url != null && data.url.length > 0;

  return (
    <LayerCard className="p-6" id="tenant-overview-webhook-tile">
      <div className="flex items-center gap-2">
        <span
          className={`inline-block h-2 w-2 rounded-full ${isConfigured ? "bg-kumo-success" : "bg-kumo-warning"}`}
        />
        <Text
          variant="secondary"
          size="xs"
          className="font-semibold uppercase tracking-wider"
        >
          <Trans>告警 Webhook</Trans>
        </Text>
      </div>
      <div className="mt-4">
        {isConfigured ? (
          <>
            <Badge variant="success">
              <Trans>已配置</Trans>
            </Badge>
            <Text
              as="p"
              className="mt-2 break-all font-mono text-xs text-kumo-subtle"
            >
              {data.url}
            </Text>
          </>
        ) : (
          <Badge variant="warning">
            <Trans>未配置</Trans>
          </Badge>
        )}
      </div>
    </LayerCard>
  );
}

// ---------------------------------------------------------------------------
// TopModelsTile — top models from dashboard summary (tenant_admin only)
// ---------------------------------------------------------------------------

function TopModelsTile() {
  const { data, isLoading } = useDashboard();

  if (isLoading) {
    return (
      <article className="overflow-hidden rounded-xl bg-kumo-base ring-1 ring-kumo-line">
        <div className="border-b border-kumo-line bg-kumo-elevated p-6">
          <Text variant="heading3" as="p">
            <Trans>高频模型</Trans>
          </Text>
        </div>
        <div className="space-y-3 p-6">
          <SsrSafeSkeleton minWidth={120} maxWidth={300} blockHeight={16} />
          <SsrSafeSkeleton minWidth={100} maxWidth={260} blockHeight={16} />
        </div>
      </article>
    );
  }

  const models = data?.models?.models ?? [];

  if (models.length === 0) {
    return (
      <article className="overflow-hidden rounded-xl bg-kumo-base ring-1 ring-kumo-line">
        <div className="border-b border-kumo-line bg-kumo-elevated p-6">
          <Text variant="heading3" as="p">
            <Trans>高频模型</Trans>
          </Text>
        </div>
        <div className="p-6">
          <Empty size="sm" title={t`暂无模型数据`} />
        </div>
      </article>
    );
  }

  const preview = models.slice(0, 5);

  return (
    <article className="overflow-hidden rounded-xl bg-kumo-base ring-1 ring-kumo-line">
      <div className="flex items-center justify-between border-b border-kumo-line bg-kumo-elevated p-6">
        <Text variant="heading3" as="p">
          <Trans>高频模型</Trans>
        </Text>
        <Badge variant="outline" className="rounded-full">
          {models.length} <Trans>个模型</Trans>
        </Badge>
      </div>
      <div className="flex flex-wrap gap-2 p-6">
        {preview.map((model) => (
          <Badge key={model} variant="secondary" className="rounded-full font-mono text-xs">
            {model}
          </Badge>
        ))}
        {models.length > 5 ? (
          <Badge variant="secondary" className="rounded-full text-xs">
            +{models.length - 5}
          </Badge>
        ) : null}
      </div>
    </article>
  );
}

// ---------------------------------------------------------------------------
// RecentActivityTile — quick activity summary (all roles)
// ---------------------------------------------------------------------------

function RecentActivityTile() {
  const { data, isLoading } = useDashboard();

  if (isLoading) {
    return (
      <LayerCard className="space-y-3 p-6">
        <SsrSafeSkeleton minWidth={80} maxWidth={120} blockHeight={12} />
        <SsrSafeSkeleton minWidth={100} maxWidth={180} blockHeight={28} />
      </LayerCard>
    );
  }

  const requestCount = data?.summary?.requestCount ?? null;
  const totalTokens = data?.summary?.totalTokens ?? null;
  const recentSpend = data?.summary?.recentSpend ?? null;

  return (
    <LayerCard className="p-6">
      <div className="flex items-center gap-2">
        <span className="inline-block h-2 w-2 rounded-full bg-kumo-success" />
        <Text
          variant="secondary"
          size="xs"
          className="font-semibold uppercase tracking-wider"
        >
          <Trans>近 30 天</Trans>
        </Text>
      </div>
      <Text variant="heading1" as="p" className="mt-4 leading-tight">
        {fmt(recentSpend)}
      </Text>
      <Text variant="secondary" as="p" className="mt-3 text-sm">
        {fmtInt(requestCount)} <Trans>次请求</Trans> · {fmtInt(totalTokens)} tokens
      </Text>
    </LayerCard>
  );
}

// ---------------------------------------------------------------------------
// TenantOverviewScreen — exported screen component
// ---------------------------------------------------------------------------

export function TenantOverviewScreen() {
  // Derived variant — no state+effect, per react-useeffect rule.
  // CLIENT-SIDE UX ONLY: server is the authoritative scope boundary.
  const me = useMe().data;
  const isTenantAdmin = me?.tenantRole === "tenant_admin";
  const company = me?.company ?? "";

  return (
    <div id="tenant-overview-root" className="space-y-6">
      {/* KPI row: identity + personal spend + (team budget ring for admin) + recent activity */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <TeamIdentityTile company={company} />
        <PersonalSpendTile />
        {isTenantAdmin ? <TeamBudgetTile /> : null}
        <RecentActivityTile />
      </div>

      {/* Team-only tiles: webhook status + top models (hidden for member) */}
      {isTenantAdmin ? (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          <WebhookStatusTile />
          <TopModelsTile />
        </div>
      ) : null}
    </div>
  );
}
