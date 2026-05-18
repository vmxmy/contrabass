# LiteLLM Portal — PanelCard 迁移 Batch-3（4 个 offender，10 处 chrome）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development / executing-plans. Steps use `- [ ]`.

**Goal:** 迁移 alerts(2) / members(2) / provisioning(3) / overview-TopModelsTile(3) 到 `PanelCard`，基线 6→2。剩 2 个（app.tsx、member-overlay）是 God Component，明确推迟到拆分专项 plan，保留在基线由棘轮继续追踪。

**Architecture:** 同 Batch-1/2：纯替换外层卡片容器为 `<PanelCard>`，子内容逐字保留，header 统一到 PanelCard sm header（审计 S3 有意收敛）。overview 的 TopModelsTile 三个状态分支各自替换为带 `state` 的 PanelCard（不合并 return，保持机械低风险）。

**Tech Stack:** React, TS strict, Kumo, Vitest, pnpm。

---

## Instructions for the implementing agent (Kimi) — read fully before Task 1

1. **Scope lock.** Each task lists ONE source file + `src/litellm-portal/ui/ratchet-baseline.json`. Touch ONLY those. Never modify `ui/panel-card.tsx`, `ui/ratchet*`, `panel-state.tsx`, `density.tsx`.
2. **Preserve inner content exactly.** Replace ONLY the wrapper + header band per OLD→NEW. Every child copied VERBATIM.
3. **Verbatim.** Apply OLD→NEW exactly. No reformat, no `any`, no `@ts-ignore`. If an OLD block is not found exactly, STOP and report (do not improvise). NOTE: `provisioning.tsx` `InviteForm` contains a pre-existing `} as never,` — that is NOT yours to fix; leave it untouched, it is outside every OLD block.
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
   Expected: full `ui` suite passes. If the migrated file is STILL in `ratchet-baseline.json`, you missed a chrome occurrence → STOP and report.
6. **STOP rule.** Any output ≠ Expected → STOP, report task/step + full output, do not continue.
7. **One commit per task**, scope `litellm-portal`, exact message. Never push / rebase / amend / switch branches.
8. **Working directory** for every command: `/Users/xumingyang/github/contrabass/cloud`.

---

## Task 1: `tenant-portal/screens/alerts.tsx` (2 cards)

**Files:** Modify `src/litellm-portal/tenant-portal/screens/alerts.tsx`, `src/litellm-portal/ui/ratchet-baseline.json`

- [ ] **Step 1: Add import.** After this existing line:
```tsx
import { MemberForbidden } from "../routes";
```
add EXACTLY below it:
```tsx
import { PanelCard } from "../../ui";
```

- [ ] **Step 2: Migrate both cards.** Replace EXACTLY:
```tsx
      <article className="overflow-hidden rounded-xl bg-kumo-base ring-1 ring-kumo-line">
        <div className="border-b border-kumo-line bg-kumo-elevated p-6">
          <Text variant="heading3" as="p"><Trans>告警 Webhook</Trans></Text>
          <Text variant="secondary" as="p">
            <Trans>配置预算告警通知的 Webhook 地址。</Trans>
          </Text>
        </div>
        <CurrentWebhookStatus />
      </article>
      <article className="overflow-hidden rounded-xl bg-kumo-base ring-1 ring-kumo-line">
        <div className="border-b border-kumo-line bg-kumo-elevated p-6">
          <Text variant="heading3" as="p"><Trans>更新 Webhook</Trans></Text>
          <Text variant="secondary" as="p">
            <Trans>设置或清除告警 Webhook URL。客户端不校验 URL，服务端负责安全验证。</Trans>
          </Text>
        </div>
        <WebhookConfigForm />
      </article>
```
with EXACTLY:
```tsx
      <PanelCard
        title={t`告警 Webhook`}
        subtitle={t`配置预算告警通知的 Webhook 地址。`}
        padded={false}
      >
        <CurrentWebhookStatus />
      </PanelCard>
      <PanelCard
        title={t`更新 Webhook`}
        subtitle={t`设置或清除告警 Webhook URL。客户端不校验 URL，服务端负责安全验证。`}
        padded={false}
      >
        <WebhookConfigForm />
      </PanelCard>
```

