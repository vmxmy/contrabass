## Context

Contrabass today is a single-host Go binary. The orchestrator loop, team coordinator, dashboard HTTP server, and tmux-based agent runners all live in one process and share one filesystem. Cross-process safety is provided by `flock(2)` on `.contrabass/state/team/<name>/*.json`, in-process pub/sub via `internal/hub`, JSONL event logs in `internal/ipc`, and `fsnotify` watching `WORKFLOW.md`. This works for one operator on one machine but blocks team collaboration: only the host sees the dashboard, only the host can claim issues, and only the host's tracker tokens are in play.

Phase 1 splits the system along the **coordination / execution** seam:

- **Coordination** (board state, claim leases, event fan-out, dashboard) moves to Cloudflare.
- **Execution** (codex/opencode CLI, git worktree, tmux) stays on developer machines.

A separate Phase 2 change will add Container-backed execution behind the same protocol. The single most important design constraint here is therefore the **worker protocol**: it must be the same wire contract for a developer laptop today and for a Cloudflare Container tomorrow.

Stakeholders: contrabass maintainers (build/operate cloud control plane), team leads (configure workflows via dashboard), individual developers (run `contrabass worker` on their laptop and watch dashboard).

## Goals / Non-Goals

**Goals:**

- Replace single-host coordination with a Cloudflare-hosted control plane (DOs, D1, R2, Queues, Cron) that multiple developers in a team share.
- Define a **versioned worker protocol** — REST + WebSocket + NDJSON events + R2 presigned uploads — that is reusable by Phase 2 Container workers without change.
- Provide a `contrabass worker` CLI that any developer can run locally to consume dispatched issues using existing `internal/agent` / `internal/workspace` / `internal/tmux` code.
- Move tracker polling and tracker secrets into the cloud (no shared API keys on laptops).
- Host the React dashboard on Cloudflare Pages, talking to the same control-plane API.
- Preserve a `--local-only` build of the existing single-host binary so offline / solo use keeps working.

**Non-Goals:**

- Container-based agent execution (Phase 2).
- Source code, git credentials, or model API keys leaving developer machines (Phase 1 explicit non-goal).
- Multi-team tenancy beyond per-team subdomain isolation.
- Real-time terminal streaming of agent stdout to the dashboard (stream summarized events, not raw PTY).
- Replacing the Bubble Tea TUI (it becomes a thin client; full replacement is out of scope).
- Migrating commit / PR / GitHub-App workflows that today live entirely in `internal/agent` runners.

## Decisions

### D1. One Durable Object per team for coordination, one per active issue for run lifecycle

**Decision**: `TeamCoordinator` DO keyed by `idFromName(teamId)` holds the task board, worker registry, and dashboard fan-out. `IssueRun` DO keyed by `idFromName(teamId + ":" + issueRef)` holds claim lease, heartbeat alarm, and run state machine.

**Rationale**: DOs are single-writer per ID, which is exactly what `flock.go` provided locally. Splitting team-level vs issue-level reduces contention: high-frequency dispatch traffic hits a small `IssueRun`, the team DO sees only board mutations.

**Alternatives considered**:
- *Single DO per team holding everything*: simple but serializes every heartbeat behind board reads. Rejected.
- *D1 with optimistic locking*: doesn't compose well with WS fan-out and alarms. Rejected.
- *Workflows as the issue lifecycle*: considered but Workflows are step-oriented, not event-driven, and don't expose alarms/WS naturally. Workflows may be added later for explicit plan→exec→verify pipelines, but the lifecycle-state owner must be a DO.

### D2. Worker protocol is the cross-phase contract; freeze v1 before any DO code lands

**Decision**: Define `worker-protocol` v1 as a versioned spec (REST + WS frame schemas + NDJSON event schema + R2 PUT contract) and treat it as immutable. Phase 2 Container workers register against the same `/v1/workers/register` endpoint and speak the same dispatch frames.

**Rationale**: If the protocol shifts between phases, we rewrite both sides. Freezing it early lets cloud and worker teams move in parallel and keeps Container support a pure additive change.

**Alternatives considered**:
- *Direct gRPC*: introduces protobuf toolchain on both sides, extra Worker complexity for streaming, and limited browser tooling. Rejected.
- *Polling-only (no WebSocket)*: simpler but high dispatch latency (5–30s); poor UX for "claim and run now" interactions. Rejected.
- *Push everything over WS, including artifact upload*: WS over Workers has size/time limits; large logs would force chunking. Use WS for control + small events, R2 presigned PUT for artifacts. Accepted.

### D3. NDJSON event upload over HTTP POST, not WS push

**Decision**: Worker pushes agent events as NDJSON (one JSON object per line) via `POST /v1/runs/{runId}/events`. Dispatch and lease-revocation come down over WS. Heartbeats are tiny POSTs.

