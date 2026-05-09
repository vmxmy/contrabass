# Ergonomics Follow-up Issues

This document tracks ergonomics feedback gathered during the phase-1 cloud onboarding (epic 17).
All issues listed here are **implementation-level improvements only** — none require changes to
worker-protocol v1. Wire shapes defined in `cloud/schemas/worker-protocol-v1/` and documented
in `docs/worker-protocol.md` are frozen; any protocol-level additions belong to v2.

File each section below as a separate GitHub issue tagged `ergonomics` + `area/cloud` (and
`area/worker` or `area/dashboard` as appropriate). Link back to this document in each issue body.

---

## Feedback collection template (used during 17.1 dual-run period)

Ask every developer running `contrabass worker` against staging to answer these after their
first two weeks:

1. Where did you get stuck during enrollment? (one-time code, OS keychain, `worker login` UX)
2. Did you ever see a run stop unexpectedly without a clear reason?
3. Did you ever hit the 200-event or 512 KB per-request limit? What happened?
4. Did the config push → activate two-step flow make sense on first use?
5. Did the migration tool (`contrabass migrate cloud`) behave as expected?
6. Any confusing dashboard states or misleading error messages?

Collect answers in a shared doc and map each friction point to one of the issues below, or open
a new issue if it doesn't fit.

---

## Issue 1 — Worker enrollment: one-time code discovery

**Labels**: `ergonomics`, `area/worker`, `area/dashboard`

**Summary**: The `contrabass worker login` flow requires a one-time code from the dashboard, but
the current dashboard spec (task 11.5) does not call out where the code appears or how long it
is valid. Developers attempting enrollment for the first time have to search the dashboard for
the code. The code also expires, but no countdown is shown.

**Proposed fix**:
- Add a dedicated "Enroll worker" page / modal in the dashboard that displays the code
  prominently with a countdown timer.
- Make `contrabass worker login` print a direct URL to the enrollment page on startup.
- Document the expected flow in `docs/worker-enroll.md`.

**Not a v1 change**: enrollment is an out-of-band step; no protocol frame carries the one-time
code.

---

## Issue 2 — OS credential store: locked keyring gives no actionable error

**Labels**: `ergonomics`, `area/worker`

**Summary**: Task 12.3 wires the OS credential store via `99designs/keyring`. On Linux, if the
user session keyring (libsecret / GNOME Keyring) is locked (common in headless SSH sessions),
`contrabass worker` silently fails to load the refresh token and falls through to re-enrollment.
The error message does not explain how to unlock the keyring or use a fallback.

**Proposed fix**:
- Distinguish "keyring locked" from "no credential stored" and print a specific message with
  remediation steps for each OS.
- Support a `CONTRABASS_WORKER_TOKEN_FILE` env var as a plaintext fallback for CI / headless
  environments (with a warning that the file must be chmod 600).

**Not a v1 change**: credential storage is entirely local to the worker.

---

## Issue 3 — Ack 5-second deadline is too tight on slow machines under load

**Labels**: `ergonomics`, `area/worker`

**Summary**: The protocol requires `POST /v1/runs/{runId}/ack` within 5 seconds of the dispatch
frame. On a machine under heavy load (large compile job, antivirus scan, aggressive swap), the
worker can receive the dispatch frame but fail to fork the agent and post the ack in time, causing
the run to be requeued unnecessarily.

**Observed during dual-run**: one developer on macOS with 8 GB RAM reported two spurious
requeues in the first week because of a background Time Machine backup running at dispatch time.

**Proposed fix (implementation-only)**:
- In `cmd/contrabass/worker.go`, add a fast path that sends `{accept: true}` immediately on
  dispatch receipt and starts agent provisioning asynchronously. The ack does not need the agent
  to be running; it only signals intent.
- Add a `--ack-timeout-ms` flag (default 4800) with a warning if the value is above the server's
  deadline. This does not change the server's 5-second enforcement; it just gives operators
  visibility into the configured local budget.

**Not a v1 change**: the `ack` schema and 5-second enforcement are frozen. The fix is in the
worker's local sequencing.

---

## Issue 4 — `lease-revoked` produces no user-visible feedback in the terminal

**Labels**: `ergonomics`, `area/worker`

**Summary**: When the cloud sends a `lease-revoked` frame, the worker stops the agent. From the
developer's perspective the running terminal pane just exits, sometimes mid-output, with no
indication of why. The worker logs the revocation at DEBUG level but does not surface it to the
foreground terminal.

**Proposed fix**:
- In `cmd/contrabass/worker.go`, print a clearly formatted message to stderr when a
  `lease-revoked` frame arrives, including the `reason` field from the frame (e.g.
  `heartbeat_timeout`, `manual_reassign`).
