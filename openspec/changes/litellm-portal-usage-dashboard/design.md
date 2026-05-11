## Context

The LiteLLM portal is a standalone Cloudflare Worker app under `cloud/src/litellm-portal/` for gz-zhiyun users. Access is provided by Cloudflare Access email login, while LiteLLM identity, team membership, keys, models, and usage are read by the Worker using server-side LiteLLM credentials.

Stakeholders include individual company users who need to inspect their own API keys and managers who need usage trends across time grains. The browser must never receive the LiteLLM master key, raw request messages/responses, or any ability to supply a different `user_id`.

## Goals / Non-Goals

**Goals:**

- Provide a read-only portal showing existing API keys, team models, team limits, and usage summaries.
- Resolve signed-in email to LiteLLM `user_id` server-side and use that identity for all LiteLLM calls.
- Support multiple usage time grains: minute, hour, day, week, and month.
- Use request-level spend logs for minute/hour charts and aggregated daily data for day/week/month summaries when appropriate.
- Keep the frontend Kumo-based with no custom style blocks, inline styles, or hardcoded identity controls.
- Keep API responses sanitized and aggregated.

**Non-Goals:**

- Creating, editing, deleting, or rotating LiteLLM API keys.
- Admin impersonation or frontend-selected `user_id`.
- Exposing raw prompt/response payloads, LiteLLM master key, or Cloudflare Access tokens to the browser.
- Building a full multi-tenant admin console for multiple companies.

## Decisions

1. **Worker-only identity resolution**
   - Decision: The Worker validates Cloudflare Access, normalizes the email, resolves the matching LiteLLM user via `/user/list?user_email=...`, and ignores any frontend-provided user identity.
   - Rationale: This prevents users from viewing other users' keys or usage.
   - Alternative considered: Let the frontend pass `user_id`. Rejected because it breaks permission isolation.

2. **Read-only key visibility**
   - Decision: The portal exposes only `GET /api/keys` and dashboard aggregation. `POST /api/keys` is not implemented.
   - Rationale: The requested company portal is for visibility, not self-service key issuance.
   - Alternative considered: Hide the create form but leave the API. Rejected because hidden APIs are still callable.

3. **Team model source of truth**
   - Decision: Available models come from LiteLLM team metadata (`/team/info`) when configured; if LiteLLM returns an empty team model list, the response marks the source as unrestricted and can fall back to global models.
   - Rationale: LiteLLM commonly represents unrestricted team access as an empty model list.
   - Alternative considered: Treat empty team models as no models. This can be added later if the LiteLLM team policy changes.

4. **Granularity-specific usage sources**
   - Decision: Minute/hour usage uses `/spend/logs/v2` with pagination and Worker-side time bucketing; day/week/month usage uses `/user/daily/activity` when available and Worker-side rollups for week/month.
   - Rationale: Daily activity is efficient for trend summaries, while spend logs provide the request-level timestamps needed for minute/hour views.
   - Alternative considered: Use spend logs for every grain. Rejected for longer ranges because it can be expensive and paginated heavily.

5. **Aggregated frontend payloads**
   - Decision: The Worker returns buckets containing only time, token counts, request counts, spend, and optional model/key aliases. It strips raw messages and responses.
   - Rationale: This protects prompt content and reduces browser payload size.

## Risks / Trade-offs

- **Large spend log windows can be expensive** → Limit minute/hour windows, page size, and max pages; use daily endpoints for longer windows.
- **LiteLLM beta endpoints may change** → Normalize defensively and return `available: false` for optional analytics instead of breaking the whole dashboard.
- **Team model semantics may differ by deployment** → Expose `source` metadata and keep the behavior isolated in Worker logic.
- **Clock/timezone confusion** → Return bucket timestamps in ISO form and include the window and grain in API metadata.
- **Kumo standalone class coverage may omit arbitrary Tailwind classes** → Use Kumo/standalone generated classes already present in the CSS and verify in browser.
