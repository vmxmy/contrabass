import React from "react";
import { createRoute } from "@tanstack/react-router";
import { Loader } from "@cloudflare/kumo/components/loader";
import { Text } from "@cloudflare/kumo/components/text";
import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { manageRoute } from "./route";
import { requireAdminRoute } from "./admin-guard";
import { PreferencesForm } from "../../preferences-form";
import { useAdminPreferencesDefaults, useUpdateAdminPreferencesDefaults } from "../../hooks/use-admin-preferences-defaults";

export const manageSettingsRoute = createRoute({
  getParentRoute: () => manageRoute,
  path: "/settings",
  beforeLoad: ({ context }) => requireAdminRoute(context),
  component: ManageSettingsPage,
});

export function ManageSettingsPage() {
  const { data: defaults, isLoading, error } = useAdminPreferencesDefaults();
  const updateDefaults = useUpdateAdminPreferencesDefaults();

  return (
    <section className="space-y-6" aria-label={t`设置管理`}>
      {error ? (
        <Text variant="secondary" as="p"><Trans>全局默认设置加载失败，请稍后重试。</Trans></Text>
      ) : isLoading || defaults === undefined ? (
        <Loader aria-label={t`正在加载全局默认设置`} />
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
