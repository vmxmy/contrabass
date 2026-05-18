# LiteLLM Portal — Plan-6：SideNav 响应式抽屉（审计 S1 🔴 Blocker）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development / executing-plans. Steps use `- [ ]`.

**Goal:** 关闭审计 S1 🔴：SideNav 固定 `w-56`、零响应式断点、窄屏破版。改为：md+ 维持现状静态侧栏（**桌面行为完全不变**），<md 变为带汉堡按钮的离屏抽屉（transform 滑入，非 display:none）。自包含在 `components/side-nav.tsx`，**不改任何 shell**。

**Architecture:** 关键约束 = 现有 `side-nav.test.tsx` 6 个测试断言的是 DOM 存在性（aria-current / `[data-active-accent-bar]` / `focus-visible:ring-kumo-brand` & `hover:bg-kumo-tint` 类 / 分组标题文本 / `[data-nav-icon]`×3），**没有**断言宽度或可见性。因此：保持 `<nav>` 及其全部 links/headings/icons 原样在 DOM，仅用 CSS `transform`（`-translate-x-full md:translate-x-0`）做移动端离屏（transform 不像 `display:none` 那样移出可达性树/DOM 查询）→ 6 个测试**全部保持绿 = 行为保持的证据**。新增汉堡按钮 + 本地 `useState` 开合（无 shell 接线）。SSR/#418 安全：`useState(false)` 在服务端与客户端首渲一致。新增抽屉开合行为的测试 = 新行为的证据。

**Tech Stack:** React, TS strict, Vitest + @testing-library/react (happy-dom), pnpm。

---

## Instructions for the implementing agent (Kimi) — read fully before Task 1

1. **Scope lock.** ONLY `src/litellm-portal/components/side-nav.tsx` and `src/litellm-portal/components/side-nav.test.tsx`. Never touch any shell, `ui/*`, or other file.
2. **Verbatim.** Apply OLD→NEW exactly. No reformat, no `any`, no `@ts-ignore`. If OLD not found verbatim, STOP and report with the actual file region.
3. **Regression contract (non-negotiable).** The 6 EXISTING tests in `side-nav.test.tsx` MUST stay green unchanged — they are the proof desktop behaviour is preserved. You ADD new tests; you do NOT modify or delete any existing test. If an existing test fails after your change, your implementation is wrong → STOP and report (do NOT edit the test to make it pass).
4. **TYPECHECK PROTOCOL.** When a step says "Typecheck", run EXACTLY:
   ```bash
   bunx tsc --noEmit -p tsconfig.json 2>&1 | grep -E "error TS" | grep -vE "TS6142|server\.ts\(6,33\)" | grep "litellm-portal/components/side-nav" || echo "SIDENAV TYPECHECK CLEAN"
   ```
   Expected: single line `SIDENAV TYPECHECK CLEAN`. A bare `TS6142` is NEVER a stop reason. Any other error line → STOP and report.
5. **STOP rule.** Any output ≠ Expected → STOP, report step + full output, do not continue.
6. **Commits:** exactly the commits the tasks specify, scope `litellm-portal`. Never push / rebase / amend / switch branches.
7. **Working directory** for every command: `/Users/xumingyang/github/contrabass/cloud`.

---

## Task 1: Add new drawer-behaviour tests FIRST (TDD red)

**Files:** Modify `src/litellm-portal/components/side-nav.test.tsx`

- [ ] **Step 1: Append new tests.** Add EXACTLY this block at the END of `src/litellm-portal/components/side-nav.test.tsx` (after the final `});` that closes the `describe`, on a new line):

