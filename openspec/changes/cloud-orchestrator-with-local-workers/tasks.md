## 1. Worker protocol freeze (do first; cross-phase contract)

- [x] 1.1 Create `cloud/schemas/worker-protocol-v1/` with JSON Schema files for register/dispatch/ack/heartbeat/events/complete/lease-revoked/refresh payloads
- [x] 1.2 Generate Go types from those schemas under `internal/workerproto/v1/` and add `go generate` step
- [x] 1.3 Generate TypeScript types from the same schemas under `cloud/src/workerproto/v1/` and wire into the cloud package's `tsconfig`
- [x] 1.4 Add a contract-test fixture set (golden JSON for every frame) under `testdata/workerproto/v1/` consumed by both Go and TS test suites
- [x] 1.5 Add `protocol_version` field to every frame schema and lock value to `1.0.0`
- [x] 1.6 Document protocol invariants and v1 non-goals in `docs/worker-protocol.md`

## 2. Cloud project scaffold

- [x] 2.1 Create `cloud/` directory with `wrangler.toml`, `package.json`, `tsconfig.json`, Vitest setup
- [x] 2.2 Add `cloud/` to root `package.json` workspaces and Bun lockfile
- [x] 2.3 Add `make cloud-build`, `make cloud-deploy`, `make cloud-deploy-dry`, `make cloud-test` targets
- [x] 2.4 Add CI lane: build cloud + `wrangler deploy --dry-run` on PRs touching `cloud/**` or `cloud/schemas/**`
- [x] 2.5 Set up two Wrangler environments: `staging` and `production`

## 3. D1 schema and bindings

- [x] 3.1 Create D1 database `contrabass-control-plane` and add binding to `wrangler.toml`
- [x] 3.2 Write migrations: `team_configs`, `team_configs_active`, `runs`, `internal_board`, `audit_log`, `worker_enrollments`
- [x] 3.3 Add D1 migration tooling (`wrangler d1 migrations`) and `make cloud-migrate`
- [x] 3.4 Write seed script for the synthetic test team used by smoke tests

## 4. R2 buckets and Queues

- [x] 4.1 Create R2 buckets: `contrabass-artifacts` (logs/diffs/screenshots), `contrabass-events-archive`
  - Evidence: `wrangler r2 bucket list` shows `contrabass-artifacts` created at `2026-05-08T21:35:17.624Z` and `contrabass-events-archive` created at `2026-05-08T21:35:18.591Z`.
- [x] 4.2 Add R2 bindings to `wrangler.toml`
- [x] 4.3 Implement R2 presigned PUT URL generation utility under `cloud/src/r2/presign.ts`
- [x] 4.4 Create `events-archive` Queue and consumer Worker that batches events into `contrabass-events-archive`
- [x] 4.5 Set Queue dead-letter policy and document recovery procedure

## 5. Secrets Store

- [x] 5.1 Create Secrets Store and document per-team secret naming convention (`tracker/{teamId}/linear`, `tracker/{teamId}/github`)
- [x] 5.2 Bind Secrets Store only to the tracker poller Worker (NOT to API Worker or DOs)
- [x] 5.3 Add `make cloud-secret-set` helper

## 6. `IssueRun` Durable Object

- [x] 6.1 Implement `IssueRun` DO class under `cloud/src/do/issue-run.ts` with state machine `queued | dispatched | running | succeeded | failed | cancelled`
- [x] 6.2 Implement lease tracking (`leaseHolder`, `leaseExpiresAt`, `leaseSec`) with DO alarms
- [x] 6.3 Implement heartbeat handler that extends lease and resets alarm
- [x] 6.4 Implement events append + forward to `TeamCoordinator` + enqueue to events Queue
- [x] 6.5 Implement CAS dispatch acquire (single-leaseholder guarantee)
- [x] 6.6 Implement `complete` handler that writes terminal record to D1 and broadcasts `run-complete`
- [x] 6.7 Implement `cancel` handler called by `TeamCoordinator`
- [x] 6.8 Implement late-event window (24h retention for terminal runs)
- [x] 6.9 Vitest coverage: state-machine transitions, alarm firing, CAS race, late events

## 7. `TeamCoordinator` Durable Object

