## 1. OpenSpec setup

- [x] 1.1 Create proposal, design, spec, and task artifacts for admin dashboard alignment.
- [x] 1.2 Validate the change is apply-ready before implementation.

## 2. Admin data model

- [x] 2.1 Add a role-gated `/api/admin/summary` endpoint with global user/team/spend/budget/risk metrics.
- [x] 2.2 Add tests for admin summary success, role gate inclusion, and bounded aggregate behavior.

## 3. Dashboard interaction and layout

- [x] 3.1 Rename tabs to `个人视图` / `全局管理` and default admins to personal view unless `#admin` is explicit.
- [x] 3.2 Add admin overview hero cards that use Kumo semantic components/tokens and real summary data.
- [x] 3.3 Align admin global usage with the user usage panel interaction model, including auto grain, brush sync, summary tiles, bucket table, and top-model rail.
- [x] 3.4 Reframe admin tables into `资源与权限` and `审计与风险` sections while preserving read-only admin operations.

## 4. Verification and documentation

- [x] 4.1 Update React tests for admin tab labels/defaults, admin summary cards, and admin usage parity.
- [x] 4.2 Regenerate the LiteLLM portal app bundle.
- [x] 4.3 Run targeted LiteLLM portal tests and build checks.
- [x] 4.4 Validate the OpenSpec change strictly so it is archive-ready.
