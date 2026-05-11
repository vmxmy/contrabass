## 1. Portal Foundation

- [x] 1.1 Add standalone LiteLLM portal Worker entrypoint, Wrangler config, Kumo CSS generation, and package scripts.
- [x] 1.2 Implement Cloudflare Access JWT validation plus allowed-domain/allowed-email enforcement.
- [x] 1.3 Serve the portal HTML, generated Kumo stylesheet, and favicon without custom inline styles.

## 2. LiteLLM Read-only Data Model

- [x] 2.1 Resolve the signed-in email to the actual LiteLLM user through `/user/list?user_email=...` before reading data.
- [x] 2.2 List only API keys owned by the resolved LiteLLM user using `/user/info` with `/key/list` fallback.
- [x] 2.3 Remove key creation from the UI and ensure `POST /api/keys` does not call `/key/generate`.
- [x] 2.4 Read team metadata from `/team/info` and expose team-scoped model availability with source metadata.

## 3. Usage Analytics

- [x] 3.1 Add dashboard aggregation for identity, key counts, team data, model access, and recent daily usage.
- [x] 3.2 Add a read-only `/api/usage/timeseries` endpoint accepting bounded `grain` values: `minute`, `hour`, `day`, `week`, and `month`.
- [x] 3.3 Aggregate minute/hour buckets from paginated `/spend/logs/v2` without returning raw `messages` or `response` fields.
- [x] 3.4 Aggregate day/week/month buckets from `/user/daily/activity` or sanitized Worker-side rollups.
- [x] 3.5 Render a Kumo-compatible token usage line chart with grain/window controls for user and management review.

## 4. Verification

- [x] 4.1 Cover auth, identity mapping, key isolation, team model filtering, dashboard aggregation, and no-key-creation behavior with tests.
- [x] 4.2 Add tests for timeseries bucketing, pagination limits, unsupported grains, and sanitization.
- [x] 4.3 Run `pnpm exec vitest run src/litellm-portal/index.test.ts` and `pnpm run build:litellm-portal`.
- [x] 4.4 Re-run browser visual checks after the chart is added on desktop and mobile.
