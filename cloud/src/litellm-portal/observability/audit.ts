import type { LiteLLMPortalEnv } from "../types";

export type AuditPoint = {
  actor: string;
  action: string;
  target: string;
  ip: string;
  ts: string;
};

export function recordAudit(env: LiteLLMPortalEnv, point: AuditPoint): void {
  if (!env.AUDIT_AE) {
    return;
  }
  env.AUDIT_AE.writeDataPoint({
    blobs: [point.actor, point.action, point.target, point.ip, point.ts],
    doubles: [],
    indexes: [point.actor],
  });
}
