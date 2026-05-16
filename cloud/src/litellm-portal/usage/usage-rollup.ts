import type { LiteLLMPortalEnv } from "../types";
import type { IndexDOLike, UsageRollup, DashboardWindow } from "../dashboard-schemas";
import { DASHBOARD_WINDOWS, WINDOW_SPEC } from "../dashboard-schemas";
import { LiteLLMUsageSource } from "./litellm-usage-source";

export const ROLLUP_KEY = "usage:rollup:v1";
const ROLLUP_TTL_S = 2100; // > the */30 cron period
const ROLLUP_CONCURRENCY = 8;

function indexStub(env: LiteLLMPortalEnv): IndexDOLike | null {
  if (!env.INDEX_DO) return null;
  return env.INDEX_DO.get(env.INDEX_DO.idFromName("index")) as unknown as IndexDOLike;
}

export async function runUsageRollup(env: LiteLLMPortalEnv): Promise<void> {
  const kv = env.USAGE_ROLLUP_KV;
  const index = indexStub(env);
  if (!kv || index === null) return;

  let roster: Array<{ userId: string; maxBudget: number }>;
  try {
    roster = [];
    let cursor: string | undefined;
    do {
      const page = await index.listAllUsers({ limit: 200, cursor });
      for (const u of page.users) roster.push({ userId: u.userId, maxBudget: u.maxBudget ?? 0 });
      cursor = page.cursor;
    } while (cursor !== undefined);
  } catch (err) {
    console.warn("[usage-rollup] roster fetch failed; keeping prior KV", String(err).slice(0, 120));
    return; // do NOT overwrite KV
  }

  const now = Date.now();
  const src = new LiteLLMUsageSource(env, now);
  const out: UsageRollup["users"] = [];

  for (let i = 0; i < roster.length; i += ROLLUP_CONCURRENCY) {
    const chunk = roster.slice(i, i + ROLLUP_CONCURRENCY);
    const results = await Promise.all(chunk.map(async (u) => {
      try {
        const win = {} as Record<DashboardWindow, { spend: number; requests: number; totalTokens: number }>;
        for (const w of DASHBOARD_WINDOWS) {
          const k = await src.queryKpiWithDelta({
            scope: { kind: "user", userId: u.userId },
            currentFromMs: now - WINDOW_SPEC[w].lenMs, currentToMs: now,
            previousFromMs: 0, previousToMs: 0,
          });
          win[w] = k.current;
        }
        return { userId: u.userId, maxBudget: u.maxBudget, win };
      } catch {
        return null; // skip failing user
      }
    }));
    for (const r of results) if (r !== null) out.push(r);
  }

  const rollup: UsageRollup = { generatedAt: new Date(now).toISOString(), users: out };
  await kv.put(ROLLUP_KEY, JSON.stringify(rollup), { expirationTtl: ROLLUP_TTL_S });
}
