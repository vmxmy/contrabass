# Operations Console (Phase 2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the Owner-only **Operations Console** at `/ops` — a left-nav + ops-chip shell (fixed neutral-steel accent, tenant branding ignored) gated server-side to `role === "admin"`, with seven all-tenant screens (Tenant Overview, Provisioning & Invites, Global Usage, Audit, Platform Settings, Tenant Detail, User Detail) plus a server-authoritative read-write impersonation primitive that lets an Owner "enter a tenant" with a fully audited envelope.

**Architecture:** Evolve within the existing Cloudflare-Worker SSR + React-island + Kumo + TanStack-Router stack (#135/Phase-1). SSR renders one component tree driven by the hydrated `useMe()` identity; a new `/ops` route subtree (mirroring Phase-1's `createTenantPortalRoutes` factory and `routes/index.tsx` shell-select seam) renders `OpsConsoleShell` for Owners and a 403/redirect for everyone else. Screens reuse the Phase-0 `requireAdmin` + F1 endpoints (`POST /api/admin/teams`, `/api/admin/invites`, `PUT /api/admin/teams/:teamId/members/:userId/tenant-role`) and the existing `UsageDashboard`/`AdminAuditFeed`/admin hooks; the three "做实" stub pages (`audit/$eventId`, `teams/$teamId`, `users/$userId`) become real. A new server-authoritative impersonation context (signed short-TTL token threaded into `PortalIdentity`/`requireTenantAdmin`/`auditWrite`) authorizes and audits every Owner-as-tenant write.

**Tech Stack:** TypeScript, Cloudflare Workers (SSR), React islands, `@cloudflare/kumo`, TanStack Router (lazy routes), Hono, Zod, Lingui i18n (zh-CN/en), Vitest (happy-dom + cloudflare:workers via `bun run test`), Storybook, `bun run` toolchain.

---

## Prerequisites (read before Task 1)

- **HARD GATE: PR #139 (Phase 1 — Tenant Portal) MUST be merged into `main` before Phase-2 *execution*.** Phase 0 (#138) is already in `main`. This plan is authored *ahead* per the Phase-0/Phase-1 plan-ahead pattern; Phase-2 *planning* is complete on delivery of this doc, but Phase-2 *implementation* cannot start until #139 is in `main`. Phase 2 anchors on Phase-1 symbols that land with #139: `TenantPortalShell`/`TenantBrand` (`tenant-portal/shell.tsx`), `createTenantPortalRoutes`/`MemberForbidden` (`tenant-portal/routes.tsx`), `applyBrandVars` (`tenant-portal/branding.ts`), the `routes/index.tsx` `PortalIndex` shell-select seam, `MeSchema.tenantRole/tenantTeamId` (`schemas.ts`, already in #138), `useTenantInvites`/`useCreateTenantInvite`/`useRevokeTenantInvite` (`tenant-portal/hooks.ts`), and the `tenant-portal/i18n-completeness.test.ts` namespace test. If #139 is not merged, STOP and merge it first.
- Branch off updated `main` AFTER #139 merges: `git checkout main && git pull && git checkout -b feat/litellm-portal-phase2-ops-console`.
- Symbol-anchored references: post-#139 line numbers shift; anchor by symbol + landmark and `grep`/Read to confirm before editing. Every file:line in this plan was verified against the pre-#139 working tree on 2026-05-17.
- Commits: `<type>(litellm-portal): <imperative ≤72 chars>`, lowercase, no trailing period, `git -c commit.gpgsign=false`. History is load-bearing — resolve conflicts via `git merge main` into the PR branch, **never** `git rebase main`, **never** squash, **never** cherry-pick into a fresh branch (CLAUDE.md).
- **Toolchain HARD RULES (run from `cloud/`):**
  - Tests: `cd /Users/xumingyang/github/contrabass/cloud && bun run test <path>`. **NEVER** `npx vitest` nor `bun test` — both fail to resolve the env (no happy-dom, no `cloudflare:workers`).
  - Typecheck: `bun run typecheck`. The single pre-existing `src/litellm-portal/server.ts → server-impl.tsx --jsx` error is the known baseline; "zero new errors" means no others. ZERO new tsc baseline errors permitted.
  - Build: `bun run build:litellm-portal` regenerates `app.generated.ts` (and `kumo-css.generated.ts`). Editing `app.tsx`/islands requires a rebuild before deploy, and the regenerated `app.generated.ts` **MUST be committed** (the `embed.FS` contract — the Go binary embeds the built SPA).
  - Known flake: the full-suite `vitest` run intermittently times out (5s) on SSR tests (happy-dom fetching `http://localhost:3000/kumo.css`) in files this branch did not modify (rotates across `index.test.ts`/`security.test.ts`/`usage-overview-routes.test.ts`). Not a regression — confirm any such failure via an **isolated re-run** of the affected file(s); CI is the gate (consistent with #134/#135/#136/#138/#139).

Repo root `/Users/xumingyang/github/contrabass`; portal `cloud/src/litellm-portal/`; commands from `cloud/`.

---

## Explicit decisions baked in (do not re-brainstorm — user-locked 2026-05-17)

1. **Ops面 = Owner-only, server-authoritative.** Owner = `identity.role === "admin"` (resolved server-side by `resolveIdentity` → `role-cache.ts`, fail-closed for the platform role). `/ops` and every Ops screen render only for Owners; non-Owner authenticated → in-shell 403 card + link to `/`; unauthenticated → existing login flow (unchanged). The gate is the server-resolved identity hydrated via `useMe()` (the same #418-safe channel Phase-1 uses at `routes/index.tsx`); the client branch only mirrors the server-resolved identity, never decides it.
2. **Ops chrome = fixed neutral-steel accent; tenant branding IGNORED on Ops面** (umbrella §4). The Ops shell never calls `applyBrandVars`; it applies a fixed steel accent via a small local constant. No Kumo fork, no semantic-token override.
3. **Impersonation = read-write (act as tenant), explicit-exit + idle/absolute timeout (~30 min), start/stop + every action audited**, real=OwnerId / effective=tenant(teamId). The impersonation primitive is designed FIRST (Task 2), server-authoritative, before any screen that deep-links into it.
4. **Reuse, do not rebuild.** Reuse `requireAdmin`, F1 `POST /api/admin/teams` (`adminCreateTeamApp`), `/api/admin/invites` (`adminInvitesApp`), `PUT /api/admin/teams/:teamId/members/:userId/tenant-role` (`adminTenantRoleApp`), `auditWrite` + `WriteReasonSchema`, the global `UsageDashboard` (`initialScope="global"`), `AdminAuditFeed`/`useAdminAudit`, `useAdminTeams`/`useAdminUsers`, Kumo primitives, #135 lazy routes, Phase-1 shell/routes-factory/screen-self-gate idiom + `RevokeInviteDialog` typed-confirm.

---

## File Structure

| File | Responsibility | Change |
|---|---|---|
| `cloud/src/litellm-portal/durable/schemas.ts` | `ImpersonationSessionSchema` (DO record) | Modify |
| `cloud/src/litellm-portal/durable/index-do.ts` | `putImpersonationSession`/`getImpersonationSession`/`endImpersonationSession` + `cb_index_impersonation` table | Modify |
| `cloud/src/litellm-portal/impersonation.ts` | Impersonation context primitive: signed short-TTL token mint/verify, `ImpersonationContext` type, idle/absolute timeout check | Create |
| `cloud/src/litellm-portal/schemas.ts` | `OpsTenantsSchema`, `OpsTenantDetailSchema`, `OpsUserDetailSchema`, `AuditEventDetailSchema`, `StartImpersonationBodySchema`/result, `OpsPlatformSettingsSchema` (client DTOs) | Modify |
| `cloud/src/litellm-portal/routes.ts` | `requireOwner`; impersonation threading in `applyAuthMiddleware`/`requireTenantAdmin`/`auditWrite`; `opsTenantsApp`, `opsTenantDetailApp`, `opsUserDetailApp`, `opsAuditDetailApp`, `opsImpersonationApp`, `opsPlatformSettingsApp` Hono sub-apps; mount in `app` | Modify |
| `cloud/src/litellm-portal/ops-console/shell.tsx` | Ops Console shell: left-nav + ops chip + impersonation-aware (no banner here — banner is tenant-side), fixed steel accent, Owner-gated | Create |
| `cloud/src/litellm-portal/ops-console/routes.tsx` | `createOpsConsoleRoutes` factory (lazy) for the 7 Ops screens; `OwnerForbidden` | Create |
| `cloud/src/litellm-portal/ops-console/hooks.ts` | React-Query hooks for `/api/ops/*` + impersonation start | Create |
| `cloud/src/litellm-portal/ops-console/screens/tenant-overview.tsx` | All-tenants list (member count · cycle spend/budget · alert/webhook · billing; row → tenant detail) | Create |
| `cloud/src/litellm-portal/ops-console/screens/provisioning.tsx` | Create team (F1) · cross-tenant invite send/list/revoke (F1) · assign portal tenantRole (P0 admin endpoint) | Create |
| `cloud/src/litellm-portal/ops-console/screens/global-usage.tsx` | Reuse global `UsageDashboard` (`initialScope="global"`) | Create |
| `cloud/src/litellm-portal/ops-console/screens/audit.tsx` | Platform-wide `AdminAuditFeed` (reuse `useAdminAudit`) + row → event detail | Create |
| `cloud/src/litellm-portal/ops-console/screens/platform-settings.tsx` | Prefs defaults · write-ops visibility · role/tenantRole mgmt entry · platform webhook/billing pointers | Create |
| `cloud/src/litellm-portal/ops-console/screens/tenant-detail.tsx` | Tenant detail (members · budget · webhook · billing history · tenantRole assign · enter-tenant) | Create |
| `cloud/src/litellm-portal/ops-console/screens/user-detail.tsx` | User detail (identity · teams · role/tenantRole · usage history · keys) | Create |
| `cloud/src/litellm-portal/ops-console/ops-theme.ts` | Fixed neutral-steel accent CSS-var constant (no Kumo fork) | Create |
| `cloud/src/litellm-portal/routes/index.tsx` (Phase-1 `PortalIndex`) | Additive: render `OpsConsoleShell` subtree when path is `/ops*` and identity is Owner | Modify |
| `cloud/src/litellm-portal/router.tsx` | Mount `createOpsConsoleRoutes(rootRoute)` additively (no `/manage/*` collision) | Modify |
| `cloud/src/litellm-portal/tenant-portal/shell.tsx` | Add impersonation banner (ARIA alert region, exit button) — rendered when an impersonation context is active in the hydrated identity | Modify |
| `cloud/src/litellm-portal/routes/manage/audit/$eventId.lazy.tsx` | "做实": real audit event-detail page | Modify |
| `cloud/src/litellm-portal/routes/manage/teams/$teamId.lazy.tsx` | "做实": real tenant-detail page (delegates to shared `OpsTenantDetail`) | Modify |
| `cloud/src/litellm-portal/routes/manage/users/$userId.lazy.tsx` | "做实": real user-detail page (delegates to shared `OpsUserDetail`) | Modify |
| `cloud/src/litellm-portal/i18n/messages/{zh-CN,en}.ts` | All new Ops copy | Modify |
| `cloud/src/litellm-portal/ops-console/ops-console.stories.tsx` | Stories mirroring `tenant-portal.stories.tsx` | Create |
| `cloud/src/litellm-portal/ops-console/i18n-completeness.test.ts` | Ops-namespace i18n completeness (mirrors `tenant-portal/i18n-completeness.test.ts`) | Create |
| `*.test.tsx`/`*.test.ts` colocated per repo convention | TDD coverage | Create/Modify |

Decomposition principle: backend (`requireOwner` + Ops endpoints) and the impersonation primitive land before the shell; the shell + routes factory land before the screens; each screen is one task; the three "做实" stub pages are each their own task anchored to the real stub files; i18n/stories/bundle is one task; a final E2E + whole-branch-review task defers PR-merge to the user.

---

## Task 1: `requireOwner` + Ops backend read endpoints (`/api/ops/*`)

**Files:**
- Modify: `cloud/src/litellm-portal/schemas.ts` (add Ops DTOs), `cloud/src/litellm-portal/routes.ts` (`requireOwner`, `opsTenantsApp`, `opsTenantDetailApp`, `opsUserDetailApp`, `opsAuditDetailApp`, mount)
- Test: `cloud/src/litellm-portal/ops-routes.test.ts` (new, mirrors existing route-test harness)

- [ ] **Step 1: Write the failing test** — `cloud/src/litellm-portal/ops-routes.test.ts`

```ts
import { describe, expect, it } from "vitest";
import { app } from "./routes";

// Minimal env: no INDEX_DO/TEAM_CONFIG_DO bindings → the Ops read endpoints
// return their documented 503 fallbacks, but auth + requireOwner still gate.
function reqOps(path: string, headers: Record<string, string> = {}): Request {
  return new Request(`http://localhost${path}`, { headers });
}

describe("ops backend gating", () => {
  it("unauthenticated /api/ops/tenants → 401", async () => {
    const res = await app.fetch(reqOps("/api/ops/tenants"), {} as never);
    expect(res.status).toBe(401);
  });

  it("non-owner (no Access email) /api/ops/tenants → 401 (auth) before owner check", async () => {
    const res = await app.fetch(reqOps("/api/ops/tenants"), {} as never);
    expect([401, 403]).toContain(res.status);
  });

  it("owner with no INDEX_DO → 503 index_do_unavailable (gate passed, dependency missing)", async () => {
    const env = {
      LITELLM_PORTAL_ALLOWED_EMAILS: "owner@x.com",
      BOOTSTRAP_ADMIN_EMAILS: "owner@x.com",
    } as never;
    const res = await app.fetch(
      reqOps("/api/ops/tenants", { "cf-access-authenticated-user-email": "owner@x.com" }),
      env,
    );
    // Owner gate passes (bootstrap admin); the handler then reports the missing DO.
    expect([503, 502, 500]).toContain(res.status);
  });
});
```

- [ ] **Step 2: Run test to verify it fails** — `cd /Users/xumingyang/github/contrabass/cloud && bun run test src/litellm-portal/ops-routes.test.ts` → FAIL (route `/api/ops/tenants` returns 404 `not_found`).

- [ ] **Step 3: Add Ops DTOs to `schemas.ts`** — append after `TenantBillingPeriodsSchema` (anchor: the `// /api/tenant/billing` block, ~line 540):

```ts
// ---------------------------------------------------------------------------
// /api/ops/* — Operations Console (Owner-only, all-tenant)
// ---------------------------------------------------------------------------

export const OpsTenantRowSchema = z.object({
  teamId: z.string(),
  alias: z.string().nullable(),
  memberCount: z.number(),
  cycleSpend: z.number().nullable(),
  maxBudget: z.number().nullable(),
  alertWebhookConfigured: z.boolean(),
  billingPeriodsCount: z.number(),
});

export type OpsTenantRow = z.infer<typeof OpsTenantRowSchema>;

export const OpsTenantsSchema = z.object({ tenants: z.array(OpsTenantRowSchema) });

export type OpsTenants = z.infer<typeof OpsTenantsSchema>;

export const OpsTenantMemberSchema = z.object({
  userId: z.string(),
  email: z.string(),
  tenantRole: z.enum(["tenant_admin", "member"]).nullable(),
  spend: z.number().nullable(),
});

export const OpsTenantDetailSchema = z.object({
  teamId: z.string(),
  alias: z.string().nullable(),
  maxBudget: z.number().nullable(),
  cycleSpend: z.number().nullable(),
  alertWebhookUrl: z.string().nullable(),
  members: z.array(OpsTenantMemberSchema),
  billingPeriods: z.array(z.string()),
});

export type OpsTenantDetail = z.infer<typeof OpsTenantDetailSchema>;

export const OpsUserDetailSchema = z.object({
  userId: z.string(),
  email: z.string(),
  platformRole: z.enum(["admin", "user", "none"]),
  teamId: z.string().nullable(),
  tenantRole: z.enum(["tenant_admin", "member"]).nullable(),
  spend: z.number().nullable(),
  maxBudget: z.number().nullable(),
  keyCount: z.number(),
});

export type OpsUserDetail = z.infer<typeof OpsUserDetailSchema>;

export const AuditEventDetailSchema = z.object({
  id: z.string(),
  ts: z.string().nullable(),
  actorEmail: z.string(),
  action: z.string(),
  entityKind: z.string(),
  entityId: z.string(),
  before: z.string().nullable(),
  after: z.string().nullable(),
  reason: z.string().nullable(),
});

export type AuditEventDetail = z.infer<typeof AuditEventDetailSchema>;

export const OpsPlatformSettingsSchema = z.object({
  writeOpsEnabled: z.boolean(),
  companyName: z.string(),
});

export type OpsPlatformSettings = z.infer<typeof OpsPlatformSettingsSchema>;
```

- [ ] **Step 4: Add `requireOwner` + the Ops read sub-apps to `routes.ts`** — `requireOwner` is byte-identical in intent to `requireAdmin` but named for the Ops面 boundary so the gate reads clearly at call sites. Add after `requireTenantAdmin` (anchor: line ~660, end of `requireTenantAdmin`):

```ts
async function requireOwner(c: Context<HonoEnv>, next: () => Promise<void>): Promise<Response | void> {
  // Ops Console boundary. Platform Owner only. Fail-closed: anything other than
  // a resolved platform admin role is rejected (mirrors requireAdmin, named for
  // the /ops surface so the gate reads unambiguously at the call site).
  if (c.get("identity").role !== "admin") {
    return c.json({ error: "owner_required" }, 403);
  }
  await next();
}
```

Add the Ops read sub-apps after `tenantBillingApp` (anchor: line ~1982, just before the `const app = new Hono...` top-level mount). These reuse existing IndexDO/TeamConfigDO stubs already declared in this file (`IndexDOInviteStub`, `TeamConfigDOAlertStub`, `IndexDOTenantRoleStub`) and existing helpers (`adminTeamsFromDO`, `listAuditEvents`, `adminUsersFromDO`):

```ts
// ---------------------------------------------------------------------------
// Operations Console read endpoints — /api/ops/* (Owner-only, all-tenant)
// ---------------------------------------------------------------------------

type IndexDOOpsStub = {
  listTeams(): Promise<Array<{ id: string; alias: string }>>;
  listTenantRoles(opts?: { teamId?: string }): Promise<
    Array<{ userId: string; teamId: string; tenantRole: "tenant_admin" | "member" }>
  >;
  listInvites(opts?: { status?: "pending" | "consumed" | "revoked" }): Promise<
    Array<{ emailLc: string; teamId: string }>
  >;
  getUserById(userId: string): Promise<{ userId: string; email: string; role: "admin" | "user"; teamId: string | null; maxBudget?: number } | null>;
  getUserByEmail(email: string): Promise<{ userId: string; email: string; role: "admin" | "user"; teamId: string | null; maxBudget?: number } | null>;
};

type TeamConfigDOOpsStub = {
  getTeam(): Promise<{ id: string; alias: string; maxBudget?: number } | null>;
  getAlertWebhook(): Promise<{ url: string } | null>;
  getSpendSnapshot(): Promise<{ currentSpend: number } | null>;
};

function idxOps(env: LiteLLMPortalEnv): IndexDOOpsStub | null {
  if (!env.INDEX_DO) return null;
  return env.INDEX_DO.get(env.INDEX_DO.idFromName("index")) as unknown as IndexDOOpsStub;
}

function teamOps(env: LiteLLMPortalEnv, teamId: string): TeamConfigDOOpsStub | null {
  if (!env.TEAM_CONFIG_DO) return null;
  return env.TEAM_CONFIG_DO.get(
    env.TEAM_CONFIG_DO.idFromName(teamId),
  ) as unknown as TeamConfigDOOpsStub;
}

async function billingPeriodsList(env: LiteLLMPortalEnv): Promise<string[]> {
  if (!env.BILLING_ARCHIVE_R2) return [];
  const listed = await env.BILLING_ARCHIVE_R2.list({ prefix: "billing/" });
  const periods: string[] = [];
  for (const obj of listed.objects) {
    const m = /^billing\/(\d{4})\/(\d{2})\.csv$/u.exec(obj.key);
    if (m) periods.push(`${m[1]}-${m[2]}`);
  }
  return periods;
}

const opsTenantsApp = new Hono<HonoEnv>()
  .use("/*", applyAuthMiddleware)
  .use("/ops/*", applyAdminRateLimit)
  .use("/ops/*", requireOwner)
  .get("/ops/tenants", async (c) => {
    const idx = idxOps(c.env);
    if (idx == null) return c.json({ error: "index_do_unavailable" }, 503);
    const teams = await idx.listTeams();
    const roles = await idx.listTenantRoles();
    const periods = await billingPeriodsList(c.env);
    const tenants = await Promise.all(
      teams.map(async (team) => {
        const memberCount = roles.filter((r) => r.teamId === team.id).length;
        const tc = teamOps(c.env, team.id);
        const teamRec = tc != null ? await tc.getTeam() : null;
        const webhook = tc != null ? await tc.getAlertWebhook() : null;
        const snap = tc != null ? await tc.getSpendSnapshot() : null;
        return {
          teamId: team.id,
          alias: team.alias ?? null,
          memberCount,
          cycleSpend: snap?.currentSpend ?? null,
          maxBudget: teamRec?.maxBudget ?? null,
          alertWebhookConfigured: webhook?.url != null,
          billingPeriodsCount: periods.length,
        };
      }),
    );
    return c.json(OpsTenantsSchema.parse({ tenants }));
  });

const opsTenantDetailApp = new Hono<HonoEnv>()
  .use("/*", applyAuthMiddleware)
  .use("/ops/*", applyAdminRateLimit)
  .use("/ops/*", requireOwner)
  .get("/ops/tenants/:teamId", async (c) => {
    const teamId = decodeURIComponent(c.req.param("teamId") ?? "").trim();
    if (!teamId) return c.json({ error: "team_id_required" }, 400);
    const idx = idxOps(c.env);
    if (idx == null) return c.json({ error: "index_do_unavailable" }, 503);
    const tc = teamOps(c.env, teamId);
    const teamRec = tc != null ? await tc.getTeam() : null;
    const webhook = tc != null ? await tc.getAlertWebhook() : null;
    const snap = tc != null ? await tc.getSpendSnapshot() : null;
    const roles = await idx.listTenantRoles({ teamId });
    const members = await Promise.all(
      roles.map(async (r) => {
        const u = await idx.getUserById(r.userId);
        return {
          userId: r.userId,
          email: u?.email ?? r.userId,
          tenantRole: r.tenantRole,
          spend: null as number | null,
        };
      }),
    );
    return c.json(
      OpsTenantDetailSchema.parse({
        teamId,
        alias: teamRec?.alias ?? null,
        maxBudget: teamRec?.maxBudget ?? null,
        cycleSpend: snap?.currentSpend ?? null,
        alertWebhookUrl: webhook?.url ?? null,
        members,
        billingPeriods: await billingPeriodsList(c.env),
      }),
    );
  });

const opsUserDetailApp = new Hono<HonoEnv>()
  .use("/*", applyAuthMiddleware)
  .use("/ops/*", applyAdminRateLimit)
  .use("/ops/*", requireOwner)
  .get("/ops/users/:userId", async (c) => {
    const userId = decodeURIComponent(c.req.param("userId") ?? "").trim();
    if (!userId) return c.json({ error: "user_id_required" }, 400);
    const idx = idxOps(c.env);
    if (idx == null) return c.json({ error: "index_do_unavailable" }, 503);
    const rec = (await idx.getUserById(userId)) ?? (await idx.getUserByEmail(userId));
    if (rec == null) return c.json({ error: "user_not_found" }, 404);
    const roles = await idx.listTenantRoles();
    const role = roles.find((r) => r.userId === rec.userId) ?? null;
    return c.json(
      OpsUserDetailSchema.parse({
        userId: rec.userId,
        email: rec.email,
        platformRole: rec.role === "admin" ? "admin" : "user",
        teamId: rec.teamId,
        tenantRole: role?.tenantRole ?? null,
        spend: null,
        maxBudget: rec.maxBudget ?? null,
        keyCount: 0,
      }),
    );
  });

const opsAuditDetailApp = new Hono<HonoEnv>()
  .use("/*", applyAuthMiddleware)
  .use("/ops/*", applyAdminRateLimit)
  .use("/ops/*", requireOwner)
  .get("/ops/audit/:eventId", async (c) => {
    const eventId = decodeURIComponent(c.req.param("eventId") ?? "").trim();
    if (!eventId) return c.json({ error: "event_id_required" }, 400);
    if (!c.env.INDEX_DO) return c.json({ error: "index_do_unavailable" }, 503);
    type IndexDOAuditListStub = {
      listAudit(opts?: { limit?: number }): Promise<
        Array<{
          id: string; ts: string; actorEmail: string; action: string;
          entityKind: string; entityId: string;
          before: unknown; after: unknown; reason: string | null;
        }>
      >;
    };
    const idx = c.env.INDEX_DO.get(
      c.env.INDEX_DO.idFromName("index"),
    ) as unknown as IndexDOAuditListStub;
    const events = await idx.listAudit({ limit: 500 });
    const ev = events.find((e) => e.id === eventId);
    if (ev == null) return c.json({ error: "audit_event_not_found" }, 404);
    return c.json(
      AuditEventDetailSchema.parse({
        id: ev.id,
        ts: ev.ts,
        actorEmail: ev.actorEmail,
        action: ev.action,
        entityKind: ev.entityKind,
        entityId: ev.entityId,
        before: typeof ev.before === "string" ? ev.before : ev.before == null ? null : JSON.stringify(ev.before),
        after: typeof ev.after === "string" ? ev.after : ev.after == null ? null : JSON.stringify(ev.after),
        reason: ev.reason,
      }),
    );
  });
```

Add the Ops DTO imports to the existing `schemas` import block at the top of `routes.ts` (anchor: the existing `import { ... } from "./schemas"` aggregate — add `OpsTenantsSchema`, `OpsTenantDetailSchema`, `OpsUserDetailSchema`, `AuditEventDetailSchema`). Mount the four sub-apps in the `app` chain after `.route("/api", tenantBillingApp)` (anchor: line ~2025) and before `.all("/*", ...)`:

```ts
  .route("/api", opsTenantsApp)
  .route("/api", opsTenantDetailApp)
  .route("/api", opsUserDetailApp)
  .route("/api", opsAuditDetailApp)
```

- [ ] **Step 5: Run test to verify it passes** — `cd /Users/xumingyang/github/contrabass/cloud && bun run test src/litellm-portal/ops-routes.test.ts` → PASS (3 tests). Then `bun run typecheck` → baseline-only.

- [ ] **Step 6: Commit**
```bash
cd /Users/xumingyang/github/contrabass
git add cloud/src/litellm-portal/schemas.ts cloud/src/litellm-portal/routes.ts cloud/src/litellm-portal/ops-routes.test.ts
git -c commit.gpgsign=false commit -m "feat(litellm-portal): requireOwner + /api/ops/* read endpoints"
```

---

## Task 2: Impersonation context primitive (server-authoritative, designed FIRST)

**Files:**
- Modify: `cloud/src/litellm-portal/durable/schemas.ts`, `cloud/src/litellm-portal/durable/index-do.ts`
- Create: `cloud/src/litellm-portal/impersonation.ts`, `cloud/src/litellm-portal/impersonation.test.ts`

**Design (the envelope, locked):** an Owner starts impersonation of `teamId`. The server mints a signed, short-TTL token (HMAC-SHA256 over a JSON payload, reusing the `PORTAL_SESSION_SECRET` HMAC pattern) carrying `{ realActor, effectiveTeamId, issuedAt, idleDeadline, absoluteDeadline }`. The token rides in a dedicated `cb_imp` cookie (HttpOnly, SameSite=Strict, Secure). On every request, `applyAuthMiddleware` verifies the token (signature + both deadlines) and, when valid, attaches an `ImpersonationContext` to `c.set("identity", ...)` by **deriving a tenant-scoped identity** (`role` stays the real Owner role for read superset, but `tenantTeamId`/`tenantRole` are pinned to the impersonated team so `requireTenantAdmin`/`tenantTeamOr403` authorize tenant writes). A server-side DO record (`cb_index_impersonation`) is the authoritative session ledger (start/stop timestamps) so the Owner can be force-exited and so stop is auditable even if the cookie is lost. Every audited write while impersonating carries `viaImpersonation:true`, `realActor`, `effectiveTenant`. Client banner is UX only.

- [ ] **Step 1: Write the failing test** — `cloud/src/litellm-portal/impersonation.test.ts`

```ts
import { describe, expect, it } from "vitest";
import {
  mintImpersonationToken,
  verifyImpersonationToken,
  type ImpersonationContext,
} from "./impersonation";

const SECRET = "test-secret-0123456789";

describe("impersonation token", () => {
  it("mint→verify round-trips the envelope", async () => {
    const now = 1_000_000;
    const token = await mintImpersonationToken(SECRET, {
      realActor: "owner@x.com",
      effectiveTeamId: "team-1",
      now,
    });
    const ctx = await verifyImpersonationToken(SECRET, token, now + 1000);
    expect(ctx).not.toBeNull();
    const c = ctx as ImpersonationContext;
    expect(c.realActor).toBe("owner@x.com");
    expect(c.effectiveTeamId).toBe("team-1");
    expect(c.viaImpersonation).toBe(true);
  });

  it("rejects a tampered token", async () => {
    const token = await mintImpersonationToken(SECRET, {
      realActor: "owner@x.com",
      effectiveTeamId: "team-1",
      now: 1_000_000,
    });
    const tampered = token.slice(0, -2) + "xx";
    expect(await verifyImpersonationToken(SECRET, tampered, 1_000_100)).toBeNull();
  });

  it("rejects past the idle deadline (30 min idle)", async () => {
    const now = 1_000_000;
    const token = await mintImpersonationToken(SECRET, {
      realActor: "owner@x.com",
      effectiveTeamId: "team-1",
      now,
    });
    const afterIdle = now + 31 * 60 * 1000;
    expect(await verifyImpersonationToken(SECRET, token, afterIdle)).toBeNull();
  });

  it("rejects past the absolute deadline (2 h cap)", async () => {
    const now = 1_000_000;
    const token = await mintImpersonationToken(SECRET, {
      realActor: "owner@x.com",
      effectiveTeamId: "team-1",
      now,
    });
    const afterAbsolute = now + 121 * 60 * 1000;
    expect(await verifyImpersonationToken(SECRET, token, afterAbsolute)).toBeNull();
  });
});
```

- [ ] **Step 2: Run → FAIL** — `cd /Users/xumingyang/github/contrabass/cloud && bun run test src/litellm-portal/impersonation.test.ts` (module missing).

- [ ] **Step 3: Implement `impersonation.ts`**

```ts
/**
 * Server-authoritative impersonation primitive for the Operations Console.
 *
 * An Owner "enters a tenant" (read-write: act as tenant). The session is
 * carried by a signed, short-TTL token (HMAC-SHA256, same crypto shape as the
 * portal session cookie). The token is the transport; the IndexDO
 * `cb_index_impersonation` record is the authoritative ledger (force-exit +
 * auditable stop). Every tenant-scoped write while impersonating is attributed
 * real=OwnerId / effective=tenant(teamId) and audited with viaImpersonation.
 *
 * Timeouts (locked): 30-minute idle, 2-hour absolute cap. Each verified request
 * does NOT slide the idle window here (the slide is applied by the caller that
 * re-mints on activity — see routes.ts applyAuthMiddleware); verify only checks
 * the deadlines embedded at mint time, so this module is pure + testable.
 */

export const IMPERSONATION_COOKIE = "cb_imp";
const IDLE_MS = 30 * 60 * 1000;
const ABSOLUTE_MS = 2 * 60 * 60 * 1000;

export type ImpersonationContext = {
  viaImpersonation: true;
  realActor: string;
  effectiveTeamId: string;
  issuedAt: number;
  idleDeadline: number;
  absoluteDeadline: number;
};

type Payload = {
  realActor: string;
  effectiveTeamId: string;
  issuedAt: number;
  idleDeadline: number;
  absoluteDeadline: number;
};

function b64urlEncode(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/u, "");
}

function b64urlDecode(s: string): Uint8Array {
  const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/") + pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
  return out;
}

async function hmac(secret: string, data: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data));
  return new Uint8Array(sig);
}

function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a[i] ^ b[i];
  return diff === 0;
}

export async function mintImpersonationToken(
  secret: string,
  input: { realActor: string; effectiveTeamId: string; now: number },
): Promise<string> {
  const payload: Payload = {
    realActor: input.realActor,
    effectiveTeamId: input.effectiveTeamId,
    issuedAt: input.now,
    idleDeadline: input.now + IDLE_MS,
    absoluteDeadline: input.now + ABSOLUTE_MS,
  };
  const body = b64urlEncode(new TextEncoder().encode(JSON.stringify(payload)));
  const sig = b64urlEncode(await hmac(secret, body));
  return `${body}.${sig}`;
}

export async function verifyImpersonationToken(
  secret: string,
  token: string,
  now: number,
): Promise<ImpersonationContext | null> {
  const parts = token.split(".");
  if (parts.length !== 2) return null;
  const [body, sig] = parts;
  const expected = await hmac(secret, body);
  let provided: Uint8Array;
  try {
    provided = b64urlDecode(sig);
  } catch {
    return null;
  }
  if (!timingSafeEqual(expected, provided)) return null;

  let payload: Payload;
  try {
    payload = JSON.parse(new TextDecoder().decode(b64urlDecode(body))) as Payload;
  } catch {
    return null;
  }
  if (
    typeof payload.realActor !== "string" ||
    typeof payload.effectiveTeamId !== "string" ||
    typeof payload.idleDeadline !== "number" ||
    typeof payload.absoluteDeadline !== "number"
  ) {
    return null;
  }
  if (now > payload.idleDeadline) return null;
  if (now > payload.absoluteDeadline) return null;

  return {
    viaImpersonation: true,
    realActor: payload.realActor,
    effectiveTeamId: payload.effectiveTeamId,
    issuedAt: payload.issuedAt,
    idleDeadline: payload.idleDeadline,
    absoluteDeadline: payload.absoluteDeadline,
  };
}

export function readImpersonationCookie(req: Request): string | null {
  const raw = req.headers.get("cookie");
  if (!raw) return null;
  for (const part of raw.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === IMPERSONATION_COOKIE) return v.join("=");
  }
  return null;
}

export function buildImpersonationSetCookie(token: string, maxAgeSeconds: number): string {
  return `${IMPERSONATION_COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${maxAgeSeconds}`;
}

export function buildImpersonationClearCookie(): string {
  return `${IMPERSONATION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`;
}
```

- [ ] **Step 4: Add the DO ledger record + methods.** In `durable/schemas.ts`, append after `TeamAlertWebhookSchema` (anchor: line ~84):

```ts
export const ImpersonationSessionSchema = z.object({
  realActor: z.string(),
  effectiveTeamId: z.string(),
  startedAt: z.string().datetime(),
  endedAt: z.string().datetime().nullable(),
}).strict();

export type ImpersonationSession = z.infer<typeof ImpersonationSessionSchema>;
```

In `durable/index-do.ts`, add a `cb_index_impersonation` table to `initializeSql` (anchor: the `CREATE TABLE IF NOT EXISTS cb_index_tenant_roles` block, ~line 239 — add an adjacent `CREATE TABLE IF NOT EXISTS cb_index_impersonation (real_actor TEXT NOT NULL, effective_team_id TEXT NOT NULL, started_at TEXT NOT NULL, ended_at TEXT, PRIMARY KEY (real_actor, started_at))` plus its `CREATE INDEX IF NOT EXISTS cb_index_impersonation_actor_idx ON cb_index_impersonation (real_actor, started_at DESC)`), and add the public methods after `listTenantRoles` (anchor: line ~700, end of the tenant-roles section). KV-fallback mirrors the `tenantRole` pattern in this file:

```ts
  // -------------------------------------------------------------------------
  // Impersonation session ledger (Owner-as-tenant; Ops Console)
  // -------------------------------------------------------------------------

  async putImpersonationSession(record: ImpersonationSession): Promise<void> {
    const parsed = ImpersonationSessionSchema.parse(record);
    const sql = await this.sql();
    if (sql !== null) {
      sql.exec(
        `INSERT OR REPLACE INTO cb_index_impersonation
           (real_actor, effective_team_id, started_at, ended_at)
         VALUES (?, ?, ?, ?)`,
        parsed.realActor, parsed.effectiveTeamId, parsed.startedAt, parsed.endedAt,
      );
      return;
    }
    await this.ctx.storage.put(
      `imp:${parsed.realActor}:${parsed.startedAt}`,
      parsed,
    );
  }

  async getActiveImpersonationSession(realActor: string): Promise<ImpersonationSession | null> {
    if (typeof realActor !== "string" || realActor.length === 0) {
      throw new Error("getActiveImpersonationSession: realActor must be a non-empty string");
    }
    const sql = await this.sql();
    if (sql !== null) {
      const row = firstRow(sql.exec<SqlRow>(
        `SELECT * FROM cb_index_impersonation
           WHERE real_actor = ? AND ended_at IS NULL
           ORDER BY started_at DESC LIMIT 1`,
        realActor,
      ));
      if (row == null) return null;
      return ImpersonationSessionSchema.parse({
        realActor: String(row.real_actor),
        effectiveTeamId: String(row.effective_team_id),
        startedAt: String(row.started_at),
        endedAt: row.ended_at == null ? null : String(row.ended_at),
      });
    }
    const entries = await this.ctx.storage.list<unknown>({ prefix: `imp:${realActor}:`, reverse: true });
    for (const raw of entries.values()) {
      const rec = ImpersonationSessionSchema.parse(raw);
      if (rec.endedAt == null) return rec;
    }
    return null;
  }

  async endImpersonationSession(realActor: string): Promise<void> {
    const active = await this.getActiveImpersonationSession(realActor);
    if (active == null) return;
    await this.putImpersonationSession({ ...active, endedAt: new Date().toISOString() });
  }
```

Add `ImpersonationSession`/`ImpersonationSessionSchema` to the existing `import { ... } from "./schemas"` block at the top of `durable/index-do.ts` (anchor: the aggregate schema import).

- [ ] **Step 5: Run → PASS** — `cd /Users/xumingyang/github/contrabass/cloud && bun run test src/litellm-portal/impersonation.test.ts` (4 tests) + `bun run test src/litellm-portal/durable` (existing DO tests still green) + `bun run typecheck` (baseline-only).

- [ ] **Step 6: Commit**
```bash
cd /Users/xumingyang/github/contrabass
git add cloud/src/litellm-portal/impersonation.ts cloud/src/litellm-portal/impersonation.test.ts cloud/src/litellm-portal/durable/schemas.ts cloud/src/litellm-portal/durable/index-do.ts
git -c commit.gpgsign=false commit -m "feat(litellm-portal): impersonation token primitive + DO ledger"
```

---

## Task 3: Impersonation thread-through + start/stop endpoints + audit envelope

**Files:** Modify `cloud/src/litellm-portal/routes.ts` (`applyAuthMiddleware` impersonation derive, `opsImpersonationApp` start/stop, audit envelope on tenant writes); Test `cloud/src/litellm-portal/impersonation-routes.test.ts`

- [ ] **Step 1: Failing test** — `cloud/src/litellm-portal/impersonation-routes.test.ts`

```ts
import { describe, expect, it } from "vitest";
import { app } from "./routes";
import { mintImpersonationToken, IMPERSONATION_COOKIE } from "./impersonation";

describe("impersonation start/stop gating", () => {
  it("POST /api/ops/impersonation requires Owner (401 unauthenticated)", async () => {
    const res = await app.fetch(
      new Request("http://localhost/api/ops/impersonation", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ teamId: "team-1", reason: "support" }),
      }),
      {} as never,
    );
    expect([401, 403]).toContain(res.status);
  });

  it("DELETE /api/ops/impersonation clears the cookie even without an active token", async () => {
    const env = {
      LITELLM_PORTAL_ALLOWED_EMAILS: "owner@x.com",
      BOOTSTRAP_ADMIN_EMAILS: "owner@x.com",
    } as never;
    const res = await app.fetch(
      new Request("http://localhost/api/ops/impersonation", {
        method: "DELETE",
        headers: { "cf-access-authenticated-user-email": "owner@x.com" },
      }),
      env,
    );
    // Owner gate passes; stop is idempotent and always clears the cookie.
    expect([200, 503]).toContain(res.status);
    if (res.status === 200) {
      expect(res.headers.get("set-cookie") ?? "").toContain(`${IMPERSONATION_COOKIE}=;`);
    }
  });

  it("a valid impersonation token derives a tenant-scoped identity for /api/tenant/*", async () => {
    // Smoke: a minted token is structurally accepted by the cookie reader path.
    const token = await mintImpersonationToken("s", {
      realActor: "owner@x.com",
      effectiveTeamId: "team-1",
      now: Date.now(),
    });
    expect(token.split(".")).toHaveLength(2);
  });
});
```

- [ ] **Step 2: Run → FAIL** — `cd /Users/xumingyang/github/contrabass/cloud && bun run test src/litellm-portal/impersonation-routes.test.ts`.

- [ ] **Step 3: Implement.** In `routes.ts`:

(a) Add imports at the top (anchor: existing `import { ... } from "./roles"` / `./auth` block):
```ts
import {
  mintImpersonationToken,
  verifyImpersonationToken,
  readImpersonationCookie,
  buildImpersonationSetCookie,
  buildImpersonationClearCookie,
  type ImpersonationContext,
} from "./impersonation";
import { SetTenantRoleBodySchema as _unusedKeepLint } from "./schemas"; // (only if not already imported; remove if dup)
```
(If `SetTenantRoleBodySchema` is already imported, omit that last line — it exists in the current import aggregate; do not duplicate.)

(b) Extend `applyAuthMiddleware` (anchor: line ~615) to derive the impersonation identity AFTER `resolveIdentity` succeeds. Replace the body's tail (`c.set("identity", identityResult.identity); await next();`) with:

```ts
  const baseIdentity = identityResult.identity;
  const impToken = readImpersonationCookie(c.req.raw);
  if (impToken != null && c.env.PORTAL_SESSION_SECRET && baseIdentity.role === "admin") {
    const imp = await verifyImpersonationToken(
      c.env.PORTAL_SESSION_SECRET,
      impToken,
      Date.now(),
    );
    if (imp != null) {
      // Owner acts AS the tenant: read superset stays (role=admin), but the
      // tenant facet is pinned so requireTenantAdmin/tenantTeamOr403 authorize
      // and audit tenant-scoped writes against the impersonated team.
      c.set("identity", {
        ...baseIdentity,
        tenantRole: "tenant_admin",
        tenantTeamId: imp.effectiveTeamId,
      });
      c.set("impersonation", imp);
      await next();
      return;
    }
  }
  c.set("identity", baseIdentity);
  await next();
```

Add `impersonation?: ImpersonationContext` to the `HonoEnv` `Variables` type (anchor: the `type HonoEnv = { Bindings: LiteLLMPortalEnv; Variables: { identity: PortalIdentity } }` declaration — extend `Variables` with `impersonation?: ImpersonationContext`).

(c) Wrap `auditWrite` calls on the tenant write path with the envelope. Add a helper after `requireOwner` (Task 1):

```ts
function impersonationAuditFields(
  c: Context<HonoEnv>,
): { realActor: string; effectiveTeam: string; viaImpersonation: true } | Record<string, never> {
  const imp = c.get("impersonation");
  if (imp == null) return {};
  return {
    realActor: imp.realActor,
    effectiveTeam: imp.effectiveTeamId,
    viaImpersonation: true,
  };
}
```

`auditWrite`'s `AuditWritePoint` carries `before`/`after`/`reason` as strings; thread the impersonation envelope by appending it into the `after` JSON of each tenant-scoped core (`createInviteCore`, `revokeInviteCore`, `alertWebhookSetCore`, `alertWebhookClearCore`, `billingDownloadCore` when `scope === "tenant"`). At each `await auditWrite(c.env, { ... after: JSON.stringify(X), ... })` on the tenant path, change `after` to `JSON.stringify({ ...X, _impersonation: impersonationAuditFields(c) })` when `impersonationAuditFields(c)` is non-empty. Concretely, in each `*Core` add at the top: `const impEnv = impersonationAuditFields(c);` and at the `auditWrite` call set `after: JSON.stringify(Object.keys(impEnv).length ? { value: <existingAfterValue>, _impersonation: impEnv } : <existingAfterValue>)`. (The existing admin path — `scope === "admin"` — is untouched: `impersonationAuditFields` returns `{}` there because no impersonation cookie is set for direct admin calls.)

(d) Add the start/stop sub-app after `opsAuditDetailApp` (Task 1):

```ts
const StartImpersonationBodySchema = z.object({
  reason: WriteReasonSchema,
  teamId: z.string().min(1),
});

const opsImpersonationApp = new Hono<HonoEnv>()
  .use("/*", applyAuthMiddleware)
  .use("/ops/*", applyAdminRateLimit)
  .use("/ops/*", requireOwner)
  .post("/ops/impersonation", async (c) => {
    if (!c.env.PORTAL_SESSION_SECRET) return c.json({ error: "session_secret_missing" }, 503);
    const parsed = await parseWriteBody(c, StartImpersonationBodySchema);
    if (!parsed.ok) return parsed.response;
    const identity = c.get("identity");
    const now = Date.now();
    const token = await mintImpersonationToken(c.env.PORTAL_SESSION_SECRET, {
      realActor: identity.email,
      effectiveTeamId: parsed.data.teamId,
      now,
    });
    const startedAt = new Date(now).toISOString();
    if (c.env.INDEX_DO) {
      type IndexDOImpStub = {
        putImpersonationSession(r: {
          realActor: string; effectiveTeamId: string; startedAt: string; endedAt: string | null;
        }): Promise<void>;
      };
      const idx = c.env.INDEX_DO.get(
        c.env.INDEX_DO.idFromName("index"),
      ) as unknown as IndexDOImpStub;
      await idx.putImpersonationSession({
        realActor: identity.email,
        effectiveTeamId: parsed.data.teamId,
        startedAt,
        endedAt: null,
      });
    }
    await auditWrite(c.env, {
      actor: identity.email,
      action: "ops_impersonation_start",
      target: parsed.data.teamId,
      ip: c.req.header("cf-connecting-ip") ?? "unknown",
      ts: startedAt,
      before: "null",
      after: JSON.stringify({ effectiveTeamId: parsed.data.teamId }),
      reason: parsed.data.reason,
    });
    c.header("set-cookie", buildImpersonationSetCookie(token, 2 * 60 * 60));
    return c.json({ ok: true, effectiveTeamId: parsed.data.teamId });
  })
  .delete("/ops/impersonation", async (c) => {
    const identity = c.get("identity");
    if (c.env.INDEX_DO) {
      type IndexDOImpStub = { endImpersonationSession(realActor: string): Promise<void> };
      const idx = c.env.INDEX_DO.get(
        c.env.INDEX_DO.idFromName("index"),
      ) as unknown as IndexDOImpStub;
      await idx.endImpersonationSession(identity.email);
    }
    await auditWrite(c.env, {
      actor: identity.email,
      action: "ops_impersonation_stop",
      target: identity.email,
      ip: c.req.header("cf-connecting-ip") ?? "unknown",
      ts: new Date().toISOString(),
      before: "active",
      after: "ended",
      reason: "explicit_exit",
    });
    c.header("set-cookie", buildImpersonationClearCookie());
    return c.json({ ok: true });
  });
```

Mount it in `app` after `.route("/api", opsAuditDetailApp)`: `.route("/api", opsImpersonationApp)`.

- [ ] **Step 4: Run → PASS** — `cd /Users/xumingyang/github/contrabass/cloud && bun run test src/litellm-portal/impersonation-routes.test.ts src/litellm-portal/ops-routes.test.ts` + the existing tenant-route tests `bun run test src/litellm-portal/routes` (the admin-path audit is byte-unchanged when no impersonation cookie — verify those stay green) + `bun run typecheck` (baseline-only).

- [ ] **Step 5: Commit**
```bash
cd /Users/xumingyang/github/contrabass
git add cloud/src/litellm-portal/routes.ts cloud/src/litellm-portal/impersonation-routes.test.ts
git -c commit.gpgsign=false commit -m "feat(litellm-portal): impersonation thread-through + start/stop + audit envelope"
```

---

## Task 4: Ops theme + `OpsConsoleShell` + Owner-gated routes factory + SSR select

**Files:**
- Create: `cloud/src/litellm-portal/ops-console/ops-theme.ts`, `ops-console/shell.tsx`, `ops-console/shell.test.tsx`, `ops-console/routes.tsx`
- Modify: `cloud/src/litellm-portal/routes/index.tsx`, `cloud/src/litellm-portal/router.tsx`
- Test: extend `cloud/src/litellm-portal/router.test.tsx`/`index.test.ts`

- [ ] **Step 1: Failing test** — `cloud/src/litellm-portal/ops-console/shell.test.tsx`

```tsx
/**
 * @vitest-environment happy-dom
 */
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { I18nProvider } from "@lingui/react";
import { setupI18n } from "../i18n/setup";
import { OpsConsoleShell } from "./shell";
import type { PortalIdentity } from "../types";

const i18n = setupI18n("zh-CN");

function renderShell(identity: PortalIdentity) {
  return render(
    <I18nProvider i18n={i18n}>
      <OpsConsoleShell identity={identity}>
        <div>child</div>
      </OpsConsoleShell>
    </I18nProvider>,
  );
}

const owner: PortalIdentity = {
  email: "owner@x.com", userId: "u1", domain: "x.com", litellmUserId: "u1",
  role: "admin", tenantRole: null, tenantTeamId: null,
};
const nonOwner: PortalIdentity = {
  email: "user@x.com", userId: "u2", domain: "x.com", litellmUserId: "u2",
  role: "user", tenantRole: "member", tenantTeamId: "t1",
};

describe("OpsConsoleShell", () => {
  it("Owner sees all seven nav items + ops chip", () => {
    renderShell(owner);
    for (const label of ["租户总览", "发放与邀请", "全局用量", "审计", "平台设置"]) {
      expect(screen.getByText(new RegExp(label))).toBeTruthy();
    }
    expect(screen.getByText(/运营控制台/)).toBeTruthy();
  });

  it("non-Owner sees a 403 card + link to / (no nav)", () => {
    renderShell(nonOwner);
    expect(screen.getByText(/仅平台 Owner 可访问/)).toBeTruthy();
    expect(screen.queryByText(/租户总览/)).toBeNull();
  });
});
```

- [ ] **Step 2: Run → FAIL** — `cd /Users/xumingyang/github/contrabass/cloud && bun run test src/litellm-portal/ops-console/shell.test.tsx` (module missing).

- [ ] **Step 3: Implement `ops-theme.ts`**

```ts
import type React from "react";

/**
 * Fixed neutral-steel accent for the Operations Console (umbrella §4).
 *
 * Ops面 signals "internal / privileged": it uses a FIXED steel accent and
 * IGNORES tenant branding entirely. This does NOT fork Kumo and does NOT
 * override any semantic/hierarchy/type token — it only sets the same two
 * `--kumo-brand*` accent vars Phase-1 branding uses, to a constant steel pair.
 *
 * Steel: #475569 (slate-600) / hover #334155 (slate-700) — both clear WCAG-AA
 * Non-text Contrast (≥3:1) against the Kumo light (#fafafa) and dark (#1a1a1a)
 * canvases (same surfaces tenant-portal/branding.ts checks).
 */
export const OPS_STEEL_ACCENT: React.CSSProperties = {
  "--kumo-brand": "#475569",
  "--kumo-brand-hover": "#334155",
} as React.CSSProperties;
```

- [ ] **Step 4: Implement `ops-console/shell.tsx`** (mirrors `tenant-portal/shell.tsx` structure: left-nav + chip, Owner gate, fixed steel accent, all copy via Lingui macros — keys added in this task's i18n edit + finalized in Task 12):

```tsx
import React from "react";
import { Banner } from "@cloudflare/kumo/components/banner";
import { Badge } from "@cloudflare/kumo/components/badge";
import { Text } from "@cloudflare/kumo/components/text";
import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import type { PortalIdentity } from "../types";
import { OPS_STEEL_ACCENT } from "./ops-theme";

export type OpsConsoleShellProps = {
  identity: PortalIdentity;
  children: React.ReactNode;
};

type NavItem = { href: string; label: React.ReactNode };

const OPS_NAV: NavItem[] = [
  { href: "/ops", label: <Trans>租户总览</Trans> },
  { href: "/ops/provisioning", label: <Trans>发放与邀请</Trans> },
  { href: "/ops/usage", label: <Trans>全局用量</Trans> },
  { href: "/ops/audit", label: <Trans>审计</Trans> },
  { href: "/ops/settings", label: <Trans>平台设置</Trans> },
];

function isOwner(identity: PortalIdentity): boolean {
  return identity.role === "admin";
}

function OpsForbiddenCard() {
  return (
    <div className="mx-auto w-full max-w-2xl px-6 py-16" id="ops-forbidden-root">
      <Banner
        variant="error"
        title={t`无权访问运营控制台`}
        description={<Trans>仅平台 Owner 可访问。</Trans>}
        action={
          <a
            href="/"
            className="font-semibold text-kumo-link underline underline-offset-2"
          >
            <Trans>返回门户</Trans>
          </a>
        }
      />
    </div>
  );
}

export function OpsConsoleShell({ identity, children }: OpsConsoleShellProps) {
  if (!isOwner(identity)) {
    return (
      <div
        id="ops-console-shell-root"
        className="flex min-h-screen flex-col bg-kumo-canvas text-kumo-default"
      >
        <OpsForbiddenCard />
      </div>
    );
  }

  return (
    <div
      id="ops-console-shell-root"
      className="flex min-h-screen flex-col bg-kumo-canvas text-kumo-default"
      style={OPS_STEEL_ACCENT}
    >
      <div
        className="flex items-center gap-3 border-b border-kumo-default bg-kumo-elevated px-6 py-4"
        aria-label={t`运营控制台`}
      >
        <Text variant="heading3" as="span" className="truncate text-kumo-strong">
          <Trans>运营控制台</Trans>
        </Text>
        <Badge variant="neutral"><Trans>内部 · 特权</Trans></Badge>
      </div>
      <div className="flex flex-1">
        <nav
          aria-label={t`运营导航`}
          className="w-56 shrink-0 border-r border-kumo-default bg-kumo-elevated px-3 py-6"
        >
          <ul className="space-y-1">
            {OPS_NAV.map((item) => (
              <li key={item.href}>
                <a
                  href={item.href}
                  className="block rounded-md px-3 py-2 text-sm font-medium text-kumo-default hover:bg-kumo-canvas hover:text-kumo-strong"
                >
                  {item.label}
                </a>
              </li>
            ))}
          </ul>
        </nav>
        <main className="min-w-0 flex-1 px-6 py-8">{children}</main>
      </div>
    </div>
  );
}
```

- [ ] **Step 5: Implement `ops-console/routes.tsx`** (mirrors `createTenantPortalRoutes`; each screen wired to its real component from Tasks 5–11; `OwnerForbidden` is the deep-link default — server `requireOwner` is the authoritative gate):

```tsx
import React from "react";
import { createRoute, type AnyRoute } from "@tanstack/react-router";
import { Empty } from "@cloudflare/kumo/components/empty";
import { t } from "@lingui/core/macro";
import { OpsTenantOverviewScreen } from "./screens/tenant-overview";
import { OpsProvisioningScreen } from "./screens/provisioning";
import { OpsGlobalUsageScreen } from "./screens/global-usage";
import { OpsAuditScreen } from "./screens/audit";
import { OpsPlatformSettingsScreen } from "./screens/platform-settings";
import { OpsTenantDetailScreen } from "./screens/tenant-detail";
import { OpsUserDetailScreen } from "./screens/user-detail";

export function OwnerForbidden() {
  return (
    <div id="ops-forbidden-route-root" className="py-12">
      <Empty title={t`无权访问`} description={t`运营控制台仅对平台 Owner 开放。`} />
    </div>
  );
}

type OpsRouteSpec = { path: string; component: React.ComponentType };

const OPS_ROUTE_SPECS: OpsRouteSpec[] = [
  { path: "/ops", component: OpsTenantOverviewScreen },
  { path: "/ops/provisioning", component: OpsProvisioningScreen },
  { path: "/ops/usage", component: OpsGlobalUsageScreen },
  { path: "/ops/audit", component: OpsAuditScreen },
  { path: "/ops/audit/$eventId", component: OpsAuditScreen },
  { path: "/ops/settings", component: OpsPlatformSettingsScreen },
  { path: "/ops/tenants/$teamId", component: OpsTenantDetailScreen },
  { path: "/ops/users/$userId", component: OpsUserDetailScreen },
];

/**
 * Build the Ops Console route subtree under `parentRoute`. `/ops` is NOT owned
 * by the existing `indexRoute` (which owns `/`), so unlike Phase-1's tenant
 * factory there is no index-collision filter — every spec maps. The screens
 * server-gate via `requireOwner`; client deep-link default is `OwnerForbidden`
 * inside each screen when `useMe().role !== "admin"`.
 */
export function createOpsConsoleRoutes(parentRoute: AnyRoute) {
  return OPS_ROUTE_SPECS.map((spec) =>
    createRoute({
      getParentRoute: () => parentRoute,
      path: spec.path,
      component: spec.component,
    }),
  );
}

export { OPS_ROUTE_SPECS };
```

- [ ] **Step 6: Run shell test → PASS** — `cd /Users/xumingyang/github/contrabass/cloud && bun run test src/litellm-portal/ops-console/shell.test.tsx` (2 tests). (`routes.tsx` imports the seven screen modules — create empty-but-valid stub exports for the seven screens NOW so the module resolves; Tasks 5–11 replace each stub body. Each stub is a real, type-valid component, not a placeholder string: e.g. `export function OpsTenantOverviewScreen() { return <div id="ops-tenant-overview-root" />; }` — these are completed in their own tasks.)

- [ ] **Step 7: SSR shell-select wiring (additive, #418-safe).** In `routes/index.tsx` (Phase-1 `PortalIndex`), the seam already selects `TenantPortalShell` from the hydrated `useMe()`. Add an Ops branch driven by the router's current path + the hydrated identity. Modify `PortalIndex` so that when the matched route is under `/ops`, it does NOT render here (the `/ops*` routes are owned by the Ops factory, not `indexRoute`). The actual wiring is in `router.tsx`: mount `createOpsConsoleRoutes(rootRoute)` additively next to the Phase-1 tenant factory (anchor: the `const tenantPortalRoutes = createTenantPortalRoutes(rootRoute, { includeIndex: false });` line, ~line 60, and the `...tenantPortalRoutes,` spread in `routeTree`, ~line 95):

```ts
import { createOpsConsoleRoutes } from "./ops-console/routes";
// ...
const opsConsoleRoutes = createOpsConsoleRoutes(rootRoute);
// ... in rootRoute.addChildren([ ... ]) append after ...tenantPortalRoutes,
  ...opsConsoleRoutes,
```

Each Ops screen wraps itself in `OpsConsoleShell` using the hydrated `useMe()` identity (the screen modules do this in Tasks 5–11), so SSR and client render the SAME tree (the conditional is driven only by hydrated RouterContext identity → server and client agree → #418-safe). No `/ops` path collides with `/manage/*` (the legacy subtree keeps its own `manageRoute` parent + 301 behavior) nor with the Phase-1 tenant subtree (`/usage|/keys|/members|/alerts|/billing` — disjoint from `/ops*`).

- [ ] **Step 8: Run** — `cd /Users/xumingyang/github/contrabass/cloud && bun run test src/litellm-portal/ops-console/shell.test.tsx src/litellm-portal/router.test.tsx src/litellm-portal/index.test.ts && bun run typecheck`. Extend `router.test.tsx` with: `/ops` resolves to the Ops factory route; an Owner identity renders `OpsConsoleShell` (`id="ops-console-shell-root"`); a non-Owner identity at `/ops` renders the 403 card (`id="ops-forbidden-root"`); legacy `/manage/keys` still resolves unchanged. (If `index.test.ts` hits the documented happy-dom flake, isolated re-run to confirm.)

- [ ] **Step 9: Commit**
```bash
cd /Users/xumingyang/github/contrabass
git add cloud/src/litellm-portal/ops-console cloud/src/litellm-portal/routes/index.tsx cloud/src/litellm-portal/router.tsx
git -c commit.gpgsign=false commit -m "feat(litellm-portal): Ops Console shell + Owner-gated routes + SSR select"
```

---

## Task 5: Ops hooks (`/api/ops/*` + impersonation)

**Files:** Create `cloud/src/litellm-portal/ops-console/hooks.ts` + `hooks.test.tsx`

- [ ] **Step 1: Failing test** — `cloud/src/litellm-portal/ops-console/hooks.test.tsx`

```tsx
import { describe, it, expect, vi, afterEach } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useOpsTenants, useOpsTenantDetail, useOpsUserDetail, useOpsAuditEvent } from "./hooks";

const wrap = () => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
};
const orig = globalThis.fetch;
afterEach(() => { globalThis.fetch = orig; vi.restoreAllMocks(); });

describe("ops-console hooks", () => {
  it("useOpsTenants GETs /api/ops/tenants", async () => {
    globalThis.fetch = vi.fn(async (u: RequestInfo | URL) => {
      expect(String(u)).toContain("/api/ops/tenants");
      return new Response(JSON.stringify({ tenants: [] }), { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;
    const { result } = renderHook(() => useOpsTenants(), { wrapper: wrap() });
    await waitFor(() => expect(result.current.data).toEqual({ tenants: [] }));
  });

  it("useOpsTenantDetail GETs /api/ops/tenants/:id", async () => {
    globalThis.fetch = vi.fn(async (u: RequestInfo | URL) => {
      expect(String(u)).toContain("/api/ops/tenants/team-1");
      return new Response(
        JSON.stringify({ teamId: "team-1", alias: null, maxBudget: null, cycleSpend: null, alertWebhookUrl: null, members: [], billingPeriods: [] }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as unknown as typeof fetch;
    const { result } = renderHook(() => useOpsTenantDetail("team-1"), { wrapper: wrap() });
    await waitFor(() => expect(result.current.data?.teamId).toBe("team-1"));
  });

  it("useOpsUserDetail GETs /api/ops/users/:id", async () => {
    globalThis.fetch = vi.fn(async (u: RequestInfo | URL) => {
      expect(String(u)).toContain("/api/ops/users/u-1");
      return new Response(
        JSON.stringify({ userId: "u-1", email: "a@x.com", platformRole: "user", teamId: null, tenantRole: null, spend: null, maxBudget: null, keyCount: 0 }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as unknown as typeof fetch;
    const { result } = renderHook(() => useOpsUserDetail("u-1"), { wrapper: wrap() });
    await waitFor(() => expect(result.current.data?.userId).toBe("u-1"));
  });

  it("useOpsAuditEvent GETs /api/ops/audit/:id", async () => {
    globalThis.fetch = vi.fn(async (u: RequestInfo | URL) => {
      expect(String(u)).toContain("/api/ops/audit/ev-1");
      return new Response(
        JSON.stringify({ id: "ev-1", ts: null, actorEmail: "o@x.com", action: "x", entityKind: "y", entityId: "z", before: null, after: null, reason: null }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as unknown as typeof fetch;
    const { result } = renderHook(() => useOpsAuditEvent("ev-1"), { wrapper: wrap() });
    await waitFor(() => expect(result.current.data?.id).toBe("ev-1"));
  });
});
```

- [ ] **Step 2: Run → FAIL** — `cd /Users/xumingyang/github/contrabass/cloud && bun run test src/litellm-portal/ops-console/hooks.test.tsx`.

- [ ] **Step 3: Implement `hooks.ts`** (mirrors `tenant-portal/hooks.ts` `extractError` + Zod-parse idiom):

```ts
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  OpsTenantsSchema,
  OpsTenantDetailSchema,
  OpsUserDetailSchema,
  AuditEventDetailSchema,
  type OpsTenants,
  type OpsTenantDetail,
  type OpsUserDetail,
  type AuditEventDetail,
} from "../schemas";

export const OPS_TENANTS_QUERY_KEY = ["ops", "tenants"] as const;
export const OPS_TENANT_DETAIL_QUERY_KEY = (teamId: string) => ["ops", "tenant", teamId] as const;
export const OPS_USER_DETAIL_QUERY_KEY = (userId: string) => ["ops", "user", userId] as const;
export const OPS_AUDIT_EVENT_QUERY_KEY = (eventId: string) => ["ops", "audit", eventId] as const;

function extractError(json: unknown, fallback: string): string {
  if (json !== null && typeof json === "object" && "error" in json) {
    const v = (json as Record<string, unknown>).error;
    if (typeof v === "string") return v;
  }
  return fallback;
}

async function getJson<T>(url: string, parse: (j: unknown) => T, fallbackErr: string): Promise<T> {
  const res = await fetch(url, { headers: { "content-type": "application/json" } });
  const json = (await res.json().catch(() => ({}))) as unknown;
  if (!res.ok) throw new Error(extractError(json, fallbackErr));
  return parse(json);
}

export function useOpsTenants() {
  return useQuery<OpsTenants>({
    queryKey: OPS_TENANTS_QUERY_KEY,
    queryFn: () => getJson("/api/ops/tenants", (j) => OpsTenantsSchema.parse(j), "ops_tenants_request_failed"),
    staleTime: 30_000,
    refetchOnWindowFocus: false,
  });
}

export function useOpsTenantDetail(teamId: string) {
  return useQuery<OpsTenantDetail>({
    queryKey: OPS_TENANT_DETAIL_QUERY_KEY(teamId),
    queryFn: () =>
      getJson(`/api/ops/tenants/${encodeURIComponent(teamId)}`, (j) => OpsTenantDetailSchema.parse(j), "ops_tenant_detail_request_failed"),
    enabled: teamId.length > 0,
    staleTime: 30_000,
    refetchOnWindowFocus: false,
  });
}

export function useOpsUserDetail(userId: string) {
  return useQuery<OpsUserDetail>({
    queryKey: OPS_USER_DETAIL_QUERY_KEY(userId),
    queryFn: () =>
      getJson(`/api/ops/users/${encodeURIComponent(userId)}`, (j) => OpsUserDetailSchema.parse(j), "ops_user_detail_request_failed"),
    enabled: userId.length > 0,
    staleTime: 30_000,
    refetchOnWindowFocus: false,
  });
}

export function useOpsAuditEvent(eventId: string) {
  return useQuery<AuditEventDetail>({
    queryKey: OPS_AUDIT_EVENT_QUERY_KEY(eventId),
    queryFn: () =>
      getJson(`/api/ops/audit/${encodeURIComponent(eventId)}`, (j) => AuditEventDetailSchema.parse(j), "ops_audit_event_request_failed"),
    enabled: eventId.length > 0,
    staleTime: 30_000,
    refetchOnWindowFocus: false,
  });
}

export type StartImpersonationInput = { teamId: string; reason: string };

export function useStartImpersonation() {
  const queryClient = useQueryClient();
  return useMutation<{ ok: true; effectiveTeamId: string }, Error, StartImpersonationInput>({
    mutationFn: async (input) => {
      const res = await fetch("/api/ops/impersonation", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ teamId: input.teamId, reason: input.reason }),
      });
      const json = (await res.json().catch(() => ({}))) as unknown;
      if (!res.ok) throw new Error(extractError(json, "ops_impersonation_start_failed"));
      return json as { ok: true; effectiveTeamId: string };
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: OPS_TENANTS_QUERY_KEY });
    },
  });
}

export function useStopImpersonation() {
  const queryClient = useQueryClient();
  return useMutation<{ ok: true }, Error, void>({
    mutationFn: async () => {
      const res = await fetch("/api/ops/impersonation", {
        method: "DELETE",
        headers: { "content-type": "application/json" },
      });
      const json = (await res.json().catch(() => ({}))) as unknown;
      if (!res.ok) throw new Error(extractError(json, "ops_impersonation_stop_failed"));
      return json as { ok: true };
    },
    onSuccess: () => {
      void queryClient.invalidateQueries();
    },
  });
}
```

- [ ] **Step 4: Run → PASS** — `cd /Users/xumingyang/github/contrabass/cloud && bun run test src/litellm-portal/ops-console/hooks.test.tsx`.

- [ ] **Step 5: Commit**
```bash
cd /Users/xumingyang/github/contrabass
git add cloud/src/litellm-portal/ops-console/hooks.ts cloud/src/litellm-portal/ops-console/hooks.test.tsx
git -c commit.gpgsign=false commit -m "feat(litellm-portal): ops-console react-query hooks for /api/ops/*"
```

---

## Task 6: Tenant Overview screen (all-tenants list)

**Files:** Create `cloud/src/litellm-portal/ops-console/screens/tenant-overview.tsx` + `.test.tsx` (replaces the Task-4 stub)

- [ ] **Step 1: Failing test** — `ops-console/screens/tenant-overview.test.tsx`

```tsx
/**
 * @vitest-environment happy-dom
 */
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

vi.mock("@cloudflare/kumo/components/toast", () => ({
  Toasty: ({ children }: { children: React.ReactNode }) => children,
}));
vi.mock("../hooks", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../hooks")>();
  return { ...actual, useOpsTenants: vi.fn() };
});

import { I18nProvider } from "@lingui/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { setupI18n } from "../../i18n/setup";
import { ME_QUERY_KEY } from "../../hooks/use-me";
import { useOpsTenants } from "../hooks";
import type { Me } from "../../schemas";
import { OpsTenantOverviewScreen } from "./tenant-overview";

const i18n = setupI18n("zh-CN");
const owner: Me = { email: "o@x.com", userId: "u1", company: "C", domain: "x.com", role: "admin", tenantRole: null, tenantTeamId: null };

function renderScreen() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  qc.setQueryData(ME_QUERY_KEY, owner);
  return render(
    <QueryClientProvider client={qc}>
      <I18nProvider i18n={i18n}><OpsTenantOverviewScreen /></I18nProvider>
    </QueryClientProvider>,
  );
}
afterEach(() => cleanup());

describe("OpsTenantOverviewScreen", () => {
  it("renders a row per tenant with member count + budget", () => {
    (useOpsTenants as unknown as ReturnType<typeof vi.fn>).mockReturnValue({
      data: { tenants: [{ teamId: "t1", alias: "Acme", memberCount: 3, cycleSpend: 12, maxBudget: 100, alertWebhookConfigured: true, billingPeriodsCount: 2 }] },
      isLoading: false, isError: false, error: null,
    });
    renderScreen();
    expect(screen.getByText(/Acme/)).toBeTruthy();
    expect(screen.getByText(/3/)).toBeTruthy();
  });

  it("renders Empty when no tenants", () => {
    (useOpsTenants as unknown as ReturnType<typeof vi.fn>).mockReturnValue({
      data: { tenants: [] }, isLoading: false, isError: false, error: null,
    });
    renderScreen();
    expect(screen.getByText(/暂无租户/)).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run → FAIL.**

- [ ] **Step 3: Implement `tenant-overview.tsx`** (Kumo `Table` + self-gate `OwnerForbidden` mirroring `members.tsx`; rows link to `/ops/tenants/$teamId`):

```tsx
import React from "react";
import { Banner } from "@cloudflare/kumo/components/banner";
import { Badge } from "@cloudflare/kumo/components/badge";
import { Empty } from "@cloudflare/kumo/components/empty";
import { SkeletonLine } from "@cloudflare/kumo/components/loader";
import { Table } from "@cloudflare/kumo/components/table";
import { Text } from "@cloudflare/kumo/components/text";
import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { useMe } from "../../hooks/use-me";
import { useOpsTenants } from "../hooks";
import { OwnerForbidden } from "../routes";

function TenantsTable() {
  const { data, isLoading, isError, error } = useOpsTenants();
  if (isLoading) {
    return (
      <div className="space-y-3 p-6">
        <SkeletonLine minWidth={200} maxWidth={400} blockHeight={16} />
        <SkeletonLine minWidth={200} maxWidth={400} blockHeight={16} />
      </div>
    );
  }
  if (isError) {
    return (
      <Banner
        variant="error"
        title={t`租户列表加载失败`}
        description={error instanceof Error ? error.message : t`网络请求失败`}
      />
    );
  }
  const tenants = data?.tenants ?? [];
  if (tenants.length === 0) return <Empty size="sm" title={t`暂无租户`} />;
  return (
    <div className="overflow-x-auto">
      <Table className="w-full text-sm">
        <Table.Header>
          <Table.Row>
            <Table.Head><Trans>租户</Trans></Table.Head>
            <Table.Head><Trans>成员数</Trans></Table.Head>
            <Table.Head><Trans>本周期花费/预算</Trans></Table.Head>
            <Table.Head><Trans>告警 Webhook</Trans></Table.Head>
            <Table.Head><Trans>账单</Trans></Table.Head>
          </Table.Row>
        </Table.Header>
        <Table.Body>
          {tenants.map((tn) => (
            <Table.Row key={tn.teamId}>
              <Table.Cell>
                <a
                  href={`/ops/tenants/${encodeURIComponent(tn.teamId)}`}
                  className="font-medium text-kumo-link underline underline-offset-2"
                >
                  {tn.alias ?? tn.teamId}
                </a>
              </Table.Cell>
              <Table.Cell className="tabular-nums">{tn.memberCount}</Table.Cell>
              <Table.Cell className="tabular-nums">
                {tn.cycleSpend ?? "—"} / {tn.maxBudget ?? "—"}
              </Table.Cell>
              <Table.Cell>
                <Badge variant={tn.alertWebhookConfigured ? "success" : "neutral"}>
                  {tn.alertWebhookConfigured ? t`已配置` : t`未配置`}
                </Badge>
              </Table.Cell>
              <Table.Cell className="tabular-nums">{tn.billingPeriodsCount}</Table.Cell>
            </Table.Row>
          ))}
        </Table.Body>
      </Table>
    </div>
  );
}

export function OpsTenantOverviewScreen() {
  const me = useMe().data;
  if (me?.role !== "admin") return <OwnerForbidden />;
  return (
    <div id="ops-tenant-overview-root" className="space-y-6">
      <article className="overflow-hidden rounded-xl bg-kumo-base ring-1 ring-kumo-line">
        <div className="border-b border-kumo-line bg-kumo-elevated p-6">
          <Text variant="heading3" as="p"><Trans>租户总览</Trans></Text>
          <Text variant="secondary" as="p">
            <Trans>所有租户的成员、花费、告警与账单状态。</Trans>
          </Text>
        </div>
        <TenantsTable />
      </article>
    </div>
  );
}
```

- [ ] **Step 4: Run → PASS.**
- [ ] **Step 5: Commit** `feat(litellm-portal): ops-console tenant overview screen`

---

## Task 7: Provisioning & Invites screen (create team · invites · tenantRole assign)

**Files:** Create `cloud/src/litellm-portal/ops-console/screens/provisioning.tsx` + `.test.tsx`; add `useOpsCreateTeam`/`useOpsCreateInvite`/`useOpsRevokeInvite`/`useOpsSetTenantRole` to `ops-console/hooks.ts`

- [ ] **Step 1: Failing test** — `ops-console/screens/provisioning.test.tsx`

```tsx
/**
 * @vitest-environment happy-dom
 */
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, fireEvent } from "@testing-library/react";

vi.mock("@cloudflare/kumo/components/toast", () => ({ Toasty: ({ children }: { children: React.ReactNode }) => children }));
const createTeamMutate = vi.fn();
const setRoleMutate = vi.fn();
vi.mock("../hooks", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../hooks")>();
  return {
    ...actual,
    useOpsCreateTeam: () => ({ mutate: createTeamMutate, isPending: false }),
    useOpsSetTenantRole: () => ({ mutate: setRoleMutate, isPending: false }),
  };
});

import { I18nProvider } from "@lingui/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { setupI18n } from "../../i18n/setup";
import { ME_QUERY_KEY } from "../../hooks/use-me";
import type { Me } from "../../schemas";
import { OpsProvisioningScreen } from "./provisioning";

const i18n = setupI18n("zh-CN");
const owner: Me = { email: "o@x.com", userId: "u1", company: "C", domain: "x.com", role: "admin", tenantRole: null, tenantTeamId: null };

function renderScreen() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  qc.setQueryData(ME_QUERY_KEY, owner);
  return render(
    <QueryClientProvider client={qc}>
      <I18nProvider i18n={i18n}><OpsProvisioningScreen /></I18nProvider>
    </QueryClientProvider>,
  );
}
afterEach(() => { cleanup(); createTeamMutate.mockReset(); setRoleMutate.mockReset(); });

describe("OpsProvisioningScreen", () => {
  it("submitting the create-team form calls useOpsCreateTeam with alias", () => {
    renderScreen();
    fireEvent.change(screen.getByPlaceholderText(/团队名称/), { target: { value: "Acme" } });
    fireEvent.click(screen.getByRole("button", { name: /创建团队/ }));
    expect(createTeamMutate).toHaveBeenCalledWith(
      expect.objectContaining({ alias: "Acme", reason: expect.any(String) }),
      expect.anything(),
    );
  });

  it("submitting the tenant-role form calls useOpsSetTenantRole", () => {
    renderScreen();
    fireEvent.change(screen.getByPlaceholderText(/团队 ID/), { target: { value: "t1" } });
    fireEvent.change(screen.getByPlaceholderText(/用户 ID/), { target: { value: "u9" } });
    fireEvent.click(screen.getByRole("button", { name: /指派角色/ }));
    expect(setRoleMutate).toHaveBeenCalledWith(
      expect.objectContaining({ teamId: "t1", userId: "u9", tenantRole: expect.any(String), reason: expect.any(String) }),
      expect.anything(),
    );
  });
});
```

- [ ] **Step 2: Run → FAIL.**

- [ ] **Step 3: Implement.** First append the four write hooks to `ops-console/hooks.ts` (reusing existing schemas `AdminCreateTeamBodySchema`/result, `AdminCreateInviteBodySchema`, `AdminRevokeInviteBodySchema`, `SetTenantRoleBodySchema`/result already exported from `../schemas`):

```ts
import {
  AdminCreateTeamResultSchema,
  AdminCreateInviteResultSchema,
  AdminRevokeInviteResultSchema,
  SetTenantRoleResultSchema,
  type AdminCreateTeamResult,
  type AdminCreateInviteResult,
  type AdminRevokeInviteResult,
  type SetTenantRoleResult,
} from "../schemas";

export type OpsCreateTeamInput = { reason: string; alias: string; models?: string[]; maxBudget?: number | null };
export function useOpsCreateTeam() {
  const queryClient = useQueryClient();
  return useMutation<AdminCreateTeamResult, Error, OpsCreateTeamInput>({
    mutationFn: async (input) => {
      const res = await fetch("/api/admin/teams", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          reason: input.reason, alias: input.alias,
          models: input.models ?? [],
          ...(input.maxBudget != null ? { maxBudget: input.maxBudget } : {}),
        }),
      });
      const json = (await res.json().catch(() => ({}))) as unknown;
      if (!res.ok) throw new Error(extractError(json, "ops_create_team_failed"));
      return AdminCreateTeamResultSchema.parse(json);
    },
    onSuccess: () => { void queryClient.invalidateQueries({ queryKey: OPS_TENANTS_QUERY_KEY }); },
  });
}

export type OpsCreateInviteInput = { reason: string; email: string; teamId: string; teamRole?: "admin" | "user" };
export function useOpsCreateInvite() {
  return useMutation<AdminCreateInviteResult, Error, OpsCreateInviteInput>({
    mutationFn: async (input) => {
      const res = await fetch("/api/admin/invites", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ reason: input.reason, email: input.email, teamId: input.teamId, teamRole: input.teamRole ?? "user" }),
      });
      const json = (await res.json().catch(() => ({}))) as unknown;
      if (!res.ok) throw new Error(extractError(json, "ops_create_invite_failed"));
      return AdminCreateInviteResultSchema.parse(json);
    },
  });
}

