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
      await expect(response.json(), testCase.name).resolves.toEqual({
        error: "unauthorized",
        protocol_version: "1.0.0",
      });
    }
  });

  it("adds the API version header to generated, forwarded, and not-found responses", async () => {
    const cases: Array<{
      name: string;
      request: Request;
      env: Env;
      expectedStatus: number;
    }> = [
      {
        name: "generated auth error",
        request: new Request("https://api.test/v1/teams/team-1/board"),
        env: createEnv(),
        expectedStatus: 401,
      },
      {
        name: "forwarded upstream response",
        request: new Request("https://api.test/v1/teams/team-1/board", {
          headers: { authorization: "Bearer worker-session" },
        }),
        env: envWithAuth(createEnv(async () => Response.json({ forwarded: true })), {
          workerTokens: "worker-session",
        }),
        expectedStatus: 200,
      },
      {
        name: "not found",
        request: new Request("https://api.test/v1/unknown", {
          headers: { authorization: "Bearer worker-session" },
        }),
        env: envWithAuth(createEnv(), { workerTokens: "worker-session" }),
        expectedStatus: 404,
      },
    ];

    for (const testCase of cases) {
      const response = await handleWorkerRequest(testCase.request, testCase.env);

      expect(response.status, testCase.name).toBe(testCase.expectedStatus);
      expect(response.headers.get("x-contrabass-api-version"), testCase.name).toBe("1.0.0");
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

  it("forwards board mutation posts to TeamCoordinator", async () => {
    const seen: Array<{
      name?: string;
      url: string;
      method: string;
      teamId?: string;
      contentType?: string;
      body: unknown;
    }> = [];
    const env = createEnv(async (request) => {
      seen.push({
        url: request.url,
        method: request.method,
        teamId: request.headers.get("x-contrabass-team-id") ?? undefined,
        contentType: request.headers.get("content-type") ?? undefined,
        body: await request.json(),
      });
      return Response.json({ forwarded: true }, { status: 202 });
    }, {});
    const cases = [
      { path: "refresh", body: { entries: [{ issueRef: "LIN-1", phase: "open" }] } },
      { path: "reassign-run", body: { runId: "run-1", targetWorkerId: "worker-2" } },
      { path: "cancel-run", body: { runId: "run-1" } },
      { path: "pause", body: {} },
      { path: "resume", body: {} },
    ];

    for (const testCase of cases) {
      const response = await handleWorkerRequest(new Request(
        `https://api.test/v1/teams/team-1/board/${testCase.path}?audit=1`,
        {
          method: "POST",
          headers: { authorization: "Bearer worker-session", "content-type": "application/json" },
          body: JSON.stringify(testCase.body),
        },
      ), envWithAuth(env, { workerTokens: "worker-session" }));

      expect(response.status, testCase.path).toBe(202);
      await expect(response.json(), testCase.path).resolves.toEqual({ forwarded: true });
    }

    expect(seen).toEqual(cases.map((testCase) => ({
      url: `https://team-coordinator.internal/board/${testCase.path}?audit=1`,
      method: "POST",
      teamId: "team-1",
      contentType: "application/json",
      body: testCase.body,
    })));
  });

  it("forwards run ack, heartbeat, events, and complete posts to IssueRun", async () => {
    const seen: Array<{
      name?: string;
      url: string;
      method: string;
      body: string;
      teamId?: string;
      runId?: string;
      contentType?: string;
    }> = [];
    const env = createEnv(async (request) => {
      if (request.url === "https://team-coordinator.internal/board") {
        return Response.json({
          board: {
            open: [],
            claimed: [],
            running: [{ issueRef: "run-1", runId: "run-1", phase: "running", lastUpdated: 1 }],
            done: [],
          },
        });
      }

      seen.push({
        url: request.url,
        method: request.method,
        body: await request.text(),
        teamId: request.headers.get("x-contrabass-team-id") ?? undefined,
        runId: request.headers.get("x-contrabass-run-id") ?? undefined,
        contentType: request.headers.get("content-type") ?? undefined,
      });
      return Response.json({ forwarded: true }, { status: 202 });
    }, {});

    const cases = [
      {
        name: "ack",
        path: "ack",
        contentType: "application/json",
        body: JSON.stringify({ accept: true, protocol_version: "1.0.0" }),
      },
      {
        name: "heartbeat",
        path: "heartbeat",
        contentType: "application/json",
        body: JSON.stringify({ lastEventTs: 1_771_000_000_000, protocol_version: "1.0.0" }),
      },
      {
        name: "events",
        path: "events",
        contentType: "application/x-ndjson",
        body: "{\"ts\":1771000000000,\"kind\":\"log\",\"payload\":{\"message\":\"ok\"},\"protocol_version\":\"1.0.0\"}\n",
      },
      {
        name: "complete",
        path: "complete",
        contentType: "application/json",
        body: JSON.stringify({
          status: "failed",
          summary: "tests failed",
          errorClass: "tests_failed",
          artifactKeys: {},
          finalConfigHash: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          protocol_version: "1.0.0",
        }),
      },
    ];

    for (const testCase of cases) {
      const response = await handleWorkerRequest(new Request(`https://api.test/v1/runs/run-1/${testCase.path}`, {
        method: "POST",
        headers: {
          authorization: "Bearer worker-session",
          "content-type": testCase.contentType,
          "x-contrabass-team-id": "team-1",
        },
        body: testCase.body,
      }), envWithAuth(env, { workerTokens: "worker-session" }));

      expect(response.status, testCase.name).toBe(202);
      await expect(response.json(), testCase.name).resolves.toEqual({ forwarded: true });
    }

    expect(seen).toEqual(cases.map((testCase) => ({
      url: `https://issue-run.internal/${testCase.path}`,
      method: "POST",
      body: testCase.body,
      teamId: "team-1",
      runId: "run-1",
      contentType: testCase.contentType,
    })));
  });

  it("normalizes forwarded protocol errors with protocol_version", async () => {
    const env = createSplitEnv(
      async () => Response.json({
        board: {
          open: [],
          claimed: [],
          running: [{ issueRef: "LIN-1", runId: "run-1", phase: "running", lastUpdated: 1 }],
          done: [],
        },
      }),
      async () => Response.json({
        error: "events_too_large",
        max_events: 200,
        max_bytes: 524288,
      }, { status: 413 }),
    );

    const response = await handleWorkerRequest(new Request("https://api.test/v1/runs/run-1/events", {
      method: "POST",
      headers: {
        authorization: "Bearer worker-session",
        "content-type": "application/x-ndjson",
        "x-contrabass-team-id": "team-1",
      },
      body: "{\"ts\":1771000000000,\"kind\":\"log\",\"payload\":{\"message\":\"too large\"},\"protocol_version\":\"1.0.0\"}\n",
    }), envWithAuth(env, { workerTokens: "worker-session" }));

    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toEqual({
      error: "events_too_large",
      max_events: 200,
      max_bytes: 524288,
      protocol_version: "1.0.0",
    });
  });

  it("maps malformed forwarded errors to upstream_error with protocol_version", async () => {
    const cases: Array<{
      name: string;
      upstream: Response;
      expectedStatus: number;
    }> = [
      {
        name: "non-json upstream error",
        upstream: new Response("service unavailable", { status: 503 }),
        expectedStatus: 503,
      },
      {
        name: "json upstream error without protocol error code",
        upstream: Response.json({ message: "bad gateway" }, { status: 502 }),
        expectedStatus: 502,
      },
    ];

    for (const testCase of cases) {
      const env = createEnv(async () => testCase.upstream.clone());
      const response = await handleWorkerRequest(new Request("https://api.test/v1/teams/team-1/board", {
        headers: { authorization: "Bearer worker-session" },
      }), envWithAuth(env, { workerTokens: "worker-session" }));

      expect(response.status, testCase.name).toBe(testCase.expectedStatus);
      await expect(response.json(), testCase.name).resolves.toEqual({
        error: "upstream_error",
        protocol_version: "1.0.0",
      });
      expect(response.headers.get("x-contrabass-api-version"), testCase.name).toBe("1.0.0");
    }
  });

  it("forwards worker long-poll dispatch requests to TeamCoordinator", async () => {
    const seen: { name?: string; url?: string; method?: string; teamId?: string; workerId?: string } = {};
    const env = createEnv(async (request) => {
      seen.url = request.url;
      seen.method = request.method;
      seen.teamId = request.headers.get("x-contrabass-team-id") ?? undefined;
      seen.workerId = request.headers.get("x-contrabass-worker-id") ?? undefined;
      return Response.json({
        type: "dispatch",
        protocol_version: "1.0.0",
        runId: "run-1",
        issueRef: "LIN-1",
        workerId: "worker-1",
      });
    }, seen);

    const response = await handleWorkerRequest(new Request(
      "https://api.test/v1/workers/worker-1/dispatch?wait=25s",
      {
        headers: {
          authorization: "Bearer worker-session",
          "x-contrabass-team-id": "team-1",
        },
      },
    ), envWithAuth(env, { workerTokens: "worker-session" }));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      type: "dispatch",
      protocol_version: "1.0.0",
      runId: "run-1",
      issueRef: "LIN-1",
      workerId: "worker-1",
    });
    expect(seen).toEqual({
      name: "team-1",
      url: "https://team-coordinator.internal/workers/worker-1/dispatch?wait=25s",
      method: "GET",
      teamId: "team-1",
      workerId: "worker-1",
    });
  });

  it("forwards dashboard websocket subscribe upgrades to TeamCoordinator", async () => {
    const seen: { name?: string; url?: string; method?: string; teamId?: string; upgrade?: string } = {};
    const env = createEnv(async (request) => {
      seen.url = request.url;
      seen.method = request.method;
      seen.teamId = request.headers.get("x-contrabass-team-id") ?? undefined;
      seen.upgrade = request.headers.get("upgrade") ?? undefined;
      return new Response(null, { status: 200, headers: { "x-upstream-websocket": "accepted" } });
    }, seen);

    const response = await handleWorkerRequest(new Request(
      "https://api.test/v1/teams/team-1/subscribe?last_event_id=42",
      {
        headers: {
          cookie: "contrabass_session=dashboard-session",
          upgrade: "websocket",
        },
      },
    ), envWithAuth(env, { dashboardTokens: "dashboard-session" }));

    expect(response.status).toBe(200);
    expect(response.headers.get("x-upstream-websocket")).toBe("accepted");
    expect(seen).toEqual({
      name: "team-1",
      url: "https://team-coordinator.internal/subscribe?last_event_id=42",
      method: "GET",
      teamId: "team-1",
      upgrade: "websocket",
    });
  });

  it("forwards worker dispatch websocket upgrades to TeamCoordinator subscriptions", async () => {
    const seen: { name?: string; url?: string; method?: string; teamId?: string; workerId?: string; upgrade?: string } = {};
    const env = createEnv(async (request) => {
      seen.url = request.url;
      seen.method = request.method;
      seen.teamId = request.headers.get("x-contrabass-team-id") ?? undefined;
      seen.workerId = request.headers.get("x-contrabass-worker-id") ?? undefined;
      seen.upgrade = request.headers.get("upgrade") ?? undefined;
      return new Response(null, { status: 200, headers: { "x-upstream-websocket": "accepted" } });
    }, seen);

    const response = await handleWorkerRequest(new Request(
      "https://api.test/v1/workers/worker-1/dispatch-ws",
      {
        headers: {
          authorization: "Bearer worker-session",
          "x-contrabass-team-id": "team-1",
          upgrade: "websocket",
        },
      },
    ), envWithAuth(env, { workerTokens: "worker-session" }));

    expect(response.status).toBe(200);
    expect(response.headers.get("x-upstream-websocket")).toBe("accepted");
    expect(seen).toEqual({
      name: "team-1",
      url: "https://team-coordinator.internal/subscribe?workerId=worker-1",
      method: "GET",
      teamId: "team-1",
      workerId: "worker-1",
      upgrade: "websocket",
    });
  });

  it("routes run forwards through IssueRun named by team and issueRef", async () => {
    const seen: { teamName?: string; issueRunName?: string } = {};
    const env = createSplitEnv(
      async () => Response.json({
        board: {
          open: [],
          claimed: [{ issueRef: "LIN-1", runId: "run-1", phase: "claimed", lastUpdated: 1 }],
          running: [],
          done: [],
        },
      }),
      async () => Response.json({ forwarded: true }, { status: 202 }),
      seen,
    );

    const response = await handleWorkerRequest(new Request("https://api.test/v1/runs/run-1/heartbeat", {
      method: "POST",
      headers: {
        authorization: "Bearer worker-session",
        "content-type": "application/json",
        "x-contrabass-team-id": "team-1",
      },
      body: JSON.stringify({ lastEventTs: 1_771_000_000_000, protocol_version: "1.0.0" }),
    }), envWithAuth(env, { workerTokens: "worker-session" }));

    expect(response.status).toBe(202);
    expect(seen).toEqual({
      teamName: "team-1",
      issueRunName: "team-1:LIN-1",
    });
  });

  it("returns run_not_found when the TeamCoordinator board lacks the run", async () => {
    const env = createSplitEnv(
      async () => Response.json({ board: { open: [], claimed: [], running: [], done: [] } }),
      async () => Response.json({ forwarded: true }, { status: 202 }),
    );

    const response = await handleWorkerRequest(new Request("https://api.test/v1/runs/run-missing/heartbeat", {
      method: "POST",
      headers: {
        authorization: "Bearer worker-session",
        "content-type": "application/json",
        "x-contrabass-team-id": "team-1",
      },
      body: JSON.stringify({ lastEventTs: 1_771_000_000_000, protocol_version: "1.0.0" }),
    }), envWithAuth(env, { workerTokens: "worker-session" }));

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ error: "run_not_found", protocol_version: "1.0.0" });
  });

  it("maps routing validation failures to structured protocol errors", async () => {
    const cases: Array<{
      name: string;
      request: Request;
      expectedStatus: number;
      expectedBody: Record<string, unknown>;
    }> = [
      {
        name: "run forward missing team scope",
        request: new Request("https://api.test/v1/runs/run-1/heartbeat", {
          method: "POST",
          headers: {
            authorization: "Bearer worker-session",
            "content-type": "application/json",
          },
          body: JSON.stringify({ lastEventTs: 1_771_000_000_000, protocol_version: "1.0.0" }),
        }),
        expectedStatus: 400,
        expectedBody: { error: "invalid_team_id", protocol_version: "1.0.0" },
      },
      {
        name: "worker dispatch missing team scope",
        request: new Request("https://api.test/v1/workers/worker-1/dispatch", {
          headers: { authorization: "Bearer worker-session" },
        }),
        expectedStatus: 400,
        expectedBody: { error: "invalid_team_id", protocol_version: "1.0.0" },
      },
    ];

    for (const testCase of cases) {
      const response = await handleWorkerRequest(
        testCase.request,
        envWithAuth(createEnv(), { workerTokens: "worker-session" }),
      );

      expect(response.status, testCase.name).toBe(testCase.expectedStatus);
      await expect(response.json(), testCase.name).resolves.toEqual(testCase.expectedBody);
      expect(response.headers.get("x-contrabass-api-version"), testCase.name).toBe("1.0.0");
    }
  });

  it("scopes issued worker session run forwards to the token team and worker", async () => {
    const seen: Array<{ name?: string; url: string; workerId?: string; body: unknown }> = [];
    const env = {
      ...createEnv(async (request) => {
        if (request.url === "https://team-coordinator.internal/board") {
          return Response.json({
            board: {
              open: [],
              claimed: [],
              running: [{ issueRef: "run-1", runId: "run-1", phase: "running", lastUpdated: 1 }],
              done: [],
            },
          });
        }

        seen.push({
          url: request.url,
          workerId: request.headers.get("x-contrabass-worker-id") ?? undefined,
          body: await request.json(),
        });
        return request.url.endsWith("/workers/register")
          ? Response.json({ worker: { workerId: "worker-1" } })
          : Response.json({ forwarded: true });
      }, {}),
      CONTRABASS_WORKER_TOKEN_SECRET: "test-secret",
    };

    const registerResponse = await handleWorkerRequest(new Request("https://api.test/v1/workers/register", {
      method: "POST",
      headers: { authorization: "Bearer enrollment-session", "content-type": "application/json" },
      body: JSON.stringify(registerBody()),
    }), envWithAuth(env, { workerTokens: "enrollment-session" }));
    const registerJson = await registerResponse.json() as Record<string, unknown>;
    const sessionToken = registerJson.sessionToken;
    if (typeof sessionToken !== "string") {
      throw new Error("sessionToken must be a string");
    }

    const response = await handleWorkerRequest(new Request("https://api.test/v1/runs/run-1/ack", {
      method: "POST",
      headers: { authorization: `Bearer ${sessionToken}`, "content-type": "application/json" },
      body: JSON.stringify({ accept: true, protocol_version: "1.0.0" }),
    }), env);

    expect(response.status).toBe(200);
    expect(seen.at(-1)).toEqual({
      url: "https://issue-run.internal/ack",
      workerId: "worker-1",
      body: { accept: true, protocol_version: "1.0.0", workerId: "worker-1" },
    });

    const crossTeamResponse = await handleWorkerRequest(new Request("https://api.test/v1/runs/run-1/heartbeat", {
      method: "POST",
      headers: {
        authorization: `Bearer ${sessionToken}`,
        "content-type": "application/json",
        "x-contrabass-team-id": "team-2",
      },
      body: JSON.stringify({ lastEventTs: 1_771_000_000_000, protocol_version: "1.0.0" }),
    }), env);

    expect(crossTeamResponse.status).toBe(403);
    await expect(crossTeamResponse.json()).resolves.toEqual({ error: "team_forbidden", protocol_version: "1.0.0" });
  });

  it("scopes issued worker session dispatch routes to the token worker", async () => {
    const seen: Array<{ url: string; workerId?: string }> = [];
    const env = {
      ...createEnv(async (request) => {
        seen.push({
          url: request.url,
          workerId: request.headers.get("x-contrabass-worker-id") ?? undefined,
        });
        return request.url.endsWith("/workers/register")
          ? Response.json({ worker: { workerId: "worker-1" } })
          : Response.json({ dispatch: null });
      }),
      CONTRABASS_WORKER_TOKEN_SECRET: "test-secret",
    };

    const registerResponse = await handleWorkerRequest(new Request("https://api.test/v1/workers/register", {
      method: "POST",
      headers: { authorization: "Bearer enrollment-session", "content-type": "application/json" },
      body: JSON.stringify(registerBody()),
    }), envWithAuth(env, { workerTokens: "enrollment-session" }));
    const registerJson = await registerResponse.json() as Record<string, unknown>;
    const sessionToken = registerJson.sessionToken;
    if (typeof sessionToken !== "string") {
      throw new Error("sessionToken must be a string");
    }

    const response = await handleWorkerRequest(new Request("https://api.test/v1/workers/worker-1/dispatch?wait=25s", {
      headers: { authorization: `Bearer ${sessionToken}` },
    }), env);

    expect(response.status).toBe(200);
    expect(seen.at(-1)).toEqual({
      url: "https://team-coordinator.internal/workers/worker-1/dispatch?wait=25s",
      workerId: "worker-1",
    });

    const forbiddenResponse = await handleWorkerRequest(new Request(
      "https://api.test/v1/workers/worker-2/dispatch?wait=25s",
      { headers: { authorization: `Bearer ${sessionToken}` } },
    ), env);

    expect(forbiddenResponse.status).toBe(403);
    await expect(forbiddenResponse.json()).resolves.toEqual({ error: "team_forbidden", protocol_version: "1.0.0" });
  });

  it("keeps public worker auth routes unauthenticated but versioned", async () => {
    const cases: Array<{
      name: string;
      request: Request;
      expectedStatus: number;
      expectedBody: Record<string, unknown>;
    }> = [
      {
        name: "refresh",
        request: new Request("https://api.test/v1/workers/refresh", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ refreshToken: "", protocol_version: "1.0.0" }),
        }),
        expectedStatus: 401,
        expectedBody: { error: "refresh_invalid", protocol_version: "1.0.0" },
      },
      {
        name: "enroll",
        request: new Request("https://api.test/v1/workers/enroll", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ code: "" }),
        }),
        expectedStatus: 401,
        expectedBody: { error: "enrollment_invalid", protocol_version: "1.0.0" },
      },
    ];

    for (const testCase of cases) {
      const response = await handleWorkerRequest(testCase.request, createEnv());

      expect(response.status, testCase.name).toBe(testCase.expectedStatus);
      await expect(response.json(), testCase.name).resolves.toEqual(testCase.expectedBody);
      expect(response.headers.get("x-contrabass-api-version"), testCase.name).toBe("1.0.0");
    }
  });

  it("accepts dashboard session-cookie auth", async () => {
    const response = await handleWorkerRequest(new Request("https://api.test/v1/workers/register", {
      method: "POST",
      headers: { cookie: "contrabass_session=dashboard-session" },
    }), envWithAuth(createEnv(), { dashboardTokens: "dashboard-session" }));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "invalid_request", protocol_version: "1.0.0" });
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

  it("registers workers through TeamCoordinator and returns session bootstrap data", async () => {
    const seen: { name?: string; url?: string; method?: string; body?: unknown; teamId?: string } = {};
    const env = {
      ...createEnv(async (request) => {
        seen.url = request.url;
        seen.method = request.method;
        seen.body = request.method === "GET" ? undefined : await request.json();
        seen.teamId = request.headers.get("x-contrabass-team-id") ?? undefined;
        return Response.json({ worker: { workerId: "worker-1" } });
      }, seen),
      CONTRABASS_WORKER_TOKEN_SECRET: "test-secret",
    };

    const response = await handleWorkerRequest(new Request("https://api.test/v1/workers/register", {
      method: "POST",
      headers: { authorization: "Bearer enrollment-session", "content-type": "application/json" },
      body: JSON.stringify(registerBody()),
    }), envWithAuth(env, { workerTokens: "enrollment-session" }));

    expect(response.status).toBe(200);
    const body = await response.json() as Record<string, unknown>;
    expect(body).toMatchObject({
      dispatchChannel: {
        wsUrl: "wss://api.test/v1/workers/worker-1/dispatch-ws",
        longPollUrl: "https://api.test/v1/workers/worker-1/dispatch?wait=25s",
      },
      heartbeatIntervalSec: 20,
      leaseSec: 60,
      protocol_version: "1.0.0",
    });
    expect(body.sessionToken).toEqual(expect.any(String));
    expect(body.sessionTokenExpiresAt).toEqual(expect.any(Number));
    expect(body.refreshToken).toEqual(expect.any(String));
    expect(seen).toMatchObject({
      name: "team-1",
      url: "https://team-coordinator.internal/workers/register",
      method: "POST",
      teamId: "team-1",
      body: { ...registerBody(), kind: "local" },
    });

    const sessionToken = body.sessionToken;
    if (typeof sessionToken !== "string") {
      throw new Error("sessionToken must be a string");
    }
    const authenticatedResponse = await handleWorkerRequest(new Request("https://api.test/v1/teams/team-1/board", {
      headers: { authorization: `Bearer ${sessionToken}` },
    }), env);
    expect(authenticatedResponse.status).toBe(200);
    expect(seen.url).toBe("https://team-coordinator.internal/board");

    const crossTeamResponse = await handleWorkerRequest(new Request("https://api.test/v1/teams/team-2/board", {
      headers: { authorization: `Bearer ${sessionToken}` },
    }), env);
    expect(crossTeamResponse.status).toBe(403);
    await expect(crossTeamResponse.json()).resolves.toEqual({ error: "team_forbidden", protocol_version: "1.0.0" });
    expect(seen.name).toBe("team-1");
  });

  it("rejects incompatible worker protocol versions before mutating registry", async () => {
    let calls = 0;
    const env = createEnv(async () => {
      calls += 1;
      return Response.json({ ok: true });
    });

    const response = await handleWorkerRequest(new Request("https://api.test/v1/workers/register", {
      method: "POST",
      headers: { authorization: "Bearer enrollment-session", "content-type": "application/json" },
      body: JSON.stringify({
        ...registerBody(),
        supported_protocol_versions: ["2.0.0"],
      }),
    }), envWithAuth(env, { workerTokens: "enrollment-session" }));

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: "protocol_version_unsupported",
      supported: ["1.0.0"],
      protocol_version: "1.0.0",
    });
    expect(calls).toBe(0);
  });

  it("rejects registration for teams absent from the control-plane store", async () => {
    const env = {
      ...envWithAuth(createEnv(), { workerTokens: "enrollment-session" }),
      CONTROL_PLANE_DB: fakeD1({ teamExists: false }),
    };

    const response = await handleWorkerRequest(new Request("https://api.test/v1/workers/register", {
      method: "POST",
      headers: { authorization: "Bearer enrollment-session", "content-type": "application/json" },
      body: JSON.stringify(registerBody()),
    }), env);

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({ error: "team_forbidden", protocol_version: "1.0.0" });
  });

  it("enrolls a worker with a one-time code and refreshes its session token", async () => {
    const enrollment = {
      enrollment_id: "enroll-1",
      team_id: "team-1",
      worker_id: null,
      expires_at: "2999-01-01T00:00:00.000Z",
      redeemed_at: null,
      refresh_token_expires_at: null,
      revoked_at: null,
    };
    const env = {
      ...createEnv(),
      CONTROL_PLANE_DB: fakeD1({ enrollment }),
      CONTRABASS_WORKER_TOKEN_SECRET: "test-secret",
    };

    const enrollResponse = await handleWorkerRequest(new Request("https://api.test/v1/workers/enroll", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code: "ABC-123", workerId: "worker-1" }),
    }), env);

    expect(enrollResponse.status).toBe(200);
    const enrollBody = await enrollResponse.json() as Record<string, unknown>;
    expect(enrollBody).toMatchObject({
      teamId: "team-1",
      workerId: "worker-1",
      protocol_version: "1.0.0",
    });
    expect(enrollBody.refreshToken).toEqual(expect.any(String));

    const refreshResponse = await handleWorkerRequest(new Request("https://api.test/v1/workers/refresh", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ refreshToken: enrollBody.refreshToken, protocol_version: "1.0.0" }),
    }), env);

    expect(refreshResponse.status).toBe(200);
    const refreshBody = await refreshResponse.json() as Record<string, unknown>;
    expect(refreshBody).toMatchObject({
      expiresAt: expect.any(Number),
      protocol_version: "1.0.0",
    });
    expect(refreshBody.sessionToken).toEqual(expect.stringMatching(/^cbs\./u));
  });

  it("rejects a stale concurrent enrollment redemption when the atomic update changes no rows", async () => {
    const enrollment = {
      enrollment_id: "enroll-1",
      team_id: "team-1",
      worker_id: null,
      expires_at: "2999-01-01T00:00:00.000Z",
      redeemed_at: null,
      refresh_token_expires_at: null,
      revoked_at: null,
    };
    const env = {
      ...createEnv(),
      CONTROL_PLANE_DB: fakeD1({ enrollment, staleEnrollmentRead: true }),
    };

    const firstResponse = await handleWorkerRequest(new Request("https://api.test/v1/workers/enroll", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code: "ABC-123", workerId: "worker-1" }),
    }), env);
    const secondResponse = await handleWorkerRequest(new Request("https://api.test/v1/workers/enroll", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code: "ABC-123", workerId: "worker-2" }),
    }), env);

    expect(firstResponse.status).toBe(200);
    expect(secondResponse.status).toBe(401);
    await expect(secondResponse.json()).resolves.toEqual({ error: "enrollment_invalid", protocol_version: "1.0.0" });
  });

  it("fails register and refresh when no worker token signing secret is configured", async () => {
    let calls = 0;
    const env = createEnv(async () => {
      calls += 1;
      return Response.json({ worker: { workerId: "worker-1" } });
    });

    const registerResponse = await handleWorkerRequest(new Request("https://api.test/v1/workers/register", {
      method: "POST",
      headers: { cookie: "contrabass_session=dashboard-session", "content-type": "application/json" },
      body: JSON.stringify(registerBody()),
    }), envWithAuth(env, { dashboardTokens: "dashboard-session" }));

    expect(registerResponse.status).toBe(500);
    await expect(registerResponse.json()).resolves.toEqual({
      error: "worker_token_secret_missing",
      protocol_version: "1.0.0",
    });
    expect(calls).toBe(0);

    const refreshResponse = await handleWorkerRequest(new Request("https://api.test/v1/workers/refresh", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ refreshToken: "valid-refresh", protocol_version: "1.0.0" }),
    }), {
      ...createEnv(),
      CONTROL_PLANE_DB: fakeD1({
        enrollment: {
          enrollment_id: "enroll-1",
          team_id: "team-1",
          worker_id: "worker-1",
          expires_at: "2999-01-01T00:00:00.000Z",
          redeemed_at: "2026-01-01T00:00:00.000Z",
          refresh_token_expires_at: "2999-01-01T00:00:00.000Z",
          revoked_at: null,
        },
      }),
    });

    expect(refreshResponse.status).toBe(500);
    await expect(refreshResponse.json()).resolves.toEqual({
      error: "worker_token_secret_missing",
      protocol_version: "1.0.0",
    });
  });

  it("maps revoked refresh tokens to refresh_revoked", async () => {
    const env = {
      ...createEnv(),
      CONTROL_PLANE_DB: fakeD1({
        enrollment: {
          enrollment_id: "enroll-1",
          team_id: "team-1",
          worker_id: "worker-1",
          expires_at: "2999-01-01T00:00:00.000Z",
          redeemed_at: "2026-01-01T00:00:00.000Z",
          refresh_token_expires_at: "2999-01-01T00:00:00.000Z",
          revoked_at: "2026-01-02T00:00:00.000Z",
        },
      }),
    };

    const response = await handleWorkerRequest(new Request("https://api.test/v1/workers/refresh", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ refreshToken: "revoked-refresh", protocol_version: "1.0.0" }),
    }), env);

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: "refresh_revoked", protocol_version: "1.0.0" });
  });

  it("parses and stores a new team config version", async () => {
    const configs: FakeConfigRow[] = [];
    const env = envWithAuth({
      ...createEnv(),
      CONTROL_PLANE_DB: fakeD1({ configs }),
    }, { dashboardTokens: "dashboard-session" });
    const contentYaml = [
      "---",
      "model: openai/gpt-5-codex",
      "project_url: https://linear.app/example/project/cloud",
      "tracker:",
      "  type: internal",
      "---",
      "Fix {{ issue.title }}.",
      "",
    ].join("\n");

    const response = await handleWorkerRequest(new Request("https://api.test/v1/teams/team-1/config", {
      method: "POST",
      headers: { cookie: "contrabass_session=dashboard-session", "content-type": "application/json" },
      body: JSON.stringify({ content_yaml: contentYaml, created_by: "operator-1", notes: "initial import" }),
    }), env);

    expect(response.status).toBe(201);
    const body = await response.json() as Record<string, unknown>;
    expect(body).toMatchObject({
      teamId: "team-1",
      version: 1,
      unchanged: false,
      protocol_version: "1.0.0",
    });
    expect(body.contentHash).toEqual(expect.stringMatching(/^[a-f0-9]{64}$/u));
    expect(configs).toEqual([{
      team_id: "team-1",
      version: 1,
      content_hash: body.contentHash,
      content_yaml: contentYaml,
      created_by: "operator-1",
      created_at: expect.any(String),
      notes: "initial import",
    }]);
  });

  it("returns the existing version when pushed config content is unchanged", async () => {
    const contentYaml = "---\ntracker:\n  type: internal\n---\nPrompt.\n";
    const configs: FakeConfigRow[] = [{
      team_id: "team-1",
      version: 4,
      content_hash: await testSha256Hex(contentYaml),
      content_yaml: contentYaml,
      created_by: "operator-1",
      created_at: "2026-05-09T00:00:00.000Z",
      notes: "already stored",
    }];
    const env = envWithAuth({
      ...createEnv(),
      CONTROL_PLANE_DB: fakeD1({ configs }),
    }, { dashboardTokens: "dashboard-session" });

    const response = await handleWorkerRequest(new Request("https://api.test/v1/teams/team-1/config", {
      method: "POST",
      headers: { cookie: "contrabass_session=dashboard-session", "content-type": "application/json" },
      body: JSON.stringify({ contentYaml }),
    }), env);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      teamId: "team-1",
      version: 4,
      contentHash: configs[0].content_hash,
      unchanged: true,
      protocol_version: "1.0.0",
    });
    expect(configs).toHaveLength(1);
  });

  it("returns immutable cacheable YAML config by content hash", async () => {
    const contentYaml = "---\ntracker:\n  type: internal\n---\nPrompt.\n";
    const contentHash = await testSha256Hex(contentYaml);
    const env = envWithAuth({
      ...createEnv(),
      CONTROL_PLANE_DB: fakeD1({
        configs: [{
          team_id: "team-1",
          version: 2,
          content_hash: contentHash,
          content_yaml: contentYaml,
          created_by: "operator-1",
          created_at: "2026-05-09T00:00:00.000Z",
          notes: "stored",
        }],
      }),
    }, { workerTokens: "worker-session" });

    const response = await handleWorkerRequest(new Request(`https://api.test/v1/teams/team-1/config/${contentHash}`, {
      headers: { authorization: "Bearer worker-session" },
    }), env);

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("public, max-age=86400, immutable");
    expect(response.headers.get("content-type")).toBe("text/yaml; charset=utf-8");
    await expect(response.text()).resolves.toBe(contentYaml);
  });

  it("returns structured errors for missing or malformed config hashes", async () => {
    const validMissingHash = "a".repeat(64);
    const env = envWithAuth({
      ...createEnv(),
      CONTROL_PLANE_DB: fakeD1({ configs: [] }),
    }, { workerTokens: "worker-session" });
    const cases: Array<{ name: string; hash: string; expectedStatus: number; expectedError: string }> = [
      { name: "malformed", hash: "not-a-sha", expectedStatus: 400, expectedError: "invalid_config_hash" },
      { name: "not found", hash: validMissingHash, expectedStatus: 404, expectedError: "config_not_found" },
    ];

    for (const testCase of cases) {
      const response = await handleWorkerRequest(new Request(`https://api.test/v1/teams/team-1/config/${testCase.hash}`, {
        headers: { authorization: "Bearer worker-session" },
      }), env);

      expect(response.status, testCase.name).toBe(testCase.expectedStatus);
      await expect(response.json(), testCase.name).resolves.toEqual({
        error: testCase.expectedError,
        protocol_version: "1.0.0",
      });
    }
  });

  it("rejects invalid config and does not write to D1", async () => {
    const configs: FakeConfigRow[] = [];
    const env = envWithAuth({
      ...createEnv(),
      CONTROL_PLANE_DB: fakeD1({ configs }),
    }, { dashboardTokens: "dashboard-session" });
    const cases: Array<{ name: string; contentYaml: string; expectedDetails: Array<Record<string, unknown>> }> = [
      {
        name: "invalid yaml",
        contentYaml: "---\nmodel: [\n---\nprompt\n",
        expectedDetails: [{ path: "$", message: expect.stringContaining("invalid workflow yaml") }],
      },
      {
        name: "unknown tracker",
        contentYaml: "---\ntracker:\n  type: jira\n---\nprompt\n",
        expectedDetails: [{ path: "tracker.type", message: "unknown tracker type: jira" }],
      },
      {
        name: "missing secret binding",
        contentYaml: "---\ntracker:\n  type: linear\n  token: $LINEAR_API_KEY\n---\nprompt\n",
        expectedDetails: [{ path: "tracker.linear.token", message: "secret not bound: LINEAR_API_KEY" }],
      },
      {
        name: "invalid liquid prompt",
        contentYaml: "---\ntracker:\n  type: internal\n---\nFix {{ issue.title\n",
        expectedDetails: [{ path: "prompt", message: expect.stringContaining("invalid liquid template") }],
      },
    ];

    for (const testCase of cases) {
      const response = await handleWorkerRequest(new Request("https://api.test/v1/teams/team-1/config", {
        method: "POST",
        headers: { cookie: "contrabass_session=dashboard-session", "content-type": "application/json" },
        body: JSON.stringify({ content_yaml: testCase.contentYaml }),
      }), env);

      expect(response.status, testCase.name).toBe(400);
      await expect(response.json(), testCase.name).resolves.toEqual({
        error: "config_invalid",
        details: testCase.expectedDetails,
        protocol_version: "1.0.0",
      });
    }
    expect(configs).toEqual([]);
  });
});

