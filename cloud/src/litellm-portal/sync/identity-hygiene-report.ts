// Read-only data-hygiene report over the identity map vs. LiteLLM reality.
// Detects source-data problems no code can safely auto-fix (spelling drift,
// trailing whitespace, orphans, duplicate ids, legacy-only key attribution)
// plus the safe zero-spend migration candidates. Never mutates anything.

import { litellmFetch, extractRecords, firstString } from "../litellm";
import { readJson, isRecord } from "../utils";
import type { LiteLLMPortalEnv } from "../types";
import type { IdentityMapRecord } from "../durable/schemas";
import { canMigrate } from "../identity/migrate-user-id";

const PAGE_CAP = 100;

type IndexDOStub = {
  listIdentities(opts?: { limit?: number; cursor?: string }): Promise<{
    identities: IdentityMapRecord[];
    cursor: string | undefined;
  }>;
};

export type IdentityHygieneReport = {
  generatedAt: string;
  totals: { identities: number; litellmUsers: number };
  /** identity email ≠ the email LiteLLM holds for the same user_id. */
  emailDrift: Array<{ emailLc: string; litellmUserId: string; litellmEmail: string }>;
  /** LiteLLM user_email with surrounding whitespace (e.g. trailing space). */
  trailingWhitespaceEmails: Array<{ litellmUserId: string; rawEmail: string }>;
  /** identity.litellmUserId no longer present in /user/list. */
  orphans: Array<{ emailLc: string; litellmUserId: string }>;
  /** >1 email mapped to the same litellmUserId. */
  duplicateUserIds: Array<{ litellmUserId: string; emails: string[] }>;
  /** zero-spend, zero-key "recorded" rows safe for opt-in migration. */
  migrationCandidates: Array<{ emailLc: string; litellmUserId: string }>;
  /** keys attributable ONLY via the legacy portal_email tier (gates its
   *  removal — must be empty before tier 3 can be deleted). */
  legacyOnlyKeys: Array<{ keyHash: string | null; portalEmail: string }>;
  errors: string[];
};

async function loadAllIdentities(idx: IndexDOStub): Promise<IdentityMapRecord[]> {
  const out: IdentityMapRecord[] = [];
  let cursor: string | undefined;
  for (let i = 0; i < PAGE_CAP; i++) {
    const page = await idx.listIdentities({ limit: 500, ...(cursor ? { cursor } : {}) });
    out.push(...page.identities);
    if (!page.cursor || page.identities.length === 0) break;
    cursor = page.cursor;
  }
  return out;
}

async function loadLiteLLMUsers(
  env: LiteLLMPortalEnv,
  errors: string[],
): Promise<Map<string, { rawEmail: string }>> {
  const byId = new Map<string, { rawEmail: string }>();
  for (let page = 1; page <= PAGE_CAP; page++) {
    let records: Array<Record<string, unknown>>;
    try {
      const resp = await litellmFetch(env, `/user/list?page=${page}`);
      records = extractRecords(await readJson(resp));
    } catch (err) {
      errors.push(`user_list_page_${page}:${String(err).slice(0, 80)}`);
      break;
    }
    if (records.length === 0) break;
    for (const r of records) {
      const uid = firstString(r, ["user_id", "id"]);
      if (uid === undefined) continue;
      const rawEmail = typeof r.email === "string" ? r.email : (firstString(r, ["user_email"]) ?? "");
      byId.set(uid, { rawEmail });
    }
    if (page === PAGE_CAP) errors.push("user_list_truncated_at_page_cap");
  }
  return byId;
}

async function scanLegacyOnlyKeys(
  env: LiteLLMPortalEnv,
  knownUserIds: Set<string>,
  errors: string[],
): Promise<Array<{ keyHash: string | null; portalEmail: string }>> {
  const out: Array<{ keyHash: string | null; portalEmail: string }> = [];
  for (let page = 1; page <= PAGE_CAP; page++) {
    let records: Array<Record<string, unknown>>;
    try {
      const resp = await litellmFetch(env, `/key/list?page=${page}&return_full_object=true`);
      records = extractRecords(await readJson(resp));
    } catch (err) {
      errors.push(`key_list_page_${page}:${String(err).slice(0, 80)}`);
      break;
    }
    if (records.length === 0) break;
    for (const k of records) {
      const merged = isRecord(k.key_info) ? { ...k.key_info, ...k } : k;
      const keyUserId = firstString(merged, ["user_id", "userId"]);
      if (keyUserId !== undefined && knownUserIds.has(keyUserId)) continue;
      const meta = merged.metadata;
      if (!isRecord(meta)) continue;
      if (isRecord(meta.cb_identity)) continue; // has the structured tag
      const portalEmail = firstString(meta, ["portal_email"]);
      if (portalEmail === undefined) continue;
      out.push({
        keyHash: firstString(merged, ["key_hash", "keyHash", "token"]) ?? null,
        portalEmail,
      });
    }
    if (page === PAGE_CAP) errors.push("key_list_truncated_at_page_cap");
  }
  return out;
}

export async function buildIdentityHygieneReport(
  env: LiteLLMPortalEnv,
): Promise<IdentityHygieneReport> {
  const errors: string[] = [];
  const report: IdentityHygieneReport = {
    generatedAt: new Date().toISOString(),
    totals: { identities: 0, litellmUsers: 0 },
    emailDrift: [],
    trailingWhitespaceEmails: [],
    orphans: [],
    duplicateUserIds: [],
    migrationCandidates: [],
    legacyOnlyKeys: [],
    errors,
  };
  if (!env.INDEX_DO) {
    errors.push("INDEX_DO binding not configured");
    return report;
  }

  const idx = env.INDEX_DO.get(env.INDEX_DO.idFromName("index")) as unknown as IndexDOStub;
  const identities = await loadAllIdentities(idx);
  const litellmUsers = await loadLiteLLMUsers(env, errors);
  report.totals = { identities: identities.length, litellmUsers: litellmUsers.size };

  for (const [uid, { rawEmail }] of litellmUsers) {
    if (rawEmail.length > 0 && rawEmail !== rawEmail.trim()) {
      report.trailingWhitespaceEmails.push({ litellmUserId: uid, rawEmail });
    }
  }

  const byUserId = new Map<string, string[]>();
  for (const id of identities) {
    byUserId.set(id.litellmUserId, [...(byUserId.get(id.litellmUserId) ?? []), id.emailLc]);

    const llm = litellmUsers.get(id.litellmUserId);
    if (llm === undefined) {
      report.orphans.push({ emailLc: id.emailLc, litellmUserId: id.litellmUserId });
    } else if (llm.rawEmail.trim().toLowerCase() !== id.emailLc) {
      report.emailDrift.push({
        emailLc: id.emailLc,
        litellmUserId: id.litellmUserId,
        litellmEmail: llm.rawEmail,
      });
    }

    if (id.origin === "recorded") {
      try {
        const gate = await canMigrate(env, id.litellmUserId);
        if (gate.eligible) {
          report.migrationCandidates.push({
            emailLc: id.emailLc,
            litellmUserId: id.litellmUserId,
          });
        }
      } catch (err) {
        errors.push(`canMigrate(${id.litellmUserId}):${String(err).slice(0, 80)}`);
      }
    }
  }
  for (const [uid, emails] of byUserId) {
    if (emails.length > 1) report.duplicateUserIds.push({ litellmUserId: uid, emails });
  }

  report.legacyOnlyKeys = await scanLegacyOnlyKeys(
    env,
    new Set(litellmUsers.keys()),
    errors,
  );

  return report;
}
