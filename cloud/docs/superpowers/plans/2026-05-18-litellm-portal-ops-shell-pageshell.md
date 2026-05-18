# LiteLLM Portal — Plan-8：OpsConsoleShell 迁移到 PageShell（审计 S2 收敛，第 1 个 shell）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development / executing-plans. Steps use `- [ ]`.

**Goal:** 把 `OpsConsoleShell` 的外壳 chrome（根 canvas div + header band + flex/SideNav/main）替换为 `<PageShell>`，关闭审计 S2 的第 1 个顶层带侧栏外壳。Ops 的载荷性 wrapper（`id="ops-console-shell-root"`、`style={OPS_STEEL_ACCENT}`、`<DensityProvider>`、`!isOwner` 403 早返回）**全部保留**。

**Architecture（已验证的判定）:** 已读 `ops-console/shell.test.tsx` 的 7 个测试 —— 它们全是**行为断言**（nav 项文本 / `[data-ops-privileged-pill]`+`ring-1` / `data-testid=ops-summary-chips` / nav 分组 / aria-current / focus-ring / 非 Owner 403 无 nav），**不**断言外层 `id`/`min-h-screen`/header `aria-label`/DensityProvider 嵌套。因此把 chrome 换成 PageShell（保留 pill/chips/SideNav/Forbidden 分支）**逐字保留全部 7 个断言** = 行为保持的证据。steel-accent 经 Plan-7b 的 `style` 透传（**已有单测断言转发**）保留 = 不可见样式风险已转成已测不变量。`DensityProvider`（纯 context）包在 PageShell 外，效果不变。

**已记录的设计排除（PR review 可否决，附结构性理由）:**
- `tenant-portal/shell.tsx`：双变体（owner=`max-w-5xl` 无 nav vs 非 owner=侧栏）+ 前置 `ImpersonationBanner`(role=alert,载荷性) + `BrandSummaryBar` + `SideNavSsrFallback`。PageShell 模型是「单 header+nav+main」，与之结构不符 → 强行并入会威胁 impersonation/SSR 契约,**排除**。
- `routes/manage/route.lazy.tsx`：嵌套子布局(`flex flex-1`,非 `min-h-screen` 页根),非顶层 shell → **排除**。
- `__root.tsx` 着陆页:居中、无侧栏 → **排除**(Plan-7 已记录)。

**Tech Stack:** React, TS strict, Vitest + @testing-library/react (happy-dom), pnpm。

---

## Instructions for the implementing agent (Kimi) — read fully before Task 1

1. **Scope lock.** Modify ONLY `src/litellm-portal/ops-console/shell.tsx`. Never modify any test, `ui/*`, other shell, hooks.
2. **Preserve logic exactly.** Replace ONLY the main `return (...)` JSX shown in the OLD block. Do NOT touch the `!isOwner(identity)` early-return block above it, the hooks, or any import except adding the PageShell import.
3. **Verbatim.** Apply OLD→NEW exactly. No reformat, no `any`, no `@ts-ignore`. If OLD not found verbatim, STOP and report with the actual file region.
4. **Regression contract (non-negotiable).** `src/litellm-portal/ops-console/shell.test.tsx` (7 tests) MUST stay green WITHOUT being modified — it is the proof Ops behaviour/identity-gating is preserved. If any of those 7 fail, your change is wrong → STOP and report (NEVER edit the test to pass).
5. **TYPECHECK PROTOCOL.** When a step says "Typecheck", run EXACTLY:
   ```bash
   bunx tsc --noEmit -p tsconfig.json 2>&1 | grep -E "error TS" | grep -vE "TS6142|server\.ts\(6,33\)" | grep "litellm-portal/ops-console/shell" || echo "OPS SHELL TYPECHECK CLEAN"
   ```
   Expected: single line `OPS SHELL TYPECHECK CLEAN`. Bare `TS6142` is NEVER a stop reason.
6. **STOP rule.** Any output ≠ Expected → STOP, report step + full output, do not continue.
7. **One commit**, scope `litellm-portal`, exact message. Never push / rebase / amend / switch branches.
8. **Working directory** for every command: `/Users/xumingyang/github/contrabass/cloud`.

---

## Task 1: Migrate OpsConsoleShell chrome to PageShell

**Files:** Modify `src/litellm-portal/ops-console/shell.tsx`

- [ ] **Step 1: Add the PageShell import.** Replace EXACTLY:
```tsx
import { SideNav, type SideNavGroup } from "../components/side-nav";
```
with EXACTLY:
```tsx
import { SideNav, type SideNavGroup } from "../components/side-nav";
import { PageShell } from "../ui";
```

