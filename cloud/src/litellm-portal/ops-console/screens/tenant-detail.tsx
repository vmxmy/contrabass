import React, { useCallback } from "react";
import { Badge } from "@cloudflare/kumo/components/badge";
import { Button } from "@cloudflare/kumo/components/button";
import { Table } from "@cloudflare/kumo/components/table";
import { Text } from "@cloudflare/kumo/components/text";
import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { useParams } from "@tanstack/react-router";
import { useOpsTenantDetail, useStartImpersonation } from "../hooks";
import { PanelSkeleton, PanelEmpty, PanelError } from "../../components/panel-state";
import { densityClasses, useDensity } from "../../components/density";
import { PanelCard } from "../../ui";

export function OpsTenantDetailBody({ teamId }: { teamId: string }) {
  const { data, isLoading, isError, error } = useOpsTenantDetail(teamId);
  const startImpersonation = useStartImpersonation();
  const dc = densityClasses(useDensity());

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
      <div id="ops-tenant-detail-root">
        <PanelSkeleton lines={2} />
      </div>
    );
  }
  if (isError) {
    return (
      <div id="ops-tenant-detail-root">
        <PanelError title={t`租户详情加载失败`} error={error} />
      </div>
    );
  }
  if (!data) {
    return (
      <div id="ops-tenant-detail-root">
        <PanelEmpty title={t`未找到租户`} />
      </div>
    );
  }

  return (
    <div id="ops-tenant-detail-root" className="space-y-6">
      <PanelCard
        title={data.alias ?? data.teamId}
        subtitle={data.teamId}
        actions={
          <Button
            variant="primary"
            size="sm"
            loading={startImpersonation.isPending}
            onClick={enterTenant}
          >
            <Trans>进入租户</Trans>
          </Button>
        }
        padded={false}
      >
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
      </PanelCard>

      <PanelCard
        title={t`成员`}
        subtitle={t`该租户的所有成员及其门户角色与花费。`}
        padded={false}
      >
        {data.members.length === 0 ? (
          <PanelEmpty title={t`暂无成员`} />
        ) : (
          <div className="overflow-x-auto">
            <Table className="w-full text-sm">
              <Table.Header className="sticky top-0 bg-kumo-elevated z-10">
                <Table.Row className={dc.row}>
                  <Table.Head className={dc.cell}><Trans>邮箱</Trans></Table.Head>
                  <Table.Head className={dc.cell}><Trans>门户角色</Trans></Table.Head>
                  <Table.Head className={dc.cell}><Trans>花费</Trans></Table.Head>
                </Table.Row>
              </Table.Header>
              <Table.Body>
                {data.members.map((m) => (
                  <Table.Row key={m.userId} className={dc.row}>
                    <Table.Cell className={dc.cell}>
                      <a
                        href={`/ops/users/${encodeURIComponent(m.userId)}`}
                        className="font-medium text-kumo-link underline underline-offset-2"
                      >
                        {m.email}
                      </a>
                    </Table.Cell>
                    <Table.Cell className={`${dc.cell} text-kumo-default`}>
                      {m.tenantRole === "tenant_admin" ? t`租户管理员` : t`成员`}
                    </Table.Cell>
                    <Table.Cell className={`${dc.cell} tabular-nums`}>{m.spend ?? "—"}</Table.Cell>
                  </Table.Row>
                ))}
              </Table.Body>
            </Table>
          </div>
        )}
      </PanelCard>
    </div>
  );
}

export function OpsTenantDetailScreen() {
  const params = useParams({ strict: false }) as { teamId?: string };
  return <OpsTenantDetailBody teamId={params.teamId ?? ""} />;
}