- [ ] **Step 3: Typecheck.** §4 command. Expected: `MIGRATION TYPECHECK CLEAN`. (`t` already imported in alerts.tsx.)
- [ ] **Step 4: Ratchet shrink + suite.** §5 commands. Expected: pass; `tenant-portal/screens/alerts.tsx` gone from baseline.
- [ ] **Step 5: Commit.**
```bash
git add src/litellm-portal/tenant-portal/screens/alerts.tsx src/litellm-portal/ui/ratchet-baseline.json
git commit -m "refactor(litellm-portal): migrate tenant alerts cards to PanelCard"
```

---

## Task 2: `tenant-portal/screens/members.tsx` (2 cards)

**Files:** Modify `src/litellm-portal/tenant-portal/screens/members.tsx`, `src/litellm-portal/ui/ratchet-baseline.json`

- [ ] **Step 1: Add import.** After this existing line:
```tsx
import { PanelSkeleton, PanelEmpty, PanelError } from "../../components/panel-state";
```
add EXACTLY below it:
```tsx
import { PanelCard } from "../../ui";
```

- [ ] **Step 2: Migrate CreateInviteForm card.** Replace EXACTLY:
```tsx
    <article className="overflow-hidden rounded-xl bg-kumo-base ring-1 ring-kumo-line">
      <div className="border-b border-kumo-line bg-kumo-elevated p-6">
        <Text variant="heading3" as="p"><Trans>发送邀请</Trans></Text>
        <Text variant="secondary" as="p">
          <Trans>邀请新成员加入当前团队。</Trans>
        </Text>
      </div>
      <div className="space-y-5 p-6">
```
with EXACTLY:
```tsx
    <PanelCard
      title={t`发送邀请`}
      subtitle={t`邀请新成员加入当前团队。`}
      padded={false}
    >
      <div className="space-y-5 p-6">
```

- [ ] **Step 3: Close CreateInviteForm card.** Replace EXACTLY:
```tsx
        </div>
      </div>
    </article>
  );
}

// ---------------------------------------------------------------------------
// InvitesTable
```
with EXACTLY:
```tsx
        </div>
      </div>
    </PanelCard>
  );
}

// ---------------------------------------------------------------------------
// InvitesTable
```

- [ ] **Step 4: Migrate the screen's InvitesTable card.** Replace EXACTLY:
```tsx
      <article className="overflow-hidden rounded-xl bg-kumo-base ring-1 ring-kumo-line">
        <div className="border-b border-kumo-line bg-kumo-elevated p-6">
          <Text variant="heading3" as="p"><Trans>成员与邀请</Trans></Text>
          <Text variant="secondary" as="p">
            <Trans>管理团队成员的邀请状态。</Trans>
          </Text>
        </div>
        <InvitesTable />
      </article>
```
with EXACTLY:
```tsx
      <PanelCard
        title={t`成员与邀请`}
        subtitle={t`管理团队成员的邀请状态。`}
        padded={false}
      >
        <InvitesTable />
      </PanelCard>
```

- [ ] **Step 5: Typecheck.** §4 command. Expected: `MIGRATION TYPECHECK CLEAN`. (`t` already imported.)
- [ ] **Step 6: Ratchet shrink + suite.** §5 commands. Expected: pass; file gone from baseline.
- [ ] **Step 7: Commit.**
```bash
git add src/litellm-portal/tenant-portal/screens/members.tsx src/litellm-portal/ui/ratchet-baseline.json
git commit -m "refactor(litellm-portal): migrate tenant members cards to PanelCard"
```

---

## Task 3: `ops-console/screens/provisioning.tsx` (3 cards)

**Files:** Modify `src/litellm-portal/ops-console/screens/provisioning.tsx`, `src/litellm-portal/ui/ratchet-baseline.json`

- [ ] **Step 1: Add import.** After this existing line:
```tsx
import { PanelError } from "../../components/panel-state";
```
add EXACTLY below it:
```tsx
import { PanelCard } from "../../ui";
```

- [ ] **Step 2: Migrate CreateTeamForm.** Replace EXACTLY:
```tsx
    <article className="overflow-hidden rounded-xl bg-kumo-base ring-1 ring-kumo-line">
      <div className="border-b border-kumo-line bg-kumo-elevated p-6">
        <Text variant="heading3" as="p"><Trans>创建团队</Trans></Text>
        <Text variant="secondary" as="p">
          <Trans>为新租户创建一个团队。</Trans>
        </Text>
      </div>
      <div className="space-y-5 p-6">
```
with EXACTLY:
```tsx
    <PanelCard
      title={t`创建团队`}
      subtitle={t`为新租户创建一个团队。`}
      padded={false}
    >
      <div className="space-y-5 p-6">
```

