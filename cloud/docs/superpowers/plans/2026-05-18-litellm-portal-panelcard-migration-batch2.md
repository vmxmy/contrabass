# LiteLLM Portal — PanelCard 迁移 Batch-2（4 个中等 offender）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development / executing-plans. Steps use `- [ ]`.

**Goal:** 把 4 个中等复杂度违规文件（create-key-button / billing / tenant-detail / audit，共 6 处 chrome）迁移到 `PanelCard`，基线 10→6。

**Architecture:** 同 Batch-1：纯替换外层卡片容器为 `<PanelCard>`，子内容逐字保留，header 大标题统一到 PanelCard sm header（审计 S3 有意收敛）。两个特例已在任务内显式处理：(1) create-key-button 的 chrome 在 Kumo `<Surface>`（模态内块），迁移后删除已无用的 `Surface` import；(2) audit 详情卡的 `id="ops-audit-detail-root"` 锚点用外层 `<div id>` 保留。

**Tech Stack:** React, TS strict, Kumo, Vitest, pnpm。

---

## Instructions for the implementing agent (Kimi) — read fully before Task 1

1. **Scope lock.** Each task lists ONE source file + `src/litellm-portal/ui/ratchet-baseline.json`. Touch ONLY those. Never modify `ui/panel-card.tsx`, `ui/ratchet*`, `panel-state.tsx`, `density.tsx`.
2. **Preserve inner content exactly.** Replace ONLY the outer wrapper + header band per the OLD→NEW blocks. Every child copied VERBATIM.
3. **Verbatim.** Apply OLD→NEW exactly. No reformat, no `any`, no `@ts-ignore`, no console.log. If an OLD block is not found exactly, STOP and report (do not improvise).
4. **TYPECHECK PROTOCOL.** When a step says "Typecheck", run EXACTLY:
   ```bash
   bunx tsc --noEmit -p tsconfig.json 2>&1 | grep -E "error TS" | grep -vE "TS6142|server\.ts\(6,33\)" | grep "litellm-portal/" | grep -vE "litellm-portal/(ui|i18n|errors|a11y|hooks|lib|components|dashboard-schemas)" || echo "MIGRATION TYPECHECK CLEAN"
   ```
   Expected: single line `MIGRATION TYPECHECK CLEAN`. A bare `TS6142` is NEVER a stop reason. A real error line for the file you edited → STOP and report.
5. **Ratchet shrink (every task).** After the edits run EXACTLY:
   ```bash
   UPDATE_RATCHET_BASELINE=1 pnpm exec vitest run src/litellm-portal/ui/ratchet.test.ts
   ```
   then:
   ```bash
   pnpm exec vitest run src/litellm-portal/ui
   ```
   Expected: full `ui` suite passes. If the migrated file is STILL in `src/litellm-portal/ui/ratchet-baseline.json`, you missed a `rounded-xl`+`ring-1`/`border border-kumo-line` occurrence → STOP and report.
6. **STOP rule.** Any output ≠ Expected → STOP, report task/step + full output, do not continue.
7. **One commit per task**, scope `litellm-portal`, exact message. Never push / rebase / amend / switch branches.
8. **Working directory** for every command: `/Users/xumingyang/github/contrabass/cloud`.

---

## Task 1: `app/create-key-button.tsx` (chrome is on a Kumo `<Surface>` inside the Dialog)

**Files:** Modify `src/litellm-portal/app/create-key-button.tsx`, `src/litellm-portal/ui/ratchet-baseline.json`

- [ ] **Step 1: Remove the now-unused Surface import.** Delete EXACTLY this line:
```tsx
import { Surface } from "@cloudflare/kumo/components/surface";
```

- [ ] **Step 2: Add the PanelCard import.** Immediately after this existing line:
```tsx
} from "./utils";
```
add EXACTLY a new line below it:
```tsx
import { PanelCard } from "../ui";
```

- [ ] **Step 3: Replace the Surface opening tag.** Replace EXACTLY:
```tsx
            <Surface className="rounded-xl p-5 ring-1 ring-kumo-line">
```
with EXACTLY:
```tsx
            <PanelCard>
```

- [ ] **Step 4: Replace the Surface closing tag.** Replace EXACTLY:
```tsx
              ) : null}
            </Surface>
```
with EXACTLY:
```tsx
              ) : null}
            </PanelCard>
```

- [ ] **Step 5: Typecheck.** §4 command. Expected: `MIGRATION TYPECHECK CLEAN`. (If a real error says `Surface` is still referenced, you missed Step 1/3/4 — STOP and report.)
- [ ] **Step 6: Ratchet shrink + suite.** §5 commands. Expected: `ui` suite passes; `app/create-key-button.tsx` gone from baseline.
- [ ] **Step 7: Commit.**
```bash
git add src/litellm-portal/app/create-key-button.tsx src/litellm-portal/ui/ratchet-baseline.json
git commit -m "refactor(litellm-portal): migrate create-key success surface to PanelCard"
```

