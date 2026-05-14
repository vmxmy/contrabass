import type { LiteLLMPortalEnv } from "../types";

/** Parse the env var into a normalized lowercase domain array.
 *  Splits on "," and trims whitespace. Returns [] if the var is undefined or empty. */
export function parseAllowedDomains(env: LiteLLMPortalEnv): string[] {
  const raw = env.PORTAL_ALLOWED_EMAIL_DOMAINS;
  if (!raw) {
    return [];
  }
  const seen = new Set<string>();
  const result: string[] = [];
  for (const entry of raw.split(",")) {
    const domain = entry.trim().toLowerCase();
    if (domain && !seen.has(domain)) {
      seen.add(domain);
      result.push(domain);
    }
  }
  return result;
}

/** Returns true iff the email's domain (case-insensitive) appears in
 *  PORTAL_ALLOWED_EMAIL_DOMAINS. Returns false for emails without "@" or
 *  with an empty / unknown domain. */
export function isEmailAllowed(email: string, env: LiteLLMPortalEnv): boolean {
  const atIndex = email.indexOf("@");
  if (atIndex === -1 || atIndex !== email.lastIndexOf("@")) {
    return false;
  }
  const domain = email.slice(atIndex + 1).toLowerCase();
  if (!domain) {
    return false;
  }
  const allowed = parseAllowedDomains(env);
  return allowed.includes(domain);
}