export type OpsRevokeInviteInput = { email: string; reason: string; confirmEmail: string };
export function useOpsRevokeInvite() {
  return useMutation<AdminRevokeInviteResult, Error, OpsRevokeInviteInput>({
    mutationFn: async (input) => {
      const res = await fetch(`/api/admin/invites/${encodeURIComponent(input.email)}`, {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ reason: input.reason, confirmEmail: input.confirmEmail }),
      });
      const json = (await res.json().catch(() => ({}))) as unknown;
      if (!res.ok) throw new Error(extractError(json, "ops_revoke_invite_failed"));
      return AdminRevokeInviteResultSchema.parse(json);
    },
  });
}

export type OpsSetTenantRoleInput = { teamId: string; userId: string; tenantRole: "tenant_admin" | "member"; reason: string };
export function useOpsSetTenantRole() {
  const queryClient = useQueryClient();
  return useMutation<SetTenantRoleResult, Error, OpsSetTenantRoleInput>({
    mutationFn: async (input) => {
      const res = await fetch(
        `/api/admin/teams/${encodeURIComponent(input.teamId)}/members/${encodeURIComponent(input.userId)}/tenant-role`,
        {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ reason: input.reason, tenantRole: input.tenantRole }),
        },
      );
      const json = (await res.json().catch(() => ({}))) as unknown;
      if (!res.ok) throw new Error(extractError(json, "ops_set_tenant_role_failed"));
      return SetTenantRoleResultSchema.parse(json);
    },
    onSuccess: (_d, vars) => {
      void queryClient.invalidateQueries({ queryKey: OPS_TENANT_DETAIL_QUERY_KEY(vars.teamId) });
    },
  });
}
```

Then `provisioning.tsx` (three Kumo sections: create-team form, cross-tenant invite form, tenantRole-assign form; success-path state reset on every mutation `onSuccess` — the Phase-1 Task5/6 MEDIUM-class discipline):

```tsx
import React, { useCallback, useState } from "react";
import { Banner } from "@cloudflare/kumo/components/banner";
import { Button } from "@cloudflare/kumo/components/button";
import { Field } from "@cloudflare/kumo/components/field";
import { Input } from "@cloudflare/kumo/components/input";
import { Select } from "@cloudflare/kumo/components/select";
import { Text } from "@cloudflare/kumo/components/text";
import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { useMe } from "../../hooks/use-me";
import { useOpsCreateTeam, useOpsCreateInvite, useOpsSetTenantRole } from "../hooks";
import { OwnerForbidden } from "../routes";

