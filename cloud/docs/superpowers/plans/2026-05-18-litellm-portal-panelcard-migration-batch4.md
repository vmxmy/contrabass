# LiteLLM Portal — PanelCard 迁移 Batch-4（收口：app.tsx + member-overlay，基线 2→0）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development / executing-plans. Steps use `- [ ]`.

**Goal:** 迁移最后 2 个棘轮基线文件的卡片 chrome 到 `PanelCard`，棘轮基线 **2→0** —— 全 Portal 手写卡片 chrome 100% 消除，PanelCard 迁移完整收口。

**Architecture:** 同 Batch-1/2/3 的纯 chrome 替换（非 God-Component 行为重构 —— 仅替换外层卡片容器，子内容/数据/图表/IIFE 逐字保留）。这两个文件**没有任何断言其卡片 DOM 的单测**（不同于 side-nav），故 chrome 替换由现有"ratchet + tsc + ui suite + git scope"门即可证明：文件离开基线、tsc clean、ui 21 绿、仅这 2 文件+baseline 改动。member-overlay 的 4 个嵌套 div 用**含唯一上下文锚点**的 OLD 块消除 `</div>` 歧义。

> 说明：本 plan 只做 member-overlay/app.tsx 的**卡片 chrome 收口**（机械、可门控验证）。审计 S7 的 God-Component **完整拆分**（ViewModel 抽取 / 哑组件 / lazy chart）是行为敏感、需运行时 QA 的独立后续工作，不在此。

**Tech Stack:** React, TS strict, Vitest, pnpm。

---

## Instructions for the implementing agent (Kimi) — read fully before Task 1

1. **Scope lock.** Task 1 = ONLY `src/litellm-portal/app.tsx` + `ui/ratchet-baseline.json`. Task 2 = ONLY `src/litellm-portal/dashboard/views/member-overlay.tsx` + `ui/ratchet-baseline.json`. Never modify `ui/panel-card.tsx`, `ui/ratchet*`, `panel-state.tsx`, `density.tsx`, charts, hooks.
2. **Preserve inner content exactly.** Replace ONLY the wrapper + header band per OLD→NEW. Every child (tables, IIFE, charts, badges, conditional branches) copied VERBATIM.
3. **Verbatim.** Apply OLD→NEW exactly. No reformat, no `any`, no `@ts-ignore`. If an OLD block is not found exactly, STOP and report with the actual file region — do NOT improvise.
4. **TYPECHECK PROTOCOL.** When a step says "Typecheck", run EXACTLY:
   ```bash
   bunx tsc --noEmit -p tsconfig.json 2>&1 | grep -E "error TS" | grep -vE "TS6142|server\.ts\(6,33\)" | grep "litellm-portal/" | grep -vE "litellm-portal/(ui|i18n|errors|a11y|hooks|lib|components|dashboard-schemas)" || echo "MIGRATION TYPECHECK CLEAN"
   ```
   Expected: single line `MIGRATION TYPECHECK CLEAN`. A bare `TS6142` is NEVER a stop reason. A real error for the file you edited → STOP and report.
5. **Ratchet shrink (every task).** After the edits run EXACTLY:
   ```bash
   UPDATE_RATCHET_BASELINE=1 pnpm exec vitest run src/litellm-portal/ui/ratchet.test.ts
   ```
   then:
   ```bash
   pnpm exec vitest run src/litellm-portal/ui
   ```
   Expected: full `ui` suite passes. If the migrated file is STILL in `ratchet-baseline.json`, you missed a chrome occurrence → STOP and report.
6. **STOP rule.** Any output ≠ Expected → STOP, report task/step + full output, do not continue.
7. **One commit per task**, scope `litellm-portal`, exact message. Never push / rebase / amend / switch branches.
8. **Working directory** for every command: `/Users/xumingyang/github/contrabass/cloud`.

---

## Task 1: `app.tsx` — TeamsAccessCard + ModelAccessCard (2 cards)

