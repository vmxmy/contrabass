## Context

The user dashboard has a clear narrative: identity and spend overview, Token usage trend, team/model permissions, then API Keys. The admin dashboard currently exposes tables first, then global usage and audit logs. This satisfies data access but not product coherence.

The approved design direction is to keep the same mental model across personas while increasing density in the admin view:

1. Overview: What is the current global state?
2. Trend: How is usage changing over time?
3. Resources: Which users/teams need management attention?
4. Evidence: What changed recently and what risk is visible?

## Goals / Non-Goals

**Goals:**

- Keep user/admin dashboards visually and cognitively consistent.
- Preserve admin read-only behavior.
- Add bounded global summary metrics that can be computed from existing LiteLLM admin endpoints.
- Give admin usage the same one-click control model and chart/table pairing as personal usage.
- Keep Kumo semantic tokens/components as the visual foundation.

**Non-Goals:**

- Add arbitrary date ranges or new usage API parameters.
- Add write actions for admin resource management.
- Add new LiteLLM dependencies beyond existing admin list endpoints.
- Redesign the portal shell outside the dashboard tabs.

## Decisions

1. **Admin lands on personal view by default**
   - Decision: `#admin` is the only automatic path into global management; otherwise the admin starts on `个人视图`.
   - Rationale: Admins are also users, and the safer default preserves the personal workflow.

2. **Admin summary is server-derived**
   - Decision: Add `/api/admin/summary`, behind the same role gate, using paged user data and team data.
   - Rationale: The hero needs real operational signals, not hard-coded UI placeholders.

3. **Summary remains bounded**
   - Decision: Request up to the LiteLLM admin page-size maximum and expose `limited` when total users exceed the sampled page.
   - Rationale: Avoid expensive unbounded scans while making incomplete aggregate status explicit.

4. **Admin usage reuses user usage mechanics**
   - Decision: Admin usage uses auto/manual grain state, preset rail, brush sync, summary cards, bucket table, and top-model rail.
   - Rationale: One interaction model reduces cognitive load across personal and global views.

5. **Resource and audit cards are grouped after usage**
   - Decision: Place account/team tables under a `资源与权限` section and audit under `审计与风险`.
   - Rationale: Admin precision remains available after the overview and trend context.

## Risks / Trade-offs

| Risk | Mitigation |
|------|------------|
| User aggregates are sampled when there are more than 200 users | Expose a `limited` flag and copy so admins know the hero is a sampled snapshot |
| Additional admin summary fetch increases page load | It is separate from tables and can load independently with skeletons |
| Duplicate controls between user/admin usage drift over time | Reuse shared helper functions and mirror component structure |
| Admin summary risk count is approximate | Calculate from budget/role/team signals and label it as attention items |
