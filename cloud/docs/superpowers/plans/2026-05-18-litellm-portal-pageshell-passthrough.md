# LiteLLM Portal — Plan-7b：PageShell 增加 id/style/className 透传（为 shell 迁移解锁，含 steel-accent 回归断言）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development / executing-plans. Steps use `- [ ]`.

**Goal:** 给 `PageShell` 增加可选 `id` / `style` / `className` 透传到根元素，使带侧栏的 shell 可直接用 PageShell 作根（保留 `id="ops-console-shell-root"`、`style={OPS_STEEL_ACCENT}` 等载荷性属性）。新增测试**显式断言这些属性被转发** —— 把"Ops steel-accent 迁移后是否保留"从不可单测的视觉问题变成**已测试的不变量**。

**Architecture（已记录的设计判定，PR review 可否决）:** 表现层原语接受 `id/style/className` 透传是**业界惯例、最低风险**的选择（对比:让 PageShell 吞掉 DensityProvider/identity 才是高风险）。判定:PageShell 只透传这三者到根 div;`DensityProvider`(纯 context、无 DOM)由 shell 包在 PageShell 外;`!isOwner` 等 gating 仍是 shell 内的早返回。纯增量、向后兼容(三者均可选,现有 25 测试不变)。

**Tech Stack:** React, TS strict, Vitest + @testing-library/react (happy-dom), pnpm。

---

## Instructions for the implementing agent (Kimi) — read fully before Task 1

1. **Scope lock.** Modify ONLY `src/litellm-portal/ui/page-shell.tsx` and `src/litellm-portal/ui/page-shell.test.tsx`. Nothing else.
2. **Backward compatible.** The 3 new props are OPTIONAL. The existing 4 PageShell tests MUST stay green unchanged (do not modify them). You only APPEND new tests.
3. **Verbatim.** Apply OLD→NEW exactly. No reformat, no `any`, no `@ts-ignore`. If OLD not found verbatim, STOP and report.
4. **TDD order mandatory:** append new tests → run → see new ones FAIL → implement → run → all green.
5. **TYPECHECK PROTOCOL.** When a step says "Typecheck", run EXACTLY:
   ```bash
   bunx tsc --noEmit -p tsconfig.json 2>&1 | grep -E "error TS" | grep -vE "TS6142|server\.ts\(6,33\)" | grep "litellm-portal/ui/" || echo "UI TYPECHECK CLEAN"
   ```
   Expected: single line `UI TYPECHECK CLEAN`. Bare `TS6142` is NEVER a stop reason.
6. **STOP rule.** Any output ≠ Expected → STOP, report step + full output, do not continue.
7. **One commit per task**, scope `litellm-portal`, exact message. Never push / rebase / amend / switch branches.
8. **Working directory** for every command: `/Users/xumingyang/github/contrabass/cloud`.

---

## Task 1: Append passthrough tests (TDD red)

**Files:** Modify `src/litellm-portal/ui/page-shell.test.tsx`

- [ ] **Step 1: Append.** Add EXACTLY this block at the END of `src/litellm-portal/ui/page-shell.test.tsx` (after the final `});`):

```tsx
describe("PageShell — id/style/className passthrough (shell-migration unblock)", () => {
  it("forwards id and inline style to the root (preserves Ops steel accent / anchors)", () => {
    const { container } = render(
      <PageShell
        id="ops-console-shell-root"
        style={{ ["--kumo-brand" as string]: "#71717a" }}
        nav={<aside />}
      >
        x
      </PageShell>,
    );
    const root = container.querySelector("[data-page-shell]") as HTMLElement;
    expect(root.id).toBe("ops-console-shell-root");
    expect(root.style.getPropertyValue("--kumo-brand")).toBe("#71717a");
  });

  it("appends className to the canonical token set without replacing it", () => {
    const { container } = render(
      <PageShell className="extra-shell-class" nav={<aside />}>
        x
      </PageShell>,
    );
    const root = container.querySelector("[data-page-shell]") as HTMLElement;
    expect(root.className).toContain(
      "flex min-h-screen flex-col bg-kumo-canvas text-kumo-default",
    );
    expect(root.className).toContain("extra-shell-class");
  });

  it("still emits the exact canonical tokens when no passthrough is given (regression)", () => {
    const { container } = render(<PageShell nav={<aside />}>x</PageShell>);
    const root = container.querySelector("[data-page-shell]") as HTMLElement;
    expect(root.className).toBe(
      "flex min-h-screen flex-col bg-kumo-canvas text-kumo-default",
    );
    expect(root.id).toBe("");
  });
});
```

