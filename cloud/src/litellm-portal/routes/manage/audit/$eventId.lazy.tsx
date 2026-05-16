import React from "react";
import { Text } from "@cloudflare/kumo/components/text";
import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { useAdminAudit } from "../../../hooks/use-admin-audit";
import { manageAuditEventIdRoute } from "./$eventId";

function auditEventSummary(event: { action: string; objectType: string | null; objectId: string | null } | undefined, fallback: string) {
  if (!event) return fallback;
  const target = event.objectId ?? event.objectType ?? fallback;
  return `${event.action} · ${target}`;
}

export function ManageAuditEventPage() {
  const { eventId } = manageAuditEventIdRoute.useParams();
  const { data } = useAdminAudit({ page: 1, size: 50 });
  const event = data?.events.find((item) => item.id === eventId);
  const eventDisplay = auditEventSummary(event, eventId);

  return (
    <section className="space-y-6" aria-label={t`审计事件详情`}>
      <div className="py-8 text-center text-kumo-subtle">
        <Text variant="secondary" as="p"><Trans>审计事件详情</Trans>（{eventDisplay}）— <Trans>待实现</Trans></Text>
      </div>
    </section>
  );
}
