# LiteLLM Portal — PanelCard 迁移 Batch-1（6 个最简 offender）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development / executing-plans. Steps use `- [ ]`.

**Goal:** 把 6 个最简单的存量违规文件的手写卡片 chrome 替换为 `PanelCard`（来自 Plan-1 的 `src/litellm-portal/ui/`），并让棘轮基线相应递减——证明并固化迁移范式。

**Architecture:** 纯替换外层卡片容器（`<article|section|div rounded-xl ring-1/border>` + 手写 header band）为 `<PanelCard>`，内部内容**逐字保留**。这是审计 S3 要求的**有意视觉收敛**：各屏原本用 `<Text variant="heading3">` 大标题 header，统一到 PanelCard 的 `text-sm font-semibold` header（继承自 legacy dashboard Panel）。这是预期视觉变化，不是回归。每迁移一个文件即用 `UPDATE_RATCHET_BASELINE=1` 重生成基线（自动剔除已迁移文件），基线单调递减。

**Tech Stack:** React, TS strict（kebab-case、named export、no `any`）, Kumo, Vitest, pnpm。验证门见下 §TYPECHECK PROTOCOL。

---

## Instructions for the implementing agent (Kimi) — read fully before Task 1

1. **Scope lock.** Each task lists ONE source file + the shared `ratchet-baseline.json`. Touch ONLY those. Never modify `ui/panel-card.tsx`, `ui/ratchet*.ts*`, `panel-state.tsx`, `density.tsx`, or any file not named in the task.
2. **Behaviour: preserve inner content exactly.** You replace ONLY the outer card wrapper element + its header band. Every child (tables, skeleton/empty/error branches, dl/dt/dd, maps) is copied VERBATIM, unchanged.
3. **Copy edits verbatim.** Each task gives an exact OLD block and exact NEW block. Apply exactly. Do not reformat or "improve". No `any`, no `@ts-ignore`, no console.log.
4. **Import rule.** Add the PanelCard import in the file's existing import group, exactly as the task specifies (path differs per directory — use the task's literal string).
5. **TYPECHECK PROTOCOL.** Whenever a step says "Typecheck", run EXACTLY:
   ```bash
   bunx tsc --noEmit -p tsconfig.json 2>&1 | grep -E "error TS" | grep -vE "TS6142|server\.ts\(6,33\)" | grep "litellm-portal/" | grep -vE "litellm-portal/(ui|i18n|errors|a11y|hooks|lib|components|dashboard-schemas)" || echo "MIGRATION TYPECHECK CLEAN"
   ```
   Expected output: the single line `MIGRATION TYPECHECK CLEAN`. A bare `TS6142` is pre-existing noise, NEVER a stop reason. Any real error line for the file you edited → STOP and report.
6. **Ratchet shrink step (every task).** After the edit, run EXACTLY:
   ```bash
   UPDATE_RATCHET_BASELINE=1 pnpm exec vitest run src/litellm-portal/ui/ratchet.test.ts
   ```
   then run WITHOUT the env var:
   ```bash
   pnpm exec vitest run src/litellm-portal/ui
   ```
   Expected: full `ui` suite all pass (ratchet now green with the shrunk baseline). If the migrated file is STILL in `src/litellm-portal/ui/ratchet-baseline.json` after this, your edit did not remove all `rounded-xl`+`ring-1`/`border border-kumo-line` from it → STOP and report.
7. **STOP rule.** Any command output not matching Expected → STOP, report full output, do not continue, do not "fix" by editing other files.
8. **One commit per task**, scope `litellm-portal`, exact message from the task. Never push / rebase / amend / switch branches.
9. **Working directory** for every command: `/Users/xumingyang/github/contrabass/cloud`.

---

## Task 1: `dashboard/panels/alert-panel.tsx`

**Files:** Modify `src/litellm-portal/dashboard/panels/alert-panel.tsx`, `src/litellm-portal/ui/ratchet-baseline.json`

- [ ] **Step 1: Add import.** In `src/litellm-portal/dashboard/panels/alert-panel.tsx`, change line 1 from:
```tsx
import React from "react";
```
to:
```tsx
import React from "react";
import { PanelCard } from "../../ui";
```

