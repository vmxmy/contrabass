import React from "react";
import { Table } from "@cloudflare/kumo/components/table";
import { Text } from "@cloudflare/kumo/components/text";
import { useParams } from "@tanstack/react-router";
import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { useAdminAudit } from "../../hooks/use-admin-audit";
import { useOpsAuditEvent } from "../hooks";
import { PanelSkeleton, PanelEmpty, PanelError } from "../../components/panel-state";
import { densityClasses, useDensity } from "../../components/density";
import { BlockErrorBoundary } from "../../errors/error-boundary";
import { PanelCard } from "../../ui";

export function AuditEventDetailCard({ eventId }: { eventId: string }) {
  const { data, isLoading, isError, error } = useOpsAuditEvent(eventId);
  if (isLoading) {
    return <PanelSkeleton lines={2} />;
  }
  if (isError) {
    return <PanelError title={t`审计事件加载失败`} error={error} />;
  }
  if (!data) return <PanelEmpty title={t`未找到审计事件`} />;
  return (
    <div id="ops-audit-detail-root">
      <PanelCard title={t`审计事件详情`} padded={false}>
      <dl className="grid grid-cols-1 gap-4 p-6 sm:grid-cols-2">
        <div>
          <dt className="text-xs text-kumo-secondary"><Trans>动作</Trans></dt>
          <dd className="font-medium">{data.action}</dd>
        </div>
        <div>
          <dt className="text-xs text-kumo-secondary"><Trans>操作者</Trans></dt>
          <dd>{data.actorEmail}</dd>
        </div>
        <div>
          <dt className="text-xs text-kumo-secondary"><Trans>对象</Trans></dt>
          <dd>{data.entityKind} · {data.entityId}</dd>
        </div>
        <div>
          <dt className="text-xs text-kumo-secondary"><Trans>时间</Trans></dt>
          <dd className="tabular-nums">{data.ts ?? "—"}</dd>
        </div>
        <div className="sm:col-span-2">
          <dt className="text-xs text-kumo-secondary"><Trans>变更前</Trans></dt>
          <dd><pre className="whitespace-pre-wrap text-xs">{data.before ?? "—"}</pre></dd>
        </div>
        <div className="sm:col-span-2">
          <dt className="text-xs text-kumo-secondary"><Trans>变更后</Trans></dt>
          <dd><pre className="whitespace-pre-wrap text-xs">{data.after ?? "—"}</pre></dd>
        </div>
        <div className="sm:col-span-2">
          <dt className="text-xs text-kumo-secondary"><Trans>原因</Trans></dt>
          <dd>{data.reason ?? "—"}</dd>
        </div>
      </dl>
      </PanelCard>
    </div>
  );
}

function AuditFeedTable() {
  const { data, isLoading, isError, error } = useAdminAudit({ page: 1, size: 50 });
  const dc = densityClasses(useDensity());
  if (isLoading) {
    return <PanelSkeleton lines={2} />;
  }
  if (isError) {
    return <PanelError title={t`审计日志加载失败`} error={error} />;
  }
  const events = data?.events ?? [];
  if (events.length === 0) return <PanelEmpty title={t`暂无审计记录`} />;
  return (
    <div className="overflow-x-auto">
      <Table className="w-full text-sm">
        <Table.Header className="sticky top-0 bg-kumo-elevated z-10">
          <Table.Row className={dc.row}>
            <Table.Head className={dc.cell}><Trans>动作</Trans></Table.Head>
            <Table.Head className={dc.cell}><Trans>操作者</Trans></Table.Head>
            <Table.Head className={dc.cell}><Trans>对象</Trans></Table.Head>
            <Table.Head className={dc.cell}><Trans>时间</Trans></Table.Head>
            <Table.Head className={dc.cell}><Trans>详情</Trans></Table.Head>
          </Table.Row>
        </Table.Header>
        <Table.Body>
          {events.map((e) => (
            <Table.Row key={e.id} className={dc.row}>
              <Table.Cell className={`${dc.cell} font-medium`}>{e.action}</Table.Cell>
              <Table.Cell className={dc.cell}>{e.actorUserEmail ?? "—"}</Table.Cell>
              <Table.Cell className={dc.cell}>{e.objectType ?? "—"} · {e.objectId ?? "—"}</Table.Cell>
              <Table.Cell className={`${dc.cell} tabular-nums`}>{e.createdAt ?? "—"}</Table.Cell>
              <Table.Cell className={dc.cell}>
                <a
                  href={`/ops/audit/${encodeURIComponent(e.id)}`}
                  className="text-kumo-link underline underline-offset-2"
                >
                  <Trans>详情</Trans>
                </a>
              </Table.Cell>
            </Table.Row>
          ))}
        </Table.Body>
      </Table>
    </div>
  );
}

export function OpsAuditScreen() {
  const params = useParams({ strict: false }) as { eventId?: string };
  return (
    <div id="ops-audit-root" className="space-y-6">
      {params.eventId ? (
        <AuditEventDetailCard eventId={params.eventId} />
      ) : (
        <PanelCard
          title={t`平台审计`}
          subtitle={t`跨租户的运营动作审计日志。`}
          padded={false}
        >
          {/*
            §F.4: per-block render/runtime isolation for the audit feed body.
            LAYERED on top of the MAJOR-1 client.tsx chunk-fetch try/catch
            (not replacing it). Transparent pass-through when nothing throws.
          */}
          <BlockErrorBoundary blockLabel="审计列表">
            <AuditFeedTable />
          </BlockErrorBoundary>
        </PanelCard>
      )}
    </div>
  );
}
