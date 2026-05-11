## ADDED Requirements

### Requirement: Strict CSP on portal HTML responses
Every portal HTML response SHALL set a `Content-Security-Policy` header that restricts scripts to `'self'` plus a per-response nonce; the FOUC-prevention inline script SHALL carry that nonce.

#### Scenario: HTML response includes nonce CSP
- **WHEN** an authenticated user requests `/`
- **THEN** the response MUST include a `Content-Security-Policy` header with `script-src 'self' 'nonce-<value>'`
- **AND** the rendered HTML MUST attach the same nonce to its single inline `<script>`

#### Scenario: Production CSP forbids inline without nonce
- **WHEN** the rendered HTML embeds a `<script>` without the response nonce
- **THEN** the browser console MUST report a CSP violation
- **AND** the script MUST NOT execute

### Requirement: Worker secrets resolved from Secret Store
`LITELLM_MASTER_KEY`, `ROLE_INVALIDATION_WEBHOOK_TOKEN`, and any other credentials SHALL be bound through Workers Secret Store; plain `env.*` variables SHALL no longer carry their values.

#### Scenario: Wrangler config references Secret Store
- **WHEN** the portal Wrangler config is parsed
- **THEN** the configuration MUST include `[[secrets_store_secrets]]` bindings for each credential
- **AND** there MUST NOT be a plain `env.LITELLM_MASTER_KEY` declaration in the file

### Requirement: Admin endpoints enforce per-actor rate limits
Each `/api/admin/*` endpoint SHALL be protected by a Durable Object-backed sliding-window rate limiter keyed by actor email plus client IP.

#### Scenario: Burst triggers 429
- **WHEN** an actor exceeds the configured request budget in one window
- **THEN** the response MUST be HTTP 429 with a `Retry-After` header
- **AND** the upstream LiteLLM call MUST be skipped

### Requirement: Master-key fragments cannot leak in responses
The Worker SHALL run a sanitizer middleware that scans every outbound JSON response for `sk-` style master-key fragments; matches SHALL convert the response to 500 and alert observability.

#### Scenario: Sanitizer catches accidental leak
- **WHEN** an admin response unintentionally contains `"key":"sk-..."` substring
- **THEN** the response MUST be replaced with `{"error":"response_blocked"}` HTTP 500
- **AND** the leak attempt MUST be recorded as an alert event
