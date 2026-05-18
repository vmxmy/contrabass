# LiteLLM Portal — Plan-12：admin-components 纯逻辑抽取到 admin/derive.ts（审计 S7/E1，已门控切片）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development / executing-plans. Steps use `- [ ]`.

**Goal:** 把 576 行 God Component `admin-components.tsx` 里**纯**业务/格式逻辑（`text`、`AdminStatusSummary` 类型、`deriveHealthSummary`、`relativeTime`）原样移出到 `src/litellm-portal/admin/derive.ts`，并加单元测试。这是审计 S7/E1「文件级 God Component；business derive + 时间格式化混在组件文件里」的**已充分门控切片**。

**Architecture:** 纯逻辑**搬移**(非重写):4 个符号逐字移到 `admin/derive.ts`,`admin-components.tsx` 改为 `import` 它们。行为零变更 → 既有 `admin-components.test.tsx`(AdminStatusHeader 用 deriveHealthSummary、SyncStatusBadge 用 relativeTime)不改保持绿 = 集成行为保持的证据;新增 `admin/derive.test.ts` 对纯函数做单元测试 = 抽出逻辑的完整证据。**有意只做纯逻辑切片**:有状态组件(AdminUsersTable/AdminCard/AdminSection/SyncStatusBadge)的拆分**不做** —— 既有测试仅覆盖 9 个导出中的 5 个,搬移有状态组件不被行为证据覆盖(误接可能通过部分门),需先补这 4 个导出的测试再拆,属独立后续工作。

**Tech Stack:** React, TS strict（kebab-case、named export、explicit return types、no `any`）, Vitest, pnpm。

---

## Instructions for the implementing agent (Kimi) — read fully before Task 1

1. **Scope lock.** Task 1 creates `src/litellm-portal/admin/derive.ts` + `src/litellm-portal/admin/derive.test.ts`. Task 2 modifies ONLY `src/litellm-portal/admin-components.tsx`. Never modify `admin-components.test.tsx` or any other file.
2. **Move, do not rewrite.** Copy the 4 symbols VERBATIM into derive.ts. In admin-components.tsx, DELETE the local definitions and ADD the import. Logic must be byte-identical (behaviour unchanged).
3. **Verbatim.** Apply OLD→NEW exactly. No reformat, no `any`, no `@ts-ignore`. If an OLD block isn't found verbatim, STOP and report with the actual file region.
4. **Regression contract.** `admin-components.test.tsx` MUST stay green WITHOUT modification (proves AdminStatusHeader/SyncStatusBadge integration unchanged). If it fails after Task 2, STOP and report (NEVER edit it).
5. **TDD for derive.test.ts** (Task 1): write test → run → FAIL → implement derive.ts → PASS.
6. **TYPECHECK PROTOCOL.** When a step says "Typecheck", run EXACTLY:
   ```bash
   bunx tsc --noEmit -p tsconfig.json 2>&1 | grep -E "error TS" | grep -vE "TS6142|server\.ts\(6,33\)" | grep -E "litellm-portal/admin/|litellm-portal/admin-components" || echo "ADMIN DERIVE TYPECHECK CLEAN"
   ```
   Expected: single line `ADMIN DERIVE TYPECHECK CLEAN`. Bare `TS6142` is NEVER a stop reason.
7. **STOP rule.** Any output ≠ Expected → STOP, report step + full output, do not continue.
8. **One commit per task**, scope `litellm-portal`, exact message. Never push / rebase / amend / switch branches. **Working directory:** `/Users/xumingyang/github/contrabass/cloud`.

---

## Task 1: Create admin/derive.ts + unit tests (TDD)

**Files:** Create `src/litellm-portal/admin/derive.ts`, `src/litellm-portal/admin/derive.test.ts`

- [ ] **Step 1: Write the unit test.** Create `src/litellm-portal/admin/derive.test.ts` with EXACTLY:

```ts
import { afterEach, describe, expect, it, vi } from "vitest";
import { text, deriveHealthSummary, relativeTime } from "./derive";

afterEach(() => vi.restoreAllMocks());

describe("text", () => {
  it("returns — for null / undefined / empty string", () => {
    expect(text(null)).toBe("—");
    expect(text(undefined)).toBe("—");
    expect(text("")).toBe("—");
  });
  it("stringifies present values", () => {
    expect(text("a")).toBe("a");
    expect(text(0)).toBe("0");
  });
});

describe("deriveHealthSummary", () => {
  it("danger tone when over-budget and riskCount>=10", () => {
    const r = deriveHealthSummary({ overBudgetTeamCount: 2, riskCount: 10 });
    expect(r.tone).toBe("danger");
    expect(r.message).toContain("2 个团队超预算");
  });
  it("warning tone when over-budget and riskCount<10", () => {
    expect(deriveHealthSummary({ overBudgetUserCount: 1, riskCount: 1 }).tone).toBe("warning");
  });
  it("warning with unmanaged roles when risk but no over-budget", () => {
    const r = deriveHealthSummary({ riskCount: 3, unmanagedRoleCount: 2 });
    expect(r.tone).toBe("warning");
    expect(r.message).toContain("2 个未映射角色");
  });
  it("success when all clear", () => {
    expect(deriveHealthSummary({})).toEqual({ message: "系统正常", tone: "success" });
  });
});

describe("relativeTime", () => {
  it("just now for <60s / future / invalid", () => {
    const now = 1_000_000_000_000;
    vi.spyOn(Date, "now").mockReturnValue(now);
    expect(relativeTime(new Date(now - 5_000).toISOString())).toBe("just now");
    expect(relativeTime(new Date(now + 5_000).toISOString())).toBe("just now");
    expect(relativeTime("not-a-date")).toBe("just now");
  });
  it("m/h/d ago buckets", () => {
    const now = 1_000_000_000_000;
    vi.spyOn(Date, "now").mockReturnValue(now);
    expect(relativeTime(new Date(now - 5 * 60_000).toISOString())).toBe("5m ago");
    expect(relativeTime(new Date(now - 3 * 3_600_000).toISOString())).toBe("3h ago");
    expect(relativeTime(new Date(now - 2 * 86_400_000).toISOString())).toBe("2d ago");
  });
});
```

