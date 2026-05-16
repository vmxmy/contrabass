import type { LiteLLMPortalEnv } from "../types";
import type { UsageSource, UsageScope, DashboardGrain } from "../dashboard-schemas";
import { litellmFetch } from "../litellm";
import { readJson } from "../utils";
import { parseDailyActivity, type DailyRow } from "./daily-activity";

const TZ_OFFSET_MIN = 8 * 60; // Asia/Shanghai = UTC+8
const TZ_MS = TZ_OFFSET_MIN * 60 * 1000;
const CACHE_TTL_S = 120;
const FETCH_TIMEOUT_MS = 8000;

export type UsageUnavailable = { kind: "unavailable"; reason: string };

function unavailable(reason: string): UsageUnavailable {
  return { kind: "unavailable", reason };
}

function shDate(ms: number): string {
  return new Date(ms + TZ_MS).toISOString().slice(0, 10);
}

function hashKey(s: string): string {
  // FNV-1a 32-bit — deterministic, non-crypto; edge cacheKey only needs determinism.
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

export class LiteLLMUsageSource implements UsageSource {
  private inflight = new Map<string, Promise<DailyRow[]>>();

  constructor(
    private env: LiteLLMPortalEnv,
    private now: number = Date.now(),
  ) {}

  private async rows(scope: UsageScope, fromMs: number, toMs: number): Promise<DailyRow[]> {
    const start = shDate(fromMs);
    const end = shDate(toMs);
    const isUser = scope.kind === "user";
    const path = isUser ? "/user/daily/activity" : "/user/daily/activity/aggregated";
    const qs = new URLSearchParams({ start_date: start, end_date: end, timezone: String(-TZ_OFFSET_MIN), page_size: "1000" });
    if (isUser) qs.set("user_id", scope.userId);
    const url = `${path}?${qs.toString()}`;
    const cacheKey = `usage:dua:${isUser ? scope.userId : "global"}:${start}:${end}`;

    const existing = this.inflight.get(cacheKey);
    if (existing) return existing;

    const p = (async (): Promise<DailyRow[]> => {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
      try {
        const cacheKeyUrl = `https://cache.invalid/${hashKey(cacheKey)}`;
        // `cf` is a Cloudflare Workers fetch extension not present in the DOM RequestInit
        // type; the cast is the documented way to pass edge-cache directives.
        const resp = await litellmFetch(this.env, url, {
          signal: ctrl.signal,
          cf: { cacheEverything: true, cacheTtl: CACHE_TTL_S, cacheKey: cacheKeyUrl },
        } as RequestInit);
        const body = await readJson(resp);
        const parsed = parseDailyActivity(body);
        if (resp.ok && parsed.length === 0 && body != null
          && (Array.isArray((body as { results?: unknown }).results) ? (body as { results: unknown[] }).results.length > 0 : true)) {
          console.warn("[usage-litellm] ok response parsed to zero rows", { path });
        }
        return parsed;
      } catch (err) {
        if (err && typeof err === "object" && (err as { kind?: string }).kind === "unavailable") throw err;
        const status = (err as { status?: number }).status;
        if (status !== undefined && status >= 400 && status < 500) return []; // 4xx = no data, not a fault
        console.warn("[usage-litellm] fetch failed", { path, err: String(err).slice(0, 120) });
        throw unavailable(String(status ?? (err as Error)?.name ?? "error"));
      } finally {
        clearTimeout(t);
        this.inflight.delete(cacheKey);
      }
    })();

    this.inflight.set(cacheKey, p);
    return p;
  }

  private agg(rows: DailyRow[], fromMs: number, toMs: number) {
    const lo = shDate(fromMs); // half-open: row.date > lo (exclusive lower bound)
    const hi = shDate(toMs);
    let spend = 0, requests = 0, totalTokens = 0;
    for (const r of rows) {
      if (r.date > lo && r.date <= hi) {
        spend += r.spend;
        requests += r.requests;
        totalTokens += r.totalTokens;
      }
    }
    return { spend, requests, totalTokens };
  }

  async queryKpiWithDelta(o: {
    scope: UsageScope;
    currentFromMs: number;
    currentToMs: number;
    previousFromMs: number;
    previousToMs: number;
  }) {
    const rows = await this.rows(
      o.scope,
      // previousFromMs===0 is the "no previous window" sentinel (rollup path);
      // || currentFromMs avoids widening the fetch to 1970. Do NOT switch to ??.
      Math.min(o.previousFromMs || o.currentFromMs, o.currentFromMs),
      o.currentToMs,
    );
    return {
      current: this.agg(rows, o.currentFromMs, o.currentToMs),
      previous: this.agg(rows, o.previousFromMs, o.previousToMs),
    };
  }

  async queryTimeseries(o: { scope: UsageScope; grain: DashboardGrain; fromMs: number; toMs: number }) {
    const rows = await this.rows(o.scope, o.fromMs, o.toMs);
    const lo = shDate(o.fromMs);
    const hi = shDate(o.toMs);
    return rows
      .filter((r) => r.date > lo && r.date <= hi)
      .map((r) => ({
        startMs: Date.parse(`${r.date}T00:00:00.000+08:00`),
        label: r.date.slice(5),
        totalTokens: r.totalTokens,
        requests: r.requests,
        spend: Math.round(r.spend * 1e6) / 1e6,
      }));
  }

  async queryModelBreakdown(o: { scope: UsageScope; fromMs: number; toMs: number }) {
    const rows = await this.rows(o.scope, o.fromMs, o.toMs);
    const lo = shDate(o.fromMs);
    const hi = shDate(o.toMs);
    const acc = new Map<string, { spend: number; totalTokens: number; requests: number }>();
    for (const r of rows) {
      if (r.date <= lo || r.date > hi) continue; // half-open (lo, hi]
      for (const m of r.models) {
        const cur = acc.get(m.model) ?? { spend: 0, totalTokens: 0, requests: 0 };
        cur.spend += m.spend;
        cur.totalTokens += m.totalTokens;
        cur.requests += m.requests;
        acc.set(m.model, cur);
      }
    }
    return [...acc.entries()]
      .map(([model, v]) => ({
        model,
        spend: Math.round(v.spend * 1e6) / 1e6,
        totalTokens: v.totalTokens,
        requests: v.requests,
      }))
      .sort((a, b) => b.spend - a.spend || b.totalTokens - a.totalTokens);
  }
}
