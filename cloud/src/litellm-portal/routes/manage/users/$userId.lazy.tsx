import React from "react";
import { useParams } from "@tanstack/react-router";
import { OpsUserDetailBody } from "../../../ops-console/screens/user-detail";

export function ManageUserDetailPage() {
  const { userId } = useParams({ strict: false }) as { userId?: string };

  return (
    <section className="space-y-6">
      <OpsUserDetailBody userId={userId ?? ""} />
    </section>
  );
}
