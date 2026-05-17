import React from "react";
import { Badge } from "@cloudflare/kumo/components/badge";
import { Table } from "@cloudflare/kumo/components/table";
import { Text } from "@cloudflare/kumo/components/text";
import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { useOpsTenants } from "../hooks";
import { PanelSkeleton, PanelEmpty, PanelError } from "../../components/panel-state";

function TenantsTable() {
  const { data, isLoading, isError, error } = useOpsTenants();
  if (isLoading) {
    return <PanelSkeleton lines={4} />;
  }
  if (isError) {
    return <PanelError title={t`租户列表加载失败`} error={error} />;
  }
  const tenants = data?.tenants ?? [];
  if (tenants.length === 0) return <PanelEmpty title={t`暂无租户`} />;
  return (
    <div className="overflow-x-auto">
      <Table className="w-full text-sm">
        <Table.Header>
          <Table.Row>
            <Table.Head><Trans>租户</Trans></Table.Head>
            <Table.Head><Trans>成员数</Trans></Table.Head>
            <Table.Head><Trans>本周期花费/预算</Trans></Table.Head>
            <Table.Head><Trans>告警 Webhook</Trans></Table.Head>
            <Table.Head><Trans>账单</Trans></Table.Head>
          </Table.Row>
        </Table.Header>
        <Table.Body>
          {tenants.map((tn) => (
            <Table.Row key={tn.teamId}>
              <Table.Cell>
                <a
                  href={`/ops/tenants/${encodeURIComponent(tn.teamId)}`}
                  className="font-medium text-kumo-link underline underline-offset-2"
                >
                  {tn.alias ?? tn.teamId}
                </a>
              </Table.Cell>
              <Table.Cell className="tabular-nums">{tn.memberCount}</Table.Cell>
              <Table.Cell className="tabular-nums">
                {tn.cycleSpend ?? "—"} / {tn.maxBudget ?? "—"}
              </Table.Cell>
              <Table.Cell>
                <Badge variant={tn.alertWebhookConfigured ? "success" : "neutral"}>
                  {tn.alertWebhookConfigured ? t`已配置` : t`未配置`}
                </Badge>
              </Table.Cell>
              <Table.Cell className="tabular-nums">{tn.billingPeriodsCount}</Table.Cell>
            </Table.Row>
          ))}
        </Table.Body>
      </Table>
    </div>
  );
}

export function OpsTenantOverviewScreen() {
  return (
    <div id="ops-tenant-overview-root" className="space-y-6">
      <article className="overflow-hidden rounded-xl bg-kumo-base ring-1 ring-kumo-line">
        <div className="border-b border-kumo-line bg-kumo-elevated p-6">
          <Text variant="heading3" as="p"><Trans>租户总览</Trans></Text>
          <Text variant="secondary" as="p">
            <Trans>所有租户的成员、花费、告警与账单状态。</Trans>
          </Text>
        </div>
        <TenantsTable />
      </article>
    </div>
  );
}
