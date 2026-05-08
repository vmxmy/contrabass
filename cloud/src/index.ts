export { IssueRun } from "./do/issue-run";
import { archiveEventsBatch, type EventArchiveMessage } from "./queues/events-archive";

export interface Env {
  EVENTS_ARCHIVE_BUCKET: R2Bucket;
  EVENTS_ARCHIVE_QUEUE: Queue<EventArchiveMessage>;
}

export function handleRequest(): Response {
  return Response.json(
    {
      service: "contrabass-cloud",
      status: "not_configured",
    },
    { status: 503 },
  );
}

const worker: ExportedHandler<Env, EventArchiveMessage> = {
  fetch() {
    return handleRequest();
  },

  async queue(batch, env) {
    await archiveEventsBatch(batch.messages, env.EVENTS_ARCHIVE_BUCKET);
  },
};

export default worker;
