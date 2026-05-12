## ADDED Requirements

### Requirement: API contracts validated by Zod schemas
The portal SHALL define every API request and response shape as a Zod schema and SHALL validate payloads at both the Worker boundary and the client boundary.

#### Scenario: Worker rejects malformed inbound payload
- **WHEN** a write endpoint receives a body that fails Zod parse
- **THEN** the response MUST be HTTP 422 with an error code derived from the failing path
- **AND** no upstream LiteLLM call MUST be made

#### Scenario: Client rejects malformed upstream response
- **WHEN** a query hook receives an API response whose JSON fails its Zod schema
- **THEN** the hook MUST surface the validation error to the caller as an error state
- **AND** the response data MUST NOT be cached under the matching query key

### Requirement: Hono RPC client provides typed access
The portal SHALL expose its public API through a Hono application whose typed client (`hc<AppType>`) is the only HTTP entry point used by the React app.

#### Scenario: Client call returns inferred types
- **WHEN** application code calls `client.api.dashboard.$get()`
- **THEN** the returned promise type MUST mirror the server-side schema
- **AND** TypeScript MUST refuse code that reads fields not declared in the schema

### Requirement: TanStack Query manages client-side data
The portal SHALL fetch, cache, and invalidate all dashboard, admin, and user data via TanStack Query hooks; component-local `fetch` + `useEffect` for data is prohibited.

#### Scenario: Two components share one dashboard request
- **WHEN** two mounted components both call `useDashboard()` on the same page
- **THEN** the network MUST see only one `/api/dashboard` request during the active `staleTime` window
- **AND** both components MUST receive the same data reference

#### Scenario: Mutation invalidates affected queries
- **WHEN** a create-key mutation succeeds
- **THEN** the `["dashboard"]` and `["keys"]` query keys MUST be invalidated
- **AND** subsequent reads MUST refetch
