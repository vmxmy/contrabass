import React from "react";
import { Text } from "@cloudflare/kumo/components/text";
import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { useAdminUsers } from "../../../hooks/use-admin-users";
import { manageUsersUserIdRoute } from "./$userId";

export function ManageUserDetailPage() {
  const { userId } = manageUsersUserIdRoute.useParams();
  const { data } = useAdminUsers(1, 50);
  const user = data?.users.find((item) => item.userId === userId || item.email === userId);
  const userDisplay = user?.email ?? userId;

  return (
    <section className="space-y-6" aria-label={t`用户详情`}>
      <div className="py-8 text-center text-kumo-subtle">
        <Text variant="secondary" as="p"><Trans>用户详情页</Trans>（{userDisplay}）— <Trans>待实现</Trans></Text>
      </div>
    </section>
  );
}
