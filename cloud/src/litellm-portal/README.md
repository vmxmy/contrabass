# Litellm Portal

A Cloudflare Worker that fronts the upstream LiteLLM proxy. After openspec change `portal-do-config-source-of-truth`, the portal uses Durable Objects as the single source of truth for team / user / role / budget, plus a Cloudflare Queue (`litellm-sync`) that materializes desired state into LiteLLM with retries and a DLQ, plus a 1-minute scheduled mirror that pulls spend snapshots back. Authentication is email magic-link login (replacing Cloudflare Access).

## Environment variables and secrets

| Name | Type (secret/var) | Required when | Set via | Example |
|---|---|---|---|---|
| `PORTAL_SESSION_SECRET` | secret | `PORTAL_DO_SOT_ENABLED="true"` | `wrangler secret put PORTAL_SESSION_SECRET --config wrangler.litellm-portal.toml` | random ≥32 byte string |
| `PORTAL_MAGIC_LINK_SECRET` | secret | `PORTAL_DO_SOT_ENABLED="true"` | `wrangler secret put PORTAL_MAGIC_LINK_SECRET --config wrangler.litellm-portal.toml` | random ≥32 byte string |
| `PORTAL_ALLOWED_EMAIL_DOMAINS` | var | always | `[vars]` in `wrangler.litellm-portal.toml` | `"gz-zhiyun.com,partner.example"` |
| `BOOTSTRAP_ADMIN_EMAILS` | var | first deploy and any future bootstrap-admin additions | `[vars]` in `wrangler.litellm-portal.toml` | `"alice@gz-zhiyun.com,bob@gz-zhiyun.com"` |
| `PORTAL_DO_SOT_ENABLED` | var | feature flag — set `"false"` until cutover | `[vars]` in `wrangler.litellm-portal.toml` | `"false"` |

The following pre-change fields remain required and are unchanged:

| Name | Type (secret/var) | Notes |
|---|---|---|
| `LITELLM_BASE_URL` | var | Base URL of the upstream LiteLLM proxy (e.g. `https://litellm.ziikoo.com`) |
| `LITELLM_MASTER_KEY` | secret | Master key for LiteLLM admin endpoints — provision via `wrangler secrets-store secret put LITELLM_MASTER_KEY` |

## Cloudflare bindings

All bindings are declared in `wrangler.litellm-portal.toml`. The new bindings introduced by `portal-do-config-source-of-truth` are:

- `INDEX_DO` (singleton IndexDO Durable Object) — class `IndexDO` — owns the team list, `email→user` index, magic-link nonces, bootstrap admin state, and audit log.
- `TEAM_CONFIG_DO` (per-team TeamConfigDO Durable Object) — class `TeamConfigDO` — owns team metadata, members, keys, spend snapshot, and sync metadata per team (id = teamId).
- `LITELLM_SYNC_QUEUE` (queue producer for `litellm-sync`) — consumed by the worker's `queue()` handler; each admin write enqueues a `SyncMessage` after the DO commit to materialize desired state into LiteLLM with retries.
- `LITELLM_SYNC_DLQ` (queue producer for `litellm-sync-dlq`) — written to on terminal sync failure after all retries are exhausted; `meta:lastSyncError` is also written on the corresponding DO row.

## Cron triggers

Configured under `[triggers]` in `wrangler.litellm-portal.toml`. Dispatch is implemented in `src/litellm-portal/index.ts`'s `scheduled()` handler via `controller.cron`:

- `"0 9 * * *"` — daily 09:00 UTC, fires the `scanBudgetThresholds` budget-warning email scan.
- `"* * * * *"` — every minute, reserved for the spend snapshot mirror (PDCSOT-39 / T-5.2 will land the handler). Currently a no-op placeholder so the cron schedule is registered before the handler is implemented.

## MailChannels DNS prerequisites

For magic-link delivery via MailChannels (`https://api.mailchannels.net/tx/v1/send`), the sender domain MUST have:

- An SPF TXT record permitting MailChannels: `v=spf1 include:relay.mailchannels.net ~all` (or include alongside any existing SPF policy).
- A DKIM record published in the sender domain's DNS, with the public key matching the key configured in the MailChannels dashboard.
- Optionally, a DMARC TXT record (`v=DMARC1; p=quarantine; rua=mailto:...`) for delivery reliability.

The current `from` address defaults to `no-reply@gz-zhiyun.com`. If you change it, update the SPF/DKIM records on the new sender domain too.

## Cutover sequence

Brief checklist (the detailed runbook lives in `openspec/changes/portal-do-config-source-of-truth/design.md` § Migration Plan):

1. Deploy the worker with `PORTAL_DO_SOT_ENABLED="false"`. Cloudflare Access continues to gate the portal.
2. During a ≤30-minute maintenance window: flip `PORTAL_DO_SOT_ENABLED="true"`, redeploy.
3. On first request, `IndexDO.init()` imports the existing LiteLLM users/teams into DO. `meta:imported = true` afterwards.
4. Smoke-test: bootstrap admin login via magic link, an admin write that flows DO → Queue → LiteLLM, and one tick of the spend snapshot cron.
5. Detach Cloudflare Access from the hostname.
6. Cleanup commits (PDCSOT-80..84) remove dead CF Access code paths.

Rollback: redeploy previous build and re-attach Cloudflare Access policy in the Cloudflare dashboard. DO state is left in place (`meta:imported` stays true).

## See also

- OpenSpec change: `cloud/src/litellm-portal/openspec/changes/portal-do-config-source-of-truth/`
- Plane project: `PDCSOT` (https://plane.ziikoo.com/ziikoo/projects/1e281c60-3d8b-440f-9f50-3128d544c0bd/issues/)
