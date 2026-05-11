## Why

The gz-zhiyun LiteLLM portal must give company users and managers a trustworthy read-only view of AI API key access, model availability, and token consumption without allowing the frontend to choose or forge LiteLLM identities. The current portal needs a clearer usage dashboard that supports both near-real-time anomaly detection and management-level trend review.

## What Changes

- Add a Cloudflare Worker-hosted LiteLLM portal for `zhiyun.ziikoo.com` protected by Cloudflare Access email login.
- Resolve the signed-in email to the corresponding LiteLLM user server-side before reading keys, team membership, models, and usage.
- Show only existing API keys owned by the resolved LiteLLM user; remove key creation from the UI and do not expose a key-generation API.
- Show available models from the user's LiteLLM team configuration, with clear source metadata when the team is unrestricted or a Worker allowlist is configured.
- Provide usage analytics across practical time grains for users and management:
  - minute-level for recent spikes and runaway scripts,
  - hour-level for same-day usage rhythm,
  - day-level for 7/30/90 day review,
  - week-level for management trend review,
  - month-level for budget and quarterly review.
- Keep LiteLLM master credentials and raw request payloads away from the browser; expose only aggregated, sanitized data.

## Capabilities

### New Capabilities
- `litellm-portal-usage-dashboard`: Covers Access-authenticated LiteLLM identity resolution, read-only key/model visibility, and multi-granularity token usage analytics for the gz-zhiyun portal.

### Modified Capabilities

None.

## Impact

- Adds/updates Cloudflare Worker code under `cloud/src/litellm-portal/`.
- Adds Worker routing/configuration in `cloud/wrangler.litellm-portal.toml` and package scripts for local dev, build, and deploy.
- Depends on Cloudflare Access JWT headers, LiteLLM admin/master API credentials stored as Worker secrets, and LiteLLM OpenAPI endpoints such as `/user/list`, `/user/info`, `/team/info`, `/v1/models`, `/user/daily/activity`, and `/spend/logs/v2`.
- Adds tests for authentication boundaries, email-to-user resolution, read-only API behavior, team model filtering, dashboard aggregation, and no key creation exposure.
