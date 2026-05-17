# Operations Console (Phase 2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the Owner-only **Operations Console** at `/ops` — a left-nav + ops-chip shell (fixed neutral-steel accent, tenant branding ignored) gated server-side to `role === "admin"`, with seven all-tenant screens (Tenant Overview, Provisioning & Invites, Global Usage, Audit, Platform Settings, Tenant Detail, User Detail) plus a server-authoritative read-write impersonation primitive that lets an Owner "enter a tenant" with a fully audited envelope.

**Architecture:** Evolve within the existing Cloudflare-Worker SSR + React-island + Kumo + TanStack-Router stack (#135/Phase-1). SSR renders one component tree driven by the hydrated `useMe()` identity; a new `/ops` route subtree (mirroring Phase-1's `createTenantPortalRoutes` factory and `routes/index.tsx` shell-select seam) renders `OpsConsoleShell` for Owners and a 403/redirect for everyone else. Screens reuse the Phase-0 `requireAdmin` + F1 endpoints (`POST /api/admin/teams`, `/api/admin/invites`, `PUT /api/admin/teams/:teamId/members/:userId/tenant-role`) and the existing `UsageDashboard`/`AdminAuditFeed`/admin hooks; the three "做实" stub pages (`audit/$eventId`, `teams/$teamId`, `users/$userId`) become real. A new server-authoritative impersonation context (signed short-TTL token threaded into `PortalIdentity`/`requireTenantAdmin`/`auditWrite`) authorizes and audits every Owner-as-tenant write.

**Tech Stack:** TypeScript, Cloudflare Workers (SSR), React islands, `@cloudflare/kumo`, TanStack Router (lazy routes), Hono, Zod, Lingui i18n (zh-CN/en), Vitest (happy-dom + cloudflare:workers via `bun run test`), Storybook, `bun run` toolchain.

---

## Prerequisites (read before Task 1)

- **HARD GATE: PR #139 (Phase 1 — Tenant Portal) MUST be merged into `main` before Phase-2 *execution*.** Phase 0 (#138) is already in `main`. This plan is authored *ahead* per the Phase-0/Phase-1 plan-ahead pattern; Phase-2 *planning* is complete on delivery of this doc, but Phase-2 *implementation* cannot start until #139 is in `main`. Phase 2 anchors on Phase-1 symbols that land with #139: `TenantPortalShell`/`TenantBrand` (`tenant-portal/shell.tsx`), `createTenantPortalRoutes`/`MemberForbidden` (`tenant-portal/routes.tsx`), `applyBrandVars` (`tenant-portal/branding.ts`), the `routes/index.tsx` `PortalIndex` shell-select seam, `MeSchema.tenantRole/tenantTeamId` (`schemas.ts`, already in #138), `useTenantInvites`/`useCreateTenantInvite`/`useRevokeTenantInvite` (`tenant-portal/hooks.ts`), and the `tenant-portal/i18n-completeness.test.ts` namespace test. If #139 is not merged, STOP and merge it first.
- Branch off updated `main` AFTER #139 merges: `git checkout main && git pull && git checkout -b feat/litellm-portal-phase2-ops-console`.
- Symbol-anchored references: post-#139 line numbers shift; anchor by symbol + landmark and `grep`/Read to confirm before editing. Every file:line in this plan was re-verified against the repo on 2026-05-17 (these are the authoritative anchors; confirm again post-#139): `durable/schemas.ts` — `TeamAlertWebhookSchema`@78, `AuditEventSchema`@95, `SpendSnapshotSchema`@69 (`{teamId, currentSpend:number, maxBudget:number|null, fetchedAt}`); `schemas.ts` — `TenantBillingPeriodsSchema`@540; `durable/index-do.ts` — `listTenantRoles`@679 (ends ~704, `storeNonce`@705), `appendAudit`@758; `durable/team-config-do.ts` — `getSpend(): Promise<SpendSnapshot|null>`@493 (there is NO `getSpendSnapshot`), `getTeam(): Promise<TeamRecord|null>`@363; `routes.ts` — `requireTenantAdmin`@645 with the `if (id.role==="admin"){await next();return;}` short-circuit @648, `applyAuthMiddleware`@615; `observability/audit.ts` — `AuditWritePoint`/`auditWrite` (string `before/after/reason`, `AuditEvent` built @~36).
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
| `cloud/src/litellm-portal/durable/schemas.ts` | `ImpersonationSessionSchema` (DO record) + `ImpersonationAuditEnvelopeSchema` + extend `AuditEventSchema` with optional `impersonation` (H1/H2) | Modify |
| `cloud/src/litellm-portal/observability/audit.ts` | First-class `impersonation?: ImpersonationAuditEnvelope \| null` on `AuditWritePoint`/`auditWrite` → `AuditEvent.impersonation` + AE blob (H1/H2) | Modify |
| `cloud/src/litellm-portal/durable/index-do.ts` | `putImpersonationSession`/`getActiveImpersonationSession`/`endImpersonationSession` + `cb_index_impersonation` table; `cb_index_audit_events.impersonation` column + `putAuditSql`/`auditFromRow` round-trip (H1/H2) | Modify |
| `cloud/src/litellm-portal/impersonation.ts` | Impersonation context primitive: `mintImpersonationToken`, `reMintImpersonationToken` (H4 idle-slide, fixed absolute cap), `verifyImpersonationToken`, cookie helpers, `ImpersonationContext` type | Create |
| `cloud/src/litellm-portal/schemas.ts` | `OpsTenantsSchema`, `OpsTenantDetailSchema`, `OpsUserDetailSchema`, `AuditEventDetailSchema`, `StartImpersonationBodySchema`/result, `OpsPlatformSettingsSchema` (client DTOs) | Modify |
| `cloud/src/litellm-portal/routes.ts` | `requireOwner`; `requireImpersonationForOwnerWrite` (C3); impersonation derive + H4 idle re-mint in `applyAuthMiddleware`; typed `impersonationEnvelope` on tenant-path `auditWrite`; `opsTenantsApp`, `opsTenantDetailApp`, `opsUserDetailApp`, `opsAuditDetailApp`, `opsImpersonationApp`, `opsPlatformSettingsApp` sub-apps; mount in `app` | Modify |
| `cloud/src/litellm-portal/ops-console/shell.tsx` | Ops Console shell: left-nav + ops chip + impersonation-aware (no banner here — banner is tenant-side), fixed steel accent, Owner-gated | Create |
| `cloud/src/litellm-portal/ops-console/routes.tsx` | `createOpsConsoleRoutes` factory: pathless `OpsLayout` route owning `<OpsConsoleShell><Outlet/></OpsConsoleShell>` (single client gate) + 7 child path specs | Create |
| `cloud/src/litellm-portal/ops-console/hooks.ts` | React-Query hooks for `/api/ops/*` + impersonation start | Create |
| `cloud/src/litellm-portal/ops-console/screens/tenant-overview.tsx` | All-tenants list (member count · cycle spend/budget · alert/webhook · billing; row → tenant detail) | Create |
| `cloud/src/litellm-portal/ops-console/screens/provisioning.tsx` | Create team (F1) · cross-tenant invite send/list/revoke (F1) · assign portal tenantRole (P0 admin endpoint) | Create |
| `cloud/src/litellm-portal/ops-console/screens/global-usage.tsx` | Reuse global `UsageDashboard` (`initialScope="global"`) | Create |
| `cloud/src/litellm-portal/ops-console/screens/audit.tsx` | Platform-wide `AdminAuditFeed` (reuse `useAdminAudit`) + row → event detail | Create |
| `cloud/src/litellm-portal/ops-console/screens/platform-settings.tsx` | Prefs defaults · write-ops visibility · role/tenantRole mgmt entry · platform webhook/billing pointers | Create |
| `cloud/src/litellm-portal/ops-console/screens/tenant-detail.tsx` | Tenant detail (members · budget · webhook · billing history · tenantRole assign · enter-tenant) | Create |
| `cloud/src/litellm-portal/ops-console/screens/user-detail.tsx` | User detail (identity · teams · role/tenantRole · usage history · keys) | Create |
| `cloud/src/litellm-portal/ops-console/ops-theme.ts` | Fixed neutral-steel accent CSS-var constant (no Kumo fork) | Create |
| `cloud/src/litellm-portal/router.tsx` | Mount the `createOpsConsoleRoutes(rootRoute)` pathless layout route additively (no `/`, `/manage/*`, or Phase-1-tenant collision). `routes/index.tsx`/`PortalIndex` is NOT touched (H3) | Modify |
| `cloud/src/litellm-portal/routes/__root.tsx` | Split `RootLayout`: outer URL-branch component returns `<Outlet/>` at `/ops*` (Ops shell is sole chrome — C-NEW-1), `PortalRootLayout` keeps the unchanged generic chrome for all other routes | Modify |
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

  it("authenticated NON-admin /api/ops/tenants → 403 owner_required (route-level gate)", async () => {
    // A real authenticated user who is NOT a bootstrap/Owner admin: auth
    // passes, resolveIdentity yields role !== "admin", requireOwner rejects.
    // (Not on BOOTSTRAP_ADMIN_EMAILS, allowed to log in via the email domain.)
    const env = {
      PORTAL_ALLOWED_EMAIL_DOMAINS: "x.com",
      LITELLM_PORTAL_ALLOWED_EMAILS: "user@x.com",
    } as never;
    const res = await app.fetch(
      reqOps("/api/ops/tenants", { "cf-access-authenticated-user-email": "user@x.com" }),
      env,
    );
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "owner_required" });
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
    // Owner gate passes (bootstrap admin); the handler then reports the missing
    // DO with EXACTLY 503 index_do_unavailable (the `idxOps(c.env) == null`
    // branch). 502/500 here would mean a different failure — assert tightly.
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "index_do_unavailable" });
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
  // First-class, queryable impersonation envelope (H1/H2). Mirrors
  // ImpersonationAuditEnvelopeSchema in durable/schemas.ts. Null when the
  // write was a direct (non-impersonated) action.
  impersonation: z
    .object({
      realActor: z.string(),
      effectiveTeam: z.string(),
      viaImpersonation: z.literal(true),
    })
    .nullable(),
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

