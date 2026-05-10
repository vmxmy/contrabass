# Worker Protocol v1

## Scope

This document freezes the invariants for worker-protocol v1, the wire contract between the Cloudflare control plane and any worker implementation. In Phase 1 the worker is the local `contrabass worker` daemon; in Phase 2 container workers must reuse the same v1 contract without changing frame shapes.

Authoritative schema and fixture locations:

- Schemas: `cloud/schemas/worker-protocol-v1/`
- Go types: `internal/workerproto/v1/`
- TypeScript types: `cloud/src/workerproto/v1/`
- Golden fixtures: `testdata/workerproto/v1/`
- OpenSpec source: `openspec/changes/cloud-orchestrator-with-local-workers/specs/worker-protocol/spec.md`

## Protocol Identity

- Every request body, response body, structured error body, and WebSocket frame includes `protocol_version: "1.0.0"`.
- `POST /v1/workers/register` includes `supported_protocol_versions`; the cloud selects `1.0.0` or rejects registration with `409 protocol_version_unsupported`.
- v1 payload object shapes are immutable after the OpenSpec change is archived. Backward-incompatible changes require a new schema directory and API contract, such as `worker-protocol-v2/`.
- Domain payload fields use lower camel case, for example `teamId`, `workerId`, `runId`, `leaseSec`, and `configHash`.
- Version-negotiation metadata uses snake case, currently `protocol_version` and `supported_protocol_versions`.

## Transport Invariants

| Flow | Transport | Direction | Invariant |
| --- | --- | --- | --- |
| Register | `POST /v1/workers/register` JSON | worker to cloud | Establishes a short-lived session token, refresh token, dispatch channel, heartbeat cadence, lease duration, and selected protocol version. |
| Refresh | `POST /v1/workers/refresh` JSON | worker to cloud | Rotates the short-lived session token without re-enrollment while the refresh token remains valid. |
| Dispatch | WebSocket text frame `dispatch` | cloud to worker | Primary work delivery path. A dispatch must include run identity, issue reference, branch, rendered prompt, config hash, lease duration, the 5-second acknowledgement requirement, and presigned artifact URLs. |
| Dispatch fallback | `GET /v1/workers/{workerId}/dispatch?wait=25s` | cloud to worker | Returns one dispatch body with the same shape as the WebSocket frame, or `204` when no work is available before timeout. |
| Ack | `POST /v1/runs/{runId}/ack` JSON | worker to cloud | Must arrive within the dispatch ack deadline, default `5` seconds, or the cloud revokes and requeues the lease. |
| Heartbeat | `POST /v1/runs/{runId}/heartbeat` JSON | worker to cloud | Extends a valid lease by the server-selected `leaseSec`; workers send at `heartbeatIntervalSec`, normally `leaseSec / 3`. |
| Events | `POST /v1/runs/{runId}/events` NDJSON | worker to cloud | Uploads bounded event batches: at most 200 events and at most 512 KiB per request. |
| Artifacts | R2 presigned `PUT` URLs | worker to R2 | Large outputs go directly to R2; the API Worker does not accept large artifacts. |
| Complete | `POST /v1/runs/{runId}/complete` JSON | worker to cloud | Terminal report for a valid lease, with summary, final config hash, status, and artifact keys. |
| Lease revocation | WebSocket text frame `lease-revoked` | cloud to worker | Tells the original worker to stop work, clean up local state, and not attempt completion. |

## State And Lease Invariants

- `IssueRun` is the single writer for an active run's lease and lifecycle. A run has at most one leaseholder at any time.
- Valid run states are `queued`, `dispatched`, `running`, `succeeded`, `failed`, and `cancelled`.
- Valid transitions are `queued -> dispatched`, `dispatched -> running`, `dispatched -> queued`, `running -> succeeded`, `running -> failed`, `running -> cancelled`, and `running -> queued` on lease revocation.
- Dispatch acquisition uses compare-and-set semantics in the run Durable Object; simultaneous dispatch attempts cannot create two successful leaseholders for one issue reference.
- The server clock is authoritative for `leaseExpiresAt`; worker clocks are diagnostic only.
- Heartbeats from non-holders or revoked holders fail with structured `409` errors such as `lease_holder_mismatch` or `lease_revoked` and do not extend the lease.
- A worker that receives `lease-revoked` must stop the agent, attempt best-effort partial artifact upload, release local worktree state, and remove the run from its in-flight set without calling `complete`.
- Terminal runs reject late events and late completions. The cloud may retain enough terminal state for 24 hours to deduplicate late traffic and count observability events.

## Payload Invariants

