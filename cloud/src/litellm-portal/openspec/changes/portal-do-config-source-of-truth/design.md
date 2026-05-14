## Context

The portal currently uses three external dependencies for identity and configuration:

1. Cloudflare Access validates a `Cf-Access-Jwt-Assertion` header on every request via JWKS, and `/cdn-cgi/access/logout` ends the session. The portal is hardwired to this product through `auth.ts`.
2. Identity (email) and role come from LiteLLM `/user/list`. Role is projected through a three-tier cache: memory → `ROLE_CACHE_KV` → LiteLLM origin.
3. Team / user / role / budget config lives only in LiteLLM. The portal calls LiteLLM admin endpoints synchronously on every admin write (master-key bearer).

The post-change shape inverts (2) and (3) and replaces (1) with a Worker-owned login flow. The LiteLLM proxy itself stays unchanged as the inference data plane. Durable Objects become the single source of truth for desired config; LiteLLM is downgraded to a downstream materialization target plus a spend producer that the portal mirrors.

This change is targeted at a small internal organization (≤500 users, ≤50 teams) on a single email domain. Decisions are scaled to that envelope and are explicit about not overengineering for multi-tenant or external-facing scenarios.

## Goals / Non-Goals

**Goals:**
- Remove every code path that depends on `Cf-Access-*` headers or `/cdn-cgi/access/*` URLs.
- Replace identity with a self-contained email magic-link flow and signed session cookies owned by the Worker.
- Move team / user / role / budget config into Durable Objects partitioned per team plus a singleton index.
- Make every admin write atomically (1) commit to DO and (2) enqueue a sync message; a queue consumer pushes to LiteLLM with retry and a DLQ.
- Mirror spend snapshots from LiteLLM into DO on a ≤60s cadence so the UI never reads spend live.
- Bootstrap a fresh deployment with a one-shot idempotent LiteLLM import seeded into DO and admins seeded from `BOOTSTRAP_ADMIN_EMAILS`.
- Cut over in one maintenance window without dual-running CF Access and DO auth.

**Non-Goals:**
- Replacing the LiteLLM proxy or moving inference traffic through DO.
- Real-time (sub-second) spend. Eventual mirroring with ≤60s staleness is sufficient.
- Per-request DO-side admission control for inference traffic.
- Password login, social SSO, MFA, or any external IdP.
- Workspaces or organizations above team (none exist today; not introduced now).
- Refactoring the in-flight `admin-team-member-usage` / `admin-team-attributed-usage` reads beyond updating their data source.

## Decisions

### 1. Keep LiteLLM as inference data plane; DO is the new control plane
Decision:
- The upstream LiteLLM proxy remains untouched. Inference traffic never touches DO.
- DO owns desired config and mirrored spend; LiteLLM owns actual spend and request execution.

Rationale:
- The user request was explicitly framed as "配置和下发" (configure and push-down), which presupposes a downstream target.
- Keeps scope finite. Replacing LiteLLM is out of band for this change.

Alternatives considered:
- Replace LiteLLM with a Worker + DO inference layer: rejected as far larger than the request.
- Make DO a real-time admission controller in front of LiteLLM: rejected because no latency/availability requirement justifies the cost.

### 2. Auth is email magic-link with signed session cookies
Decision:
- `/login` accepts an email. If the email's domain is in `PORTAL_ALLOWED_EMAIL_DOMAINS`, the Worker emits an HMAC-signed token (`PORTAL_MAGIC_LINK_SECRET`) with a 15-minute TTL and stores the nonce in `IndexDO`.
- `/magic-callback?token=…` verifies the signature, marks the nonce single-use, upserts the user record in `IndexDO`, and issues a signed session cookie (`PORTAL_SESSION_SECRET`, 7d TTL, `HttpOnly; Secure; SameSite=Lax; Path=/`).
- `/logout` clears the cookie and redirects to `/login`.

Rationale:
- No external IdP dependency.
- Smallest credential surface (no passwords, no rotation, no MFA enrollment).
- Matches a small-internal-org operating envelope.

Alternatives considered:
- OIDC to Google/Feishu/Azure: rejected as out of scope; introduces another dependency.
- Username + password: rejected as too much surface for ≤500 users.
- Static bearer or IP allow-list: rejected because the portal serves human admins, not machines.

### 3. Open signup inside an email-domain allow-list; role defaults to `user`
Decision:
- Any email matching `PORTAL_ALLOWED_EMAIL_DOMAINS` can request a magic link.
- On first successful login, `IndexDO` auto-creates `UserRecord { email, userId, role: "user", teamId: null }`.
- Admin role is granted later by an existing admin via the admin UI, or seeded via `BOOTSTRAP_ADMIN_EMAILS`.