// Stub typed to the REAL TeamConfigDO surface (durable/team-config-do.ts):
//   getTeam(): Promise<TeamRecord | null>   — TeamRecord.maxBudget is OPTIONAL
//   getAlertWebhook(): Promise<TeamAlertWebhook | null>
//   getSpend(): Promise<SpendSnapshot | null>   — there is NO getSpendSnapshot.
// SpendSnapshot (durable/schemas.ts:69) = { teamId; currentSpend:number;
//   maxBudget:number|null; fetchedAt }. Budget precedence (explicit): the
//   spend snapshot's maxBudget is the BUDGET-CYCLE-authoritative value (the
//   spend cron writes it alongside currentSpend), so it WINS; fall back to
//   the TeamRecord.maxBudget only when no snapshot exists.
type TeamConfigDOOpsStub = {
  getTeam(): Promise<{ id: string; alias: string; maxBudget?: number } | null>;
  getAlertWebhook(): Promise<{ url: string } | null>;
  getSpend(): Promise<{ currentSpend: number; maxBudget: number | null } | null>;
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

/**
 * Fan-out one team's DO reads, fail-soft: any DO error for one team yields
 * all-null facets so a single bad/cold DO can never 500 the whole list
 * (this is the actual catch the Self-Review claims; without it the claim
 * was false). Mirrors the fail-open tenant-facet philosophy.
 */
async function readTeamFacets(
  env: LiteLLMPortalEnv,
  teamId: string,
): Promise<{
  alias: string | null;
  cycleSpend: number | null;
  maxBudget: number | null;
  alertWebhookUrl: string | null;
}> {
  const tc = teamOps(env, teamId);
  if (tc == null) {
    return { alias: null, cycleSpend: null, maxBudget: null, alertWebhookUrl: null };
  }
  try {
    const [teamRec, webhook, snap] = await Promise.all([
      tc.getTeam().catch(() => null),
      tc.getAlertWebhook().catch(() => null),
      tc.getSpend().catch(() => null),
    ]);
    return {
      alias: teamRec?.alias ?? null,
      cycleSpend: snap?.currentSpend ?? null,
      // snapshot maxBudget wins (budget-cycle authoritative); else team record.
      maxBudget: snap?.maxBudget ?? teamRec?.maxBudget ?? null,
      alertWebhookUrl: webhook?.url ?? null,
    };
  } catch {
    return { alias: null, cycleSpend: null, maxBudget: null, alertWebhookUrl: null };
  }
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
        const f = await readTeamFacets(c.env, team.id);
        return {
          teamId: team.id,
          alias: team.alias ?? f.alias,
          memberCount,
          cycleSpend: f.cycleSpend,
          maxBudget: f.maxBudget,
          alertWebhookConfigured: f.alertWebhookUrl != null,
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
    const f = await readTeamFacets(c.env, teamId);
    const roles = await idx.listTenantRoles({ teamId });
    const members = await Promise.all(
      roles.map(async (r) => {
        const u = await idx.getUserById(r.userId).catch(() => null);
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
        alias: f.alias,
        maxBudget: f.maxBudget,
        cycleSpend: f.cycleSpend,
        alertWebhookUrl: f.alertWebhookUrl,
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

// Extract the first-class impersonation envelope from a stored AuditEvent.
// auditWrite (Task 3) writes it as a typed AuditEvent.impersonation field
// (durable/schemas.ts ImpersonationAuditEnvelopeSchema); when present, return
// it; else null. Tolerant of the unknown-typed column.
function readImpersonationEnvelope(
  raw: unknown,
): { realActor: string; effectiveTeam: string; viaImpersonation: true } | null {
  const parsed = ImpersonationAuditEnvelopeSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

const opsAuditDetailApp = new Hono<HonoEnv>()
  .use("/*", applyAuthMiddleware)
  .use("/ops/*", applyAdminRateLimit)
  .use("/ops/*", requireOwner)
  .get("/ops/audit/:eventId", async (c) => {
    const eventId = decodeURIComponent(c.req.param("eventId") ?? "").trim();
    if (!eventId) return c.json({ error: "event_id_required" }, 400);
    if (!c.env.INDEX_DO) return c.json({ error: "index_do_unavailable" }, 503);
    // listAudit supports cursor pagination ({ limit, before } — durable/
    // index-do.ts:797). A bare find() over a single 500-row page silently
    // 404s any event older than 500 (M2). Page backward by the last row's
    // `ts` cursor until the event is found or the log is exhausted, capped at
    // 50 pages (~25k events) to bound worst-case fan-out.
    type AuditRow = {
      id: string; ts: string; actorEmail: string; action: string;
      entityKind: string; entityId: string;
      before: unknown; after: unknown; reason: string | null;
      impersonation?: unknown;
    };
    type IndexDOAuditListStub = {
      listAudit(opts?: { limit?: number; before?: string }): Promise<AuditRow[]>;
    };
    const idx = c.env.INDEX_DO.get(
      c.env.INDEX_DO.idFromName("index"),
    ) as unknown as IndexDOAuditListStub;
    const PAGE = 500;
    const MAX_PAGES = 50;
    let before: string | undefined;
    let ev: AuditRow | undefined;
    for (let i = 0; i < MAX_PAGES; i += 1) {
      const page: AuditRow[] = await idx.listAudit(
        before === undefined ? { limit: PAGE } : { limit: PAGE, before },
      );
      if (page.length === 0) break;
      ev = page.find((e) => e.id === eventId);
      if (ev != null) break;
      before = page[page.length - 1].ts;
      if (page.length < PAGE) break;
    }
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
        impersonation: readImpersonationEnvelope(ev.impersonation),
      }),
    );
  });
```

`ImpersonationAuditEnvelopeSchema` is defined in `durable/schemas.ts` in Task 3 (H1/H2). Add it to the `routes.ts` import from `./durable/schemas` (the aggregate that already imports `AuditEvent`).

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

**Design (the envelope, locked):** an Owner starts impersonation of `teamId`. The server mints a signed, short-TTL token (HMAC-SHA256 over a JSON payload, reusing the `PORTAL_SESSION_SECRET` HMAC pattern) carrying `{ realActor, effectiveTeamId, issuedAt, idleDeadline, absoluteDeadline }`. The token rides in a dedicated `cb_imp` cookie (HttpOnly, SameSite=Strict, Secure). On every request, `applyAuthMiddleware` verifies the token (signature + both deadlines) and, when valid, attaches an `ImpersonationContext` to `c.set("identity", ...)` by **deriving a tenant-scoped identity** (`role` stays the real Owner role for read superset, but `tenantTeamId`/`tenantRole` are pinned to the impersonated team so `requireTenantAdmin`/`tenantTeamOr403` authorize tenant writes). A server-side DO record (`cb_index_impersonation`) is the authoritative session ledger (start/stop timestamps) so the Owner can be force-exited and so stop is auditable even if the cookie is lost. Every audited write while impersonating carries the typed `ImpersonationAuditEnvelope` `{ realActor, effectiveTeam, viaImpersonation: true }` (the canonical field names — `effectiveTeam`, NOT `effectiveTenant`/`effectiveTeamId` — used identically everywhere; see H1/H2). Client banner is UX only.

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

- [ ] **Step 4: Add the DO ledger record + the typed audit envelope + extend `AuditEventSchema` (H1/H2 schema home).** In `durable/schemas.ts`, append after `TeamAlertWebhookSchema` (anchor: `export const TeamAlertWebhookSchema`@78):

```ts
export const ImpersonationSessionSchema = z.object({
  realActor: z.string(),
  effectiveTeamId: z.string(),
  startedAt: z.string().datetime(),
  endedAt: z.string().datetime().nullable(),
}).strict();

export type ImpersonationSession = z.infer<typeof ImpersonationSessionSchema>;

/**
 * H1/H2: the ONE canonical, queryable impersonation-audit envelope. Defined
 * once here, referenced by AuditEvent (below), AuditWritePoint/auditWrite
 * (observability/audit.ts), the /api/ops/audit/:eventId projection
 * (AuditEventDetailSchema in schemas.ts), and the Task-9/12 detail card.
 * NOT a per-callsite JSON blob stuffed into `after`.
 */
export const ImpersonationAuditEnvelopeSchema = z.object({
  realActor: z.string(),
  effectiveTeam: z.string(),
  viaImpersonation: z.literal(true),
}).strict();

export type ImpersonationAuditEnvelope = z.infer<typeof ImpersonationAuditEnvelopeSchema>;
```

Then EXTEND `AuditEventSchema` (anchor: `export const AuditEventSchema`@95) — add ONE optional, nullable field (additive, `.strict()` still holds because the key is now declared); old rows without it parse as `impersonation: undefined`:

```ts
// inside AuditEventSchema's z.object({ ... }) — add after `reason`:
  impersonation: ImpersonationAuditEnvelopeSchema.nullable().optional(),
```

`AuditEvent` (the inferred type) now carries an optional first-class `impersonation` field — queryable/indexable, NOT a string blob.

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

Add `ImpersonationSession`/`ImpersonationSessionSchema` AND `ImpersonationAuditEnvelopeSchema`/`ImpersonationAuditEnvelope` to the existing `import { ... } from "./schemas"` block at the top of `durable/index-do.ts` (anchor: the aggregate schema import).

- [ ] **Step 4b: Persist the new `AuditEvent.impersonation` field through `appendAudit` (H1/H2 — make it queryable, not lost).** The real `appendAudit` (`durable/index-do.ts:758`) `AuditEventSchema.parse`s the event then `putAuditSql`s it; `cb_index_audit_events` (created in `initializeSql`, anchor: the `CREATE TABLE IF NOT EXISTS cb_index_audit_events` block ~line 208) has no impersonation column and `auditFromRow` (anchor: `function auditFromRow`, the `AuditEventSchema.parse({...})` row mapper ~line 146) does not map it. Add — additively, migration-safe (the `CREATE TABLE IF NOT EXISTS` already exists; an existing DO needs the column added):

  1. In `initializeSql`, AFTER the `cb_index_audit_events` `CREATE TABLE IF NOT EXISTS` + its `CREATE INDEX`, add an idempotent column-add + index (SQLite has no `ADD COLUMN IF NOT EXISTS`; guard via PRAGMA):
```ts
// after the cb_index_audit_events CREATE TABLE/INDEX statements:
const auditCols = sql
  .exec<{ name: string }>("PRAGMA table_info(cb_index_audit_events)")
  .toArray()
  .map((r) => r.name);
if (!auditCols.includes("impersonation")) {
  sql.exec("ALTER TABLE cb_index_audit_events ADD COLUMN impersonation TEXT");
}
sql.exec(
  `CREATE INDEX IF NOT EXISTS cb_index_audit_events_imp_team_idx
     ON cb_index_audit_events (json_extract(impersonation, '$.effectiveTeam'))`,
);
```
  2. In `putAuditSql` (anchor: `private putAuditSql`, the `INSERT INTO cb_index_audit_events (...)` ~line 411), add the `impersonation` column to the column list + a bound param `event.impersonation == null ? null : JSON.stringify(event.impersonation)`.
  3. In `auditFromRow`, map it back: `impersonation: row.impersonation == null ? null : ImpersonationAuditEnvelopeSchema.parse(JSON.parse(String(row.impersonation)))`. The KV-fallback path (`this.ctx.storage.put(audit:<id>, parsed)`) already round-trips the whole parsed object, so the field rides along automatically there.
  4. Add a DO test (`durable/index-do-audit-impersonation.test.ts`): `appendAudit` an event WITH `impersonation: { realActor, effectiveTeam, viaImpersonation: true }`, then `listAudit` and assert the field round-trips (SQL path) and that an event WITHOUT it yields `impersonation: null`.

- [ ] **Step 5: Run → PASS** — `cd /Users/xumingyang/github/contrabass/cloud && bun run test src/litellm-portal/impersonation.test.ts` (4 tests) + `bun run test src/litellm-portal/durable` (existing DO tests still green; the new audit-impersonation round-trip test passes) + `bun run typecheck` (baseline-only).

- [ ] **Step 6: Commit**
```bash
cd /Users/xumingyang/github/contrabass
git add cloud/src/litellm-portal/impersonation.ts cloud/src/litellm-portal/impersonation.test.ts cloud/src/litellm-portal/durable/schemas.ts cloud/src/litellm-portal/durable/index-do.ts cloud/src/litellm-portal/durable/index-do-audit-impersonation.test.ts
git -c commit.gpgsign=false commit -m "feat(litellm-portal): impersonation primitive + DO ledger + audit envelope schema"
```

---

## Task 3: Impersonation thread-through + start/stop endpoints + audit envelope

**Files:** Modify `cloud/src/litellm-portal/observability/audit.ts` (first-class `impersonation` on `AuditWritePoint`/`auditWrite`), `cloud/src/litellm-portal/routes.ts` (`applyAuthMiddleware` derive + re-mint, `requireImpersonationForOwnerTenantWrite` C3 guard, `opsImpersonationApp` start/stop, typed envelope on tenant writes); Test `cloud/src/litellm-portal/impersonation-routes.test.ts`

- [ ] **Step 1: Failing test** — `cloud/src/litellm-portal/impersonation-routes.test.ts`

```ts
import { describe, expect, it } from "vitest";
import { app } from "./routes";
import {
  mintImpersonationToken,
  IMPERSONATION_COOKIE,
} from "./impersonation";

const OWNER_ENV = {
  LITELLM_PORTAL_ALLOWED_EMAILS: "owner@x.com",
  BOOTSTRAP_ADMIN_EMAILS: "owner@x.com",
  PORTAL_SESSION_SECRET: "test-secret-0123456789",
  LITELLM_PORTAL_WRITE_OPS_ENABLED: "true",
} as never;

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
    const res = await app.fetch(
      new Request("http://localhost/api/ops/impersonation", {
        method: "DELETE",
        headers: { "cf-access-authenticated-user-email": "owner@x.com" },
      }),
      OWNER_ENV,
    );
    expect([200, 503]).toContain(res.status);
    if (res.status === 200) {
      expect(res.headers.get("set-cookie") ?? "").toContain(`${IMPERSONATION_COOKIE}=;`);
    }
  });
});