- [ ] **Step 2: Replace the card wrapper.** Replace EXACTLY this block:
```tsx
    <div className="mb-4 rounded-xl border border-kumo-line bg-kumo-base p-5">
      <div className="mb-2 text-xs uppercase tracking-wider text-kumo-subtle">告警面板</div>
      {alerts.map((a, i) => (
```
with EXACTLY:
```tsx
    <PanelCard title="告警面板">
      {alerts.map((a, i) => (
```

- [ ] **Step 3: Close the wrapper.** Replace EXACTLY this block (the end of the component):
```tsx
      ))}
    </div>
  );
}
```
with EXACTLY:
```tsx
      ))}
    </PanelCard>
  );
}
```

- [ ] **Step 4: Typecheck.** Run the §5 TYPECHECK PROTOCOL command. Expected: `MIGRATION TYPECHECK CLEAN`.

- [ ] **Step 5: Ratchet shrink + suite.** Run the two §6 commands. Expected: full `ui` suite passes; `alert-panel.tsx` no longer in baseline.

- [ ] **Step 6: Commit.**
```bash
git add src/litellm-portal/dashboard/panels/alert-panel.tsx src/litellm-portal/ui/ratchet-baseline.json
git commit -m "refactor(litellm-portal): migrate alert-panel card to PanelCard"
```

---

## Task 2: `dashboard/panels/kpi-band.tsx`

**Files:** Modify `src/litellm-portal/dashboard/panels/kpi-band.tsx`, `src/litellm-portal/ui/ratchet-baseline.json`

- [ ] **Step 1: Add import.** Change line 1-2 from:
```tsx
import React from "react";
import { fmtCompact } from "../../lib/format";
```
to:
```tsx
import React from "react";
import { fmtCompact } from "../../lib/format";
import { PanelCard } from "../../ui";
```

- [ ] **Step 2: Replace the inner Card chrome.** Replace EXACTLY:
```tsx
  return (
    <div className="rounded-xl border border-kumo-line bg-kumo-base p-5">
      <div className="text-xs uppercase tracking-wider text-kumo-subtle">{label}</div>
      <div className="mt-1 font-mono text-2xl font-semibold tabular-nums text-kumo-strong">{value}</div>
      <div className="mt-1 text-xs"><Delta pct={pct} /></div>
    </div>
  );
```
with EXACTLY:
```tsx
  return (
    <PanelCard>
      <div className="text-xs uppercase tracking-wider text-kumo-subtle">{label}</div>
      <div className="mt-1 font-mono text-2xl font-semibold tabular-nums text-kumo-strong">{value}</div>
      <div className="mt-1 text-xs"><Delta pct={pct} /></div>
    </PanelCard>
  );
```

- [ ] **Step 3: Typecheck.** §5 command. Expected: `MIGRATION TYPECHECK CLEAN`.
- [ ] **Step 4: Ratchet shrink + suite.** §6 commands. Expected: `ui` suite passes; `kpi-band.tsx` gone from baseline.
- [ ] **Step 5: Commit.**
```bash
git add src/litellm-portal/dashboard/panels/kpi-band.tsx src/litellm-portal/ui/ratchet-baseline.json
git commit -m "refactor(litellm-portal): migrate kpi-band card to PanelCard"
```

---

## Task 3: `app/keys-card.tsx`

**Files:** Modify `src/litellm-portal/app/keys-card.tsx`, `src/litellm-portal/ui/ratchet-baseline.json`

- [ ] **Step 1: Add import.** After this existing line:
```tsx
import { CreateKeyButton } from "./create-key-button";
```
add EXACTLY this new line directly below it:
```tsx
import { PanelCard } from "../ui";
```