- If the worker is running inside a tmux pane, use `tmux display-message` to show the revocation
  reason in the status bar.

**Not a v1 change**: `lease-revoked` frame shape is frozen. The fix is in the worker's display
layer.

---

## Issue 5 — Long-poll fallback activates silently; developers don't know WS failed

**Labels**: `ergonomics`, `area/worker`

**Summary**: After 3 consecutive WebSocket upgrade failures the worker switches to long-poll
(task 12.5), but the transition is logged at INFO and not shown in the foreground terminal.
Developers behind corporate proxies who are already frustrated by WS failures see no output
and assume the worker has hung.

**Proposed fix**:
- Print a warning banner when falling back to long-poll mode, including the proxy-detection
  heuristic that triggered the switch (e.g. "WebSocket upgrade returned 403 — using long-poll
  fallback").
- Add a `--force-long-poll` flag for teams that know they are behind a WS-blocking proxy, so the
  first-run experience is not three silent failures.

**Not a v1 change**: the long-poll endpoint and payload shape are frozen. The fix is in startup
UX.

---

## Issue 6 — Config push → activate two-step flow is confusing on first use

**Labels**: `ergonomics`, `area/dashboard`, `area/worker`

**Summary**: `contrabass config push` uploads a config version (task 9.1 / 9.6) but does not
activate it. A separate step in the dashboard (or via the API) is required to call
`POST /v1/teams/{teamId}/config/{version}/activate`. First-time users push the config, see "upload
successful", and then wonder why their workers are still using the old config.

**Proposed fix**:
- Add an `--activate` flag to `contrabass config push` that immediately calls the activate
  endpoint after a successful upload. Default is off (current safe behaviour).
- Update the dashboard config history view to show an "Activate" button next to unactivated
  versions with a tooltip explaining that workers fetch config on next dispatch.
- Add a note to `docs/cloud-migration.md` under "Post-Migration Checks" step 3 that activation
  is manual by default.

**Not a v1 change**: the activate endpoint URL and payload are not part of the worker-protocol
schema set.

---

## Issue 7 — Config hash is opaque in worker output; no easy mapping to a human version

**Labels**: `ergonomics`, `area/worker`, `area/dashboard`

**Summary**: Dispatch frames carry `configHash` (a SHA-256). Workers log the hash at startup but
the log line is not surfaced to the tmux pane. After a run, developers cannot easily tell which
config version their run used without opening the dashboard and searching by hash.

**Proposed fix**:
- In the dispatch consumer, print the first 8 characters of `configHash` and, if available, the
  version label from the local cache entry (fetched via `GET /v1/teams/{teamId}/config/{hash}`)
  when the run begins.
- Add a `version_label` field to the config GET response (without touching protocol schemas)
  so workers can show a human-readable identifier alongside the hash.

**Not a v1 change**: the `configHash` field in the dispatch frame is frozen. The worker is free
to fetch additional metadata from the config store endpoint and display it locally.

---

## Issue 8 — Presigned R2 URLs may expire when a run greatly exceeds the original lease

**Labels**: `ergonomics`, `area/worker`, `area/cloud`

**Summary**: Dispatch frames include presigned R2 PUT URLs valid for the lease window (task 4.3).
Heartbeats extend the logical lease, but they do not refresh the presigned URLs. A run that runs
for several heartbeat cycles could receive URLs that have already expired, causing the artifact
upload at completion to fail silently.

**Observed during dual-run**: a 45-minute codex run (lease originally 10 minutes, extended 4×)
failed to upload its log artifact; the API responded with `403 Request has expired`.

**Proposed fix (implementation-only)**:
- In `IssueRun` DO, on each heartbeat that extends the lease by more than 50% of the remaining
  URL validity window, generate fresh presigned URLs and include them in the heartbeat `200`
  response body as an optional `refreshedArtifactUploadURLs` object.
- In `cmd/contrabass/worker.go`, check for `refreshedArtifactUploadURLs` in each heartbeat
  response and replace the in-memory URL map when present.

**Not a v1 change**: the heartbeat request schema is frozen, but the heartbeat *response* is not
fully specified by a sealed schema. Adding an optional response field is an additive server-side
change. If the heartbeat response is later sealed in v1, this becomes a v2 item.

---

## Issue 9 — Event-limit errors lack actionable guidance for verbose agents

**Labels**: `ergonomics`, `area/worker`

**Summary**: When an agent produces more than 200 events or 512 KB of events in one batch, the
server returns `413 events_too_large`. The error body includes `max_events` and `max_bytes` but
does not tell the worker which event(s) caused the overflow, making it hard to debug which
tool_call or log was oversized.

**Proposed fix**:
- In the event batching adapter (task 12.8), split batches proactively before hitting the limit
  rather than relying on server rejection. The adapter should maintain a running byte count and
  flush when either the count or event limit is approached.
- Improve the worker's retry log to include "batch N of M" so operators can see batching in
  action.
- Add an integration test for the oversized-batch path to `internal/workerproto/...`.

**Not a v1 change**: the 413 error schema is frozen. The fix is in the client's batching
strategy.

---

## Issue 10 — Migration token creation flow is undocumented

**Labels**: `ergonomics`, `area/cloud`, `docs`

**Summary**: `docs/cloud-migration.md` says `--token "$CONTRABASS_MIGRATION_TOKEN"` is required
for upload but does not explain how an operator obtains this token. The bearer token or
migration-capable session referenced in the prerequisites section has no creation flow documented.

**Proposed fix**:
- Add a "Obtain a migration token" section to `docs/cloud-migration.md` covering:
  - How to generate an operator token from the dashboard.
  - How to set `CONTRABASS_MIGRATION_TOKEN` in the shell for the migration run.
  - Token expiry and revocation.
- Add `make cloud-migration-token` or document `wrangler` CLI steps if the token is generated
  via Wrangler.

**Not a v1 change**: token issuance is not a worker-protocol concern.

---

## Issue 11 — `migrate <name>` confirmation phrase is easy to typo; no `--yes` flag for scripting

**Labels**: `ergonomics`, `area/worker`

**Summary**: The migration command requires typing `migrate <name>` exactly. Teams scripting
their migration in CI (e.g. as part of an onboarding automation) cannot pass `--yes` or pipe
confirmation. The only option is `--dry-run`, which does not upload.

**Proposed fix**:
- Add a `--confirm` flag that bypasses the interactive prompt, intended for non-interactive CI
  environments. Document that `--confirm` should be used with `--dry-run=false` explicitly to
  prevent accidental runs.
- Keep the interactive prompt as the default for human operators.

**Not a v1 change**: this is a CLI UX change only.

---

## Issue 12 — Dashboard version-skew banner fires on patch version difference

**Labels**: `ergonomics`, `area/dashboard`

**Summary**: The SPA reads `X-Contrabass-Api-Version` and shows a reload banner when versions
differ (task 11.6, task 8.7). The current spec says "incompatible majors", but the initial
implementation may trigger the banner on any version difference (including a patch release to
the API Worker while the dashboard is still on a CDN cache). Developers see the banner
unexpectedly and think something is broken.

**Proposed fix**:
- Implement the banner only for major version mismatches. Minor and patch differences should
  be logged to the browser console but not shown to the user.
- Document the `X-Contrabass-Api-Version` format and comparison semantics in a short ADR or
  comment in the SPA version-check module.

**Not a v1 change**: the `X-Contrabass-Api-Version` header is not part of the worker protocol
schemas. It is a dashboard-facing header defined in task 8.7.

---

## Issue 13 — Workers have no user-visible friendly name; operators cannot identify machines in the dashboard

**Labels**: `ergonomics`, `area/worker`, `area/dashboard`

**Summary**: `workerId` is auto-generated at registration (a UUID or similar). The dashboard
worker-status panel shows the raw ID. When a team has four developers all running
`contrabass worker`, operators cannot tell at a glance which entry corresponds to which machine.

**Proposed fix**:
- Add a `--name` flag to `contrabass worker` that is sent as an extra registration field
  (`workerName`) stored in the `worker_enrollments` D1 table. The dashboard displays this name
  alongside the worker ID.
- Fall back to `$USER@$(hostname)` when `--name` is not given.
- Store the chosen name in the OS credential store alongside the refresh token so it is
  consistent across restarts.

**Not a v1 change**: `workerName` is an additive field in the `worker_enrollments` D1 table
and a non-v1 display field. It must NOT be added to any sealed v1 schema
(`register-request.json`, etc.); it can be passed as an extra query param or a header that
the API Worker stores out-of-band.

---

## Protocol v1 freeze reminder

The following are **intentionally deferred to v2** and must not be implemented as v1 changes:

| Idea raised during feedback | Why it is a v2 item |
| --- | --- |
| Add `workerName` to `register-request.json` | Would mutate a sealed schema |
| Carry refreshed presigned URLs in the `heartbeat` v1 request body | Heartbeat request schema is sealed |
| Add a `batch_id` field to events for client-side dedup | Event-line schema is sealed |
| Push config activation status in the `dispatch` frame | Dispatch schema is sealed |
| Add `ack_deadline_ms` to the dispatch frame so the cloud can communicate its actual threshold | Dispatch schema is sealed |

Any of the above that the team decides to pursue must go through the full OpenSpec change process
for `worker-protocol-v2/` and cannot be retrofitted into `cloud/schemas/worker-protocol-v1/`.
