# Cloud Queue Recovery

The `events-archive` Queue archives run events into the `contrabass-events-archive`
R2 bucket. Its consumer retries a failed batch three times and then sends the
messages to the `events-archive-dlq` dead-letter queue.

Cloudflare moves messages to a dead-letter queue after the configured
`max_retries` limit is reached. Without a dead-letter queue, repeatedly failing
messages are discarded. Messages in a dead-letter queue with no active consumer
are retained for four days, so recovery must happen before that window expires.

## When to recover

- Queue backlog grows while the Worker is healthy.
- Worker logs show repeated `archiveEventsBatch` or R2 `put` failures.
- `events-archive-dlq` has messages in the Cloudflare dashboard or Queues API.

## Recovery procedure

1. Stop the failure source before replaying:

   ```sh
   cd cloud
   bunx wrangler queues pause-delivery events-archive
   ```

2. Fix and deploy the queue consumer:

   ```sh
   make cloud-test
   make cloud-deploy-dry
   make cloud-deploy
   ```

3. Pull a small batch from `events-archive-dlq` with the Cloudflare Queues API
   or dashboard. Inspect the first messages and confirm each body still matches
   the `EventArchiveMessage` shape used by `cloud/src/queues/events-archive.ts`.

4. Replay only validated message bodies to `events-archive` with the Queues API
   `POST /accounts/{account_id}/queues/{queue_id}/messages/batch` endpoint.
   Acknowledge the matching DLQ messages only after the push to
   `events-archive` succeeds.

5. Resume the main consumer and watch R2 writes:

   ```sh
   cd cloud
   bunx wrangler queues resume-delivery events-archive
   ```

6. Verify recovery:

   ```sh
   cd cloud
   bunx wrangler queues list
   ```

   Confirm `events-archive-dlq` drains to zero and that new NDJSON objects appear
   under `events/YYYY/MM/DD/HH/` in the `contrabass-events-archive` R2 bucket.

## Safety rules

- Do not purge `events-archive-dlq` until the corresponding R2 archive objects
  are present.
- Replay in small batches first; Queue delivery is at-least-once, so duplicate
  archive records are possible and should be handled during analysis.
- If messages fail again after replay, stop and preserve the remaining DLQ
  messages for debugging instead of repeatedly replaying them.