- [ ] **Step 2: Run — expect FAIL.** Run:
```bash
pnpm exec vitest run src/litellm-portal/admin/derive.test.ts
```
Expected: FAIL — cannot resolve `./derive`. If it PASSES, STOP and report.

- [ ] **Step 3: Create derive.ts.** Create `src/litellm-portal/admin/derive.ts` with EXACTLY:

```ts
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
```

- [ ] **Step 4: Run — expect PASS.** Run:
```bash
pnpm exec vitest run src/litellm-portal/admin/derive.test.ts
```
Expected: PASS, all tests (text 2 + deriveHealthSummary 4 + relativeTime 2 = 8). If any FAIL, STOP and report.

- [ ] **Step 5: Typecheck.** §6 command. Expected: `ADMIN DERIVE TYPECHECK CLEAN`.

- [ ] **Step 6: Commit.**
```bash
git add src/litellm-portal/admin/derive.ts src/litellm-portal/admin/derive.test.ts
git commit -m "feat(litellm-portal): extract admin pure derive/format helpers (S7/E1)"
```

---

## Task 2: Point admin-components.tsx at admin/derive.ts (delete local defs)

**Files:** Modify `src/litellm-portal/admin-components.tsx`

- [ ] **Step 1: Replace the import region + delete local `text`.** Replace EXACTLY:
```tsx
import { fmt, fmtInt } from "./lib/format";

function text(value: unknown): string {
  return value == null || value === "" ? "—" : String(value);
}
```
with EXACTLY:
```tsx
import { fmt, fmtInt } from "./lib/format";
import {
  text,
  deriveHealthSummary,
  relativeTime,
  type AdminStatusSummary,
} from "./admin/derive";
```

- [ ] **Step 2: Delete the local type + deriveHealthSummary.** Replace EXACTLY:
```tsx
type AdminStatusSummary = {
  riskCount?: number | null;
  overBudgetUserCount?: number | null;
  overBudgetTeamCount?: number | null;
  unmanagedRoleCount?: number | null;
  noTeamUserCount?: number | null;
  limited?: boolean;
};

function deriveHealthSummary(summary: AdminStatusSummary): { message: string; tone: "success" | "warning" | "danger" } {
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
```
with EXACTLY:
```tsx
```
(i.e. delete the entire block — replace it with an empty string so those lines are removed.)

- [ ] **Step 3: Delete the local `relativeTime`.** Replace EXACTLY:
```tsx
function relativeTime(iso: string): string {
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
```
with EXACTLY:
```tsx
```
(delete the entire function.)

- [ ] **Step 4: Regression gate — existing admin-components tests (UNMODIFIED).** Run:
```bash
pnpm exec vitest run src/litellm-portal/admin-components.test.tsx
```
Expected: ALL pass (file unmodified). If ANY fail, STOP and report full output. Do NOT edit the test.

- [ ] **Step 5: Typecheck.** §6 command. Expected: `ADMIN DERIVE TYPECHECK CLEAN`. (If a real error says `text`/`deriveHealthSummary`/`relativeTime`/`AdminStatusSummary` is undefined or duplicate, you mis-deleted/mis-imported — STOP and report.)

- [ ] **Step 6: Broader regression.** Run:
```bash
pnpm exec vitest run src/litellm-portal/admin-components.test.tsx src/litellm-portal/admin src/litellm-portal/ui
```
Expected: ALL pass. If any fail, STOP and report.

- [ ] **Step 7: Commit.**
```bash
git add src/litellm-portal/admin-components.tsx
git commit -m "refactor(litellm-portal): admin-components imports derive helpers from admin/ (S7/E1)"
```

---

## Task 3: Verification (no commit)

- [ ] **Step 1:** `pnpm exec vitest run src/litellm-portal/admin-components.test.tsx` → all pass; `git diff` shows that test file UNCHANGED.
- [ ] **Step 2:** `pnpm exec vitest run src/litellm-portal/admin/derive.test.ts` → 8 passed.
- [ ] **Step 3:** §6 TYPECHECK PROTOCOL → `ADMIN DERIVE TYPECHECK CLEAN`.
- [ ] **Step 4:** `git diff --name-only HEAD~2 HEAD` → exactly `admin/derive.ts`, `admin/derive.test.ts`, `admin-components.tsx`. Report + `git log --oneline -2`.

**DoD:** pure `text`/`deriveHealthSummary`/`relativeTime`/`AdminStatusSummary` live in `admin/derive.ts` with 8 unit tests; `admin-components.tsx` imports them (local defs deleted, byte-identical logic); existing admin-components.test.tsx green UNMODIFIED; tsc clean; 2 commits; only the 3 expected files changed. Audit S7/E1 pure-logic slice closed.

## Out of scope (documented, with reason)
Splitting the stateful components (AdminUsersTable / AdminTeamsTable / AdminAuditFeed / AdminCard / AdminSection / SyncStatusBadge / RoleBadge / ModelChips) into `admin/{cells,tables,panels}` — the existing admin-components.test.tsx only covers 5 of 9 exports, so a stateful-component split is NOT behaviour-evidenced; it requires first adding tests for the untested exports. That is a deliberately separate, properly-gated follow-up. Screen archetypes → separate design-led plan (slot grammar specified in REMEDIATION_PLAN.md).
