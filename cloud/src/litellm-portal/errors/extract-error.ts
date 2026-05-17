import { errorMessage } from "./error-messages";

/**
 * Shared error extractor (§F.3). Pulls the server `error` code (or uses the
 * caller's fallback code) and returns the LOCALIZED HUMAN message id via the
 * §F.3 map — never the raw code. Single source for tenant-portal/hooks.ts
 * and ops-console/hooks.ts.
 */
export function extractError(json: unknown, fallbackCode: string): string {
  let code: string = fallbackCode;
  if (json !== null && typeof json === "object" && "error" in json) {
    const v = (json as Record<string, unknown>).error;
    if (typeof v === "string") code = v;
  }
  return errorMessage(code);
}
