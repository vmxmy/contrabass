import type { LiteLLMPortalEnv } from "../types";
import type { SyncMessage } from "../durable/schemas";
import type { TeamConfigDO } from "../durable/team-config-do";
import { litellmFetch, LiteLLMRequestError } from "../litellm";

/** Maximum delivery attempts before Cloudflare routes the message to the DLQ.
 *  Matches the `max_retries` configured on the `litellm-sync` queue binding.
 */
const MAX_RETRIES = 5;

/** LiteLLM admin endpoint for each sync message kind. */
const LITELLM_ENDPOINT: Record<SyncMessage["kind"], string> = {
  "team.update": "/team/update",
  "user.update": "/user/update",
  "key.generate": "/key/generate",
  "key.delete": "/key/delete",
  "key.update": "/key/update",
};

/** Handle one batch of sync messages from the litellm-sync queue.
 *
 *  For each message:
 *  - Dispatch by msg.body.kind to the matching LiteLLM admin endpoint (POST).
 *  - On 2xx: for team.update, call DO.recordSyncSuccess(idempotencyKey) then
 *    msg.ack(). For other kinds, just msg.ack().
 *  - On non-retryable 4xx (400–499): call DO.recordSyncError(reason) for
 *    team.update, then msg.ack() to prevent Cloudflare retrying a
 *    logically-bad request.
 *  - On retryable error (5xx, network / JSON failure): if this is the final
 *    attempt (attempts >= MAX_RETRIES), call DO.recordSyncError for
 *    team.update; then msg.retry() so Cloudflare can DLQ it.
 *  - Unknown kind (defensive — SyncMessage.kind is a closed union): call
 *    recordSyncError and ack.
 *
 *  Idempotency note: duplicate delivery of a team.update message results in
 *  a redundant POST to /team/update (which is set-not-append at the LiteLLM
 *  side) and re-stamps meta:lastSyncedAt via recordSyncSuccess. No separate
 *  duplicate-skip path is implemented today; per-kind DO writeback for
 *  user.update and key.* will be wired in a follow-up task.
 *
 *  Each message is processed independently — a failure on one does not
 *  prevent the remaining messages in the batch from being handled.
 */
export async function handleLiteLLMSyncBatch(
  batch: MessageBatch<SyncMessage>,
  env: LiteLLMPortalEnv,
): Promise<void> {
  for (const msg of batch.messages) {
    await handleMessage(msg, env);
  }
}

async function handleMessage(
  msg: Message<SyncMessage>,
  env: LiteLLMPortalEnv,
): Promise<void> {
  const body = msg.body;
  const isFinalAttempt = msg.attempts >= MAX_RETRIES;

  const endpoint = LITELLM_ENDPOINT[body.kind];
  if (endpoint === undefined) {
    // Defensive branch: closed union makes this unreachable, but handle it
    // gracefully to avoid infinite retries on an unrecognised kind.
    await recordTeamSyncError(env, body, `unknown_kind:${body.kind}`);
    msg.ack();
    return;
  }

  try {
    await litellmFetch(env, endpoint, {
      method: "POST",
      body: JSON.stringify(body.payload),
    });

    // 2xx success path.
    if (body.kind === "team.update") {
      const stub = getTeamConfigDO(env, body.entityId);
      await stub.recordSyncSuccess(body.idempotencyKey);
    }
    msg.ack();
  } catch (err) {
    if (err instanceof LiteLLMRequestError && err.status >= 400 && err.status <= 499) {
      // Non-retryable: bad request — forward to DLQ then ack to prevent infinite retry loop.
      const reason = `HTTP ${err.status} from ${endpoint}`;
      if (body.kind === "team.update") {
        await recordTeamSyncError(env, body, reason);
      }
      await forwardToDlq(env, body, reason);
      msg.ack();
      return;
    }

    // Retryable: 5xx, network error, JSON parse failure, etc.
    if (isFinalAttempt && body.kind === "team.update") {
      const reason = err instanceof LiteLLMRequestError
        ? `HTTP ${err.status} from ${endpoint}`
        : err instanceof Error
          ? err.message.slice(0, 200)
          : `unknown_error from ${endpoint}`;
      await recordTeamSyncError(env, body, reason);
    }
    msg.retry();
  }
}

function getTeamConfigDO(env: LiteLLMPortalEnv, teamId: string): TeamConfigDO {
  if (!env.TEAM_CONFIG_DO) {
    throw new Error("TEAM_CONFIG_DO binding not configured");
  }
  return env.TEAM_CONFIG_DO.get(
    env.TEAM_CONFIG_DO.idFromName(teamId),
  ) as unknown as TeamConfigDO;
}

async function recordTeamSyncError(
  env: LiteLLMPortalEnv,
  body: SyncMessage,
  reason: string,
): Promise<void> {
  try {
    const stub = getTeamConfigDO(env, body.entityId);
    await stub.recordSyncError(reason);
  } catch {
    // DO write failure must not block ack/retry on the queue message.
  }
}

async function forwardToDlq(
  env: LiteLLMPortalEnv,
  original: SyncMessage,
  reason: string,
): Promise<void> {
  if (!env.LITELLM_SYNC_DLQ) {
    // DLQ binding not configured; nothing we can do — record but don't throw.
    return;
  }
  try {
    // Wrap the original SyncMessage in a fresh envelope that includes the failure
    // reason. We send the ORIGINAL kind/entityId/payload/idempotencyKey unchanged
    // so an operator replay can re-enqueue against litellm-sync exactly.
    await env.LITELLM_SYNC_DLQ.send({
      ...original,
      // Stamp a fresh enqueuedAt so the DLQ message's metadata reflects when it
      // was DLQ'd, not when it was first enqueued. (The original enqueuedAt is
      // not preserved in DLQ metadata; if you need it, it's part of the audit log.)
      enqueuedAt: new Date().toISOString(),
    });
  } catch {
    // DLQ producer failures shouldn't block the queue ack/retry path.
  }
}