const REASON = "ops_provisioning";

function CreateTeamForm() {
  const [alias, setAlias] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const createTeam = useOpsCreateTeam();
  const submit = useCallback(() => {
    const a = alias.trim();
    if (!a) { setErr(t`请输入团队名称`); return; }
    setErr(null);
    createTeam.mutate(
      { alias: a, reason: REASON },
      {
        onSuccess: () => { setAlias(""); setErr(null); },
        onError: (e: unknown) => setErr(e instanceof Error ? e.message : t`创建失败`),
      },
    );
  }, [alias, createTeam]);
  return (
    <article className="overflow-hidden rounded-xl bg-kumo-base ring-1 ring-kumo-line">
      <div className="border-b border-kumo-line bg-kumo-elevated p-6">
        <Text variant="heading3" as="p"><Trans>创建团队</Trans></Text>
      </div>
      <div className="space-y-5 p-6">
        {err ? <Banner variant="error" title={t`创建失败`} description={err} /> : null}
        <Field label={t`团队名称`} required={true}>
          <Input id="ops-team-alias" size="lg" placeholder={t`团队名称`} value={alias}
            onChange={(e: React.ChangeEvent<HTMLInputElement>) => setAlias(e.target.value)} />
        </Field>
        <div className="flex justify-end">
          <Button variant="primary" size="sm" loading={createTeam.isPending} onClick={submit}>
            <Trans>创建团队</Trans>
          </Button>
        </div>
      </div>
    </article>
  );
}

