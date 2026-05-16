## Why

Admin users can already inspect the global user list, the global team list, and a placeholder team detail route, but they cannot answer two basic operational questions: which users inside a specific team are consuming budget right now, and how much of a user's usage should be attributed to that team rather than to the user globally. This gap makes the existing `/admin/teams/:teamId` view too shallow for budget review, incident triage, and team-owner support.

## What Changes

- Add a real admin team detail experience at `/admin/teams/:teamId` with a summary hero and a paginated member usage table.
- Add admin APIs dedicated to team member usage instead of asking the client to reconstruct membership from the paginated global user list.
- Show each member's usage scope with explicit labels so the MVP does not imply exact team-attributed historical spend when only user-level cumulative spend is available.
- Add a second-phase attributed-usage design and API surface for exact `team_id + user_id` usage views when upstream spend-log attribution is available.
- Add links from each team member row into the existing admin user detail route for deeper investigation.
- Return bounded scan metadata (`limited`, sampled counts) when upstream LiteLLM pagination prevents a complete team-member scan in one request.
- Define an explicit `unavailable` state for exact team-attributed analytics when upstream records lack the identifiers required for precise attribution.

## Capabilities

### New Capabilities
- `admin-team-member-usage`: team detail APIs and UI that let admins inspect which users belong to a team, how much they have spent, and which members are nearest to budget or role-related risk.
- `admin-team-attributed-usage`: team-scoped usage APIs and UI that let admins inspect exact usage attributed to a team overall and to each member inside that team when upstream spend-log attribution is present.

### Modified Capabilities
- None.

## Impact

- Affected backend: `routes.ts`, `litellm.ts`, `timeseries.ts`, `schemas.ts`, and shared admin helpers for paginated upstream scans plus team-attributed spend-log aggregation.
- Affected frontend: `routes/admin/teams/$teamId.lazy.tsx`, new admin hooks for team summary/member usage/attributed usage, and shared admin table/surface components in `admin-components.tsx`.
- Affected API surface: new `/api/admin/teams/:teamId/summary`, `/api/admin/teams/:teamId/members`, `/api/admin/teams/:teamId/usage/users`, and `/api/admin/teams/:teamId/users/:userId/usage/timeseries` read-only endpoints.
- No new bindings, secrets, Durable Objects, queues, or third-party dependencies.
