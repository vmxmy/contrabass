# Worker Protocol v1 — JSON Schemas

Authoritative wire-format schemas for the contrabass worker protocol.

This directory is the **source of truth** for both the cloud-side (TypeScript) and the worker-side (Go) implementations. Generated types live at:

- TypeScript: `cloud/src/workerproto/v1/` (per task 1.3)
- Go: `internal/workerproto/v1/` (per task 1.2)

The shape and field names defined here are **frozen** — see capability spec `openspec/changes/cloud-orchestrator-with-local-workers/specs/worker-protocol/spec.md` and design decision **D2** ("Worker protocol is the cross-phase contract; freeze v1 before any DO code lands").

## Scope

Schemas cover the wire payloads called out by §1 of the change tasks:

| File | Endpoint(s) | Direction |
|---|---|---|
| `register.json` | `POST /v1/workers/register` | request + response |
| `dispatch.json` | WS frame `dispatch` (and `GET /v1/workers/{id}/dispatch?wait=` long-poll body) | server → worker |
| `ack.json` | `POST /v1/runs/{runId}/ack` | request |
| `heartbeat.json` | `POST /v1/runs/{runId}/heartbeat` | request |
| `events.json` | `POST /v1/runs/{runId}/events` (one schema per NDJSON line) | request |
| `complete.json` | `POST /v1/runs/{runId}/complete` | request |
| `lease-revoked.json` | WS frame `lease-revoked` | server → worker |
| `refresh.json` | `POST /v1/workers/refresh` | request + response |
| `_common.json` | shared `$defs` (`ProtocolVersion`, `ErrorResponse`, identifiers, timestamps, …) | — |

## Conventions

- JSON Schema **2020-12** (`$schema: https://json-schema.org/draft/2020-12/schema`).
- Every schema sets a stable `$id` of the form `https://contrabass.dev/schemas/worker-protocol/v1/<file>.json` so generators can resolve `$ref` cross-file.
- Shared types live in `_common.json#/$defs/<Name>` and are referenced via `$ref`.
- Identifier shapes: `runId`, `workerId`, `teamId` are non-empty strings ≤ 255 chars; numeric quantities (`leaseSec`, `lastEventTs`, `maxConcurrency`, …) are integer-typed with explicit minimums.
- HTTP error responses are NOT covered here per-endpoint; they share `_common.json#/$defs/ErrorResponse` plus a per-endpoint `errorCode` enum embedded in the file.
- WebSocket frames carry a `type` discriminator (`dispatch`, `lease-revoked`) and `protocol_version` (mirrors REST).
- `additionalProperties: false` on every object — additions require a v2.

## Versioning rule (frozen)

Field shapes in this directory MUST NOT change in a backward-incompatible way after the parent change archives. Additive evolution is allowed only as `worker-protocol-v2/` (a new directory). See spec requirement **Versioned protocol identity** and design **D2**.

## Validation

Schemas are linted as part of task **1.4** (golden fixture set under `testdata/workerproto/v1/`). Quick local check (Bun):

```bash
bunx ajv-cli validate -s cloud/schemas/worker-protocol-v1/register.json \
  -d testdata/workerproto/v1/register/request-valid.json --strict=false --spec=draft2020
```
