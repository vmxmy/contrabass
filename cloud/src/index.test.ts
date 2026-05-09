import { describe, expect, it } from "vitest";

import { handleRequest, type Env } from "./index";

describe("cloud worker scaffold", () => {
  it("returns an explicit placeholder response", async () => {
    const response = await handleRequest();

    await expect(response.json()).resolves.toEqual({
      service: "contrabass-cloud",
      status: "not_configured",
    });
    expect(response.status).toBe(503);
  });

  it("forwards team board snapshots to the TeamCoordinator durable object", async () => {
    const seen: { name?: string; url?: string; teamId?: string } = {};
    const env = createEnv(async (request) => {
      seen.url = request.url;
      seen.teamId = request.headers.get("x-contrabass-team-id") ?? undefined;
      return Response.json({ board: { open: [], claimed: [], running: [], done: [] } });
    }, seen);

    const response = await handleRequest(new Request("https://api.test/v1/teams/team-1/board", {
      headers: { authorization: "Bearer test-session" },
    }), envWithAuth(env, "test-session"));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ board: { open: [], claimed: [], running: [], done: [] } });
    expect(seen).toMatchObject({
      name: "team-1",
      url: "https://team-coordinator.internal/board",
      teamId: "team-1",
    });
  });

  it("forwards team board refreshes to the TeamCoordinator durable object", async () => {
    const seen: { name?: string; url?: string; method?: string; body?: unknown; teamId?: string } = {};
    const env = createEnv(async (request) => {
      seen.url = request.url;
      seen.method = request.method;
      seen.body = await request.json();
      seen.teamId = request.headers.get("x-contrabass-team-id") ?? undefined;
      return Response.json({ board: { open: [{ issueRef: "LIN-1", phase: "open", lastUpdated: 1 }], claimed: [], running: [], done: [] } });
    }, seen);

    const response = await handleRequest(new Request("https://api.test/v1/teams/team-1/board/refresh", {
      method: "POST",
      headers: { authorization: "Bearer test-session", "content-type": "application/json" },
      body: JSON.stringify({ issueRef: "LIN-1" }),
    }), envWithAuth(env, "test-session"));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      board: { open: [{ issueRef: "LIN-1", phase: "open", lastUpdated: 1 }], claimed: [], running: [], done: [] },
    });
    expect(seen).toMatchObject({
      name: "team-1",
      url: "https://team-coordinator.internal/board/refresh",
      method: "POST",
      body: { issueRef: "LIN-1" },
      teamId: "team-1",
    });
  });
});

function createEnv(
  fetch: (request: Request) => Promise<Response>,
  seen: { name?: string },
): Env {
  const namespace = {
    idFromName(name: string) {
      seen.name = name;
      return { name };
    },
    get() {
      return { fetch };
    },
  };

  return {
    TEAM_COORDINATOR: namespace,
    ISSUE_RUN: namespace,
    EVENTS_ARCHIVE_BUCKET: {},
    EVENTS_ARCHIVE_QUEUE: {},
  } as unknown as Env;
}

function envWithAuth(env: Env, workerTokens: string): Env {
  return {
    ...env,
    CONTRABASS_WORKER_SESSION_TOKENS: workerTokens,
  };
}
