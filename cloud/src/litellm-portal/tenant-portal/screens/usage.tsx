import React from "react";
import { UsageDashboard } from "../../dashboard/views/usage-dashboard";

export function TenantUsageScreen() {
  return (
    <div id="tenant-usage-root" className="space-y-6">
      <UsageDashboard initialScope="self" />
    </div>
  );
}
