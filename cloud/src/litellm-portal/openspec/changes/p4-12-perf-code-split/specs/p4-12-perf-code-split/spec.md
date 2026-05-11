## ADDED Requirements

### Requirement: Admin code splits from user bundle
Admin routes SHALL load through `lazyRouteComponent` so that admin-only modules (admin tables, audit feed, write actions) are absent from the bundle a non-admin user downloads.

#### Scenario: User bundle does not contain admin sources
- **WHEN** the production bundle is analyzed for `/`
- **THEN** the source-map analysis MUST show no `Admin*` component code in the initial chunk
- **AND** the admin chunk MUST be requested only after the user navigates under `/admin`

### Requirement: Static assets served from R2 with immutable caching
Built `portal.[hash].js` and `kumo.[hash].css` artifacts SHALL be uploaded to R2 with `Cache-Control: public, max-age=31536000, immutable`; the Worker SHALL emit HTML referencing the hashed asset URLs and stop embedding the JS/CSS via `embed.FS`-style inlining.

#### Scenario: Asset response carries immutable cache header
- **WHEN** the browser fetches the hashed JS or CSS asset
- **THEN** the response MUST include `Cache-Control: public, max-age=31536000, immutable`
- **AND** the Worker MUST NOT serve those assets directly

#### Scenario: HTML references hashed URL
- **WHEN** the SSR HTML is rendered
- **THEN** every `<link>`/`<script>` for portal assets MUST point to the latest hashed URL
- **AND** the prior un-hashed `/portal.js` and `/kumo.css` URLs MUST 302 to the new asset (or 404 after the deprecation window)

### Requirement: Production source maps stored privately
Production builds SHALL emit external source maps that are uploaded to a private store (R2 + auth, or Sentry); the served HTML SHALL NOT advertise their location.

#### Scenario: Source map exists but is not publicly linked
- **WHEN** the production HTML is inspected
- **THEN** the rendered scripts MUST NOT contain `//# sourceMappingURL=` pointing to a public path
- **AND** the corresponding `.map` MUST be retrievable only with appropriate credentials
