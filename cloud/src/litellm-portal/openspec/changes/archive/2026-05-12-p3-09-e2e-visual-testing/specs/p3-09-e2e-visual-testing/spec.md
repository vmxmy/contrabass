## ADDED Requirements

### Requirement: Critical portal flows have Playwright coverage
The repository SHALL include Playwright specs that exercise login → key creation → key deletion, admin tab switching, admin pagination, and audit-detail deep linking against a `wrangler dev` preview.

#### Scenario: Key lifecycle test passes in CI
- **WHEN** the `portal-e2e` workflow runs
- **THEN** the key-lifecycle Playwright spec MUST pass on chromium
- **AND** the failure artifacts MUST be uploaded on red

#### Scenario: Role guard test fails closed
- **WHEN** the role-guard spec runs and the redirect from `/admin` to `/` does not happen for a non-admin
- **THEN** the spec MUST fail the suite
- **AND** the test MUST not depend on private API responses

### Requirement: Portal compound components have Storybook stories
Each exported compound component (HeroStats, TeamsAccessCard, ApiKeysCard, AdminCard, PortalTabs, HeaderActions) SHALL ship at least three stories covering loading, empty/error, and loaded states.

#### Scenario: Each component story builds
- **WHEN** `storybook build` runs
- **THEN** all declared stories MUST compile without errors
- **AND** kumo CSS MUST be loaded so previews match runtime appearance

### Requirement: Visual regression gates UI changes
The CI pipeline SHALL publish Storybook to a visual-regression service on every PR and SHALL block merge when an unreviewed pixel diff is detected.

#### Scenario: Unreviewed visual diff blocks merge
- **WHEN** a PR introduces a non-baseline pixel diff in any tracked story
- **THEN** the GitHub check MUST report failure
- **AND** the PR MUST link to the diff inspection UI for review