describe("C3 — Owner-as-tenant write audit-escape is closed", () => {
  it("plain Owner (no impersonation cookie) POST /api/tenant/invites → 403 impersonation_required", async () => {
    const res = await app.fetch(
      new Request("http://localhost/api/tenant/invites", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "cf-access-authenticated-user-email": "owner@x.com",
        },
        body: JSON.stringify({ reason: "support", email: "x@y.com", teamRole: "user" }),
      }),
      OWNER_ENV,
    );
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "impersonation_required" });
  });

  it("Owner WITH a valid impersonation cookie passes the C3 guard (no impersonation_required)", async () => {
    const token = await mintImpersonationToken("test-secret-0123456789", {
      realActor: "owner@x.com",
      effectiveTeamId: "team-1",
      now: Date.now(),
    });
    const res = await app.fetch(
      new Request("http://localhost/api/tenant/invites", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "cf-access-authenticated-user-email": "owner@x.com",
          cookie: `${IMPERSONATION_COOKIE}=${token}`,
        },
        body: JSON.stringify({ reason: "support", email: "x@y.com", teamRole: "user" }),
      }),
      OWNER_ENV,
    );
    // Past the C3 guard: the failure (if any) is now a downstream DO/dependency
    // error, NEVER the impersonation_required gate.
    expect(res.status).not.toBe(403);
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    expect(body.error).not.toBe("impersonation_required");
  });
});

describe("H4 — idle re-mint extends idle but not absolute", () => {
  it("re-minting at t+20m keeps the original absoluteDeadline", async () => {
    const t0 = 1_000_000_000;
    const first = await mintImpersonationToken("s", {
      realActor: "o@x.com", effectiveTeamId: "team-1", now: t0,
    });
    // Decode the first token's absoluteDeadline (b64url payload before the dot).
    const decode = (tok: string) =>
      JSON.parse(
        new TextDecoder().decode(
          Uint8Array.from(
            atob(tok.split(".")[0].replace(/-/g, "+").replace(/_/g, "/")),
            (c) => c.charCodeAt(0),
          ),
        ),
      ) as { idleDeadline: number; absoluteDeadline: number };
    const a = decode(first);
    // mintImpersonationToken always sets absoluteDeadline = now + 2h; a re-mint
    // MUST carry the ORIGINAL absoluteDeadline, so it cannot be a fresh mint.
    // The re-mint helper (reMintImpersonationToken) is the unit under test:
    const { reMintImpersonationToken } = await import("./impersonation");
    const remint = await reMintImpersonationToken("s", a /* prior payload */, t0 + 20 * 60 * 1000);
    const b = decode(remint);
    expect(b.absoluteDeadline).toBe(a.absoluteDeadline);   // unchanged (H4)
    expect(b.idleDeadline).toBeGreaterThan(a.idleDeadline); // extended (H4)
  });
});
```

- [ ] **Step 2: Run → FAIL** — `cd /Users/xumingyang/github/contrabass/cloud && bun run test src/litellm-portal/impersonation-routes.test.ts`.

- [ ] **Step 2b: Add `reMintImpersonationToken` to `impersonation.ts` (H4 — idle slide, absolute cap fixed).** `mintImpersonationToken` always recomputes BOTH deadlines from `now`, so calling it on activity would silently reset the 2h absolute cap → the absolute tier becomes unreachable (H4). Add a dedicated re-mint that carries the ORIGINAL `absoluteDeadline` and slides ONLY `idleDeadline`:

```ts
// in impersonation.ts, after mintImpersonationToken:
export async function reMintImpersonationToken(
  secret: string,
  prior: { realActor: string; effectiveTeamId: string; issuedAt: number; absoluteDeadline: number },
  now: number,
): Promise<string> {
  const payload: Payload = {
    realActor: prior.realActor,
    effectiveTeamId: prior.effectiveTeamId,
    issuedAt: prior.issuedAt,            // preserve original session origin
    idleDeadline: now + IDLE_MS,         // slide the idle window
    absoluteDeadline: prior.absoluteDeadline, // HARD 2h cap — never extended
  };
  const body = b64urlEncode(new TextEncoder().encode(JSON.stringify(payload)));
  const sig = b64urlEncode(await hmac(secret, body));
  return `${body}.${sig}`;
}
```
`verifyImpersonationToken` already returns the full payload (incl. `issuedAt`/`absoluteDeadline`), so the middleware has everything `reMintImpersonationToken` needs. Add this to the Task-2 `impersonation.test.ts` round-trip suite too (assert `reMint` past the absolute cap still fails `verify`).

- [ ] **Step 3: Implement.** In `observability/audit.ts` (H1/H2 — first-class envelope on the write path):

```ts
// extend AuditWritePoint (anchor: `export type AuditWritePoint = AuditPoint & {`):
export type AuditWritePoint = AuditPoint & {
  before: string;
  after: string;
  reason: string;
  impersonation?: ImpersonationAuditEnvelope | null;
};
// import the type at the top of observability/audit.ts (it already imports
// AuditEvent from ../durable/schemas — extend that import):
//   import type { AuditEvent, ImpersonationAuditEnvelope } from "../durable/schemas";
// in auditWrite, when building `auditEvent: AuditEvent`, add:
//   impersonation: point.impersonation ?? null,
// and APPEND a 9th blob to the AUDIT_AE writeDataPoint blobs array (current
// blobs are [actor, action, target, ip, ts, before, after, reason] = 8;
// add as the 9th, AFTER point.reason):
//   point.impersonation ? JSON.stringify(point.impersonation) : "",
```

**M-NEW-2 — AE 9th blob is APPEND-ONLY and positionally safe; SQL is the authoritative queryable path.** Verified against the repo (2026-05-17): there is NO consumer that reads `AUDIT_AE` blobs positionally — the only `AUDIT_AE` references are the `writeDataPoint` writers in `observability/audit.ts` and `observability/observability.test.ts`, which asserts blob CONTENT via `.toContain(...)` only (no `.length`/index assertions, no `blobs[n]` reads), plus the `AUDIT_AE?` binding type and an `index.test.ts` mock. AE schema limit is 20 blobs; 8→9 is within budget. Appending (never reordering/inserting) the 9th blob therefore cannot break any reader or existing test. **Scope it explicitly:** the AE blob is a best-effort, append-only analytics breadcrumb — it is NOT the queryable source of truth. The authoritative, queryable impersonation-audit path is the typed `AuditEvent.impersonation` column in `cb_index_audit_events` (the indexed DO column + `putAuditSql`/`auditFromRow` round-trip from Task-2 Step-4b, with the `durable/index-do-audit-impersonation.test.ts` round-trip test as the guarantee, and the `cb_index_audit_events_imp_team_idx` index for `effectiveTeam` queries). The plan must NOT claim the AE sink is "queryable"; it is a redundant best-effort mirror only.

Then in `routes.ts`:

(a) Add imports at the top (anchor: existing `import { ... } from "./roles"` / `./auth` block). **M3 — no lint-hack line.** `SetTenantRoleBodySchema` is ALREADY imported in the existing `routes.ts` `./schemas` aggregate (it backs `adminTenantRoleApp`); do NOT add a duplicate import and do NOT add any `_unusedKeepLint` placeholder — that hack is deleted from this plan:
```ts
import {
  mintImpersonationToken,
  reMintImpersonationToken,
  verifyImpersonationToken,
  readImpersonationCookie,
  buildImpersonationSetCookie,
  buildImpersonationClearCookie,
  IMPERSONATION_COOKIE,
  type ImpersonationContext,
} from "./impersonation";
// ImpersonationAuditEnvelope type — add to the existing `./durable/schemas`
// import aggregate in routes.ts (the one that already imports AuditEvent-side
// types via observability); used by the typed envelope helper below.
```

(b) Extend `applyAuthMiddleware` (anchor: `applyAuthMiddleware`@615) to derive the impersonation identity AND slide the idle window (H4) AFTER `resolveIdentity` succeeds. Replace the body's tail (`c.set("identity", identityResult.identity); await next();`) with:

```ts
  const baseIdentity = identityResult.identity;
  const impToken = readImpersonationCookie(c.req.raw);
  if (impToken != null && c.env.PORTAL_SESSION_SECRET && baseIdentity.role === "admin") {
    const now = Date.now();
    const imp = await verifyImpersonationToken(c.env.PORTAL_SESSION_SECRET, impToken, now);
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
      // H4: idle slide. When past ~50% of the idle window, re-mint with a
      // fresh idleDeadline but the UNCHANGED absoluteDeadline (2h hard cap),
      // and Set-Cookie on the response so the next request sees the slid token.
      const idleWindowMidpoint = imp.idleDeadline - 15 * 60 * 1000; // 30m window → slide after 15m
      if (now >= idleWindowMidpoint && now < imp.absoluteDeadline) {
        const slid = await reMintImpersonationToken(
          c.env.PORTAL_SESSION_SECRET,
          {
            realActor: imp.realActor,
            effectiveTeamId: imp.effectiveTeamId,
            issuedAt: imp.issuedAt,
            absoluteDeadline: imp.absoluteDeadline,
          },
          now,
        );
        const remainingSec = Math.max(
          0,
          Math.floor((imp.absoluteDeadline - now) / 1000),
        );
        c.header("set-cookie", buildImpersonationSetCookie(slid, remainingSec));
      }
      await next();
      return;
    }
  }
  c.set("identity", baseIdentity);
  await next();
