import type { KVNamespace } from "./types";
import { UserPreferencesSchema, UserPreferencesPatchSchema, type UserPreferences, type UserPreferencesPatch } from "./schemas";

export const GLOBAL_DEFAULTS_KEY = "__global_defaults__";
export const BUDGET_ALERT_KIND = "budget-threshold";

type PreferenceRecord = Record<string, unknown>;

export class KVUserPrefsStore {
  constructor(private readonly kv: KVNamespace | undefined) {}

  async getForEmail(email: string): Promise<UserPreferences> {
    const defaults = await this.getGlobalDefaults();
    if (!this.kv) {
      return defaults;
    }

    const stored = await this.kv.get(await this.preferenceKey(email));
    if (stored === null) {
      return defaults;
    }
    return mergePreferences(defaults, parsePreferencesJson(stored));
  }

  async patchForEmail(email: string, patch: UserPreferencesPatch): Promise<UserPreferences> {
    if (!this.kv) {
      throw new Error("user_prefs_kv_missing");
    }
    const parsedPatch = UserPreferencesPatchSchema.parse(patch);
    const current = await this.getForEmail(email);
    const next = mergePreferences(current, parsedPatch);
    await this.kv.put(await this.preferenceKey(email), JSON.stringify(next));
    return next;
  }

  async getGlobalDefaults(): Promise<UserPreferences> {
    if (!this.kv) {
      return UserPreferencesSchema.parse({});
    }
    const stored = await this.kv.get(GLOBAL_DEFAULTS_KEY);
    if (stored === null) {
      return UserPreferencesSchema.parse({});
    }
    return mergePreferences(UserPreferencesSchema.parse({}), parsePreferencesJson(stored));
  }

  async patchGlobalDefaults(patch: UserPreferencesPatch): Promise<UserPreferences> {
    if (!this.kv) {
      throw new Error("user_prefs_kv_missing");
    }
    const parsedPatch = UserPreferencesPatchSchema.parse(patch);
    const current = await this.getGlobalDefaults();
    const next = mergePreferences(current, parsedPatch);
    await this.kv.put(GLOBAL_DEFAULTS_KEY, JSON.stringify(next));
    return next;
  }

  async hasBudgetAlertForDate(email: string, dateKey: string): Promise<boolean> {
    if (!this.kv) return false;
    return (await this.kv.get(await this.notificationKey(email, BUDGET_ALERT_KIND, dateKey))) !== null;
  }

  async markBudgetAlertForDate(email: string, dateKey: string): Promise<void> {
    if (!this.kv) return;
    await this.kv.put(await this.notificationKey(email, BUDGET_ALERT_KIND, dateKey), JSON.stringify({ sentAt: new Date().toISOString() }), {
      expirationTtl: 60 * 60 * 24 * 45,
    });
  }

  async preferenceKey(email: string): Promise<string> {
    return sha256Hex(normalizeEmail(email));
  }

  private async notificationKey(email: string, kind: string, dateKey: string): Promise<string> {
    return `notification:${kind}:${await this.preferenceKey(email)}:${dateKey}`;
  }
}

export async function sha256Hex(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

function parsePreferencesJson(json: string): PreferenceRecord {
  try {
    const parsed = JSON.parse(json) as unknown;
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function mergePreferences(base: UserPreferences, patch: PreferenceRecord): UserPreferences {
  const notificationsPatch = isRecord(patch.notifications) ? patch.notifications : {};
  return UserPreferencesSchema.parse({
    ...base,
    ...patch,
    notifications: {
      ...base.notifications,
      ...notificationsPatch,
    },
  });
}

function isRecord(value: unknown): value is PreferenceRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