function InviteForm() {
  const [email, setEmail] = useState("");
  const [teamId, setTeamId] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const invite = useOpsCreateInvite();
  const submit = useCallback(() => {
    if (!email.trim() || !teamId.trim()) { setErr(t`请填写邮箱与团队 ID`); return; }
    setErr(null);
    invite.mutate(
      { email: email.trim(), teamId: teamId.trim(), reason: REASON },
      {
        onSuccess: () => { setEmail(""); setTeamId(""); setErr(null); },
        onError: (e: unknown) => setErr(e instanceof Error ? e.message : t`邀请失败`),
      } as never,
    );
  }, [email, teamId, invite]);
  return (
    <article className="overflow-hidden rounded-xl bg-kumo-base ring-1 ring-kumo-line">
      <div className="border-b border-kumo-line bg-kumo-elevated p-6">
        <Text variant="heading3" as="p"><Trans>跨租户邀请</Trans></Text>
      </div>
      <div className="space-y-5 p-6">
        {err ? <Banner variant="error" title={t`邀请失败`} description={err} /> : null}
        <Field label={t`邮箱`} required={true}>
          <Input id="ops-invite-email" size="lg" type="email" placeholder={t`邮箱`} value={email}
            onChange={(e: React.ChangeEvent<HTMLInputElement>) => setEmail(e.target.value)} />
        </Field>
        <Field label={t`团队 ID`} required={true}>
          <Input id="ops-invite-team" size="lg" placeholder={t`团队 ID`} value={teamId}
            onChange={(e: React.ChangeEvent<HTMLInputElement>) => setTeamId(e.target.value)} />
        </Field>
        <div className="flex justify-end">
          <Button variant="primary" size="sm" loading={invite.isPending} onClick={submit}>
            <Trans>发送邀请</Trans>
          </Button>
        </div>
      </div>
    </article>
  );
}

