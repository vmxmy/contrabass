# LiteLLM Usage: Direct + Cache (retire SQLite firehose) — Design

**Date:** 2026-05-16
**Status:** Approved (brainstorming) — pending spec review → implementation plan
**Supersedes:** the SQLite CQRS usage read model (L1/L2 ingest) and the tenant attribution filter (2026-05-16 attribution-filter, commits `9e3c7dc..7bbf639`, deployed `72714451`).

## Problem (evidence)

`ingestSpendLogs` pulls the **global** LiteLLM `/spend/logs/v2` firehose into `cb_usage_events` with a hard `MAX_PAGES=20 × PAGE_SIZE=100 = 2000 rows/tick`, `sort_order=asc`. Measured ground truth (this tenant, 48h window, via `~/.zshrc` creds, browser UA to bypass the Cloudflare bot rule fronting `litellm.ziikoo.com`):

- Global 48h = **147 pages ≈ 14,711 rows**; ~77% is unauthenticated scan/SSRF abuse traffic.
- `laoxu` (= `xu@gz-zhiyun.com`) 48h = **872 requests / $62.85 / 98,112,009 tokens**, latest event ~30 min before now.
- DO SQLite self-scope 48h = **empty (0/0/0)**; most recent `laoxu` event in DO ≈ 8 days old.

The 2000-row/tick ceiling, ascending order, and 94%-non-user traffic mean the ingest cursor cannot keep `cb_usage_events` current → recent personal data is structurally missing. The just-shipped attribution filter cleans *display* of junk but does nothing for *ingest throughput*; it treats a symptom. The `/user/daily/activity` (LiteLLM server-side pre-aggregated) path was always correct — that is why global totals were right while per-user/trend were 0.

Per-user **server-side-filtered** calls are cheap and proven: `/user/daily/activity?user_id=laoxu` = one pre-aggregated call returning per-day `metrics` + per-model `breakdown`; `/spend/logs/v2?user_id=laoxu` = 18 pages/48h (vs 147 global). The fix is to stop pulling the global firehose and read per-user, on demand, cached.

## Locked decisions (from clarifying Q&A)

1. **Degradation = weak.** LiteLLM hiccup → brief loading/empty acceptable. No durable last-known-good availability tier. → pure CF edge cache + in-worker request coalescing; no DO/KV durability tier for the request path.
2. **Day-grain only.** Entire trend/KPI/model path sourced from `/user/daily/activity` (per-user) and `/user/daily/activity/aggregated` (global). No raw `/spend/logs/v2` anywhere. 24h/48h trend = 1–2 day buckets.
3. **Drop `recent` panel** and (consequent on day-grain) **`hourOfDay` heatmap**. Frontend changes; `DashboardResponse` schema loses `recent`/`hourOfDay`.
4. **Admin leaderboard via periodic rollup → KV** (not request-time fan-out, not firehose).
5. **No interim stop-gap.** One-step full redesign; accept continued personal-data loss until it ships.
6. **Rollup store = Cloudflare KV** (`USAGE_ROLLUP_KV`); a DO is overkill.
7. **Approach A**: direct adapter + edge cache + KV rollup; **delete** DO/ingest/attribution entirely. Safety net = git branch + tests + post-deploy revert window (no runtime feature flag).

## Architecture

The seam is `buildDashboard(deps, opts)`'s `deps.usage` interface. A new `LiteLLMUsageSource` implements the subset of that interface that `buildDashboard`/`buildSummary` actually call; orchestration and auth are otherwise unchanged.

```
request → auth → buildDashboard({ usage: LiteLLMUsageSource, index: IndexDO }, opts)
  self/member  → /user/daily/activity?user_id=…           (edge-cached, coalesced)
  global       → /user/daily/activity/aggregated          (edge-cached, coalesced)
  admin perUser/risk → read USAGE_ROLLUP_KV                (no live fan-out)
cron */30      → usageRollupCron: roster → per-user daily/activity → USAGE_ROLLUP_KV
```