---

## Task 2: `tenant-portal/screens/billing.tsx`

**Files:** Modify `src/litellm-portal/tenant-portal/screens/billing.tsx`, `src/litellm-portal/ui/ratchet-baseline.json`

- [ ] **Step 1: Add import.** After this existing line:
```tsx
import { MemberForbidden } from "../routes";
```
add EXACTLY below it:
```tsx
import { PanelCard } from "../../ui";
```

- [ ] **Step 2: Replace the article + header band.** Replace EXACTLY:
```tsx
      <article className="overflow-hidden rounded-xl bg-kumo-base ring-1 ring-kumo-line">
        <div className="border-b border-kumo-line bg-kumo-elevated p-6">
          <Text variant="heading3" as="p"><Trans>账单下载</Trans></Text>
          <Text variant="secondary" as="p">
            <Trans>按账期下载团队 CSV 账单。服务端已按团队过滤，客户端不聚合数据。</Trans>
          </Text>
        </div>
        <BillingPeriodsTable />
      </article>
```
with EXACTLY:
```tsx
      <PanelCard
        title={t`账单下载`}
        subtitle={t`按账期下载团队 CSV 账单。服务端已按团队过滤，客户端不聚合数据。`}
        padded={false}
      >
        <BillingPeriodsTable />
      </PanelCard>
```

- [ ] **Step 3: Typecheck.** §4 command. Expected: `MIGRATION TYPECHECK CLEAN`. (`t` is already imported here via `import { t } from "@lingui/core/macro";` — do NOT re-add.)
- [ ] **Step 4: Ratchet shrink + suite.** §5 commands. Expected: pass; file gone from baseline.
- [ ] **Step 5: Commit.**
```bash
git add src/litellm-portal/tenant-portal/screens/billing.tsx src/litellm-portal/ui/ratchet-baseline.json
git commit -m "refactor(litellm-portal): migrate tenant billing card to PanelCard"
```

---

## Task 3: `ops-console/screens/tenant-detail.tsx` (TWO cards)

**Files:** Modify `src/litellm-portal/ops-console/screens/tenant-detail.tsx`, `src/litellm-portal/ui/ratchet-baseline.json`

- [ ] **Step 1: Add import.** After this existing line:
```tsx
import { densityClasses, useDensity } from "../../components/density";
```
add EXACTLY below it:
```tsx
import { PanelCard } from "../../ui";
```

- [ ] **Step 2: Migrate card 1 (header with action button).** Replace EXACTLY:
```tsx
      <article className="overflow-hidden rounded-xl bg-kumo-base ring-1 ring-kumo-line">
        <div className="flex items-start justify-between gap-4 border-b border-kumo-line bg-kumo-elevated p-6">
          <div>
            <Text variant="heading3" as="p">{data.alias ?? data.teamId}</Text>
            <Text variant="secondary" as="p">{data.teamId}</Text>
          </div>
          <Button
            variant="primary"
            size="sm"
            loading={startImpersonation.isPending}
            onClick={enterTenant}
          >
            <Trans>进入租户</Trans>
          </Button>
        </div>
        <dl className="grid grid-cols-2 gap-4 p-6 text-sm sm:grid-cols-4">
```
with EXACTLY:
```tsx
      <PanelCard
        title={data.alias ?? data.teamId}
        subtitle={data.teamId}
        actions={
          <Button
            variant="primary"
            size="sm"
            loading={startImpersonation.isPending}
            onClick={enterTenant}
          >
            <Trans>进入租户</Trans>
          </Button>
        }
        padded={false}
      >
        <dl className="grid grid-cols-2 gap-4 p-6 text-sm sm:grid-cols-4">
```

- [ ] **Step 3: Close card 1.** Replace EXACTLY:
```tsx
        </dl>
      </article>

      <article className="overflow-hidden rounded-xl bg-kumo-base ring-1 ring-kumo-line">
        <div className="border-b border-kumo-line bg-kumo-elevated p-6">
          <Text variant="heading3" as="p"><Trans>成员</Trans></Text>
          <Text variant="secondary" as="p">
            <Trans>该租户的所有成员及其门户角色与花费。</Trans>
          </Text>
        </div>
        {data.members.length === 0 ? (
```
with EXACTLY:
```tsx
        </dl>
      </PanelCard>

      <PanelCard
        title={t`成员`}
        subtitle={t`该租户的所有成员及其门户角色与花费。`}
        padded={false}
      >
        {data.members.length === 0 ? (
```

- [ ] **Step 4: Close card 2.** Replace EXACTLY:
```tsx
          </div>
        )}
      </article>
    </div>
  );
}
```
with EXACTLY:
```tsx
          </div>
        )}
      </PanelCard>
    </div>
  );
}
```