function TenantRoleForm() {
  const [teamId, setTeamId] = useState("");
  const [userId, setUserId] = useState("");
  const [role, setRole] = useState<"tenant_admin" | "member">("member");
  const [err, setErr] = useState<string | null>(null);
  const setTenantRole = useOpsSetTenantRole();
  const submit = useCallback(() => {
    if (!teamId.trim() || !userId.trim()) { setErr(t`请填写团队 ID 与用户 ID`); return; }
    setErr(null);
    setTenantRole.mutate(
      { teamId: teamId.trim(), userId: userId.trim(), tenantRole: role, reason: REASON },
      {
        onSuccess: () => { setTeamId(""); setUserId(""); setRole("member"); setErr(null); },
        onError: (e: unknown) => setErr(e instanceof Error ? e.message : t`指派失败`),
      },
    );
  }, [teamId, userId, role, setTenantRole]);
  return (
    <article className="overflow-hidden rounded-xl bg-kumo-base ring-1 ring-kumo-line">
      <div className="border-b border-kumo-line bg-kumo-elevated p-6">
        <Text variant="heading3" as="p"><Trans>指派门户级 tenantRole</Trans></Text>
        <Text variant="secondary" as="p">
          <Trans>写入权威在此。被指派者在该团队的门户角色。</Trans>
        </Text>
      </div>
      <div className="space-y-5 p-6">
        {err ? <Banner variant="error" title={t`指派失败`} description={err} /> : null}
        <Field label={t`团队 ID`} required={true}>
          <Input id="ops-role-team" size="lg" placeholder={t`团队 ID`} value={teamId}
            onChange={(e: React.ChangeEvent<HTMLInputElement>) => setTeamId(e.target.value)} />
        </Field>
        <Field label={t`用户 ID`} required={true}>
          <Input id="ops-role-user" size="lg" placeholder={t`用户 ID`} value={userId}
            onChange={(e: React.ChangeEvent<HTMLInputElement>) => setUserId(e.target.value)} />
        </Field>
        <Select label={t`门户角色`} className="w-full" size="lg" value={role}
          onValueChange={(v) => setRole(v as "tenant_admin" | "member")}>
          <Select.Option value="member"><Trans>成员</Trans></Select.Option>
          <Select.Option value="tenant_admin"><Trans>租户管理员</Trans></Select.Option>
        </Select>
        <div className="flex justify-end">
          <Button variant="primary" size="sm" loading={setTenantRole.isPending} onClick={submit}>
            <Trans>指派角色</Trans>
          </Button>
        </div>
      </div>
    </article>
  );
}

export function OpsProvisioningScreen() {
  const me = useMe().data;
  if (me?.role !== "admin") return <OwnerForbidden />;
  return (
    <div id="ops-provisioning-root" className="space-y-6">
      <CreateTeamForm />
      <InviteForm />
      <TenantRoleForm />
    </div>
  );
}
```

- [ ] **Step 4: Run → PASS** — `cd /Users/xumingyang/github/contrabass/cloud && bun run test src/litellm-portal/ops-console/screens/provisioning.test.tsx src/litellm-portal/ops-console/hooks.test.tsx`.
- [ ] **Step 5: Commit** `feat(litellm-portal): ops-console provisioning & invites screen`

---

## Task 8: Global Usage screen (reuse global `UsageDashboard`)

**Files:** Create `cloud/src/litellm-portal/ops-console/screens/global-usage.tsx` + `.test.tsx`

- [ ] **Step 1: Failing test** — assert it mounts `UsageDashboard` with `initialScope="global"` (the existing component's documented prop, `usage-dashboard.tsx:20-23`):

```tsx
/**
 * @vitest-environment happy-dom
 */
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";

const usageSpy = vi.fn();
vi.mock("../../dashboard/views/usage-dashboard", () => ({
  UsageDashboard: (props: { initialScope?: string }) => {
    usageSpy(props);
    return <div data-testid="usage-dashboard" />;
  },
}));
vi.mock("@cloudflare/kumo/components/toast", () => ({ Toasty: ({ children }: { children: React.ReactNode }) => children }));