### Added

- **`LiteLLMUsageSource`** — implements the `deps.usage` subset:
  | method | source | notes |
  |---|---|---|
  | `queryKpiWithDelta({scope,current*,previous*})` | `/user/daily/activity?user_id=` (self/member) or `/aggregated` (global) | fetch ONE wide window covering current+previous; split by `date` in-worker for `deltaPct` (1 call, not 2) |
  | `queryTimeseries({scope,grain,from,to})` | same response `results[].date` | `grain` always `day` |
  | `queryModelBreakdown({scope,from,to})` | same response `results[].breakdown.models` | accumulate per model |
  | `queryPerUserSeries({topN})` | read `USAGE_ROLLUP_KV` | no live fan-out |
  - `queryHourOfDay`, `queryRecentEvents` are **removed** (not implemented; callers + schema fields + frontend panels deleted).
- **`usageRollupCron`** (`*/30 * * * *`): paginate `IndexDO.listAllUsers` (tens of users), bounded concurrency (R≈8), per-user `/user/daily/activity` (single 30d fetch covering all standard windows), aggregate `{userId, win:{24h,48h,7d,30d}:{spend,requests,totalTokens}, maxBudget}` → write single KV key `usage:rollup:v1` (`{generatedAt, users:[…], rankBySpend}`), `expirationTtl≈2100s`. Any failure → do NOT overwrite prior KV; `console.warn("[usage-rollup] …")`.
- **`USAGE_ROLLUP_KV`** binding in `wrangler.litellm-portal.toml` + `types.ts`.
- Edge caching: `litellmFetch` (or a wrapper) injects `cf:{ cacheEverything:true, cacheTtl≈120, cacheKey }` on the daily/activity subrequests. `cacheKey = sha256("usage:dua:" + (userId||"global") + ":" + startDate + ":" + endDate)` — normalized to Shanghai day boundaries, **never contains the API key**. In-worker `Map<cacheKey, Promise<…>>` collapses concurrent identical fetches (in-flight dedupe).
- `litellmFetch` for these calls gets an **8s timeout** so a slow LiteLLM cannot stall the request path.

### Deleted (full retirement)

- `sync/usage-importer.ts`: `ingestSpendLogs`, cursor handling, v3/v4 mapping sentinels, `resetSpendLogsCursorForMappingMigration`, `loadRegisteredUserIds`.
- `cb_usage_events` table and all event queries: `queryKpiWithDelta` events path, `queryTimeseries`, `queryModelBreakdown`, `queryHourOfDay`, `queryRecentEvents`, `queryPerUserSeries`, `queryUserDetail`.
- Attribution filter (2026-05-16): `attributed` column, `SpendEventSchema.attributed`, `SpendEventInput`, Task 1–4 code + tests.
- `*/5` ingest cron; events branch of retention pruning; **all** `/spend/logs/v2` call sites.
- `UsageDO` class and `USAGE_DO` binding (daily also served via direct/rollup now).
- Frontend: `recent` panel, `hourOfDay` panel; `trend` rendered at day grain.

### Unchanged

