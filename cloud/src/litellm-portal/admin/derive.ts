/**
 * Pure derive/format helpers extracted from admin-components.tsx (audit S7/E1).
 * Byte-identical move — no behaviour change. Unit-tested in derive.test.ts;
 * the unchanged admin-components.test.tsx proves integration is preserved.
 */
export function text(value: unknown): string {
  return value == null || value === "" ? "—" : String(value);
}

export type AdminStatusSummary = {
  riskCount?: number | null;
  overBudgetUserCount?: number | null;
  overBudgetTeamCount?: number | null;
  unmanagedRoleCount?: number | null;
  noTeamUserCount?: number | null;
  limited?: boolean;
};

export function deriveHealthSummary(summary: AdminStatusSummary): {
  message: string;
  tone: "success" | "warning" | "danger";
} {
  const overBudgetTeams = Number(summary.overBudgetTeamCount ?? 0);
  const overBudgetUsers = Number(summary.overBudgetUserCount ?? 0);
  const riskCount = Number(summary.riskCount ?? 0);
  const unmanagedRoles = Number(summary.unmanagedRoleCount ?? 0);
  const noTeamUsers = Number(summary.noTeamUserCount ?? 0);

  if (overBudgetTeams > 0 || overBudgetUsers > 0) {
    const parts: string[] = [];
    if (overBudgetTeams > 0) parts.push(`${overBudgetTeams} 个团队超预算`);
    if (overBudgetUsers > 0) parts.push(`${overBudgetUsers} 个用户超预算`);
    const tone = riskCount >= 10 ? "danger" : "warning";
    return { message: parts.join("，"), tone };
  }

  if (riskCount > 0) {
    const parts: string[] = [];
    if (unmanagedRoles > 0) parts.push(`${unmanagedRoles} 个未映射角色`);
    if (noTeamUsers > 0) parts.push(`${noTeamUsers} 个用户未关联团队`);
    return { message: parts.join("，") || `${riskCount} 个风险项`, tone: "warning" };
  }

  return { message: "系统正常", tone: "success" };
}

export function relativeTime(iso: string): string {
  const diffMs = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(diffMs) || diffMs < 0) return "just now";
  const diffSec = Math.floor(diffMs / 1000);
  if (diffSec < 60) return "just now";
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  const diffDay = Math.floor(diffHr / 24);
  return `${diffDay}d ago`;
}
