## Context

The current admin team detail route is a placeholder that only renders breadcrumbs and static copy. The portal already exposes:
- `/api/admin/users` with paginated global users and cumulative user spend
- `/api/admin/teams` with global team metadata and team-level spend/budget
- `/api/admin/usage/timeseries` for global trends

What it does not expose is either:
1. a reliable, team-scoped member view
2. an exact team-attributed per-user usage view

The frontend cannot safely derive the first from `/api/admin/users` because that endpoint is paginated and global. The current usage pipeline supports either a single `user_id` view or a global view; it does not yet expose a dedicated `team_id`-scoped breakdown, even though the spend-log path is the most plausible place to derive one.

This expanded change therefore has two layers:
- **Phase 1 (MVP):** trustworthy team member roster + cumulative user usage context
- **Phase 2 (exact attribution):** team-attributed usage surfaces driven by spend logs that can be filtered by both `team_id` and `user_id`

## Goals / Non-Goals

**Goals:**
- Turn `/admin/teams/:teamId` into a useful read-only investigation surface.
- Provide a dedicated server endpoint for team members so the client never guesses team membership from incomplete global pages.
- Surface each member's cumulative spend, budget context, role, and clear risk indicators in the MVP.
- Add an exact team-attributed usage design for per-team user leaderboards and per-member timeseries views.
- Explicitly disclose scan completeness and attribution availability when upstream data is incomplete.
- Reuse existing admin navigation, breadcrumbs, and visual primitives.

**Non-Goals:**
- New write operations, team membership editing, or role management from the team detail page.
- Cross-team comparison dashboards.
- New infrastructure such as KV caches, Durable Objects, or analytics pipelines.
- Pretending exact team attribution exists when upstream spend logs do not expose the required identifiers.

## Decisions

### 1. Keep a two-phase contract inside one change
Decision:
- Treat team member visibility and exact team attribution as related but distinct deliverables.
- Keep the MVP path shippable even if exact team attribution is unavailable in a given LiteLLM deployment.

Rationale:
- Admins need member visibility immediately.
- Exact attribution depends on the quality of upstream spend-log identifiers and should not block the entire team detail feature.

Alternatives considered:
- Split into two separate changes now: rejected because the UI, route, and API family are tightly related.
- Block the entire feature until exact attribution works everywhere: rejected because it delays a high-value admin workflow.

### 2. Add dedicated team detail endpoints instead of reusing `/api/admin/users`
Decision:
- Add `GET /api/admin/teams/:teamId/summary`
- Add `GET /api/admin/teams/:teamId/members?page=&size=&sort=`

Rationale:
- The current `/api/admin/users` contract is global and paginated. Filtering it in the browser would produce incomplete membership and unstable ordering.
- A team-specific endpoint lets the server scan upstream user pages, apply membership filtering once, and return a coherent result.

Alternatives considered:
- Filter `/api/admin/users` on the client: rejected because pagination makes membership incomplete.
- Expand `/api/admin/teams` with embedded member arrays: rejected because the teams index page should stay light and the member table deserves independent pagination.

### 3. MVP semantics will expose **cumulative user spend**, not pretend to provide exact team-attributed historical spend
Decision:
- Member rows will expose cumulative user spend from the LiteLLM user record as the primary usage number in Phase 1.
- The UI and API field names/copy will explicitly label the number as cumulative or user-level spend.

Rationale:
- The current pipeline already exposes reliable user-level spend.
- This solves the immediate operational need without inventing false precision.

Alternatives considered:
- Fake team attribution by reusing global user totals under a team heading: rejected because it misleads operators.
- Ship no usage number in Phase 1: rejected because spend visibility is the main admin question.

### 4. Exact team-attributed usage will be derived from spend logs and gated by identifier availability
Decision:
- Add a second-phase API family:
  - `GET /api/admin/teams/:teamId/usage/users`
  - `GET /api/admin/teams/:teamId/users/:userId/usage/timeseries`
- Implement exact attribution by filtering spend-log records on both `team_id` and `user_id`.
- If upstream spend-log records do not carry the required identifiers consistently, return `available: false` plus an explanatory reason rather than partial or misleading numbers.

