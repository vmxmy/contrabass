# LiteLLM Portal — Plan-9：PageShell 增加 preHeader 槽（解锁 tenant 非-owner 迁移，含放置不变量单测）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development / executing-plans. Steps use `- [ ]`.

**Goal:** 给 `PageShell` 增加可选 `preHeader` 槽：渲染在根元素内、**header band 之前、`flex flex-1`(nav/main)之外**的全宽区域(无 chrome)。这让 tenant 的前置 `ImpersonationBanner`(role=alert,载荷性) + `BrandSummaryBar` 能以正确的全宽位置进入 PageShell。新增测试**断言 preHeader 的 DOM 放置不变量** —— 把"impersonation banner 迁移后位置是否正确"从视觉问题变成**已测试的结构不变量**。

**Architecture（已记录的判定，PR review 可否决）:** 增加 `preHeader` 槽是与 `header`/`style` 同类的、惯例的、最低风险的薄增量。判定:preHeader 是根的直接子节点,顺序在 header band 之前,且**不**被包进 header band 的 `border-b px-6 py-4` chrome,也**不**在 nav/main 的 `flex flex-1` 内。纯增量、向后兼容(可选,现有 28 测试不变)。

**Tech Stack:** React, TS strict, Vitest + @testing-library/react (happy-dom), pnpm。

---

## Instructions for the implementing agent (Kimi) — read fully before Task 1

1. **Scope lock.** Modify ONLY `src/litellm-portal/ui/page-shell.tsx` and `src/litellm-portal/ui/page-shell.test.tsx`. Nothing else.
2. **Backward compatible.** `preHeader` is OPTIONAL. The existing 7 PageShell tests MUST stay green unchanged (never modify them). Only APPEND new tests.
3. **Verbatim.** Apply OLD→NEW exactly. No reformat, no `any`, no `@ts-ignore`. If OLD not found verbatim, STOP and report.
4. **TDD order mandatory:** append new tests → run → new ones FAIL → implement → all green.
5. **TYPECHECK PROTOCOL.** When a step says "Typecheck", run EXACTLY:
   ```bash
   bunx tsc --noEmit -p tsconfig.json 2>&1 | grep -E "error TS" | grep -vE "TS6142|server\.ts\(6,33\)" | grep "litellm-portal/ui/" || echo "UI TYPECHECK CLEAN"
   ```
   Expected: single line `UI TYPECHECK CLEAN`. Bare `TS6142` is NEVER a stop reason.
6. **STOP rule.** Any output ≠ Expected → STOP, report step + full output, do not continue.
7. **One commit per task**, scope `litellm-portal`, exact message. Never push / rebase / amend / switch branches.
8. **Working directory** for every command: `/Users/xumingyang/github/contrabass/cloud`.

---

## Task 1: Append preHeader placement-invariant tests (TDD red)

**Files:** Modify `src/litellm-portal/ui/page-shell.test.tsx`

- [ ] **Step 1: Append.** Add EXACTLY this block at the END of `src/litellm-portal/ui/page-shell.test.tsx` (after the final `});`):

```tsx
describe("PageShell — preHeader slot (tenant impersonation/summary placement)", () => {
  it("renders preHeader content before the header band and OUTSIDE nav/main", () => {
    const { container } = render(
      <PageShell
        preHeader={<div data-testid="pre">PRE</div>}
        header={<span>brand</span>}
        nav={<aside data-testid="nav" />}
      >
        <p data-testid="body">body</p>
      </PageShell>,
    );
    const root = container.querySelector("[data-page-shell]") as HTMLElement;
    const pre = container.querySelector("[data-page-shell-preheader]") as HTMLElement;
    const band = container.querySelector("[data-page-shell-header]") as HTMLElement;
    const flex = container.querySelector("[data-page-shell-body]") as HTMLElement;
    // present + is a direct child of root
    expect(pre).not.toBeNull();
    expect(pre.parentElement).toBe(root);
    // NOT wrapped in the header band chrome
    expect(pre.closest("[data-page-shell-header]")).toBeNull();
    // NOT inside the nav/main flex container
    expect(pre.closest("[data-page-shell-body]")).toBeNull();
    // DOM order: preHeader comes before the header band, which comes before body flex
    const kids = Array.from(root.children);
    expect(kids.indexOf(pre)).toBeLessThan(kids.indexOf(band));
    expect(kids.indexOf(band)).toBeLessThan(kids.indexOf(flex));
    expect(screen.getByTestId("pre")).toBeTruthy();
  });

  it("omits the preHeader region entirely when not provided (backward compatible)", () => {
    const { container } = render(
      <PageShell header={<span>h</span>} nav={<aside />}>x</PageShell>,
    );
    expect(container.querySelector("[data-page-shell-preheader]")).toBeNull();
  });

  it("supports preHeader with NO header band (tenant non-owner has banner+summary, header optional)", () => {
    const { container } = render(
      <PageShell preHeader={<div data-testid="pre2" />} nav={<aside />}>x</PageShell>,
    );
    expect(container.querySelector("[data-page-shell-preheader]")).not.toBeNull();
    expect(container.querySelector("[data-page-shell-header]")).toBeNull();
  });
});
```