Rationale:
- Mirrors today's behavior where domain + explicit allow-list controls admission.
- Avoids an approval queue and a "pending" user state.

Alternatives considered:
- Approval-required signup: rejected as more operational burden than the org needs.
- Import-only (no self-signup): rejected because new hires would need manual provisioning every time.

### 4. DO is authoritative for desired config and mirrors spend snapshots
Decision:
- DO is source of truth for: team metadata, user records, role, budget limits, rpm/tpm limits, model allow-lists, key metadata.
- DO also mirrors spend; a scheduled Worker writes `spend:current` per team every ≤60s.

Rationale:
- Spend is physically generated inside LiteLLM; making it primary in DO would require LiteLLM-side hooks the portal does not own.
- Mirroring lets the UI never depend on LiteLLM uptime for spend display.

Alternatives considered:
- DO is the spend ledger; LiteLLM webhooks back: rejected, requires LiteLLM-side hooks and a high-throughput write path.
- Read spend live from LiteLLM on every page load: rejected, ties UI latency and uptime to LiteLLM.

### 5. DO layout: per-team `TeamConfigDO` + singleton `IndexDO`
Decision:
- `IndexDO` (id `"index"`) holds: team list, `email→user`, `user→team`, magic-link nonces, bootstrap state, audit log.
- `TeamConfigDO` (id = teamId) holds: team metadata, members, keys, spend snapshot, sync metadata (`meta:lastSyncedAt`, `meta:lastSyncError`, `meta:dirty`).