**Files:** Modify `src/litellm-portal/app.tsx`, `src/litellm-portal/ui/ratchet-baseline.json`

- [ ] **Step 1: Add import.** Replace EXACTLY:
```tsx
import React, { useEffect, useMemo, useState } from "react";
```
with EXACTLY:
```tsx
import React, { useEffect, useMemo, useState } from "react";
import { PanelCard } from "./ui";
```

- [ ] **Step 2: TeamsAccessCard — open.** Replace EXACTLY:
```tsx
    <article className="overflow-hidden rounded-xl bg-kumo-base ring-1 ring-kumo-line">
      <div className="border-b border-kumo-line bg-kumo-elevated p-6">
        <Text variant="heading3" as="p">团队权限</Text>
        <Text variant="secondary" as="p">只展示当前账号所属团队的信息。</Text>
      </div>
      {!loaded ? (
```
with EXACTLY:
```tsx
    <PanelCard title="团队权限" subtitle="只展示当前账号所属团队的信息。" padded={false}>
      {!loaded ? (
```

- [ ] **Step 3: TeamsAccessCard — close.** Replace EXACTLY:
```tsx
      )}
    </article>
  );
}

export function ModelAccessCard() {
```
with EXACTLY:
```tsx
      )}
    </PanelCard>
  );
}

export function ModelAccessCard() {
```

- [ ] **Step 4: ModelAccessCard — open.** Replace EXACTLY:
```tsx
    <article className="overflow-hidden rounded-xl bg-kumo-base ring-1 ring-kumo-line">
      <div className="border-b border-kumo-line bg-kumo-elevated p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="space-y-1">
            <Text variant="heading3" as="p">团队可用模型</Text>
            <Text variant="secondary" as="p">{sourceLabel(modelAccess.source)}</Text>
          </div>
          <Badge variant="outline" className="rounded-full">
            {modelAccess.models.length || "—"} 个模型
          </Badge>
        </div>
      </div>

      <div className="space-y-5 p-6">
```
with EXACTLY:
```tsx
    <PanelCard
      title="团队可用模型"
      subtitle={sourceLabel(modelAccess.source)}
      actions={
        <Badge variant="outline" className="rounded-full">
          {modelAccess.models.length || "—"} 个模型
        </Badge>
      }
      padded={false}
    >
      <div className="space-y-5 p-6">
```

- [ ] **Step 5: ModelAccessCard — close.** Replace EXACTLY:
```tsx
        )}
      </div>
    </article>
  );
}

function PreferencesBootstrap() {
```
with EXACTLY:
```tsx
        )}
      </div>
    </PanelCard>
  );
}

function PreferencesBootstrap() {
```

- [ ] **Step 6: Typecheck.** §4 command. Expected: `MIGRATION TYPECHECK CLEAN`.
- [ ] **Step 7: Ratchet shrink + suite.** §5 commands. Expected: `ui` suite passes; `app.tsx` gone from baseline.
- [ ] **Step 8: Commit.**
```bash
git add src/litellm-portal/app.tsx src/litellm-portal/ui/ratchet-baseline.json
git commit -m "refactor(litellm-portal): migrate app.tsx Teams/ModelAccess cards to PanelCard"
```

---

## Task 2: `dashboard/views/member-overlay.tsx` — 4 cards (unique-anchor edits)

**Files:** Modify `src/litellm-portal/dashboard/views/member-overlay.tsx`, `src/litellm-portal/ui/ratchet-baseline.json`

- [ ] **Step 1: Add import.** Replace EXACTLY:
```tsx
import { ModelDonut } from "../charts/model-donut";
```
with EXACTLY:
```tsx
import { ModelDonut } from "../charts/model-donut";
import { PanelCard } from "../../ui";
```

- [ ] **Step 2: Quota card — open.** Replace EXACTLY:
```tsx
            <div className="mb-4 rounded-xl border border-kumo-line bg-kumo-base p-5">
              <div className="text-xs uppercase tracking-wider text-kumo-subtle">配额使用</div>
```
with EXACTLY:
```tsx
            <PanelCard title="配额使用">
```

