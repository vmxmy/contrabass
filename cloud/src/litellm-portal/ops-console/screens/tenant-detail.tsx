import React, { useCallback } from "react";
import { Badge } from "@cloudflare/kumo/components/badge";
import { Banner } from "@cloudflare/kumo/components/banner";
import { Button } from "@cloudflare/kumo/components/button";
import { Empty } from "@cloudflare/kumo/components/empty";
import { SkeletonLine } from "@cloudflare/kumo/components/loader";
import { Table } from "@cloudflare/kumo/components/table";
import { Text } from "@cloudflare/kumo/components/text";
import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { useParams } from "@tanstack/react-router";
import { useOpsTenantDetail, useStartImpersonation } from "../hooks";

export function OpsTenantDetailBody({ teamId }: { teamId: string }) {
  const { data, isLoading, isError, error } = useOpsTenantDetail(teamId);
  const startImpersonation = useStartImpersonation();

  const enterTenant = useCallback(() => {
    startImpersonation.mutate(
      { teamId, reason: "ops_enter_tenant" },
      {
        onSuccess: () => {
          if (typeof window !== "undefined") window.location.assign("/");
        },
      },
    );
  }, [startImpersonation, teamId]);

  if (isLoading) {
    return (
      <div id="ops-tenant-detail-root" className="space-y-3 p-6">
        <SkeletonLine minWidth={200} maxWidth={400} blockHeight={16} />
        <SkeletonLine minWidth={200} maxWidth={400} blockHeight={16} />
      </div>
    );
  }
  if (isError) {
    return (
      <div id="ops-tenant-detail-root">
        <Banner
          variant="error"
          title={t`租户详情加载失败`}
          description={error instanceof Error ? error.message : t`网络请求失败`}
        />
      </div>
    );
  }
  if (!data) {
    return (
      <div id="ops-tenant-detail-root">
        <Empty size="sm" title={t`未找到租户`} />
      </div>
    );
  }

  return (
    <div id="ops-tenant-detail-root" className="space-y-6">
      <article className="overflow-hidden rounded-xl bg-kumo-base ring-1 ring-kumo-line">
        <div className="flex items-start justify-between gap-4 border-b border-kumo-line bg-kumo-elevated p-6">
          <div>
            <Text variant="heading3" as="p">{data.alias ?? data.teamId}</Text>
            <Text variant="secondary" as="p">{data.teamId}</Text>
          </div>
          <Button
            variant="primary"
            size="sm"
            loading={startImpersonation.isPending}
            onClick={enterTenant}
          >
            <Trans>进入租户</Trans>
          </Button>
        </div>
        <dl className="grid grid-cols-2 gap-4 p-6 text-sm sm:grid-cols-4">
          <div>
            <dt className="text-kumo-subtle"><Trans>预算</Trans></dt>
            <dd className="tabular-nums text-kumo-default">{data.maxBudget ?? "—"}</dd>
          </div>
          <div>
            <dt className="text-kumo-subtle"><Trans>本周期花费</Trans></dt>
            <dd className="tabular-nums text-kumo-default">{data.cycleSpend ?? "—"}</dd>
          </div>
          <div>
            <dt className="text-kumo-subtle"><Trans>告警 Webhook</Trans></dt>
            <dd>
              <Badge variant={data.alertWebhookUrl ? "success" : "neutral"}>
                {data.alertWebhookUrl ? t`已配置` : t`未配置`}
              </Badge>
            </dd>
          </div>
          <div>
            <dt className="text-kumo-subtle"><Trans>账单期数</Trans></dt>
            <dd className="tabular-nums text-kumo-default">{data.billingPeriods.length}</dd>
          </div>
        </dl>
      </article>

      <article className="overflow-hidden rounded-xl bg-kumo-base ring-1 ring-kumo-line">
        <div className="border-b border-kumo-line bg-kumo-elevated p-6">
          <Text variant="heading3" as="p"><Trans>成员</Trans></Text>
          <Text variant="secondary" as="p">
            <Trans>该租户的所有成员及其门户角色与花费。</Trans>
          </Text>
        </div>
        {data.members.length === 0 ? (
          <Empty size="sm" title={t`暂无成员`} />
        ) : (
          <div className="overflow-x-auto">
            <Table className="w-full text-sm">
              <Table.Header>
                <Table.Row>
                  <Table.Head><Trans>邮箱</Trans></Table.Head>
                  <Table.Head><Trans>门户角色</Trans></Table.Head>
                  <Table.Head><Trans>花费</Trans></Table.Head>
                </Table.Row>
              </Table.Header>
              <Table.Body>
                {data.members.map((m) => (
                  <Table.Row key={m.userId}>
                    <Table.Cell>
                      <a
                        href={`/ops/users/${encodeURIComponent(m.userId)}`}
                        className="font-medium text-kumo-link underline underline-offset-2"
                      >
                        {m.email}
                      </a>
                    </Table.Cell>
                    <Table.Cell className="text-kumo-default">
                      {m.tenantRole === "tenant_admin" ? t`租户管理员` : t`成员`}
                    </Table.Cell>
                    <Table.Cell className="tabular-nums">{m.spend ?? "—"}</Table.Cell>
                  </Table.Row>
                ))}
              </Table.Body>
            </Table>
          </div>
        )}
      </article>
    </div>
  );
}

export function OpsTenantDetailScreen() {
  const params = useParams({ strict: false }) as { teamId?: string };
  return <OpsTenantDetailBody teamId={params.teamId ?? ""} />;
}
