import { describe, expect, it } from "vitest";

import { handleWorkerRequest, validateAuthPrincipal, type Env } from "./index";

describe("API Worker router auth middleware", () => {
  it("rejects protected routes without validated auth", async () => {
    const cases: Array<{ name: string; headers: HeadersInit }> = [
      { name: "missing", headers: {} },
      { name: "unconfigured bearer", headers: { authorization: "Bearer worker-session" } },
      { name: "wrong bearer", headers: { authorization: "Bearer attacker-token" } },
      { name: "generic session cookie", headers: { cookie: "session=attacker-token" } },
      { name: "wrong dashboard cookie", headers: { cookie: "contrabass_session=attacker-token" } },
      { name: "malformed dashboard cookie", headers: { cookie: "contrabass_session=%E0%A4%A" } },
    ];

    for (const testCase of cases) {
      const response = await handleWorkerRequest(new Request("https://api.test/v1/teams/team-1/board", {
        headers: testCase.headers,
      }), envWithAuth(createEnv(), { dashboardTokens: "dashboard-session" }));

      expect(response.status, testCase.name).toBe(401);
      await expect(response.json(), testCase.name).resolves.toEqual({ error: "unauthorized" });
    }
  });

  it("accepts bearer auth and routes board snapshots to TeamCoordinator", async () => {
    const seen: { name?: string; url?: string; teamId?: string; auth?: string } = {};
    const env = createEnv(async (request) => {
      seen.url = request.url;
      seen.teamId = request.headers.get("x-contrabass-team-id") ?? undefined;
      seen.auth = request.headers.get("authorization") ?? undefined;
      return Response.json({ board: { open: [], claimed: [], running: [], done: [] } });
    }, seen);

    const response = await handleWorkerRequest(new Request("https://api.test/v1/teams/team-1/board", {
      headers: { authorization: "Bearer worker-session" },
    }), envWithAuth(env, { workerTokens: "worker-session" }));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ board: { open: [], claimed: [], running: [], done: [] } });
    expect(seen).toMatchObject({
      name: "team-1",
      url: "https://team-coordinator.internal/board",
      teamId: "team-1",
      auth: "Bearer worker-session",
    });
  });

  it("accepts dashboard session-cookie auth", async () => {
    const response = await handleWorkerRequest(new Request("https://api.test/v1/workers/register", {
      method: "POST",
      headers: { cookie: "contrabass_session=dashboard-session" },
    }), envWithAuth(createEnv(), { dashboardTokens: "dashboard-session" }));

    expect(response.status).toBe(501);
    await expect(response.json()).resolves.toEqual({ error: "not_implemented" });
  });

  it("validates bearer and dashboard cookie principals against configured token stores", async () => {
    const cases = [
      {
        name: "bearer",
        request: new Request("https://api.test/v1/workers/register", {
          headers: { authorization: "Bearer worker-session" },
        }),
        env: envWithAuth(createEnv(), { workerTokens: "worker-session" }),
        expected: { kind: "bearer", token: "worker-session" },
      },
      {
        name: "cookie",
        request: new Request("https://api.test/v1/teams/team-1/board", {
          headers: { cookie: "other=ignored; contrabass_session=dashboard%20session" },
        }),
        env: envWithAuth(createEnv(), { dashboardTokens: JSON.stringify(["dashboard session"]) }),
        expected: { kind: "dashboard-session", token: "dashboard session" },
      },
      {
        name: "missing configured store fails closed",
        request: new Request("https://api.test/v1/workers/register", {
          headers: { authorization: "Bearer worker-session" },
        }),
        env: createEnv(),
        expected: undefined,
      },
      {
        name: "generic session cookie is ignored",
        request: new Request("https://api.test/v1/workers/register", {
          headers: { cookie: "session=dashboard-session" },
        }),
        env: envWithAuth(createEnv(), { dashboardTokens: "dashboard-session" }),
        expected: undefined,
      },
    ];

    for (const testCase of cases) {
      await expect(
        validateAuthPrincipal(testCase.request, testCase.env),
        testCase.name,
      ).resolves.toEqual(testCase.expected);
    }
  });
});

function createEnv(
  fetch: (request: Request) => Promise<Response> = async () => Response.json({ ok: true }),
  seen: { name?: string } = {},
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

function envWithAuth(
  env: Env,
  tokens: { workerTokens?: string; dashboardTokens?: string },
): Env {
  return {
    ...env,
    CONTRABASS_WORKER_SESSION_TOKENS: tokens.workerTokens,
    CONTRABASS_DASHBOARD_SESSION_TOKENS: tokens.dashboardTokens,
  };
}
