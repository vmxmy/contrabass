import React from "react";
import { UsageDashboard } from "../../dashboard/views/usage-dashboard";

export function OpsGlobalUsageScreen() {
  return (
    <div id="ops-global-usage-root" className="space-y-6">
      <UsageDashboard initialScope="global" />
    </div>
  );
}
