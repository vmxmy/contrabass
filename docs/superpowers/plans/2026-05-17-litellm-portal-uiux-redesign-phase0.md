# LiteLLM Portal UI/UX Redesign — Phase 0 (Backend Foundation) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the backend foundation for a 3-tier role model (platform Owner / tenant admin / member) — a portal-level `tenantRole` store, identity resolution, a tenant-admin guard, tenant-scoped API variants, and the invite→tenantRole write path — with **zero UI** and each piece independently testable.

**Architecture:** Evolve within the existing Cloudflare Worker + IndexDO/TeamConfigDO + Hono architecture. A new self-migrating IndexDO table (`cb_index_tenant_roles`) mirrors the exact dual-SQL/KV pattern of the existing `cb_index_invites` table. `resolveIdentity` is extended to also resolve `{tenantRole, teamId}` (fail-closed, reusing the 5-min role cache). A `requireTenantAdmin` Hono middleware mirrors `requireAdmin`. Tenant-scoped endpoints under `/api/tenant/*` reuse the existing F1/F2/F3 handlers behind a "own-team-only" scope guard. The existing F1 fail-open invite auto-join (in `handleMagicCallback`) also writes the initial `tenantRole` from `invite.teamRole`.

**Tech Stack:** TypeScript, Cloudflare Workers, Hono, Zod, Durable Objects (SQL + KV dual path), Vitest (happy-dom), `bun run` toolchain.

---

## Prerequisites (read before Task 1)

- **PR #136 (F1/F2/F3) MUST be merged into `main` first.** This plan anchors on symbols introduced by F1: `InviteRecordSchema` / `InviteRecord` (`durable/schemas.ts`), `cb_index_invites` table + `putInvite`/`getInvite`/`markInviteConsumed` (`durable/index-do.ts`), the fail-open auto-join block in `handleMagicCallback` (`auth/login-routes.ts`), `requireAdmin` + `applyAuthMiddleware` + `applyAdminRateLimit` + `parseWriteBody` + `auditWrite` + the `adminInvitesApp`/`adminTeamAlertWebhookApp`/`adminBillingArchiveApp` sub-apps (`routes.ts`). If #136 is not merged, STOP and merge it.
- Work on a fresh branch off updated `main`: `git checkout main && git pull && git checkout -b feat/litellm-portal-phase0-tenantrole`.
- Toolchain: run tests with `cd /Users/xumingyang/github/contrabass/cloud && bun run test <path>` (NEVER `npx vitest` — that environment lacks `happy-dom` and falsely fails DOM workers). Typecheck: `bun run typecheck` — the single pre-existing `src/litellm-portal/server.ts → server-impl.tsx` `--jsx` error is a known baseline; "zero new errors" means no errors other than that one.
- Commit convention: `<type>(litellm-portal): <imperative ≤72 chars>`, lowercase, no trailing period. Use `git -c commit.gpgsign=false`.
- Symbol-anchored references: line numbers shift after #136 merges, so this plan anchors by **symbol + neighboring landmark**. Always `grep`/Read to confirm the exact insertion point before editing.
- All new strings that ever surface to users are out of scope here (Phase 0 is API-only); no `i18n/messages/*` changes.

Repo root: `/Users/xumingyang/github/contrabass`. Portal: `cloud/src/litellm-portal/`. All commands run from `cloud/`.

---

## File Structure (decomposition)

| File | Responsibility | Change |
|---|---|---|
| `cloud/src/litellm-portal/durable/schemas.ts` | Zod DO record schemas | Add `TenantRoleRecordSchema` + `type TenantRoleRecord` |
| `cloud/src/litellm-portal/durable/index-do.ts` | IndexDO storage (SQL+KV dual) | Add `cb_index_tenant_roles` table + `tenantRoleKey()` + `tenantRoleFromRow()` + `putTenantRoleSql()` + public `putTenantRole`/`getTenantRole`/`listTenantRoles` |
| `cloud/src/litellm-portal/durable/index-do.test.ts` | IndexDO unit tests | Add tenantRole CRUD tests (KV + SQL) |
| `cloud/src/litellm-portal/types.ts` | Shared types | Extend `PortalIdentity` with `tenantRole` + `tenantTeamId` |
| `cloud/src/litellm-portal/roles.ts` | Identity resolution | Extend `resolveIdentity` to populate `tenantRole`/`tenantTeamId` (fail-closed) |
| `cloud/src/litellm-portal/role-cache.ts` | 5-min role/user cache | Carry `tenantRole`/`tenantTeamId` through the cache entry |
| `cloud/src/litellm-portal/roles.test.ts` (or nearest existing roles test) | resolveIdentity tests | Add tenantRole resolution + fail-closed cases |
| `cloud/src/litellm-portal/routes.ts` | Hono routing | Add `requireTenantAdmin` middleware, `tenantInvitesApp`/`tenantAlertWebhookApp`/`tenantBillingApp` sub-apps under `/api/tenant/*`, and an admin `PUT /api/admin/teams/:teamId/members/:userId/tenant-role` write API; mount all |
| `cloud/src/litellm-portal/schemas.ts` | API request/response schemas | Add `SetTenantRoleBodySchema` + result schema |
| `cloud/src/litellm-portal/routes-do-path.test.ts` | Route/middleware tests | Add `requireTenantAdmin` + tenant-scoped route + assign-tenant-role tests |
| `cloud/src/litellm-portal/auth/login-routes.ts` | Magic-link callback | In the existing fail-open auto-join block, also `putTenantRole` from `invite.teamRole` |
| `cloud/src/litellm-portal/auth/login-routes.test.ts` | Callback tests | Add: invite consume writes tenantRole; fail-open unchanged |

---

## Task 1: `TenantRoleRecord` schema

**Files:**
- Modify: `cloud/src/litellm-portal/durable/schemas.ts` (insert immediately after the `InviteRecordSchema` / `export type InviteRecord` block added by F1)

- [ ] **Step 1: Write the failing test**