- [ ] **Step 5: Typecheck.** §4 command. Expected: `MIGRATION TYPECHECK CLEAN`. (`t` already imported here.)
- [ ] **Step 6: Ratchet shrink + suite.** §5 commands. Expected: pass; file gone from baseline.
- [ ] **Step 7: Commit.**
```bash
git add src/litellm-portal/ops-console/screens/tenant-detail.tsx src/litellm-portal/ui/ratchet-baseline.json
git commit -m "refactor(litellm-portal): migrate ops tenant-detail cards to PanelCard"
```

---

## Task 4: `ops-console/screens/audit.tsx` (TWO cards; preserve `id` anchor)

**Files:** Modify `src/litellm-portal/ops-console/screens/audit.tsx`, `src/litellm-portal/ui/ratchet-baseline.json`

- [ ] **Step 1: Add import.** After this existing line:
```tsx
import { BlockErrorBoundary } from "../../errors/error-boundary";
```
add EXACTLY below it:
```tsx
import { PanelCard } from "../../ui";
```

- [ ] **Step 2: Migrate the detail card (keep `id` via wrapper div).** Replace EXACTLY:
```tsx
    <article id="ops-audit-detail-root" className="overflow-hidden rounded-xl bg-kumo-base ring-1 ring-kumo-line">
      <div className="border-b border-kumo-line bg-kumo-elevated p-6">
        <Text variant="heading3" as="p"><Trans>审计事件详情</Trans></Text>
      </div>
      <dl className="grid grid-cols-1 gap-4 p-6 sm:grid-cols-2">
```
with EXACTLY:
```tsx
    <div id="ops-audit-detail-root">
      <PanelCard title={t`审计事件详情`} padded={false}>
      <dl className="grid grid-cols-1 gap-4 p-6 sm:grid-cols-2">
```

- [ ] **Step 3: Close the detail card.** Replace EXACTLY:
```tsx
      </dl>
    </article>
  );
}

function AuditFeedTable() {
```
with EXACTLY:
```tsx
      </dl>
      </PanelCard>
    </div>
  );
}

function AuditFeedTable() {
```

- [ ] **Step 4: Migrate the feed card.** Replace EXACTLY:
```tsx
        <article className="overflow-hidden rounded-xl bg-kumo-base ring-1 ring-kumo-line">
          <div className="border-b border-kumo-line bg-kumo-elevated p-6">
            <Text variant="heading3" as="p"><Trans>平台审计</Trans></Text>
            <Text variant="secondary" as="p">
              <Trans>跨租户的运营动作审计日志。</Trans>
            </Text>
          </div>
```
with EXACTLY:
```tsx
        <PanelCard
          title={t`平台审计`}
          subtitle={t`跨租户的运营动作审计日志。`}
          padded={false}
        >
```

- [ ] **Step 5: Close the feed card.** Replace EXACTLY:
```tsx
          <BlockErrorBoundary blockLabel="审计列表">
            <AuditFeedTable />
          </BlockErrorBoundary>
        </article>
      )}
```
with EXACTLY:
```tsx
          <BlockErrorBoundary blockLabel="审计列表">
            <AuditFeedTable />
          </BlockErrorBoundary>
        </PanelCard>
      )}
```

- [ ] **Step 6: Typecheck.** §4 command. Expected: `MIGRATION TYPECHECK CLEAN`. (`t` already imported in audit.tsx.)
- [ ] **Step 7: Ratchet shrink + suite.** §5 commands. Expected: pass; file gone from baseline.
- [ ] **Step 8: Commit.**
```bash
git add src/litellm-portal/ops-console/screens/audit.tsx src/litellm-portal/ui/ratchet-baseline.json
git commit -m "refactor(litellm-portal): migrate ops audit cards to PanelCard"
```

---

## Task 5: Batch verification (no commit)

- [ ] **Step 1:** `pnpm exec vitest run src/litellm-portal/ui` → all pass (21).
- [ ] **Step 2:** §4 TYPECHECK PROTOCOL → `MIGRATION TYPECHECK CLEAN`.
- [ ] **Step 3:** `node -e "console.log(require('./src/litellm-portal/ui/ratchet-baseline.json').length)"` → expected `6` (10 − 4 migrated).
- [ ] **Step 4:** Report `git log --oneline` of the 4 new commits and confirm only the 4 source files + baseline changed.

**DoD:** 4 files use `<PanelCard>` (create-key-button no longer imports `Surface`; audit keeps `id="ops-audit-detail-root"` via wrapper div), baseline 10→6, `ui` suite green, typecheck clean, 4 commits.

## Out of scope
Remaining 6 baseline files (app.tsx, member-overlay, provisioning, alerts, members, overview) → Batch-3. PageShell / SideNav→Kumo sidebar / archetypes / density adoption / Error Boundary coverage → later plans.
