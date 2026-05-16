## 1. API contracts and schemas

- [ ] 1.1 Add schemas and TypeScript types for `GET /api/admin/teams/:teamId/summary`.
- [ ] 1.2 Add schemas and TypeScript types for `GET /api/admin/teams/:teamId/members` with pagination and completeness metadata.
- [ ] 1.3 Add schemas and TypeScript types for `GET /api/admin/teams/:teamId/usage/users` and `GET /api/admin/teams/:teamId/users/:userId/usage/timeseries`, including explicit unavailable-state payloads.
- [ ] 1.4 Choose explicit field names for usage scope in the new payloads (for example `cumulativeSpend` vs `attributedSpend`).

## 2. Backend aggregation for team members

- [ ] 2.1 Add a server helper that resolves a team by `teamId` for admin detail routes.
- [ ] 2.2 Implement bounded upstream user scanning to collect members whose `teamIds` include the requested team.
- [ ] 2.3 Return `limited` / sampled metadata when the upstream scan hits the configured guardrail before a full pass completes.
- [ ] 2.4 Implement `GET /api/admin/teams/:teamId/summary` under the existing admin middleware stack.
- [ ] 2.5 Implement `GET /api/admin/teams/:teamId/members` under the existing admin middleware stack.

## 3. Backend aggregation for exact attributed usage

- [ ] 3.1 Extend spend-log aggregation helpers to support filtering by `team_id` in addition to the existing global and `user_id` modes.
- [ ] 3.2 Add exact team-attributed per-member leaderboard aggregation for `GET /api/admin/teams/:teamId/usage/users`.
- [ ] 3.3 Add exact `team_id + user_id` timeseries aggregation for `GET /api/admin/teams/:teamId/users/:userId/usage/timeseries`.
- [ ] 3.4 Add explicit `available: false` / reason responses when upstream spend logs cannot support exact attribution.

## 4. Frontend data hooks

- [ ] 4.1 Add `useAdminTeamSummary(teamId)` for the team detail hero.
- [ ] 4.2 Add `useAdminTeamMembers(teamId, page, size)` for the member usage table.
- [ ] 4.3 Add `useAdminTeamUsageUsers(teamId, window, grain)` for the attributed member leaderboard.
- [ ] 4.4 Add `useAdminTeamUserUsage(teamId, userId, window, grain)` for the attributed per-member drilldown.
- [ ] 4.5 Normalize limited/sample metadata and unavailable-state metadata into hook return values.

## 5. Team detail UI

- [ ] 5.1 Replace the placeholder `/admin/teams/:teamId` page with a real read-only detail layout.
- [ ] 5.2 Add a summary hero showing team identity, spend, budget, member count, and member-risk indicators.
- [ ] 5.3 Add a paginated member usage table with identity, role, cumulative usage, budget context, and a link to `/admin/users/:userId`.
- [ ] 5.4 Add a separate attributed-usage section for team-scoped member leaderboard and drilldown.
- [ ] 5.5 Add empty, not-found, loading, sampled-result, and attributed-unavailable states to the team detail page.
- [ ] 5.6 Add copy that explicitly distinguishes cumulative user usage from exact team-attributed usage.

## 6. Tests

- [ ] 6.1 Add backend tests for team summary and team members endpoints, including admin guard behavior.
- [ ] 6.2 Add backend tests for attributed leaderboard/timeseries endpoints, including unavailable and membership-mismatch paths.
- [ ] 6.3 Add tests for bounded scan behavior and `limited` metadata.
- [ ] 6.4 Add frontend tests for team detail loading, empty, not-found, sampled-result, and attributed-unavailable states.
- [ ] 6.5 Add frontend tests verifying member-row navigation to `/admin/users/:userId`.
- [ ] 6.6 Add frontend tests verifying cumulative and attributed usage are rendered as distinct concepts.

## 7. Verification

- [ ] 7.1 Verify `/admin/teams/:teamId` renders a team summary and member table for a populated team.
- [ ] 7.2 Verify a team with zero members shows the expected empty state.
- [ ] 7.3 Verify sampled-result disclosure appears when the backend marks the member response as limited.
- [ ] 7.4 Verify attributed usage renders when exact `team_id + user_id` attribution is available.
- [ ] 7.5 Verify the UI renders an explicit unavailable state when exact team attribution is not available.
- [ ] 7.6 Verify the UI language never describes cumulative user spend as exact team-attributed spend.
