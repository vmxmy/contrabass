# LiteLLM Portal — Plan-10：TenantPortalShell 非-owner 变体迁移到 PageShell（审计 S2 收敛，第 2 个 shell）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development / executing-plans. Steps use `- [ ]`.

**Goal:** 把 `TenantPortalShell` 的 **非-owner 变体**（侧栏布局）外壳 chrome 替换为 `<PageShell>`（`preHeader` = ImpersonationBanner + BrandSummaryBar，`nav` = SideNav/SsrFallback）。**owner 变体**（`max-w-5xl` 居中、无 nav、OwnerOpsEntry）保持 bespoke（**已记录的排除**，与 __root 着陆同理：合法的不同布局，非噪音）。所有载荷性逻辑（impersonation / SSR fallback / 双变体 / brand vars / id / DensityProvider）保留。

**Architecture（已验证的契约，证据充分）:** 已读 `tenant-portal/shell.test.tsx`(9 测试) + `shell-impersonation.test.tsx`(3 测试)：全部行为断言（nav 项/owner-无nav/aria-current/focus-ring/`[data-brand-summary-bar]`/`role=alert`/SideNav 分组），**仅一条结构断言** `#tenant-portal-shell-root` 的 inline `style` 只含 `--kumo-brand*` —— 由 PageShell 的 **Plan-7b 已测 style 透传**满足（`applyBrandVars(brand)` 只产 brand 变量）。impersonation banner 的位置由 **Plan-9 已测 preHeader 放置不变量**保证 = **无视觉 QA 缺口**。`DensityProvider` 移到两分支外（纯 context、无 DOM、默认值不变）。

**Tech Stack:** React, TS strict, Vitest + @testing-library/react (happy-dom), pnpm。

---

## Instructions for the implementing agent (Kimi) — read fully before Task 1

1. **Scope lock.** Modify ONLY `src/litellm-portal/tenant-portal/shell.tsx`. Never modify any test, `ui/*`, other shell, hooks, `branding`, `BrandSummaryBar`, `ImpersonationBanner`, `SideNavSsrFallback`, `OwnerOpsEntry`.
2. **Preserve logic exactly.** Replace ONLY the single main `return (...)` JSX block shown. Keep every expression verbatim: `impersonation`, `BrandSummaryBar`, `owner`, `hydrated`, `navGroups`, `pathname`, `densityPref`, `applyBrandVars(brand)`, `OwnerOpsEntry`, `children`, the SideNav/SsrFallback props.
3. **Verbatim.** Apply OLD→NEW exactly. No reformat, no `any`, no `@ts-ignore`. If OLD not found verbatim, STOP and report with the actual file region.
4. **Regression contract (non-negotiable).** `tenant-portal/shell.test.tsx`, `tenant-portal/shell-impersonation.test.tsx`, `tenant-portal/routes.test.tsx` MUST stay green WITHOUT being modified. If any fail, your change is wrong → STOP and report (NEVER edit a test to pass).
5. **TYPECHECK PROTOCOL.** When a step says "Typecheck", run EXACTLY:
   ```bash
   bunx tsc --noEmit -p tsconfig.json 2>&1 | grep -E "error TS" | grep -vE "TS6142|server\.ts\(6,33\)" | grep "litellm-portal/tenant-portal/shell" || echo "TENANT SHELL TYPECHECK CLEAN"
   ```
   Expected: single line `TENANT SHELL TYPECHECK CLEAN`. Bare `TS6142` is NEVER a stop reason.
6. **STOP rule.** Any output ≠ Expected → STOP, report step + full output, do not continue.
7. **One commit**, scope `litellm-portal`, exact message. Never push / rebase / amend / switch branches.
8. **Working directory** for every command: `/Users/xumingyang/github/contrabass/cloud`.

---

## Task 1: Migrate the non-owner variant to PageShell

**Files:** Modify `src/litellm-portal/tenant-portal/shell.tsx`

- [ ] **Step 1: Add the PageShell import.** Replace EXACTLY:
```tsx
import { SideNav, type SideNavGroup, type SideNavItem } from "../components/side-nav";
```
with EXACTLY:
```tsx
import { SideNav, type SideNavGroup, type SideNavItem } from "../components/side-nav";
import { PageShell } from "../ui";
```

