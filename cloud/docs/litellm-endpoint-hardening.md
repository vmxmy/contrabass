# LiteLLM Endpoint Hardening — Ops Advisory

**Audience:** infra/ops (executes). Author: portal investigation 2026-05. **Scope:** `litellm.ziikoo.com` ingress + LiteLLM proxy config. **Not portal code** — the portal already mitigated its side (per-user server-side-filtered reads via PR #134; it no longer pulls the global firehose).

## Evidence (measured 2026-05-16)

- `/spend/logs/v2` over 48h ≈ **14,711 rows**; **~77% have no valid user** (`metadata.user_api_key_user_id` empty) — i.e. unauthenticated scan / abuse, not real tenant traffic.
- Active **SSRF probing**: AWS instance-metadata host `169.254.169.254/...` observed arriving as a `model` value.
- `litellm.ziikoo.com` is already fronted by **Cloudflare** (a bot rule returns CF error `1010` for non-browser user-agents — confirmed when scripting against it).
- Net effect on the platform: junk dominated headline spend and starved the old ingest. Portal-side is fixed; **the origin is still being scanned and is still serving/charging on unauthenticated requests** — that is the remaining exposure.

## Recommended hardening (layered; do in this order)

### 1. LiteLLM-native auth enforcement (highest leverage, no infra change)
- **Reject unauthenticated requests outright.** Confirm `general_settings` requires a valid virtual/master key on ALL routes; ensure no route is in an allow-anonymous list. The ~77% no-user traffic should be **401 at LiteLLM**, never reach a model, never accrue spend.
- **Disable public/unauthenticated discovery**: turn off any public `/models` / `/model/info` / docs (`--no-docs` or `general_settings.disable_swagger`/`public_routes: []`) so scanners can't enumerate.
- **Per-key controls**: ensure every real tenant key has `max_budget`, `rpm_limit`/`tpm_limit`, and `allowed_routes` scoped (no key should reach `/spend/logs/*` admin routes).
- **Lock admin routes to the master key only** and rotate the master key if it was ever used outside the Worker (the portal Worker is the only legitimate admin caller).

### 2. Cloudflare edge controls (it's already behind CF — use it)
- **WAF custom rules**: block/challenge requests whose body or params contain SSRF markers (`169.254.169.254`, `metadata.google.internal`, `localhost`, `127.0.0.1`, `file://`, internal RFC1918 ranges) on the model/messages fields.
- **Rate limiting** per client IP on `/v1/*` and especially `/spend/logs/*`, `/key/*`, `/user/*` admin paths (e.g. low threshold + block).
- **Cloudflare Access (Zero Trust) in front of admin/management routes** (`/spend/*`, `/key/*`, `/user/*`, `/team/*`, `/model/*` mutations): only the portal Worker (service token / mTLS) and named admins should reach them. Public inference (`/v1/chat/completions`) stays open but key-gated.
- Turn the existing bot rule from "block weird UA" into **Bot Fight / managed challenge** on non-`/v1` paths.

### 3. Network egress (kills SSRF impact even if a probe lands)
- Ensure the LiteLLM host/container **cannot reach link-local / cloud-metadata / RFC1918** (egress firewall: deny `169.254.0.0/16`, `127.0.0.0/8`, `10/8`, `172.16/12`, `192.168/16`, `100.64/10`). This neutralizes the metadata-SSRF class regardless of input filtering.

### 4. Observability / verification
- Alert on: ratio of no-key 4xx vs 200, sudden `/spend/logs` request volume, any 2xx to admin routes not from the portal service token.
- After changes, re-measure: `/spend/logs/v2` 48h row count should drop dramatically (the 77% should become 401s and not be logged as spend). Re-run the portal smoke (`/api/usage/overview` self) — should be unaffected (it uses per-user filtered reads).

## Acceptance

- Unauthenticated request to any LiteLLM route → `401` (no model invocation, no spend row).
- SSRF marker in payload → blocked at CF WAF AND non-routable at egress.
- Admin/management routes reachable only by the portal service identity + named admins.
- 48h `/spend/logs/v2` volume and the no-user fraction fall sharply on re-measure.

## Out of scope / notes

- Portal code needs **no further change** for this; it already reads per-user (`/user/daily/activity?user_id=`) and never the global firehose.
- Do not relax the portal Worker's master-key path while locking admin routes — verify the Worker's service token/IP is allow-listed before enforcing Access, or the dashboard breaks (weak-degradation will show `available:false`).
