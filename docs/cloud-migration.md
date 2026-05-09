# Cloud Migration

Contrabass cloud migration is an opt-in, stand-up migration from the single-host local runtime to the Cloudflare control plane. The migration command reads local project state, uploads enough data for the cloud board and configuration store to start, and leaves all local files in place so rollback remains simple.

Use this guide for task-board and `WORKFLOW.md` onboarding only. It does not move source code, git credentials, model API keys, or local agent secrets to the cloud.

## What Migrates

`contrabass migrate cloud --team <name>` reads these local inputs from the selected project root:

| Source | Cloud target | Notes |
| --- | --- | --- |
| `WORKFLOW.md` | D1 `team_configs` via `POST /v1/teams/{teamId}/config` | Uploaded with `created_by: "migration"` and a note pointing to the source path. The cloud validates and stores it as a content-addressed config version. |
| `.contrabass/state/team/<name>/*.json` | Migration plan context | Read and counted so operators can verify the selected team state, but not deleted or mutated. |
| `.contrabass/board/` | Cloud board via `POST /v1/teams/{teamId}/board/refresh` | Local board issues become refresh entries with stable `external_id` values so repeat runs skip duplicates. |

The command is idempotent:

- configuration upload is skipped when the same `content_hash` already exists for the team;
- board entries are skipped when their `external_id` is already present in the cloud board;
- local files are never removed or rewritten by the migration command.

## Prerequisites

Before migrating a real team, confirm the cloud control plane is ready:

1. D1 migrations are applied and the target team exists in the cloud environment.
2. The API Worker is reachable from your machine.
3. Tracker tokens for cloud polling are installed in Cloudflare Secrets Store; do not copy tracker secrets into local worker config.
4. At least one operator has a bearer token or migration-capable session for the API Worker.
5. Every developer who will run cloud work has or can create a `contrabass worker` enrollment from the dashboard.
6. The local project still has a valid `WORKFLOW.md`, `.contrabass/state/team/<name>/`, and `.contrabass/board/` directory.

## Dry Run

Always start with a dry run from the project root:

```sh
contrabass migrate cloud --team <name> --dry-run
```

Use `--root <path>` when running from outside the project root:

```sh
contrabass migrate cloud --team <name> --root /path/to/project --dry-run
```

The dry-run output should show:

- the loaded team name;
- the `WORKFLOW.md` path, byte size, and SHA-256 hash;
- the number of local team-state JSON files;
- the number of board issues, comments, and refresh entries;
- `no uploads performed`.

Stop and fix the local project before uploading if the team name, hash, or board counts are unexpected.

## Upload

After reviewing the dry run, upload to the API Worker:

```sh
contrabass migrate cloud \
  --team <name> \
  --api-base-url https://api.staging.contrabass.dev \
  --token "$CONTRABASS_MIGRATION_TOKEN" \
  --dry-run=false
```

The command prompts for an explicit confirmation before any upload. Type exactly:

```text
migrate <name>
```

A successful upload reports whether the config was uploaded or skipped and how many board entries were uploaded or skipped by `external_id`.

## Post-Migration Checks

After upload, verify the cloud state before asking developers to stop local-only mode:

1. Open the dashboard for the team and confirm the board entries match the dry-run counts.
2. Open configuration history and confirm the imported version has migration metadata and the expected hash.
3. Activate the imported config only after review; importing and activation are separate control-plane steps.
4. Start a worker with `contrabass worker --team <name>` after enrollment and verify it registers as `idle`.
5. Trigger a small test issue and confirm dispatch, ack, heartbeat, events, completion, and board update flow through the dashboard.

Keep the local-only runtime available during the first onboarding window. The migration is designed for dual-running until the team is comfortable with cloud coordination.

## Rollback

Rollback is operational, not destructive: stop using the cloud path and resume the local-only runtime from the unchanged local files.

1. Stop local cloud workers:

   ```sh
   # Stop any running contrabass worker processes for the team.
   pkill -f "contrabass worker --team <name>" || true
   ```

   If your team runs workers under a process manager, stop them there instead of using `pkill`.

2. Pause cloud dispatch for the team from the dashboard or operator API so no new leases are assigned while rolling back.
3. Leave migrated D1, Durable Object, R2, and Queue data intact for audit and future retry. Do not delete rows as part of routine rollback.
4. Restart the local-only runtime from the same project checkout:

   ```sh
   contrabass server --local-only
   ```

   If your binary was built without the local-only tag, rebuild the fallback binary first:

   ```sh
   make build LOCAL_ONLY=1
   ```

5. Confirm the embedded dashboard or local TUI shows the expected board from `.contrabass/board/` and `.contrabass/state/team/<name>/`.
6. If a cloud worker was executing a run during rollback, treat the local board as source of truth and requeue or close the issue manually in local-only mode.

Because migration uploads are idempotent, retrying cloud onboarding after a fix is safe. Re-run the dry run, then re-run the upload; already-present config hashes and board `external_id` values are skipped.

## Failure Handling

| Symptom | Action |
| --- | --- |
| `uploads require --api-base-url` | Add `--api-base-url` or use `--dry-run` when you only want a plan. |
| `migration upload cancelled` | Re-run and type the exact `migrate <name>` confirmation when ready. |
| Config upload returns `config_invalid` | Fix `WORKFLOW.md`, rerun `--dry-run`, then retry upload. The cloud writes nothing on validation failure. |
| Board refresh partially fails | Inspect the API error, then retry the command. Entries already accepted by `external_id` are skipped. |
| Worker cannot enroll or register | Keep local-only mode running and resolve dashboard enrollment or worker protocol compatibility before switching users. |
| Dashboard/API version skew appears | Reload the dashboard or wait for matching API and Pages deployments before continuing migration checks. |

## Data Ownership Notes

- Cloud coordination state includes board rows, config versions, run summaries, event archives, and artifact references.
- Developer worktrees, git credentials, model credentials, agent configuration, and source code remain on developer machines.
- Tracker polling secrets live only in Cloudflare Secrets Store and are bound only to the tracker poller Worker.
- The local `.contrabass/` directory remains the rollback source of truth until the team intentionally retires local-only operation.
