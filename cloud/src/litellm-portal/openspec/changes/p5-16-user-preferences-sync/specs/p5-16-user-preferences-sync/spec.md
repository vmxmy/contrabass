## ADDED Requirements

### Requirement: User preferences persist server-side
The portal SHALL expose `GET /api/me/preferences` and `PATCH /api/me/preferences` backed by a `USER_PREFS_KV` namespace; preferences SHALL include theme, default tab, default usage window, language, density, and notification toggles.

#### Scenario: Preference change syncs across devices
- **WHEN** the user updates `theme=dark` on device A and reloads the portal on device B
- **THEN** device B MUST render in dark mode without manual toggling
- **AND** the GET endpoint MUST return the new value

#### Scenario: Default values fill missing fields
- **WHEN** the user has no stored preferences yet
- **THEN** the GET endpoint MUST return the schema defaults
- **AND** the response status MUST be 200

### Requirement: Theme preference migrates from localStorage
On first authenticated mount, the client SHALL detect `localStorage["litellm-portal-mode"]`, post the value to `/api/me/preferences`, and clear the localStorage entry.

#### Scenario: Migration runs once
- **WHEN** the user first opens the portal after this change ships and has a `litellm-portal-mode` value in localStorage
- **THEN** the client MUST POST it to the preferences endpoint
- **AND** the localStorage entry MUST be removed
- **AND** subsequent reloads MUST NOT re-trigger the migration

### Requirement: Budget threshold alerts trigger email
A daily Workers Cron Trigger SHALL scan opted-in users; when the user crosses their configured spend ratio (default 0.8 of budget), an email SHALL be sent via MailChannels.

#### Scenario: Cross threshold sends one email
- **WHEN** the cron job runs and finds a user above the threshold for the first time
- **THEN** exactly one email MUST be sent that calendar day
- **AND** the user's notification log MUST record the send

#### Scenario: Below threshold sends nothing
- **WHEN** the cron runs and a user is below the threshold
- **THEN** no email MUST be sent
- **AND** the notification log MUST NOT change for that user
