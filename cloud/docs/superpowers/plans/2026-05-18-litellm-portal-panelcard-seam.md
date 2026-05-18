# LiteLLM Portal — PanelCard 统一卡片原语 + 卡片 chrome 防回归棘轮 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the single canonical card component (`PanelCard`) for the LiteLLM Portal and a CI-enforced structural ratchet that prevents any new file from hand-writing card chrome — closing audit S3 / supplementary evidence A & C with zero behaviour change.

**Architecture:** Pure-additive Layer-2 "seam" package at `src/litellm-portal/ui/`. `PanelCard` inherits the *exact* chrome of the legacy `dashboard/components/panel.tsx` (so it is a consolidation, not a restyle), wires the already-present `DensityProvider` for body padding (closes S4 for cards), and renders the four canonical content states *inside* the card via the existing `panel-state` primitives (so screens stop hand-writing "header + state branch"). A vitest source-tree scanner + committed baseline file enforces "no new raw card chrome" inside the existing `vitest run` CI gate. No screens are migrated in this plan; migration is a follow-on plan.

**Tech Stack:** React 18, TypeScript (strict, kebab-case files, named exports, explicit return types, no `any`), `@cloudflare/kumo` ^2.1.0, Lingui i18n, Vitest + @testing-library/react (happy-dom for component tests, node for scanner tests), pnpm, husky. Build/verify gate: `pnpm exec tsc --noEmit` + `pnpm exec vitest run`.

---

## Instructions for the implementing agent (Kimi) — read fully before Task 1

These are **hard constraints**. Re-read this block before every task.