**Rationale**:
- NDJSON POST is trivially retryable and survives proxy timeouts.
- Avoids backpressure entanglement between event ingestion and dispatch latency.
- Workers' NDJSON parsing is built-in and cheap.

**Alternatives considered**:
- *WS-only bidirectional*: harder to retry, harder to debug with curl. Rejected.
- *gRPC bidi stream*: see D2. Rejected.

### D4. Heartbeats drive lease enforcement via DO alarms; no orphan-recovery sweep

**Decision**: `IssueRun` DO sets an alarm at `lease_expires_at`. Heartbeat extends the alarm. If alarm fires before heartbeat, lease is revoked, dispatch is requeued, and a `lease-revoked` WS frame is sent to the original worker.

**Rationale**: Replaces the local `internal/orchestrator/orphan_recovery` poll loop with a precise, event-driven mechanism. No dead-claim sweep needed; the alarm is the sweep.

**Alternatives considered**:
- *Periodic Cron-triggered scan*: works but wastes invocations and is imprecise. Rejected.
- *Worker-side TTL only*: cloud wouldn't know when to free the slot. Rejected.

### D5. Configuration moves from `WORKFLOW.md` + `fsnotify` to D1 rows + WS push

**Decision**: Workflow config is rows in D1, edited via dashboard or `contrabass config push <file>`. Each version has a content hash. Dispatch frames carry the active hash; workers fetch fresh config from `GET /v1/teams/{teamId}/config/{hash}` on cache miss.

**Rationale**: There is no shared filesystem in the cloud; `fsnotify` is moot. Hash-based distribution lets workers cache, lets dashboards diff versions, and makes audit trivial.

**Alternatives considered**:
- *Keep `WORKFLOW.md` in a git repo cloud-side*: introduces a git provider dependency in the control plane. Rejected for Phase 1.
- *Push full config in every dispatch*: bloats dispatch frames and re-encodes secrets references. Rejected.

### D6. Tracker secrets only in cloud; agent / git / model secrets only on developer machines

**Decision**: Linear / GitHub PATs used for **issue polling** live in Cloudflare Secrets Store, bound to the tracker poller Worker. Model API keys, GitHub app credentials, git credentials used for **code work** stay on developer machines and are read by `contrabass worker` from the local environment.

**Rationale**: Preserves the explicit Phase 1 non-goal "source code never leaves developer machines." Cloud only needs tracker access (read/write issues) — it does not need code or model credentials.

**Alternatives considered**:
- *All secrets in cloud, push to worker on dispatch*: violates the non-goal and creates a high-value target. Rejected.
- *Secrets stay local even for tracker polling*: requires a developer to be online for tracker polling to work. Rejected — tracker polling must run 24/7.

### D7. Dashboard ships from Cloudflare Pages, not embedded in the Go binary

**Decision**: `packages/dashboard` is built and deployed to Pages. The Go binary's `embed_dashboard.go` is kept but only used by `--local-only` builds.

**Rationale**: Decouples dashboard release cadence from Go binary releases; Pages handles CDN + previews.

**Alternatives considered**:
- *Serve SPA from API Worker via Static Assets binding*: viable but Pages gives PR previews and a simpler deploy story. Pages chosen.
- *Always embed in binary*: forces a Go release for every dashboard fix. Rejected.

### D8. Keep Go packages in-tree; gate single-host runtime behind a build tag

**Decision**: `internal/team`, `internal/orchestrator`, `internal/hub`, `internal/web`, `internal/ipc` stay in the repo and compile only with `-tags localonly`. `cmd/contrabass server` requires the tag; `cmd/contrabass worker` does not.

**Rationale**: Avoids a destructive deletion before cloud parity is proven. Lets us keep CI green for offline mode while iterating on cloud.

**Alternatives considered**:
- *Delete legacy packages immediately*: high-risk, removes the fallback path. Rejected.
- *Keep both runtimes always compiled*: `internal/web` + `internal/team` increase the worker binary size and reachable code surface unnecessarily. Rejected.

### D9. Cloud-side Internal Board is a D1 table, not files

**Decision**: The local file-based `.contrabass/board/` format (`docs/local-board.md`) is preserved as an export format only. Cloud-hosted Internal Board is rows in D1 with the same schema fields.

**Rationale**: D1 gives transactional updates and indexed queries; files do not. The export remains for offline edit / debug.

## Risks / Trade-offs