```

Add `impersonation?: ImpersonationContext` to the `HonoEnv` `Variables` type (anchor: the `Variables: { identity: PortalIdentity }` declaration — extend with `impersonation?: ImpersonationContext`).

(c) **C3 — close the Owner-as-tenant write audit-escape.** `requireTenantAdmin` (`routes.ts:648`) short-circuits `if (id.role === "admin") { await next(); return; }`, so a plain Owner reaches every `/api/tenant/*` write WITHOUT an impersonation cookie and the write would be audited as a plain `tenant_*` action with NO envelope. Add a middleware that runs ON THE TENANT WRITE APPS, AFTER `applyAuthMiddleware` (so `c.get("impersonation")` is populated) and `requireTenantAdmin`: an Owner (`role === "admin"`) performing a tenant-scoped WRITE (`POST`/`PUT`/`DELETE`) MUST carry a valid impersonation context, else 403 `impersonation_required` (matches the locked "act as tenant" model — an Owner only writes as a tenant via impersonation). A genuine tenant_admin (`role !== "admin"`) is unaffected.

```ts
// after requireOwner (Task 1):
async function requireImpersonationForOwnerWrite(
  c: Context<HonoEnv>,
  next: () => Promise<void>,
): Promise<Response | void> {
  const method = c.req.method.toUpperCase();
  const isWrite = method === "POST" || method === "PUT" || method === "DELETE" || method === "PATCH";
  const id = c.get("identity");
  // Owner doing a tenant-scoped WRITE must be impersonating; reads are exempt
  // (Owner read-superset is allowed and audited as read). A real tenant_admin
  // (role !== "admin") is never gated here.
  if (isWrite && id.role === "admin" && c.get("impersonation") == null) {
    return c.json({ error: "impersonation_required" }, 403);
  }
  await next();
}
```

Wire it into the three tenant write apps AFTER `requireTenantAdmin`. In `tenantInvitesApp`, `tenantAlertWebhookApp`, `tenantBillingApp` (anchors: their `.use("/tenant/*", requireTenantAdmin)` lines ~1931/1956/1976) add immediately below each: `.use("/tenant/*", requireImpersonationForOwnerWrite)`. (`billingDownloadCore` is a GET → `isWrite` false → Owner read-superset still works for tenant billing download while impersonating OR directly, but a tenant_admin path is unchanged.)

(d) **H1/H2 — typed envelope, no string-blob.** Add the helper after `requireImpersonationForOwnerWrite`:

```ts
function impersonationEnvelope(c: Context<HonoEnv>): ImpersonationAuditEnvelope | null {
  const imp = c.get("impersonation");
  if (imp == null) return null;
  return { realActor: imp.realActor, effectiveTeam: imp.effectiveTeamId, viaImpersonation: true };
}
```

Then pass it as the first-class `impersonation` field on EVERY tenant-path `auditWrite` (the typed `AuditWritePoint.impersonation` from Step 3's `observability/audit.ts` change) — NOT munged into `after`. EXACT per-core diff (each is a one-line addition to the existing `auditWrite(c.env, { ... })` object literal; `after` is left BYTE-UNCHANGED so the admin path stays identical):

- `createInviteCore` (anchor: its `await auditWrite(c.env, { actor..., action: \`${scope}_invite_create\`, ... after: JSON.stringify(inviteToPublic(record)), reason })`): add `impersonation: impersonationEnvelope(c),` to the object.
- `revokeInviteCore` (anchor: `action: \`${scope}_invite_revoke\`, ... after: result.status, reason`): add `impersonation: impersonationEnvelope(c),`.
- `alertWebhookSetCore` (anchor: `action: \`${scope}_team_alert_webhook_set\`, ... after: JSON.stringify({ url }), reason`): add `impersonation: impersonationEnvelope(c),`.
- `alertWebhookClearCore` (anchor: `action: \`${scope}_team_alert_webhook_clear\`, ... after: "null", reason: parsed.data.reason`): add `impersonation: impersonationEnvelope(c),`.
- `billingDownloadCore` (anchor: `action: \`${scope}_billing_archive_download\`, ... after: "", reason: ""`): add `impersonation: impersonationEnvelope(c),`.

For the direct admin path (`scope === "admin"`, no cookie) `impersonationEnvelope(c)` returns `null` → `auditWrite` writes `impersonation: null` → byte-identical observable behavior except the new explicit-null column (additive, non-breaking). The envelope is now a queryable `AuditEvent.impersonation` field surfaced by `/api/ops/audit/:eventId` (Task 1 `readImpersonationEnvelope`) → `AuditEventDetailSchema.impersonation` → Task-9/12 detail card. No per-callsite `after`-string parsing anywhere.

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

- [ ] **Step 4: Run → PASS** — `cd /Users/xumingyang/github/contrabass/cloud && bun run test src/litellm-portal/impersonation-routes.test.ts src/litellm-portal/impersonation.test.ts src/litellm-portal/ops-routes.test.ts` (incl. the C3 negative+positive cases and the H4 re-mint case) + the existing tenant-route tests `bun run test src/litellm-portal/routes` (CRITICAL regression check: a genuine tenant_admin — `role !== "admin"` — is NOT gated by `requireImpersonationForOwnerWrite`, and the direct admin path's `auditWrite` is byte-unchanged except the additive `impersonation: null` column → those suites stay green) + `bun run typecheck` (baseline-only).

- [ ] **Step 5: Commit**
```bash
cd /Users/xumingyang/github/contrabass
git add cloud/src/litellm-portal/observability/audit.ts cloud/src/litellm-portal/impersonation.ts cloud/src/litellm-portal/routes.ts cloud/src/litellm-portal/impersonation-routes.test.ts
git -c commit.gpgsign=false commit -m "feat(litellm-portal): impersonation thread-through + C3 write-gate + typed audit envelope + H4 idle re-mint"
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

- [ ] **Step 5: Implement `ops-console/routes.tsx` with a pathless layout route (C2 fix — Option B).** A pathless `OpsLayoutRoute` parent owns `<OpsConsoleShell><Outlet/></OpsConsoleShell>` and the Owner gate; all 7 path specs nest UNDER it as children. **IMPORTANT — this pathless layout nests INSIDE `rootRoute`'s `RootLayout` (`routes/__root.tsx:146`), it does NOT replace it.** `RootLayout` is the UNCONDITIONAL root component (`createRootRouteWithContext()({ component: RootLayout })`, `__root.tsx:31`) and renders the generic platform `<h1>智云AI管理平台</h1>` + `HeaderActions` + admin command-palette + `container mx-auto` wrapper around its `<Outlet/>`. Without the Step-5b change below, `/ops` would render: RootLayout generic platform chrome → OpsLayout → OpsConsoleShell steel chrome (a double-wrap that violates locked decision #2 / umbrella §4 — Ops面 must be the SOLE chrome, fixed steel, no platform header). Step-5b makes `RootLayout` skip its generic chrome under `/ops` so `OpsConsoleShell` is the only chrome. Screens are bare bodies (no per-screen `OwnerForbidden` — the layout route is the single client gate; server `requireOwner` is authoritative):

```tsx
import React from "react";
import { createRoute, Outlet, type AnyRoute } from "@tanstack/react-router";
import { Loader } from "@cloudflare/kumo/components/loader";
import { OpsConsoleShell } from "./shell";
import { useMe } from "../hooks/use-me";
import { OpsTenantOverviewScreen } from "./screens/tenant-overview";
import { OpsProvisioningScreen } from "./screens/provisioning";
import { OpsGlobalUsageScreen } from "./screens/global-usage";
import { OpsAuditScreen } from "./screens/audit";
import { OpsPlatformSettingsScreen } from "./screens/platform-settings";
import { OpsTenantDetailScreen } from "./screens/tenant-detail";
import { OpsUserDetailScreen } from "./screens/user-detail";

/**
 * Pathless layout component. Wraps the matched `/ops` child in the Ops shell.
 *
 * M-NEW-1: mirror `PortalIndex`'s undefined-me discipline EXACTLY
 * (`routes/index.tsx:34-40`). `useMe()` is SSR-seeded (server resolves the
 * identity; client rehydrates the same data → #418-safe). Before `me`
 * resolves it is `undefined`; we MUST NOT downgrade that to a 403 flash
 * (which would also risk an SSR/hydrate divergence and contradict locked
 * decision #1 — the client mirrors the server-resolved identity, it never
 * decides it). Distinguish three states:
 *   - me === undefined  → neutral loading (NOT 403); SSR always seeds me, so
 *                          this is only the transient pre-data state and is
 *                          identical on server and client for the same URL.
 *   - me resolved, Owner → OpsConsoleShell with the screen.
 *   - me resolved, non-Owner → OpsConsoleShell renders its own 403 card.
 * `OpsConsoleShell` owns the Owner-vs-403 branch (single gate); this layout
 * only owns the loading-vs-resolved branch. Server `requireOwner` is the
 * authoritative security boundary.
 */
function OpsLayout() {
  const me = useMe().data;
  if (me === undefined) {
    // Neutral loading — never the 403 card. Same tree server & client.
    return (
      <div
        id="ops-console-loading-root"
        className="flex min-h-screen items-center justify-center bg-kumo-canvas"
      >
        <Loader aria-label="正在加载运营控制台" />
      </div>
    );
  }
  const identity = {
    email: me.email,
    userId: me.userId,
    domain: me.domain,
    litellmUserId: me.userId,
    role: me.role,
    tenantRole: me.tenantRole,
    tenantTeamId: me.tenantTeamId,
  } as const;
  return (
    <OpsConsoleShell identity={identity}>
      <Outlet />
    </OpsConsoleShell>
  );
}

type OpsRouteSpec = { path: string; component: React.ComponentType };

const OPS_ROUTE_SPECS: OpsRouteSpec[] = [
  { path: "/ops", component: OpsTenantOverviewScreen },
  { path: "/ops/provisioning", component: OpsProvisioningScreen },
  { path: "/ops/usage", component: OpsGlobalUsageScreen },
  { path: "/ops/audit", component: OpsAuditScreen },
  // $eventId MUST be a child of /ops/audit (shares OpsAuditScreen, which
  // switches on the route param) — documented invariant (L2).
  { path: "/ops/audit/$eventId", component: OpsAuditScreen },
  { path: "/ops/settings", component: OpsPlatformSettingsScreen },
  { path: "/ops/tenants/$teamId", component: OpsTenantDetailScreen },
  { path: "/ops/users/$userId", component: OpsUserDetailScreen },
];

/**
 * Build the Ops Console subtree: a pathless layout route under `parentRoute`
 * (rootRoute) owning `<OpsConsoleShell><Outlet/></OpsConsoleShell>` + the
 * Owner gate, with all 7 path specs as its CHILDREN. Returns the single
 * layout route (caller adds it to `rootRoute.addChildren`); the children are
 * attached here. `/ops*` is disjoint from `/` (indexRoute), `/manage/*`
 * (legacy 301 subtree) and the Phase-1 tenant subtree — no collision.
 */
