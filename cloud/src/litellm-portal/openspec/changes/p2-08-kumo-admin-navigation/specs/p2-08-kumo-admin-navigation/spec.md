## ADDED Requirements

### Requirement: Admin layout uses kumo Sidebar
The admin view SHALL render a left-hand `Sidebar` (from `@cloudflare/kumo/components/sidebar`) containing entries for users, teams, audit, usage, and settings; the main content SHALL appear in the Sidebar inset.

#### Scenario: Sidebar highlights current route
- **WHEN** the admin navigates to `/admin/users`
- **THEN** the Sidebar entry for "用户" MUST be visually marked active
- **AND** other entries MUST NOT carry the active style

#### Scenario: Sidebar collapse persists across reloads
- **WHEN** the admin collapses the sidebar
- **THEN** the collapsed state MUST persist in localStorage
- **AND** subsequent reloads MUST mount the sidebar in the collapsed state

### Requirement: Admin sub-pages show Breadcrumbs
Each admin sub-page SHALL render a kumo `Breadcrumbs` element at the top reflecting the current route segment hierarchy.

#### Scenario: Breadcrumb mirrors route
- **WHEN** the admin is at `/admin/users/<id>`
- **THEN** the breadcrumb MUST read "管理员 / 用户 / <user-display>"
- **AND** each segment except the last MUST be clickable

### Requirement: Command palette opens via ⌘K
The portal SHALL register a global `⌘K` / `Ctrl+K` shortcut that opens a kumo `CommandPalette` listing navigation targets (users, teams, recent audit events) and quick actions (new key, switch theme, logout).

#### Scenario: User triggers palette by shortcut
- **WHEN** the user presses `⌘K` anywhere in the portal
- **THEN** the kumo CommandPalette MUST become visible and focus its input
- **AND** typing MUST filter both navigation items and quick actions
