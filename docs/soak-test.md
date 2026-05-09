# Real-World Soak Test Runbook (Task 16.2)

One developer runs `contrabass worker` against the staging environment for 1 week
with the codex agent. This document covers setup, monitoring, acceptance criteria,
and the results record to fill in.

## Prerequisites

| Requirement | Check |
|---|---|
| `contrabass worker` built from this branch | `contrabass worker --help` prints help |
| `codex` on `$PATH` | `which codex` returns a path |
| `git` on `$PATH` | `which git` returns a path |
| tmux available (recommended) | `which tmux` returns a path |
| Staging enrollment code from the dashboard | Received from team lead |
| `ANTHROPIC_API_KEY` (or provider key codex uses) | `echo $ANTHROPIC_API_KEY` non-empty |
| Network access to `staging.contrabass.dev` | `curl -sf https://api.staging.contrabass.dev/healthz` returns 200 |

## Staging API URL

```
https://api.staging.contrabass.dev
```

Dashboard: `https://staging.contrabass.dev`

## Step 1 — Enroll

Run once on the machine that will host the worker:

```bash
contrabass worker login \
  --api-url https://api.staging.contrabass.dev \
  --code <ENROLLMENT_CODE>
```

Expected output:

```
Enrolled worker "worker-<id>" for team "synthetic-smoke". Refresh token stored in OS credential store.
```

The refresh token is stored in the OS credential store (Keychain on macOS,
libsecret on Linux). It is valid for ≥30 days; re-enrollment is only needed if
the token is explicitly revoked.

## Step 2 — Start the worker

```bash
contrabass worker \
  --team synthetic-smoke \
  --api-url https://api.staging.contrabass.dev \
  --max-concurrency 1
```

Expected output:

```
Registered worker "<id>" for team "synthetic-smoke". Dispatch WebSocket: wss://api.staging.contrabass.dev/v1/workers/<id>/dispatch-ws
```

The worker then waits silently for dispatch frames. Runs are executed in
`workspaces/<runId>/` under the current directory.

**Run inside a persistent session** so it survives terminal disconnects:

```bash
tmux new-session -s soak 'contrabass worker --team synthetic-smoke --api-url https://api.staging.contrabass.dev'
# Detach: Ctrl-B D
# Reattach: tmux attach -t soak
```

Alternatively pipe stdout/stderr to a log file:

```bash
contrabass worker --team synthetic-smoke --api-url https://api.staging.contrabass.dev \
  2>&1 | tee ~/soak-worker.log
```

## Step 3 — Inject test issues (staging poller)

The staging tracker poller injects synthetic issues from the `synthetic-smoke`
internal board every minute. No manual action is required.

To inject an issue immediately for a faster first dispatch:

```bash
curl -s -X POST https://api.staging.contrabass.dev/v1/teams/synthetic-smoke/board/refresh \
  -H "Authorization: Bearer $STAGING_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"entries": [{"issueRef": "SOAK-1", "phase": "open"}]}'
```

## Step 4 — Monitor

### Dashboard

Open `https://staging.contrabass.dev` and select team `synthetic-smoke`. Watch:

- **Board** — runs move from `open → claimed → running → done`
- **Worker status** — `idle | busy | unhealthy`
- **Run detail** — events stream in during execution

### CLI board poll

```bash
watch -n 30 'curl -s https://api.staging.contrabass.dev/v1/teams/synthetic-smoke/board \
  -H "Authorization: Bearer $STAGING_TOKEN" | jq .board'
```

### Worker log

```bash
tmux attach -t soak          # or tail -f ~/soak-worker.log
```

Look for:
- `Registered worker` at startup
- No `lease_revoked` errors without a corresponding requeue
- No `HTTP 401` after the first hour (session auto-refresh must work)
- Heartbeat log lines at ~20s cadence per active run

### Key metrics to watch (Workers Analytics Engine)

| Metric | Healthy range |
|---|---|
| Dispatch latency (issue injected → ack) | < 5 s |
| Heartbeat interval | leaseSec/3 ± 2 s |
| Lease revocation rate | < 1 % of runs |
| Event ingest rate | tracks agent output, no 413 errors |
| Session refresh rate | ~every 45 min, no 401 after refresh |

## Acceptance criteria (all must be met to mark 16.2 done)

- [ ] Worker runs continuously for **7 calendar days** without manual restart
- [ ] Session token is refreshed automatically; no `HTTP 401` errors after the first hour
- [ ] ≥ 10 runs dispatched, acked, and completed as `succeeded` or `failed`
- [ ] No run stuck in `running` for > 2× leaseSec without a revocation event
- [ ] Dashboard board state stays consistent (no phantom running runs after completion)
- [ ] No unhandled panics or OOM events in the worker process

## Results record

Fill this in as the soak progresses.

| Date | Runs dispatched | Runs succeeded | Runs failed | Revocations | 401 errors | Notes |
|---|---|---|---|---|---|---|
| Day 1 | | | | | | |
| Day 2 | | | | | | |
| Day 3 | | | | | | |
| Day 4 | | | | | | |
| Day 5 | | | | | | |
| Day 6 | | | | | | |
| Day 7 | | | | | | |

**Soak passed:** YES / NO

**Issues filed:** (link to follow-up issues)

## Troubleshooting

### Worker exits with `HTTP 401` immediately

The enrollment refresh token may be revoked. Re-enroll:

```bash
contrabass worker login --api-url https://api.staging.contrabass.dev --code <NEW_CODE>
```

### Worker exits with `no supported agent runner found on PATH`

Ensure `codex` is on `$PATH` and accessible from the shell that runs the worker.

### Dispatch frames arrive but runs fail immediately

Check `ANTHROPIC_API_KEY` (or the key your codex configuration uses) is set in
the environment where the worker process runs.

### WS upgrade fails, falling back to long-poll

This is expected behind proxies that block WebSocket upgrades. The worker
switches automatically to long-poll after 3 failures and retries WS every minute.
No action needed unless long-poll is also blocked.

### Board shows run stuck in `running`

If `now - run.lastHeartbeatAt > leaseSec`, the cloud should revoke the lease via
alarm. Wait one full `leaseSec` (default 60 s) then refresh the dashboard. If the
run is still `running`, file a bug — this is the lease-revocation path (task 16.3).

## Related tasks

- **16.1** Smoke test (automated, already passing)
- **16.3** Lease-revocation path validation (kill worker mid-run)
- **16.4** WS reconnect + `last_event_id` replay validation
- **16.5** Long-poll fallback validation