function registerBody(): Record<string, unknown> {
  return {
    teamId: "team-1",
    workerId: "worker-1",
    capabilities: ["agent:mock", "git"],
    maxConcurrency: 2,
    version: "0.1.0",
    supported_protocol_versions: ["1.0.0"],
    protocol_version: "1.0.0",
  };
}

type FakeEnrollment = {
  enrollment_id: string;
  team_id: string;
  worker_id: string | null;
  expires_at: string;
  redeemed_at: string | null;
  refresh_token_expires_at: string | null;
  revoked_at: string | null;
};

type FakeConfigRow = {
  team_id: string;
  version: number;
  content_hash: string;
  content_yaml: string;
  created_by: string;
  created_at: string;
  notes: string;
};

function fakeD1(state: {
  teamExists?: boolean;
  enrollment?: FakeEnrollment;
  staleEnrollmentRead?: boolean;
  configs?: FakeConfigRow[];
}): D1Database {
  let enrollment = state.enrollment;
  const firstEnrollment = enrollment === undefined ? undefined : { ...enrollment };
  const configs = state.configs ?? [];

  return {
    prepare(sql: string) {
      return {
        bind(...values: unknown[]) {
          return {
            async first() {
              if (sql.includes("FROM team_configs") && sql.includes("content_hash")) {
                return configs.find((row) => row.team_id === values[0] && row.content_hash === values[1]) ?? null;
              }
              if (sql.includes("MAX(version)") && sql.includes("team_configs")) {
                const teamId = String(values[0]);
                const versions = configs.filter((row) => row.team_id === teamId).map((row) => row.version);
                return { next_version: versions.length === 0 ? 1 : Math.max(...versions) + 1 };
              }
              if (sql.includes("team_configs_active")) {
                return state.teamExists === false ? null : { team_id: "team-1" };
              }
              if (sql.includes("worker_enrollments")) {
                return (state.staleEnrollmentRead ? firstEnrollment : enrollment) ?? null;
              }
              return null;
            },
            async run() {
              if (sql.includes("INSERT INTO team_configs")) {
                configs.push({
                  team_id: String(values[0]),
                  version: Number(values[1]),
                  content_hash: String(values[2]),
                  content_yaml: String(values[3]),
                  created_by: String(values[4]),
                  created_at: String(values[5]),
                  notes: String(values[6]),
                });
              }
              if (sql.includes("UPDATE worker_enrollments") && enrollment !== undefined) {
                const isEnrollmentRedemption = sql.includes("redeemed_at IS NULL");
                if (
                  isEnrollmentRedemption
                  && (enrollment.redeemed_at !== null
                    || enrollment.revoked_at !== null
                    || enrollment.expires_at <= String(values[6]))
                ) {
                  return d1RunResult(0);
                }
                enrollment = {
                  ...enrollment,
                  worker_id: typeof values[0] === "string" ? values[0] : enrollment.worker_id,
                  redeemed_at: typeof values[2] === "string" ? values[2] : enrollment.redeemed_at,
                  refresh_token_expires_at: typeof values[3] === "string"
                    ? values[3]
                    : enrollment.refresh_token_expires_at,
                };
              }
              return d1RunResult(1);
            },
          };
        },
      };
    },
  } as unknown as D1Database;
}

async function testSha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function d1RunResult(changes: number): D1Result {
  return {
    success: true,
    results: [],
    meta: {
      duration: 0,
      size_after: 0,
      rows_read: 0,
      rows_written: changes,
      last_row_id: 0,
      changed_db: changes > 0,
      changes,
    },
  };
}

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

function createSplitEnv(
  teamFetch: (request: Request) => Promise<Response>,
  issueRunFetch: (request: Request) => Promise<Response>,
  seen: { teamName?: string; issueRunName?: string } = {},
): Env {
  return {
    TEAM_COORDINATOR: {
      idFromName(name: string) {
        seen.teamName = name;
        return { name };
      },
      get() {
        return { fetch: teamFetch };
      },
    },
    ISSUE_RUN: {
      idFromName(name: string) {
        seen.issueRunName = name;
        return { name };
      },
      get() {
        return { fetch: issueRunFetch };
      },
    },
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
