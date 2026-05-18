import { litellmFetch, extractRecords } from "../litellm";
import { readJson } from "../utils";
import type { LiteLLMPortalEnv } from "../types";
import type { IdentityMapRecord } from "../durable/schemas";

const PAGE_CAP = 100;

/** Minimal IndexDO surface. Inline to avoid pulling cloudflare:workers into tests. */
type IndexDOStub = {
  getIdentityByEmail(email: string): Promise<IdentityMapRecord | null>;
  putIdentity(record: IdentityMapRecord): Promise<void>;
};

export type IdentityReconcileResult = {
  scanned: number;
  upserted: number;
  /** litellmUserId changed vs. the stored row — surfaced, never auto-rewritten
   *  (rewriting an arbitrary id orphans spend; the hygiene report owns this). */
  drift: Array<{ emailLc: string; from: string; to: string; origin: string }>;
  errors: Array<{ userId: string; reason: string }>;
  limited: boolean;
};

function parseTeams(record: Record<string, unknown>): string[] {
  const src = Array.isArray(record.teams)
    ? record.teams
    : Array.isArray(record.team_ids)
      ? record.team_ids
      : Array.isArray(record.teamIds)
        ? record.teamIds
        : [];
  return (src as unknown[]).filter((t): t is string => typeof t === "string");
}

/**
 * Reconcile the durable identity map against LiteLLM /user/list (paged,
 * bounded). Refreshes litellmUserId / teams / userRole / lastReconciledAt and
 * PRESERVES origin — a "deterministic" or "migrated" row stays that way; only
 * brand-new observations are written as "recorded". Drift (a changed
 * litellmUserId for an existing email) is reported, not auto-applied.
 *
 * Defensive: returns gracefully if bindings are unset. Per-user failures do not
 * abort the scan.
 */
export async function runIdentityReconcile(env: LiteLLMPortalEnv): Promise<IdentityReconcileResult> {
  const result: IdentityReconcileResult = {
    scanned: 0,
    upserted: 0,
    drift: [],
    errors: [],
    limited: false,
  };
  if (!env.INDEX_DO) {
    result.errors.push({ userId: "(global)", reason: "INDEX_DO binding not configured" });
    return result;
  }
  if (!env.LITELLM_BASE_URL?.trim() || !env.LITELLM_MASTER_KEY?.trim()) {
    result.errors.push({ userId: "(global)", reason: "LiteLLM config missing" });
    return result;
  }

  const idx = env.INDEX_DO.get(env.INDEX_DO.idFromName("index")) as unknown as IndexDOStub;

  for (let page = 1; page <= PAGE_CAP; page++) {
    let records: Array<Record<string, unknown>>;
    try {
      const response = await litellmFetch(env, `/user/list?page=${page}`);
      records = extractRecords(await readJson(response));
    } catch (err) {
      result.errors.push({ userId: `(page ${page})`, reason: String(err).slice(0, 120) });
      break;
    }
    if (records.length === 0) break;

    for (const record of records) {
      const userId =
        (typeof record.user_id === "string" && record.user_id.trim().length > 0
          ? record.user_id.trim()
          : typeof record.id === "string" && record.id.trim().length > 0
            ? record.id.trim()
            : "");
      if (userId === "") continue;
      if (typeof record.email !== "string" || record.email.trim().length === 0) {
        result.errors.push({ userId, reason: "user record has no valid email field" });
        continue;
      }
      result.scanned++;
      const emailLc = record.email.trim().toLowerCase();

      try {
        const existing = await idx.getIdentityByEmail(emailLc);
        const drifted = existing != null && existing.litellmUserId !== userId;
        if (drifted) {
          result.drift.push({
            emailLc,
            from: existing.litellmUserId,
            to: userId,
            origin: existing.origin,
          });
        }
        // "recorded" rows mirror LiteLLM reality, so adopt the observed id.
        // "deterministic"/"migrated" rows are the portal's own provisioned id —
        // a divergent /user/list id means a stale duplicate still exists; keep
        // pointing at our id and let the hygiene report flag the duplicate.
        const preserveProvisioned =
          drifted && existing != null && existing.origin !== "recorded";
        await idx.putIdentity({
          emailLc,
          litellmUserId: preserveProvisioned ? existing.litellmUserId : userId,
          teams: parseTeams(record),
          userRole: typeof record.role === "string" ? record.role : null,
          origin: existing?.origin ?? "recorded",
          lastReconciledAt: new Date().toISOString(),
        });
        result.upserted++;
      } catch (err) {
        result.errors.push({ userId, reason: String(err).slice(0, 120) });
      }
    }

    if (page === PAGE_CAP) result.limited = true;
  }

  return result;
}
