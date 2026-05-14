## ADDED Requirements

### Requirement: Email magic-link login replaces Cloudflare Access
The system SHALL authenticate portal users with an email magic-link flow owned by the Worker, with no dependency on Cloudflare Access JWT validation or `/cdn-cgi/access/*` URLs.

#### Scenario: Allowed email requests a magic link
- **WHEN** a user submits an email at `/login` whose domain matches `PORTAL_ALLOWED_EMAIL_DOMAINS`
- **THEN** the server MUST mint an HMAC-signed single-use token with a 15-minute TTL
- **AND** the server MUST store the nonce in `IndexDO` so it can be invalidated on use
- **AND** the server MUST send the magic link via the configured email transport
- **AND** the response MUST NOT disclose whether the email already corresponds to a known user

#### Scenario: Disallowed email attempts to log in
- **WHEN** a user submits an email at `/login` whose domain does not match any entry in `PORTAL_ALLOWED_EMAIL_DOMAINS`
- **THEN** the server MUST reject the request with a 403
- **AND** the server MUST NOT call the email transport
- **AND** the server MUST NOT create or update any DO state

#### Scenario: Magic link callback succeeds
- **WHEN** a user visits `/magic-callback?token=…` with an unexpired, unused, signature-valid token
- **THEN** the server MUST mark the nonce used so a replay of the same link is rejected
- **AND** the server MUST issue a signed session cookie with `HttpOnly`, `Secure`, `SameSite=Lax`, and a 7-day expiry
- **AND** the server MUST redirect the user to `/`

#### Scenario: Magic link callback fails
- **WHEN** the token is expired, tampered, missing, or already used
- **THEN** the server MUST reject the request without issuing a session cookie
- **AND** the UI MUST render an explicit error state that offers a path back to `/login`

### Requirement: Signed session cookie is the only credential the portal accepts
The system SHALL accept ONLY its own signed session cookie as authentication for protected routes, and SHALL NOT read or trust any `Cf-Access-*` header.

#### Scenario: Request with a valid session cookie
- **WHEN** a request arrives carrying a session cookie whose HMAC verifies and whose expiry is in the future
- **THEN** the server MUST treat the request as authenticated for the email/userId encoded in the cookie
- **AND** the server MUST NOT consult any `Cf-Access-*` header in its decision

#### Scenario: Request with a tampered or missing session cookie
- **WHEN** a request to a protected route arrives without a session cookie OR with a cookie that fails HMAC verification OR whose expiry has passed
- **THEN** the server MUST return a 401 response for API routes and redirect to `/login` for page routes
- **AND** the server MUST NOT fall back to any other authentication mechanism

### Requirement: Email allow-list is configurable and case-insensitive
The system SHALL accept one or more email domains in `PORTAL_ALLOWED_EMAIL_DOMAINS` (comma-separated) and SHALL match them case-insensitively.

#### Scenario: Multi-domain allow-list
- **WHEN** `PORTAL_ALLOWED_EMAIL_DOMAINS` is set to `gz-zhiyun.com,partner.example`
- **AND** a user submits an email at `gz-zhiyun.com` or `partner.example`
- **THEN** the server MUST treat the email as eligible for a magic link

#### Scenario: Case-insensitive match
- **WHEN** a user submits `Person@GZ-ZHIYUN.COM`
- **AND** the allow-list contains `gz-zhiyun.com`
- **THEN** the server MUST treat the email as eligible
- **AND** the canonical stored email MUST be lowercase

### Requirement: Logout clears the session and redirects to `/login`
The system SHALL terminate the user's session by clearing the cookie at a Worker-owned `/logout` endpoint and SHALL NOT depend on `/cdn-cgi/access/logout`.

#### Scenario: Logout from an authenticated session
- **WHEN** an authenticated user POSTs to `/logout`
- **THEN** the server MUST emit a `Set-Cookie` header that expires the session cookie immediately
- **AND** the server MUST redirect the user to `/login`
- **AND** the server MUST NOT call any Cloudflare endpoint

### Requirement: Bootstrap admins are seeded from environment
The system SHALL grant `role = admin` to any email listed in `BOOTSTRAP_ADMIN_EMAILS` at the moment that email first successfully completes the magic-link flow.

#### Scenario: Bootstrap admin's first login
- **WHEN** an email listed in `BOOTSTRAP_ADMIN_EMAILS` completes `/magic-callback` and no `UserRecord` exists for that email yet
- **THEN** the server MUST create the `UserRecord` with `role = admin`
- **AND** the server MUST persist this assignment in `IndexDO`
- **AND** the assignment MUST survive removal of the email from `BOOTSTRAP_ADMIN_EMAILS` on subsequent deploys
