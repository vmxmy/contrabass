# Litellm Portal

A Cloudflare Worker serving the admin portal at `zhiyun.ziikoo.com`. The Worker is the only public entrypoint — there is no Cloudflare Access in front of it. Authentication is email magic-link. Durable Objects are the source of truth for teams, users, roles, and budgets. LiteLLM is the inference data plane and a downstream materialization target; it is not the control plane.

## Architecture

```
browser → Worker (zhiyun.ziikoo.com)
               │
               ├─ auth: magic-link email (Cloudflare Email Service)
               │         HMAC-signed token, 15-min TTL, single-use
               │         session cookie: HS256, 7-day TTL, HttpOnly/Secure/SameSite=Lax
               │
               ├─ state: IndexDO (singleton) + TeamConfigDO (per-team)
               │         source of truth for teams / users / roles / budgets
               │
               ├─ sync:  admin write → DO commit → enqueue to litellm-sync
               │         queue consumer → LiteLLM admin API (max 5 retries)
               │         terminal failure → litellm-sync-dlq + meta:lastSyncError
               │
               └─ cron:  * * * * *  — spend snapshot: LiteLLM /team/info → TeamConfigDO
                         0 9 * * *  — daily budget-threshold email scan
```

- `IndexDO` (singleton, id `"index"`) — team list, `email→user` index, magic-link nonces, bootstrap state, audit log.
- `TeamConfigDO` (id = teamId) — team metadata, members, keys, spend snapshot, sync metadata (`meta:lastSyncedAt`, `meta:lastSyncError`, `meta:dirty`).
- `BOOTSTRAP_ADMIN_EMAILS` secret seeds the initial admin accounts on first `IndexDO.init()`.

## Auth flow

1. User POSTs email to `POST /login`.
2. Worker validates email format and domain against `PORTAL_ALLOWED_EMAIL_DOMAINS`; rate-limit: 3 requests/email/5 min, 10 requests/IP/5 min.
3. `ensurePortalDOInitialized` (singleflight + 30 s failure backoff) ensures `IndexDO` is seeded.
4. `issueMagicLink(env, email)` — HMAC-signed token stored as a nonce in `IndexDO`.
5. Cloudflare Email Service sends a "Sign in" email to the user with a `/magic-callback?token=…` link (15-min TTL).
6. User clicks the link → Worker verifies HMAC signature + single-use + TTL → upserts `UserRecord` in `IndexDO` → sets session cookie → redirects to `/`.

## Sync flow

1. Admin write handler commits the change to DO.
2. `enqueueSync(env, { kind, entityId, payload, idempotencyKey })` sends a `SyncMessage` to `LITELLM_SYNC_QUEUE`.
3. Queue consumer dispatches to the appropriate LiteLLM admin endpoint.
   - 4xx response → forward to `litellm-sync-dlq` (non-retryable).
   - 5xx response → retry (up to `max_retries = 5` with Cloudflare Queue backoff).
4. On success, `recordSyncSuccess(idempotencyKey)` clears `meta:dirty` only if the key matches the pending sync entry — prevents stale-success races.
5. Spend cron (`* * * * *`) walks team IDs from `IndexDO`, calls LiteLLM `/team/info` per team, writes `spend:current` to each `TeamConfigDO`. UI reads spend strictly from DO.

## Required bindings

### Durable Objects

| Binding | Class | Notes |
|---|---|---|
| `INDEX_DO` | `IndexDO` | Singleton (id `"index"`). Team list, user index, nonces, audit log. |
| `TEAM_CONFIG_DO` | `TeamConfigDO` | Per-team (id = teamId). Metadata, members, spend snapshot, sync state. |
| `RATE_LIMIT_DO` | `RateLimitDO` | Per-IP / per-email rate limiting for login endpoints. |

### Queues

| Binding | Queue name | Role |
|---|---|---|
| `LITELLM_SYNC_QUEUE` | `litellm-sync` | Producer. Enqueued on every admin write. |
| `LITELLM_SYNC_DLQ` | `litellm-sync-dlq` | Producer. Written on terminal sync failure. |

Also configure a queue consumer for `litellm-sync` with `max_retries = 5` and a DLQ pointing to `litellm-sync-dlq`.

### Email

`[[send_email]]` binding named `EMAIL` with `remote = true`. The sender domain (`ziikoo.com`) must be onboarded in Cloudflare Compute → Email Service → Email Sending.

### KV

| Binding | Notes |
|---|---|
| `USER_PREFS_KV` | Stores per-user UI preferences. |