- [ ] **Step 3: Quota card close + Models card open.** Replace EXACTLY:
```tsx
              <div className="mt-1 font-mono text-xs text-kumo-subtle">
                ${spend.toFixed(2)}{maxBudget != null ? ` / $${maxBudget.toFixed(2)}` : ""}
              </div>
            </div>
            <div className="mb-4 rounded-xl border border-kumo-line bg-kumo-base p-5">
              <div className="mb-2 text-xs uppercase tracking-wider text-kumo-subtle">近 30 天使用过的模型</div>
```
with EXACTLY:
```tsx
              <div className="mt-1 font-mono text-xs text-kumo-subtle">
                ${spend.toFixed(2)}{maxBudget != null ? ` / $${maxBudget.toFixed(2)}` : ""}
              </div>
            </PanelCard>
            <PanelCard title="近 30 天使用过的模型">
```

- [ ] **Step 4: Models card close + chart-card-1 open.** Replace EXACTLY:
```tsx
                ))}
              </div>
            </div>
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
              <div className="rounded-xl border border-kumo-line bg-kumo-base p-5">
```
with EXACTLY:
```tsx
                ))}
              </div>
            </PanelCard>
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
              <PanelCard padded={false}>
```

- [ ] **Step 5: chart-card-1 close + chart-card-2 (full).** Replace EXACTLY:
```tsx
                })()}
              </div>
              <div className="rounded-xl border border-kumo-line bg-kumo-base p-5">
                <ModelDonut slices={data.models.map((m) => ({ model: m.model, value: m.spend }))} />
              </div>
```
with EXACTLY:
```tsx
                })()}
              </PanelCard>
              <PanelCard padded={false}>
                <ModelDonut slices={data.models.map((m) => ({ model: m.model, value: m.spend }))} />
              </PanelCard>
```

- [ ] **Step 6: Typecheck.** §4 command. Expected: `MIGRATION TYPECHECK CLEAN`.
- [ ] **Step 7: Ratchet shrink + suite.** §5 commands. Expected: `ui` suite passes; `dashboard/views/member-overlay.tsx` gone from baseline; baseline is now EMPTY.
- [ ] **Step 8: Commit.**
```bash
git add src/litellm-portal/dashboard/views/member-overlay.tsx src/litellm-portal/ui/ratchet-baseline.json
git commit -m "refactor(litellm-portal): migrate member-overlay cards to PanelCard"
```

---

## Task 3: Verification (no commit)

- [ ] **Step 1:** `pnpm exec vitest run src/litellm-portal/ui` → all pass (21).
- [ ] **Step 2:** §4 TYPECHECK PROTOCOL → `MIGRATION TYPECHECK CLEAN`.
- [ ] **Step 3:** `node -e "const b=require('./src/litellm-portal/ui/ratchet-baseline.json');console.log('baseline length:', b.length)"` → expected `baseline length: 0`.
- [ ] **Step 4:** Confirm both files chrome-free:
```bash
grep -lE "rounded-xl.*(ring-1|border border-kumo-line)|(ring-1|border border-kumo-line).*rounded-xl" src/litellm-portal/app.tsx src/litellm-portal/dashboard/views/member-overlay.tsx || echo "BOTH CHROME-FREE"
```
Expected: `BOTH CHROME-FREE`.
- [ ] **Step 5:** Report `git log --oneline` of the 2 new commits; confirm only the 2 source files + baseline changed.

**DoD:** app.tsx + member-overlay use `<PanelCard>`, **ratchet baseline length = 0** (全 Portal 手写卡片 chrome 100% 消除), `ui` suite green, typecheck clean, 2 commits.

## Out of scope
S7 God-Component **完整拆分**（member-overlay/app.tsx 的 ViewModel 抽取、哑组件、lazy chart、内层 ErrorBoundary）—— 行为敏感，需运行时 QA，独立后续工作。PageShell 收敛(S2) / 屏原型 / SideNav 响应式 → 各自后续 plan。
