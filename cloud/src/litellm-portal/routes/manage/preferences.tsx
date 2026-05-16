import React from "react";
import { createRoute } from "@tanstack/react-router";
import { Loader } from "@cloudflare/kumo/components/loader";
import { Text } from "@cloudflare/kumo/components/text";
import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { manageRoute } from "./route";
import { PreferencesForm } from "../../preferences-form";
import { usePreferences, useUpdatePreferences } from "../../hooks/use-preferences";

export const managePreferencesRoute = createRoute({
  getParentRoute: () => manageRoute,
  path: "/preferences",
  component: ManagePreferencesPage,
});

export function ManagePreferencesPage() {
  const { data: preferences, isLoading, error } = usePreferences();
  const updatePreferences = useUpdatePreferences();

  if (error) {
    return <Text variant="secondary" as="p"><Trans>偏好设置加载失败，请稍后重试。</Trans></Text>;
  }

  if (isLoading || preferences === undefined) {
    return <Loader aria-label={t`正在加载偏好设置`} />;
  }

  return (
    <section className="space-y-6" aria-label={t`偏好设置`}>
      <PreferencesForm
        preferences={preferences}
        pending={updatePreferences.isPending}
        title={<Trans>偏好设置</Trans>}
        description={<Trans>这些设置会同步到服务端，并在其他设备登录后自动生效。</Trans>}
        onChange={(patch) => updatePreferences.mutate(patch)}
      />
    </section>
  );
}