### Analytics Engine

| Binding | Notes |
|---|---|
| `METRICS_AE` | Request and usage metrics. |
| `AUDIT_AE` | Admin-action audit events. |

## Required secrets and vars

| Name | Kind | Notes |
|---|---|---|
| `LITELLM_MASTER_KEY` | secret | Master key for LiteLLM admin endpoints. |
| `PORTAL_SESSION_SECRET` | secret | Signs session cookies (HS256). Rotate to invalidate all sessions. |
| `PORTAL_MAGIC_LINK_SECRET` | secret | Signs magic-link tokens (HMAC). |
| `BOOTSTRAP_ADMIN_EMAILS` | secret | Comma-separated list of emails granted `role=admin` on first `IndexDO.init()`. |
| `ROLE_INVALIDATION_WEBHOOK_TOKEN` | secret | Authenticates role-invalidation webhook calls. |
| `PORTAL_ALLOWED_EMAIL_DOMAINS` | var | Comma-separated allowed email domains, e.g. `"gz-zhiyun.com"`. |
| `PORTAL_MAIL_FROM` | var | Sender address for magic-link emails, e.g. `"no-reply@ziikoo.com"`. |
| `LITELLM_BASE_URL` | var | Base URL of the upstream LiteLLM proxy, e.g. `"https://litellm.ziikoo.com"`. |
| `LITELLM_PORTAL_COMPANY_NAME` | var | Company name shown in the portal UI. |
| `LITELLM_PORTAL_DISPLAY_NAME` | var | Portal display name shown in email subjects. |

## Deploy

```bash
# Pre-create queues (idempotent — wrangler does NOT auto-create)
wrangler queues create litellm-sync
wrangler queues create litellm-sync-dlq

# Set secrets (interactive)
wrangler secret put LITELLM_MASTER_KEY        --config cloud/wrangler.litellm-portal.toml
wrangler secret put PORTAL_SESSION_SECRET     --config cloud/wrangler.litellm-portal.toml
wrangler secret put PORTAL_MAGIC_LINK_SECRET  --config cloud/wrangler.litellm-portal.toml
wrangler secret put BOOTSTRAP_ADMIN_EMAILS    --config cloud/wrangler.litellm-portal.toml
wrangler secret put ROLE_INVALIDATION_WEBHOOK_TOKEN --config cloud/wrangler.litellm-portal.toml

# Build + deploy (uses pre-bundle pipeline due to lingui macros)
cd cloud && bun run deploy:litellm-portal
```

## Email prerequisites

The sender domain (`ziikoo.com`) must be onboarded in Cloudflare Compute → Email Service → Email Sending. Cloudflare Email Service handles SPF/DKIM automatically for domains managed in Cloudflare DNS. If using a domain external to Cloudflare, add the Cloudflare-provided SPF include and DKIM record manually before deploying.

## Removed since previous version

The following items were removed as part of the magic-link + DO source-of-truth cutover and must not be re-introduced:

- **Cloudflare Access** — `Cf-Access-Jwt-Assertion` header validation, JWKS verification, `/cdn-cgi/access/logout`. Replaced by magic-link auth and signed session cookies.
- **`role-cache.ts` LiteLLM-projection path** — three-tier memory → KV → LiteLLM role lookup. Replaced by `IndexDO` lookup with in-process cache.
- **`ROLE_CACHE_KV` binding** — removed in T-12.3.
- **`x-litellm-portal-dev-email` test header** — replaced by a signed session cookie test helper.
- **`PORTAL_DO_SOT_ENABLED` feature flag** — the DO source-of-truth path is always active; the flag is gone.
- **MailChannels** — `https://api.mailchannels.net/tx/v1/send`. Replaced by Cloudflare Email Service (`[[send_email]]` binding).
- **`CLOUDFLARE_ACCESS_AUD`, `CLOUDFLARE_ACCESS_TEAM_DOMAIN`, `LITELLM_PORTAL_ALLOWED_EMAIL_DOMAIN`, `LITELLM_PORTAL_ALLOWED_EMAILS`, `LITELLM_PORTAL_DEV_AUTH`** — removed env vars from the pre-cutover configuration.

## See also

- OpenSpec change: `cloud/src/litellm-portal/openspec/changes/portal-do-config-source-of-truth/`
- Plane project: `PDCSOT` (https://plane.ziikoo.com/ziikoo/projects/1e281c60-3d8b-440f-9f50-3128d544c0bd/issues/)
