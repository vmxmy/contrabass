## 1. Schemas and types

- [ ] 1.1 Define Zod schemas in `durable/schemas.ts` for `TeamRecord`, `UserRecord`, `KeyRecord`, `SpendSnapshot`, `MagicLinkNonce`, `AuditEvent`, `SyncMessage`.
- [ ] 1.2 Remove `CLOUDFLARE_ACCESS_AUD`, `CLOUDFLARE_ACCESS_TEAM_DOMAIN`, `LITELLM_PORTAL_ALLOWED_EMAIL_DOMAIN`, `LITELLM_PORTAL_ALLOWED_EMAILS`, `LITELLM_PORTAL_DEV_AUTH` from `types.ts`.
- [ ] 1.3 Add `PORTAL_SESSION_SECRET`, `PORTAL_MAGIC_LINK_SECRET`, `PORTAL_ALLOWED_EMAIL_DOMAINS`, `BOOTSTRAP_ADMIN_EMAILS`, `DO_SOT_FLAG` to `types.ts`.
- [ ] 1.4 Add `INDEX_DO`, `TEAM_CONFIG_DO`, `LITELLM_SYNC_QUEUE`, `LITELLM_SYNC_DLQ` bindings to `types.ts`.
- [ ] 1.5 Choose explicit field names (`maxBudget`, `currentSpend`, `lastSyncedAt`, `lastSyncError`) and ensure they do not collide with existing admin payloads.

## 2. Durable Objects: IndexDO + TeamConfigDO

- [ ] 2.1 Implement `IndexDO` in `durable/index-do.ts` with storage keys: `teams:list`, `email:{lowercase}`, `user:{userId}`, `nonce:{token}`, `audit:{ts}:{id}`, `meta:imported`, `meta:bootstrapAdmins`.
- [ ] 2.2 Implement `TeamConfigDO` in `durable/team-config-do.ts` with storage keys: `team`, `members:{userId}`, `keys:{keyId}`, `spend:current`, `meta:lastSyncedAt`, `meta:lastSyncError`, `meta:dirty`.
- [ ] 2.3 Implement DO alarm handlers in `IndexDO` to expire `nonce:{token}` after 15 minutes.
- [ ] 2.4 Implement `IndexDO.init()` as idempotent: guarded by `meta:imported`, safe to call repeatedly.
- [ ] 2.5 Add `[[migrations]] new_classes = ["IndexDO", "TeamConfigDO"]` to `wrangler.toml` (or the wrangler.jsonc equivalent).
- [ ] 2.6 Add `[[durable_objects.bindings]]` entries for `INDEX_DO` and `TEAM_CONFIG_DO`.

## 3. Auth: magic-link + session + allow-list

- [ ] 3.1 Implement `auth/allowlist.ts`: parse `PORTAL_ALLOWED_EMAIL_DOMAINS` (comma-separated), case-insensitive match.
- [ ] 3.2 Implement `auth/magic-link.ts`: HMAC sign with `PORTAL_MAGIC_LINK_SECRET`, 15-minute TTL, single-use enforcement via `IndexDO` nonce key.
- [ ] 3.3 Implement `auth/session.ts`: sign session cookie (HS256) with `PORTAL_SESSION_SECRET`, 7d TTL, `HttpOnly; Secure; SameSite=Lax; Path=/`; verify on each request.
- [ ] 3.4 Implement MailChannels send for magic-link delivery; fail loud with a 5xx if mail delivery fails.
- [ ] 3.5 Implement `/login` (GET shows form, POST issues magic link), `/magic-callback` (GET verifies + sets cookie), `/logout` (POST clears cookie).
- [ ] 3.6 Replace `authenticateRequest()` body in `auth.ts` with `authenticateSession()`; keep the `PortalPrincipal` shape stable for callers.
- [ ] 3.7 Replace the `window.location.href = "/cdn-cgi/access/logout"` line in `routes/__root.tsx` with a POST to `/logout`.
- [ ] 3.8 Replace `role-cache.ts` LiteLLM projection with a 30s memory cache that reads role from `IndexDO`.

## 4. Sync: queue producer + consumer + DLQ

