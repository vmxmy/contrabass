import { describe, expect, it } from "vitest";
import { computeTeamAvgPoints } from "./use-member-usage";

const memberTrend = [
  { startMs: 1000, totalTokens: 3000 },
  { startMs: 2000, totalTokens: 4000 },
];

describe("computeTeamAvgPoints", () => {
  it("returns per-bucket team average when global data + userCount>0", () => {
    const g = { summary: { userCount: 10 }, trend: [{ totalTokens: 50000 }, { totalTokens: 60000 }] };
    expect(computeTeamAvgPoints(memberTrend, g)).toEqual([
      [1000, 5000],
      [2000, 6000],
    ]);
  });

  it("returns null when global data is undefined (graceful single-series)", () => {
    expect(computeTeamAvgPoints(memberTrend, undefined)).toBeNull();
  });

  it("returns null when userCount is 0", () => {
    const g = { summary: { userCount: 0 }, trend: [{ totalTokens: 50000 }] };
    expect(computeTeamAvgPoints(memberTrend, g)).toBeNull();
  });

  it("skips global buckets with no matching member bucket", () => {
    const g = { summary: { userCount: 2 }, trend: [{ totalTokens: 100 }, { totalTokens: 200 }, { totalTokens: 999 }] };
    expect(computeTeamAvgPoints(memberTrend, g)).toEqual([
      [1000, 50],
      [2000, 100],
    ]);
  });
});
