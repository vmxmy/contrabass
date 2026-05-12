## ADDED Requirements

### Requirement: Role lookup uses a cross-isolate KV cache
The portal SHALL resolve user roles through a three-tier cache: in-isolate memory (≤30 s), Workers KV (≤5 min), and LiteLLM origin; KV writes SHALL be transparent to callers and KV unavailability SHALL fall back silently to memory + origin.

#### Scenario: Two isolates share one origin lookup
- **WHEN** isolate A resolves a role and writes KV, then isolate B resolves the same email within 5 minutes
- **THEN** isolate B MUST read the role from KV
- **AND** isolate B MUST NOT issue a LiteLLM `/user/list` request

#### Scenario: KV outage does not block resolution
- **WHEN** the `ROLE_CACHE_KV` binding throws on read or write
- **THEN** role resolution MUST proceed via memory cache plus LiteLLM origin without raising to the caller
- **AND** the failure MUST be logged once per cooldown window

### Requirement: Admins can invalidate cached roles
The portal SHALL expose `POST /api/admin/roles/invalidate?email=<email>` that clears both memory and KV entries for the target email.

#### Scenario: Admin clears stale role
- **WHEN** an admin posts to `/api/admin/roles/invalidate?email=user@example.com`
- **THEN** the next role lookup for that email MUST hit LiteLLM origin (no cache hit)
- **AND** the API MUST require the admin role gate

### Requirement: External webhook can push role changes
The portal SHALL expose `POST /api/_internal/role-changed` for LiteLLM admin to notify role mutations; the endpoint SHALL authenticate via a shared secret and invalidate the named email.

#### Scenario: Valid webhook invalidates cache
- **WHEN** a request bearing the configured shared-secret invalidates email X
- **THEN** the response MUST be 204
- **AND** subsequent role lookups for X MUST bypass both memory and KV

#### Scenario: Invalid secret rejected
- **WHEN** a request reaches `/api/_internal/role-changed` without a valid secret
- **THEN** the response MUST be 401
- **AND** the cache MUST be untouched