Rationale:
- Per-team partitioning avoids serializing all writes through one DO.
- `IndexDO` gives a single coherent place for cross-team lookups (the magic-link login flow needs to find a user's team without scanning all DOs).

Alternatives considered:
- Single global ConfigDO: rejected because every admin write would serialize through one DO.
- Per-user DO: rejected as overengineered for ≤500 users.
- Entity-typed DOs (UsersDO / TeamsDO / BudgetDO / AuditDO): rejected because cross-entity invariants (deleting a team must orphan its keys/users) become awkward across four transactional boundaries.

### 6. Writes go DO-first, then enqueue, then a consumer pushes LiteLLM with retry + DLQ
Decision:
- Each admin write performs (a) synchronous DO update, (b) `env.LITELLM_SYNC_QUEUE.send({ kind, entityId, payload, idempotencyKey })`, (c) return 200 to the caller.
- Queue consumer dispatches to LiteLLM admin endpoints with up to 5 retries and exponential backoff; on terminal failure, the message is forwarded to a dead-letter queue and `meta:lastSyncError` is written on the corresponding DO row.
- Successful sync updates `meta:lastSyncedAt` on the corresponding DO row.

Rationale:
- Admin UX latency stops depending on LiteLLM availability.
- Drift between DO and LiteLLM is bounded by retry cadence rather than by request-time outcome.
- DLQ surfaces operator-visible sync failures.

Alternatives considered:
- Synchronous DO + synchronous LiteLLM in the same handler: rejected because flapping LiteLLM degrades the admin UX.
- DO-first + best-effort + reconciler cron only (no queue): rejected because retry semantics are weaker and harder to observe.
- A separate sync service Worker as the only LiteLLM writer: rejected as more infra than warranted.

### 7. Bootstrap from `BOOTSTRAP_ADMIN_EMAILS` plus one-shot LiteLLM import
Decision:
- `IndexDO` exposes an `init()` path that runs on first request and is idempotent.
- If `meta:imported` is false: call LiteLLM `/team/list` and `/user/list`, seed `TeamConfigDO`s and `IndexDO` indexes, then set `meta:imported = true`.
- Emails in `BOOTSTRAP_ADMIN_EMAILS` are marked `role = admin` during import (or at first login if absent from LiteLLM).

Rationale:
- Cutover requires DO to be populated before users land.
- An env-var admin guarantees the first login can manage the rest of the org.
- Idempotency lets the import survive partial-progress restarts.

Alternatives considered:
- First-signup-becomes-admin: rejected because it races with legitimate users.
- Manual seeding only: rejected because LiteLLM already has the data we want.
- Greenfield DO (no import): rejected because existing teams and users would be silently abandoned.

### 8. Cutover is single-window, no dual-run
Decision:
- Deploy with `PORTAL_DO_SOT_ENABLED=true` inside a ≤30-minute maintenance window.
- Cloudflare Access policies are detached from the hostname after deploy verification.
- Rollback = redeploy previous build and re-attach the Cloudflare Access policy in the Cloudflare dashboard.

Rationale:
- Two concurrent identity paths (CF Access + magic-link) would require user routing rules and double-writes; the stated org size does not justify the engineering cost.
- A short maintenance window is acceptable for ≤500 users.

Alternatives considered:
- Shadow mode + flag flip: rejected as more machinery than the user wants.
- Multi-region staged rollout: rejected as not relevant to a single-org portal.

### 9. Spend snapshots refresh via a 1-minute scheduled Worker
Decision:
- `scheduled("* * * * *")` walks team IDs from `IndexDO`, calls LiteLLM `/team/info` per team, writes `spend:current` to each `TeamConfigDO`.
- UI reads spend strictly from DO.

Rationale:
- Matches a ≤60s staleness budget.
- Decouples UI latency from upstream.
- Keeps spend writes serialized inside each per-team DO.

Alternatives considered:
- Read spend live on each admin page load: rejected for the reasons above.
- Per-user spend snapshots in addition to per-team: deferred to an open question.

## Risks / Trade-offs

- [LiteLLM extended outage] → admin writes still succeed; sync messages accumulate retries → DLQ alerts after backoff exhaustion. Mitigated by surfacing `lastSyncedAt` and `lastSyncError` per row in the admin UI and treating DLQ depth as an operational signal.
- [DO state corruption] → DO is the only authoritative copy of role/admission state. Mitigated by retaining the LiteLLM import path; a worst-case re-import seeds DO again from LiteLLM.
- [Magic link delivery failure] → users cannot log in. Mitigated by retry on `/login`, clear UX, and a `BOOTSTRAP_ADMIN_EMAILS` operator path to investigate even when mail is broken.
- [Session cookie secret rotation] → invalidates all sessions. Accepted: forced re-login is cheap with magic-link.
- [Import partial-progress] → a crash midway through the one-shot import leaves a half-populated DO. Mitigated by the idempotent init path and a `meta:imported` flag (re-run is safe).
- [Cutover regression] → no dual-run means a broken deploy strands the org. Mitigated by an explicit pre-cutover verification checklist and a documented rollback (redeploy + re-attach CF Access policy).
- [Queue capacity under bulk admin edits] → unlikely at ≤50 teams; if observed, raise consumer concurrency or coalesce by entityId.
- [Drift between DO and LiteLLM going undetected for a stuck message] → mitigated by a periodic reconciliation pass that walks `meta:dirty` rows and re-enqueues; out of MVP scope but tracked as an open question.

## Migration Plan

1. Land schema modules (`durable/schemas.ts`, `types.ts` updates), DO classes (`IndexDO`, `TeamConfigDO`), and the wrangler bindings + DO `new_classes` migration entry. No behavior change yet; new code is unwired.
2. Land magic-link auth (`auth/magic-link.ts`, `auth/session.ts`, `auth/allowlist.ts`), `/login`, `/magic-callback`, `/logout`. Still gated behind `PORTAL_DO_SOT_ENABLED=false`; CF Access still active.
3. Land the queue (`litellm-sync` producer + consumer Worker) and spend cron. Still gated.
4. Land the one-shot LiteLLM importer and the bootstrap admin path.
5. Replace `authenticateRequest` and `requireAdmin` sources of identity/role behind the feature flag. Wire admin write endpoints to DO-first + enqueue. Wire admin reads to DO.
6. Schedule a maintenance window. Flip `PORTAL_DO_SOT_ENABLED=true`, redeploy, allow `IndexDO.init()` to run, smoke-test login + admin write + spend mirror.
7. Detach Cloudflare Access from the hostname in the Cloudflare dashboard.
8. In a follow-up cleanup commit, delete dead CF Access code paths, role-projection paths, and removed env vars from `types.ts`.

Rollback:
- Redeploy the previous build.
- Re-attach the Cloudflare Access policy in the Cloudflare dashboard.
- DO state is left in place; on a subsequent retry, `meta:imported` remains true so init is a no-op.

## Open Questions

- Should the spend snapshot cron also walk user-level spend, or is team-aggregate spend sufficient for the UI as it exists today?
- Should the `IndexDO` audit log be the canonical audit surface, or do we still mirror audit events through LiteLLM `/audit`?
- Should `PORTAL_ALLOWED_EMAIL_DOMAINS` accept multiple domains at launch (multi-tenant readiness), or stay strictly single-domain to match the current envelope?
- Does the DLQ need its own admin surface (replay UI), or is operator inspection via `wrangler queues` enough for the initial cutover?
- Do we need a periodic full-state reconciliation cron (DO → LiteLLM diff scan) for drift detection, or is the per-row `meta:dirty` + DLQ visibility sufficient?
- For new users who self-sign-up before they're attached to a team, what does the portal show them? An "awaiting team assignment" screen, or a read-only personal page?
