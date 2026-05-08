#!/usr/bin/env bash
# Quick-start contrabass.
#
# Usage:
#   scripts/start.sh                              # demo + dashboard on :8080
#   scripts/start.sh demo                         # alias of above
#   scripts/start.sh github | omx | omc | opencode | hardening | local | mock
#   scripts/start.sh --port 9000                  # override port
#   scripts/start.sh --host 0.0.0.0               # bind all interfaces
#   scripts/start.sh --no-tui                     # headless
#   scripts/start.sh --config <path>              # custom config
#   scripts/start.sh --build                      # force rebuild SPA+binary
#   scripts/start.sh --skip-env-check             # skip required-var validation
#
# Env loading:
#   If a .env file exists at repo root, it is auto-sourced before launch.
#
# Env validation:
#   Per preset, required vars are checked. Missing → exit 2 with hint.

set -euo pipefail

cd "$(git -C "$(dirname "$0")/.." rev-parse --show-toplevel)"

PORT="${CONTRABASS_PORT:-8080}"
HOST="${CONTRABASS_HOST:-localhost}"
CONFIG="${CONTRABASS_CONFIG:-}"
PRESET="demo"
EXTRA_ARGS=()
FORCE_BUILD=0
SKIP_ENV_CHECK=0

while [ $# -gt 0 ]; do
  case "$1" in
    demo|github|omx|omc|opencode|hardening|local|mock)
      PRESET="$1"; shift ;;
    --config)
      CONFIG="$2"; shift 2 ;;
    --port)
      PORT="$2"; shift 2 ;;
    --host)
      HOST="$2"; shift 2 ;;
    --no-tui)
      EXTRA_ARGS+=("--no-tui"); shift ;;
    --no-port)
      PORT=""; shift ;;
    --build)
      FORCE_BUILD=1; shift ;;
    --skip-env-check)
      SKIP_ENV_CHECK=1; shift ;;
    --help|-h)
      sed -n '2,21p' "$0"; exit 0 ;;
    *)
      EXTRA_ARGS+=("$1"); shift ;;
  esac
done

# Auto-source .env if present
if [ -f .env ]; then
  echo ">> sourcing .env"
  set -a
  # shellcheck disable=SC1091
  . ./.env
  set +a
fi

if [ -z "$CONFIG" ]; then
  case "$PRESET" in
    demo)      CONFIG="testdata/workflow.demo.md" ;;
    github)    CONFIG="testdata/workflow.github.md" ;;
    omx)       CONFIG="testdata/workflow.omx.md" ;;
    omc)       CONFIG="testdata/workflow.omc.md" ;;
    opencode)  CONFIG="testdata/workflow.ohmyopencode.md" ;;
    hardening) CONFIG="testdata/workflow.hardening.md" ;;
    local)     CONFIG="testdata/workflow.local.md" ;;
    mock)      CONFIG="testdata/workflow.mock.md" ;;
  esac
fi

[ -f "$CONFIG" ] || { echo "config not found: $CONFIG" >&2; exit 1; }

# Per-preset required env vars
required_for_preset() {
  case "$1" in
    demo|hardening|omx|omc)
      echo "CONTRABASS_MODEL CONTRABASS_PROJECT_URL LINEAR_ASSIGNEE_ID LINEAR_API_KEY" ;;
    github|opencode)
      echo "CONTRABASS_MODEL GITHUB_OWNER GITHUB_REPO GITHUB_ASSIGNEE GITHUB_TOKEN" ;;
    local|mock)
      echo "" ;;  # internal/mock trackers don't require external creds
    *)
      echo "" ;;
  esac
}

if [ "$SKIP_ENV_CHECK" = 0 ]; then
  missing=()
  for var in $(required_for_preset "$PRESET"); do
    if [ -z "${!var:-}" ]; then
      missing+=("$var")
    fi
  done
  if [ "${#missing[@]}" -gt 0 ]; then
    echo "" >&2
    echo "ERROR: preset '$PRESET' needs these env vars (missing):" >&2
    for v in "${missing[@]}"; do echo "  - $v" >&2; done
    echo "" >&2
    echo "Hints:" >&2
    echo "  - cp .env.example .env  # then edit" >&2
    echo "  - or: export VAR=value before running" >&2
    echo "  - or: scripts/start.sh --skip-env-check  (run anyway, expect failures)" >&2
    exit 2
  fi
fi

# Bun deps (only if missing)
if [ ! -d node_modules ] || [ ! -d packages/dashboard/node_modules ]; then
  echo ">> bun install"
  bun install
fi

# Dashboard SPA (only if dist absent or --build)
if [ "$FORCE_BUILD" = 1 ] || [ ! -d packages/dashboard/dist ]; then
  echo ">> make build-dashboard"
  make build-dashboard
fi

# Build binary if --build
if [ "$FORCE_BUILD" = 1 ]; then
  echo ">> make build"
  make build
fi

CMD=(go run ./cmd/contrabass --config "$CONFIG")
if [ -n "$PORT" ]; then
  CMD+=(--port "$PORT")
fi
if [ -n "$HOST" ] && [ "$HOST" != "localhost" ]; then
  CMD+=(--host "$HOST")
fi
if [ "${#EXTRA_ARGS[@]}" -gt 0 ]; then
  CMD+=("${EXTRA_ARGS[@]}")
fi

echo ">> ${CMD[*]}"
if [ -n "$PORT" ]; then
  if [ "$HOST" = "0.0.0.0" ]; then
    echo ">> dashboard: http://<your-host>:$PORT (binding all interfaces)"
  else
    echo ">> dashboard: http://$HOST:$PORT"
  fi
fi
exec "${CMD[@]}"
