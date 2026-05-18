// Controlled, opt-in migration of an EXISTING LiteLLM user_id to the
// business-deterministic id. LiteLLM has no user_id-rename API and user_id is
// the join key across VerificationToken / DailyUserSpend / SpendLogs.user /
// members_with_roles — so a rewrite (delete + recreate) ORPHANS all historical
// spend. Therefore migration is gated to the zero-spend AND zero-key subset,
// reserved accounts are hard-excluded, and ordering is create-new → repoint
// identity → delete-old so a mid-flight failure never loses the old id.
//
// Never invoked automatically. The admin route supplies the identity store and
// audit sink and decides batching.

import type { LiteLLMPortalEnv } from "../types";
import type { IdentityMapRecord } from "../durable/schemas";
import { listUserKeys, litellmFetch, provisionLiteLLMUser, deleteUserById } from "../litellm";
import { readJson } from "../utils";
import { parseDailyActivity } from "../usage/daily-activity";
import { isReservedLiteLLMUserId, normalizeEmail } from "./derive-user-id";

export type MigrationGate = { eligible: boolean; reason: string };

export interface IdentityStore {
  putIdentity(record: IdentityMapRecord): Promise<void>;
}

export type MigrationResult = {
  oldUserId: string;
  newUserId: string;
  emailLc: string;
};

/**
 * Eligible only if the current LiteLLM user has ZERO keys AND ZERO spend, and
 * is not a reserved account. Any signal of history → ineligible (fail-closed:
 * any error resolving the signals is treated as "not safe to migrate").
 */
export async function canMigrate(
  env: LiteLLMPortalEnv,
  currentUserId: string,
): Promise<MigrationGate> {
  const id = currentUserId.trim();
  if (id.length === 0) return { eligible: false, reason: "empty_user_id" };
  if (isReservedLiteLLMUserId(id)) return { eligible: false, reason: "reserved_account" };

  let keyCount: number;
  try {
    const keys = await listUserKeys(env, { litellmUserId: id });
    keyCount = keys.keys.length;
  } catch (err) {
    return { eligible: false, reason: `key_check_failed:${String(err).slice(0, 80)}` };
  }
  if (keyCount > 0) return { eligible: false, reason: `has_${keyCount}_keys` };

  let spend = 0;
  try {
    const qs = new URLSearchParams({ user_id: id, page_size: "1000" });
    const resp = await litellmFetch(env, `/user/daily/activity?${qs.toString()}`);
    const rows = parseDailyActivity(await readJson(resp));
    spend = rows.reduce((acc, r) => acc + r.spend, 0);
  } catch (err) {
    return { eligible: false, reason: `spend_check_failed:${String(err).slice(0, 80)}` };
  }
  if (spend > 0) return { eligible: false, reason: `has_spend:${spend}` };

  return { eligible: true, reason: "zero_keys_zero_spend" };
}

/**
 * Repoint an eligible user to the deterministic id. Order is strict:
 *   1. canMigrate gate (re-checked here — never trust a stale gate)
 *   2. POST /user/new with the deterministic id
 *   3. repoint the identity map (origin: "migrated")
 *   4. POST /user/delete on the old id
 * If step 4 fails the new user + identity already point correctly; the stale
 * old row is reported by the hygiene job, not silently retried here.
 */
export async function migrateUserId(
  env: LiteLLMPortalEnv,
  email: string,
  currentUserId: string,
  store: IdentityStore,
  changedBy?: string,
): Promise<MigrationResult> {
  const emailLc = normalizeEmail(email);
  const gate = await canMigrate(env, currentUserId);
  if (!gate.eligible) {
    throw new Error(`migrate_ineligible:${gate.reason}`);
  }

  const provisioned = await provisionLiteLLMUser(env, emailLc, {}, changedBy);

  await store.putIdentity({
    emailLc,
    litellmUserId: provisioned.litellmUserId,
    teams: [],
    userRole: null,
    origin: "migrated",
    lastReconciledAt: new Date().toISOString(),
  });

  await deleteUserById(env, currentUserId, changedBy);

  return {
    oldUserId: currentUserId,
    newUserId: provisioned.litellmUserId,
    emailLc,
  };
}
