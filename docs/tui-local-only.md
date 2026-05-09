# Local-only TUI mode

Contrabass ships two TUI modes selected at build time via the `localonly` build tag.

| Mode | Build command | Entry point | Requires cloud |
|---|---|---|---|
| **Cloud thin client** | `make build` (default) | `contrabass tui --team <id>` | Yes — enrollment + WebSocket |
| **Local-only orchestrator** | `make build LOCAL_ONLY=1` | `contrabass server` | No |

## When to use local-only mode

- Solo offline use with no cloud account
- Air-gapped environments (no outbound HTTPS to `api.contrabass.dev`)
- Single-developer workflows where cloud coordination adds no value
- Validating a workflow config locally before pushing to the cloud

## Building the local-only binary

```bash
make build LOCAL_ONLY=1
```

This passes `-tags localonly` to the Go compiler and includes:

- `internal/team` — team run coordination
- `internal/orchestrator` — issue-claim loop, lease management, orphan recovery
- `internal/hub` — in-process event fan-out
- `internal/web` — embedded dashboard HTTP server
- `internal/ipc` — JSONL event log (local equivalent of cloud NDJSON events)

The resulting binary is larger than the default cloud binary. It is not intended for distribution to team members — each developer's binary is a single-host tool.

## Running the local-only TUI

```bash
# Basic usage — reads WORKFLOW.md in the current directory
./contrabass server

# With embedded web dashboard on a custom port
./contrabass server --port 8080

# Headless mode (no TUI, structured log output)
./contrabass server --no-tui

# Dry-run: start the orchestrator, emit the first event, then exit
./contrabass server --dry-run
```

The TUI occupies the full terminal (alt-screen). Press `q` or `Ctrl+C` to exit and trigger graceful shutdown.

### Configuration

The orchestrator reads `WORKFLOW.md` (or the path passed with `--config`). Config is watched via `fsnotify` and reloaded live without a restart. See the root README and `docs/local-board.md` for config reference.

## Embedded web dashboard

When `--port` is set, the local binary serves the dashboard SPA from an embedded `embed.FS` at `http://localhost:<port>/`. The dashboard is the same React SPA built from `packages/dashboard` but served from the binary rather than from Cloudflare Pages.

```bash
./contrabass server --port 8080
# Web dashboard available at http://localhost:8080
```

The embedded dashboard is excluded from the default (non-localonly) build. `embed_dashboard.go` produces an empty `embed.FS` when built without `-tags localonly`.

## The `contrabass tui` command in local-only builds

In localonly builds, `contrabass tui` is a stub:

```
$ contrabass tui
Error: tui subcommand is not available in local-only builds; use `contrabass server` instead
```

This is intentional. The cloud TUI (`tui.go`) depends on the cloud enrollment store and WebSocket subscriber, neither of which is included in a localonly binary. The server subcommand provides an equivalent read-write TUI for the single-host orchestrator.

## Checking which build you have

```bash
# Cloud build — tui works, server does not
contrabass tui --help    # succeeds, shows --team flag
contrabass server        # exits: "server is not available in this build; rebuild with -tags localonly"

# Local-only build — server works, tui is a stub
contrabass server --help # succeeds, shows --port, --no-tui, --dry-run flags
contrabass tui           # exits: "tui subcommand is not available in local-only builds"
```

## Differences between modes

| Capability | Local-only (`localonly` tag) | Cloud (`contrabass tui`) |
|---|---|---|
| Tracker polling | On this machine using local env tokens | Cloud-side, secrets in Cloudflare Secrets Store |
| Config reload | `fsnotify` on `WORKFLOW.md` | WS `config-changed` frame from `TeamCoordinator` |
| Issue dispatch | In-process orchestrator loop | Cloud `IssueRun` Durable Object |
| Event fan-out | In-process `internal/hub` | Cloud WS subscription + NDJSON POST |
| Dashboard | Embedded SPA served from binary | Cloudflare Pages |
| Multiple workers | No — single machine only | Yes — any enrolled worker |
| Enrollment required | No | Yes — `contrabass worker login` |
| Internet required | No | Yes |

## Rollback to local-only from cloud

If cloud onboarding does not work out, stop running `contrabass worker`, rebuild with `LOCAL_ONLY=1`, and resume `contrabass server`. Your `.contrabass/state/` and `.contrabass/board/` directories are untouched. See `docs/local-board.md` for the local board format.
