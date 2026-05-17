import React from "react";
import { Text } from "@cloudflare/kumo/components/text";
import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { useParams } from "@tanstack/react-router";
import { useOpsUserDetail } from "../hooks";
import { PanelSkeleton, PanelEmpty, PanelError } from "../../components/panel-state";

export function OpsUserDetailBody({ userId }: { userId: string }) {
  const { data, isLoading, isError, error } = useOpsUserDetail(userId);

  if (isLoading) {
    return (
      <div id="ops-user-detail-root">
        <PanelSkeleton lines={2} />
      </div>
    );
  }
  if (isError) {
    return (
      <div id="ops-user-detail-root">
        <PanelError title={t`用户详情加载失败`} error={error} />
      </div>
    );
  }
  if (!data) {
    return (
      <div id="ops-user-detail-root">
        <PanelEmpty title={t`未找到用户`} />
      </div>
    );
  }

  return (
    <div id="ops-user-detail-root" className="space-y-6">
      <article className="overflow-hidden rounded-xl bg-kumo-base ring-1 ring-kumo-line">
        <div className="border-b border-kumo-line bg-kumo-elevated p-6">
          <Text variant="heading3" as="p">{data.email}</Text>
          <Text variant="secondary" as="p">{data.userId}</Text>
        </div>
        <dl className="grid grid-cols-2 gap-4 p-6 text-sm sm:grid-cols-3">
          <div>
            <dt className="text-kumo-subtle"><Trans>平台角色</Trans></dt>
            <dd className="text-kumo-default">{data.platformRole}</dd>
          </div>
          <div>
            <dt className="text-kumo-subtle"><Trans>所属团队</Trans></dt>
            <dd className="text-kumo-default">{data.teamId ?? "—"}</dd>
          </div>
          <div>
            <dt className="text-kumo-subtle"><Trans>门户角色</Trans></dt>
            <dd className="text-kumo-default">
              {data.tenantRole === "tenant_admin"
                ? t`租户管理员`
                : data.tenantRole === "member"
                  ? t`成员`
                  : "—"}
            </dd>
          </div>
          <div>
            <dt className="text-kumo-subtle"><Trans>预算</Trans></dt>
            <dd className="tabular-nums text-kumo-default">{data.maxBudget ?? "—"}</dd>
          </div>
          <div>
            <dt className="text-kumo-subtle"><Trans>Key 数量</Trans></dt>
            <dd className="tabular-nums text-kumo-default">{data.keyCount}</dd>
          </div>
        </dl>
      </article>
    </div>
  );
}

export function OpsUserDetailScreen() {
  const params = useParams({ strict: false }) as { userId?: string };
  return <OpsUserDetailBody userId={params.userId ?? ""} />;
}