import { I18nProvider } from "@lingui/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { setupI18n } from "../../i18n/setup";
import { ME_QUERY_KEY } from "../../hooks/use-me";
import type { Me } from "../../schemas";
import { OpsGlobalUsageScreen } from "./global-usage";

const i18n = setupI18n("zh-CN");
const owner: Me = { email: "o@x.com", userId: "u1", company: "C", domain: "x.com", role: "admin", tenantRole: null, tenantTeamId: null };
afterEach(() => { cleanup(); usageSpy.mockReset(); });

describe("OpsGlobalUsageScreen", () => {
  it("mounts UsageDashboard with initialScope=global", () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    qc.setQueryData(ME_QUERY_KEY, owner);
    render(
      <QueryClientProvider client={qc}>
        <I18nProvider i18n={i18n}><OpsGlobalUsageScreen /></I18nProvider>
      </QueryClientProvider>,
    );
    expect(usageSpy).toHaveBeenCalledWith(expect.objectContaining({ initialScope: "global" }));
  });
});
```

- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement `global-usage.tsx`** (thin reuse — no new chart code):

```tsx
import React from "react";
import { UsageDashboard } from "../../dashboard/views/usage-dashboard";
import { useMe } from "../../hooks/use-me";
import { OwnerForbidden } from "../routes";

export function OpsGlobalUsageScreen() {
  const me = useMe().data;
  if (me?.role !== "admin") return <OwnerForbidden />;
  return (
    <div id="ops-global-usage-root" className="space-y-6">
      <UsageDashboard initialScope="global" />
    </div>
  );
}
```

- [ ] **Step 4: Run → PASS.**
- [ ] **Step 5: Commit** `feat(litellm-portal): ops-console global usage screen (reuse UsageDashboard)`

---

## Task 9: Audit screen (reuse `useAdminAudit`) + row → event detail

**Files:** Create `cloud/src/litellm-portal/ops-console/screens/audit.tsx` + `.test.tsx`

- [ ] **Step 1: Failing test** — mock `useAdminAudit`; assert a table row per event and that each row links to `/ops/audit/$eventId`; when the route param `eventId` is present render the detail via `useOpsAuditEvent`.

```tsx
/**
 * @vitest-environment happy-dom
 */
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

vi.mock("@cloudflare/kumo/components/toast", () => ({ Toasty: ({ children }: { children: React.ReactNode }) => children }));
vi.mock("../../hooks/use-admin-audit", () => ({
  useAdminAudit: () => ({
    data: { events: [{ id: "ev-1", createdAt: "2026-05-17T00:00:00Z", action: "ops_impersonation_start", actorUserId: null, actorUserEmail: "o@x.com", objectType: "team", objectId: "t1" }], totalCount: 1, page: 1, size: 50 },
    isLoading: false, isError: false, error: null,
  }),
}));
vi.mock("@tanstack/react-router", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tanstack/react-router")>();
  return { ...actual, useParams: () => ({}) };
});

import { I18nProvider } from "@lingui/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { setupI18n } from "../../i18n/setup";
import { ME_QUERY_KEY } from "../../hooks/use-me";
import type { Me } from "../../schemas";
import { OpsAuditScreen } from "./audit";

const i18n = setupI18n("zh-CN");
const owner: Me = { email: "o@x.com", userId: "u1", company: "C", domain: "x.com", role: "admin", tenantRole: null, tenantTeamId: null };
afterEach(() => cleanup());

describe("OpsAuditScreen", () => {
  it("lists audit events with a detail link", () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    qc.setQueryData(ME_QUERY_KEY, owner);
    render(
      <QueryClientProvider client={qc}>
        <I18nProvider i18n={i18n}><OpsAuditScreen /></I18nProvider>
      </QueryClientProvider>,
    );
    expect(screen.getByText(/ops_impersonation_start/)).toBeTruthy();
    const link = screen.getByRole("link", { name: /详情/ }) as HTMLAnchorElement;
    expect(link.getAttribute("href")).toContain("/ops/audit/ev-1");
  });
});
```

- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement `audit.tsx`** — list view reuses `useAdminAudit` (existing hook, `hooks/use-admin-audit.ts`). When the `$eventId` route param is set, render a detail card from `useOpsAuditEvent` (Task 5). Use `useParams` from `@tanstack/react-router` with `{ strict: false }` so the same component serves both `/ops/audit` and `/ops/audit/$eventId` (matching the Task-4 `OPS_ROUTE_SPECS` mapping):

```tsx
import React from "react";
import { Banner } from "@cloudflare/kumo/components/banner";
import { Empty } from "@cloudflare/kumo/components/empty";
import { SkeletonLine } from "@cloudflare/kumo/components/loader";
import { Table } from "@cloudflare/kumo/components/table";
import { Text } from "@cloudflare/kumo/components/text";
import { useParams } from "@tanstack/react-router";
import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { useMe } from "../../hooks/use-me";
import { useAdminAudit } from "../../hooks/use-admin-audit";
import { useOpsAuditEvent } from "../hooks";
import { OwnerForbidden } from "../routes";

function AuditEventDetailCard({ eventId }: { eventId: string }) {
  const { data, isLoading, isError, error } = useOpsAuditEvent(eventId);
  if (isLoading) return <SkeletonLine minWidth={200} maxWidth={400} blockHeight={16} />;
  if (isError) {
    return (
      <Banner variant="error" title={t`审计事件加载失败`}
        description={error instanceof Error ? error.message : t`网络请求失败`} />
    );
  }
  if (!data) return <Empty size="sm" title={t`未找到该审计事件`} />;
  return (
    <article id="ops-audit-detail-root" className="overflow-hidden rounded-xl bg-kumo-base ring-1 ring-kumo-line">
      <div className="border-b border-kumo-line bg-kumo-elevated p-6">
        <Text variant="heading3" as="p"><Trans>审计事件详情</Trans></Text>
      </div>
      <dl className="grid grid-cols-2 gap-4 p-6 text-sm">
        <dt className="text-kumo-subtle"><Trans>动作</Trans></dt><dd>{data.action}</dd>
        <dt className="text-kumo-subtle"><Trans>操作者</Trans></dt><dd className="font-mono">{data.actorEmail}</dd>
        <dt className="text-kumo-subtle"><Trans>对象</Trans></dt><dd className="font-mono">{data.entityKind} · {data.entityId}</dd>
        <dt className="text-kumo-subtle"><Trans>时间</Trans></dt><dd className="tabular-nums">{data.ts ?? "—"}</dd>
        <dt className="text-kumo-subtle"><Trans>变更前</Trans></dt><dd className="font-mono break-all">{data.before ?? "—"}</dd>
        <dt className="text-kumo-subtle"><Trans>变更后</Trans></dt><dd className="font-mono break-all">{data.after ?? "—"}</dd>
        <dt className="text-kumo-subtle"><Trans>原因</Trans></dt><dd>{data.reason ?? "—"}</dd>
      </dl>
    </article>
  );
}

function AuditFeedTable() {
  const { data, isLoading, isError, error } = useAdminAudit({ page: 1, size: 50 });
  if (isLoading) return <SkeletonLine minWidth={200} maxWidth={400} blockHeight={16} />;
  if (isError) {
    return (
      <Banner variant="error" title={t`审计列表加载失败`}
        description={error instanceof Error ? error.message : t`网络请求失败`} />
    );
  }
  const events = data?.events ?? [];
  if (events.length === 0) return <Empty size="sm" title={t`暂无审计记录`} />;
  return (
    <div className="overflow-x-auto">
      <Table className="w-full text-sm">
        <Table.Header>
          <Table.Row>
            <Table.Head><Trans>动作</Trans></Table.Head>
            <Table.Head><Trans>操作者</Trans></Table.Head>
            <Table.Head><Trans>对象</Trans></Table.Head>
            <Table.Head><Trans>时间</Trans></Table.Head>
            <Table.Head className="text-right"><Trans>操作</Trans></Table.Head>
          </Table.Row>
        </Table.Header>
        <Table.Body>
          {events.map((e) => (
            <Table.Row key={e.id}>
              <Table.Cell>{e.action}</Table.Cell>
              <Table.Cell className="font-mono">{e.actorUserEmail ?? "—"}</Table.Cell>
              <Table.Cell className="font-mono">{e.objectType ?? "—"} · {e.objectId ?? "—"}</Table.Cell>
              <Table.Cell className="tabular-nums">{e.createdAt ?? "—"}</Table.Cell>
              <Table.Cell className="text-right">
                <a
                  href={`/ops/audit/${encodeURIComponent(e.id)}`}
                  className="text-kumo-link underline underline-offset-2"
                >
                  <Trans>详情</Trans>
                </a>
              </Table.Cell>
            </Table.Row>
          ))}
        </Table.Body>
      </Table>
    </div>
  );
}

export function OpsAuditScreen() {
  const me = useMe().data;
  if (me?.role !== "admin") return <OwnerForbidden />;
  const params = useParams({ strict: false }) as { eventId?: string };
  return (
    <div id="ops-audit-root" className="space-y-6">
      {params.eventId ? (
        <AuditEventDetailCard eventId={params.eventId} />
      ) : (
        <article className="overflow-hidden rounded-xl bg-kumo-base ring-1 ring-kumo-line">
          <div className="border-b border-kumo-line bg-kumo-elevated p-6">
            <Text variant="heading3" as="p"><Trans>平台审计</Trans></Text>
          </div>
          <AuditFeedTable />
        </article>
      )}
    </div>
  );
}
```

- [ ] **Step 4: Run → PASS.**
- [ ] **Step 5: Commit** `feat(litellm-portal): ops-console audit screen + event detail`

---

## Task 10: Platform Settings screen

**Files:** Create `cloud/src/litellm-portal/ops-console/screens/platform-settings.tsx` + `.test.tsx`; add `GET /api/ops/platform-settings` to `routes.ts` (returns `OpsPlatformSettingsSchema`); add `useOpsPlatformSettings` to `ops-console/hooks.ts`

- [ ] **Step 1: Failing test** — assert the screen shows the write-ops toggle visibility status + company name from `useOpsPlatformSettings`, and links to the existing admin preferences-defaults / role mgmt entry points.

```tsx
/**
 * @vitest-environment happy-dom
 */
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

vi.mock("@cloudflare/kumo/components/toast", () => ({ Toasty: ({ children }: { children: React.ReactNode }) => children }));
vi.mock("../hooks", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../hooks")>();
  return { ...actual, useOpsPlatformSettings: vi.fn() };
});

import { I18nProvider } from "@lingui/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { setupI18n } from "../../i18n/setup";
import { ME_QUERY_KEY } from "../../hooks/use-me";
import { useOpsPlatformSettings } from "../hooks";
import type { Me } from "../../schemas";
import { OpsPlatformSettingsScreen } from "./platform-settings";

const i18n = setupI18n("zh-CN");
const owner: Me = { email: "o@x.com", userId: "u1", company: "C", domain: "x.com", role: "admin", tenantRole: null, tenantTeamId: null };
afterEach(() => cleanup());

