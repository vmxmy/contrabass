## ADDED Requirements

### Requirement: Mutation feedback uses kumo Toasty
Success, failure, and warning feedback for any mutation in the portal SHALL be delivered through `Toasty` from `@cloudflare/kumo/components/toasty`; the portal SHALL host a single `<Toasty.Provider>` near the app root.

#### Scenario: Successful key creation toasts
- **WHEN** a create-key mutation resolves with a new key
- **THEN** a success toast MUST appear in the toasty viewport with the configured label
- **AND** the toast MUST auto-dismiss within the kumo default timeout

#### Scenario: Mutation failure toasts with retry
- **WHEN** a delete-key mutation rejects
- **THEN** an error toast MUST appear with the server-provided message
- **AND** the toast MUST expose a retry action that re-runs the mutation

### Requirement: Truncated values expose context via Tooltip
UI elements that truncate strings (email, key alias, long IDs) SHALL provide the full value through `<Tooltip>`; the legacy HTML `title=` attribute on these elements SHALL be removed.

#### Scenario: Hovering truncated email reveals full address
- **WHEN** the user hovers an email rendered with ellipsis
- **THEN** a kumo tooltip MUST display the full email after the configured delay
- **AND** the rendered DOM MUST NOT also carry a `title` attribute

### Requirement: Admin tables expose row actions via DropdownMenu
Admin tables that surface per-row actions SHALL render the action menu through `DropdownMenu` from `@cloudflare/kumo/components/dropdown-menu`.

#### Scenario: User clicks ⋯ to view actions
- **WHEN** the user clicks a row's ⋯ trigger
- **THEN** a kumo DropdownMenu MUST open anchored to that trigger
- **AND** the menu MUST be keyboard navigable (Tab/Enter/Esc)