```tsx
describe("SideNav responsive drawer (S1)", () => {
  it("renders a mobile menu toggle button that is hidden on md+ and starts collapsed", () => {
    renderNav("/");
    const toggle = screen.getByRole("button", { name: "打开导航菜单" });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(toggle.className).toContain("md:hidden");
  });

  it("toggles aria-expanded and the nav's translate state when clicked", async () => {
    const { container } = renderNav("/");
    const toggle = screen.getByRole("button", { name: "打开导航菜单" });
    const nav = container.querySelector("nav") as HTMLElement;
    expect(nav.className).toContain("-translate-x-full");
    expect(nav.className).toContain("md:translate-x-0");
    toggle.click();
    expect(
      screen.getByRole("button", { name: "关闭导航菜单" }).getAttribute("aria-expanded"),
    ).toBe("true");
    expect(nav.className).toContain("max-md:translate-x-0");
  });

  it("keeps every nav link/heading/icon in the DOM regardless of drawer state (desktop unaffected)", () => {
    const { container } = renderNav("/usage");
    // identical guarantees to the existing contract — proves no DOM removal
    expect(screen.getByRole("link", { current: "page" }).getAttribute("href")).toBe("/usage");
    expect(screen.getByText("我的")).toBeTruthy();
    expect(container.querySelectorAll("[data-nav-icon]").length).toBe(3);
    expect(screen.getByRole("link", { name: /概览/ })).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run — expect FAIL (red).** Run:
```bash
pnpm exec vitest run src/litellm-portal/components/side-nav.test.tsx
```
Expected: the 6 ORIGINAL tests PASS; the 3 NEW tests FAIL (no toggle button / no translate classes yet). If the new tests already pass, STOP and report (the implementation must not exist yet). If any ORIGINAL test fails, STOP and report.

- [ ] **Step 3: Commit the red tests.**
```bash
git add src/litellm-portal/components/side-nav.test.tsx
git commit -m "test(litellm-portal): add SideNav responsive drawer specs (red)"
```

---

## Task 2: Implement the responsive drawer (green)

**Files:** Modify `src/litellm-portal/components/side-nav.tsx`

- [ ] **Step 1: Replace the component body.** Replace EXACTLY this block:
```tsx
  // Both accents resolve through --kumo-brand (the shell sets it: tenant brand
  // or OPS_STEEL_ACCENT steel). The accent bar uses bg-kumo-brand either way;
  // `accent` exists for explicitness/testing, not a second color path.
  return (
    <nav aria-label={ariaLabel} className="w-56 shrink-0 border-r border-kumo-line bg-kumo-elevated px-3 py-6">
      <div className="space-y-6">
```
with EXACTLY:
```tsx
  // Both accents resolve through --kumo-brand (the shell sets it: tenant brand
  // or OPS_STEEL_ACCENT steel). The accent bar uses bg-kumo-brand either way;
  // `accent` exists for explicitness/testing, not a second color path.
  //
  // S1 responsive: md+ keeps the original static rail unchanged (no shell
  // wiring). Below md the nav is an off-canvas drawer toggled by a local
  // hamburger — CSS transform only (NOT display:none) so every link/heading/
  // icon stays in the DOM and the existing a11y/test contract is preserved.
  // useState(false) is deterministic on SSR + client first render (#418-safe).
  const [open, setOpen] = React.useState(false);
  return (
    <>
      <button
        type="button"
        aria-expanded={open}
        aria-controls="side-nav-drawer"
        aria-label={open ? "关闭导航菜单" : "打开导航菜单"}
        onClick={() => setOpen((v) => !v)}
        className={`fixed left-3 top-3 z-50 inline-flex h-9 w-9 items-center justify-center rounded-md border border-kumo-line bg-kumo-elevated text-kumo-strong md:hidden ${FOCUS_RING}`}
      >
        <span aria-hidden="true" className="text-lg leading-none">{open ? "✕" : "☰"}</span>
      </button>
      {open ? (
        <button
          type="button"
          aria-hidden="true"
          tabIndex={-1}
          onClick={() => setOpen(false)}
          className="fixed inset-0 z-30 bg-black/40 md:hidden"
        />
      ) : null}
      <nav
        id="side-nav-drawer"
        aria-label={ariaLabel}
        className={`fixed inset-y-0 left-0 z-40 w-56 shrink-0 overflow-y-auto border-r border-kumo-line bg-kumo-elevated px-3 py-6 transition-transform duration-200 -translate-x-full md:static md:z-auto md:translate-x-0 md:transition-none ${
          open ? "max-md:translate-x-0" : ""
        }`}
      >
        <div className="space-y-6">
```

- [ ] **Step 2: Close the new fragment.** Replace EXACTLY this block (the end of the component):
```tsx
        ))}
      </div>
    </nav>
  );
}
```
with EXACTLY:
```tsx
        ))}
        </div>
      </nav>
    </>
  );
}
```

- [ ] **Step 3: Run — expect all green.** Run:
```bash
pnpm exec vitest run src/litellm-portal/components/side-nav.test.tsx
```
Expected: ALL 9 tests pass (6 original + 3 new). If any ORIGINAL test fails, your implementation broke the contract → STOP and report (do NOT modify the tests). If a NEW test fails, fix only `side-nav.tsx` per the plan and report if you cannot.

- [ ] **Step 4: Typecheck.** §4 command. Expected: `SIDENAV TYPECHECK CLEAN`.

- [ ] **Step 5: Broader regression gate.** Run:
```bash
pnpm exec vitest run src/litellm-portal/ui src/litellm-portal/router.test.tsx src/litellm-portal/hydration.test.tsx
```
Expected: ALL pass (the shells render SideNav; this proves no shell regression). If any fail, STOP and report full output.

- [ ] **Step 6: Commit.**
```bash
git add src/litellm-portal/components/side-nav.tsx
git commit -m "fix(litellm-portal): SideNav responsive off-canvas drawer below md (S1)"
```

---

## Task 3: Verification (no commit)

- [ ] **Step 1:** `pnpm exec vitest run src/litellm-portal/components/side-nav.test.tsx` → 9 passed (6 original unchanged + 3 new).
- [ ] **Step 2:** §4 TYPECHECK PROTOCOL → `SIDENAV TYPECHECK CLEAN`.
- [ ] **Step 3:** `pnpm exec vitest run src/litellm-portal/ui` → 21 passed (seam suite unaffected).
- [ ] **Step 4:** `git log --oneline -2` → the red-tests commit + the implementation commit. Confirm only `side-nav.tsx` + `side-nav.test.tsx` changed vs the batch start.

**DoD:** SideNav is an off-canvas drawer below `md` with an accessible hamburger toggle; md+ desktop rail unchanged; all 6 original tests green (desktop behaviour preserved by evidence) + 3 new drawer tests green; tsc clean; ui/router/hydration suites green; 2 commits; no shell touched. Audit S1 🔴 closed.

## Out of scope
PageShell consolidation (S2) / screen archetypes / S7 God-Component full decomposition (ViewModel extraction) → separate plans; those require behavioural test redesign + runtime/visual QA beyond this contained, test-preserving change.