Create `cloud/src/litellm-portal/durable/tenant-role-schema.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { TenantRoleRecordSchema } from "./schemas";

describe("TenantRoleRecordSchema", () => {
  it("accepts a valid tenant_admin record", () => {
    const rec = {
      userId: "user_abc",
      teamId: "team_acme",
      tenantRole: "tenant_admin" as const,
      updatedBy: "owner@x.com",
      updatedAt: new Date().toISOString(),
    };
    expect(TenantRoleRecordSchema.parse(rec)).toEqual(rec);
  });

  it("accepts member and rejects unknown role / extra keys / bad datetime", () => {
    expect(TenantRoleRecordSchema.parse({
      userId: "u", teamId: "t", tenantRole: "member",
      updatedBy: "o@x.com", updatedAt: new Date().toISOString(),
    }).tenantRole).toBe("member");
    expect(() => TenantRoleRecordSchema.parse({
      userId: "u", teamId: "t", tenantRole: "boss",
      updatedBy: "o@x.com", updatedAt: new Date().toISOString(),
    })).toThrow();
    expect(() => TenantRoleRecordSchema.parse({
      userId: "u", teamId: "t", tenantRole: "member",
      updatedBy: "o@x.com", updatedAt: "not-a-date",
    })).toThrow();
    expect(() => TenantRoleRecordSchema.parse({
      userId: "u", teamId: "t", tenantRole: "member",
      updatedBy: "o@x.com", updatedAt: new Date().toISOString(), extra: 1,
    })).toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/xumingyang/github/contrabass/cloud && bun run test src/litellm-portal/durable/tenant-role-schema.test.ts`
Expected: FAIL — `TenantRoleRecordSchema` is not exported.

- [ ] **Step 3: Add the schema**

In `cloud/src/litellm-portal/durable/schemas.ts`, immediately after `export type InviteRecord = z.infer<typeof InviteRecordSchema>;` insert:

```ts
export const TenantRoleRecordSchema = z.object({
  userId: z.string(),
  teamId: z.string(),
  tenantRole: z.enum(["tenant_admin", "member"]),
  updatedBy: z.string(),
  updatedAt: z.string().datetime(),
}).strict();

export type TenantRoleRecord = z.infer<typeof TenantRoleRecordSchema>;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /Users/xumingyang/github/contrabass/cloud && bun run test src/litellm-portal/durable/tenant-role-schema.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
cd /Users/xumingyang/github/contrabass
git add cloud/src/litellm-portal/durable/schemas.ts cloud/src/litellm-portal/durable/tenant-role-schema.test.ts
git -c commit.gpgsign=false commit -m "feat(litellm-portal): add TenantRoleRecord schema"
```

---

## Task 2: IndexDO `cb_index_tenant_roles` table + CRUD (dual SQL/KV)

Mirror the exact pattern F1 used for `cb_index_invites` (table in `initializeSql`, a `*Key()` helper, a `*FromRow()` mapper, a private `put*Sql()`, and public dual-path methods).

**Files:**
- Modify: `cloud/src/litellm-portal/durable/index-do.ts`
- Modify (test): `cloud/src/litellm-portal/durable/index-do.test.ts`

- [ ] **Step 1: Write the failing tests**

Append inside the existing top-level `describe("IndexDO", () => { ... })` block in `cloud/src/litellm-portal/durable/index-do.test.ts`, before its closing `});`. Reuse the file's existing `makeIndexDO` (KV) and `makeSqlIndexDO` (SQL) factories:

```ts
  function tr(over: Partial<{ userId: string; teamId: string; tenantRole: "tenant_admin" | "member" }> = {}) {
    return {
      userId: "u1", teamId: "t1", tenantRole: "member" as const,
      updatedBy: "owner@x.com", updatedAt: new Date().toISOString(), ...over,
    };
  }

  for (const [label, make] of [["KV", makeIndexDO], ["SQL", makeSqlIndexDO]] as const) {
    it(`putTenantRole + getTenantRole roundtrip (${label})`, async () => {
      const { obj } = make();
      expect(await obj.getTenantRole("u1", "t1")).toBeNull();
      const rec = tr({ tenantRole: "tenant_admin" });
      await obj.putTenantRole(rec);
      expect(await obj.getTenantRole("u1", "t1")).toEqual(rec);
    });

    it(`putTenantRole upserts on (userId,teamId) (${label})`, async () => {
      const { obj } = make();
      await obj.putTenantRole(tr({ tenantRole: "member" }));
      await obj.putTenantRole(tr({ tenantRole: "tenant_admin" }));
      expect((await obj.getTenantRole("u1", "t1"))?.tenantRole).toBe("tenant_admin");
      expect((await obj.listTenantRoles({ teamId: "t1" })).length).toBe(1);
    });

    it(`listTenantRoles filters by teamId (${label})`, async () => {
      const { obj } = make();
      await obj.putTenantRole(tr({ userId: "u1", teamId: "t1" }));
      await obj.putTenantRole(tr({ userId: "u2", teamId: "t1" }));
      await obj.putTenantRole(tr({ userId: "u3", teamId: "t2" }));
      expect((await obj.listTenantRoles({ teamId: "t1" })).map((r) => r.userId).sort())
        .toEqual(["u1", "u2"]);
      expect((await obj.listTenantRoles()).length).toBe(3);
    });

    it(`getTenantRole returns null for unknown pair (${label})`, async () => {
      const { obj } = make();
      await obj.putTenantRole(tr());
      expect(await obj.getTenantRole("u1", "tX")).toBeNull();
      expect(await obj.getTenantRole("uX", "t1")).toBeNull();
    });
  }

  it("SQL path stores tenant roles without creating legacy KV keys", async () => {
    const { obj, data } = makeSqlIndexDO();
    await obj.putTenantRole(tr());
    expect(data.size).toBe(0);
    expect((await obj.getTenantRole("u1", "t1"))?.tenantRole).toBe("member");
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/xumingyang/github/contrabass/cloud && bun run test src/litellm-portal/durable/index-do.test.ts`
Expected: FAIL — `obj.putTenantRole` / `getTenantRole` / `listTenantRoles` are not functions.

- [ ] **Step 3: Add the table to `initializeSql`**

In `cloud/src/litellm-portal/durable/index-do.ts`, find the `sql.exec(\`...\`)` block inside `initializeSql` and the `cb_index_invites` table F1 added. Immediately after the `cb_index_invites` `CREATE TABLE ... ;` and its `CREATE INDEX ...;`, add inside the same template string:

```sql
      CREATE TABLE IF NOT EXISTS cb_index_tenant_roles (
        user_id TEXT NOT NULL,
        team_id TEXT NOT NULL,
        tenant_role TEXT NOT NULL CHECK (tenant_role IN ('tenant_admin', 'member')),
        updated_by TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (user_id, team_id)
      );
      CREATE INDEX IF NOT EXISTS cb_index_tenant_roles_team_idx
        ON cb_index_tenant_roles (team_id, user_id);
```

