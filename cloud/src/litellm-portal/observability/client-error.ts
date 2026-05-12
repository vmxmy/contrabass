import type { LiteLLMPortalEnv } from "../types";
import { recordAudit } from "./audit";

export type ClientErrorEvent = {
  message: string;
  stack?: string;
  sessionId: string;
  ts: string;
};

export type ClientErrorPayload = {
  events: ClientErrorEvent[];
};

const RATE_LIMIT_MAX = 30;
const RATE_LIMIT_WINDOW_MS = 60 * 1000;

type RateLimitEntry = {
  count: number;
  windowStart: number;
};

const rateLimitStore = new Map<string, RateLimitEntry>();

export function checkClientErrorRateLimit(sessionId: string): boolean {
  const now = Date.now();
  const entry = rateLimitStore.get(sessionId);
  if (entry === undefined || now - entry.windowStart >= RATE_LIMIT_WINDOW_MS) {
    rateLimitStore.set(sessionId, { count: 1, windowStart: now });
    return true;
  }
  if (entry.count >= RATE_LIMIT_MAX) {
    return false;
  }
  entry.count += 1;
  return true;
}

export function recordClientError(env: LiteLLMPortalEnv, event: ClientErrorEvent, ip: string): void {
  recordAudit(env, {
    actor: `session:${event.sessionId}`,
    action: "client_error",
    target: event.message.slice(0, 200),
    ip,
    ts: event.ts,
  });
}

export function _clearRateLimitStoreForTests(): void {
  rateLimitStore.clear();
}
