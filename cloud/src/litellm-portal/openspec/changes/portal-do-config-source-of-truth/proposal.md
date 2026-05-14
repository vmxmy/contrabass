## Why

Today the portal sits behind Cloudflare Access for identity, and the upstream LiteLLM proxy is the authoritative store for team / user / role / budget. This couples authentication to a single Cloudflare product, leaves the portal unable to model its own users (it borrows them from LiteLLM each request), and forces every admin write to be a synchronous round-trip into LiteLLM with no buffering, retry, or local source of truth. When LiteLLM admin endpoints flap, the admin UI flaps with them; when an operator needs to evolve the user/role model beyond what LiteLLM exposes, there is no place to do it.

## What Changes

- Remove Cloudflare Access from the portal request path. Replace it with an email magic-link login owned by the Worker, signed session cookies, and a configurable email-domain allow-list.
- Introduce Durable Objects as the single source of truth for team metadata, user records, role assignments, and budget/limit configuration, plus mirrored spend snapshots.
- Partition DO storage as a per-team `TeamConfigDO` (id = teamId) plus a singleton `IndexDO` (team list, email→user index, user→team index, magic-link nonces, audit log, bootstrap state).
- Introduce a Cloudflare Queue (`litellm-sync`) so admin writes return after the DO write while a consumer Worker reliably pushes desired state into LiteLLM with retries and a dead-letter queue.
- Introduce a scheduled Worker that mirrors spend from LiteLLM into per-team DO storage on a ≤60s cadence so the UI never reads spend live.
- Bootstrap a fresh deployment with admins from a `BOOTSTRAP_ADMIN_EMAILS` env var and seed DO from LiteLLM `/user/list` + `/team/list` exactly once on first init.
- Cut over in a single maintenance window; no dual-run between Cloudflare Access and DO-backed auth.

## Capabilities

### New Capabilities
- `portal-magic-link-auth`: email magic-link login, signed session cookie, email-domain allow-list, replacement for Cloudflare Access JWT validation and `/cdn-cgi/access/logout`.
- `portal-config-source-of-truth`: Durable Objects (`IndexDO` + `TeamConfigDO`) that own team / user / role / budget config plus mirrored spend snapshots, with DO-first writes.
- `portal-litellm-config-sync`: Cloudflare Queue producer at admin write sites, a queue-consumer Worker that materializes DO state into LiteLLM with retries and a DLQ, and a scheduled spend mirror that pulls LiteLLM spend back into DO.
- `portal-bootstrap-import`: env-var admin bootstrap and a one-shot idempotent LiteLLM import that seeds DO on first init.

### Modified Capabilities
- None. The in-flight `admin-team-member-usage` and `admin-team-attributed-usage` capabilities remain read-only and continue to work; their data source is expected to switch from direct LiteLLM reads to the new DO surface, but that adaptation is downstream of this change.

## Impact

- Affected backend: `auth.ts`, `routes.ts`, `index.ts`, `types.ts`, `role-cache.ts`, `litellm.ts`, `client.tsx`, `security/headers.ts`, `routes/__root.tsx` logout link.
- New backend modules: `auth/magic-link.ts`, `auth/session.ts`, `auth/allowlist.ts`, `durable/index-do.ts`, `durable/team-config-do.ts`, `durable/schemas.ts`, `sync/queue-producer.ts`, `sync/queue-consumer.ts`, `sync/litellm-importer.ts`, `sync/spend-snapshot-cron.ts`.
- Affected frontend: a new `/login` route and a removed `/cdn-cgi/access/logout` affordance; admin write surfaces stay where they are but their response semantics gain a `lastSyncedAt` and a sync-status badge.
- Affected API surface: new `POST /login`, `GET /magic-callback`, `POST /logout`. Existing `/api/admin/*` write endpoints keep their paths but now write DO → Queue → LiteLLM. Existing admin reads continue to work but now read from DO.
- New bindings: `INDEX_DO` and `TEAM_CONFIG_DO` Durable Object bindings, a `LITELLM_SYNC_QUEUE` queue producer + consumer, and a 1-minute scheduled trigger.
- New secrets / env vars: `PORTAL_SESSION_SECRET`, `PORTAL_MAGIC_LINK_SECRET`, `PORTAL_ALLOWED_EMAIL_DOMAINS`, `BOOTSTRAP_ADMIN_EMAILS`.
- Removed env vars: `CLOUDFLARE_ACCESS_AUD`, `CLOUDFLARE_ACCESS_TEAM_DOMAIN`, `LITELLM_PORTAL_ALLOWED_EMAIL_DOMAIN`, `LITELLM_PORTAL_ALLOWED_EMAILS`, `LITELLM_PORTAL_DEV_AUTH`.
- Operational envelope assumed: ≤500 users, ≤50 teams, session 7d, magic-link 15min, spend staleness ≤60s, cutover via ≤30 min maintenance window.
