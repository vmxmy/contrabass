// High-coverage spend attribution via the api_key → key → activity chain.
//
// Raw LiteLLM_SpendLogs.user is null for ~53% of rows, so a plain
// /user/daily/activity?user_id=<slug> query undercounts. Every billable row,
// however, carries an api_key. Resolving the user's keys and summing each
// key's activity recovers the rows the user-scoped query misses. This is the
// attribution / verification layer — the dashboard keeps /user/daily/activity
// as the fast display path; this cross-checks it (reconcile + hygiene).

import type { LiteLLMPortalEnv } from "../types";
import { litellmFetch, listUserKeys, firstString, type KeyOwner } from "../litellm";
import { readJson, isRecord } from "../utils";
import { parseDailyActivity } from "./daily-activity";

export type AttributedSpend = {
  spend: number;
  requests: number;
  totalTokens: number;
  keyCount: number;
  /** Keys whose activity could not be fetched (network/4xx); spend excluded. */
  unresolvedKeys: number;
};

function keyHash(raw: Record<string, unknown>): string | undefined {
  const merged = isRecord(raw.key_info) ? { ...raw.key_info, ...raw } : raw;
  return firstString(merged, ["key_hash", "keyHash", "token", "key", "api_key"]);
}

/**
 * Sum spend across every key owned by `owner` via
 * /user/daily/activity?api_key=<hash>. Per-key failures are counted in
 * `unresolvedKeys` and excluded rather than aborting the whole total.
 */
export async function attributedSpend(
  env: LiteLLMPortalEnv,
  owner: KeyOwner,
): Promise<AttributedSpend> {
  const keyList = await listUserKeys(env, owner);
  const hashes = keyList.keys
    .map((k) => keyHash(k.raw as Record<string, unknown>))
    .filter((h): h is string => typeof h === "string" && h.length > 0);

  let spend = 0;
  let requests = 0;
  let totalTokens = 0;
  let unresolvedKeys = 0;

  for (const hash of hashes) {
    try {
      const qs = new URLSearchParams({ api_key: hash, page_size: "1000" });
      const resp = await litellmFetch(env, `/user/daily/activity?${qs.toString()}`);
      const rows = parseDailyActivity(await readJson(resp));
      for (const r of rows) {
        spend += r.spend;
        requests += r.requests;
        totalTokens += r.totalTokens;
      }
    } catch {
      unresolvedKeys++;
    }
  }

  return {
    spend: Math.round(spend * 1e6) / 1e6,
    requests,
    totalTokens,
    keyCount: hashes.length,
    unresolvedKeys,
  };
}
