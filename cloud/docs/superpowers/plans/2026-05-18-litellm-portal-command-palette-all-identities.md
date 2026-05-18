# LiteLLM Portal — Plan-4：命令面板对全部已认证身份开放（审计 S10 / C2）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development / executing-plans. Steps use `- [ ]`.

**Goal:** `__root.tsx` 现仅 `me?.role === "admin"` 才挂载命令面板（⌘K），非 admin（admin_viewer / tenant_admin / member——恰是高频键盘流用户）完全无法使用。改为对**任何已认证身份**挂载，关闭审计 S10/C2 🟠 Critical。

**Architecture:** 单文件单点改动。命令面板的 jump 数据源（`useAdminUsers/Teams/Audit`）是 admin-only，**服务端强制鉴权**（role 单一真源 = LiteLLM，服务端 403）；非 admin 挂载时这些查询自然返回空 → `filter((group) => group.items.length > 0)` 过滤掉空 jump 组，仅保留通用 action（新建 Key / 切换深色 / 退出）。因此对全身份挂载**不泄露任何 admin 数据**（服务端拒绝 + UI 空组过滤），是纯增益、对 admin 行为零变更。删除随之失效的死代码 `const isAdmin`。

> 已知后续优化（不在本 plan）：非 admin 挂载会触发 3 个必然 403 的 admin 查询（浪费 + 日志噪音）。本 plan 取最小安全闭环（恢复非 admin 的 ⌘K 可达性，审计 S10 核心诉求）；按 role 条件禁用 admin 查询是独立后续项，因为它需改 `use-admin-*` hooks 的 enabled 语义，超出最小修复面。

**Tech Stack:** React, TanStack Router, TS strict, Vitest, pnpm。

---

## Instructions for the implementing agent (Kimi) — read fully before Task 1

1. **Scope lock.** Modify ONLY `src/litellm-portal/routes/__root.tsx`. Nothing else. Do NOT modify `portal-command-palette.tsx`, the `use-admin-*` hooks, or any other file.
2. **Verbatim.** Apply OLD→NEW exactly. No reformat, no `any`, no `@ts-ignore`. If OLD not found verbatim, STOP and report with the actual file region.
3. **Two edits, one file:** (a) delete the now-dead `const isAdmin` line; (b) change the command-palette mount gate from `isAdmin` to `me`. Nothing else changes.
4. **TYPECHECK PROTOCOL.** When a step says "Typecheck", run EXACTLY:
   ```bash
   bunx tsc --noEmit -p tsconfig.json 2>&1 | grep -E "error TS" | grep -vE "TS6142|server\.ts\(6,33\)" | grep "litellm-portal/routes/__root" || echo "ROOT TYPECHECK CLEAN"
   ```
   Expected: single line `ROOT TYPECHECK CLEAN`. A bare `TS6142` is NEVER a stop reason. Any other error line → STOP and report.
5. **Behaviour gate (real tests).** Run EXACTLY:
   ```bash
   pnpm exec vitest run src/litellm-portal/router.test.tsx src/litellm-portal/hydration.test.tsx src/litellm-portal/ui
   ```
   Expected: ALL pass. If any FAIL, STOP and report full output (this is the regression gate for the root render — do NOT proceed on failure).
6. **STOP rule.** Any output ≠ Expected → STOP, report step + full output, do not continue.
7. **One commit**, scope `litellm-portal`, exact message. Never push / rebase / amend / switch branches.
8. **Working directory** for every command: `/Users/xumingyang/github/contrabass/cloud`.

---

## Task 1: Open the command palette to all authenticated identities

**Files:** Modify `src/litellm-portal/routes/__root.tsx`

- [ ] **Step 1: Delete the dead `isAdmin` const.** Replace EXACTLY:
```tsx
  const { data: me } = useMe();
  const isAdmin = me?.role === "admin";
```
with EXACTLY:
```tsx
  const { data: me } = useMe();
```

- [ ] **Step 2: Change the mount gate from admin-only to authenticated.** Replace EXACTLY:
```tsx
      {isAdmin ? (
        <React.Suspense fallback={<CommandPaletteFallback />}>
          <LazyPortalCommandPalette />
        </React.Suspense>
      ) : null}
```
with EXACTLY:
```tsx
      {me ? (
        <React.Suspense fallback={<CommandPaletteFallback />}>
          <LazyPortalCommandPalette />
        </React.Suspense>
      ) : null}
```

- [ ] **Step 3: Typecheck.** §4 command. Expected: `ROOT TYPECHECK CLEAN`. (If a real error says `isAdmin` is still referenced somewhere, you missed a usage — STOP and report; do NOT re-add the const, report instead.)

- [ ] **Step 4: Behaviour gate.** §5 command. Expected: router.test.tsx + hydration.test.tsx + ui suite ALL pass. If any fail, STOP and report full output.

- [ ] **Step 5: Commit.**
```bash
git add src/litellm-portal/routes/__root.tsx
git commit -m "fix(litellm-portal): mount command palette for all authenticated identities"
```

---

## Task 2: Verification (no commit)

- [ ] **Step 1:** §4 TYPECHECK PROTOCOL → `ROOT TYPECHECK CLEAN`.
- [ ] **Step 2:** §5 behaviour gate → all pass.
- [ ] **Step 3:** Confirm the change:
```bash
grep -n "isAdmin\|{me ? (" src/litellm-portal/routes/__root.tsx
```
Expected: NO `isAdmin` line remains; the palette gate line shows `{me ? (`.
- [ ] **Step 4:** Report `git log --oneline -1` and the diff stat.

**DoD:** command palette mounts for every authenticated identity (admin behaviour unchanged; non-admins gain ⌘K with the universal action commands), dead `isAdmin` removed, typecheck clean, router + hydration + ui suites green, 1 commit, no other file touched.

## Out of scope
Role-conditional disabling of the admin jump queries (efficiency follow-up). God-Component decomposition / PageShell / archetypes / density / SideNav→Kumo sidebar → later plans.