- [ ] 4.1 Add `[[queues.producers]]` for `LITELLM_SYNC_QUEUE` (queue name `litellm-sync`) and `[[queues.consumers]]` for the same queue.
- [ ] 4.2 Add `[[queues.producers]]` for `LITELLM_SYNC_DLQ` (queue name `litellm-sync-dlq`).
- [ ] 4.3 Implement `sync/queue-producer.ts` with `enqueueSync({ kind, entityId, payload, idempotencyKey })`.
- [ ] 4.4 Implement `sync/queue-consumer.ts` as a Worker `queue()` handler that dispatches `kind` → LiteLLM admin endpoint (`team.update`, `user.update`, `key.generate`, `key.delete`, etc.), with up to 5 retries and exponential backoff.
- [ ] 4.5 On terminal failure, forward the message to `LITELLM_SYNC_DLQ` and write `meta:lastSyncError` on the corresponding DO row.
- [ ] 4.6 On success, write `meta:lastSyncedAt` on the corresponding DO row and clear `meta:dirty`.

## 5. Spend snapshot cron

- [ ] 5.1 Add `[triggers] crons = ["* * * * *"]` to wrangler config.
- [ ] 5.2 Implement `sync/spend-snapshot-cron.ts` as the Worker `scheduled()` handler.
- [ ] 5.3 The handler reads `teams:list` from `IndexDO`, then for each team fetches LiteLLM `/team/info?team_id=` and writes `spend:current` on the corresponding `TeamConfigDO`.
- [ ] 5.4 Tolerate per-team errors: a single failed team must not stop the loop; record `meta:lastSpendError` on the failing team.

## 6. Bootstrap and one-shot LiteLLM import

- [ ] 6.1 Implement `sync/litellm-importer.ts`: idempotent walk of LiteLLM `/team/list` (all pages) into `TeamConfigDO`s and `IndexDO.teams:list`.
- [ ] 6.2 Walk LiteLLM `/user/list` (all pages); for each user, write `IndexDO.email:{…}` and `IndexDO.user:{…}` and append to the relevant `TeamConfigDO.members:{userId}`.
- [ ] 6.3 During import, mark emails in `BOOTSTRAP_ADMIN_EMAILS` with `role = admin`.
- [ ] 6.4 On completion, set `meta:imported = true` and write a single `audit:{ts}:import` event.
- [ ] 6.5 Gate the importer entrypoint behind the `IndexDO.init()` flag so it cannot run twice in parallel.
- [ ] 6.6 At first-login of an email present in `BOOTSTRAP_ADMIN_EMAILS` but not in LiteLLM, upsert the user with `role = admin`.

## 7. Wrangler bindings + secrets

- [ ] 7.1 Add `[[durable_objects.bindings]]` for `INDEX_DO` and `TEAM_CONFIG_DO`.
- [ ] 7.2 Add the queue producer/consumer entries and the DLQ producer entry.
- [ ] 7.3 Add the 1-minute cron trigger.
- [ ] 7.4 Remove any CF Access references from `wrangler.toml` / `wrangler.jsonc`.
- [ ] 7.5 Define new secrets in deploy docs: `PORTAL_SESSION_SECRET`, `PORTAL_MAGIC_LINK_SECRET`; new env vars: `PORTAL_ALLOWED_EMAIL_DOMAINS`, `BOOTSTRAP_ADMIN_EMAILS`, `DO_SOT_FLAG`.

## 8. Route refactor (DO-sourced reads, DO-first writes)

- [ ] 8.1 In `routes.ts`, replace identity extraction with `authenticateSession()`; replace role lookup with `IndexDO` + 30s memory cache.
- [ ] 8.2 Replace LiteLLM-direct reads in `/api/admin/teams`, `/api/admin/users`, `/api/admin/teams/:teamId/*` with DO reads.
- [ ] 8.3 Replace LiteLLM-direct writes in `/api/admin/teams/:teamId/limits`, `/api/admin/users/:userId`, `/api/admin/keys/:keyId/disable`, `/api/admin/keys/:keyId` with DO-first writes that then call `enqueueSync(...)`.
- [ ] 8.4 Keep `auditWrite()` semantics; the audit row is also appended to `IndexDO.audit:{…}` and (when LiteLLM sync succeeds) the existing LiteLLM audit path remains until the cleanup follow-up removes it.
- [ ] 8.5 Add a `lastSyncedAt` and a `lastSyncError` field to admin team/user/key payloads so the UI can show a sync-status badge.

