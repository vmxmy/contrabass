export { IssueRun } from "./do/issue-run";
export { TeamCoordinator } from "./do/team-coordinator";
import { archiveEventsBatch, type EventArchiveMessage } from "./queues/events-archive";

export interface Env {
  EVENTS_ARCHIVE_BUCKET: R2Bucket;
  EVENTS_ARCHIVE_QUEUE: Queue<EventArchiveMessage>;
  TEAM_COORDINATOR: DurableObjectNamespace;
}

const TEAM_BOARD_ROUTE = /^\/v1\/teams\/([^/]+)\/board$/;
const TEAM_BOARD_REFRESH_ROUTE = /^\/v1\/teams\/([^/]+)\/board\/refresh$/;

export async function handleRequest(request?: Request, env?: Env): Promise<Response> {
  if (request !== undefined && env !== undefined) {
    const response = await routeApiRequest(request, env);
    if (response !== undefined) {
      return response;
    }
  }

  return Response.json(
    {
      service: "contrabass-cloud",
      status: "not_configured",
    },
    { status: 503 },
  );
}

async function routeApiRequest(request: Request, env: Env): Promise<Response | undefined> {
  const url = new URL(request.url);
  const boardMatch = TEAM_BOARD_ROUTE.exec(url.pathname);
  if (request.method === "GET" && boardMatch !== null) {
    return forwardTeamCoordinatorRequest(env, decodeURIComponent(boardMatch[1] ?? ""), "/board", request);
  }

  const refreshMatch = TEAM_BOARD_REFRESH_ROUTE.exec(url.pathname);
  if (request.method === "POST" && refreshMatch !== null) {
    return forwardTeamCoordinatorRequest(env, decodeURIComponent(refreshMatch[1] ?? ""), "/board/refresh", request);
  }

  return undefined;
}

async function forwardTeamCoordinatorRequest(
  env: Env,
  teamId: string,
  coordinatorPath: "/board" | "/board/refresh",
  request: Request,
): Promise<Response> {
  if (teamId.trim() === "") {
    return Response.json({ error: "invalid_team_id" }, { status: 400 });
  }

  const id = env.TEAM_COORDINATOR.idFromName(teamId);
  const stub = env.TEAM_COORDINATOR.get(id);
  const headers = new Headers(request.headers);
  headers.set("x-contrabass-team-id", teamId);

  const body = request.method === "GET" || request.method === "HEAD" ? undefined : await request.arrayBuffer();

  return stub.fetch(new Request(`https://team-coordinator.internal${coordinatorPath}`, {
    method: request.method,
    headers,
    body,
  }));
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
