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
    await expect(crossTeamResponse.json()).resolves.toEqual({ error: "team_forbidden" });
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

function fakeD1(state: { teamExists?: boolean; enrollment?: FakeEnrollment; staleEnrollmentRead?: boolean }): D1Database {
  let enrollment = state.enrollment;
  const firstEnrollment = enrollment === undefined ? undefined : { ...enrollment };

  return {
    prepare(sql: string) {
      return {
        bind(...values: unknown[]) {
          return {
            async first() {
              if (sql.includes("team_configs_active")) {
                return state.teamExists === false ? null : { team_id: "team-1" };
              }
              if (sql.includes("worker_enrollments")) {
                return (state.staleEnrollmentRead ? firstEnrollment : enrollment) ?? null;
              }
              return null;
            },
            async run() {
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
