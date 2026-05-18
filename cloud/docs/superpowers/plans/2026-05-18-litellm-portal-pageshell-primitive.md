# LiteLLM Portal — Plan-7：PageShell 外壳 chrome 原语（审计 S2，原语阶段）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development / executing-plans. Steps use `- [ ]`.

**Goal:** 抽出薄表现层原语 `<PageShell>`（统一 header band / 内容区 padding / 背景 / 宽度 token）放进 `src/litellm-portal/ui/`，为后续 3 个带侧栏外壳（tenant 常规变体 / ops / manage）的 chrome 收敛提供唯一答案。**本 plan 只建原语 + 测试，不迁移任何 shell**（与 Plan-1 PanelCard 同节奏：先建缝，再分批迁移）。

**Architecture（含已记录的设计判定，供 review 推翻）:**
审计 S2 指出 4 套外壳 chrome 不一致。设计判定（**显式假设，PR review 可否决**）：
- `__root.tsx` 着陆页（居中、**无侧栏**、品牌大标题）是**有意不同**的独立界面 → **排除**，不并入。
- `tenant-portal/shell.tsx` 的 pure-Owner `max-w-5xl` 变体是**有意**的窄栏 → 保留，不并入。
- 其余 3 个带侧栏外壳（tenant 常规变体 / ops / manage）的内容区 token 漂移（`px-6 py-8` vs `py-10`、header 有/无、`space-y-8` 不一致）是**意外噪音** → 由 `<PageShell>` 统一。
PageShell 是**纯表现层薄壳**：只渲染「可选 header band + 侧栏槽 + 内容区」骨架。**不含**任何 SSR/#418/impersonation/identity 逻辑——这些继续留在各 shell 内、包在 PageShell 外（与 PanelCard 不碰 panel-state 同理）。token 基准取自当前 ops shell（最干净的 header+sidebar 实例）。

**Tech Stack:** React, TS strict（kebab-case、named export、explicit return types、no `any`）, Vitest + @testing-library/react (happy-dom), pnpm。

---

## Instructions for the implementing agent (Kimi) — read fully before Task 1

1. **Scope lock.** Create ONLY `src/litellm-portal/ui/page-shell.tsx` and `src/litellm-portal/ui/page-shell.test.tsx`; modify ONLY `src/litellm-portal/ui/index.ts`. Never modify any shell, `panel-card.tsx`, `ratchet*`, `panel-state.tsx`, `density.tsx`.
2. **Pure additive.** New files only + one export line. Zero behaviour change to any existing rendered page (no shell is migrated in this plan).
3. **Verbatim.** Copy code blocks exactly. No reformat, no `any`, no `@ts-ignore`, no console.log. If an OLD block isn't found verbatim, STOP and report.
4. **TDD order mandatory:** write test → run → see it FAIL for the stated reason → implement → run → see PASS.
5. **TYPECHECK PROTOCOL.** When a step says "Typecheck", run EXACTLY:
   ```bash
   bunx tsc --noEmit -p tsconfig.json 2>&1 | grep -E "error TS" | grep -vE "TS6142|server\.ts\(6,33\)" | grep "litellm-portal/ui/" || echo "UI TYPECHECK CLEAN"
   ```
   Expected: single line `UI TYPECHECK CLEAN`. A bare `TS6142` is NEVER a stop reason. Any other `ui/` error → STOP and report.
6. **STOP rule.** Any output ≠ Expected → STOP, report step + full output, do not continue.
7. **One commit per task**, scope `litellm-portal`, exact message. Never push / rebase / amend / switch branches.
8. **Working directory** for every command: `/Users/xumingyang/github/contrabass/cloud`.

---

## Task 1: Write the failing PageShell spec (TDD red)

**Files:** Create `src/litellm-portal/ui/page-shell.test.tsx`

- [ ] **Step 1: Write the test.** Create `src/litellm-portal/ui/page-shell.test.tsx` with EXACTLY:

```tsx
/**
 * @vitest-environment happy-dom
 */
import React from "react";
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { PageShell } from "./page-shell";

afterEach(cleanup);

describe("PageShell — unified surface chrome (S2)", () => {
  it("renders the canvas wrapper, the nav slot and the main content region", () => {
    const { container } = render(
      <PageShell nav={<aside data-testid="nav">N</aside>}>
        <p>body-content</p>
      </PageShell>,
    );
    const root = container.querySelector("[data-page-shell]") as HTMLElement;
    expect(root).not.toBeNull();
    expect(root.className).toContain("min-h-screen");
    expect(root.className).toContain("bg-kumo-canvas");
    expect(screen.getByTestId("nav")).toBeTruthy();
    const main = container.querySelector("[data-page-shell-main]") as HTMLElement;
    expect(main.tagName).toBe("MAIN");
    expect(main.className).toContain("px-6");
    expect(main.className).toContain("py-8");
    expect(screen.getByText("body-content")).toBeTruthy();
  });

  it("omits the header band when no header prop is given (manage stays header-less)", () => {
    const { container } = render(
      <PageShell nav={<aside />}>x</PageShell>,
    );
    expect(container.querySelector("[data-page-shell-header]")).toBeNull();
  });

  it("renders the header band with the unified token set when header is given", () => {
    const { container } = render(
      <PageShell header={<span>brand</span>} nav={<aside />}>
        x
      </PageShell>,
    );
    const header = container.querySelector("[data-page-shell-header]") as HTMLElement;
    expect(header).not.toBeNull();
    expect(header.className).toContain("border-b");
    expect(header.className).toContain("bg-kumo-elevated");
    expect(screen.getByText("brand")).toBeTruthy();
  });

  it("emits a stable token contract (the S2 chrome matrix) so the 3 sidebar shells converge", () => {
    const { container } = render(<PageShell nav={<aside />}>x</PageShell>);
    const root = container.querySelector("[data-page-shell]") as HTMLElement;
    const main = container.querySelector("[data-page-shell-main]") as HTMLElement;
    // canonical tokens taken from the ops shell (cleanest header+sidebar)
    expect(root.className).toBe(
      "flex min-h-screen flex-col bg-kumo-canvas text-kumo-default",
    );
    expect(main.className).toBe(
      "min-w-0 flex-1 px-6 py-8 opacity-100 motion-safe:transition-opacity motion-safe:duration-150",
    );
  });
});
```