export function createOpsConsoleRoutes(parentRoute: AnyRoute) {
  const opsLayoutRoute = createRoute({
    getParentRoute: () => parentRoute,
    id: "ops-layout", // pathless: id-only, no `path`
    component: OpsLayout,
  });
  const children = OPS_ROUTE_SPECS.map((spec) =>
    createRoute({
      getParentRoute: () => opsLayoutRoute,
      path: spec.path,
      component: spec.component,
    }),
  );
  opsLayoutRoute.addChildren(children);
  return opsLayoutRoute;
}

export { OPS_ROUTE_SPECS, OpsLayout };
```

- [ ] **Step 5b: Make `RootLayout` Ops-aware so `OpsConsoleShell` is the SOLE chrome at `/ops` (C-NEW-1 — the C2 double-wrap fix).** Because `rootRoute` is `createRootRouteWithContext()({ component: RootLayout })` (`__root.tsx:31`) and every route — including the Ops layout — is a child of `rootRoute` (`router.tsx`), the pathless `OpsLayout` renders INSIDE `RootLayout`'s `<Outlet/>`. `RootLayout` (`__root.tsx:146-191`) unconditionally renders the generic platform `<h1>{platformName}</h1>` ("智云AI管理平台"), `<HeaderActions/>`, the admin command-palette (`isAdmin = me?.role==="admin"` → every Owner), and a `container mx-auto` wrapper. That double-wraps the Ops steel shell under the platform header — violating locked decision #2 / umbrella §4 (Ops面 = independent, fixed steel, internal/privileged chrome, NOT embedded under platform chrome). Fix `RootLayout` to bypass its generic chrome under `/ops`:

  In `cloud/src/litellm-portal/routes/__root.tsx`, change the import (anchor: `import { Link, createRootRouteWithContext, Outlet, useRouter } from "@tanstack/react-router";` @ `__root.tsx:13`) to also import `useRouterState`:

```tsx
import { Link, createRootRouteWithContext, Outlet, useRouter, useRouterState } from "@tanstack/react-router";
```

  Then split `RootLayout` into an outer component that does the URL branch and an inner `PortalRootLayout` holding the EXISTING body verbatim. **Rules-of-hooks: a single mounted `RootLayout` CAN navigate `/` → `/ops` within its lifetime, flipping the branch — so an early `return` with hooks below it would change the hook count between renders (a real React violation). The split avoids this: each component has an unconditional, fixed hook sequence; the conditional is component SELECTION (different element types unmount/remount cleanly), not a variable hook count in one component.** Replace the `function RootLayout()` declaration head + keep its entire existing body under the new name:

```tsx
// NEW outer component — the only thing the root route renders. Pure-derived
// from the URL (no window/effect/state) → SSR and client hydration take the
// SAME branch for the SAME path (#418 SSR==hydrate preserved). useRouterState
// resolves on the SSR memory router (renderPortalSSR builds it with the
// request path — the mechanism Phase-1 SSR-selects with) AND the client
// browser router.
function RootLayout() {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const isOpsSurface = pathname === "/ops" || pathname.startsWith("/ops/");
  // At /ops the Operations Console owns the ENTIRE chrome: no generic platform
  // <h1>/HeaderActions/command-palette/container wrapper. OpsLayout +
  // OpsConsoleShell (rendered via <Outlet/>) is the sole chrome (C-NEW-1).
  if (isOpsSurface) {
    return <Outlet />;
  }
  return <PortalRootLayout />;
}

// EXISTING RootLayout body, renamed verbatim — unchanged hook sequence
// (useRouter, useMe, useEffect, …) and unchanged generic chrome JSX for all
// non-/ops routes. Phase-1 (`/`, `/usage`, `/manage/*`, …) is byte-identical.
function PortalRootLayout() {
  const router = useRouter();
  const { data: me } = useMe();
  // ...the rest of the original RootLayout body, completely unchanged...
}
```

  `RootLayout` itself now has exactly ONE hook (`useRouterState`), always called, in fixed order — rules-of-hooks safe even when the URL class flips, because switching `<Outlet/>` ↔ `<PortalRootLayout/>` is a component-identity change (React unmounts one subtree and mounts the other; neither component ever sees a changing hook count). `PortalRootLayout`'s hook sequence is the original `RootLayout`'s, untouched. The root route binding (`__root.tsx:31` `component: RootLayout`) is unchanged — it still points at the (now outer) `RootLayout`.

- [ ] **Step 6: Run shell test → PASS** — `cd /Users/xumingyang/github/contrabass/cloud && bun run test src/litellm-portal/ops-console/shell.test.tsx` (2 tests). Create empty-but-valid bare-body stub exports for the seven screens NOW so `routes.tsx` resolves (e.g. `export function OpsTenantOverviewScreen() { return <div id="ops-tenant-overview-root" />; }`) — Tasks 6–11 replace each stub body. These are real type-valid components, not placeholder strings.

- [ ] **Step 7: Add a MOUNTED-route test using the PRODUCTION router (C2 + C-NEW-1 regression guard).** The earlier draft of this test built the tree with a BARE `createRootRoute()` (no component) — that was an INADEQUATE harness: it could never catch the `RootLayout` double-wrap because it had no `RootLayout` at all (a false-green). This test MUST use the production router from `cloud/src/litellm-portal/router.tsx` (`createPortalRouter`, which wires the real `rootRoute`/`RootLayout` + `createOpsConsoleRoutes` mount) so it renders exactly what production renders. `cloud/src/litellm-portal/ops-console/routes.test.tsx`:

```tsx
/**
 * @vitest-environment happy-dom
 */
import React from "react";
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { I18nProvider } from "@lingui/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";
import { setupI18n } from "../i18n/setup";
import { ME_QUERY_KEY } from "../hooks/use-me";
import type { Me } from "../schemas";
// PRODUCTION router factory — real rootRoute/RootLayout + the Ops mount.
import { createPortalRouter, createMemoryHistory } from "../router";
import { AppShell } from "../routes/__root";

const i18n = setupI18n("zh-CN");

// Render via the production tree so this test sees the SAME RootLayout +
// OpsLayout + OpsConsoleShell nesting production renders (C-NEW-1: catches the
// double-wrap a bare createRootRoute() harness would false-green).
function renderAt(path: string, me: Me, role: "admin" | "user" | "none") {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  qc.setQueryData(ME_QUERY_KEY, me);
  const router = createPortalRouter(
    createMemoryHistory({ initialEntries: [path] }),
    { role },
  );
  return render(
    <QueryClientProvider client={qc}>
      <I18nProvider i18n={i18n}>
        <AppShell queryClient={qc}>
          <RouterProvider router={router} />
        </AppShell>
      </I18nProvider>
    </QueryClientProvider>,
  );
}
afterEach(() => cleanup());

const owner: Me = { email: "o@x.com", userId: "u1", company: "Acme Co", domain: "x.com", role: "admin", tenantRole: null, tenantTeamId: null };
const member: Me = { email: "m@x.com", userId: "u2", company: "Acme Co", domain: "x.com", role: "user", tenantRole: "member", tenantTeamId: "t1" };

describe("Ops Console mounted routing (C2 + C-NEW-1 guard, production router)", () => {
  it("Owner at /ops: Ops shell is the SOLE chrome — generic platform header ABSENT", async () => {
    renderAt("/ops", owner, "admin");
    // Ops steel shell present, wrapping the screen:
    await screen.findByText(/运营控制台/);
    expect(document.getElementById("ops-console-shell-root")).not.toBeNull();
    expect(await screen.findByText(/租户总览/)).toBeTruthy();
    // C-NEW-1: generic RootLayout chrome must NOT also render at /ops.
    expect(screen.queryByText(/智云AI管理平台|Acme Co/)).toBeNull(); // platform <h1>
    expect(document.getElementById("header-actions-root")).toBeNull(); // HeaderActions
  });

  it("non-Owner at /ops/provisioning: 403 card, no screen, no generic chrome", async () => {
    renderAt("/ops/provisioning", member, "user");
    expect(await screen.findByText(/仅平台 Owner 可访问/)).toBeTruthy();
    expect(document.getElementById("ops-forbidden-root")).not.toBeNull();
    expect(document.getElementById("header-actions-root")).toBeNull();
  });

  it("undefined me at /ops renders the neutral loading state, NOT the 403 card (M-NEW-1)", async () => {
    // No ME_QUERY_KEY seed → useMe().data === undefined.
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const router = createPortalRouter(
      createMemoryHistory({ initialEntries: ["/ops"] }),
      { role: "admin" },
    );
    render(
      <QueryClientProvider client={qc}>
        <I18nProvider i18n={i18n}>
          <AppShell queryClient={qc}>
            <RouterProvider router={router} />
          </AppShell>
        </I18nProvider>
      </QueryClientProvider>,
    );
    expect(await screen.findByText(/正在加载运营控制台/)).toBeTruthy();
    expect(document.getElementById("ops-console-loading-root")).not.toBeNull();
    expect(screen.queryByText(/仅平台 Owner 可访问/)).toBeNull(); // NOT a 403 flash
  });

  it("Phase-1 unaffected: at / the generic platform header IS present, Ops shell ABSENT", async () => {
    renderAt("/", owner, "admin");
    expect(await screen.findByText(/Acme Co|智云AI管理平台/)).toBeTruthy(); // platform <h1>
    expect(document.getElementById("header-actions-root")).not.toBeNull();
    expect(document.getElementById("ops-console-shell-root")).toBeNull();
  });
});
```

This harness IS the production render path (`createPortalRouter` → real `rootRoute`/`RootLayout`/`PortalRootLayout` + `createOpsConsoleRoutes`), so a regression in either the Step-5b bypass or the Step-5 layout fails the test loudly. (`AppShell` is exported from `routes/__root.tsx` for exactly this — `server-impl.tsx` uses it for SSR; here it provides the `LinkProvider`/`Toasty` context the chrome needs. The `mocks` block omitted for brevity follows the existing screen-test harness pattern — `vi.mock("@cloudflare/kumo/components/toast", …)` etc. as in `tenant-portal/screens/overview.test.tsx`.)

- [ ] **Step 8: Wire the layout route into `router.tsx` (additive, #418-safe). H3: `PortalIndex` is NOT touched** — `indexRoute` is `path:"/"` so `PortalIndex` structurally cannot match `/ops*`; the earlier "modify PortalIndex so under /ops it does not render" instruction was dead-code-inviting and self-contradictory and is removed. `/ops*` is owned entirely by `createOpsConsoleRoutes`. In `router.tsx` (anchor: the `const tenantPortalRoutes = createTenantPortalRoutes(rootRoute, { includeIndex: false });` line ~60, and the `...tenantPortalRoutes,` spread in `rootRoute.addChildren([...])` ~line 95):

```ts
import { createOpsConsoleRoutes } from "./ops-console/routes";
// ...
const opsLayoutRoute = createOpsConsoleRoutes(rootRoute);
// ... in rootRoute.addChildren([ ... ]) append after ...tenantPortalRoutes,
  opsLayoutRoute,
