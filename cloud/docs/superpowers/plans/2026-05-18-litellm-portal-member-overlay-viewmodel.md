# LiteLLM Portal — Plan-11：member-overlay ViewModel 抽取（审计 S7，行为保持重构）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development / executing-plans. Steps use `- [ ]`.

**Goal:** 关闭审计 S7 对 `member-overlay.tsx` 的核心诉求：把内联 IIFE 的 team-avg 计算 + 双 `useDashboard` 取数 + 派生量抽到 `useMemberUsage` ViewModel hook + 纯函数 `computeTeamAvgPoints`。组件变纯表现层。**行为零变更**——由**已存在的** `member-overlay.test.tsx`（3 个测试，恰好覆盖 member+global 虚线序列 / global 缺失 / userCount=0 三条风险路径）作为回归证据，不改测试。

**Architecture:** 标准「在既有测试网下重构」模式（与全部 14 个已验证 plan 同节奏:Kimi 改 / 我独立验收 / 既有测试不改保持绿 = 行为保持的证据)。**有意不过度拆分**(不切多个 dumb 子组件——那是 gold-plating + 增风险)；只做 S7 核心:数据逻辑移出 JSX。组件渲染结构(`<>`/className/`data-chart='trend'`/PanelCard)逐字不变 → 3 个既有测试逐字保持绿。

**Tech Stack:** React, TanStack Query, TS strict（kebab-case、named export、explicit return types、no `any`）, Vitest + happy-dom, pnpm。

---

## Instructions for the implementing agent (Kimi) — read fully before Task 1

1. **Scope lock.** Task 1 creates `src/litellm-portal/dashboard/views/use-member-usage.ts` + `src/litellm-portal/dashboard/views/use-member-usage.test.ts`. Task 2 modifies ONLY `src/litellm-portal/dashboard/views/member-overlay.tsx`. Never modify `member-overlay.test.tsx`, `use-dashboard.ts`, charts, `ui/*`.
2. **Verbatim.** Copy code blocks exactly. No reformat, no `any`, no `@ts-ignore`. If an OLD block isn't found verbatim, STOP and report with the actual file region.
3. **Regression contract (non-negotiable).** `src/litellm-portal/dashboard/views/member-overlay.test.tsx` (3 tests) MUST stay green WITHOUT being modified — it is the proof behaviour is preserved across the 3 data permutations. If any fail after Task 2, the refactor is wrong → STOP and report (NEVER edit that test).
4. **TDD for the pure helper** (Task 1): write the helper test → run → see FAIL → implement → see PASS.
5. **TYPECHECK PROTOCOL.** When a step says "Typecheck", run EXACTLY:
   ```bash
   bunx tsc --noEmit -p tsconfig.json 2>&1 | grep -E "error TS" | grep -vE "TS6142|server\.ts\(6,33\)" | grep "litellm-portal/dashboard/views/" || echo "MEMBER VM TYPECHECK CLEAN"
   ```
   Expected: single line `MEMBER VM TYPECHECK CLEAN`. Bare `TS6142` is NEVER a stop reason.
6. **STOP rule.** Any output ≠ Expected → STOP, report step + full output, do not continue.
7. **One commit per task**, scope `litellm-portal`, exact message. Never push / rebase / amend / switch branches.
8. **Working directory** for every command: `/Users/xumingyang/github/contrabass/cloud`.

---

## Task 1: Pure helper + ViewModel hook (TDD)

**Files:** Create `src/litellm-portal/dashboard/views/use-member-usage.ts`, `src/litellm-portal/dashboard/views/use-member-usage.test.ts`

- [ ] **Step 1: Write the helper test.** Create `src/litellm-portal/dashboard/views/use-member-usage.test.ts` with EXACTLY:

```ts
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
```

- [ ] **Step 2: Run — expect FAIL.** Run:
```bash
pnpm exec vitest run src/litellm-portal/dashboard/views/use-member-usage.test.ts
```
Expected: FAIL — cannot resolve `./use-member-usage`. If it PASSES, STOP and report.

- [ ] **Step 3: Implement.** Create `src/litellm-portal/dashboard/views/use-member-usage.ts` with EXACTLY:

```ts
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
```

- [ ] **Step 4: Run — expect PASS.** Run:
```bash
pnpm exec vitest run src/litellm-portal/dashboard/views/use-member-usage.test.ts
```
Expected: PASS, 4 tests. If any FAIL, STOP and report.

- [ ] **Step 5: Typecheck.** §5 command. Expected: `MEMBER VM TYPECHECK CLEAN`.

- [ ] **Step 6: Commit.**
```bash
git add src/litellm-portal/dashboard/views/use-member-usage.ts src/litellm-portal/dashboard/views/use-member-usage.test.ts
git commit -m "feat(litellm-portal): extract useMemberUsage VM + computeTeamAvgPoints (S7)"
```

---

## Task 2: Make MemberOverlay consume the ViewModel (behaviour-preserving)

**Files:** Modify `src/litellm-portal/dashboard/views/member-overlay.tsx`

