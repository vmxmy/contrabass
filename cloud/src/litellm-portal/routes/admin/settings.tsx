import React from "react";
import { createRoute } from "@tanstack/react-router";
import { Loader } from "@cloudflare/kumo/components/loader";
import { Text } from "@cloudflare/kumo/components/text";
import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { adminRoute } from "./route";
import { AdminBreadcrumbs } from "./navigation";
import { PreferencesForm } from "../../preferences-form";
import { useAdminPreferencesDefaults, useUpdateAdminPreferencesDefaults } from "../../hooks/use-admin-preferences-defaults";

export const adminSettingsRoute = createRoute({
  getParentRoute: () => adminRoute,
  path: "/settings",
  component: AdminSettingsPage,
});

export function AdminSettingsPage() {
  const { data: defaults, isLoading, error } = useAdminPreferencesDefaults();
  const updateDefaults = useUpdateAdminPreferencesDefaults();

  return (
    <section className="space-y-6" aria-label={t`设置管理`}>
      <AdminBreadcrumbs segments={[{ label: <Trans>设置</Trans> }]} />
      {isLoading || defaults === undefined ? (
        <Loader aria-label={t`正在加载全局默认设置`} />
      ) : error ? (
        <Text variant="secondary" as="p"><Trans>全局默认设置加载失败，请稍后重试。</Trans></Text>
      ) : (
        <PreferencesForm
          preferences={defaults}
          pending={updateDefaults.isPending}
          title={<Trans>全局偏好默认值</Trans>}
          description={<Trans>新用户首次读取偏好时会继承这些默认值，已有用户不会被覆盖。</Trans>}
          onChange={(patch) => updateDefaults.mutate(patch)}
        />
      )}
    </section>
  );
}