```

`createOpsConsoleRoutes` returns the single pathless layout route with its 7 children already attached, so adding it to `rootRoute.addChildren` mounts the whole `/ops` subtree under the shell. SSR (`renderPortalSSR` builds the router with the request path) and client hydration resolve the SAME matched route; the shell branch is driven solely by the hydrated `useMe()` identity → server and client agree (#418-safe). No path collides with `/`, `/manage/*`, or the Phase-1 tenant subtree.

- [ ] **Step 9: Run** — `cd /Users/xumingyang/github/contrabass/cloud && bun run test src/litellm-portal/ops-console/shell.test.tsx src/litellm-portal/ops-console/routes.test.tsx src/litellm-portal/router.test.tsx src/litellm-portal/index.test.ts && bun run typecheck`. Also extend the existing `router.test.tsx` with a production-router C-NEW-1 assertion (same `createPortalRouter` harness as Step 7): at `/ops` the generic platform `<h1>` + `#header-actions-root` are ABSENT and `#ops-console-shell-root` present; at `/` they are PRESENT and `#ops-console-shell-root` absent (Phase-1 chrome unaffected); legacy `/manage/keys` still resolves unchanged. (If `index.test.ts` hits the documented happy-dom flake, isolated re-run to confirm.)

- [ ] **Step 10: Commit** (`routes/index.tsx`/`PortalIndex` is intentionally NOT in the change set — H3: it is untouched; `routes/__root.tsx` IS, for the Step-5b Ops-aware `RootLayout` split)
```bash
cd /Users/xumingyang/github/contrabass
git add cloud/src/litellm-portal/ops-console cloud/src/litellm-portal/router.tsx cloud/src/litellm-portal/routes/__root.tsx
git -c commit.gpgsign=false commit -m "feat(litellm-portal): Ops Console shell + layout gate + RootLayout /ops bypass + mount"
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

> **Shared directive for Tasks 6–11 (C2 — bare-body screens).** Every Ops screen
> below is a BARE body component: NO `import { OwnerForbidden }`, NO
> `import { useMe }` for gating, NO `if (me?.role !== "admin") return
> <OwnerForbidden/>`. The pathless `OpsLayout` route (Task 4) renders each
> screen ONLY inside `OpsConsoleShell`, which is the single client gate
> (non-Owner → 403 card before the screen mounts); server `requireOwner` is the
> authoritative security boundary. Screens that genuinely need `me` for DATA
> (none below do — they use route params + `/api/ops/*` hooks) may still import
> `useMe`, but never for gating. Per-screen `.test.tsx` files render the bare
> body in isolation (fast, behavior-focused); the shell-wrapping invariant is
> covered ONCE by the Task-4 Step-7 `ops-console/routes.test.tsx` mounted-route
> regression guard. The screen-body code blocks below already reflect this — do
> NOT re-add a per-screen gate.

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

- [ ] **Step 3: Implement `tenant-overview.tsx`** (Kumo `Table`, bare body per the Tasks-6–11 shared directive — NO self-gate, gated by `OpsLayout`/`OpsConsoleShell`; rows link to `/ops/tenants/$teamId`):

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
import { useOpsTenants } from "../hooks";

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

// Bare body — the pathless OpsLayout route (Task 4) renders this only inside
// OpsConsoleShell, which is the single client gate (non-Owner → 403 card
// before this ever mounts); server requireOwner is authoritative. No
// per-screen OwnerForbidden (C2).
export function OpsTenantOverviewScreen() {
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
import { useOpsCreateTeam, useOpsCreateInvite, useOpsSetTenantRole } from "../hooks";

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

// Bare body (C2) — gated by OpsLayout/OpsConsoleShell + server requireOwner.
export function OpsProvisioningScreen() {
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

// Bare body (C2) — gated by OpsLayout/OpsConsoleShell + server requireOwner.
export function OpsGlobalUsageScreen() {
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
import { useAdminAudit } from "../../hooks/use-admin-audit";
import { useOpsAuditEvent } from "../hooks";

export function AuditEventDetailCard({ eventId }: { eventId: string }) {
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

// Bare body (C2) — gated by OpsLayout/OpsConsoleShell + server requireOwner.
export function OpsAuditScreen() {
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
import { useOpsPlatformSettings } from "../hooks";

// Bare body (C2) — gated by OpsLayout/OpsConsoleShell + server requireOwner.
export function OpsPlatformSettingsScreen() {
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
import { useOpsTenantDetail, useStartImpersonation } from "../hooks";

/**
 * Reusable body keyed by an explicit `teamId` (no route coupling) so Task 12's
 * legacy `/manage/teams/$teamId` stub can delegate here verbatim. Bare body
 * (C2): the Ops route renders it under OpsLayout/OpsConsoleShell (Ops steel
 * chrome); the legacy `/manage` stub renders it under the EXISTING `/manage`
 * admin chrome (RootLayout generic header + manage layout) — that is the
 * accepted, intended behavior for the legacy path, NOT the Ops shell. The
 * underlying data fetch (`useOpsTenantDetail` → `GET /api/ops/tenants/:id`)
 * is server-gated by `requireOwner` regardless of which chrome wraps it.
 */