- [ ] **Step 2: Replace the outer section + header band.** Replace EXACTLY:
```tsx
    <section className="overflow-hidden rounded-xl bg-kumo-base ring-1 ring-kumo-line">
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-kumo-line bg-kumo-elevated p-6">
        <div>
          <Text variant="heading3" as="p">API Keys</Text>
          <Text variant="secondary" as="p">仅列出当前 LiteLLM 用户拥有的密钥。</Text>
        </div>
        <CreateKeyButton />
      </div>
      <div className="overflow-x-auto">
```
with EXACTLY:
```tsx
    <PanelCard
      title="API Keys"
      subtitle="仅列出当前 LiteLLM 用户拥有的密钥。"
      actions={<CreateKeyButton />}
      padded={false}
    >
      <div className="overflow-x-auto">
```

- [ ] **Step 3: Close the wrapper.** Replace EXACTLY this block (component end):
```tsx
        )}
      </div>
    </section>
  );
}
```
with EXACTLY:
```tsx
        )}
      </div>
    </PanelCard>
  );
}
```

- [ ] **Step 4: Typecheck.** §5 command. Expected: `MIGRATION TYPECHECK CLEAN`.
- [ ] **Step 5: Ratchet shrink + suite.** §6 commands. Expected: `ui` suite passes; `app/keys-card.tsx` gone from baseline.
- [ ] **Step 6: Commit.**
```bash
git add src/litellm-portal/app/keys-card.tsx src/litellm-portal/ui/ratchet-baseline.json
git commit -m "refactor(litellm-portal): migrate ApiKeysCard shell to PanelCard"
```

---

## Task 4: `ops-console/screens/user-detail.tsx`

**Files:** Modify `src/litellm-portal/ops-console/screens/user-detail.tsx`, `src/litellm-portal/ui/ratchet-baseline.json`

- [ ] **Step 1: Add import.** After this existing line:
```tsx
import { PanelSkeleton, PanelEmpty, PanelError } from "../../components/panel-state";
```
add EXACTLY directly below:
```tsx
import { PanelCard } from "../../ui";
```

- [ ] **Step 2: Replace the article + header band.** Replace EXACTLY:
```tsx
      <article className="overflow-hidden rounded-xl bg-kumo-base ring-1 ring-kumo-line">
        <div className="border-b border-kumo-line bg-kumo-elevated p-6">
          <Text variant="heading3" as="p">{data.email}</Text>
          <Text variant="secondary" as="p">{data.userId}</Text>
        </div>
        <dl className="grid grid-cols-2 gap-4 p-6 text-sm sm:grid-cols-3">
```
with EXACTLY:
```tsx
      <PanelCard title={data.email} subtitle={data.userId} padded={false}>
        <dl className="grid grid-cols-2 gap-4 p-6 text-sm sm:grid-cols-3">
```

- [ ] **Step 3: Close the wrapper.** Replace EXACTLY:
```tsx
        </dl>
      </article>
    </div>
  );
}
```
with EXACTLY:
```tsx
        </dl>
      </PanelCard>
    </div>
  );
}
```

- [ ] **Step 4: Typecheck.** §5 command. Expected: `MIGRATION TYPECHECK CLEAN`.
- [ ] **Step 5: Ratchet shrink + suite.** §6 commands. Expected: `ui` suite passes; file gone from baseline.
- [ ] **Step 6: Commit.**
```bash
git add src/litellm-portal/ops-console/screens/user-detail.tsx src/litellm-portal/ui/ratchet-baseline.json
git commit -m "refactor(litellm-portal): migrate ops user-detail card to PanelCard"
```

---

## Task 5: `ops-console/screens/tenant-overview.tsx`

**Files:** Modify `src/litellm-portal/ops-console/screens/tenant-overview.tsx`, `src/litellm-portal/ui/ratchet-baseline.json`

- [ ] **Step 1: Add import.** After this existing line:
```tsx
import { densityClasses, useDensity } from "../../components/density";
```
add EXACTLY directly below:
```tsx
import { PanelCard } from "../../ui";
```