- [ ] **Step 3: Close CreateTeamForm + open InviteForm migration.** Replace EXACTLY:
```tsx
        </div>
      </div>
    </article>
  );
}

// ---------------------------------------------------------------------------
// InviteForm
```
with EXACTLY:
```tsx
        </div>
      </div>
    </PanelCard>
  );
}

// ---------------------------------------------------------------------------
// InviteForm
```

- [ ] **Step 4: Migrate InviteForm header.** Replace EXACTLY:
```tsx
    <article className="overflow-hidden rounded-xl bg-kumo-base ring-1 ring-kumo-line">
      <div className="border-b border-kumo-line bg-kumo-elevated p-6">
        <Text variant="heading3" as="p"><Trans>发送邀请</Trans></Text>
        <Text variant="secondary" as="p">
          <Trans>邀请用户加入指定团队。</Trans>
        </Text>
      </div>
      <div className="space-y-5 p-6">
```
with EXACTLY:
```tsx
    <PanelCard
      title={t`发送邀请`}
      subtitle={t`邀请用户加入指定团队。`}
      padded={false}
    >
      <div className="space-y-5 p-6">
```

- [ ] **Step 5: Close InviteForm.** Replace EXACTLY:
```tsx
        </div>
      </div>
    </article>
  );
}

// ---------------------------------------------------------------------------
// TenantRoleForm
```
with EXACTLY:
```tsx
        </div>
      </div>
    </PanelCard>
  );
}

// ---------------------------------------------------------------------------
// TenantRoleForm
```

- [ ] **Step 6: Migrate TenantRoleForm header.** Replace EXACTLY:
```tsx
    <article className="overflow-hidden rounded-xl bg-kumo-base ring-1 ring-kumo-line">
      <div className="border-b border-kumo-line bg-kumo-elevated p-6">
        <Text variant="heading3" as="p"><Trans>指派租户角色</Trans></Text>
        <Text variant="secondary" as="p">
          <Trans>为团队成员指派租户管理员或成员角色。</Trans>
        </Text>
      </div>
      <div className="space-y-5 p-6">
```
with EXACTLY:
```tsx
    <PanelCard
      title={t`指派租户角色`}
      subtitle={t`为团队成员指派租户管理员或成员角色。`}
      padded={false}
    >
      <div className="space-y-5 p-6">
```

- [ ] **Step 7: Close TenantRoleForm.** Replace EXACTLY:
```tsx
        </div>
      </div>
    </article>
  );
}

// ---------------------------------------------------------------------------
// OpsProvisioningScreen
```
with EXACTLY:
```tsx
        </div>
      </div>
    </PanelCard>
  );
}

// ---------------------------------------------------------------------------
// OpsProvisioningScreen
```

- [ ] **Step 8: Typecheck.** §4 command. Expected: `MIGRATION TYPECHECK CLEAN`. (`t` already imported. The pre-existing `} as never,` is untouched and out of scope.)
- [ ] **Step 9: Ratchet shrink + suite.** §5 commands. Expected: pass; file gone from baseline.
- [ ] **Step 10: Commit.**
```bash
git add src/litellm-portal/ops-console/screens/provisioning.tsx src/litellm-portal/ui/ratchet-baseline.json
git commit -m "refactor(litellm-portal): migrate ops provisioning forms to PanelCard"
```

---

## Task 4: `tenant-portal/screens/overview.tsx` — TopModelsTile (3 state branches)

**Files:** Modify `src/litellm-portal/tenant-portal/screens/overview.tsx`, `src/litellm-portal/ui/ratchet-baseline.json`

- [ ] **Step 1: Add import.** After this existing line:
```tsx
import { fmt, fmtInt, fmtCompact } from "../../lib/format";
```
add EXACTLY below it:
```tsx
import { PanelCard } from "../../ui";
```

- [ ] **Step 2: Migrate the loading branch.** Replace EXACTLY:
```tsx
    return (
      <article className="overflow-hidden rounded-xl bg-kumo-base ring-1 ring-kumo-line">
        <div className="border-b border-kumo-line bg-kumo-elevated p-6">
          <Text variant="heading3" as="p">
            <Trans>高频模型</Trans>
          </Text>
        </div>
        <PanelSkeleton lines={2} />
      </article>
    );
  }

  const models = data?.models?.models ?? [];
```
with EXACTLY:
```tsx
    return (
      <PanelCard title={t`高频模型`} state={{ kind: "loading", lines: 2 }} />
    );
  }

  const models = data?.models?.models ?? [];
```