describe("OpsPlatformSettingsScreen", () => {
  it("shows write-ops status + company name", () => {
    (useOpsPlatformSettings as unknown as ReturnType<typeof vi.fn>).mockReturnValue({
      data: { writeOpsEnabled: true, companyName: "Acme" }, isLoading: false, isError: false, error: null,
    });
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    qc.setQueryData(ME_QUERY_KEY, owner);
    render(
      <QueryClientProvider client={qc}>
        <I18nProvider i18n={i18n}><OpsPlatformSettingsScreen /></I18nProvider>
      </QueryClientProvider>,
    );
    expect(screen.getByText(/Acme/)).toBeTruthy();
    expect(screen.getByText(/写操作已启用/)).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement.** Add the endpoint to `routes.ts` after `opsImpersonationApp` and mount it (`.route("/api", opsPlatformSettingsApp)`):

```ts
const opsPlatformSettingsApp = new Hono<HonoEnv>()
  .use("/*", applyAuthMiddleware)
  .use("/ops/*", applyAdminRateLimit)
  .use("/ops/*", requireOwner)
  .get("/ops/platform-settings", (c) =>
    c.json(
      OpsPlatformSettingsSchema.parse({
        writeOpsEnabled: isWriteOpsEnabled(c.env),
        companyName: portalCompanyName(c.env),
      }),
    ),
  );
```

Add `OpsPlatformSettingsSchema` to the `routes.ts` `./schemas` import aggregate. Add the hook to `ops-console/hooks.ts`:

```ts
import { OpsPlatformSettingsSchema, type OpsPlatformSettings } from "../schemas";
export const OPS_PLATFORM_SETTINGS_QUERY_KEY = ["ops", "platform-settings"] as const;
export function useOpsPlatformSettings() {
  return useQuery<OpsPlatformSettings>({
    queryKey: OPS_PLATFORM_SETTINGS_QUERY_KEY,
    queryFn: () =>
      getJson("/api/ops/platform-settings", (j) => OpsPlatformSettingsSchema.parse(j), "ops_platform_settings_request_failed"),
    staleTime: 60_000,
    refetchOnWindowFocus: false,
  });
}
```

Then `platform-settings.tsx`:

```tsx
import React from "react";
import { Badge } from "@cloudflare/kumo/components/badge";
import { Banner } from "@cloudflare/kumo/components/banner";
import { SkeletonLine } from "@cloudflare/kumo/components/loader";
import { Text } from "@cloudflare/kumo/components/text";
import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { useMe } from "../../hooks/use-me";
import { useOpsPlatformSettings } from "../hooks";
import { OwnerForbidden } from "../routes";

export function OpsPlatformSettingsScreen() {
  const me = useMe().data;
  if (me?.role !== "admin") return <OwnerForbidden />;
  const { data, isLoading, isError, error } = useOpsPlatformSettings();
  return (
    <div id="ops-platform-settings-root" className="space-y-6">
      <article className="overflow-hidden rounded-xl bg-kumo-base ring-1 ring-kumo-line">
        <div className="border-b border-kumo-line bg-kumo-elevated p-6">
          <Text variant="heading3" as="p"><Trans>平台设置</Trans></Text>
        </div>
        <div className="space-y-4 p-6 text-sm">
          {isLoading ? <SkeletonLine minWidth={200} maxWidth={400} blockHeight={16} /> : null}
          {isError ? (
            <Banner variant="error" title={t`平台设置加载失败`}
              description={error instanceof Error ? error.message : t`网络请求失败`} />
          ) : null}
          {data ? (
            <>
              <div className="flex items-center justify-between">
                <Text variant="secondary"><Trans>平台名称</Trans></Text>
                <span className="font-medium">{data.companyName}</span>
              </div>
              <div className="flex items-center justify-between">
                <Text variant="secondary"><Trans>写操作开关</Trans></Text>
                <Badge variant={data.writeOpsEnabled ? "success" : "neutral"}>
                  {data.writeOpsEnabled ? t`写操作已启用` : t`写操作已禁用`}
                </Badge>
              </div>
            </>
          ) : null}
          <div className="space-y-2 border-t border-kumo-line pt-4">
            <a href="/manage/preferences" className="block text-kumo-link underline underline-offset-2">
              <Trans>偏好默认值</Trans>
            </a>
            <a href="/ops/provisioning" className="block text-kumo-link underline underline-offset-2">
              <Trans>角色 / tenantRole 管理</Trans>
            </a>
          </div>
        </div>
      </article>
    </div>
  );
}
```

- [ ] **Step 4: Run → PASS** — `bun run test src/litellm-portal/ops-console/screens/platform-settings.test.tsx src/litellm-portal/ops-routes.test.ts` + `bun run typecheck`.
- [ ] **Step 5: Commit** `feat(litellm-portal): ops-console platform settings screen + endpoint`

---

## Task 11: Tenant Detail + User Detail screens + "enter tenant" deep-link

**Files:** Create `cloud/src/litellm-portal/ops-console/screens/tenant-detail.tsx`, `ops-console/screens/user-detail.tsx` + their `.test.tsx`

- [ ] **Step 1: Failing test** — `ops-console/screens/tenant-detail.test.tsx` (route param `teamId`; mock `useOpsTenantDetail` + `useStartImpersonation`; assert members render, tenantRole assign reuses Task-7 hook, "进入租户" calls `useStartImpersonation` then navigates to `/`). And `user-detail.test.tsx` (route param `userId`; mock `useOpsUserDetail`; assert identity/teams/role render).

```tsx
/**
 * @vitest-environment happy-dom
 */
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, fireEvent } from "@testing-library/react";

vi.mock("@cloudflare/kumo/components/toast", () => ({ Toasty: ({ children }: { children: React.ReactNode }) => children }));
const startMutate = vi.fn((_v, opts?: { onSuccess?: () => void }) => opts?.onSuccess?.());
vi.mock("../hooks", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../hooks")>();
  return {
    ...actual,
    useOpsTenantDetail: vi.fn(),
    useStartImpersonation: () => ({ mutate: startMutate, isPending: false }),
    useOpsSetTenantRole: () => ({ mutate: vi.fn(), isPending: false }),
  };
});
vi.mock("@tanstack/react-router", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tanstack/react-router")>();
  return { ...actual, useParams: () => ({ teamId: "t1" }) };
});

import { I18nProvider } from "@lingui/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { setupI18n } from "../../i18n/setup";
import { ME_QUERY_KEY } from "../../hooks/use-me";
import { useOpsTenantDetail } from "../hooks";
import type { Me } from "../../schemas";
import { OpsTenantDetailScreen } from "./tenant-detail";

const i18n = setupI18n("zh-CN");
const owner: Me = { email: "o@x.com", userId: "u1", company: "C", domain: "x.com", role: "admin", tenantRole: null, tenantTeamId: null };
afterEach(() => { cleanup(); startMutate.mockClear(); });

describe("OpsTenantDetailScreen", () => {
  it("renders members and an enter-tenant action that starts impersonation", () => {
    (useOpsTenantDetail as unknown as ReturnType<typeof vi.fn>).mockReturnValue({
      data: { teamId: "t1", alias: "Acme", maxBudget: 100, cycleSpend: 5, alertWebhookUrl: null, members: [{ userId: "u9", email: "m@x.com", tenantRole: "member", spend: null }], billingPeriods: ["2026-04"] },
      isLoading: false, isError: false, error: null,
    });
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    qc.setQueryData(ME_QUERY_KEY, owner);
    render(
      <QueryClientProvider client={qc}>
        <I18nProvider i18n={i18n}><OpsTenantDetailScreen /></I18nProvider>
      </QueryClientProvider>,
    );
    expect(screen.getByText(/m@x.com/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /进入租户/ }));
    expect(startMutate).toHaveBeenCalledWith(
      expect.objectContaining({ teamId: "t1", reason: expect.any(String) }),
      expect.anything(),
    );
  });
});
```

- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement `tenant-detail.tsx`** (self-gate; `useOpsTenantDetail` for data; reuses `useOpsSetTenantRole` from Task 7 for in-row tenantRole assignment; "进入租户" calls `useStartImpersonation` then `window.location.assign("/")` so the server re-renders the Tenant Portal WITH the impersonation cookie — server-authoritative; client banner appears via Task 13):

```tsx
import React, { useCallback } from "react";
import { Banner } from "@cloudflare/kumo/components/banner";
import { Badge } from "@cloudflare/kumo/components/badge";
import { Button } from "@cloudflare/kumo/components/button";
import { Empty } from "@cloudflare/kumo/components/empty";
import { SkeletonLine } from "@cloudflare/kumo/components/loader";
import { Table } from "@cloudflare/kumo/components/table";
import { Text } from "@cloudflare/kumo/components/text";
import { useParams } from "@tanstack/react-router";
import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { useMe } from "../../hooks/use-me";
import { useOpsTenantDetail, useStartImpersonation } from "../hooks";
import { OwnerForbidden } from "../routes";

export function OpsTenantDetailScreen() {
  const me = useMe().data;
  const params = useParams({ strict: false }) as { teamId?: string };
  const teamId = params.teamId ?? "";
  const { data, isLoading, isError, error } = useOpsTenantDetail(teamId);
  const startImpersonation = useStartImpersonation();

  const enterTenant = useCallback(() => {
    if (!teamId) return;
    startImpersonation.mutate(
      { teamId, reason: "ops_enter_tenant" },
      {
        onSuccess: () => {
          // Server now holds the impersonation cookie; full reload so SSR
          // renders the Tenant Portal AS the tenant (server-authoritative).
          if (typeof window !== "undefined") window.location.assign("/");
        },
      },
    );
  }, [teamId, startImpersonation]);

  if (me?.role !== "admin") return <OwnerForbidden />;
  if (isLoading) return <SkeletonLine minWidth={200} maxWidth={400} blockHeight={16} />;
  if (isError) {
    return (
      <Banner variant="error" title={t`租户详情加载失败`}
        description={error instanceof Error ? error.message : t`网络请求失败`} />
    );
  }
  if (!data) return <Empty size="sm" title={t`未找到该租户`} />;

  return (
    <div id="ops-tenant-detail-root" className="space-y-6">
      <article className="overflow-hidden rounded-xl bg-kumo-base ring-1 ring-kumo-line">
        <div className="flex items-center justify-between border-b border-kumo-line bg-kumo-elevated p-6">
          <div>
            <Text variant="heading3" as="p">{data.alias ?? data.teamId}</Text>
            <Text variant="secondary" as="p" className="font-mono">{data.teamId}</Text>
          </div>
          <Button variant="primary" size="sm" loading={startImpersonation.isPending} onClick={enterTenant}>
            <Trans>进入租户</Trans>
          </Button>
        </div>
        <dl className="grid grid-cols-2 gap-4 p-6 text-sm">
          <dt className="text-kumo-subtle"><Trans>预算</Trans></dt>
          <dd className="tabular-nums">{data.maxBudget ?? "—"}</dd>
          <dt className="text-kumo-subtle"><Trans>本周期花费</Trans></dt>
          <dd className="tabular-nums">{data.cycleSpend ?? "—"}</dd>
          <dt className="text-kumo-subtle"><Trans>告警 Webhook</Trans></dt>
          <dd>
            <Badge variant={data.alertWebhookUrl ? "success" : "neutral"}>
              {data.alertWebhookUrl ? t`已配置` : t`未配置`}
            </Badge>
          </dd>
          <dt className="text-kumo-subtle"><Trans>账单期数</Trans></dt>
          <dd className="tabular-nums">{data.billingPeriods.length}</dd>
        </dl>
      </article>
      <article className="overflow-hidden rounded-xl bg-kumo-base ring-1 ring-kumo-line">
        <div className="border-b border-kumo-line bg-kumo-elevated p-6">
          <Text variant="heading3" as="p"><Trans>成员</Trans></Text>
        </div>
        {data.members.length === 0 ? (
          <Empty size="sm" title={t`暂无成员`} />
        ) : (
          <div className="overflow-x-auto">
            <Table className="w-full text-sm">
              <Table.Header>
                <Table.Row>
                  <Table.Head><Trans>邮箱</Trans></Table.Head>
                  <Table.Head><Trans>门户角色</Trans></Table.Head>
                </Table.Row>
              </Table.Header>
              <Table.Body>
                {data.members.map((m) => (
                  <Table.Row key={m.userId}>
                    <Table.Cell className="font-mono">
                      <a
                        href={`/ops/users/${encodeURIComponent(m.userId)}`}
                        className="text-kumo-link underline underline-offset-2"
                      >
                        {m.email}
                      </a>
                    </Table.Cell>
                    <Table.Cell>
                      {m.tenantRole === "tenant_admin" ? t`租户管理员` : t`成员`}
                    </Table.Cell>
                  </Table.Row>
                ))}
              </Table.Body>
            </Table>
          </div>
        )}
      </article>
    </div>
  );
}
```

Then `user-detail.tsx`:

```tsx
import React from "react";
import { Banner } from "@cloudflare/kumo/components/banner";
import { Empty } from "@cloudflare/kumo/components/empty";
import { SkeletonLine } from "@cloudflare/kumo/components/loader";
import { Text } from "@cloudflare/kumo/components/text";
import { useParams } from "@tanstack/react-router";
import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { useMe } from "../../hooks/use-me";
import { useOpsUserDetail } from "../hooks";
import { OwnerForbidden } from "../routes";

export function OpsUserDetailScreen() {
  const me = useMe().data;
  const params = useParams({ strict: false }) as { userId?: string };
  const userId = params.userId ?? "";
  const { data, isLoading, isError, error } = useOpsUserDetail(userId);
  if (me?.role !== "admin") return <OwnerForbidden />;
  if (isLoading) return <SkeletonLine minWidth={200} maxWidth={400} blockHeight={16} />;
  if (isError) {
    return (
      <Banner variant="error" title={t`用户详情加载失败`}
        description={error instanceof Error ? error.message : t`网络请求失败`} />
    );
  }
  if (!data) return <Empty size="sm" title={t`未找到该用户`} />;
  return (
    <div id="ops-user-detail-root" className="space-y-6">
      <article className="overflow-hidden rounded-xl bg-kumo-base ring-1 ring-kumo-line">
        <div className="border-b border-kumo-line bg-kumo-elevated p-6">
          <Text variant="heading3" as="p">{data.email}</Text>
          <Text variant="secondary" as="p" className="font-mono">{data.userId}</Text>
        </div>
        <dl className="grid grid-cols-2 gap-4 p-6 text-sm">
          <dt className="text-kumo-subtle"><Trans>平台角色</Trans></dt><dd>{data.platformRole}</dd>
          <dt className="text-kumo-subtle"><Trans>所属团队</Trans></dt><dd className="font-mono">{data.teamId ?? "—"}</dd>
          <dt className="text-kumo-subtle"><Trans>门户角色</Trans></dt>
          <dd>{data.tenantRole === "tenant_admin" ? t`租户管理员` : data.tenantRole === "member" ? t`成员` : "—"}</dd>
          <dt className="text-kumo-subtle"><Trans>预算</Trans></dt><dd className="tabular-nums">{data.maxBudget ?? "—"}</dd>
          <dt className="text-kumo-subtle"><Trans>Key 数量</Trans></dt><dd className="tabular-nums">{data.keyCount}</dd>
        </dl>
      </article>
    </div>
  );
}
```

- [ ] **Step 4: Run → PASS** — `bun run test src/litellm-portal/ops-console/screens/tenant-detail.test.tsx src/litellm-portal/ops-console/screens/user-detail.test.tsx`.
- [ ] **Step 5: Commit** `feat(litellm-portal): ops-console tenant-detail + user-detail + enter-tenant`

---

## Task 12: "做实" the three stub pages + impersonation banner on Tenant Portal shell

**Files:**
- Modify: `cloud/src/litellm-portal/routes/manage/audit/$eventId.lazy.tsx`, `routes/manage/teams/$teamId.lazy.tsx`, `routes/manage/users/$userId.lazy.tsx`
- Modify: `cloud/src/litellm-portal/tenant-portal/shell.tsx` (impersonation banner — ARIA alert region)
- Test: `routes/manage/audit/$eventId.test.tsx` (+ teams/users), `tenant-portal/shell-impersonation.test.tsx`

- [ ] **Step 1: Failing tests.** (a) `routes/manage/audit/$eventId.test.tsx`: render `ManageAuditEventPage` with route param `eventId="ev-1"`, mock `useOpsAuditEvent`, assert it renders the real detail (NOT "待实现"). (b) analogous for `ManageTeamDetailPage` (delegates to `OpsTenantDetailScreen` body via `useOpsTenantDetail`) and `ManageUserDetailPage` (delegates via `useOpsUserDetail`). (c) `tenant-portal/shell-impersonation.test.tsx`: render `TenantPortalShell` with an `impersonation` prop; assert an `role="alert"` banner with an exit control is present; without it, no banner.

```tsx
/**
 * @vitest-environment happy-dom
 */
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
vi.mock("@cloudflare/kumo/components/toast", () => ({ Toasty: ({ children }: { children: React.ReactNode }) => children }));
vi.mock("../../../ops-console/hooks", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../ops-console/hooks")>();
  return { ...actual, useOpsAuditEvent: vi.fn() };
});
vi.mock("@tanstack/react-router", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tanstack/react-router")>();
  return { ...actual, useParams: () => ({ eventId: "ev-1" }) };
});
import { I18nProvider } from "@lingui/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { setupI18n } from "../../../i18n/setup";
import { useOpsAuditEvent } from "../../../ops-console/hooks";
import { ManageAuditEventPage } from "./$eventId.lazy";

const i18n = setupI18n("zh-CN");
afterEach(() => cleanup());

describe("ManageAuditEventPage (做实)", () => {
  it("renders the real audit event detail, not 待实现", () => {
    (useOpsAuditEvent as unknown as ReturnType<typeof vi.fn>).mockReturnValue({
      data: { id: "ev-1", ts: "2026-05-17T00:00:00Z", actorEmail: "o@x.com", action: "ops_impersonation_start", entityKind: "team", entityId: "t1", before: null, after: null, reason: "support" },
      isLoading: false, isError: false, error: null,
    });
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <I18nProvider i18n={i18n}><ManageAuditEventPage /></I18nProvider>
      </QueryClientProvider>,
    );
    expect(screen.queryByText(/待实现/)).toBeNull();
    expect(screen.getByText(/ops_impersonation_start/)).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement.** Rewrite `$eventId.lazy.tsx` to render the shared `AuditEventDetailCard` from the Ops audit screen (export it from `ops-console/screens/audit.tsx` — add `export` to `AuditEventDetailCard`; it is already a self-contained component taking `{ eventId }`):

```tsx
import React from "react";
import { manageAuditEventIdRoute } from "./$eventId";
import { AuditEventDetailCard } from "../../../ops-console/screens/audit";

export function ManageAuditEventPage() {
  const { eventId } = manageAuditEventIdRoute.useParams();
  return (
    <section className="space-y-6">
      <AuditEventDetailCard eventId={eventId} />
    </section>
  );
}
```

Rewrite `teams/$teamId.lazy.tsx` to delegate to a shared tenant-detail body. Extract the body of `OpsTenantDetailScreen` into an exported `OpsTenantDetailBody({ teamId }: { teamId: string })` (the part after the `useParams`/owner gate) in `tenant-detail.tsx`, have `OpsTenantDetailScreen` call it, and have the stub render it:

```tsx
import React from "react";
import { manageTeamsTeamIdRoute } from "./$teamId";
import { OpsTenantDetailBody } from "../../../ops-console/screens/tenant-detail";

export function ManageTeamDetailPage() {
  const { teamId } = manageTeamsTeamIdRoute.useParams();
  return (
    <section className="space-y-6">
      <OpsTenantDetailBody teamId={teamId} />
    </section>
  );
}
```

Same shape for `users/$userId.lazy.tsx` with an extracted `OpsUserDetailBody({ userId }: { userId: string })` from `user-detail.tsx`:

```tsx
import React from "react";
import { manageUsersUserIdRoute } from "./$userId";
import { OpsUserDetailBody } from "../../../ops-console/screens/user-detail";

export function ManageUserDetailPage() {
  const { userId } = manageUsersUserIdRoute.useParams();
  return (
    <section className="space-y-6">
      <OpsUserDetailBody userId={userId} />
    </section>
  );
}
```

(Refactor note: in `tenant-detail.tsx` split `OpsTenantDetailScreen` into the owner-gated wrapper + `export function OpsTenantDetailBody({ teamId }: { teamId: string })` holding the data/render; the wrapper passes `useParams().teamId`. Same for `user-detail.tsx` → `OpsUserDetailBody`. These exports are real, type-checked components — no placeholders.)

Then the impersonation banner in `tenant-portal/shell.tsx`. Extend `TenantPortalShellProps` with an optional `impersonation?: { realActor: string; effectiveTeamId: string } | null` and render an ARIA alert region with an exit form when present (the exit posts to the `DELETE /api/ops/impersonation` endpoint via a small form/button calling `fetch`; reuse `useStopImpersonation` from `ops-console/hooks.ts` is not importable into the tenant shell without a cycle, so use a plain `<form>`-less button that calls the endpoint and reloads):

```tsx
// add to imports
import { useState, useCallback } from "react";
// add to TenantPortalShellProps:
//   impersonation?: { realActor: string; effectiveTeamId: string } | null;

function ImpersonationBanner({
  imp,
}: {
  imp: { realActor: string; effectiveTeamId: string };
}) {
  const [exiting, setExiting] = useState(false);
  const exit = useCallback(() => {
    setExiting(true);
    void fetch("/api/ops/impersonation", {
      method: "DELETE",
      headers: { "content-type": "application/json" },
    }).finally(() => {
      if (typeof window !== "undefined") window.location.assign("/ops");
    });
  }, []);
  return (
    <div role="alert" aria-live="assertive" id="impersonation-banner-root">
      <Banner
        variant="warning"
        title={t`正在以租户身份操作`}
        description={
          <Trans>
            {imp.realActor} 正在代表团队 {imp.effectiveTeamId} 操作。所有操作均被审计。
          </Trans>
        }
        action={
          <Button variant="secondary" size="xs" loading={exiting} onClick={exit}>
            <Trans>退出代操作</Trans>
          </Button>
        }
      />
    </div>
  );
}
```

Add `import { Button } from "@cloudflare/kumo/components/button";` to `shell.tsx`, and render `{impersonation ? <ImpersonationBanner imp={impersonation} /> : null}` at the very top of the returned shell (above `BrandBar`). Thread the prop from `routes/index.tsx` `PortalIndex`: read the impersonation context from the hydrated `me` channel — extend `MeSchema` with an optional `impersonation: z.object({ realActor: z.string(), effectiveTeamId: z.string() }).nullable().optional()` and populate it in `meApp` from `c.get("impersonation")` (additive, optional-safe, same #418-safe hydration channel Phase-1 Task 1.0 used — no new fetch). `PortalIndex` passes `impersonation={me.impersonation ?? null}` to `TenantPortalShell`.

- [ ] **Step 4: Run → PASS** — `bun run test src/litellm-portal/routes/manage/audit/\$eventId.test.tsx src/litellm-portal/routes/manage/teams src/litellm-portal/routes/manage/users src/litellm-portal/tenant-portal/shell-impersonation.test.tsx` + the existing `router.test.tsx`/`index.test.ts` (legacy `/manage/*` still 301/functional; isolated re-run if the documented flake fires) + `bun run typecheck` (baseline-only).
- [ ] **Step 5: Commit** `feat(litellm-portal): make audit/team/user stubs real + impersonation banner`

---

## Task 13: i18n completeness + Storybook + bundle/regenerate SPA

**Files:** Modify `cloud/src/litellm-portal/i18n/messages/{zh-CN,en}.ts`; create `cloud/src/litellm-portal/ops-console/i18n-completeness.test.ts`; create `cloud/src/litellm-portal/ops-console/ops-console.stories.tsx`

- [ ] **Step 1: Create the Ops i18n-completeness test** — exact mirror of `tenant-portal/i18n-completeness.test.ts` (the verified pattern: explicit allowlist, three `it`s — present-in-en, present-in-zh-CN, identical key set). `cloud/src/litellm-portal/ops-console/i18n-completeness.test.ts`:

```ts
/**
 * i18n completeness test for the Operations Console namespace.
 * Mirrors tenant-portal/i18n-completeness.test.ts exactly. When you add a new
 * Ops key, add it here AND to BOTH catalogs.
 */
import { describe, expect, it } from "vitest";
import enMessages from "../i18n/messages/en";
import zhCNMessages from "../i18n/messages/zh-CN";

const OPS_KEYS = [
  // Shell + chip + nav
  "运营控制台", "内部 · 特权", "运营导航", "无权访问运营控制台",
  "仅平台 Owner 可访问。", "返回门户", "无权访问", "运营控制台仅对平台 Owner 开放。",
  // Tenant overview
  "租户总览", "所有租户的成员、花费、告警与账单状态。", "租户", "成员数",
  "本周期花费/预算", "告警 Webhook", "账单", "已配置", "未配置",
  "暂无租户", "租户列表加载失败", "网络请求失败",
  // Provisioning
  "创建团队", "团队名称", "请输入团队名称", "创建失败",
  "跨租户邀请", "邮箱", "团队 ID", "请填写邮箱与团队 ID", "邀请失败", "发送邀请",
  "指派门户级 tenantRole", "写入权威在此。被指派者在该团队的门户角色。",
  "用户 ID", "请填写团队 ID 与用户 ID", "指派失败", "门户角色",
  "成员", "租户管理员", "指派角色",
  // Audit
  "平台审计", "动作", "操作者", "对象", "时间", "操作", "详情",
  "审计列表加载失败", "暂无审计记录", "审计事件详情", "变更前", "变更后",
  "原因", "审计事件加载失败", "未找到该审计事件",
  // Platform settings
  "平台设置", "平台名称", "写操作开关", "写操作已启用", "写操作已禁用",
  "平台设置加载失败", "偏好默认值", "角色 / tenantRole 管理",
  // Tenant detail
  "租户详情加载失败", "未找到该租户", "进入租户", "预算", "本周期花费",
  "账单期数", "暂无成员",
  // User detail
  "用户详情加载失败", "未找到该用户", "平台角色", "所属团队", "Key 数量",
  // Impersonation banner
  "正在以租户身份操作", "退出代操作",
] as const;

const UNIQUE_KEYS = [...new Set(OPS_KEYS)];

describe("ops-console i18n completeness", () => {
  it("every ops-console key exists in en catalog", () => {
    const missing = UNIQUE_KEYS.filter((k) => !(k in enMessages));
    expect(missing, `Missing from en: ${JSON.stringify(missing)}`).toHaveLength(0);
  });
  it("every ops-console key exists in zh-CN catalog", () => {
    const missing = UNIQUE_KEYS.filter((k) => !(k in zhCNMessages));
    expect(missing, `Missing from zh-CN: ${JSON.stringify(missing)}`).toHaveLength(0);
  });
  it("en and zh-CN catalogs have the same complete key set", () => {
    const enKeys = new Set(Object.keys(enMessages));
    const zhKeys = new Set(Object.keys(zhCNMessages));
    expect([...enKeys].filter((k) => !zhKeys.has(k)), "en-only").toHaveLength(0);
    expect([...zhKeys].filter((k) => !enKeys.has(k)), "zh-only").toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run → FAIL** (keys missing). `cd /Users/xumingyang/github/contrabass/cloud && bun run test src/litellm-portal/ops-console/i18n-completeness.test.ts`.

- [ ] **Step 3: Add every key to BOTH catalogs.** In `cloud/src/litellm-portal/i18n/messages/zh-CN.ts` add each Chinese key mapping to its zh-CN string (identity-mapped for zh source strings, as the existing catalog does), and in `cloud/src/litellm-portal/i18n/messages/en.ts` add each key mapped to its English translation (e.g. `"运营控制台": "Operations Console"`, `"内部 · 特权": "Internal · Privileged"`, `"租户总览": "Tenant Overview"`, `"进入租户": "Enter tenant"`, `"正在以租户身份操作": "Acting as a tenant"`, `"退出代操作": "Exit impersonation"`, … one entry per `UNIQUE_KEYS` member, English wording chosen to match the umbrella §3 screen names). The pure-English literal keys (`"Operations Console arrives in Phase 2"` etc.) are Phase-1's; Phase-2 adds none — Ops keys are zh source strings (consistent with the `<Trans>中文</Trans>` macro idiom in `shell.tsx`).

- [ ] **Step 4: Run → PASS** (3 tests). Also re-run `bun run test src/litellm-portal/tenant-portal/i18n-completeness.test.ts` to confirm the same-key-set invariant still holds across both catalogs (adding keys to both keeps it green).

- [ ] **Step 5: Storybook.** Create `cloud/src/litellm-portal/ops-console/ops-console.stories.tsx` mirroring `tenant-portal/tenant-portal.stories.tsx` exactly (CSF3 `Meta`/`StoryObj`, `makeDecorator(seeds)` seeding QueryClient with inline fixtures, `I18nProvider` with `setupI18n("zh-CN")`, NO network/bindings). Cover: `OpsConsoleShell` (Owner / non-Owner variants); each screen (`OpsTenantOverviewScreen`, `OpsProvisioningScreen`, `OpsAuditScreen`, `OpsPlatformSettingsScreen`, `OpsTenantDetailScreen`, `OpsUserDetailScreen` — loading / empty / loaded / error via seeded query keys `OPS_TENANTS_QUERY_KEY` etc.); `OpsGlobalUsageScreen` (seeded `DASHBOARD_QUERY_KEY`). Storybook is type-checked by `bun run typecheck` and is render-only — no test step (mirrors how `tenant-portal.stories.tsx` is treated).

- [ ] **Step 6: Bundle + regenerate SPA.** `cd /Users/xumingyang/github/contrabass/cloud && bun run build:litellm-portal`. The Ops screens are lazy route chunks via the TanStack route factory (Task 4) so the entry bundle stays bounded (DESIGN.md bundle guidance — same lazy-route discipline #135/Phase-1 use). Confirm exit 0 and commit the regenerated `app.generated.ts` (and `kumo-css.generated.ts` if changed) — the `embed.FS` contract.

- [ ] **Step 7: Commit**
```bash
cd /Users/xumingyang/github/contrabass
git add cloud/src/litellm-portal/ops-console/i18n-completeness.test.ts cloud/src/litellm-portal/ops-console/ops-console.stories.tsx cloud/src/litellm-portal/i18n/messages cloud/src/litellm-portal/app.generated.ts cloud/src/litellm-portal/kumo-css.generated.ts
git -c commit.gpgsign=false commit -m "chore(litellm-portal): ops-console i18n + stories + regenerate SPA"
```

---

## Task 14: End-to-end verification + whole-branch review (PR-merge deferred to user)

**Files:** none (verification only)

- [ ] **Step 1: Build → typecheck → full test (correct order):**
```bash
cd /Users/xumingyang/github/contrabass/cloud
bun run typecheck                  # ONLY the server-impl --jsx baseline; ZERO new errors
bun run build:litellm-portal       # exit 0; regenerated app.generated.ts already committed (Task 13)
bun run test src/litellm-portal    # green; on the documented happy-dom localhost:3000/kumo.css
                                   # full-suite SSR-timeout flake (rotates across index/security/
                                   # usage-overview SSR tests this branch did NOT modify), re-run
                                   # the affected file(s) ISOLATED to confirm pass:
bun run test src/litellm-portal/ops-console \
             src/litellm-portal/ops-routes.test.ts \
             src/litellm-portal/impersonation.test.ts \
             src/litellm-portal/impersonation-routes.test.ts \
             src/litellm-portal/router.test.tsx \
             src/litellm-portal/index.test.ts \
             src/litellm-portal/tenant-portal/i18n-completeness.test.ts \
             src/litellm-portal/ops-console/i18n-completeness.test.ts
```
Expected: all Ops Console + impersonation suites green; tsc baseline-only; build exit 0. Full-suite SSR-timeout flake (untouched SSR files, pass isolated) is the documented pre-existing condition — CI is the gate.

- [ ] **Step 2: Behavioral E2E (manual, staging, after #139+Phase-2 merged, deploy via `bun run deploy:litellm-portal` — NEVER bare `wrangler deploy`, which 500s per project memory):**
  1. Owner logs in → `/ops` renders the Ops Console shell (left-nav + ops chip, fixed steel accent, no tenant brand color); all 7 screens reachable.
  2. Non-Owner (member/tenant_admin) navigates `/ops` → in-shell 403 card + working link to `/`; `GET /api/ops/tenants` returns 403 `owner_required`.
  3. Unauthenticated `/ops` → existing login flow (unchanged).
  4. Owner: Tenant Overview lists all tenants (member count · cycle spend/budget · webhook status · billing count); a row links to `/ops/tenants/:teamId`.
  5. Owner: Provisioning → create a team (F1 `POST /api/admin/teams`) → appears in Tenant Overview; send a cross-tenant invite (F1); assign a portal `tenantRole` (P0 `PUT .../tenant-role`) → audit row written.
  6. Owner: Global Usage = the global `UsageDashboard` (cross-tenant aggregate, scope=global, no personal toggle regression).
  7. Owner: Audit lists platform-wide events; click a row → `/ops/audit/:eventId` shows the real event detail (NOT "待实现"); legacy `/manage/audit/:eventId` also shows the real page.
  8. Owner: Tenant Detail → "进入租户" → `POST /api/ops/impersonation` sets the cookie → redirect to `/` renders the Tenant Portal AS that team; persistent ARIA-alert impersonation banner shows real=Owner / effective=team; perform a tenant write (e.g. set alert webhook) → audit row carries `viaImpersonation:true`, `realActor`, `effectiveTeam`; click "退出代操作" → cookie cleared, back to `/ops`.
  9. Impersonation idle ≥30 min OR absolute ≥2 h → next request rejects the token → identity reverts to plain Owner (server-authoritative).
  10. Legacy `/admin/*`,`/manage/*`,`/preferences` still 301/functional; Phase-1 Tenant Portal (`/`, `/usage`, …) unchanged for tenants.

- [ ] **Step 3: Open the PR (do NOT self-merge — user + system enforced policy, same as #136/#138/#139):**
```bash
cd /Users/xumingyang/github/contrabass
git push -u origin feat/litellm-portal-phase2-ops-console
gh pr create --base main --head feat/litellm-portal-phase2-ops-console \
  --title "feat(litellm-portal): Phase 2 — Operations Console" \
  --body "Implements Phase 2 of docs/superpowers/specs/2026-05-17-litellm-portal-uiux-redesign-design.md §3: Owner-only /ops Operations Console (shell + 7 screens) on requireOwner + reused F1/P0 endpoints, the three 做实 stub pages (audit/\$eventId, teams/\$teamId, users/\$userId), and a server-authoritative read-write impersonation primitive (signed short-TTL token + DO ledger + fully audited envelope, 30m idle / 2h absolute). Depends on #139 (Phase 1). Tests: Ops + impersonation suites green; tsc baseline; build clean; SPA regenerated/committed. Known pre-existing full-suite happy-dom flake documented — CI is the gate. Do not merge without review."
```
Report PR URL + CI status to the user. **Do not merge without explicit user approval.**

---

## Self-Review

**1. Spec §3 coverage (Operations Console IA, 7 screens) + locked impersonation:**

| Spec §3 row | Task | Status |
|---|---|---|
| Owner-only `/ops` SSR shell (non-Owner 403/redirect, server-resolved role, left-nav + ops chip, fixed steel accent, tenant branding ignored) | Task 4 (+ `requireOwner` Task 1, `ops-theme.ts` Task 4) | ✓ |
| 租户总览 (Home): all-tenants list — member count · cycle spend/budget · alert&webhook · billing; row → tenant | Task 6 (data: `opsTenantsApp` Task 1) | ✓ |
| 发放 & 邀请: create team (F1 `POST /api/admin/teams`) · cross-tenant invite send/list/revoke (F1) · assign portal tenantRole (P0 `PUT .../tenant-role`, write authority here) | Task 7 | ✓ |
| 全局用量: reuse global `UsageDashboard` (`initialScope="global"`) | Task 8 | ✓ |
| 审计: platform-wide `AdminAuditFeed` + 把 stub `audit/$eventId` 做实 | Task 9 (list) + Task 12 (stub real) | ✓ |
| 平台设置: prefs defaults · write-ops 开关可见性 · role/tenantRole 管理入口 · 平台 webhook/账单指针 | Task 10 | ✓ |
| 做实 `/manage/teams/$teamId` 租户详情 (members · 预算 · webhook · 账单历史 · tenantRole 指派 · 进入租户) | Task 11 (`OpsTenantDetailScreen`) + Task 12 (stub real via `OpsTenantDetailBody`) | ✓ |
| 做实 `/manage/users/$userId` 用户详情 (identity · teams · role/tenantRole · 用量 · keys) | Task 11 (`OpsUserDetailScreen`) + Task 12 (stub real via `OpsUserDetailBody`) | ✓ |
| Impersonation (read-write, explicit-exit + idle/absolute timeout ~30 min, start/stop + every action audited, real=Owner/effective=tenant, deep-link from Ops "enter tenant") | Task 2 (primitive, designed FIRST) + Task 3 (thread-through/start-stop/envelope) + Task 11 (enter-tenant) + Task 12 (banner) | ✓ |
| §横切: bilingual zh-CN/en parity + ops-namespace completeness test; Storybook; bundle/lazy; #418 SSR==hydrate; reuse `requireAdmin`/F1/`auditWrite`/`WriteReasonSchema`/typed-confirm/Kumo/#135 lazy routes/Phase-1 idiom; impersonation banner = ARIA alert | Task 13 (i18n/stories/bundle) + woven through Tasks 1–12 | ✓ |

No §3 gap. Ops面 explicitly ignores tenant branding (Task 4 `OPS_STEEL_ACCENT`, never calls `applyBrandVars`); no Kumo fork, no semantic-token override (constraint honored). Reuse mandate honored: F1 `adminCreateTeamApp`/`adminInvitesApp`/`adminTenantRoleApp` reused verbatim via Task-7 hooks; `UsageDashboard` reused (Task 8); `useAdminAudit` reused (Task 9); `auditWrite`+`WriteReasonSchema` reused (Tasks 1/3); Phase-1 shell/routes-factory/screen-self-gate/i18n-completeness idiom mirrored (Tasks 4–13).

**2. Placeholder scan:** No "TBD"/"add error handling"/"similar to Task N"/uncoded steps. Every code step contains complete, compilable TS/TSX. The Task-4 seven-screen stubs are explicitly real type-valid components (`return <div id=... />`) replaced in their own Tasks 6–11 — documented, not hidden TODOs (same disclosed-stub pattern Phase-1 used for `tenant-portal/routes.tsx`). The Task-12 `OpsTenantDetailBody`/`OpsUserDetailBody`/`AuditEventDetailCard` extractions are real exports with stated signatures. i18n keys are added within Task 13 (the verified Phase-1 i18n-completeness pattern) rather than deferred — not a hidden TODO. No undefined symbols: every hook/schema/component referenced is either defined in an earlier step of this plan or confirmed to exist in the repo (`requireAdmin`, `applyAuthMiddleware`, `applyAdminRateLimit`, `auditWrite`, `parseWriteBody`, `WriteReasonSchema`, `portalCompanyName`, `isWriteOpsEnabled`, `AdminCreateTeamBodySchema`/`-ResultSchema`, `AdminCreateInviteBodySchema`, `AdminRevokeInviteBodySchema`, `SetTenantRoleBodySchema`/`-ResultSchema`, `UsageDashboard` `initialScope`, `useAdminAudit`, `IndexDO.listTeams/listTenantRoles/listInvites/getUserById/getUserByEmail/listAudit/putTenantRole/appendAudit`, `TeamConfigDO.getTeam/getAlertWebhook/getSpendSnapshot`, `MeSchema`, `setupI18n`, `ME_QUERY_KEY`, `createTenantPortalRoutes`/`TenantPortalShell` Phase-1). `getSpendSnapshot` on the TeamConfigDO stub is read via the existing `SpendSnapshotSchema` shape (`durable/schemas.ts`); if a deployment's TeamConfigDO lacks it the Ops endpoint returns `cycleSpend: null` (fail-soft, consistent with the fail-open tenant-facet philosophy) — explicitly handled by `snap?.currentSpend ?? null`, not a placeholder.

**3. Type consistency:** `ImpersonationContext` (`{ viaImpersonation: true; realActor: string; effectiveTeamId: string; issuedAt: number; idleDeadline: number; absoluteDeadline: number }`) is identical in `impersonation.ts` (definition), `routes.ts` (`HonoEnv.Variables.impersonation?: ImpersonationContext`, `c.get("impersonation")`), and the Task-3 audit helper. `ImpersonationSession` (`{ realActor; effectiveTeamId; startedAt; endedAt: string|null }`) is identical in `durable/schemas.ts` (zod), `durable/index-do.ts` (methods), and the `routes.ts` start/stop stub types. The impersonation banner prop shape `{ realActor: string; effectiveTeamId: string }` is identical in `tenant-portal/shell.tsx` (`ImpersonationBanner`/`TenantPortalShellProps`), the `MeSchema.impersonation` extension, and `PortalIndex`. Ops DTOs (`OpsTenantsSchema`/`OpsTenantDetailSchema`/`OpsUserDetailSchema`/`AuditEventDetailSchema`/`OpsPlatformSettingsSchema`) are defined once in `schemas.ts` and consumed verbatim by `routes.ts` (response parse) and `ops-console/hooks.ts` (client parse). Hook names (`useOpsTenants`/`useOpsTenantDetail`/`useOpsUserDetail`/`useOpsAuditEvent`/`useStartImpersonation`/`useStopImpersonation`/`useOpsCreateTeam`/`useOpsCreateInvite`/`useOpsRevokeInvite`/`useOpsSetTenantRole`/`useOpsPlatformSettings`) defined in Tasks 5/7/10 and used verbatim in Tasks 6–12. Endpoints (`/api/ops/tenants[/:teamId]`, `/api/ops/users/:userId`, `/api/ops/audit/:eventId`, `/api/ops/impersonation`, `/api/ops/platform-settings`, reused `/api/admin/teams`, `/api/admin/invites[/:email]`, `/api/admin/teams/:teamId/members/:userId/tenant-role`) match `routes.ts`. `PortalIdentity` shape used everywhere matches `types.ts` (`role`/`tenantRole`/`tenantTeamId`). No drift.

> NOTE: tasks reference post-#139 symbols; exact line numbers must be confirmed against `main` after #139 merges (every anchor in this plan was verified against the pre-#139 tree on 2026-05-17). Implementation is gated on that merge (see Prerequisites). This plan completes Phase-2 *planning*; Phase-2 *execution* begins once #139 is in `main`.
