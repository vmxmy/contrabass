# LiteLLM Portal — Plan-3：管理面三大表 Error Boundary 覆盖（审计 S5 / E2）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development / executing-plans. Steps use `- [ ]`.

**Goal:** 把管理面 users / teams / audit 三个 `*.lazy.tsx` 的表格组件包进既有 `BlockErrorBoundary`，关闭审计 S5/E2 🟠 Critical（表渲染抛错冒泡导致整个 `/manage` 白屏）。

**Architecture:** `BlockErrorBoundary`（`src/litellm-portal/errors/error-boundary.tsx`，`{ blockLabel: string; children }`，class 组件，未抛错时**透明 pass-through 返回 children**）。包裹 = 纯增强，零行为变更（正常路径渲染完全不变；仅当组件抛错时局部降级而非整页白屏）。复用已在 `ops-console/screens/audit.tsx`、`usage-dashboard.tsx` 验证过的同一组件，不新建。

**Tech Stack:** React, TS strict, Vitest, pnpm。三文件无卡片 chrome，不触碰棘轮基线。

---

## Instructions for the implementing agent (Kimi) — read fully before Task 1

1. **Scope lock.** Each task modifies exactly ONE file. Touch nothing else. Never modify `error-boundary.tsx`, `admin-components.tsx`, `ui/*`, baseline.
2. **Verbatim.** Apply OLD→NEW exactly. No reformat, no `any`, no `@ts-ignore`. If OLD not found verbatim, STOP and report.
3. **Behaviour preserved by construction.** You only ADD an import and WRAP an existing element in `<BlockErrorBoundary blockLabel="…">…</BlockErrorBoundary>`. Do not change the wrapped element.
4. **TYPECHECK PROTOCOL.** When a step says "Typecheck", run EXACTLY:
   ```bash
   bunx tsc --noEmit -p tsconfig.json 2>&1 | grep -E "error TS" | grep -vE "TS6142|server\.ts\(6,33\)" | grep "litellm-portal/routes/manage/" || echo "BOUNDARY TYPECHECK CLEAN"
   ```
   Expected: single line `BOUNDARY TYPECHECK CLEAN`. A bare `TS6142` is NEVER a stop reason. Any other error line → STOP and report.
5. **Suite check (every task).** Run EXACTLY:
   ```bash
   pnpm exec vitest run src/litellm-portal/ui
   ```
   Expected: all pass (21). (The seam suite must remain green; these edits are unrelated to it but it is the fast global guard.)
6. **STOP rule.** Any output ≠ Expected → STOP, report task/step + full output, do not continue.
7. **One commit per task**, scope `litellm-portal`, exact message. Never push / rebase / amend / switch branches.
8. **Working directory** for every command: `/Users/xumingyang/github/contrabass/cloud`.

---

## Task 1: `routes/manage/users/index.lazy.tsx`

**Files:** Modify `src/litellm-portal/routes/manage/users/index.lazy.tsx`

- [ ] **Step 1: Add import.** Replace EXACTLY:
```tsx
import { AdminCard, AdminUsersTable } from "../../../admin-components";
```
with EXACTLY:
```tsx
import { AdminCard, AdminUsersTable } from "../../../admin-components";
import { BlockErrorBoundary } from "../../../errors/error-boundary";
```

- [ ] **Step 2: Wrap the table.** Replace EXACTLY:
```tsx
      <AdminCard title="全员账户">
        <AdminUsersTable />
      </AdminCard>
```
with EXACTLY:
```tsx
      <AdminCard title="全员账户">
        <BlockErrorBoundary blockLabel="用户管理">
          <AdminUsersTable />
        </BlockErrorBoundary>
      </AdminCard>
```

- [ ] **Step 3: Typecheck.** §4 command. Expected: `BOUNDARY TYPECHECK CLEAN`.
- [ ] **Step 4: Suite.** §5 command. Expected: 21 pass.
- [ ] **Step 5: Commit.**
```bash
git add src/litellm-portal/routes/manage/users/index.lazy.tsx
git commit -m "fix(litellm-portal): isolate AdminUsersTable in BlockErrorBoundary"
```