Rationale:
- `timeseries.ts` already has spend-log aggregation machinery; extending that path is more coherent than inventing a separate analytics layer.
- An explicit unavailable state is safer than best-effort guesswork.

Alternatives considered:
- Infer team attribution from current membership alone: rejected because historical calls may predate membership changes or belong to other teams.
- Hard-fail the page when exact attribution is unavailable: rejected because the MVP team detail view should still work.

### 5. The backend will perform bounded upstream scans and return completeness metadata
Decision:
- The members endpoint will scan the upstream paginated user list until all pages are consumed or a fixed max-page guard is hit.
- The response will include `limited`, `sampledUserCount`, and `totalMemberCount` semantics so the UI can disclose partial results.

Rationale:
- Upstream LiteLLM does not currently expose a first-class team-members endpoint in this codebase.
- A bounded scan mirrors the existing admin summary pattern, which already discloses sampled results.

Alternatives considered:
- Unbounded scan: rejected because it risks latency spikes and admin route instability.
- Silent truncation: rejected because admins need to know when a team view is incomplete.

### 6. The initial UI will live inside the existing team detail route and preserve the admin workspace model
Decision:
- Keep `/admin/teams/:teamId` as an admin detail page under the sidebar layout.
- Add a summary hero, a member usage table, and an attributed-usage section that can render either data or an explicit unavailable state.
- Each row will link to `/admin/users/:userId` for deeper investigation.

Rationale:
- This matches the current route architecture and avoids inventing a second navigation pattern.
- Team detail becomes the natural place to answer both “who inside this team is driving spend?” and “how much of this usage belongs to this team?”

Alternatives considered:
- Put member usage directly into `/admin/teams`: rejected because the index page would become too dense.
- Use a drawer only from the teams index: rejected because deep-linkable detail pages are better for admin workflows.

### 7. Response shapes will use explicit names for usage scope
Decision:
- Prefer names like `cumulativeSpend` for Phase 1 and `attributedSpend` for Phase 2.
- Pair usage values with explanatory copy in the UI.

Rationale:
- The portal already uses `spend` in multiple contexts (team totals, global user totals, key spend). Team detail needs tight semantics to avoid confusion.

Alternatives considered:
- Reuse the existing generic `spend` field name everywhere: rejected because it obscures scope.

## Risks / Trade-offs

- [Upstream scan latency for large tenants] -> Keep a hard page cap, return `limited: true`, and show a sample-state banner in the UI.
- [Admins may interpret cumulative user spend as team-attributed spend] -> Use explicit field names and visible copy such as “用户累计花费（非 team 归因）”.
- [Exact attribution may be unavailable in some deployments] -> Return `available: false` with a reason and keep Phase 1 data visible.
- [Duplicated list/summary logic across admin views] -> Isolate team-member aggregation and team-attributed usage aggregation in reusable helpers and dedicated hooks.
- [Future schema changes if upstream payloads evolve] -> Keep team-attributed endpoints separate from MVP member-list endpoints so semantics remain stable.

## Migration Plan

1. Add new schemas and server route contracts for Phase 1 and Phase 2 responses.
2. Implement backend team-member aggregation with bounded scan metadata.
3. Extend spend-log aggregation helpers to support `team_id` and `team_id + user_id` filtering.
4. Add frontend hooks for summary, members, attributed user leaderboard, and per-member attributed timeseries.
5. Replace the placeholder team detail page with summary + member table + attributed usage section.
6. Verify detail-page navigation, empty states, sampled-result disclosure, and explicit unavailable states.

Rollback:
- Revert the new admin endpoints and restore the existing placeholder team detail page.
- No stored data migration is required because the change is read-only.

## Open Questions

- Do upstream spend-log records in the deployed LiteLLM version consistently expose both `team_id` and `user_id` for all relevant requests?
- Should the first implementation of `usage/users` return only leaderboard totals, or also pre-computed budget risk and top-model slices per member?
- Should the team detail page default to the MVP cumulative table first and lazy-load exact attribution below it, or blend both views into one comparison table?
