// Deterministic business→LiteLLM user_id derivation.
//
// LiteLLM user_id is an arbitrary, non-derivable identifier in existing data
// (slugs, UUIDs, special accounts). For NEW users the portal provisions a
// deterministic id so the email→user_id link no longer depends on a fragile
// per-request resolve. EXISTING users are never rewritten by this — see
// identity/migrate-user-id.ts for the controlled zero-spend path.
//
// The single normalization chokepoint is `normalizeEmail`: every identity join
// keys off its output. This is where the live-data noise is absorbed
// (trailing space on `wangxiaoyi@gz-zhiyun.com `, mixed case). Normalization is
// applied ONLY to the email (the join key) — never to a LiteLLM slug, which is
// opaque and must be compared verbatim.

/** Canonical business join key. Trim + lowercase; collapses the observed
 *  trailing-whitespace / case noise in LiteLLM_UserTable.user_email. */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/** FNV-1a 32-bit over the normalized email. Deterministic, dependency-free,
 *  synchronous (Web Crypto digest is async and overkill for a disambiguator).
 *  The email already guarantees uniqueness; this suffix only disambiguates
 *  slugs that collapse to the same local-part. */
function fnv1a(input: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/**
 * Derive a stable, human-readable, collision-resistant LiteLLM user_id from an
 * email. Shape: `<local-part-slug>-<8-hex>` e.g. `liqingying-3f9a1c20`.
 *
 * Deterministic: same email (modulo trailing space / case) always yields the
 * same id. The hex suffix is derived from the FULL normalized email, so two
 * different emails whose local parts slugify identically still get distinct
 * ids.
 */
export function deterministicUserId(email: string): string {
  const norm = normalizeEmail(email);
  const localPart = norm.split("@")[0] ?? "";
  const slug =
    localPart
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 32) || "user";
  const suffix = fnv1a(norm).toString(16).padStart(8, "0");
  return `${slug}-${suffix}`;
}

/** Special LiteLLM accounts that must never be provisioned, migrated, or
 *  treated as portal users. Observed in live data; comparison is verbatim
 *  against the LiteLLM user_id (not the email). */
export const RESERVED_LITELLM_USER_IDS: ReadonlySet<string> = new Set([
  "admin",
  "default_user_id",
  "agent-app",
]);

export function isReservedLiteLLMUserId(userId: string): boolean {
  return RESERVED_LITELLM_USER_IDS.has(userId.trim());
}
