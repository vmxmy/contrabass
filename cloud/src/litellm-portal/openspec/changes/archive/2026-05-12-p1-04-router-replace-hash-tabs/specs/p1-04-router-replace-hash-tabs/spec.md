## ADDED Requirements

### Requirement: Portal navigation uses path-based routing
The portal SHALL drive view selection through path-based routing (TanStack Router) instead of URL hash; `/` SHALL render the user view and `/admin` SHALL render the admin overview.

#### Scenario: Deep link opens an admin subpage
- **WHEN** an authenticated admin opens `/admin/audit/<event-id>`
- **THEN** the SSR response MUST render the matching audit-detail page
- **AND** hydration MUST NOT re-route or flash a different page

#### Scenario: Browser back/forward navigates history
- **WHEN** an admin clicks from `/admin/users` to `/admin/users/<id>` and then presses Back
- **THEN** the visible page MUST return to `/admin/users`
- **AND** the URL bar MUST update accordingly

### Requirement: Admin routes are role-guarded at load time
Every route under `/admin` SHALL run a `beforeLoad` gate that resolves the current role; non-admin users SHALL be redirected to `/` before the route component renders.

#### Scenario: Non-admin redirected from /admin
- **WHEN** a user with role `user` navigates to `/admin`
- **THEN** the router MUST redirect to `/` before mounting the admin layout
- **AND** the network MUST NOT issue any `/api/admin/*` request

### Requirement: Legacy hash links redirect once
On first mount, the portal SHALL detect `window.location.hash === "#admin"` and replace it with `/admin` (and remove the hash) to preserve old bookmarks.

#### Scenario: Bookmarked /#admin lands on /admin
- **WHEN** a user opens `/#admin`
- **THEN** the URL MUST be replaced with `/admin` without leaving an extra history entry
- **AND** the admin view MUST render