---

## Task 2: `routes/manage/teams/index.lazy.tsx`

**Files:** Modify `src/litellm-portal/routes/manage/teams/index.lazy.tsx`

- [ ] **Step 1: Add import.** Replace EXACTLY:
```tsx
import { AdminCard, AdminTeamsTable } from "../../../admin-components";
```
with EXACTLY:
```tsx
import { AdminCard, AdminTeamsTable } from "../../../admin-components";
import { BlockErrorBoundary } from "../../../errors/error-boundary";
```

- [ ] **Step 2: Wrap the table.** Replace EXACTLY:
```tsx
      <AdminCard title="全部团队">
        <AdminTeamsTable />
      </AdminCard>
```
with EXACTLY:
```tsx
      <AdminCard title="全部团队">
        <BlockErrorBoundary blockLabel="团队管理">
          <AdminTeamsTable />
        </BlockErrorBoundary>
      </AdminCard>
```

- [ ] **Step 3: Typecheck.** §4 command. Expected: `BOUNDARY TYPECHECK CLEAN`.
- [ ] **Step 4: Suite.** §5 command. Expected: 21 pass.
- [ ] **Step 5: Commit.**
```bash
git add src/litellm-portal/routes/manage/teams/index.lazy.tsx
git commit -m "fix(litellm-portal): isolate AdminTeamsTable in BlockErrorBoundary"
```

---

## Task 3: `routes/manage/audit/index.lazy.tsx`

**Files:** Modify `src/litellm-portal/routes/manage/audit/index.lazy.tsx`

- [ ] **Step 1: Add import.** Replace EXACTLY:
```tsx
import { AdminAuditFeed, AdminCard } from "../../../admin-components";
```
with EXACTLY:
```tsx
import { AdminAuditFeed, AdminCard } from "../../../admin-components";
import { BlockErrorBoundary } from "../../../errors/error-boundary";
```

- [ ] **Step 2: Wrap the feed.** Replace EXACTLY:
```tsx
      <AdminCard title="审计日志">
        <AdminAuditFeed />
      </AdminCard>
```
with EXACTLY:
```tsx
      <AdminCard title="审计日志">
        <BlockErrorBoundary blockLabel="审计日志">
          <AdminAuditFeed />
        </BlockErrorBoundary>
      </AdminCard>
```

- [ ] **Step 3: Typecheck.** §4 command. Expected: `BOUNDARY TYPECHECK CLEAN`.
- [ ] **Step 4: Suite.** §5 command. Expected: 21 pass.
- [ ] **Step 5: Commit.**
```bash
git add src/litellm-portal/routes/manage/audit/index.lazy.tsx
git commit -m "fix(litellm-portal): isolate AdminAuditFeed in BlockErrorBoundary"
```

---

## Task 4: Verification (no commit)

- [ ] **Step 1:** §4 TYPECHECK PROTOCOL → `BOUNDARY TYPECHECK CLEAN`.
- [ ] **Step 2:** `pnpm exec vitest run src/litellm-portal/ui` → 21 pass.
- [ ] **Step 3:** Confirm each of the 3 files contains `BlockErrorBoundary` wrapping its table:
```bash
grep -c "BlockErrorBoundary" src/litellm-portal/routes/manage/users/index.lazy.tsx src/litellm-portal/routes/manage/teams/index.lazy.tsx src/litellm-portal/routes/manage/audit/index.lazy.tsx
```
Expected: each file reports `2` (import + usage).
- [ ] **Step 4:** Report `git log --oneline` of the 3 new commits.

**DoD:** 3 admin tables wrapped in `BlockErrorBoundary` (audit S5/E2 closed), typecheck clean, ui suite green, 3 commits, zero behaviour change on the success path.

## Out of scope
ApiKeysCard / MemberOverlay boundaries → folded into the God-Component decomposition plan (they live in deferred files app.tsx / member-overlay.tsx). PageShell / archetypes / density / Kumo sidebar → later plans.