- [ ] **Step 4: Add key helper + row mapper + private SQL upsert**

Near the existing `inviteKey(...)` helper (added by F1, by the other `*Key` helpers), add:

```ts
function tenantRoleKey(userId: string, teamId: string): string {
  return `trole:${userId}:${teamId}`;
}
```

Near the existing `inviteFromRow(...)` mapper, add:

```ts
function tenantRoleFromRow(row: SqlRow): TenantRoleRecord {
  return TenantRoleRecordSchema.parse({
    userId: String(row.user_id),
    teamId: String(row.team_id),
    tenantRole: row.tenant_role,
    updatedBy: String(row.updated_by),
    updatedAt: String(row.updated_at),
  });
}
```

Add `TenantRoleRecordSchema, type TenantRoleRecord` to the existing `from "./schemas"` import in this file. Near the existing private `putInviteSql`, add:

```ts
  private putTenantRoleSql(sql: SqlStorage, record: TenantRoleRecord): void {
    const parsed = TenantRoleRecordSchema.parse(record);
    sql.exec(
      `INSERT INTO cb_index_tenant_roles (
         user_id, team_id, tenant_role, updated_by, updated_at
       ) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(user_id, team_id) DO UPDATE SET
         tenant_role = excluded.tenant_role,
         updated_by = excluded.updated_by,
         updated_at = excluded.updated_at`,
      parsed.userId, parsed.teamId, parsed.tenantRole, parsed.updatedBy, parsed.updatedAt,
    );
  }
```

- [ ] **Step 5: Add public dual-path methods**

Near the public `putInvite`/`getInvite`/`listInvites` methods (in the "Invites" section F1 added), add a sibling section:

```ts
  // -------------------------------------------------------------------------
  // Tenant roles (portal-level, decoupled from LiteLLM user_role)
  // -------------------------------------------------------------------------

  async putTenantRole(record: TenantRoleRecord): Promise<void> {
    const parsed = TenantRoleRecordSchema.parse(record);
    const sql = await this.sql();
    if (sql !== null) {
      this.putTenantRoleSql(sql, parsed);
      return;
    }
    await this.ctx.storage.put(tenantRoleKey(parsed.userId, parsed.teamId), parsed);
  }

  async getTenantRole(userId: string, teamId: string): Promise<TenantRoleRecord | null> {
    if (!userId || !teamId) {
      throw new Error("getTenantRole: userId and teamId must be non-empty");
    }
    const sql = await this.sql();
    if (sql !== null) {
      const row = firstRow(sql.exec<SqlRow>(
        "SELECT * FROM cb_index_tenant_roles WHERE user_id = ? AND team_id = ?",
        userId, teamId,
      ));
      return row == null ? null : tenantRoleFromRow(row);
    }
    const raw = await this.ctx.storage.get<unknown>(tenantRoleKey(userId, teamId));
    return raw == null ? null : TenantRoleRecordSchema.parse(raw);
  }

  async listTenantRoles(opts?: { teamId?: string }): Promise<TenantRoleRecord[]> {
    const teamId = opts?.teamId;
    const sql = await this.sql();
    if (sql !== null) {
      const rows = teamId == null
        ? sql.exec<SqlRow>("SELECT * FROM cb_index_tenant_roles ORDER BY team_id, user_id").toArray()
        : sql.exec<SqlRow>(
          "SELECT * FROM cb_index_tenant_roles WHERE team_id = ? ORDER BY user_id",
          teamId,
        ).toArray();
      return rows.map(tenantRoleFromRow);
    }
    const entries = await this.ctx.storage.list<unknown>({ prefix: "trole:" });
    const out: TenantRoleRecord[] = [];
    for (const raw of entries.values()) {
      const rec = TenantRoleRecordSchema.parse(raw);
      if (teamId == null || rec.teamId === teamId) out.push(rec);
    }
    return out.sort((a, b) =>
      a.teamId === b.teamId ? a.userId.localeCompare(b.userId) : a.teamId.localeCompare(b.teamId));
  }
```

- [ ] **Step 6: Run tests to verify they pass + typecheck**

Run: `cd /Users/xumingyang/github/contrabass/cloud && bun run test src/litellm-portal/durable/index-do.test.ts && bun run typecheck`
Expected: index-do tests PASS (existing + new); typecheck shows only the known `server-impl` baseline error.

- [ ] **Step 7: Commit**

```bash
cd /Users/xumingyang/github/contrabass
git add cloud/src/litellm-portal/durable/index-do.ts cloud/src/litellm-portal/durable/index-do.test.ts
git -c commit.gpgsign=false commit -m "feat(litellm-portal): IndexDO cb_index_tenant_roles store + CRUD"
```

---

## Task 3: Extend `PortalIdentity` + `resolveIdentity` with `tenantRole`/`tenantTeamId`

The portal already resolves `PortalIdentity` (email, role, litellmUserId, domain) in `roles.ts` and caches it 5 min in `role-cache.ts` (fail-closed: on error → role "none", not cached). We add `tenantRole` (`"tenant_admin" | "member" | null`) and `tenantTeamId` (`string | null`) resolved from IndexDO `getTenantRole(litellmUserId, teamId)`, where the user's `teamId` comes from the existing IndexDO user record.

**Files:**
- Modify: `cloud/src/litellm-portal/types.ts` (the `PortalIdentity` type)
- Modify: `cloud/src/litellm-portal/role-cache.ts` (cache entry + resolver)
- Modify: `cloud/src/litellm-portal/roles.ts` (`resolveIdentity`)
- Test: `cloud/src/litellm-portal/role-cache.test.ts` (extend existing)

- [ ] **Step 1: Confirm current shapes**

Run: `cd /Users/xumingyang/github/contrabass/cloud && grep -nE "PortalIdentity|interface PortalIdentity|type PortalIdentity" src/litellm-portal/types.ts && grep -nE "resolveIdentity|resolveRoleAndUserId|getRole|ROLE_CACHE_MS|roleCache" src/litellm-portal/role-cache.ts src/litellm-portal/roles.ts`
Expected: prints the `PortalIdentity` definition and the resolver/cache symbols. Read those exact regions before editing.

- [ ] **Step 2: Write the failing test**

