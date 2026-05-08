## Why

Contrabass currently runs as a single-host Go binary: orchestration loop, team coordinator, tmux workers, and dashboard all share one process and one filesystem (worktrees, `flock(2)`, JSONL event logs, `fsnotify` config). This blocks team collaboration — only the host operator sees the board, and only their machine can claim/run issues.

Phase 1 moves orchestration and the dashboard to Cloudflare so a team can share one cloud-hosted board, while each developer runs a lightweight local `contrabass worker` daemon that consumes dispatched issues and runs the agent (codex/opencode) on their own machine. Source code and agent execution stay on developer hardware; cloud holds coordination state only.

A separate Phase 2 change will add Container-backed workers behind the **same** worker protocol — so this change must define that protocol carefully, since it becomes the cross-phase contract.

## What Changes

- **NEW** Cloudflare-hosted control plane: API Worker, `TeamCoordinator` and `IssueRun` Durable Objects, D1 (configs / issue history / internal board), R2 (logs / diffs / artifacts), Queues (event archival), Cron-triggered tracker pollers.
- **NEW** `contrabass worker` CLI subcommand that registers with the cloud, long-polls / WebSocket-subscribes for dispatch, and runs agents locally via existing `internal/agent`, `internal/workspace`, `internal/tmux` code.
- **NEW** Worker protocol (REST + WS + NDJSON event upload + R2 presigned PUT) — the contract that Phase 2 Container workers will reuse unchanged.
- **NEW** Cloud-hosted dashboard on Cloudflare Pages, served from the same `packages/dashboard` SPA, talking to the API Worker.
- **MOVED** Linear / GitHub / Internal-Board polling from local Go process to a Cron-triggered Worker; tracker tokens live in Secrets Store, not local env.
- **MOVED** Configuration source of truth from `WORKFLOW.md` + `fsnotify` to D1 rows, edited via dashboard or CLI; workers receive config hash on dispatch.
- **REMOVED** (from the deployed control-plane path) `internal/team` coordinator process, `flock.go`, `internal/hub` in-process pub/sub, `internal/web` server, `internal/orchestrator` polling loop, `internal/ipc` JSONL log + file heartbeat. The Go packages stay in-tree but are no longer the production runtime; local-only single-host mode is preserved behind a build tag for offline use.
- **BREAKING** `contrabass server` (single-host all-in-one) is no longer the recommended runtime for teams. Single-host mode remains available via `contrabass server --local-only`.
- **BREAKING** Bubble Tea TUI becomes a thin client that connects to the cloud API; it no longer drives orchestration directly.

## Capabilities

### New Capabilities
- `cloud-team-coordinator`: Durable Object per team holding the shared task board, worker registry, dispatch routing, and dashboard WebSocket fan-out. Replaces in-process team coordinator + flock.
- `cloud-issue-run`: Durable Object per active issue holding lease state, heartbeat alarms, run-state machine (queued → dispatched → running → done/failed), and event log handle. Replaces local orchestrator state files + orphan recovery.
- `worker-protocol`: Versioned REST + WebSocket + NDJSON contract between cloud and any worker (local daemon today, Container tomorrow). Covers register, dispatch, ack, heartbeat, event stream, artifact upload, complete, lease revocation. **This is the cross-phase contract.**
- `local-worker-daemon`: `contrabass worker` CLI mode — login/enroll, capability registration, dispatch consumption, local agent execution, event/artifact reporting. Reuses existing `internal/agent`, `internal/workspace`, `internal/tmux`.
- `cloud-tracker-poller`: Cron-triggered Worker that polls Linear/GitHub and serves the cloud-hosted Internal Board, feeding new issues into `IssueRun` DOs. Replaces local `internal/tracker` polling path.
- `cloud-config-store`: D1-backed team/workflow configuration with versioned hashes, edited via dashboard/CLI, distributed to workers on dispatch. Replaces `WORKFLOW.md` + `fsnotify`.
- `cloud-dashboard-hosting`: Cloudflare Pages deployment of `packages/dashboard` and `packages/landing`, with API Worker as backend; replaces `embed.FS` static-asset shipping inside the Go binary.

### Modified Capabilities
<!-- None — no pre-existing capability specs in openspec/specs/ at the time of this proposal (all prior specs are archived). -->

## Impact

- **Code**:
  - New top-level `cloud/` directory (Cloudflare Workers + DOs, TypeScript) — separate `wrangler.toml`, separate CI lane.
  - `cmd/contrabass/` gains `worker` subcommand; `server` subcommand gets `--local-only` flag and becomes a build-tag-gated artifact for the team-shared deploy path.
  - `internal/team`, `internal/orchestrator`, `internal/hub`, `internal/web`, `internal/ipc`, `internal/tmux`, `internal/agent`, `internal/workspace`, `internal/tracker`, `internal/config` — split into "worker-side" (kept, reused by `contrabass worker`) and "host-side" (kept only behind `--local-only` build tag).
  - `packages/dashboard` — switches from `/api/v1/*` on `localhost` to API Worker base URL via build-time env; otherwise unchanged.
  - `embed_dashboard.go` — kept for `--local-only` builds; no longer required for cloud path.

- **Build / deploy**:
  - New `make cloud-deploy` target (wraps `wrangler deploy`).
  - New CI lane: `bun run --cwd cloud build && wrangler deploy --dry-run` on PRs.
  - Existing `make build` / `make ci` still produce the local-only Go binary unchanged.

- **APIs / wire format**:
  - New public REST + WS surface under `https://<team>.contrabass.dev/api/v1/*` (worker protocol + dashboard API).
  - New worker enrollment flow (one-time code from dashboard → `contrabass worker login` → refresh token).

- **Data / migration**:
  - One-time migration tool: dump local `.contrabass/state/team/<name>/*.json` + `WORKFLOW.md` → seed D1 + DO storage on first cloud onboarding.
  - Internal Board files (`.contrabass/board/`) → D1 rows; existing file format is kept as an export for offline/debug.

- **Security**:
  - Tracker tokens move to Cloudflare Secrets Store (no longer in dev `.env`).
  - Source code never leaves developer machine in Phase 1 (this is an explicit non-goal we want to preserve).
  - Worker auth: short-lived bearer + refresh; enrollment requires dashboard login.

- **Operational dependencies**:
  - Cloudflare account + Workers Paid plan (DOs, Cron, R2, D1, Queues all required).
  - Cloudflare Pages project for dashboard + landing.

- **Out of scope (future Phase 2 change)**:
  - Container-based agent execution.
  - Cloud-side source-code checkout / deploy keys / GitHub App.
  - Multi-team tenancy beyond `<team>.contrabass.dev` subdomain isolation.