- [ ] **Step 2: Replace ONLY the main return block.** Replace EXACTLY:
```tsx
  return (
    <div
      id="tenant-portal-shell-root"
      className="flex min-h-screen flex-col bg-kumo-canvas text-kumo-default"
      style={applyBrandVars(brand)}
    >
      <DensityProvider density={resolveDensity(densityPref, "comfortable")}>
        {impersonation ? <ImpersonationBanner imp={impersonation} /> : null}
        <BrandSummaryBar brand={brand} />
        {owner ? (
          <main className="mx-auto w-full max-w-5xl px-6 py-10 opacity-100 motion-safe:transition-opacity motion-safe:duration-150">
            <OwnerOpsEntry />
            {children}
          </main>
        ) : (
          <div className="flex flex-1">
            {hydrated ? (
              <SideNav
                groups={navGroups}
                currentPath={pathname}
                accent="brand"
                ariaLabel={t`租户导航`}
              />
            ) : (
              <SideNavSsrFallback
                groups={navGroups}
                currentPath={pathname}
                ariaLabel={t`租户导航`}
              />
            )}
            <main className="min-w-0 flex-1 px-6 py-8 opacity-100 motion-safe:transition-opacity motion-safe:duration-150">{children}</main>
          </div>
        )}
      </DensityProvider>
    </div>
  );
```
with EXACTLY:
```tsx
  return (
    <DensityProvider density={resolveDensity(densityPref, "comfortable")}>
      {owner ? (
        <div
          id="tenant-portal-shell-root"
          className="flex min-h-screen flex-col bg-kumo-canvas text-kumo-default"
          style={applyBrandVars(brand)}
        >
          {impersonation ? <ImpersonationBanner imp={impersonation} /> : null}
          <BrandSummaryBar brand={brand} />
          <main className="mx-auto w-full max-w-5xl px-6 py-10 opacity-100 motion-safe:transition-opacity motion-safe:duration-150">
            <OwnerOpsEntry />
            {children}
          </main>
        </div>
      ) : (
        <PageShell
          id="tenant-portal-shell-root"
          style={applyBrandVars(brand)}
          preHeader={
            <>
              {impersonation ? <ImpersonationBanner imp={impersonation} /> : null}
              <BrandSummaryBar brand={brand} />
            </>
          }
          nav={
            hydrated ? (
              <SideNav
                groups={navGroups}
                currentPath={pathname}
                accent="brand"
                ariaLabel={t`租户导航`}
              />
            ) : (
              <SideNavSsrFallback
                groups={navGroups}
                currentPath={pathname}
                ariaLabel={t`租户导航`}
              />
            )
          }
        >
          {children}
        </PageShell>
      )}
    </DensityProvider>
  );
```

- [ ] **Step 3: Regression gate — tenant shell + impersonation + routes.** Run:
```bash
pnpm exec vitest run src/litellm-portal/tenant-portal/shell.test.tsx src/litellm-portal/tenant-portal/shell-impersonation.test.tsx src/litellm-portal/tenant-portal/routes.test.tsx
```
Expected: ALL pass (test files unmodified). If ANY fails, STOP and report full output — your migration broke the tenant behaviour/impersonation/SSR contract. Do NOT edit any test.

- [ ] **Step 4: Typecheck.** §5 command. Expected: `TENANT SHELL TYPECHECK CLEAN`.

- [ ] **Step 5: Broader regression.** Run:
```bash
pnpm exec vitest run src/litellm-portal/ui src/litellm-portal/tenant-portal src/litellm-portal/router.test.tsx src/litellm-portal/hydration.test.tsx
```
Expected: ALL pass (ui 31 incl. preHeader-invariant + style-forwarding + tenant suite + router + hydration). If any fail, STOP and report.

- [ ] **Step 6: Commit.**
```bash
git add src/litellm-portal/tenant-portal/shell.tsx
git commit -m "refactor(litellm-portal): migrate TenantPortalShell non-owner variant to PageShell (S2)"
```

---

## Task 2: Verification (no commit)

- [ ] **Step 1:** `pnpm exec vitest run src/litellm-portal/tenant-portal/shell.test.tsx src/litellm-portal/tenant-portal/shell-impersonation.test.tsx` → all pass; confirm both test files unmodified (`git diff` shows no test change).
- [ ] **Step 2:** §5 TYPECHECK PROTOCOL → `TENANT SHELL TYPECHECK CLEAN`.
- [ ] **Step 3:** `pnpm exec vitest run src/litellm-portal/ui` → 31 passed.
- [ ] **Step 4:** `git diff --name-only HEAD~1 HEAD` → exactly `src/litellm-portal/tenant-portal/shell.tsx`. Report it + `git log --oneline -1`.

**DoD:** TenantPortalShell non-owner variant renders via `<PageShell>` (id/brand-style/DensityProvider/impersonation/SSR-fallback all preserved); owner variant bespoke unchanged; tenant shell + impersonation + routes tests green unmodified (behaviour/impersonation/SSR proven preserved by evidence + the Plan-9 tested preHeader-placement invariant); ui 31 + router + hydration green; tsc clean; 1 commit; only `tenant-portal/shell.tsx` changed. **Audit S2: both top-level sidebar shells (Ops + Tenant) now unified on PageShell.**

## Out of scope (documented exclusions, review may override)
Tenant **owner variant** (`max-w-5xl`, no nav, OwnerOpsEntry) intentionally bespoke — a legitimately different layout, like __root landing. `routes/manage/route.lazy.tsx` (nested sub-layout) + `__root.tsx` (sidebar-less landing) excluded. Screen archetypes / S7 God-Component decomposition → separate plans.