In `cloud/src/litellm-portal/role-cache.test.ts` add (adapt mock IndexDO stub to the file's existing harness — it already stubs `getUserByEmail`; add `getTenantRole`):

```ts
it("resolveIdentity populates tenantRole + tenantTeamId from IndexDO", async () => {
  // #given a user on team t1 with portal tenant_admin role
  const env = makeEnvWithIndexDO({
    userByEmail: { userId: "u1", email: "a@x.com", role: "user", teamId: "t1" },
    tenantRole: { userId: "u1", teamId: "t1", tenantRole: "tenant_admin",
      updatedBy: "o@x.com", updatedAt: new Date().toISOString() },
  });
  // #when
  const id = await resolveIdentity(env, { email: "a@x.com", userId: "a@x.com", domain: "x.com" });
  // #then
  expect(id.ok).toBe(true);
  if (id.ok) {
    expect(id.identity.tenantRole).toBe("tenant_admin");
    expect(id.identity.tenantTeamId).toBe("t1");
  }
});

it("resolveIdentity defaults tenantRole=null when no mapping (fail-open for the tenant facet)", async () => {
  const env = makeEnvWithIndexDO({
    userByEmail: { userId: "u1", email: "b@x.com", role: "user", teamId: "t1" },
    tenantRole: null,
  });
  const id = await resolveIdentity(env, { email: "b@x.com", userId: "b@x.com", domain: "x.com" });
  expect(id.ok).toBe(true);
  if (id.ok) {
    expect(id.identity.tenantRole).toBeNull();
    expect(id.identity.tenantTeamId).toBe("t1");
  }
});
```

If `makeEnvWithIndexDO` does not exist in the test file, add a small helper near the top that builds an env whose `INDEX_DO.get().getUserByEmail`/`resolveLiteLLMUser`/`getTenantRole` return the provided fixtures, matching the file's existing stub style.

- [ ] **Step 3: Run test to verify it fails**

Run: `cd /Users/xumingyang/github/contrabass/cloud && bun run test src/litellm-portal/role-cache.test.ts`
Expected: FAIL — `identity.tenantRole` is `undefined` (property does not exist yet).

- [ ] **Step 4: Extend the `PortalIdentity` type**

In `cloud/src/litellm-portal/types.ts`, add to the `PortalIdentity` type (next to `role`):

```ts
  /** Portal-level tenant role within the user's team (decoupled from LiteLLM user_role). */
  tenantRole: "tenant_admin" | "member" | null;
  /** The team this identity is scoped to for tenant-role purposes (null if none). */
  tenantTeamId: string | null;
```

- [ ] **Step 5: Resolve + cache the new fields**

In `cloud/src/litellm-portal/role-cache.ts`: extend the cache entry type and the resolver. After the existing code resolves the user's `teamId` (from the IndexDO user record) and `litellmUserId`, add a fail-closed-consistent lookup:

```ts
// Tenant-role facet: resolved from IndexDO. On any error, fall back to
// { tenantRole: null } — the user still logs in / keeps platform role,
// they simply have no tenant-admin powers until the mapping resolves.
let tenantRole: "tenant_admin" | "member" | null = null;
let tenantTeamId: string | null = teamId ?? null;
try {
  if (env.INDEX_DO && litellmUserId && teamId) {
    const idx = env.INDEX_DO.get(env.INDEX_DO.idFromName("index")) as unknown as {
      getTenantRole(userId: string, teamId: string): Promise<{ tenantRole: "tenant_admin" | "member" } | null>;
    };
    const rec = await idx.getTenantRole(litellmUserId, teamId);
    tenantRole = rec?.tenantRole ?? null;
  }
} catch {
  tenantRole = null; // fail-open for the tenant facet; platform role unaffected
}
```

Carry `tenantRole` and `tenantTeamId` into the cached entry and into the returned `PortalIdentity` everywhere the resolver constructs it. In `roles.ts` `resolveIdentity`, ensure the returned `identity` object includes `tenantRole` and `tenantTeamId` (from the cache/resolver). Keep the existing fail-closed behavior for the **platform** role unchanged (errors there still → `role: "none"`, not cached).

- [ ] **Step 6: Run tests + typecheck**

Run: `cd /Users/xumingyang/github/contrabass/cloud && bun run test src/litellm-portal/role-cache.test.ts src/litellm-portal/index.test.ts && bun run typecheck`
Expected: PASS (new + existing identity/route tests still green — `PortalIdentity` is widened, not narrowed); typecheck only the baseline error. If any consumer constructs `PortalIdentity` literally and now fails typecheck, add `tenantRole: null, tenantTeamId: null` there.

- [ ] **Step 7: Commit**

```bash
cd /Users/xumingyang/github/contrabass
git add cloud/src/litellm-portal/types.ts cloud/src/litellm-portal/role-cache.ts cloud/src/litellm-portal/roles.ts cloud/src/litellm-portal/role-cache.test.ts
git -c commit.gpgsign=false commit -m "feat(litellm-portal): resolve tenantRole/tenantTeamId on identity"
```

---

## Task 4: `requireTenantAdmin` middleware

Mirror `requireAdmin` (in `routes.ts`). A request passes when `identity.tenantRole === "tenant_admin"` AND the route's target team equals `identity.tenantTeamId`. Platform admins (`identity.role === "admin"`) are a superset and also pass (so Owner/impersonation works). Otherwise 403 `tenant_admin_required`.

**Files:**
- Modify: `cloud/src/litellm-portal/routes.ts` (next to `requireAdmin`)
- Test: `cloud/src/litellm-portal/routes-do-path.test.ts`

- [ ] **Step 1: Write the failing test**

In `cloud/src/litellm-portal/routes-do-path.test.ts`, add a `describe("requireTenantAdmin", ...)`. Use the existing `app.fetch` + `adminRequest`/session helpers. Add a tiny probe route is not needed — instead assert via a Task-5 tenant route once it exists; for this task, unit-test the middleware by mounting a throwaway is heavy. Simpler: test it through the first tenant route in Task 5. **So in Task 4, only write the middleware; its tests live in Task 5.** Mark this step done by writing the middleware (no separate test file) and rely on Task 5's route tests (403/200 matrix) as the verification. Document this explicitly here so the engineer doesn't look for a missing test.

- [ ] **Step 2: Add the middleware**

In `cloud/src/litellm-portal/routes.ts`, immediately after the `requireAdmin` function definition, add:

```ts
function tenantTeamIdFromReq(c: Context<HonoEnv>): string | null {
  const p = c.req.param("teamId");
  return p ? decodeURIComponent(p).trim() : null;
}

async function requireTenantAdmin(c: Context<HonoEnv>, next: () => Promise<void>): Promise<Response | void> {
  const id = c.get("identity");
  // Platform admin is a superset (Owner / impersonation).
  if (id.role === "admin") { await next(); return; }
  const targetTeam = tenantTeamIdFromReq(c) ?? id.tenantTeamId;
  if (
    id.tenantRole === "tenant_admin" &&
    id.tenantTeamId != null &&
    targetTeam != null &&
    targetTeam === id.tenantTeamId
  ) {
    await next();
    return;
  }
  return c.json({ error: "tenant_admin_required" }, 403);
}
```

(`Context`/`HonoEnv` are already imported/defined in `routes.ts`.)

- [ ] **Step 3: Typecheck**

Run: `cd /Users/xumingyang/github/contrabass/cloud && bun run typecheck`
Expected: only the baseline `server-impl` error.

- [ ] **Step 4: Commit**

```bash
cd /Users/xumingyang/github/contrabass
git add cloud/src/litellm-portal/routes.ts
git -c commit.gpgsign=false commit -m "feat(litellm-portal): add requireTenantAdmin middleware"
```

---

## Task 5: Tenant-scoped endpoints under `/api/tenant/*`

Expose tenant-admin self-serve variants of F1 invites, F2 alert-webhook, F3 billing. They reuse the **exact** logic the F1/F2/F3 admin handlers run, but: (a) the team is forced to `identity.tenantTeamId` (request cannot target another team), (b) gated by `requireTenantAdmin`, (c) audited with an extra `scope: "tenant"` discriminator in the audit action name.

To stay DRY, extract the core of each F1/F2/F3 admin handler into a shared function `(env, { teamId, actorEmail, ... }) => Result` if not already; otherwise call the existing exported handler logic with `teamId` pinned. Re-read the F1/F2/F3 sub-apps (`adminInvitesApp`, `adminTeamAlertWebhookApp`, `adminBillingArchiveApp`) before extracting; prefer the smallest refactor (a shared helper per capability) over duplicating handler bodies.

**Files:**
- Modify: `cloud/src/litellm-portal/routes.ts`
- Modify: `cloud/src/litellm-portal/schemas.ts` (only if a tenant-variant body schema differs; reuse F1/F2/F3 schemas where identical)
- Test: `cloud/src/litellm-portal/routes-do-path.test.ts`

- [ ] **Step 1: Write the failing tests**

In `routes-do-path.test.ts`, extend the env/identity stubs so a session can resolve to `{ role: "user", tenantRole: "tenant_admin", tenantTeamId: "t1" }` (add `getTenantRole` to the IndexDO stub returning a fixture; ensure `resolveIdentity` path yields the tenant facet — the file already drives identity via the IndexDO stub). Add:

```ts
describe("Tenant-scoped routes (/api/tenant/*)", () => {
  it("GET /api/tenant/invites → 200 for tenant_admin of own team", async () => {
    const env = makeTenantAdminEnv({ teamId: "t1" });
    const res = await app.fetch(await tenantRequest("https://x/api/tenant/invites", env), env);
    expect(res.status).toBe(200);
  });
  it("POST /api/tenant/invites pins teamId to own team (ignores body teamId)", async () => {
    const env = makeTenantAdminEnv({ teamId: "t1" });
    const res = await app.fetch(await tenantRequest("https://x/api/tenant/invites", env, {
      method: "POST",
      body: JSON.stringify({ reason: "user_request", email: "x@x.com", teamId: "t2", teamRole: "user" }),
    }), env);
    expect(res.status).toBe(200);
    // assert the invite was created against t1, never t2 (inspect the IndexDO stub putInvite arg)
  });
  it("GET /api/tenant/invites → 403 for a plain member", async () => {
    const env = makeMemberEnv({ teamId: "t1" });
    const res = await app.fetch(await tenantRequest("https://x/api/tenant/invites", env), env);
    expect(res.status).toBe(403);
  });
  it("PUT /api/tenant/alert-webhook → 200 tenant_admin; 403 member; SSRF body → 422", async () => {
    const env = makeTenantAdminEnv({ teamId: "t1" });
    expect((await app.fetch(await tenantRequest("https://x/api/tenant/alert-webhook", env, {
      method: "PUT", body: JSON.stringify({ reason: "other", url: "https://hooks.example.com/x" }),
    }), env)).status).toBe(200);
    expect((await app.fetch(await tenantRequest("https://x/api/tenant/alert-webhook", env, {
      method: "PUT", body: JSON.stringify({ reason: "other", url: "http://169.254.169.254/x" }),
    }), env)).status).toBe(422);
  });
  it("GET /api/tenant/billing/:yearMonth scoped to own team; 403 member", async () => {
    const env = makeTenantAdminEnv({ teamId: "t1" });
    const res = await app.fetch(await tenantRequest("https://x/api/tenant/billing/2026-04", env), env);
    expect([200, 404]).toContain(res.status); // 404 if no archive object, still authorized
  });
});
```

Add `makeTenantAdminEnv`, `makeMemberEnv`, `tenantRequest` helpers near the file's existing `makeFlagOnEnv`/`adminRequest` (a member env resolves `tenantRole: "member"`; tenantRequest issues a session for that user).

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/xumingyang/github/contrabass/cloud && bun run test src/litellm-portal/routes-do-path.test.ts`
Expected: FAIL — `/api/tenant/*` returns 404 (not mounted).

- [ ] **Step 3: Add the tenant sub-apps**

In `routes.ts`, after the F1/F2/F3 admin sub-apps and before the top-level mount chain, add three sub-apps mirroring the admin ones but with `requireTenantAdmin` and `teamId` pinned to `c.get("identity").tenantTeamId`:

```ts
const tenantInvitesApp = new Hono<HonoEnv>()
  .use("/*", applyAuthMiddleware)
  .use("/tenant/*", applyAdminRateLimit)
  .use("/tenant/*", requireTenantAdmin)
  .get("/tenant/invites", async (c) => {
    const teamId = c.get("identity").tenantTeamId;
    if (!teamId) return c.json({ error: "no_tenant_scope" }, 403);
    if (!c.env.INDEX_DO) return c.json({ error: "index_do_unavailable" }, 503);
    const idx = c.env.INDEX_DO.get(c.env.INDEX_DO.idFromName("index")) as unknown as IndexDOInviteStub;
    const all = await idx.listInvites();
    return c.json(AdminInviteListSchema.parse({
      invites: all.filter((i) => i.teamId === teamId).map(inviteToPublic),
    }));
  })
  .post("/tenant/invites", async (c) => {
    if (!isWriteOpsEnabled(c.env)) return writeOpsDisabledResponse(c);
    const teamId = c.get("identity").tenantTeamId;
    if (!teamId) return c.json({ error: "no_tenant_scope" }, 403);
    const parsed = await parseWriteBody(c, AdminCreateInviteBodySchema);
    if (!parsed.ok) return parsed.response;
    // teamId is pinned to the caller's tenant — body.teamId is ignored.
    return createInviteCore(c, { ...parsed.data, teamId }, "tenant");
  })
  .delete("/tenant/invites/:email", async (c) => {
    if (!isWriteOpsEnabled(c.env)) return writeOpsDisabledResponse(c);
    const teamId = c.get("identity").tenantTeamId;
    if (!teamId) return c.json({ error: "no_tenant_scope" }, 403);
    return revokeInviteCore(c, teamId, "tenant");
  });

const tenantAlertWebhookApp = new Hono<HonoEnv>()
  .use("/*", applyAuthMiddleware)
  .use("/tenant/*", applyAdminRateLimit)
  .use("/tenant/*", requireTenantAdmin)
  .get("/tenant/alert-webhook", async (c) => alertWebhookGetCore(c, c.get("identity").tenantTeamId))
  .put("/tenant/alert-webhook", async (c) => {
    if (!isWriteOpsEnabled(c.env)) return writeOpsDisabledResponse(c);
    return alertWebhookSetCore(c, c.get("identity").tenantTeamId, "tenant");
  })
  .delete("/tenant/alert-webhook", async (c) => {
    if (!isWriteOpsEnabled(c.env)) return writeOpsDisabledResponse(c);
    return alertWebhookClearCore(c, c.get("identity").tenantTeamId, "tenant");
  });

const tenantBillingApp = new Hono<HonoEnv>()
  .use("/*", applyAuthMiddleware)
  .use("/tenant/*", applyAdminRateLimit)
  .use("/tenant/*", requireTenantAdmin)
  .get("/tenant/billing", async (c) => billingListCore(c, c.get("identity").tenantTeamId))
  .get("/tenant/billing/:yearMonth", async (c) => billingDownloadCore(c, c.get("identity").tenantTeamId, "tenant"));
```

Refactor the F1/F2/F3 admin handlers to delegate to the shared `*Core(c, teamId, scope)` functions (extract the existing body verbatim; the admin sub-apps pass the path/`:teamId` value and `scope: "admin"`, tenant sub-apps pass `identity.tenantTeamId` and `scope: "tenant"`). `auditWrite` `action` becomes e.g. `admin_invite_create` vs `tenant_invite_create` by interpolating `scope`. Keep all existing admin tests green (behavior identical for the admin path).

Mount in the top-level chain (after the admin sub-apps, before `.all("/*", ...404)`):

```ts
  .route("/api", tenantInvitesApp)
  .route("/api", tenantAlertWebhookApp)
  .route("/api", tenantBillingApp)
```

- [ ] **Step 4: Run tests + typecheck**

Run: `cd /Users/xumingyang/github/contrabass/cloud && bun run test src/litellm-portal/routes-do-path.test.ts src/litellm-portal/index.test.ts && bun run typecheck`
Expected: new tenant tests PASS; all pre-existing F1/F2/F3 admin route tests still PASS (refactor is behavior-preserving); typecheck only baseline.

- [ ] **Step 5: Commit**

```bash
cd /Users/xumingyang/github/contrabass
git add cloud/src/litellm-portal/routes.ts cloud/src/litellm-portal/schemas.ts cloud/src/litellm-portal/routes-do-path.test.ts
git -c commit.gpgsign=false commit -m "feat(litellm-portal): tenant-scoped /api/tenant invites/webhook/billing"
```

---

## Task 6: Invite consume writes initial `tenantRole`

F1 added a fail-open auto-join block in `handleMagicCallback` (`auth/login-routes.ts`) that, on a pending invite, sets the user's `teamId` and calls `markInviteConsumed`. Extend that same block to also `putTenantRole` derived from `invite.teamRole` (`"admin" → "tenant_admin"`, `"user" → "member"`). Must remain fail-open (a tenantRole write failure must not block login).

**Files:**
- Modify: `cloud/src/litellm-portal/auth/login-routes.ts` (inside the existing invite auto-join `try`)
- Modify: `cloud/src/litellm-portal/auth/login-routes.test.ts`

- [ ] **Step 1: Write the failing test**

In `auth/login-routes.test.ts`, extend the mock IndexDO stub with `putTenantRole`/`getTenantRole` (in-memory map) and add:

```ts
it("invite consume also writes tenantRole from invite.teamRole", async () => {
  const mock = makeMock({
    seedUser: { userId: "u1", email: EMAIL, role: "user", teamId: null, createdAt: new Date().toISOString() },
    seedInvite: { emailLc: EMAIL, teamId: "team_acme", teamRole: "admin", status: "pending",
      invitedBy: "o@x.com", createdAt: new Date().toISOString(), consumedAt: null },
  });
  const env = makeEnv(mock.namespace);
  const res = await callbackFor(EMAIL, env);
  expect(res.status).toBe(302);
  expect(mock.tenantRoles.get("u1:team_acme")?.tenantRole).toBe("tenant_admin");
});

it("tenantRole write failure does not block login (fail-open)", async () => {
  const mock = makeMock({
    seedUser: { userId: "u1", email: EMAIL, role: "user", teamId: null, createdAt: new Date().toISOString() },
    seedInvite: { emailLc: EMAIL, teamId: "team_acme", teamRole: "user", status: "pending",
      invitedBy: "o@x.com", createdAt: new Date().toISOString(), consumedAt: null },
    putTenantRoleThrows: true,
  });
  const env = makeEnv(mock.namespace);
  const res = await callbackFor(EMAIL, env);
  expect(res.status).toBe(302); // login still succeeds
});
```

Extend the test file's `makeMock` to support `tenantRoles` map, `putTenantRole`, and a `putTenantRoleThrows` option.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/xumingyang/github/contrabass/cloud && bun run test src/litellm-portal/auth/login-routes.test.ts`
Expected: FAIL — `tenantRoles` map stays empty (no `putTenantRole` call in callback).

- [ ] **Step 3: Extend the auto-join block**

In `cloud/src/litellm-portal/auth/login-routes.ts`, inside the existing fail-open invite auto-join `try { ... }` block (where F1 calls `markInviteConsumed(emailLc)`), after the `markInviteConsumed` call and before/after `invalidateRole`, add:

```ts
        // Seed the portal-level tenant role from the invite (fail-open).
        try {
          await inviteStub.putTenantRole({
            userId: current.userId,
            teamId: invite.teamId,
            tenantRole: invite.teamRole === "admin" ? "tenant_admin" : "member",
            updatedBy: `invite:${invite.invitedBy}`,
            updatedAt: new Date().toISOString(),
          });
        } catch (e) {
          console.error("[auth] tenantRole seed failed (non-fatal):", e);
        }
```

Extend the inline `IndexDOStub` type in this file to declare `putTenantRole(record: { userId: string; teamId: string; tenantRole: "tenant_admin" | "member"; updatedBy: string; updatedAt: string }): Promise<unknown>`.

- [ ] **Step 4: Run tests + typecheck**

Run: `cd /Users/xumingyang/github/contrabass/cloud && bun run test src/litellm-portal/auth/login-routes.test.ts && bun run typecheck`
Expected: PASS (incl. the existing F1 auto-join tests unchanged); typecheck baseline only.

- [ ] **Step 5: Commit**

```bash
cd /Users/xumingyang/github/contrabass
git add cloud/src/litellm-portal/auth/login-routes.ts cloud/src/litellm-portal/auth/login-routes.test.ts
git -c commit.gpgsign=false commit -m "feat(litellm-portal): seed tenantRole on invite consume (fail-open)"
```

---

## Task 7: Admin write API to assign `tenantRole` (for the future Ops Console)

Phase 0 must expose the backend write so Phase 2's Ops Console can assign tenant roles. Platform-admin-gated, audited, write-ops-flag gated, typed like the other F1 admin writes.

**Files:**
- Modify: `cloud/src/litellm-portal/schemas.ts`
- Modify: `cloud/src/litellm-portal/routes.ts`
- Test: `cloud/src/litellm-portal/routes-do-path.test.ts`

- [ ] **Step 1: Write the failing test**

In `routes-do-path.test.ts` add:

```ts
describe("PUT /api/admin/teams/:teamId/members/:userId/tenant-role", () => {
  it("admin sets a member's tenantRole → 200 + IndexDO.putTenantRole called + audit", async () => {
    const indexStub = makeIndexDOStub();
    const env = makeFlagOnEnv(indexStub, makeTeamConfigDOStub());
    const res = await app.fetch(await adminRequest(
      "https://x/api/admin/teams/t1/members/u1/tenant-role", env,
      { method: "PUT", body: JSON.stringify({ reason: "user_request", tenantRole: "tenant_admin" }) }), env);
    expect(res.status).toBe(200);
    expect(indexStub.putTenantRole).toHaveBeenCalledWith(
      expect.objectContaining({ userId: "u1", teamId: "t1", tenantRole: "tenant_admin" }));
    expect(indexStub.appendAudit).toHaveBeenCalled();
  });
  it("422 on bad tenantRole; 403 non-admin; 404 write-ops disabled", async () => {
    const env = makeFlagOnEnv(makeIndexDOStub(), makeTeamConfigDOStub());
    expect((await app.fetch(await adminRequest(
      "https://x/api/admin/teams/t1/members/u1/tenant-role", env,
      { method: "PUT", body: JSON.stringify({ reason: "other", tenantRole: "boss" }) }), env)).status).toBe(422);
    const off = makeFlagOnEnv(makeIndexDOStub(), makeTeamConfigDOStub(), { LITELLM_PORTAL_WRITE_OPS_ENABLED: "false" });
    expect((await app.fetch(await adminRequest(
      "https://x/api/admin/teams/t1/members/u1/tenant-role", off,
      { method: "PUT", body: JSON.stringify({ reason: "other", tenantRole: "member" }) }), off)).status).toBe(404);
  });
});
```

Add `putTenantRole: vi.fn()` to `makeIndexDOStub()` in that file.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/xumingyang/github/contrabass/cloud && bun run test src/litellm-portal/routes-do-path.test.ts`
Expected: FAIL — route returns 404.

- [ ] **Step 3: Add schema**

In `cloud/src/litellm-portal/schemas.ts`, after the F1 invite schemas, add:

```ts
export const SetTenantRoleBodySchema = z.object({
  reason: WriteReasonSchema,
  tenantRole: z.enum(["tenant_admin", "member"]),
});
export type SetTenantRoleBody = z.infer<typeof SetTenantRoleBodySchema>;

export const SetTenantRoleResultSchema = z.object({
  userId: z.string(),
  teamId: z.string(),
  tenantRole: z.enum(["tenant_admin", "member"]),
  dryRun: z.boolean(),
});
export type SetTenantRoleResult = z.infer<typeof SetTenantRoleResultSchema>;
```

- [ ] **Step 4: Add the admin route**

In `routes.ts`, add a sub-app (mirror `adminUpdateUserApp`), import the new schemas, mount after the other admin sub-apps:

```ts
const adminTenantRoleApp = new Hono<HonoEnv>()
  .use("/*", applyAuthMiddleware)
  .use("/admin/*", applyAdminRateLimit)
  .use("/admin/*", requireAdmin)
  .put("/admin/teams/:teamId/members/:userId/tenant-role", async (c) => {
    if (!isWriteOpsEnabled(c.env)) return writeOpsDisabledResponse(c);
    const teamId = decodeURIComponent(c.req.param("teamId") ?? "").trim();
    const userId = decodeURIComponent(c.req.param("userId") ?? "").trim();
    if (!teamId || !userId) return c.json({ error: "team_and_user_required" }, 400);
    const parsed = await parseWriteBody(c, SetTenantRoleBodySchema);
    if (!parsed.ok) return parsed.response;
    if (!c.env.INDEX_DO) return c.json({ error: "index_do_unavailable" }, 503);
    const identity = c.get("identity");
    const isDryRun = new URL(c.req.url).searchParams.get("dryRun") === "true";
    if (!isDryRun) {
      const idx = c.env.INDEX_DO.get(c.env.INDEX_DO.idFromName("index")) as unknown as {
        putTenantRole(r: { userId: string; teamId: string; tenantRole: "tenant_admin" | "member"; updatedBy: string; updatedAt: string }): Promise<void>;
      };
      await idx.putTenantRole({
        userId, teamId, tenantRole: parsed.data.tenantRole,
        updatedBy: identity.email, updatedAt: new Date().toISOString(),
      });
      await auditWrite(c.env, {
        actor: identity.email, action: "admin_tenant_role_set", target: `${teamId}/${userId}`,
        ip: c.req.header("cf-connecting-ip") ?? "unknown", ts: new Date().toISOString(),
        before: "null", after: JSON.stringify({ tenantRole: parsed.data.tenantRole }),
        reason: parsed.data.reason,
      });
    }
    return c.json(SetTenantRoleResultSchema.parse({
      userId, teamId, tenantRole: parsed.data.tenantRole, dryRun: isDryRun,
    }));
  });
```

Mount: `.route("/api", adminTenantRoleApp)` in the chain after the other admin sub-apps.

- [ ] **Step 5: Run tests + typecheck**

Run: `cd /Users/xumingyang/github/contrabass/cloud && bun run test src/litellm-portal/routes-do-path.test.ts && bun run typecheck`
Expected: PASS; typecheck baseline only.

- [ ] **Step 6: Commit**

```bash
cd /Users/xumingyang/github/contrabass
git add cloud/src/litellm-portal/schemas.ts cloud/src/litellm-portal/routes.ts cloud/src/litellm-portal/routes-do-path.test.ts
git -c commit.gpgsign=false commit -m "feat(litellm-portal): admin API to assign portal tenantRole"
```

---

## End-to-End Verification

- [ ] **Full suite + typecheck + build (authoritative order: build THEN test):**

```bash
cd /Users/xumingyang/github/contrabass/cloud
bun run typecheck                       # expect ONLY the server-impl jsx baseline error
bun run build:litellm-portal            # expect exit 0
bun run test src/litellm-portal         # expect green; the known happy-dom localhost:3000/kumo.css
                                        # full-suite timeout flake may rotate — re-run isolated to confirm:
bun run test src/litellm-portal/durable/index-do.test.ts \
             src/litellm-portal/role-cache.test.ts \
             src/litellm-portal/routes-do-path.test.ts \
             src/litellm-portal/auth/login-routes.test.ts
```

Expected: all Phase-0 targeted suites green; tsc only baseline; build exit 0. If the 36-file run times out on an SSR test in a file you did not touch (`index.test.ts`/`security.test.ts`/`usage-overview-routes.test.ts`), that is the pre-existing flake documented in the spec — confirm via the isolated re-run and treat CI as the gate.

- [ ] **Behavioral E2E (manual, staging, after merge + deploy via `bun run deploy:litellm-portal`):**
  1. Owner: `PUT /api/admin/teams/<t>/members/<u>/tenant-role {tenantRole:"tenant_admin"}` → 200, audit row appears in `GET /api/admin/audit`.
  2. That user logs in via magic-link → `resolveIdentity` now yields `tenantRole: "tenant_admin"`, `tenantTeamId: <t>`.
  3. As that user: `GET /api/tenant/invites` → 200; `POST /api/tenant/invites` with a foreign `teamId` in body → invite still created against own team only.
  4. As a plain member of `<t>`: `GET /api/tenant/invites` → 403 `tenant_admin_required`.
  5. New invitee with `teamRole:"admin"` consumes a magic-link → `GET /api/admin/teams/<t>/members` shows them, and their `tenantRole` is `tenant_admin` (verify via a follow-up tenant-scoped call succeeding).
  6. SSRF: `PUT /api/tenant/alert-webhook {url:"http://169.254.169.254/x"}` → 422.

- [ ] **Open the PR (do NOT self-merge):**

```bash
cd /Users/xumingyang/github/contrabass
git push -u origin feat/litellm-portal-phase0-tenantrole
gh pr create --base main --head feat/litellm-portal-phase0-tenantrole \
  --title "feat(litellm-portal): Phase 0 — portal tenantRole foundation" \
  --body "Implements Phase 0 of docs/superpowers/specs/2026-05-17-litellm-portal-uiux-redesign-design.md: tenantRole store, identity resolution, requireTenantAdmin, /api/tenant/* scoped endpoints, invite→tenantRole seed, admin assign API. Backend-only, no UI. Depends on #136. Tests: Phase-0 suites green; tsc baseline only; build clean. Known pre-existing full-suite happy-dom flake documented in spec — CI is the gate."
```

Report PR URL + CI status to the user. Do not merge without explicit approval.

---

## Self-Review

**1. Spec coverage** (spec §5 "必需后端改动" + Phase 0 bullets):
- tenantRole store + self-migration → Task 1 (schema) + Task 2 (table/CRUD). ✓
- `resolveIdentity` → `{platformRole, tenantRole, teamId}` → Task 3. ✓
- `requireTenantAdmin` (own-team only; Owner superset) → Task 4. ✓
- Tenant-scoped endpoints (invites/webhook/billing self-serve) → Task 5. ✓
- Invite consume writes initial tenantRole (write authority via F1 auto-join) → Task 6. ✓
- Backend write API for Ops Console assignment (Phase 2 dependency) → Task 7. ✓
- SSR shell selection / `/ops` routing / impersonation UI → **intentionally NOT here** (spec assigns shell/route to Phase 1/2; Phase 0 is API-only). No gap.

**2. Placeholder scan:** Task 4 Step 1 explicitly states its tests live in Task 5 (documented, not a hidden TODO). No "TBD"/"add error handling"/uncoded steps. Task 5 Step 3 says "extract `*Core` helpers" — the engineer must read the F1/F2/F3 handlers to extract; this is a behavior-preserving refactor with the exact call sites and signatures specified, and Step 4 pins the green-bar (all existing admin tests must stay green) so correctness is verifiable. Acceptable.

**3. Type consistency:** `TenantRoleRecord` fields (`userId,teamId,tenantRole,updatedBy,updatedAt`) are identical across Tasks 1/2/6/7. `tenantRole` enum `"tenant_admin"|"member"` consistent everywhere. `PortalIdentity.tenantRole` is `"tenant_admin"|"member"|null` + `tenantTeamId: string|null` consistent across Tasks 3/4/5. `invite.teamRole` mapping (`"admin"→"tenant_admin"`, `"user"→"member"`) appears only in Task 6 and matches F1's `InviteRecord.teamRole` (`"admin"|"user"`). Method names stable: `putTenantRole`/`getTenantRole`/`listTenantRoles`. No drift.

No issues requiring fixes.
