import type { LiteLLMPortalEnv } from "../types";
import type { SyncMessage } from "../durable/schemas";

export type EnqueueSyncInput = Omit<SyncMessage, "idempotencyKey" | "enqueuedAt"> & {
  /** Optional override; if omitted, derived as `${kind}:${entityId}:${monotonic}`. */
  idempotencyKey?: string;
};

export type EnqueueSyncResult = {
  /** True iff the queue send returned without throwing. */
  delivered: boolean;
  /** The final idempotencyKey used (caller-supplied or derived). */
  idempotencyKey: string;
  /** Set when delivered=false, captures the error reason. */
  error?: string;
};

/** Name of the Cloudflare Queue binding used for LiteLLM sync messages. */
export const LITELLM_SYNC_QUEUE_NAME = "litellm-sync";

/** Enqueue a sync message on the litellm-sync queue.
 *  Returns delivered=true on successful queue send.
 *  Returns delivered=false (NEVER throws) on queue send failure so the
 *  caller can mark the DO row meta:dirty=true and still respond 200.
 *  The DO is already authoritative; queue failures degrade gracefully.
 */
export async function enqueueSync(
  env: LiteLLMPortalEnv,
  input: EnqueueSyncInput,
): Promise<EnqueueSyncResult> {
  const idempotencyKey =
    input.idempotencyKey ?? `${input.kind}:${input.entityId}:${Date.now()}-${crypto.randomUUID()}`;

  if (!env.LITELLM_SYNC_QUEUE) {
    return {
      delivered: false,
      idempotencyKey,
      error: "LITELLM_SYNC_QUEUE binding not configured",
    };
  }

  const message: SyncMessage = {
    kind: input.kind,
    entityId: input.entityId,
    payload: input.payload,
    idempotencyKey,
    enqueuedAt: new Date().toISOString(),
  };

  try {
    await env.LITELLM_SYNC_QUEUE.send(message);
    return { delivered: true, idempotencyKey };
  } catch (err) {
    const raw = err instanceof Error ? err.message : String(err);
    return {
      delivered: false,
      idempotencyKey,
      error: raw.slice(0, 200),
    };
  }
}
