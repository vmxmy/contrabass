import React from "react";
import { useParams } from "@tanstack/react-router";
import { AuditEventDetailCard } from "../../../ops-console/screens/audit";

export function ManageAuditEventPage() {
  const { eventId } = useParams({ strict: false }) as { eventId?: string };

  return (
    <section className="space-y-6">
      <AuditEventDetailCard eventId={eventId ?? ""} />
    </section>
  );
}
