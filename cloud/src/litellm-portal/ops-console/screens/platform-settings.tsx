/**
 * OpsPlatformSettingsScreen — Platform Settings screen for the Ops Console.
 *
 * Bare-body screen: identity gating is performed by the OpsLayout /
 * OpsConsoleShell wrapper and the server-side `requireOwner` middleware on
 * the `/api/ops/platform-settings` endpoint. This component does NOT self-gate.
 */
import React from "react";
import { Badge } from "@cloudflare/kumo/components/badge";
import { Banner } from "@cloudflare/kumo/components/banner";
import { SkeletonLine } from "@cloudflare/kumo/components/loader";
import { Text } from "@cloudflare/kumo/components/text";
import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { useOpsPlatformSettings } from "../hooks";

function PlatformSettingsBody() {
  const { data, isLoading, isError, error } = useOpsPlatformSettings();
  if (isLoading) {
    return (
      <div className="space-y-3 p-6">
        <SkeletonLine minWidth={200} maxWidth={400} blockHeight={16} />
        <SkeletonLine minWidth={200} maxWidth={400} blockHeight={16} />
      </div>
    );
  }
  if (isError || !data) {
    return (
      <Banner
        variant="error"
        title={t`平台设置加载失败`}
        description={error instanceof Error ? error.message : t`网络请求失败`}
      />
    );
  }
  return (
    <div className="space-y-5 p-6">
      <div className="flex items-center justify-between">
        <Text variant="secondary" as="p"><Trans>平台名称</Trans></Text>
        <Text variant="body" as="p">{data.companyName}</Text>
      </div>
      <div className="flex items-center justify-between">
        <Text variant="secondary" as="p"><Trans>写操作开关</Trans></Text>
        <Badge variant={data.writeOpsEnabled ? "success" : "neutral"}>
          {data.writeOpsEnabled ? t`写操作已启用` : t`写操作已禁用`}
        </Badge>
      </div>
      <div className="space-y-2 border-t border-kumo-line pt-5">
        <a
          href="/manage/preferences"
          className="block font-medium text-kumo-link underline underline-offset-2"
        >
          <Trans>偏好默认值</Trans>
        </a>
        <a
          href="/ops/provisioning"
          className="block font-medium text-kumo-link underline underline-offset-2"
        >
          <Trans>角色 / tenantRole 管理</Trans>
        </a>
      </div>
    </div>
  );
}

export function OpsPlatformSettingsScreen() {
  return (
    <div id="ops-platform-settings-root" className="space-y-6">
      <article className="overflow-hidden rounded-xl bg-kumo-base ring-1 ring-kumo-line">
        <div className="border-b border-kumo-line bg-kumo-elevated p-6">
          <Text variant="heading3" as="p"><Trans>平台设置</Trans></Text>
          <Text variant="secondary" as="p">
            <Trans>平台名称、写操作开关与相关管理入口。</Trans>
          </Text>
        </div>
        <PlatformSettingsBody />
      </article>
    </div>
  );
}