1. **Scope lock.** You may ONLY create/modify files explicitly listed in a task's **Files** block. Touching any other file = failure. In particular you MUST NOT modify `components/panel-state.tsx`, `components/density.tsx`, `components/side-nav.tsx`, `dashboard/components/panel.tsx`, any screen, any shell, any auth/role/impersonation/SSR file.
2. **No behaviour change.** This plan adds new files only. If a step seems to require editing an existing component, STOP and report — you have misread the step.
3. **Copy code verbatim.** Every code block is complete and final. Do not "improve", rename, reorder imports, or add features (no `any`, no `@ts-ignore`, no extra props, no console.log).
4. **Exact commands.** Run commands exactly as written, from `/Users/xumingyang/github/contrabass/cloud`. Compare output to the stated **Expected**.
5. **STOP rule.** If a command's output does not match **Expected** (e.g. a test PASSES when it must FAIL, or typecheck errors), STOP and report the full output. Do NOT continue to the next step. Do NOT "fix" by editing unrelated files.
6. **TDD order is mandatory.** Write the test → run it → see it FAIL for the stated reason → write code → run it → see it PASS. Never write implementation before its failing test.
7. **One commit per task**, conventional format, scope `litellm-portal`. Never `git rebase`, never `git push` (unless a step says to), never amend a prior commit.
8. **Working directory** for every command: `/Users/xumingyang/github/contrabass/cloud`.
9. **TYPECHECK PROTOCOL (overrides every step's tsc wording).** This repo's root `tsconfig.json` `include` is `["src/**/*.ts", ...]` and does NOT list `src/**/*.tsx`, so a raw `tsc --noEmit` emits a project-wide, pre-existing `TS6142` (`'--jsx' is not set`) for EVERY `.tsx` file — `app/`, `server.ts`, and any new `ui/` file. `TS6142` and the `server.ts(6,33)` line are KNOWN PRE-EXISTING NOISE, NOT real errors, and MUST be filtered. Whenever a step says "Typecheck", the command to run is EXACTLY:
   ```bash
   bunx tsc --noEmit -p tsconfig.json 2>&1 | grep -E "error TS" | grep -vE "TS6142|server\.ts\(6,33\)" | grep "litellm-portal/ui/" || echo "UI TYPECHECK CLEAN"
   ```
   Expected output: the single line `UI TYPECHECK CLEAN` (meaning zero REAL type errors in `src/litellm-portal/ui/`). Any OTHER output is a real `ui/` type error → STOP and report. A bare `TS6142` is NEVER a reason to stop.

---

## File Structure

| Path | Responsibility | Tasks |
|---|---|---|
| `src/litellm-portal/ui/panel-card.tsx` | The ONE card component + its public types | 1,2,3 |
| `src/litellm-portal/ui/panel-card.test.tsx` | TDD spec for PanelCard (happy-dom) | 1,2,3 |
| `src/litellm-portal/ui/index.ts` | Seam public barrel (the only path screens import) | 1 |
| `src/litellm-portal/ui/ratchet-scan.ts` | Pure fs scanner: find files with raw card chrome | 4 |
| `src/litellm-portal/ui/ratchet-scan.test.ts` | TDD spec for the scanner (node, temp fixtures) | 4 |
| `src/litellm-portal/ui/ratchet.test.ts` | Enforcement: scan ⊆ committed baseline (node) | 5 |
| `src/litellm-portal/ui/ratchet-baseline.json` | Committed grandfather list of existing offenders | 5 |

All paths are relative to `/Users/xumingyang/github/contrabass/cloud`.

---

## Task 1: PanelCard skeleton — ready state + header, and the seam barrel

**Files:**
- Create: `src/litellm-portal/ui/panel-card.tsx`
- Create: `src/litellm-portal/ui/index.ts`
- Test: `src/litellm-portal/ui/panel-card.test.tsx`

- [ ] **Step 1: Write the failing test**

Create `src/litellm-portal/ui/panel-card.test.tsx` with EXACTLY this content:

```tsx
/**
 * @vitest-environment happy-dom
 */
import React from "react";
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { I18nProvider } from "@lingui/react";
import { setupI18n } from "../i18n/setup";
import { DensityProvider } from "../components/density";
import { PanelCard } from "./panel-card";

const i18n = setupI18n("zh-CN");
const wrap = (ui: React.ReactElement) =>
  render(<I18nProvider i18n={i18n}>{ui}</I18nProvider>);
afterEach(cleanup);

describe("PanelCard — frame & header", () => {
  it("renders children inside the card body when state is ready (default)", () => {
    const { container } = wrap(
      <PanelCard title="API Keys">
        <p>hello-body</p>
      </PanelCard>,
    );
    expect(screen.getByText("hello-body")).toBeTruthy();
    expect(container.querySelector("[data-panel-card]")).not.toBeNull();
    expect(container.querySelector("[data-panel-card-body]")).not.toBeNull();
  });

  it("renders a header with the string title", () => {
    wrap(<PanelCard title="用量概览">x</PanelCard>);
    expect(screen.getByText("用量概览")).toBeTruthy();
  });

  it("omits the header entirely when no title/icon/actions are given", () => {
    const { container } = wrap(<PanelCard>only-body</PanelCard>);
    expect(container.querySelector("[data-panel-card-header]")).toBeNull();
    expect(screen.getByText("only-body")).toBeTruthy();
  });

  it("renders subtitle, icon and actions in the header", () => {
    wrap(
      <PanelCard
        title="标题"
        subtitle="副标题"
        icon={<svg data-testid="ic" />}
        actions={<button type="button">新建</button>}
      >
        b
      </PanelCard>,
    );
    expect(screen.getByText("副标题")).toBeTruthy();
    expect(screen.getByTestId("ic")).toBeTruthy();
    expect(screen.getByRole("button", { name: "新建" })).toBeTruthy();
  });

  it("uses the chrome inherited from the legacy Panel (rounded-xl + border-kumo-line + bg-kumo-base) and imposes NO outer margin", () => {
    const { container } = wrap(<PanelCard title="t">b</PanelCard>);
    const card = container.querySelector("[data-panel-card]") as HTMLElement;
    expect(card.className).toContain("rounded-xl");
    expect(card.className).toContain("border-kumo-line");
    expect(card.className).toContain("bg-kumo-base");
    expect(card.className).not.toMatch(/(^|\s)mb-\d/);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run:
```bash
pnpm exec vitest run src/litellm-portal/ui/panel-card.test.tsx
```
Expected: FAIL. Error mentions cannot resolve / find module `./panel-card` (the file does not exist yet). If it PASSES, STOP and report.

- [ ] **Step 3: Create the seam barrel**

Create `src/litellm-portal/ui/index.ts` with EXACTLY this content:

```ts
export { PanelCard } from "./panel-card";
export type { PanelCardProps, PanelCardState } from "./panel-card";
```

- [ ] **Step 4: Write the minimal implementation**

Create `src/litellm-portal/ui/panel-card.tsx` with EXACTLY this content:

```tsx
/**
 * The ONE card primitive for the LiteLLM Portal (UI seam, Layer-2).
 *
 * Replaces the 4 competing card implementations (audit S3 / supplementary
 * evidence A): Kumo LayerCard, hand-written <article rounded-xl ring-1>,
 * hand-written <div rounded-xl border>, Kumo Surface. Screens MUST use
 * PanelCard and MUST NOT hand-write card chrome (enforced by ratchet.test.ts).
 *
 * Chrome is inherited verbatim from the legacy dashboard `Panel`
 * (rounded-xl + border-kumo-line + bg-kumo-base; header band
 * border-b/bg-kumo-elevated) so this is a behaviour-preserving consolidation,
 * NOT a restyle. The card imposes NO outer margin — vertical rhythm belongs to
 * the parent layout, not the card (legacy Panel's `mb-4` is intentionally
 * dropped; the layout-grammar follow-on plan owns spacing).
 *
 * Body padding is density-driven (densityClasses().card) so the already-wired
 * DensityProvider finally takes effect for cards (audit S4). The four canonical
 * content states render INSIDE the card via the existing panel-state
 * primitives, so screens stop hand-writing "header + state branch"
 * (audit S3-C). #418 SSR-safety is preserved transitively: PanelSkeleton
 * already uses SsrSafeSkeleton.
 */
import React from "react";
import { useDensity, densityClasses } from "../components/density";
import {
  PanelSkeleton,
  PanelEmpty,
  PanelError,
  PanelLoading,
} from "../components/panel-state";

export type PanelCardState =
  | { kind: "ready" }
  | { kind: "loading"; lines?: number }
  | { kind: "inlineLoading"; label: string }
  | {
      kind: "empty";
      title: string;
      description?: string;
      action?: React.ReactNode;
    }
  | { kind: "error"; error: unknown };

export type PanelCardProps = {
  /** Header title. String only — also feeds PanelError's required title. */
  title?: string;
  /** Optional sub-line under the title. */
  subtitle?: string;
  /** Optional leading icon node in the header. */
  icon?: React.ReactNode;
  /** Optional right-aligned header actions (buttons, links). */
  actions?: React.ReactNode;
  /** Content-state machine. Default { kind: "ready" } renders children. */
  state?: PanelCardState;
  /** Set false to remove body padding (e.g. flush tables). Default true. */
  padded?: boolean;
  children?: React.ReactNode;
};

const CONTAINER = "rounded-xl border border-kumo-line bg-kumo-base";
const HEADER =
  "flex items-center gap-3 border-b border-kumo-line bg-kumo-elevated px-5 py-3";

function renderState(
  state: PanelCardState,
  title: string | undefined,
): React.ReactNode {
  switch (state.kind) {
    case "loading":
      return <PanelSkeleton lines={state.lines} />;
    case "inlineLoading":
      return <PanelLoading label={state.label} />;
    case "empty":
      return (
        <PanelEmpty
          title={state.title}
          description={state.description}
          action={state.action}
        />
      );
    case "error":
      return <PanelError title={title ?? "加载失败"} error={state.error} />;
    case "ready":
    default:
      return null;
  }
}

export function PanelCard({
  title,
  subtitle,
  icon,
  actions,
  state = { kind: "ready" },
  padded = true,
  children,
}: PanelCardProps): React.ReactElement {
  const density = useDensity();
  const isReady = state.kind === "ready";
  const bodyClass = isReady && padded ? densityClasses(density).card : undefined;
  const hasHeader =
    title !== undefined || icon !== undefined || actions !== undefined;

  return (
    <section className={CONTAINER} data-panel-card>
      {hasHeader ? (
        <div className={HEADER} data-panel-card-header>
          {icon ? (
            <span className="shrink-0 text-kumo-subtle" aria-hidden="true">
              {icon}
            </span>
          ) : null}
          <div className="min-w-0 flex-1">
            {title !== undefined ? (
              <p className="truncate text-sm font-semibold text-kumo-strong">
                {title}
              </p>
            ) : null}
            {subtitle !== undefined ? (
              <p className="truncate text-xs text-kumo-subtle">{subtitle}</p>
            ) : null}
          </div>
          {actions ? (
            <div className="shrink-0" data-panel-card-actions>
              {actions}
            </div>
          ) : null}
        </div>
      ) : null}
      <div className={bodyClass} data-panel-card-body>
        {isReady ? children : renderState(state, title)}
      </div>
    </section>
  );
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run:
```bash
pnpm exec vitest run src/litellm-portal/ui/panel-card.test.tsx
```
Expected: PASS, 5 tests passed (`PanelCard — frame & header`). If any FAIL, STOP and report.

- [ ] **Step 6: Typecheck**

Run:
```bash
bunx tsc --noEmit -p tsconfig.json 2>&1 | grep -E "error TS" | grep -vE "TS6142|server\.ts\(6,33\)" | grep "litellm-portal/ui/" || echo "UI TYPECHECK CLEAN"
```
Expected: the single line `UI TYPECHECK CLEAN` (see Instructions §9 TYPECHECK PROTOCOL — `TS6142` is pre-existing noise, never a stop reason).

- [ ] **Step 7: Commit**

```bash
git add src/litellm-portal/ui/panel-card.tsx src/litellm-portal/ui/index.ts src/litellm-portal/ui/panel-card.test.tsx
git commit -m "feat(litellm-portal): add PanelCard seam primitive (frame + header)"
```

---

## Task 2: PanelCard density-driven body padding (closes S4 for cards)

**Files:**
- Modify: `src/litellm-portal/ui/panel-card.test.tsx` (append tests only)
- Verify: `src/litellm-portal/ui/panel-card.tsx` (already correct from Task 1 — this task proves it)

> Note: the implementation written in Task 1 already wires density. This task adds the proving tests. If a test fails, the bug is in the test you typed — re-check against the code block, do NOT edit `panel-card.tsx` unless the failure proves a real logic gap, and if it does, STOP and report first.

- [ ] **Step 1: Write the failing/【proving】tests**

Append EXACTLY this `describe` block to the END of `src/litellm-portal/ui/panel-card.test.tsx` (after the last `});` of the file, before EOF):

```tsx
describe("PanelCard — density-driven body padding (S4)", () => {
  it("uses comfortable padding p-6 by default (no DensityProvider)", () => {
    const { container } = wrap(<PanelCard title="t">b</PanelCard>);
    const body = container.querySelector(
      "[data-panel-card-body]",
    ) as HTMLElement;
    expect(body.className).toContain("p-6");
  });

  it("uses compact padding p-4 under DensityProvider density=compact", () => {
    const { container } = wrap(
      <DensityProvider density="compact">
        <PanelCard title="t">b</PanelCard>
      </DensityProvider>,
    );
    const body = container.querySelector(
      "[data-panel-card-body]",
    ) as HTMLElement;
    expect(body.className).toContain("p-4");
    expect(body.className).not.toContain("p-6");
  });

  it("applies NO body padding class when padded={false}", () => {
    const { container } = wrap(
      <PanelCard title="t" padded={false}>
        b
      </PanelCard>,
    );
    const body = container.querySelector(
      "[data-panel-card-body]",
    ) as HTMLElement;
    expect(body.className).not.toContain("p-6");
    expect(body.className).not.toContain("p-4");
  });
});
```

- [ ] **Step 2: Run the tests**

Run:
```bash
pnpm exec vitest run src/litellm-portal/ui/panel-card.test.tsx
```
Expected: PASS, 8 tests total (5 from Task 1 + 3 new). If a density test FAILS, STOP and report (do not edit the implementation without reporting first).

- [ ] **Step 3: Typecheck**

Run:
```bash
bunx tsc --noEmit -p tsconfig.json 2>&1 | grep -E "error TS" | grep -vE "TS6142|server\.ts\(6,33\)" | grep "litellm-portal/ui/" || echo "UI TYPECHECK CLEAN"
```
Expected: the single line `UI TYPECHECK CLEAN` (see Instructions §9 TYPECHECK PROTOCOL — `TS6142` is pre-existing noise, never a stop reason).
- [ ] **Step 4: Commit**

```bash
git add src/litellm-portal/ui/panel-card.test.tsx
git commit -m "test(litellm-portal): prove PanelCard body padding follows DensityProvider"
```

---

## Task 3: PanelCard four canonical content states (closes S3-C)

**Files:**
- Modify: `src/litellm-portal/ui/panel-card.test.tsx` (append tests only)
- Verify: `src/litellm-portal/ui/panel-card.tsx` (already implements `renderState` — this task proves it)

- [ ] **Step 1: Write the proving tests**

Append EXACTLY this `describe` block to the END of `src/litellm-portal/ui/panel-card.test.tsx`:

```tsx
describe("PanelCard — four content states render inside the frame (S3-C)", () => {
  it("state=loading renders the skeleton and NOT children", () => {
    const { container } = wrap(
      <PanelCard title="t" state={{ kind: "loading", lines: 3 }}>
        <p>should-not-show</p>
      </PanelCard>,
    );
    expect(container.querySelector("[data-panel-skeleton]")).not.toBeNull();
    expect(
      container.querySelectorAll("[data-panel-skeleton-line]").length,
    ).toBe(3);
    expect(screen.queryByText("should-not-show")).toBeNull();
  });

  it("state=empty renders PanelEmpty with title/description/action", () => {
    wrap(
      <PanelCard
        title="t"
        state={{
          kind: "empty",
          title: "暂无密钥",
          description: "去创建一个",
          action: <a href="/x">创建</a>,
        }}
      >
        c
      </PanelCard>,
    );
    expect(screen.getByText("暂无密钥")).toBeTruthy();
    expect(screen.getByText("去创建一个")).toBeTruthy();
    expect(screen.getByRole("link", { name: "创建" })).toBeTruthy();
  });

  it("state=error uses the card title as the error title and never leaks a non-catalog raw message (§F.3)", () => {
    // PanelCard renders the title in BOTH the header and (when state=error)
    // the PanelError banner — that is the intended contract (the card title
    // IS the error title). Assert it precisely inside the error region rather
    // than with a page-wide getByText, which would (correctly) find two nodes.
    const { container } = wrap(
      <PanelCard
        title="加载失败"
        state={{ kind: "error", error: new Error("Failed to fetch") }}
      >
        c
      </PanelCard>,
    );
    const errRegion = container.querySelector("[data-panel-error]");
    expect(errRegion).not.toBeNull();
    expect(errRegion?.textContent).toContain("加载失败");
    expect(container.textContent).not.toContain("Failed to fetch");
    expect(container.textContent).toContain("网络请求失败");
  });

  it("state=error falls back to a default title when card has no title", () => {
    wrap(
      <PanelCard state={{ kind: "error", error: new Error("boom") }}>
        c
      </PanelCard>,
    );
    expect(screen.getByText("加载失败")).toBeTruthy();
  });

  it("state=inlineLoading renders the labelled Kumo loader", () => {
    wrap(
      <PanelCard
        title="t"
        state={{ kind: "inlineLoading", label: "正在加载" }}
      >
        c
      </PanelCard>,
    );
    expect(screen.getByLabelText("正在加载")).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run the tests**

Run:
```bash
pnpm exec vitest run src/litellm-portal/ui/panel-card.test.tsx
```
Expected: PASS, 13 tests total. If a state test FAILS, STOP and report.

- [ ] **Step 3: Typecheck**

Run:
```bash
bunx tsc --noEmit -p tsconfig.json 2>&1 | grep -E "error TS" | grep -vE "TS6142|server\.ts\(6,33\)" | grep "litellm-portal/ui/" || echo "UI TYPECHECK CLEAN"
```
Expected: the single line `UI TYPECHECK CLEAN` (see Instructions §9 TYPECHECK PROTOCOL — `TS6142` is pre-existing noise, never a stop reason).

- [ ] **Step 4: Commit**

```bash
git add src/litellm-portal/ui/panel-card.test.tsx
git commit -m "test(litellm-portal): prove PanelCard renders four content states in-frame"
```

---

## Task 4: The ratchet scanner (pure fs, TDD with temp fixtures)

**Files:**
- Create: `src/litellm-portal/ui/ratchet-scan.ts`
- Test: `src/litellm-portal/ui/ratchet-scan.test.ts`

What "raw card chrome" means (the audited signature): a `.tsx` file whose text contains `rounded-xl` AND (`ring-1` OR `border border-kumo-line`). The scanner returns sorted POSIX-relative paths (relative to the scan root) of offending files, EXCLUDING: anything under `ui/`, any `*.test.*` / `*.stories.*`, and the explicitly allow-listed legacy `dashboard/components/panel.tsx` (the sanctioned card, migrated in a later plan).

- [ ] **Step 1: Write the failing test**

Create `src/litellm-portal/ui/ratchet-scan.test.ts` with EXACTLY this content:

```ts
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scanRawCardChrome } from "./ratchet-scan";

let root = "";

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "ratchet-"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function put(rel: string, content: string): void {
  const full = join(root, rel);
  mkdirSync(join(full, ".."), { recursive: true });
  writeFileSync(full, content);
}

describe("scanRawCardChrome", () => {
  it("flags a screen file with rounded-xl + ring-1", () => {
    put(
      "ops-console/screens/audit.tsx",
      `export const C = () => <article className="overflow-hidden rounded-xl bg-kumo-base ring-1 ring-kumo-line">x</article>;`,
    );
    expect(scanRawCardChrome(root)).toEqual(["ops-console/screens/audit.tsx"]);
  });

  it("flags rounded-xl + 'border border-kumo-line'", () => {
    put(
      "dashboard/views/x.tsx",
      `<div className="mb-4 rounded-xl border border-kumo-line bg-kumo-base" />`,
    );
    expect(scanRawCardChrome(root)).toEqual(["dashboard/views/x.tsx"]);
  });

  it("does NOT flag a file without both tokens", () => {
    put("screens/clean.tsx", `<div className="rounded-xl p-4">ok</div>`);
    expect(scanRawCardChrome(root)).toEqual([]);
  });

  it("skips the ui/ seam directory", () => {
    put(
      "ui/panel-card.tsx",
      `<section className="rounded-xl border border-kumo-line bg-kumo-base" />`,
    );
    expect(scanRawCardChrome(root)).toEqual([]);
  });

  it("skips *.test.tsx and *.stories.tsx", () => {
    put("a/b.test.tsx", `className="rounded-xl ring-1"`);
    put("a/c.stories.tsx", `className="rounded-xl ring-1"`);
    expect(scanRawCardChrome(root)).toEqual([]);
  });

  it("skips the allow-listed legacy dashboard/components/panel.tsx", () => {
    put(
      "dashboard/components/panel.tsx",
      `<div className="mb-4 rounded-xl border border-kumo-line bg-kumo-base" />`,
    );
    expect(scanRawCardChrome(root)).toEqual([]);
  });

  it("returns sorted, POSIX-separated relative paths", () => {
    put("z/late.tsx", `className="rounded-xl ring-1"`);
    put("a/early.tsx", `className="rounded-xl ring-1"`);
    expect(scanRawCardChrome(root)).toEqual([
      "a/early.tsx",
      "z/late.tsx",
    ]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run:
```bash
pnpm exec vitest run src/litellm-portal/ui/ratchet-scan.test.ts
```
Expected: FAIL — cannot resolve module `./ratchet-scan`. If it PASSES, STOP and report.

- [ ] **Step 3: Write the scanner implementation**

Create `src/litellm-portal/ui/ratchet-scan.ts` with EXACTLY this content:

```ts
/**
 * Ratchet scanner (UI seam enforcement).
 *
 * Returns the sorted POSIX-relative paths of `.tsx` files under `root` that
 * hand-write card chrome — the audited signature is `rounded-xl` co-occurring
 * with `ring-1` or `border border-kumo-line`. The ratchet test (ratchet.test.ts)
 * asserts this set never grows beyond the committed baseline, so NEW files can
 * never introduce a 5th hand-rolled card while existing offenders are
 * grandfathered until the migration plan removes them.
 *
 * Excluded: the `ui/` seam itself, `*.test.*` / `*.stories.*`, and the
 * allow-listed legacy `dashboard/components/panel.tsx` (sanctioned card,
 * migrated in a follow-on plan).
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const SKIP_DIRS = new Set<string>(["ui", "node_modules"]);
const ALLOW_FILES = new Set<string>(["dashboard/components/panel.tsx"]);

function isCandidateFile(name: string): boolean {
  if (!name.endsWith(".tsx")) return false;
  if (name.endsWith(".test.tsx")) return false;
  if (name.endsWith(".stories.tsx")) return false;
  return true;
}

function hasRawCardChrome(text: string): boolean {
  if (!text.includes("rounded-xl")) return false;
  return text.includes("ring-1") || text.includes("border border-kumo-line");
}

function walk(dir: string, rootLen: number, acc: string[]): void {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (SKIP_DIRS.has(entry)) continue;
      walk(full, rootLen, acc);
      continue;
    }
    if (!isCandidateFile(entry)) continue;
    const rel = full.slice(rootLen).replace(/\\/g, "/").replace(/^\/+/, "");
    if (ALLOW_FILES.has(rel)) continue;
    if (hasRawCardChrome(readFileSync(full, "utf8"))) acc.push(rel);
  }
}

export function scanRawCardChrome(root: string): string[] {
  const acc: string[] = [];
  walk(root, root.length, acc);
  return acc.sort();
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run:
```bash
pnpm exec vitest run src/litellm-portal/ui/ratchet-scan.test.ts
```
Expected: PASS, 7 tests passed. If any FAIL, STOP and report the full output.

- [ ] **Step 5: Typecheck**

Run:
```bash
bunx tsc --noEmit -p tsconfig.json 2>&1 | grep -E "error TS" | grep -vE "TS6142|server\.ts\(6,33\)" | grep "litellm-portal/ui/" || echo "UI TYPECHECK CLEAN"
```
Expected: the single line `UI TYPECHECK CLEAN` (see Instructions §9 TYPECHECK PROTOCOL — `TS6142` is pre-existing noise, never a stop reason).
- [ ] **Step 6: Commit**

```bash
git add src/litellm-portal/ui/ratchet-scan.ts src/litellm-portal/ui/ratchet-scan.test.ts
git commit -m "feat(litellm-portal): add raw-card-chrome ratchet scanner"
```

---

## Task 5: Generate the baseline + the enforcement test (the ratchet goes live)

**Files:**
- Create: `src/litellm-portal/ui/ratchet.test.ts`
- Create (generated, then committed): `src/litellm-portal/ui/ratchet-baseline.json`

The enforcement test scans the REAL repo and asserts the offender set is a subset of the committed baseline. Baseline is regenerated by running the same test with `UPDATE_RATCHET_BASELINE=1` (snapshot-update pattern — single source of scan logic, one command, nothing hand-typed).

- [ ] **Step 1: Write the enforcement test**

Create `src/litellm-portal/ui/ratchet.test.ts` with EXACTLY this content:

```ts
import { describe, expect, it } from "vitest";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { scanRawCardChrome } from "./ratchet-scan";

const PORTAL_ROOT = join(process.cwd(), "src/litellm-portal");
const BASELINE_PATH = join(PORTAL_ROOT, "ui/ratchet-baseline.json");

describe("UI card-chrome ratchet", () => {
  it("no NEW file hand-writes card chrome (offenders ⊆ committed baseline)", () => {
    const current = scanRawCardChrome(PORTAL_ROOT);

    if (process.env.UPDATE_RATCHET_BASELINE === "1") {
      writeFileSync(
        BASELINE_PATH,
        JSON.stringify(current, null, 2) + "\n",
        "utf8",
      );
      return;
    }

    expect(existsSync(BASELINE_PATH)).toBe(true);
    const baseline = new Set<string>(
      JSON.parse(readFileSync(BASELINE_PATH, "utf8")) as string[],
    );
    const introduced = current.filter((f) => !baseline.has(f));
    expect(
      introduced,
      `New raw card chrome introduced — use <PanelCard> from src/litellm-portal/ui instead of hand-writing rounded-xl+ring-1/border. Offending files:\n${introduced.join(
        "\n",
      )}`,
    ).toEqual([]);
  });
});
```

- [ ] **Step 2: Generate the baseline**

Run:
```bash
UPDATE_RATCHET_BASELINE=1 pnpm exec vitest run src/litellm-portal/ui/ratchet.test.ts
```
Expected: PASS (1 test). The file `src/litellm-portal/ui/ratchet-baseline.json` is now created.

- [ ] **Step 3: Inspect the generated baseline**

Run:
```bash
node -e "const b=require('./src/litellm-portal/ui/ratchet-baseline.json');console.log('count:',b.length);console.log(b.slice(0,12).join('\n'))"
```
Expected: `count:` is a number **≥ 10** (the audit found 21–43 hand-written cards across screens; the file-level count will be lower than the occurrence count but must be well above zero), and the listed paths are screen/shell files such as ones under `ops-console/screens/`, `tenant-portal/screens/`, or `dashboard/`. If `count: 0`, the scanner or root path is wrong — STOP and report.

- [ ] **Step 4: Verify the ratchet now enforces (re-run WITHOUT the env var)**

Run:
```bash
pnpm exec vitest run src/litellm-portal/ui/ratchet.test.ts
```
Expected: PASS (current offenders exactly equal the just-generated baseline, so the subset check passes).

- [ ] **Step 5: Prove the ratchet actually catches a new offender (temporary negative check — DO NOT COMMIT THIS FILE)**

Run:
```bash
printf 'export const X = () => <article className="rounded-xl ring-1 ring-kumo-line" />;\n' > src/litellm-portal/__ratchet_probe__.tsx
pnpm exec vitest run src/litellm-portal/ui/ratchet.test.ts
```
Expected: **FAIL**, with the message listing `__ratchet_probe__.tsx` as introduced raw card chrome. This proves the ratchet works.

Then remove the probe:
```bash
rm src/litellm-portal/__ratchet_probe__.tsx
pnpm exec vitest run src/litellm-portal/ui/ratchet.test.ts
```
Expected: PASS again. Confirm `git status` does NOT show `__ratchet_probe__.tsx`. If the probe test PASSED in the first half of this step, STOP and report — the ratchet is not enforcing.

- [ ] **Step 6: Commit the live ratchet + baseline**

```bash
git add src/litellm-portal/ui/ratchet.test.ts src/litellm-portal/ui/ratchet-baseline.json
git commit -m "feat(litellm-portal): enforce no-new-raw-card-chrome ratchet via baseline"
```

---

## Task 6: Full-suite verification & Definition of Done

**Files:** none (verification only — no commit unless a gap is found and a prior task must be revisited).

- [ ] **Step 1: Full typecheck**

Run:
```bash
bunx tsc --noEmit -p tsconfig.json 2>&1 | grep -E "error TS" | grep -vE "TS6142|server\.ts\(6,33\)" | grep "litellm-portal/ui/" || echo "UI TYPECHECK CLEAN"
```
Expected: the single line `UI TYPECHECK CLEAN` (see Instructions §9 TYPECHECK PROTOCOL — `TS6142` is pre-existing noise, never a stop reason).

- [ ] **Step 2: Run every file this plan created**

Run:
```bash
pnpm exec vitest run src/litellm-portal/ui
```
Expected: ALL PASS. Test counts: `panel-card.test.tsx` 13, `ratchet-scan.test.ts` 7, `ratchet.test.ts` 1. Total 21 passed, 0 failed.

- [ ] **Step 3: Confirm the ratchet is inside the CI gate**

Run:
```bash
node -e "const c=require('fs').readFileSync('vitest.config.ts','utf8');console.log(/src\/\*\*\/\*\.test\.ts/.test(c)?'ratchet IS in vitest include glob':'NOT in glob')"
```
Expected: `ratchet IS in vitest include glob` — confirming `ratchet.test.ts` runs automatically under the existing `pnpm exec vitest run` CI step (no husky/CI edit needed; enforcement is automatic).

- [ ] **Step 4: Confirm no out-of-scope files were changed**

Run:
```bash
git diff --name-only main...HEAD
```
Expected: ONLY these 7 paths appear:
```
src/litellm-portal/ui/index.ts
src/litellm-portal/ui/panel-card.test.tsx
src/litellm-portal/ui/panel-card.tsx
src/litellm-portal/ui/ratchet-baseline.json
src/litellm-portal/ui/ratchet-scan.test.ts
src/litellm-portal/ui/ratchet-scan.ts
src/litellm-portal/ui/ratchet.test.ts
```
If ANY other path appears (especially a screen, shell, `panel-state.tsx`, `density.tsx`, or `panel.tsx`), STOP and report — scope was violated.

**Definition of Done:**
- `PanelCard` exists at `src/litellm-portal/ui/panel-card.tsx`, exported from `src/litellm-portal/ui/index.ts`, with the four-state API, density-driven padding, and chrome identical to legacy `Panel`.
- 21 tests pass; `tsc --noEmit` has zero `ui/` errors.
- The ratchet test fails the build if any NEW file outside `ui/` hand-writes `rounded-xl` + `ring-1`/`border border-kumo-line`, and runs automatically in the existing `vitest run` CI gate.
- Exactly 7 new files; zero existing files modified; zero behaviour change to any rendered screen.

---

## Out of scope (explicit — do NOT attempt here)

- Migrating any screen/shell to `PanelCard` (follow-on **Plan 2**: per-surface migration; requires reading each surface's source).
- `PageShell`, `SideNav` → Kumo `sidebar`, layout slot grammar, screen archetypes (follow-on plans; need Kumo `sidebar` real API, not installed locally).
- Extending `ratchet-scan` to ban naked grids / vertical rhythm / deep Kumo container imports (follow-on plan, after `PanelCard` adoption proves the seam).
- Touching `panel-state.tsx`, `density.tsx`, `side-nav.tsx`, `dashboard/components/panel.tsx`, auth/role/impersonation/SSR.

---

## Self-Review (author checklist — completed)

1. **Spec coverage:** Plan-1 slice of `LITELLM_PORTAL_UI_REMEDIATION_PLAN.md` (Layer-2 `PanelCard` + ratchet R1) → Tasks 1–5 implement it; S3/S3-C/S4 (card scope) and supplementary evidence A/C addressed. PageShell/archetypes/migration explicitly deferred and labelled — no silent gaps.
2. **Placeholder scan:** No "TBD/handle edge cases/similar to Task N/write tests for the above". Every code step contains complete, final code; every command has exact expected output.
3. **Type consistency:** `PanelCardProps`/`PanelCardState`/`scanRawCardChrome` names identical across `panel-card.tsx`, `index.ts`, tests, `ratchet-scan.ts`, `ratchet.test.ts`. `densityClasses().card`, `PanelSkeleton({lines})`, `PanelEmpty({title,description,action})`, `PanelError({title,error})`, `PanelLoading({label})` match the verified real signatures of the existing modules. `data-*` selectors used in tests match those emitted by `panel-card.tsx` and the real `panel-state.tsx` (`data-panel-skeleton`, `data-panel-skeleton-line`).
