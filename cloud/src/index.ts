export { IssueRun } from "./do/issue-run";
export { TeamCoordinator } from "./do/team-coordinator";
import { archiveEventsBatch, type EventArchiveMessage } from "./queues/events-archive";
import { handleWorkerRequest, type Env } from "./worker";

export type { Env } from "./worker";

export async function handleRequest(request?: Request, env?: Env): Promise<Response> {
  if (request !== undefined && env !== undefined) {
    return handleWorkerRequest(request, env);
  }

  return Response.json(
    {
      service: "contrabass-cloud",
      status: "not_configured",
    },
    { status: 503 },
  );
}

const worker: ExportedHandler<Env, EventArchiveMessage> = {
  fetch(request, env) {
    return handleRequest(request, env);
  },

  async queue(batch, env) {
    await archiveEventsBatch(batch.messages, env.EVENTS_ARCHIVE_BUCKET);
  },
};

export default worker;
