# Cloud Secrets Store

Contrabass stores only cloud-side tracker tokens in Cloudflare Secrets Store. Agent, model, git, and developer-machine credentials stay local to `contrabass worker` and must never be copied into the cloud control plane.

## Store

Use the account Secrets Store named `default_secrets_store` for Contrabass tracker credentials. Cloudflare accounts expose Secrets Store as an account-level resource, so Contrabass keeps one store and separates tenants by secret name instead of creating one store per team.

Create the store once in each target Cloudflare account before deploying tracker polling:

```sh
cd cloud
bun run secrets:store:create
```

The script runs `wrangler secrets-store store create default_secrets_store --remote` against the authenticated Wrangler account. Re-run it only when provisioning a new account or after intentionally deleting the store.

Secrets created for this store should use the `workers` scope. Task 5.2 binds the store only to the tracker poller Worker; do not bind it to the public API Worker, Durable Objects, dashboard Pages project, or local workers.

## Per-Team Naming

Tracker secrets are named by provider under a team prefix:

| Provider | Secret name |
| --- | --- |
| Linear | `tracker/{teamId}/linear` |
| GitHub Issues | `tracker/{teamId}/github` |

`teamId` must be the canonical cloud team id from D1. It must not be blank and must not contain `/`, because `/` separates the namespace segments.

Examples:

```text
tracker/team-alpha/linear
tracker/team-alpha/github
```

## Values

- `tracker/{teamId}/linear`: Linear API token for polling the team's saved Linear query.
- `tracker/{teamId}/github`: GitHub PAT or installation token for polling the team's configured repositories, labels, and assignees.

Secret values are write-only through the Cloudflare API. Rotation should overwrite the same name so team configuration can keep referring to the stable provider path.
