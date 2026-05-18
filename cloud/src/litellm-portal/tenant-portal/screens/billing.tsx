/**
 * TenantBillingScreen — Billing periods & CSV download screen for the Tenant Portal.
 *
 * Identity gate: `useMe().data?.tenantRole === "tenant_admin"` is a CLIENT-SIDE
 * UX guard only. The authoritative security boundary is the server-side
 * `requireTenantAdmin` middleware on every `/api/tenant/billing` endpoint.
 * This client gate prevents accidental deep-link rendering for non-admins.
 *
 * Layered defense note: the client gate here, the server `requireTenantAdmin`,
 * and the server-side team-filtering of the CSV are independent layers.
 * The screen never reimplements them — it only triggers `downloadTenantBilling`.
 *
 * The client does NOT parse or aggregate the CSV. The server already filters
 * by the tenant's team; the screen only triggers the download.
 *
 * SSR-safe: pure component; identity is read from the hydrated `useMe()` cache
 * (Task 1.0). No module-load DOM access — the DOM-touching download lives inside
 * `downloadTenantBilling`, which is already SSR-guarded.
 */
import React, { useCallback, useState } from "react";
import { Button } from "@cloudflare/kumo/components/button";
import { Table } from "@cloudflare/kumo/components/table";
import { Text } from "@cloudflare/kumo/components/text";
import { PanelSkeleton, PanelEmpty, PanelError } from "../../components/panel-state";
import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { useMe } from "../../hooks/use-me";
import { useTenantBillingPeriods, downloadTenantBilling } from "../hooks";
import { MemberForbidden } from "../routes";

// ---------------------------------------------------------------------------
// BillingPeriodRow — one row per YYYY-MM period with a per-row download button
// ---------------------------------------------------------------------------

function BillingPeriodRow({ period }: { period: string }) {
  const [isPending, setIsPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleDownload = useCallback(async () => {
    if (isPending) return;
    setError(null);
    setIsPending(true);
    try {
      await downloadTenantBilling(period);
    } catch (err) {
      setError(err instanceof Error ? err.message : t`下载失败`);
    } finally {
      setIsPending(false);
    }
  }, [isPending, period]);

  return (
    <>
      <Table.Row data-period={period}>
        <Table.Cell className="font-mono text-kumo-default">{period}</Table.Cell>
        <Table.Cell className="text-right">
          <Button
            variant="secondary"
            size="xs"
            loading={isPending}
            disabled={isPending}
            onClick={handleDownload}
            aria-label={t({ message: "下载 {period}", values: { period } })}
          >
            <Trans>下载</Trans>
          </Button>
        </Table.Cell>
      </Table.Row>
      {error ? (
        <Table.Row>
          <Table.Cell colSpan={2}>
            <PanelError title={t`下载失败`} error={new Error(error)} />
          </Table.Cell>
        </Table.Row>
      ) : null}
    </>
  );
}

// ---------------------------------------------------------------------------
// BillingPeriodsTable — query state handler + table rendering
// ---------------------------------------------------------------------------

function BillingPeriodsTable() {
  const { data, isLoading, isError, error } = useTenantBillingPeriods();

  if (isLoading) {
    return <PanelSkeleton lines={2} />;
  }

  if (isError) {
    return <PanelError title={t`账单列表加载失败`} error={error} />;
  }

  const periods = data?.periods ?? [];

  if (periods.length === 0) {
    return <PanelEmpty title={t`暂无账单`} />;
  }

  return (
    <div className="overflow-x-auto">
      <Table className="w-full text-sm">
        <Table.Header>
          <Table.Row>
            <Table.Head className="text-xs font-semibold uppercase tracking-wider text-kumo-subtle">
              <Trans>账期</Trans>
            </Table.Head>
            <Table.Head className="text-right text-xs font-semibold uppercase tracking-wider text-kumo-subtle">
              <Trans>操作</Trans>
            </Table.Head>
          </Table.Row>
        </Table.Header>
        <Table.Body>
          {periods.map((period) => (
            <BillingPeriodRow key={period} period={period} />
          ))}
        </Table.Body>
      </Table>
    </div>
  );
}

// ---------------------------------------------------------------------------
// TenantBillingScreen — exported screen component
// ---------------------------------------------------------------------------

export function TenantBillingScreen() {
  // Derived identity gate — no state+effect, per react-useeffect rule.
  // CLIENT-SIDE UX ONLY: the authoritative gate is server requireTenantAdmin.
  const me = useMe().data;
  if (me?.tenantRole !== "tenant_admin") {
    return <MemberForbidden />;
  }

  return (
    <div id="tenant-billing-root" className="space-y-6">
      <article className="overflow-hidden rounded-xl bg-kumo-base ring-1 ring-kumo-line">
        <div className="border-b border-kumo-line bg-kumo-elevated p-6">
          <Text variant="heading3" as="p"><Trans>账单下载</Trans></Text>
          <Text variant="secondary" as="p">
            <Trans>按账期下载团队 CSV 账单。服务端已按团队过滤，客户端不聚合数据。</Trans>
          </Text>
        </div>
        <BillingPeriodsTable />
      </article>
    </div>
  );
}