export function OpsTenantDetailBody({ teamId }: { teamId: string }) {
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

// Bare body (C2) — route component reads the param and delegates to the body.
export function OpsTenantDetailScreen() {
  const params = useParams({ strict: false }) as { teamId?: string };
  return <OpsTenantDetailBody teamId={params.teamId ?? ""} />;
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
import { useOpsUserDetail } from "../hooks";

/**
 * Reusable body keyed by explicit `userId` so Task 12's legacy
 * `/manage/users/$userId` stub can delegate here verbatim. Bare body (C2):
 * Ops route → OpsConsoleShell steel chrome; legacy `/manage` stub → existing
 * `/manage` admin chrome (accepted, intended for the legacy path — not the
 * Ops shell). Data fetch `useOpsUserDetail` → `GET /api/ops/users/:id` is
 * server-gated by `requireOwner` regardless of chrome.
 */
export function OpsUserDetailBody({ userId }: { userId: string }) {
  const { data, isLoading, isError, error } = useOpsUserDetail(userId);
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

// Bare body (C2) — route component reads the param and delegates to the body.
export function OpsUserDetailScreen() {
  const params = useParams({ strict: false }) as { userId?: string };
  return <OpsUserDetailBody userId={params.userId ?? ""} />;
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
- [ ] **Step 3: Implement.** Rewrite `$eventId.lazy.tsx` to render the shared `AuditEventDetailCard` (already `export`ed from `ops-console/screens/audit.tsx` as of Task 9 — a self-contained component taking `{ eventId }`; no further export change needed):

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

Rewrite `teams/$teamId.lazy.tsx` to delegate to the `OpsTenantDetailBody` already exported from `tenant-detail.tsx` (Task 11 ships it as a first-class export taking `{ teamId }` — no extraction needed here):

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

Same shape for `users/$userId.lazy.tsx`, delegating to the `OpsUserDetailBody` already exported from `user-detail.tsx` (Task 11):

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

Then the impersonation banner in `tenant-portal/shell.tsx`. Extend `TenantPortalShellProps` with an optional `impersonation?: { realActor: string; effectiveTeamId: string } | null` and render an ARIA alert region with an exit control when present.

**M1 — import-cycle claim resolved empirically (not asserted):** `ops-console/hooks.ts` imports only `@tanstack/react-query` + `../schemas` (Task 5 code) — it does NOT import anything from `tenant-portal/*`, so `tenant-portal/shell.tsx` importing `useStopImpersonation` from `ops-console/hooks.ts` introduces NO cycle. The earlier "not importable without a cycle" claim was false; the banner reuses `useStopImpersonation` (single source of truth for the stop call + query invalidation), not a raw `fetch`. (If a future change ever did create a cycle, the fallback is to lift `useStopImpersonation` into a shared `hooks/use-impersonation.ts` — noted, not needed now.)

```tsx
// add to imports in tenant-portal/shell.tsx:
import { useState, useCallback } from "react";
import { Button } from "@cloudflare/kumo/components/button";
import { useStopImpersonation } from "../ops-console/hooks";
// add to TenantPortalShellProps:
//   impersonation?: { realActor: string; effectiveTeamId: string } | null;

function ImpersonationBanner({
  imp,
}: {
  imp: { realActor: string; effectiveTeamId: string };
}) {
  const stop = useStopImpersonation();
  const exit = useCallback(() => {
    stop.mutate(undefined, {
      // Server cleared the cookie; full reload so SSR re-renders as the plain
      // Owner and the Ops Console is reachable again.
      onSettled: () => {
        if (typeof window !== "undefined") window.location.assign("/ops");
      },
    });
  }, [stop]);
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
          <Button variant="secondary" size="xs" loading={stop.isPending} onClick={exit}>
            <Trans>退出代操作</Trans>
          </Button>
        }
      />
    </div>
  );
}
```

Render `{impersonation ? <ImpersonationBanner imp={impersonation} /> : null}` at the very top of the returned shell (above `BrandBar`). Thread the prop from `routes/index.tsx` `PortalIndex` via the hydrated `me` channel:

- **L3 — `MeSchema` + `meApp` + SSR seed + fixtures, all updated together.**
  1. Extend `MeSchema` (`schemas.ts`) with `impersonation: z.object({ realActor: z.string(), effectiveTeamId: z.string() }).nullable().optional()` — additive, optional-safe for old cached clients.
  2. In `meApp` (`routes.ts:666`) populate it from the request-scoped `c.get("impersonation")` (NOT from `PortalIdentity` — the impersonation context lives on the Hono context, not the identity record): `impersonation: imp == null ? null : { realActor: imp.realActor, effectiveTeamId: imp.effectiveTeamId }`.
  3. SSR seed: `renderPortalSSR` currently receives only `identity: PortalIdentity`, which has NO impersonation field. Add an explicit new parameter `impersonation: { realActor: string; effectiveTeamId: string } | null` to `renderPortalSSR` and include it in the `MeSchema.safeParse({ email…, tenantRole, tenantTeamId, … })` seed object in `server-impl.tsx` (anchor: that `MeSchema.safeParse` block, ~lines 63-71). Compute the value in `index.ts` on the SSR path (anchor: `index.ts:98-118`, after `authenticateRequest` + `resolveIdentity`): `readImpersonationCookie(request)` then `verifyImpersonationToken(env.PORTAL_SESSION_SECRET, token, Date.now())`, map to `{ realActor, effectiveTeamId }` or `null`, and pass it down into `renderPortalSSR`. Because the cookie is request-scoped, SSR and client hydrate the SAME `me.impersonation` for the same request → #418 SSR==hydrate preserved (same seed channel #138/Phase-1 use).
  4. `PortalIndex` passes `impersonation={me.impersonation ?? null}` to `TenantPortalShell`.
  5. Fixtures: the new field is OPTIONAL, so existing `qc.setQueryData(ME_QUERY_KEY, {...})` `Me` fixtures (Tasks 6–12) + `tenant-portal.stories.tsx`/`ops-console.stories.tsx` stay valid WITHOUT it. The Task-12 `shell-impersonation.test.tsx` explicitly sets `impersonation: { realActor, effectiveTeamId }` to exercise the banner, plus a companion case `impersonation: null` asserting no banner.

- [ ] **Step 4: Run → PASS** — `bun run test src/litellm-portal/routes/manage/audit/\$eventId.test.tsx src/litellm-portal/routes/manage/teams src/litellm-portal/routes/manage/users src/litellm-portal/tenant-portal/shell-impersonation.test.tsx` + the existing `router.test.tsx`/`index.test.ts` (legacy `/manage/*` still 301/functional; isolated re-run if the documented flake fires) + `bun run typecheck` (baseline-only).
- [ ] **Step 5: Commit** `feat(litellm-portal): make audit/team/user stubs real + impersonation banner`

---

## Task 13: i18n completeness + Storybook + bundle/regenerate SPA

**Files:** Modify `cloud/src/litellm-portal/i18n/messages/{zh-CN,en}.ts`; create `cloud/src/litellm-portal/ops-console/i18n-completeness.test.ts`; create `cloud/src/litellm-portal/ops-console/ops-console.stories.tsx`

- [ ] **Step 1: Extract the shared Phase-1 key fixture, then create the Ops i18n-completeness test.** First create `cloud/src/litellm-portal/i18n/__fixtures__/phase1-keys.ts` exporting `export const PHASE1_TENANT_KEYS = [...] as const;` (move the Phase-1 `TENANT_PORTAL_KEYS` array verbatim out of `tenant-portal/i18n-completeness.test.ts` into this fixture, and refactor that Phase-1 test to `import { PHASE1_TENANT_KEYS }` — a behavior-preserving extraction; re-run the Phase-1 test to confirm still green). Then create `cloud/src/litellm-portal/ops-console/i18n-completeness.test.ts` — a four-`it` mirror of the verified Phase-1 pattern (present-in-en, present-in-zh-CN, identical key set, PLUS the no-silent-Phase-1-shadow guard that uses `TENANT_PORTAL_KEYS_OVERLAP = new Set(PHASE1_TENANT_KEYS)`):

```ts
/**
 * i18n completeness test for the Operations Console namespace.
 * Mirrors tenant-portal/i18n-completeness.test.ts plus a 4th `it` resolving
 * the Phase-1↔Ops key-shadow Open Question. When you add a new Ops key, add
 * it here AND to BOTH catalogs.
 */
import { describe, expect, it } from "vitest";
import enMessages from "../i18n/messages/en";
import zhCNMessages from "../i18n/messages/zh-CN";
import { PHASE1_TENANT_KEYS } from "../i18n/__fixtures__/phase1-keys";

const TENANT_PORTAL_KEYS_OVERLAP = new Set<string>(PHASE1_TENANT_KEYS);

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

  // Open-Question resolution: an Ops zh source string is a SINGLE shared
  // catalog key. If an Ops key collides with a Phase-1 key, the EN
  // translation is shared — which is correct ONLY when the intended English
  // is identical. This test pins the deliberate-overlap allowlist: any Ops
  // key that already existed before Phase 2 (Phase-1/legacy) MUST be one we
  // intentionally reuse with the SAME English. New Ops semantics that happen
  // to share a Chinese surface form but need a DIFFERENT English MUST use a
  // distinct key (e.g. add a context suffix). This catches accidental
  // shadowing rather than silently mistranslating.
  it("no Ops key silently shadows a Phase-1 key with a different intended English", () => {
    // Keys Phase 2 INTENTIONALLY reuses verbatim (same Chinese AND same
    // English as their existing catalog entry). Everything else in
    // UNIQUE_KEYS must be NEW (absent before this task's catalog edit).
    const INTENTIONAL_SHARED = new Set<string>([
      "用量", "账单", "成员", "邮箱", "角色", "操作", "取消", "状态",
      "网络请求失败", "已配置", "未配置", "成员", "管理员",
      // ^ add/trim during implementation to match the ACTUAL pre-existing
      //   catalog; the test fails loudly if an Ops key pre-exists but is not
      //   on this list, forcing a conscious reuse-or-rename decision.
    ]);
    // Snapshot the catalog BEFORE adding Ops keys is impractical in a unit
    // test, so we assert the weaker-but-sufficient invariant: every Ops key
    // that is NOT on the intentional-shared list has an EN value that is not
    // accidentally a Phase-1 sentence (heuristic: Ops-new keys get Ops-domain
    // English; we assert presence + that shared keys are explicitly listed).
    const sharedButNotDeclared = UNIQUE_KEYS.filter(
      (k) => k in enMessages && k in zhCNMessages && !INTENTIONAL_SHARED.has(k) &&
        // a key is "pre-existing" if it is referenced by the Phase-1 tenant
        // namespace allowlist too:
        TENANT_PORTAL_KEYS_OVERLAP.has(k),
    );
    expect(
      sharedButNotDeclared,
      `Ops keys overlapping Phase-1 without an explicit intentional-shared decision: ${JSON.stringify(sharedButNotDeclared)}`,
    ).toHaveLength(0);
  });
});
```

`TENANT_PORTAL_KEYS_OVERLAP` is a `Set` built at the top of this test file from the Phase-1 `tenant-portal/i18n-completeness.test.ts` `TENANT_PORTAL_KEYS` allowlist (import it: `import { /* re-export */ } from "../tenant-portal/i18n-completeness.test"` is not viable — instead, in Task 13 Step 1, copy the Phase-1 `TENANT_PORTAL_KEYS` array into a shared `cloud/src/litellm-portal/i18n/__fixtures__/phase1-keys.ts` exporting `PHASE1_TENANT_KEYS`, refactor BOTH completeness tests to import it, and build `TENANT_PORTAL_KEYS_OVERLAP = new Set(PHASE1_TENANT_KEYS)`). This makes the Phase-1↔Ops overlap explicit and reviewable, resolving the Open Question (no silent shadow).

- [ ] **Step 2: Run → FAIL** (keys missing). `cd /Users/xumingyang/github/contrabass/cloud && bun run test src/litellm-portal/ops-console/i18n-completeness.test.ts`.

- [ ] **Step 3: Add every key to BOTH catalogs.** In `cloud/src/litellm-portal/i18n/messages/zh-CN.ts` add each Chinese key mapping to its zh-CN string (identity-mapped for zh source strings, as the existing catalog does), and in `cloud/src/litellm-portal/i18n/messages/en.ts` add each key mapped to its English translation (e.g. `"运营控制台": "Operations Console"`, `"内部 · 特权": "Internal · Privileged"`, `"租户总览": "Tenant Overview"`, `"进入租户": "Enter tenant"`, `"正在以租户身份操作": "Acting as a tenant"`, `"退出代操作": "Exit impersonation"`, … one entry per `UNIQUE_KEYS` member, English wording chosen to match the umbrella §3 screen names). The pure-English literal keys (`"Operations Console arrives in Phase 2"` etc.) are Phase-1's; Phase-2 adds none — Ops keys are zh source strings (consistent with the `<Trans>中文</Trans>` macro idiom in `shell.tsx`).

- [ ] **Step 4: Run → PASS** (4 tests, incl. the no-silent-shadow guard). Also re-run `bun run test src/litellm-portal/tenant-portal/i18n-completeness.test.ts` to confirm the Phase-1 test still green after the `PHASE1_TENANT_KEYS` fixture extraction AND the same-key-set invariant still holds across both catalogs (adding keys to both keeps it green).

- [ ] **Step 5: Storybook.** Create `cloud/src/litellm-portal/ops-console/ops-console.stories.tsx` mirroring `tenant-portal/tenant-portal.stories.tsx` exactly (CSF3 `Meta`/`StoryObj`, `makeDecorator(seeds)` seeding QueryClient with inline fixtures, `I18nProvider` with `setupI18n("zh-CN")`, NO network/bindings). Cover: `OpsConsoleShell` (Owner / non-Owner variants); each screen (`OpsTenantOverviewScreen`, `OpsProvisioningScreen`, `OpsAuditScreen`, `OpsPlatformSettingsScreen`, `OpsTenantDetailScreen`, `OpsUserDetailScreen` — loading / empty / loaded / error via seeded query keys `OPS_TENANTS_QUERY_KEY` etc.); `OpsGlobalUsageScreen` (seeded `DASHBOARD_QUERY_KEY`). Storybook is type-checked by `bun run typecheck` and is render-only — no test step (mirrors how `tenant-portal.stories.tsx` is treated).

- [ ] **Step 6: Bundle + regenerate SPA.** `cd /Users/xumingyang/github/contrabass/cloud && bun run build:litellm-portal`. The Ops screens are lazy route chunks via the TanStack route factory (Task 4) so the entry bundle stays bounded (DESIGN.md bundle guidance — same lazy-route discipline #135/Phase-1 use). Confirm exit 0 and commit the regenerated `app.generated.ts` (and `kumo-css.generated.ts` if changed) — the `embed.FS` contract.

- [ ] **Step 7: Commit**
```bash
cd /Users/xumingyang/github/contrabass
git add cloud/src/litellm-portal/ops-console/i18n-completeness.test.ts cloud/src/litellm-portal/ops-console/ops-console.stories.tsx cloud/src/litellm-portal/i18n/messages cloud/src/litellm-portal/i18n/__fixtures__/phase1-keys.ts cloud/src/litellm-portal/tenant-portal/i18n-completeness.test.ts cloud/src/litellm-portal/app.generated.ts cloud/src/litellm-portal/kumo-css.generated.ts
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

No §3 gap. Ops面 explicitly ignores tenant branding (Task 4 `OPS_STEEL_ACCENT`, never calls `applyBrandVars`); no Kumo fork, no semantic-token override. **C2 + C-NEW-1 closed:** every `/ops` screen renders inside `OpsConsoleShell` via the pathless `OpsLayout` route AND `RootLayout` is split (Step 5b) so it returns only `<Outlet/>` under `/ops*` — so `OpsConsoleShell` is the SOLE chrome (no generic platform `<h1>`/HeaderActions/command-palette double-wrap); the Task-4 Step-7 regression test now uses the PRODUCTION `createPortalRouter` (real `rootRoute`/`RootLayout`) and asserts the generic chrome is ABSENT at `/ops` and PRESENT at `/`. **C3 closed:** `requireImpersonationForOwnerWrite` makes an Owner tenant-scoped WRITE without a valid impersonation context fail 403 `impersonation_required` (negative+positive tests in Task 3). Reuse mandate honored: F1 `adminCreateTeamApp`/`adminInvitesApp`/`adminTenantRoleApp` via Task-7 hooks; `UsageDashboard` (Task 8); `useAdminAudit` (Task 9); `auditWrite`+`WriteReasonSchema` (Tasks 1/3); Phase-1 shell/routes-factory/i18n-completeness idiom mirrored (Tasks 4–13).

**2. Placeholder scan (honest — prior false defenses removed):** No "TBD"/"add error handling"/"similar to Task N"/uncoded steps. The Task-4 seven-screen stubs are real type-valid bare-body components replaced in Tasks 6–11 (disclosed, not hidden). The Task-9 `AuditEventDetailCard` and Task-11 `OpsTenantDetailBody`/`OpsUserDetailBody` are first-class exports with concrete signatures (Task 12 imports them verbatim — the prior "extract during Task 12" hand-wave is removed). **Prior H1/H2 defect fixed:** the earlier Step-3(c) prose ("change `after` to `JSON.stringify({...X,_impersonation})`") was a non-coded per-callsite blob and is fully replaced by (i) `ImpersonationAuditEnvelopeSchema` defined once in `durable/schemas.ts`, (ii) a first-class typed `impersonation` field on `AuditWritePoint`/`auditWrite`/`AuditEvent`/`cb_index_audit_events` (concrete column-add + `putAuditSql`/`auditFromRow` code), and (iii) an EXACT one-line per-core diff for all five tenant cores (`after` left byte-unchanged). No prose-only step remains. **Prior C1 false claim removed:** the old text defended a phantom `getSpendSnapshot` and a non-existent catch ("fail-soft" with no catch). Now: the stub uses the REAL `getSpend()` (verified `durable/team-config-do.ts:493`), `readTeamFacets` has the actual try/catch + per-call `.catch(() => null)`, and the budget-precedence (snapshot wins) is explicit. **M3 fixed:** the `_unusedKeepLint` import hack is deleted; the instruction is now deterministic ("`SetTenantRoleBodySchema` already imported — do not add"). No undefined symbols: every referenced symbol is defined in an earlier step or grep-confirmed in the repo (`requireAdmin`, `applyAuthMiddleware`, `applyAdminRateLimit`, `auditWrite`, `parseWriteBody`, `WriteReasonSchema`, `portalCompanyName`, `isWriteOpsEnabled`, the F1/P0 schemas, `UsageDashboard.initialScope`, `useAdminAudit`, `IndexDO.listTeams/listTenantRoles/listInvites/getUserById/getUserByEmail/listAudit/putTenantRole/appendAudit`, `TeamConfigDO.getTeam`@363/`getAlertWebhook`/`getSpend`@493, `MeSchema`, `setupI18n`, `ME_QUERY_KEY`, Phase-1 `createTenantPortalRoutes`/`TenantPortalShell`). Anchors corrected (`TeamAlertWebhookSchema`@78, `AuditEventSchema`@95, `SpendSnapshotSchema`@69, `TenantBillingPeriodsSchema`@540, `listTenantRoles`@679 end ~704, `appendAudit`@758, `requireTenantAdmin`@645 short-circuit @648).

**3. Type consistency:** `ImpersonationContext` (`{ viaImpersonation: true; realActor; effectiveTeamId; issuedAt; idleDeadline; absoluteDeadline }`) identical in `impersonation.ts`, `routes.ts` (`HonoEnv.Variables.impersonation?`), `applyAuthMiddleware` + helpers. `reMintImpersonationToken`'s `prior` arg shape (`{realActor,effectiveTeamId,issuedAt,absoluteDeadline}`) is a strict subset of `ImpersonationContext`, so the middleware passes it verbatim (H4). `ImpersonationSession` (`{realActor,effectiveTeamId,startedAt,endedAt:string|null}`) identical in `durable/schemas.ts` zod, `durable/index-do.ts` methods, `routes.ts` start/stop stub types. **`ImpersonationAuditEnvelope` (`{realActor,effectiveTeam,viaImpersonation:true}`) is THE single shared shape** — defined once in `durable/schemas.ts` (`ImpersonationAuditEnvelopeSchema`), consumed by `observability/audit.ts` (`AuditWritePoint.impersonation`/`AuditEvent.impersonation`), `durable/index-do.ts` (`putAuditSql`/`auditFromRow`), `routes.ts` (`impersonationEnvelope(c)` → tenant-core `auditWrite`), `schemas.ts` `AuditEventDetailSchema.impersonation` (same field names), and the Task-9/12 detail card; no field-name drift (`effectiveTeam` everywhere, not `effectiveTenant`/`effectiveTeamId`). The banner prop `{realActor,effectiveTeamId}` is consistent in `tenant-portal/shell.tsx`, the `MeSchema.impersonation` extension, the `meApp`/SSR-seed projection, and `PortalIndex`. Ops DTOs defined once in `schemas.ts`, consumed verbatim by `routes.ts` + `ops-console/hooks.ts`. Hook names defined in Tasks 5/7/10 used verbatim in Tasks 6–12. Endpoints match `routes.ts`. `PortalIdentity` matches `types.ts`. No drift.

**4. Test-harness fidelity (the C2 false-green lesson — explicit audit).** The prior revision's C2 regression test built the route tree with a BARE `createRootRoute()` (no `component`), so it could never observe the `RootLayout` double-wrap and passed while production mis-rendered — a false-green caused by a non-production harness. Corrected: the Task-4 Step-7 test now renders via the PRODUCTION `createPortalRouter` (real `rootRoute`→`RootLayout`/`PortalRootLayout` + the real `createOpsConsoleRoutes` mount) and asserts BOTH directions (generic chrome absent at `/ops`, present at `/`) + the M-NEW-1 undefined-me loading case. Audit of remaining harness choices: (a) the Task-1/Task-3 backend tests call the production `app` (`./routes`) via `app.fetch` with realistic env — production path. (b) The per-screen unit tests (Tasks 6–11) render the bare screen body in isolation (mocked `/api/ops/*` hooks) and INTENTIONALLY do not mount the shell — this is a deliberate, documented separation (the Tasks-6–11 shared directive states the shell-wrapping invariant is covered ONCE by the production-router Step-7 integration test), NOT a false-green: a unit test that asserts table/loading/error behavior of a body is legitimately scoped, BECAUSE the integration guard exists and uses the production harness. (c) `shell.test.tsx` renders `OpsConsoleShell` standalone — legitimate for a pure presentational gate component (no router needed; its mounting is the Step-7 integration test's job). (d) `impersonation.test.ts` tests pure token functions (no harness needed). No test asserts a behavior its harness cannot actually exercise. Rule going forward (stated in the plan): any test guarding a routing/SSR/chrome invariant MUST use `createPortalRouter` (the production wiring), never a synthetic `createRootRoute()`.

---

### Revision disposition

**Round 1 (independent critic) — VERIFIED CLOSED by re-review (left unchanged this round):**

| Item | Sev | Disposition |
|---|---|---|
| C1 phantom DO method | CRITICAL | FIXED — stub uses real `getSpend()`; `readTeamFacets` real try/catch + per-call `.catch`; budget precedence explicit |
| C3 impersonation audit-escape | CRITICAL | FIXED — `requireImpersonationForOwnerWrite` (403 `impersonation_required`) on 3 tenant write apps; negative+positive tests |
| H1+H2 typed audit envelope | HIGH | FIXED — `ImpersonationAuditEnvelopeSchema` once; first-class field through `AuditWritePoint`/`auditWrite`/`AuditEvent`/`cb_index_audit_events`; exact per-core diffs |
| H3 false PortalIndex instruction | HIGH | FIXED — dead instruction deleted; `PortalIndex` untouched |
| H4 idle timeout actually absolute | HIGH | FIXED — `reMintImpersonationToken` slides idle, fixed absolute cap; re-mint in `applyAuthMiddleware` |
| M1 import-cycle claim | MEDIUM | RESOLVED EMPIRICALLY — no cycle; banner reuses `useStopImpersonation` |
| M2 `find` over 500 rows | MEDIUM | FIXED — cursor pagination loop |
| M3 `_unusedKeepLint` hack | MEDIUM | FIXED — deleted; deterministic instruction |
| L1 loose status assertion | LOW | FIXED — `toBe(503)` + body equality |
| L2 `$eventId` child invariant | LOW | DOCUMENTED in `OPS_ROUTE_SPECS` |
| L3 meApp/SSR seed + fixtures | LOW | FIXED (L3 prose also de-garbled this round) |
| Open Q en/zh shadow | — | RESOLVED — shared `PHASE1_TENANT_KEYS` + 4th `it` |
| Anchors (H5) | — | RE-VERIFIED; authoritative list in Prerequisites |

**Round 2 (re-review found C2 fix introduced new defects) — fixed THIS round:**

| Item | Sev | Disposition | Plan lines changed |
|---|---|---|---|
| C-NEW-1: Ops renders nested INSIDE generic `RootLayout` chrome (C2 double-wrap); old C2 test false-greened with bare `createRootRoute()` | CRITICAL | FIXED — new Step 5b splits `RootLayout` into an outer URL-branch component (`isOpsSurface` → returns only `<Outlet/>`) + `PortalRootLayout` (verbatim existing body); rules-of-hooks safe (component-selection, not variable hook count); SSR==hydrate preserved (pure URL-derived via `useRouterState`). Step-7 test REBUILT on the PRODUCTION `createPortalRouter`: asserts generic `<h1>`/`#header-actions-root` ABSENT at `/ops`, PRESENT at `/`. `routes/__root.tsx` added to File Structure + commit | Step 5/5b ~1405–1490, Step 7 ~1491–1650, table row, commit |
| M-NEW-1: `OpsLayout` downgraded undefined-`me` to a 403 flash | MAJOR | FIXED — `OpsLayout` now mirrors `PortalIndex`'s undefined-me discipline: `me===undefined` → neutral `#ops-console-loading-root` loader (NOT 403); only resolved-non-Owner → 403 (in shell). New Step-7 test case asserts undefined-me ≠ 403 | Step 5 ~1428–1470, Step 7 test |
| M-NEW-2: AE 9th-blob read-side unverified, over-claimed "queryable" | MAJOR | FIXED — verified NO positional `AUDIT_AE` blob consumer exists in repo (only `writeDataPoint` writers + `.toContain` test); scoped the 9th blob as APPEND-ONLY/positionally-safe (≤20 limit); softened claim — SQL `cb_index_audit_events.impersonation` (indexed, round-trip-tested) is the authoritative queryable path; AE is best-effort mirror only | Task-3 Step-3 audit.ts block |
| Minor: garbled L3 prose | minor | FIXED — rewrote the "`impersonation: identity` is not where it lives" run-on into a clean 5-step list | L3 block |
| Minor: authenticated-non-admin route 403 test | minor | ADDED — Task-1 `ops-routes.test.ts` now has an authenticated NON-admin → 403 `owner_required` case (replaced the redundant unauth case) | ~98–113 |
| Minor: legacy `/manage` chrome claim | minor | CLARIFIED — `OpsTenantDetailBody`/`OpsUserDetailBody` docstrings state plainly the legacy stub renders under existing `/manage` chrome (intended, not Ops shell); data fetch still `requireOwner`-gated | ~2863–2869, ~2987–2994 |

Round-1 items were NOT regressed (re-checked: C1 `getSpend`, C3 guard, H1/H2 envelope schema+wiring, H3 `PortalIndex` untouched, H4 re-mint, M1–M3, L1–L3, Open-Q, anchors all still present and unchanged by Round-2 edits — Round-2 only touched the C2 mechanism + its test harness + the M-NEW-2 audit-claim wording + minors).

> NOTE: tasks reference post-#139 symbols; exact line numbers must be confirmed against `main` after #139 merges (every anchor in this plan was verified against the pre-#139 tree on 2026-05-17). Implementation is gated on that merge (see Prerequisites). This plan completes Phase-2 *planning*; Phase-2 *execution* begins once #139 is in `main`.
