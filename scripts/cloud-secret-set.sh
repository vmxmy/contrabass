#!/usr/bin/env bash
set -euo pipefail

team_id="${TEAM_ID:-}"
provider="${PROVIDER:-}"
store_id="${CLOUD_SECRET_STORE_ID:-}"
scopes="${CLOUD_SECRET_SCOPES:-workers}"
secret_value="${CLOUD_SECRET_VALUE:-}"

usage() {
  cat <<'USAGE' >&2
Usage:
  make cloud-secret-set TEAM_ID=<team-id> PROVIDER=<linear|github>

Optional:
  CLOUD_SECRET_STORE_ID=<store-id>     Secrets Store ID (defaults in Makefile)
  CLOUD_SECRET_SCOPES=<scopes>         Wrangler scopes (default: workers)
  CLOUD_SECRET_VALUE=<token>           Non-interactive value; prefer prompt when possible
  CLOUD_SECRET_DRY_RUN=1               Print the wrangler command without running it

The secret name is tracker/<team-id>/<provider>.
USAGE
}

if [[ -z "${team_id}" || -z "${provider}" ]]; then
  usage
  exit 2
fi

if [[ "${team_id}" == *"/"* ]]; then
  echo "TEAM_ID must not contain '/'" >&2
  exit 2
fi

case "${provider}" in
  linear|github) ;;
  *)
    echo "PROVIDER must be 'linear' or 'github'" >&2
    exit 2
    ;;
esac

if [[ -z "${store_id}" ]]; then
  echo "CLOUD_SECRET_STORE_ID is required" >&2
  exit 2
fi

secret_name="tracker/${team_id}/${provider}"
cmd=(
  bunx
  wrangler
  secrets-store
  secret
  create
  "${store_id}"
  --name
  "${secret_name}"
  --scopes
  "${scopes}"
  --remote
)

if [[ -n "${secret_value}" ]]; then
  cmd+=(--value "${secret_value}")
fi

if [[ "${CLOUD_SECRET_DRY_RUN:-}" == "1" ]]; then
  printable=("${cmd[@]}")
  if [[ -n "${secret_value}" ]]; then
    printable[${#printable[@]}-1]="***"
  fi
  printf 'Would run:'
  printf ' %q' "${printable[@]}"
  printf '\n'
  exit 0
fi

echo "Setting ${secret_name} in Secrets Store ${store_id}."
if [[ -z "${secret_value}" ]]; then
  echo "Wrangler will prompt for the secret value."
fi

"${cmd[@]}"
