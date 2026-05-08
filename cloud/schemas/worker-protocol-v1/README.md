# Worker Protocol v1 — JSON Schemas

Authoritative wire-format schemas for the contrabass worker protocol.

This directory is the **source of truth** for both the cloud-side (TypeScript) and the worker-side (Go) implementations. Generated types live at:

- TypeScript: `cloud/src/workerproto/v1/` (per task 1.3)
- Go: `internal/workerproto/v1/` (per task 1.2)

The shape and field names defined here are **frozen** — see capability spec `openspec/changes/cloud-orchestrator-with-local-workers/specs/worker-protocol/spec.md` and design decision **D2** ("Worker protocol is the cross-phase contract; freeze v1 before any DO code lands").

## Files

| File | Endpoint(s) | Direction |
|---|---|---|
| `_common.json` | shared `$defs` (`ProtocolVersion`, identifiers, `ConfigHash`, `GitBranch`, `ErrorResponseBase`, …) | — |
| `register-request.json` | `POST /v1/workers/register` | request |
| `register-response.json` | `POST /v1/workers/register` (success + per-error `$defs`) | response |
| `refresh-request.json` | `POST /v1/workers/refresh` | request |
| `refresh-response.json` | `POST /v1/workers/refresh` (success + per-error `$defs`) | response |
| `dispatch.json` | WS frame `dispatch` (and long-poll body) | server → worker |
| `ack.json` | `POST /v1/runs/{runId}/ack` (Accept ∪ Reject `oneOf`; per-error `$defs`) | request |
| `heartbeat.json` | `POST /v1/runs/{runId}/heartbeat` (per-error `$defs`) | request |
| `event-line.json` | one NDJSON line of `POST /v1/runs/{runId}/events` (per-`kind` `oneOf`) | request line |
| `events-request.json` | logical decoded batch for tests/fixtures (`maxItems: 200`) + per-error `$defs` | request envelope |
| `complete.json` | `POST /v1/runs/{runId}/complete` (`status`-discriminated `oneOf`: Succeeded ∪ Failed ∪ Cancelled) | request |
| `lease-revoked.json` | WS frame `lease-revoked` | server → worker |

## Conventions

- **JSON Schema 2020-12** (`$schema: https://json-schema.org/draft/2020-12/schema`).
- Every schema sets a stable `$id` of the form `https://contrabass.dev/schemas/worker-protocol/v1/<file>.json` so generators can resolve `$ref` cross-file.
- Shared types live in `_common.json#/$defs/<Name>` and are referenced via `$ref`.
- **Discriminated `oneOf`** is preferred over `if/then` for codegen friendliness:
  - `ack.json` discriminates on `accept` (true|false).
  - `complete.json` discriminates on `status` (succeeded|failed|cancelled).
  - `event-line.json` discriminates on `kind` (start|log|tool_call|diff|error|phase).
- **Error response shapes** are defined per-endpoint as `$defs` inside the response file (or, for request-only endpoints, inside the request file). They use `additionalProperties: false` and freeze the structured fields the spec calls out (e.g., `events_too_large` carries `max_events: 200, max_bytes: 524288`). The generic `_common.json#/$defs/ErrorResponseBase` exists only as documentation of the shared envelope and uses `additionalProperties: true`.
- `additionalProperties: false` on every wire-payload object — additions require a v2.
- **`event-line.json` payload shapes** are sealed per-`kind` in the schema itself; downstream agents do NOT need to consult external TS files for payload structure.

## Field-naming rule

- Domain payload fields: **lowerCamelCase** (`teamId`, `workerId`, `runId`, `leaseSec`, `configHash`, `lastEventTs`, `artifactUploadURLs`, …).
- Protocol-negotiation metadata: **snake_case** (`protocol_version`, `supported_protocol_versions`).

This split is intentional: the snake_case fields participate in cross-language version-negotiation handshakes where the casing is the wire literal; the camelCase fields are domain payloads where Go/TS struct conventions match naturally. Codegen MUST honor both.

## Versioning rule (frozen)

Field shapes in this directory MUST NOT change in a backward-incompatible way after the parent change archives. Additive evolution is allowed only as `worker-protocol-v2/` (a new directory). See spec requirement **Versioned protocol identity** and design **D2**.

## Validation

Quick local check (Bun + ajv-cli):

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
```

Golden fixtures (per task **1.4**) live under `testdata/workerproto/v1/<endpoint>/` and are exercised by both Go and TS test suites.
