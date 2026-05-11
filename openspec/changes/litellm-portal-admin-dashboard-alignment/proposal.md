## Why

The LiteLLM portal now has a polished personal dashboard, but the admin dashboard still reads like a stack of management tables. Admin users must switch mental models between personal usage review and global governance, which makes the product feel inconsistent and makes operational signals harder to scan.

Admin should reuse the same dashboard grammar as the user view: overview stats first, usage trend second, resource/access objects third, and audit/risk evidence last. The admin view still needs denser management data, but it should be arranged with the same visual language and one-click time controls.

## What Changes

- Rename the admin/user tabs to `个人视图` and `全局管理`, and default admins to the personal view unless `#admin` is explicitly present.
- Add an admin overview hero with global user, team, spend, budget, role, and risk signals.
- Add a dedicated `/api/admin/summary` endpoint that aggregates bounded global management metrics from existing LiteLLM admin APIs.
- Align the admin usage trend card with the user usage card, including the same one-click preset rail, auto/manual grain chips, chart brush sync, summary tiles, bucket table, and top-model side rail.
- Reframe admin tables into a consistent resource-management section and audit/risk section without changing write permissions.
- Update tests, generated bundle, and documentation so the OpenSpec change is archive-ready.

## Capabilities

### New Capabilities
- `litellm-portal-admin-dashboard-alignment`: Admin dashboard visual hierarchy and data model alignment with the user dashboard.

### Modified Capabilities
- LiteLLM portal admin API adds a read-only summary endpoint behind the existing admin role gate.
- LiteLLM portal React app updates admin tab naming, default tab behavior, and admin usage interactions.

## Impact

- Updates `cloud/src/litellm-portal/admin.ts`, `index.ts`, and `litellm.ts` for admin summary data.
- Updates `cloud/src/litellm-portal/app.tsx` for admin dashboard layout, tab labels/defaults, and usage interaction parity.
- Updates `cloud/src/litellm-portal/app.test.tsx` and `index.test.ts` for UI/data route coverage.
- Regenerates `cloud/src/litellm-portal/app.generated.ts` via the existing build script.