- [x] 7.1 Implement `TeamCoordinator` DO class under `cloud/src/do/team-coordinator.ts`
- [x] 7.2 Implement worker registry (in-memory + DO storage) with `idle | busy | unhealthy` status
- [x] 7.3 Implement task board persistence and `GET /board`, `POST /board/refresh` operations
- [x] 7.4 Implement dispatch routing: capability filter + selection policy (default: prefer local over container, then least-loaded)
- [x] 7.5 Implement WebSocket Hibernation handler for `/subscribe` with `board-update`, `run-event`, `worker-status`, `config-changed` frames
- [x] 7.6 Implement event ring buffer (last 100 per team) for reconnect replay via `last_event_id`
- [x] 7.7 Implement operator actions: `reassign-run`, `cancel-run`, `pause-team`, `resume-team`
- [x] 7.8 Implement per-team usage caps (`max_active_workers`, `max_runs_per_day`, `max_events_per_day`)
- [x] 7.9 Vitest coverage: registry transitions, dispatch policy, fan-out, replay, caps

## 8. API Worker (REST + WS proxy)

- [x] 8.1 Implement `cloud/src/worker/index.ts` Hono (or itty-router) router with auth middleware
- [x] 8.2 Implement `POST /v1/workers/register`, `POST /v1/workers/refresh`, `POST /v1/workers/enroll`
- [x] 8.3 Implement `POST /v1/runs/{runId}/ack`, `/heartbeat`, `/events`, `/complete` forwarders to `IssueRun` DO
- [x] 8.4 Implement `GET /v1/workers/{workerId}/dispatch?wait=25s` long-poll fallback
- [x] 8.5 Implement `GET /v1/teams/{teamId}/board`, `POST /v1/teams/{teamId}/board/*` forwarders to `TeamCoordinator`
- [ ] 8.6 Implement WS upgrade for `/v1/teams/{teamId}/subscribe` (dashboard) and `/v1/workers/{workerId}/dispatch-ws` (worker)
- [ ] 8.7 Add `X-Contrabass-Api-Version` response header on every response
- [ ] 8.8 Add structured error responses with `error` codes matching the protocol spec
- [ ] 8.9 Vitest coverage: auth, routing, error mapping, version header

## 9. Cloud config store

- [ ] 9.1 Implement `POST /v1/teams/{teamId}/config` with parser ported from `internal/config` (re-implemented in TS or via WASM port — start with TS reimplementation)
- [ ] 9.2 Implement `GET /v1/teams/{teamId}/config/{hash}` (immutable, cacheable)
- [ ] 9.3 Implement `POST /v1/teams/{teamId}/config/{version}/activate` updating `team_configs_active`
- [ ] 9.4 Implement Liquid prompt rendering with secret-reference rejection
- [ ] 9.5 Implement diff endpoint `GET /v1/teams/{teamId}/config/diff?from=v1&to=v2`
- [ ] 9.6 Add `contrabass config push` and `contrabass config import-md` CLI subcommands in Go
- [ ] 9.7 Vitest coverage: parser parity vs Go (shared fixtures), hash determinism, secret rejection

## 10. Cloud tracker poller

- [ ] 10.1 Add Cron Trigger (every 1 minute) and `cloud/src/poller/index.ts` entry point
- [ ] 10.2 Implement Linear adapter under `cloud/src/poller/linear.ts` (port logic from `internal/tracker/linear`)
- [ ] 10.3 Implement GitHub Issues adapter under `cloud/src/poller/github.ts`
- [ ] 10.4 Implement Internal Board (D1) adapter under `cloud/src/poller/internal-board.ts`
- [ ] 10.5 Implement per-team error isolation and `Retry-After` handling
- [ ] 10.6 Implement idempotent upsert by `external_id` into `TeamCoordinator`
- [ ] 10.7 Wire metrics emission to Workers Analytics Engine
- [ ] 10.8 Vitest coverage with mocked Linear/GitHub clients

## 11. Dashboard hosting

- [ ] 11.1 Create Cloudflare Pages project for `packages/dashboard`
- [ ] 11.2 Add `VITE_CONTRABASS_API_BASE` env wiring and update SPA API client
- [ ] 11.3 Implement OAuth login flow (GitHub) in API Worker; set `httpOnly` session cookie
- [ ] 11.4 Implement WS subscription with reconnect + `last_event_id` replay in SPA
- [ ] 11.5 Implement team picker, board view, run detail view, config history view, tracker health view
- [ ] 11.6 Implement SPA / API version-skew banner
- [ ] 11.7 Create Cloudflare Pages project for `packages/landing` and verify README rendering
- [ ] 11.8 Add Pages preview environment for staging API
- [ ] 11.9 Bun-test coverage for SPA components and reconnect logic

## 12. `contrabass worker` Go subcommand

