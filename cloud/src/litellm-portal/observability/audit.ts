import type { AuditEvent } from "../durable/schemas";
import type { LiteLLMPortalEnv } from "../types";

export type AuditPoint = {
  actor: string;
  action: string;
  target: string;
  ip: string;
  ts: string;
};

export type AuditWritePoint = AuditPoint & {
  before: string;
  after: string;
  reason: string;
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

export async function auditWrite(env: LiteLLMPortalEnv, point: AuditWritePoint): Promise<void> {
  if (env.PORTAL_DO_SOT_ENABLED === "true" && env.INDEX_DO) {
    try {
      type IndexDOAuditStub = { appendAudit(event: AuditEvent): Promise<void> };
      const idxStub = env.INDEX_DO.get(env.INDEX_DO.idFromName("index")) as unknown as IndexDOAuditStub;
      const entityKind = point.action.split("_")[1] ?? point.action;
      const auditEvent: AuditEvent = {
        id: crypto.randomUUID(),
        ts: point.ts,
        actorEmail: point.actor,
        action: point.action,
        entityKind,
        entityId: point.target,
        before: point.before,
        after: point.after,
        reason: point.reason || null,
      };
      await idxStub.appendAudit(auditEvent);
    } catch (err) {
      console.error("[audit] IndexDO appendAudit failed:", err);
    }
  }

  if (!env.AUDIT_AE) {
    return;
  }
  env.AUDIT_AE.writeDataPoint({
    blobs: [
      point.actor,
      point.action,
      point.target,
      point.ip,
      point.ts,
      point.before,
      point.after,
      point.reason,
    ],
    doubles: [],
    indexes: [point.actor],
  });
}