- [ ] **Step 1: Replace imports + data logic.** Replace EXACTLY:
```tsx
import React from "react";
import { useDashboard } from "../use-dashboard";
import { KpiBand } from "../panels/kpi-band";
import { TrendChart } from "../charts/trend-chart";
import { ModelDonut } from "../charts/model-donut";
import { PanelCard } from "../../ui";
export function MemberOverlay({
  userId, maxBudget, onClose,
}: {
  userId: string; maxBudget: number | null; onClose: () => void;
}) {
  const { data } = useDashboard({ kind: "member", userId }, "30d");
  const { data: globalData } = useDashboard({ kind: "global" }, "30d");
  const spend = data?.kpi.spend.current ?? 0;
  const quotaPct = maxBudget && maxBudget > 0 ? Math.min(100, Math.round((spend / maxBudget) * 100)) : null;
```
with EXACTLY:
```tsx
import React from "react";
import { KpiBand } from "../panels/kpi-band";
import { TrendChart } from "../charts/trend-chart";
import { ModelDonut } from "../charts/model-donut";
import { PanelCard } from "../../ui";
import { useMemberUsage } from "./use-member-usage";
export function MemberOverlay({
  userId, maxBudget, onClose,
}: {
  userId: string; maxBudget: number | null; onClose: () => void;
}) {
  const { data, spend, quotaPct, teamAvgPoints } = useMemberUsage(userId, maxBudget);
```

- [ ] **Step 2: Replace the inline IIFE chart logic with the VM value.** Replace EXACTLY:
```tsx
              <PanelCard padded={false}>
                {(() => {
                  const memberPoints: Array<[number, number]> = data.trend.map((b) => [b.startMs, b.totalTokens]);
                  const userCount = globalData?.summary?.userCount ?? 0;
                  const teamAvgPoints: Array<[number, number]> | null =
                    globalData && userCount > 0
                      ? globalData.trend
                          .map((b, i): [number, number] | null => {
                            const memberBucket = data.trend[i];
                            if (!memberBucket) return null;
                            return [memberBucket.startMs, b.totalTokens / userCount];
                          })
                          .filter((p): p is [number, number] => p !== null)
                      : null;
                  return (
                    <TrendChart
                      series={[
                        { name: "个人", points: memberPoints },
                        ...(teamAvgPoints ? [{ name: "团队人均", points: teamAvgPoints, dashed: true }] : []),
                      ]}
                    />
                  );
                })()}
              </PanelCard>
```
with EXACTLY:
```tsx
              <PanelCard padded={false}>
                <TrendChart
                  series={[
                    { name: "个人", points: data.trend.map((b) => [b.startMs, b.totalTokens]) },
                    ...(teamAvgPoints
                      ? [{ name: "团队人均", points: teamAvgPoints, dashed: true }]
                      : []),
                  ]}
                />
              </PanelCard>
```

- [ ] **Step 3: Regression gate — existing member-overlay tests (UNMODIFIED).** Run:
```bash
pnpm exec vitest run src/litellm-portal/dashboard/views/member-overlay.test.tsx
```
Expected: ALL 3 tests pass. If ANY fail, STOP and report full output — the refactor changed behaviour. Do NOT edit the test.

- [ ] **Step 4: Typecheck.** §5 command. Expected: `MEMBER VM TYPECHECK CLEAN`.

- [ ] **Step 5: Broader regression.** Run:
```bash
pnpm exec vitest run src/litellm-portal/dashboard src/litellm-portal/ui
```
Expected: ALL pass (dashboard suite incl. member-overlay 3 + use-member-usage 4, ui 31). If any fail, STOP and report.

- [ ] **Step 6: Commit.**
```bash
git add src/litellm-portal/dashboard/views/member-overlay.tsx
git commit -m "refactor(litellm-portal): MemberOverlay consumes useMemberUsage VM (S7)"
```

---

## Task 3: Verification (no commit)

- [ ] **Step 1:** `pnpm exec vitest run src/litellm-portal/dashboard/views/member-overlay.test.tsx` → 3 passed; `git diff` shows the test file UNCHANGED.
- [ ] **Step 2:** `pnpm exec vitest run src/litellm-portal/dashboard/views/use-member-usage.test.ts` → 4 passed.
- [ ] **Step 3:** §5 TYPECHECK PROTOCOL → `MEMBER VM TYPECHECK CLEAN`.
- [ ] **Step 4:** `git diff --name-only HEAD~2 HEAD` → exactly `use-member-usage.ts`, `use-member-usage.test.ts`, `member-overlay.tsx`. Report + `git log --oneline -2`.

**DoD:** member-overlay's data logic (dual fetch + quota + team-avg IIFE) extracted to `useMemberUsage` + pure `computeTeamAvgPoints`; component is presentational; 3 existing member-overlay tests green UNMODIFIED (behaviour preserved by evidence across all 3 data permutations); new pure-helper unit test 4 green; tsc clean; 2 commits; only the 3 expected files changed. Audit S7 closed for member-overlay.

## Out of scope
app.tsx S7 decomposition (larger; separate plan if pursued — its chrome is already migrated, baseline 0). Screen archetypes → separate design-led plan (slot grammar specified in REMEDIATION_PLAN.md).