- [x] 12.1 Add `cmd/contrabass/worker.go` Cobra subcommand
- [x] 12.2 Add `cmd/contrabass/worker_login.go` for one-time-code enrollment
- [x] 12.3 Add OS-credential-store integration: macOS Keychain, libsecret on Linux, Credential Manager on Windows (use `99designs/keyring` or equivalent)
- [x] 12.4 Implement registration flow with capability detection (codex/opencode/omx/omc/mock, tmux availability, OS, arch, version)
- [x] 12.5 Implement WebSocket dispatch consumer with auto-reconnect and long-poll fallback after 3 WS failures
- [x] 12.6 Implement ack handling within 5-second SLA
- [x] 12.7 Implement run executor that calls `internal/workspace.Provision`, `internal/tmux.OpenPane` (when capable), `internal/agent.Run`
- [x] 12.8 Implement event batching adapter: agent runner output → NDJSON POST batches (≤200 events, ≤512KB, ≤2s latency)
- [x] 12.9 Implement heartbeat scheduler at `leaseSec / 3` with jitter, with `progress` and `lastEventTs`
- [x] 12.10 Implement R2 presigned PUT uploader for logs/diff/screenshots
- [x] 12.11 Implement `lease-revoked` handler: SIGTERM → SIGKILL after 5s, attempt artifact upload, release worktree
- [x] 12.12 Implement config cache by hash and `GET /config/{hash}` fetch on miss
- [x] 12.13 Implement `--ephemeral` flag with shorter lease defaults for CI use
- [x] 12.14 Go test coverage with mock cloud server using shared `testdata/workerproto/v1/` fixtures

## 13. Build-tag split for legacy single-host code

- [x] 13.1 Add `//go:build localonly` to `internal/team`, `internal/orchestrator`, `internal/hub`, `internal/web`, `internal/ipc` package files
- [ ] 13.2 Move `cmd/contrabass server` and team subcommand wiring behind the `localonly` tag
- [ ] 13.3 Update `Makefile`: default `make build` excludes `localonly`; add `make build-local-only` (or `LOCAL_ONLY=1`) target
- [ ] 13.4 Update `embed_dashboard.go` to be empty unless `localonly` is set
- [ ] 13.5 Verify `make build` produces a binary with `worker` subcommand only (and that `server` reports build-tag missing)
- [ ] 13.6 Verify `make build LOCAL_ONLY=1` produces both subcommands and passes existing tests

## 14. TUI reduction to thin client

- [ ] 14.1 Add `contrabass tui` subcommand that connects to cloud API as a read-only client
- [ ] 14.2 Reuse Bubble Tea views from `internal/tui` for board / run-detail rendering, replacing local event source with WS subscription
- [ ] 14.3 Update TUI snapshot tests against cloud-event fixtures
- [ ] 14.4 Document the local-only TUI mode (build tag) for solo offline users

## 15. Migration tool

- [ ] 15.1 Implement `contrabass migrate cloud --team <name>` reading `.contrabass/state/team/<name>/*.json`, `WORKFLOW.md`, `.contrabass/board/`
- [ ] 15.2 Implement idempotent uploads: skip rows already present (by hash for config, by `external_id` for board)
- [ ] 15.3 Print a dry-run plan with `--dry-run` and require explicit confirmation without it
- [ ] 15.4 Document the migration in `docs/cloud-migration.md` with rollback instructions

## 16. End-to-end validation

- [ ] 16.1 Set up staging environment with synthetic team and run a smoke test: register mock worker → tracker poller injects a fake issue → dispatch → ack → events → complete → board updates
- [ ] 16.2 Run real-world soak: one developer runs `contrabass worker` against staging for 1 week with codex agent
- [ ] 16.3 Validate lease-revocation path by killing the worker mid-run and observing requeue
- [ ] 16.4 Validate WS reconnect with `last_event_id` replay (simulate network blip)
- [ ] 16.5 Validate long-poll fallback path by blocking WS upgrades at the proxy
- [ ] 16.6 Validate config-changed propagation across multiple connected workers and dashboards
- [ ] 16.7 Capture observability dashboards: poll latency, dispatch latency, lease-revocation rate, event ingest rate

## 17. Onboarding and rollout

- [ ] 17.1 Onboard one volunteer team to production cloud, run dual-mode (cloud + `--local-only`) for ≥ 2 weeks
- [ ] 17.2 Collect feedback, file follow-up issues for ergonomics, do not change protocol v1
- [ ] 17.3 Update `README.md` and `CLAUDE.md` with the new default workflow (`contrabass worker`, dashboard URL, migration tool)
- [ ] 17.4 Flip default `contrabass init` template from local-only to cloud
- [ ] 17.5 Mark `--local-only` as supported-but-secondary in CLI help and docs
