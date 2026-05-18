/**
 * member-overlay ViewModel (audit S7).
 *
 * Pulls the two dashboard queries + the team-average derivation + quota math
 * OUT of the MemberOverlay JSX so the component is purely presentational and
 * the back-end DTO is consumed in one place (no inline IIFE, no DTO pass-through
 * in render). Behaviour is unchanged — `member-overlay.test.tsx` (member+global
 * / global-missing / userCount=0) is the regression net.
 */
import { useDashboard } from "../use-dashboard";

type MemberData = NonNullable<ReturnType<typeof useDashboard>["data"]>;

/**
 * Per-bucket team average (member bucket startMs → global bucket totalTokens /
 * userCount). Returns null when there is no global data or userCount<=0
 * (graceful single-series). Pure — unit-tested in isolation.
 */
export function computeTeamAvgPoints(
  memberTrend: ReadonlyArray<{ startMs: number; totalTokens: number }>,
  globalData: { summary?: { userCount?: number }; trend: ReadonlyArray<{ totalTokens: number }> } | undefined,
): Array<[number, number]> | null {
  const userCount = globalData?.summary?.userCount ?? 0;
  if (!globalData || userCount <= 0) return null;
  return globalData.trend
    .map((b, i): [number, number] | null => {
      const memberBucket = memberTrend[i];
      if (!memberBucket) return null;
      return [memberBucket.startMs, b.totalTokens / userCount];
    })
    .filter((p): p is [number, number] => p !== null);
}

export type MemberUsageVM = {
  data: MemberData | undefined;
  spend: number;
  quotaPct: number | null;
  teamAvgPoints: Array<[number, number]> | null;
};

export function useMemberUsage(
  userId: string,
  maxBudget: number | null,
): MemberUsageVM {
  const { data } = useDashboard({ kind: "member", userId }, "30d");
  const { data: globalData } = useDashboard({ kind: "global" }, "30d");
  const spend = data?.kpi.spend.current ?? 0;
  const quotaPct =
    maxBudget && maxBudget > 0
      ? Math.min(100, Math.round((spend / maxBudget) * 100))
      : null;
  const teamAvgPoints = data
    ? computeTeamAvgPoints(data.trend, globalData ?? undefined)
    : null;
  return { data, spend, quotaPct, teamAvgPoints };
}