- Schemas use JSON Schema 2020-12 and stable `$id` values under `https://contrabass.dev/schemas/worker-protocol/v1/`.
- Wire payload objects are sealed with `additionalProperties: false`; adding a field to v1 is a protocol change, not an implementation detail.
- `configHash` is the active workflow configuration SHA-256 and is content-addressable. Workers fetch `/v1/teams/{teamId}/config/{hash}` only on cache miss.
- Dispatch `prompt` is already rendered by the cloud configuration store and must not contain secret references.
- Event uploads are newline-delimited JSON objects with `{ts, kind, payload}`. Valid v1 event kinds are `start`, `log`, `tool_call`, `diff`, `error`, and `phase`.
- Artifact URLs in dispatch are presigned for the lease window. Workers include resulting R2 object keys in `complete`; they do not inline large logs, diffs, summaries, or screenshots into event payloads.
- Structured error codes are stable snake_case strings. Endpoint-specific schemas freeze any additional structured fields, such as `supported`, `max_events`, `max_bytes`, or `max_active_workers`.

## Worker Registry And Routing Invariants

- A registered worker declares capabilities computed at startup, including supported agent runners, git availability, tmux availability, OS, architecture, worker kind, build version, and maximum concurrency.
- Worker `kind` is `local` in Phase 1 and may be `container` in Phase 2. The field exists in v1 so Phase 2 can be additive.
- The team coordinator dispatches only to workers whose status and current load allow more work and whose capabilities match the run requirements.
- If a worker receives work while at `maxConcurrency`, it rejects the dispatch with `accept: false` and a stable reason such as `at_capacity`; the run is requeued for another candidate.
- WebSocket is the preferred dispatch channel. After three consecutive WebSocket upgrade failures, a worker uses long-poll fallback and periodically retries WebSocket recovery.

## Security And Data-Boundary Invariants

- Cloud coordination state includes team config metadata, board state, run lifecycle, event summaries, artifact keys, and tracker-derived issue metadata.
- Source code, git credentials, model API keys, and agent execution remain on the worker machine in Phase 1.
- Tracker polling credentials live in Cloudflare Secrets Store and are bound only to the tracker poller Worker, not to the API Worker, Durable Objects, dashboard, or local workers.
- Refresh tokens are revocable and are stored by local workers in the OS credential store, not in plaintext project files.
- Session tokens are short-lived bearer tokens, valid for no more than one hour, and authorize both REST calls and the worker WebSocket upgrade.

## v1 Non-Goals

- No container-specific fields or sandbox attestation requirements beyond the existing `kind` and capability declarations. Container execution is Phase 2 and must remain additive or move to v2.
- No cloud-side source checkout, git credentials, deploy keys, or GitHub App code access.
- No transfer of model API keys, developer SSH keys, or local environment secrets from worker to cloud.
- No raw terminal or PTY streaming to the dashboard. v1 streams summarized NDJSON events and uploads artifacts separately.
- No bidirectional event streaming over WebSocket. Worker-to-cloud events use retryable NDJSON HTTP POSTs.
- No large artifact upload through the API Worker. Large logs, diffs, summaries, and screenshots use R2 presigned PUT URLs.
- No multi-team tenancy model beyond team-scoped routing and isolation; per-team subdomains may be added without changing v1 payloads.
- No replacement of local agent runner behavior. The local worker adapts existing `internal/agent`, `internal/workspace`, and `internal/tmux` behavior to the protocol.
- No mutation of v1 frame shapes to support dashboard-only features. Dashboard fan-out frames are separate from the worker protocol unless explicitly listed in the v1 schemas.

## Validation Expectations

Before changing v1 schemas or generated types, validate the shared contract from both runtimes:

```bash
bunx --bun ajv-cli@5 compile -s 'cloud/schemas/worker-protocol-v1/_common.json' \
  -s 'cloud/schemas/worker-protocol-v1/dispatch.json' \
  -s 'cloud/schemas/worker-protocol-v1/event-line.json' \
  -s 'cloud/schemas/worker-protocol-v1/events-request.json' \
  -s 'cloud/schemas/worker-protocol-v1/ack.json' \
  -s 'cloud/schemas/worker-protocol-v1/heartbeat.json' \
  -s 'cloud/schemas/worker-protocol-v1/complete.json' \
  -s 'cloud/schemas/worker-protocol-v1/lease-revoked.json' \
  -s 'cloud/schemas/worker-protocol-v1/register-request.json' \
  -s 'cloud/schemas/worker-protocol-v1/register-response.json' \
  -s 'cloud/schemas/worker-protocol-v1/refresh-request.json' \
  -s 'cloud/schemas/worker-protocol-v1/refresh-response.json' \
  --spec=draft2020 --strict=false

go test ./internal/workerproto/...
```

For documentation-only changes, check that this file stays consistent with the OpenSpec worker-protocol requirement and `cloud/schemas/worker-protocol-v1/README.md`.