- **Worker-protocol lock-in** → Mitigation: ship a `protocol_version` field in every frame; require workers to send their supported versions on register; cloud refuses incompatible workers with a clear error. Reserve `Vary: Worker-Protocol-Version` semantics for the REST surface.
- **DO hot-spot for very active teams** → Mitigation: keep dispatch traffic on `IssueRun` DOs (sharded by issue), reserve `TeamCoordinator` for board-level ops; if team-level write rate becomes a problem, shard by `(teamId, weekday-bucket)` for the registry. Defer until measured.
- **WebSocket reliability across NAT / corporate proxies** → Mitigation: long-poll fallback in the worker (`GET /v1/workers/{workerId}/dispatch?wait=25s`) when WS handshake fails 3× in a row.
- **NDJSON event ingest amplification** → Mitigation: server enforces `max_events_per_post=200` and `max_post_size=512KB`. Larger artifacts must go to R2.
- **Lease/heartbeat clock drift** → Mitigation: leases use cloud-side wall clock; workers send heartbeats at `lease_sec / 3` cadence so two missed heartbeats still leave one safety margin.
- **Migration risk for existing local users** → Mitigation: ship the migration tool first (read-only export), require users to opt in to cloud onboarding, keep `--local-only` working through Phase 1.
- **Cost surprise** → Mitigation: per-team usage caps (max active workers, max events/day) enforced at API Worker layer; document expected DO + R2 + D1 usage in onboarding.
- **Tracker token theft if Secrets Store is misconfigured** → Mitigation: rotate-on-deploy CI step, principle-of-least-privilege scopes (Linear: write issues + comments only; GitHub: issues + repo metadata, no code), audit log to R2.
- **Dashboard SPA / API Worker version skew** → Mitigation: API Worker emits `X-Contrabass-Api-Version`; SPA refuses to talk to incompatible majors and prompts reload.
- **Phase 2 protocol-evolution pressure** → Mitigation: protocol spec carries a non-goals section listing what v1 deliberately omits (artifact streaming, code transfer, sandbox attestation) so Phase 2 changes are additive (`v2`) rather than mutating `v1`.

## Migration Plan

This is a stand-up migration, not an in-place mutation. Existing local users keep working until they choose to onboard.

**Step 0 — Freeze worker-protocol v1.** Land `worker-protocol` spec, generate JSON Schemas under `cloud/schemas/` and `internal/workerproto/` (Go). No runtime changes.

**Step 1 — Cloud control plane (no users).** Stand up API Worker + `TeamCoordinator` + `IssueRun` + D1 schema + R2 buckets + Cron tracker poller, behind a feature flag. Seed with a synthetic team. Smoke tests run via a mock worker.

**Step 2 — `contrabass worker` daemon.** Implement the new subcommand against worker-protocol v1. Reuses `internal/agent`, `internal/workspace`, `internal/tmux` unchanged. Targets the synthetic team in step 1 for end-to-end validation.

**Step 3 — Dashboard on Pages.** Point `packages/dashboard` build at the API Worker base URL via env. Deploy to a `dev.contrabass.dev` Pages project.

**Step 4 — Migration tool.** `contrabass migrate cloud --team <name>` reads `.contrabass/state/team/<name>/*.json` + `WORKFLOW.md` + `.contrabass/board/`, calls cloud APIs to seed config + board + open issues. Idempotent; does not delete local files.

**Step 5 — Opt-in onboarding.** First real team onboards. `--local-only` build remains the default for everyone else. Run dual for ≥ 2 weeks.

**Step 6 — Default flip.** New `contrabass init` defaults to cloud mode. `--local-only` is retained as a supported but secondary path.

**Rollback**: If any step fails, the local-only binary keeps running because it never depended on cloud. Revert is "stop running `contrabass worker`, resume `contrabass server --local-only`." The migration tool's idempotency means re-running after a fix is safe.

## Open Questions

- **Q1.** Is `<team>.contrabass.dev` the right tenant boundary, or should we ship a self-hostable wrangler config first and add the SaaS subdomain later? Affects DNS, Pages project structure, and onboarding.
- **Q2.** Do we want Workflows to drive plan→exec→verify within `IssueRun` from day one, or just a state machine in DO storage? Workflows give durable retries but add a step-execution model the team hasn't used.
- **Q3.** WebSocket Hibernation API vs raw WS for `TeamCoordinator` dashboard fan-out — Hibernation is cheaper for many idle dashboards but has stricter handler shape. Default to Hibernation unless we hit limits.
- **Q4.** Worker enrollment: one-time code from dashboard vs OIDC (e.g., GitHub OAuth) — one-time code is simpler for Phase 1 but OIDC is cleaner for team membership reuse. Defer the choice to enrollment-flow design.
- **Q5.** Do we let `contrabass worker` run inside CI environments (ephemeral runners), or restrict to long-lived dev machines? Allowing CI complicates lease semantics (workers vanish without notice); restricting it limits use cases. Lean toward "allowed, with `--ephemeral` flag that uses shorter leases."