- [ ] **Step 3: Migrate the empty branch.** Replace EXACTLY:
```tsx
    return (
      <article className="overflow-hidden rounded-xl bg-kumo-base ring-1 ring-kumo-line">
        <div className="border-b border-kumo-line bg-kumo-elevated p-6">
          <Text variant="heading3" as="p">
            <Trans>高频模型</Trans>
          </Text>
        </div>
        <PanelEmpty title={t`暂无模型数据`} />
      </article>
    );
  }

  const preview = models.slice(0, 5);
```
with EXACTLY:
```tsx
    return (
      <PanelCard
        title={t`高频模型`}
        state={{ kind: "empty", title: t`暂无模型数据` }}
      />
    );
  }

  const preview = models.slice(0, 5);
```

- [ ] **Step 4: Migrate the main branch.** Replace EXACTLY:
```tsx
    <article className="overflow-hidden rounded-xl bg-kumo-base ring-1 ring-kumo-line">
      <div className="flex items-center justify-between border-b border-kumo-line bg-kumo-elevated p-6">
        <div className="flex items-center gap-2">
          <Cpu className="h-4 w-4 text-kumo-brand" />
          <Text variant="heading3" as="p">
            <Trans>高频模型</Trans>
          </Text>
        </div>
        <Badge variant="outline" className="rounded-full">
          {models.length} <Trans>个模型</Trans>
        </Badge>
      </div>
      <div className="flex flex-wrap gap-2 p-6">
```
with EXACTLY:
```tsx
    <PanelCard
      title={t`高频模型`}
      icon={<Cpu className="h-4 w-4 text-kumo-brand" />}
      actions={
        <Badge variant="outline" className="rounded-full">
          {models.length} <Trans>个模型</Trans>
        </Badge>
      }
      padded={false}
    >
      <div className="flex flex-wrap gap-2 p-6">
```

- [ ] **Step 5: Close the main branch.** Replace EXACTLY:
```tsx
        ) : null}
      </div>
    </article>
  );
}

// ---------------------------------------------------------------------------
// RecentActivityTile
```
with EXACTLY:
```tsx
        ) : null}
      </div>
    </PanelCard>
  );
}

// ---------------------------------------------------------------------------
// RecentActivityTile
```

- [ ] **Step 6: Typecheck.** §4 command. Expected: `MIGRATION TYPECHECK CLEAN`. (`t` already imported in overview.tsx. If a real error says `Text` or `PanelSkeleton`/`PanelEmpty` is now unused, IGNORE — they are still used elsewhere in this file; only a real error for a symbol you removed should stop you, in which case STOP and report.)
- [ ] **Step 7: Ratchet shrink + suite.** §5 commands. Expected: pass; `tenant-portal/screens/overview.tsx` gone from baseline.
- [ ] **Step 8: Commit.**
```bash
git add src/litellm-portal/tenant-portal/screens/overview.tsx src/litellm-portal/ui/ratchet-baseline.json
git commit -m "refactor(litellm-portal): migrate overview TopModelsTile to PanelCard state machine"
```

---

## Task 5: Batch verification (no commit)

- [ ] **Step 1:** `pnpm exec vitest run src/litellm-portal/ui` → all pass (21).
- [ ] **Step 2:** §4 TYPECHECK PROTOCOL → `MIGRATION TYPECHECK CLEAN`.
- [ ] **Step 3:** `node -e "const b=require('./src/litellm-portal/ui/ratchet-baseline.json');console.log(b.length);console.log(b.join(','))"` → expected length `2`, contents exactly `app.tsx,dashboard/views/member-overlay.tsx`.
- [ ] **Step 4:** Report `git log --oneline` of the 4 new commits; confirm only the 4 source files + baseline changed.

**DoD:** alerts/members/provisioning/overview use `<PanelCard>`, baseline 6→2 (only `app.tsx` + `dashboard/views/member-overlay.tsx` remain — both God Components, deferred), `ui` suite green, typecheck clean, 4 commits.

## Out of scope (explicit)
- `app.tsx` (493L) and `dashboard/views/member-overlay.tsx` (God Component, 4 nested ambiguous divs) → deferred to a dedicated **God-Component decomposition plan** (Batch-4), where card migration happens as part of the larger structural rework, not a fragile partial substitution. They remain in `ratchet-baseline.json`; the ratchet stays green and still blocks NEW chrome.
- PageShell / SideNav→Kumo sidebar / layout slot grammar / screen archetypes / density adoption / Error Boundary coverage → subsequent plans.