- `buildDashboard` orchestration skeleton, `parseDashboardRequest`, window enum, auth middleware, Kumo design language.
- `DashboardResponse.kpi/trend/models/perUser/summary`. `grain` is the constant literal `"day"` and `grainFallback` is the constant `false` (both retained in the schema for shape stability; `parseDashboardRequest`'s grain-autodetect is simplified to always-`day`).
- `buildSummary` population stats via `deps.index` (IndexDO SQL: `listTeams`, `listAllUsers`) — cheap, kept. **Risk probe** changes: per-user `spend > maxBudget` is computed from `USAGE_ROLLUP_KV` instead of a live `usage.queryKpiWithDelta` fan-out.

## Data flow

**Self/member:** resolve `identity.litellmUserId` → `computeWindow(window)` yields `[prevFrom, curTo]` (Asia/Shanghai day boundaries) → one `/user/daily/activity?user_id&start_date&end_date` (edge-cached+coalesced) → parse `results[].{date,metrics,breakdown.models}` → split current/previous by date for `deltaPct`; current dates → `trend` day buckets; current `breakdown.models` accumulated → `models` → `DashboardResponse` (no hourOfDay/recent).

**Admin global/leaderboard:** global kpi/trend/models ← `/user/daily/activity/aggregated` (same cache mechanism); `perUser` ← `USAGE_ROLLUP_KV`; `buildSummary` population ← IndexDO SQL; `riskCount` ← iterate KV rollup entries where window spend > maxBudget.

**Cron `usageRollupCron`:** `ctx.waitUntil` → paginate roster → chunked concurrency per-user daily/activity (30d) → slice per window → write `usage:rollup:v1` KV; failure preserves prior KV.

## Error handling / degradation

| scenario | behavior |
|---|---|
| edge cache hit | return, zero origin |
| miss, LiteLLM 200 | parse, populate edge cache |
| LiteLLM 5xx / timeout(>8s) / network | panel `available:false` + empty; HTTP 200 (never 5xx); FE shows retry |
| LiteLLM 200, unexpected shape | `available:false`; `console.warn("[usage-litellm] unexpected shape")` |
| LiteLLM 4xx / no data for user | `available:true, empty:true` (legit empty, distinct from fault) |
| rollup: one user fails | skip that user, others proceed; absent from leaderboard |
| rollup: whole run fails | keep prior KV; admin sees stale + `generatedAt` |
| KV missing (first deploy, cron not yet run) | admin perUser/risk empty + `available:false`; self direct unaffected |
| `LITELLM_*` config missing | existing `litellm_config_missing` 500 branch unchanged |

**Invariants:** request path never returns 5xx due to LiteLLM (except pre-existing `config_missing`); request path never calls raw `/spend/logs/v2`; `cacheKey` never contains the API key.

## Testing strategy

- `LiteLLMUsageSource` unit (mock `litellmFetch`): normal daily/activity → kpi/trend/models; current/previous date split + deltaPct; empty results → `empty:true`; 5xx / timeout / bad-shape → `available:false` (three distinct assertions); cacheKey normalization + no-key-in-key; in-flight dedupe (concurrent same key → origin call count == 1).
- `usageRollupCron` unit: roster pagination; concurrency bound; one-user failure skips rest; whole-run failure does NOT call `KV.put`; KV schema shape.
- `buildDashboard` integration: inject `LiteLLMUsageSource` + mock index; reuse `dashboard.test.ts` skeleton; assert `DashboardResponse` without hourOfDay/recent; admin path reads KV stub.
- Contract regression: `DashboardResponseSchema` change → frontend consumers tsc-clean.
- Deletion verification: repo-wide grep asserts no `/spend/logs/v2`, no `cb_usage_events`, no `attributed`; tsc only baseline `server.ts(6,33)`.
- Post-deploy smoke (browser-harness): self 48h returns real `laoxu` data, cross-checked against measured LiteLLM ground truth ($62.85 / 872 / 98.1M tokens for the same window).

## Risks / open items

- `/user/daily/activity` per-user filter + per-model breakdown shape **confirmed** by live probe (2026-05-16). Hour-grain LiteLLM endpoint not confirmed → explicitly out of scope (day-grain accepted).
- Cloudflare bot rule fronts `litellm.ziikoo.com` (error 1010 for non-browser UA). The Worker→LiteLLM subrequest from CF edge is the master-key path that already works in production; edge caching must not strip `Authorization` before origin (cache the response by `cacheKey`; send auth on the miss-fetch).
- CF subrequest cache is per-colo; acceptable under the weak-degradation decision.
- Window/date boundary must use Asia/Shanghai business day to match the existing KPI semantics and avoid a totals drift on cutover.
- Sunk cost: the attribution filter (deployed `72714451`) becomes dead code and is deleted here; do not retain a wrong mechanism for recency's sake.