- [ ] **Step 2: Run — expect FAIL.** Run:
```bash
pnpm exec vitest run src/litellm-portal/ui/page-shell.test.tsx
```
Expected: FAIL — cannot resolve `./page-shell`. If it PASSES, STOP and report.

---

## Task 2: Implement PageShell (TDD green) + export

**Files:** Create `src/litellm-portal/ui/page-shell.tsx`; Modify `src/litellm-portal/ui/index.ts`

- [ ] **Step 1: Create the component.** Create `src/litellm-portal/ui/page-shell.tsx` with EXACTLY:

```tsx
/**
 * PageShell — the ONE surface-chrome primitive for the LiteLLM Portal (UI seam).
 *
 * Closes audit S2 (4 divergent shells / supplementary evidence B). It is a
 * THIN PRESENTATIONAL wrapper: canvas wrapper + optional header band + nav slot
 * + unified content region. It carries NO SSR/#418/impersonation/identity
 * logic — each shell keeps that and composes PageShell inside its own gating
 * (mirrors PanelCard not owning panel-state).
 *
 * Documented design decisions (overridable in review):
 *  - The `/` landing (__root.tsx, centered, sidebar-less) is intentionally a
 *    different surface and is NOT migrated to PageShell.
 *  - The tenant pure-Owner `max-w-5xl` variant is intentional and stays.
 *  - The 3 sidebar-bearing shells (tenant normal / ops / manage) have
 *    ACCIDENTAL content-token drift; PageShell is their single answer. `header`
 *    is optional so `manage` keeps its intentional header-less layout.
 *
 * Canonical tokens are taken verbatim from the current ops shell (the cleanest
 * existing header+sidebar instance) so migration is a behaviour-preserving swap.
 */
import React from "react";

export type PageShellProps = {
  /** Optional brand/status band. Omit for an intentionally header-less surface. */
  header?: React.ReactNode;
  /** The fully-formed navigation element (the shell supplies its own SideNav). */
  nav: React.ReactNode;
  children: React.ReactNode;
};

const ROOT = "flex min-h-screen flex-col bg-kumo-canvas text-kumo-default";
const HEADER =
  "flex items-center gap-3 border-b border-kumo-line bg-kumo-elevated px-6 py-4";
const MAIN =
  "min-w-0 flex-1 px-6 py-8 opacity-100 motion-safe:transition-opacity motion-safe:duration-150";

export function PageShell({
  header,
  nav,
  children,
}: PageShellProps): React.ReactElement {
  return (
    <div className={ROOT} data-page-shell>
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
    </div>
  );
}
```

- [ ] **Step 2: Export from the seam barrel.** In `src/litellm-portal/ui/index.ts`, append EXACTLY these two lines at the end of the file:
```ts
export { PageShell } from "./page-shell";
export type { PageShellProps } from "./page-shell";
```

- [ ] **Step 3: Run — expect all green.** Run:
```bash
pnpm exec vitest run src/litellm-portal/ui/page-shell.test.tsx
```
Expected: PASS, 4 tests passed. If any FAIL, STOP and report.

- [ ] **Step 4: Typecheck.** §5 command. Expected: `UI TYPECHECK CLEAN`.

- [ ] **Step 5: Full seam suite (no regression).** Run:
```bash
pnpm exec vitest run src/litellm-portal/ui
```
Expected: all pass (21 prior + 4 new = 25). If any fail, STOP and report.

- [ ] **Step 6: Commit.**
```bash
git add src/litellm-portal/ui/page-shell.tsx src/litellm-portal/ui/page-shell.test.tsx src/litellm-portal/ui/index.ts
git commit -m "feat(litellm-portal): add PageShell surface-chrome seam primitive (S2)"
```

---

## Task 3: Verification (no commit)

- [ ] **Step 1:** `pnpm exec vitest run src/litellm-portal/ui` → 25 passed.
- [ ] **Step 2:** §5 TYPECHECK PROTOCOL → `UI TYPECHECK CLEAN`.
- [ ] **Step 3:** `git diff --name-only HEAD~1 HEAD` → exactly `page-shell.tsx`, `page-shell.test.tsx`, `index.ts`. Report it.

**DoD:** `<PageShell>` exists in the seam, exported, 4 tests green, ui suite 25 green, tsc clean, 1 commit, zero behaviour change (no shell migrated yet).

## Out of scope (next plans)
Migrating tenant-normal / ops / manage shells' outer chrome to `<PageShell>` (each: existing shell tests green = logic preserved + the chrome-matrix test = unification proven). __root landing + tenant pure-Owner variant intentionally excluded (documented above). S7 God-Component decomposition / archetypes → separate.