## 9. UI: /login, /logout, removal of CF Access affordances

- [ ] 9.1 Add a `/login` route with a single email input + submit button and an inline error region.
- [ ] 9.2 Add a `/magic-callback` route that exchanges the token for a session cookie and redirects to `/`.
- [ ] 9.3 Add a session-aware error page for invalid/expired magic links.
- [ ] 9.4 Add a "sync pending" / "sync failed" badge next to admin write surfaces, fed by `lastSyncedAt` / `lastSyncError`.
- [ ] 9.5 Surface an "awaiting team assignment" empty state for newly signed-up users who do not yet have a `teamId`.

## 10. Tests

- [ ] 10.1 Unit tests for `auth/magic-link.ts`: signature verification, TTL expiry, single-use enforcement.
- [ ] 10.2 Unit tests for `auth/session.ts`: cookie signing, tamper rejection, expiry rejection.
- [ ] 10.3 Unit tests for `auth/allowlist.ts`: multi-domain parse, case-insensitive match.
- [ ] 10.4 Miniflare-backed tests for `IndexDO`: nonce TTL, email index, idempotent init, bootstrap admin upsert.
- [ ] 10.5 Miniflare-backed tests for `TeamConfigDO`: team metadata write, member upsert, spend snapshot replacement, sync metadata updates.
- [ ] 10.6 Queue consumer tests: happy path advances `lastSyncedAt`, retryable failure retries, terminal failure goes to DLQ and records `lastSyncError`.
- [ ] 10.7 Importer tests: importing twice does not duplicate; `BOOTSTRAP_ADMIN_EMAILS` users land as admin.
- [ ] 10.8 Spend cron tests: per-team errors do not abort the loop.
- [ ] 10.9 Route tests: every existing `/api/admin/*` read endpoint serves DO-sourced data; every write endpoint commits to DO and enqueues a sync message.
- [ ] 10.10 E2E test: `/login` → `/magic-callback` → admin write → queue consumer → LiteLLM stub assertion.

## 11. Cutover and rollback verification

- [ ] 11.0 **Pre-deploy (one-time):** Create Cloudflare Queue resources before the first deploy — Wrangler does NOT auto-create them and the Worker will fail to start if they are missing:
  ```
  npx wrangler queues create litellm-sync --config wrangler.litellm-portal.toml
  npx wrangler queues create litellm-sync-dlq --config wrangler.litellm-portal.toml
  ```
  Confirm both queues appear in the Cloudflare dashboard (Workers & Pages → Queues) before proceeding.
- [ ] 11.1 Pre-cutover: deploy with `DO_SOT_FLAG=false`. Verify CF Access still gates the portal.
- [ ] 11.2 In the maintenance window: flip `DO_SOT_FLAG=true`, redeploy, allow `IndexDO.init()` to run, check `meta:imported=true`, verify team and user counts match LiteLLM.
- [ ] 11.3 Smoke: a `BOOTSTRAP_ADMIN_EMAILS` user receives a magic link, logs in, lands as `role=admin`.
- [ ] 11.4 Smoke: admin edits a team budget, sees `lastSyncedAt` advance, and `GET /team/info` on LiteLLM reflects the change within retry budget.
- [ ] 11.5 Smoke: spend snapshot updates `spend:current` within one cron tick.
- [ ] 11.6 Detach Cloudflare Access from the hostname.
- [ ] 11.7 Rollback drill: confirm that redeploying the previous build and re-attaching CF Access produces a working portal again (one-time exercise in staging).

## 12. Cleanup (follow-up commit)

- [ ] 12.1 Delete `Cf-Access-*` references, JWKS code, and `LITELLM_PORTAL_DEV_AUTH` test shims from `auth.ts` and tests.
- [ ] 12.2 Delete `role-cache.ts` LiteLLM projection paths now unreachable.
- [ ] 12.3 Remove `ROLE_CACHE_KV` from `wrangler.toml` if no other consumer remains.
- [ ] 12.4 Remove `LITELLM_PORTAL_DEV_AUTH` and the `x-litellm-portal-dev-email` header path from tests; replace with a test session-cookie helper.
- [ ] 12.5 Update `README.md` / portal docs to describe magic-link login, DO source of truth, and queue-based sync.