- [ ] **Step 2: Run — expect new tests FAIL.** Run:
```bash
pnpm exec vitest run src/litellm-portal/ui/page-shell.test.tsx
```
Expected: the 4 ORIGINAL tests PASS; the 3 NEW tests FAIL (props not supported yet). If new tests already pass, STOP and report. If any original fails, STOP and report.

- [ ] **Step 3: Commit red.**
```bash
git add src/litellm-portal/ui/page-shell.test.tsx
git commit -m "test(litellm-portal): add PageShell passthrough specs (red)"
```

---

## Task 2: Implement passthrough (TDD green)

**Files:** Modify `src/litellm-portal/ui/page-shell.tsx`

- [ ] **Step 1: Extend the props type.** Replace EXACTLY:
```tsx
export type PageShellProps = {
  /** Optional brand/status band. Omit for an intentionally header-less surface. */
  header?: React.ReactNode;
  /** The fully-formed navigation element (the shell supplies its own SideNav). */
  nav: React.ReactNode;
  children: React.ReactNode;
};
```
with EXACTLY:
```tsx
export type PageShellProps = {
  /** Optional brand/status band. Omit for an intentionally header-less surface. */
  header?: React.ReactNode;
  /** The fully-formed navigation element (the shell supplies its own SideNav). */
  nav: React.ReactNode;
  /** Optional id forwarded to the root (e.g. shell anchors / test selectors). */
  id?: string;
  /** Optional inline style forwarded to the root (e.g. Ops OPS_STEEL_ACCENT). */
  style?: React.CSSProperties;
  /** Optional extra classes appended AFTER the canonical token set. */
  className?: string;
  children: React.ReactNode;
};
```

- [ ] **Step 2: Forward the props onto the root.** Replace EXACTLY:
```tsx
export function PageShell({
  header,
  nav,
  children,
}: PageShellProps): React.ReactElement {
  return (
    <div className={ROOT} data-page-shell>
```
with EXACTLY:
```tsx
export function PageShell({
  header,
  nav,
  id,
  style,
  className,
  children,
}: PageShellProps): React.ReactElement {
  return (
    <div
      className={className ? `${ROOT} ${className}` : ROOT}
      id={id}
      style={style}
      data-page-shell
    >
```

- [ ] **Step 3: Run — expect all green.** Run:
```bash
pnpm exec vitest run src/litellm-portal/ui/page-shell.test.tsx
```
Expected: ALL 7 tests pass (4 original unchanged + 3 new). If any original fails, STOP and report (do NOT modify the original tests). If a new test fails, fix only page-shell.tsx per the plan; if you cannot, STOP and report.

- [ ] **Step 4: Typecheck.** §5 command. Expected: `UI TYPECHECK CLEAN`.

- [ ] **Step 5: Full seam suite (no regression).** Run:
```bash
pnpm exec vitest run src/litellm-portal/ui
```
Expected: all pass (25 prior + 3 new = 28). If any fail, STOP and report.

- [ ] **Step 6: Commit.**
```bash
git add src/litellm-portal/ui/page-shell.tsx
git commit -m "feat(litellm-portal): PageShell forwards id/style/className to root"
```

---

## Task 3: Verification (no commit)

- [ ] **Step 1:** `pnpm exec vitest run src/litellm-portal/ui/page-shell.test.tsx` → 7 passed (4 original + 3 new).
- [ ] **Step 2:** `pnpm exec vitest run src/litellm-portal/ui` → 28 passed.
- [ ] **Step 3:** §5 TYPECHECK PROTOCOL → `UI TYPECHECK CLEAN`.
- [ ] **Step 4:** `git log --oneline -2` (red-tests + impl). Confirm only `page-shell.tsx` + `page-shell.test.tsx` changed.

**DoD:** PageShell accepts optional `id`/`style`/`className` forwarded to root; 4 original tests green (backward compat); 3 new passthrough tests green (steel-accent forwarding is now a TESTED invariant); ui suite 28 green; tsc clean; 2 commits. Shell migration is now unblocked with an evidenced regression gate.

## Out of scope
Actually migrating ops/manage/tenant shells to PageShell → next plan (Plan-8): each shell keeps its own DensityProvider (wraps PageShell), `!isOwner` early return, and SideNav construction; existing shell tests + the new style-forwarding test are the regression gate. __root landing + tenant pure-Owner variant intentionally excluded (documented in Plan-7).