- [ ] **Step 2: Replace the article + header band.** Replace EXACTLY:
```tsx
      <article className="overflow-hidden rounded-xl bg-kumo-base ring-1 ring-kumo-line">
        <div className="border-b border-l-2 border-kumo-line border-l-kumo-brand bg-kumo-elevated p-6">
          <Text variant="heading3" as="p"><Trans>租户总览</Trans></Text>
          <Text variant="secondary" as="p">
            <Trans>所有租户的成员、花费、告警与账单状态。</Trans>
          </Text>
        </div>
        <TenantsTable />
      </article>
```
with EXACTLY:
```tsx
      <PanelCard title={t`租户总览`} subtitle={t`所有租户的成员、花费、告警与账单状态。`} padded={false}>
        <TenantsTable />
      </PanelCard>
```

- [ ] **Step 3: Typecheck.** §5 command. Expected: `MIGRATION TYPECHECK CLEAN`. (Note: `t` is already imported in this file — `import { t } from "@lingui/core/macro";` — do NOT add it again. If a real error says `t` is undefined, STOP and report.)
- [ ] **Step 4: Ratchet shrink + suite.** §6 commands. Expected: `ui` suite passes; file gone from baseline.
- [ ] **Step 5: Commit.**
```bash
git add src/litellm-portal/ops-console/screens/tenant-overview.tsx src/litellm-portal/ui/ratchet-baseline.json
git commit -m "refactor(litellm-portal): migrate ops tenant-overview card to PanelCard"
```

---

## Task 6: `ops-console/screens/platform-settings.tsx`

**Files:** Modify `src/litellm-portal/ops-console/screens/platform-settings.tsx`, `src/litellm-portal/ui/ratchet-baseline.json`

- [ ] **Step 1: Add import.** After this existing line:
```tsx
import { PanelSkeleton, PanelError } from "../../components/panel-state";
```
add EXACTLY directly below:
```tsx
import { PanelCard } from "../../ui";
```

- [ ] **Step 2: Replace the article + header band.** Replace EXACTLY:
```tsx
      <article className="overflow-hidden rounded-xl bg-kumo-base ring-1 ring-kumo-line">
        <div className="border-b border-kumo-line bg-kumo-elevated p-6">
          <Text variant="heading3" as="p"><Trans>平台设置</Trans></Text>
          <Text variant="secondary" as="p">
            <Trans>平台名称、写操作开关与相关管理入口。</Trans>
          </Text>
        </div>
        <PlatformSettingsBody />
      </article>
```
with EXACTLY:
```tsx
      <PanelCard title={t`平台设置`} subtitle={t`平台名称、写操作开关与相关管理入口。`} padded={false}>
        <PlatformSettingsBody />
      </PanelCard>
```

- [ ] **Step 3: Typecheck.** §5 command. Expected: `MIGRATION TYPECHECK CLEAN`. (`t` is already imported in this file via `import { t } from "@lingui/core/macro";` — do NOT re-add.)
- [ ] **Step 4: Ratchet shrink + suite.** §6 commands. Expected: `ui` suite passes; file gone from baseline.
- [ ] **Step 5: Commit.**
```bash
git add src/litellm-portal/ops-console/screens/platform-settings.tsx src/litellm-portal/ui/ratchet-baseline.json
git commit -m "refactor(litellm-portal): migrate ops platform-settings card to PanelCard"
```

---

## Task 7: Batch verification (no commit)

- [ ] **Step 1:** `pnpm exec vitest run src/litellm-portal/ui` → all pass (21).
- [ ] **Step 2:** §5 TYPECHECK PROTOCOL → `MIGRATION TYPECHECK CLEAN`.
- [ ] **Step 3:** `node -e "console.log(require('./src/litellm-portal/ui/ratchet-baseline.json').length)"` → expected `10` (16 − 6 migrated).
- [ ] **Step 4:** `git diff --name-only main...HEAD | grep -c .` includes the 6 migrated files + baseline; no unexpected files. Report the list.

**DoD:** 6 files use `<PanelCard>`, zero hand-written card chrome remains in them, baseline shrunk 16→10, `ui` suite green, typecheck clean, 6 commits.

## Out of scope
Remaining 10 baseline files (app.tsx, create-key-button, member-overlay, audit, provisioning, tenant-detail, alerts, billing, members, overview) → Batch-2+. PageShell / SideNav→Kumo sidebar / archetypes → later plans.
