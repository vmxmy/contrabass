## Context

The cloud tracker poller (`cloud/src/poller/index.ts`) is a Cloudflare Worker triggered by cron (`* * * * *`). For each active team, it reads the team's YAML config, determines which tracker adapters are enabled, calls each adapter, and POSTs normalized issues to the `TeamCoordinator` Durable Object's `/board/refresh` endpoint.

Each adapter (`linear.ts`, `github.ts`, `internal-board.ts`) implements the `PollerAdapter` type: `(invocation: PollerInvocation) => Promise<PollerAdapterResult | void>`. The adapter fetches issues from an external tracker API, normalizes them to a poller-specific issue shape, and posts them to the TeamCoordinator DO.

Plane exposes a REST API at `/api/v1/workspaces/{slug}/projects/{id}/issues/`. Authentication is via `x-api-key` header. Issue states are custom per-project (identified by UUID).

## Goals / Non-Goals

**Goals:**
- Implement `PollerAdapter` for Plane using REST API v1
- Support self-hosted Plane and Plane Cloud (`https://api.plane.so`)
- Follow existing adapter conventions (config from YAML, token from env/secret store, rate-limit error class for backoff)
- Normalize Plane issues to `PollerIssue` shape compatible with TeamCoordinator `/board/refresh`
- Properly register in type union, adapter map, config parser, and secret provider list

**Non-Goals:**
- Write-back operations (claim/release/update state) — the poller only reads; state mutations happen through the local Go binary's tracker
- Plane WebSocket / real-time subscriptions
- Project/workspace CRUD
- Dashboard UI changes for Plane-specific metadata

## Decisions

1. **REST API endpoints**: Use Plane's public REST v1 API:
   - `GET /api/v1/workspaces/{slug}/projects/{id}/issues/` — fetch issues (with pagination via `?offset=N&limit=M`)
   - `GET /api/v1/workspaces/{slug}/projects/{id}/states/` — fetch state list for filtering

2. **Issue filtering**: Fetch all open issues and filter client-side for unassigned ones, same approach as GitHub adapter. Plane supports query params but the filter logic varies by self-hosted version, so client-side filtering is more reliable.

3. **State mapping**: Plane states are UUID-referenced and user-configurable. The adapter fetches project states once per poll cycle and builds a map. Issues in "Done"/"Completed"/"Cancelled" states are excluded (terminal). Issues in "Backlog"/"Todo" are `unclaimed`. Everything else is `claimed`.

4. **Issue shape normalization**: Map Plane API response fields to `PollerIssue`:
   - `id` → UUID
   - `external_id` → UUID (same)
   - `identifier` → `sequence_id` (e.g., "PROJ-42")
   - `state` → based on Plane state group
   - `tracker_meta.provider` → `"plane"`
   - `branch_name` → `symphony/{identifier.toLowerCase()}`

5. **Config resolution**: Read from `tracker.plane:` YAML block with keys: `host`, `api_key` (or `$ENV_REF`), `workspace_slug`, `project_id`. Fall back to `tracker:` level for shared fields.

6. **Token resolution**: Same pattern as Linear — check YAML `api_key` field first (with `$` env ref support), then check env bindings in order: `TRACKER_{TEAM_ID}_PLANE_API_KEY`, `TRACKER_PLANE_API_KEY`, `PLANE_API_KEY`.

7. **Rate limiting**: `PlaneRateLimitError` with `retryAfterMs` property so the poller's existing backoff mechanism kicks in automatically.

8. **Secret store**: Add `"plane"` to `TRACKER_SECRET_PROVIDERS` array so the dashboard can manage Plane API tokens.

## Risks / Trade-offs

- **State name brittleness**: Plane state names are user-configurable per project. The adapter filters by state *group* (backlog, unstarted, started, completed, cancelled) which Plane provides on the state object — more reliable than name matching.
- **Pagination**: Plane uses offset-based pagination. Large projects may need multiple requests per poll cycle. Mitigated by the 1-minute cron — partial progress is fine.
- **No Plane SDK**: Plain `fetch`, same as existing adapters. Keeps bundle size minimal for Cloudflare Workers.
