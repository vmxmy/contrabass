import React from "react";
import { Text } from "@cloudflare/kumo/components/text";
import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { useAdminUsers } from "../../../hooks/use-admin-users";
import { AdminBreadcrumbs } from "../navigation";
import { adminUsersUserIdRoute } from "./$userId";

export function AdminUserDetailPage() {
  const { userId } = adminUsersUserIdRoute.useParams();
  const { data } = useAdminUsers(1, 50);
  const user = data?.users.find((item) => item.userId === userId || item.email === userId);
  const userDisplay = user?.email ?? userId;

  return (
    <section className="space-y-6" aria-label={t`用户详情`}>
      <AdminBreadcrumbs segments={[
        { label: <Trans>用户</Trans>, href: "/admin/users" },
        { label: userDisplay },
      ]} />
      <div className="py-8 text-center text-kumo-subtle">
        <Text variant="secondary" as="p"><Trans>用户详情页</Trans>（{userDisplay}）— <Trans>待实现</Trans></Text>
      </div>
    </section>
  );
}