- [ ] **Step 2: Replace ONLY the main return block.** Replace EXACTLY:
```tsx
  return (
    <div
      id="ops-console-shell-root"
      className="flex min-h-screen flex-col bg-kumo-canvas text-kumo-default"
      style={OPS_STEEL_ACCENT}
    >
      <DensityProvider density={resolveDensity(densityPref, "compact")}>
        <div
          className="flex items-center gap-3 border-b border-kumo-line bg-kumo-elevated px-6 py-4"
          aria-label={t`运营控制台`}
        >
          <Text variant="heading3" as="span" className="truncate text-kumo-strong">
            <Trans>运营控制台</Trans>
          </Text>
          <span
            data-ops-privileged-pill
            className="rounded-full ring-1 ring-kumo-brand px-2 py-0.5 text-xs font-medium text-kumo-subtle"
          >
            <Trans>内部·特权</Trans>
          </span>
          <OpsSummaryChips />
          <DensityToggle
            current={resolveDensity(densityPref, "compact")}
            onChange={(d) => updatePrefs.mutate({ density: d })}
          />
        </div>
        <div className="flex flex-1">
          <SideNav
            groups={[
              {
                heading: t`租户`,
                items: ["/ops", "/ops/provisioning"].map((href) => {
                  const n = byHref(href);
                  return { href: n.href, label: n.label, icon: n.icon };
                }),
              },
              {
                heading: t`平台`,
                items: ["/ops/usage", "/ops/audit", "/ops/settings"].map(
                  (href) => {
                    const n = byHref(href);
                    return { href: n.href, label: n.label, icon: n.icon };
                  },
                ),
              },
            ]}
            currentPath={pathname}
            accent="steel"
            ariaLabel={t`运营导航`}
          />
          <main className="min-w-0 flex-1 px-6 py-8 opacity-100 motion-safe:transition-opacity motion-safe:duration-150">{children}</main>
        </div>
      </DensityProvider>
    </div>
  );
```
with EXACTLY:
```tsx
  return (
    <DensityProvider density={resolveDensity(densityPref, "compact")}>
      <PageShell
        id="ops-console-shell-root"
        style={OPS_STEEL_ACCENT}
        header={
          <>
            <Text variant="heading3" as="span" className="truncate text-kumo-strong">
              <Trans>运营控制台</Trans>
            </Text>
            <span
              data-ops-privileged-pill
              className="rounded-full ring-1 ring-kumo-brand px-2 py-0.5 text-xs font-medium text-kumo-subtle"
            >
              <Trans>内部·特权</Trans>
            </span>
            <OpsSummaryChips />
            <DensityToggle
              current={resolveDensity(densityPref, "compact")}
              onChange={(d) => updatePrefs.mutate({ density: d })}
            />
          </>
        }
        nav={
          <SideNav
            groups={[
              {
                heading: t`租户`,
                items: ["/ops", "/ops/provisioning"].map((href) => {
                  const n = byHref(href);
                  return { href: n.href, label: n.label, icon: n.icon };
                }),
              },
              {
                heading: t`平台`,
                items: ["/ops/usage", "/ops/audit", "/ops/settings"].map(
                  (href) => {
                    const n = byHref(href);
                    return { href: n.href, label: n.label, icon: n.icon };
                  },
                ),
              },
            ]}
            currentPath={pathname}
            accent="steel"
            ariaLabel={t`运营导航`}
          />
        }
      >
        {children}
      </PageShell>
    </DensityProvider>
  );
```

- [ ] **Step 3: Regression gate — Ops shell tests.** Run:
```bash
pnpm exec vitest run src/litellm-portal/ops-console/shell.test.tsx
```
Expected: ALL 7 tests pass (unchanged file). If ANY fail, STOP and report full output — your migration broke the Ops behaviour/identity contract. Do NOT edit the test.

- [ ] **Step 4: Typecheck.** §5 command. Expected: `OPS SHELL TYPECHECK CLEAN`.

- [ ] **Step 5: Broader regression.** Run:
```bash
pnpm exec vitest run src/litellm-portal/ui src/litellm-portal/ops-console src/litellm-portal/router.test.tsx src/litellm-portal/hydration.test.tsx
```
Expected: ALL pass (ui 28 + ops-console suite + router + hydration). If any fail, STOP and report.

- [ ] **Step 6: Commit.**
```bash
git add src/litellm-portal/ops-console/shell.tsx
git commit -m "refactor(litellm-portal): migrate OpsConsoleShell chrome to PageShell (S2)"
```

---

## Task 2: Verification (no commit)

- [ ] **Step 1:** `pnpm exec vitest run src/litellm-portal/ops-console/shell.test.tsx` → 7 passed (file unmodified — `git diff` shows no change to the test).
- [ ] **Step 2:** §5 TYPECHECK PROTOCOL → `OPS SHELL TYPECHECK CLEAN`.
- [ ] **Step 3:** `pnpm exec vitest run src/litellm-portal/ui` → 28 passed (PageShell incl. steel-accent style-forwarding test still green).
- [ ] **Step 4:** `git diff --name-only HEAD~1 HEAD` → exactly `src/litellm-portal/ops-console/shell.tsx`. Report it + `git log --oneline -1`.

**DoD:** OpsConsoleShell renders via `<PageShell>`; `id`/steel-accent/DensityProvider/`!isOwner` 403 branch all preserved; all 7 Ops shell tests green unmodified (behaviour proven preserved); ui 28 + router + hydration green; tsc clean; 1 commit; only `ops-console/shell.tsx` changed. Audit S2 advanced (first top-level sidebar shell unified on the primitive).

## Out of scope (documented exclusions, review may override)
tenant-portal/shell.tsx (dual-variant + pre-header impersonation/summary + owner-no-nav + SSR fallback — structural non-fit), routes/manage/route.lazy.tsx (nested sub-layout), __root.tsx (sidebar-less landing). S7 God-Component decomposition / screen archetypes → separate.