- [ ] **Step 2: Run — expect new tests FAIL.** Run:
```bash
pnpm exec vitest run src/litellm-portal/ui/page-shell.test.tsx
```
Expected: the 7 ORIGINAL tests PASS; the 3 NEW tests FAIL (no preHeader / no `data-page-shell-preheader` / no `data-page-shell-body` yet). If new tests already pass, STOP and report. If any original fails, STOP and report.

- [ ] **Step 3: Commit red.**
```bash
git add src/litellm-portal/ui/page-shell.test.tsx
git commit -m "test(litellm-portal): add PageShell preHeader placement specs (red)"
```

---

## Task 2: Implement preHeader (TDD green)

**Files:** Modify `src/litellm-portal/ui/page-shell.tsx`

- [ ] **Step 1: Add `preHeader` to the props type.** Replace EXACTLY:
```tsx
  /** The fully-formed navigation element (the shell supplies its own SideNav). */
  nav: React.ReactNode;
  /** Optional id forwarded to the root (e.g. shell anchors / test selectors). */
  id?: string;
```
with EXACTLY:
```tsx
  /** The fully-formed navigation element (the shell supplies its own SideNav). */
  nav: React.ReactNode;
  /**
   * Optional full-width region rendered BEFORE the header band and OUTSIDE the
   * nav/main flex (no chrome). For tenant's ImpersonationBanner + BrandSummaryBar.
   */
  preHeader?: React.ReactNode;
  /** Optional id forwarded to the root (e.g. shell anchors / test selectors). */
  id?: string;
```

- [ ] **Step 2: Destructure `preHeader`.** Replace EXACTLY:
```tsx
export function PageShell({
  header,
  nav,
  id,
  style,
  className,
  children,
}: PageShellProps): React.ReactElement {
```
with EXACTLY:
```tsx
export function PageShell({
  header,
  nav,
  preHeader,
  id,
  style,
  className,
  children,
}: PageShellProps): React.ReactElement {
```

- [ ] **Step 3: Render preHeader + tag the body flex.** Replace EXACTLY:
```tsx
      {header !== undefined ? (
        <div className={HEADER} data-page-shell-header>
          {header}
        </div>
      ) : null}
      <div className="flex flex-1">
        {nav}
        <main className={MAIN} data-page-shell-main>
          {children}
        </main>
      </div>
```
with EXACTLY:
```tsx
      {preHeader !== undefined ? (
        <div data-page-shell-preheader>{preHeader}</div>
      ) : null}
      {header !== undefined ? (
        <div className={HEADER} data-page-shell-header>
          {header}
        </div>
      ) : null}
      <div className="flex flex-1" data-page-shell-body>
        {nav}
        <main className={MAIN} data-page-shell-main>
          {children}
        </main>
      </div>
```

- [ ] **Step 4: Run — expect all green.** Run:
```bash
pnpm exec vitest run src/litellm-portal/ui/page-shell.test.tsx
```
Expected: ALL 10 tests pass (7 original unchanged + 3 new). If any original fails, STOP and report (do NOT modify originals). If a new test fails, fix only page-shell.tsx per the plan; if you cannot, STOP and report.

- [ ] **Step 5: Typecheck.** §5 command. Expected: `UI TYPECHECK CLEAN`.

- [ ] **Step 6: Full seam suite.** Run:
```bash
pnpm exec vitest run src/litellm-portal/ui
```
Expected: all pass (28 prior + 3 new = 31). If any fail, STOP and report.

- [ ] **Step 7: Commit.**
```bash
git add src/litellm-portal/ui/page-shell.tsx
git commit -m "feat(litellm-portal): add PageShell preHeader slot (full-width, pre-band)"
```

---

## Task 3: Verification (no commit)

- [ ] **Step 1:** `pnpm exec vitest run src/litellm-portal/ui/page-shell.test.tsx` → 10 passed (7 original + 3 new).
- [ ] **Step 2:** `pnpm exec vitest run src/litellm-portal/ui` → 31 passed.
- [ ] **Step 3:** §5 TYPECHECK PROTOCOL → `UI TYPECHECK CLEAN`.
- [ ] **Step 4:** `git log --oneline -2` (red + impl). Confirm only `page-shell.tsx` + `page-shell.test.tsx` changed.

**DoD:** PageShell has an optional `preHeader` rendered before the header band, outside nav/main; 7 originals green (backward compat); 3 new placement-invariant tests green (impersonation/summary placement is now a TESTED structural invariant — no visual-QA dependency); ui suite 31; tsc clean; 2 commits. tenant non-owner migration unblocked with an evidenced gate.

## Out of scope
Migrating tenant non-owner variant to PageShell → next plan (Plan-10): owner variant (`max-w-5xl`, no nav) stays bespoke (documented exclusion, like __root landing). manage sub-layout / __root landing excluded. S7 / archetypes separate.
