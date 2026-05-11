import { describe, expect, it, vi } from "vitest";

import poller, { enabledTrackersFromConfig, runTrackerPoller, type PollerAdapterName, type PollerEnv } from "./index";

describe("tracker poller entry point", () => {
  it("exposes a health response for direct fetches", async () => {
    const response = await poller.fetch?.(new Request("https://poller.test/"), {}, createExecutionContext());

    expect(response?.status).toBe(200);
    await expect(response?.json()).resolves.toEqual({ service: "contrabass-tracker-poller", status: "ok" });
  });

  it("enumerates enabled teams and calls configured adapters once", async () => {
    const calls: Array<{ teamId: string; adapter: PollerAdapterName; cron: string; scheduledTime: number }> = [];
    const env = createEnv([
      { teamId: "disabled", contentHash: hashFor("disabled"), contentYaml: "tracker:\n  enabled: false\n  type: linear\n" },
      { teamId: "github-team", contentHash: hashFor("github"), contentYaml: "tracker:\n  enabled: true\n  type: github\n" },
      { teamId: "multi-team", contentHash: hashFor("multi"), contentYaml: "tracker:\n  linear:\n    query: active\n  internal_board:\n    enabled: true\n" },
    ]);

    const result = await runTrackerPoller(env, { cron: "* * * * *", scheduledTime: 1710000000000 }, {
      github(invocation) {
        calls.push({
          teamId: invocation.team.teamId,
          adapter: invocation.adapter,
          cron: invocation.cron,
          scheduledTime: invocation.scheduledTime,
        });
      },
      "internal-board"(invocation) {
        calls.push({
          teamId: invocation.team.teamId,
          adapter: invocation.adapter,
          cron: invocation.cron,
          scheduledTime: invocation.scheduledTime,
        });
      },
      linear(invocation) {
        calls.push({
          teamId: invocation.team.teamId,
          adapter: invocation.adapter,
          cron: invocation.cron,
          scheduledTime: invocation.scheduledTime,
        });
      },
    });

    expect(result).toEqual({
      scheduledTime: 1710000000000,
      cron: "* * * * *",
      teamsSeen: 3,
      teamsEnabled: 2,
      teamsSkippedBackoff: 0,
      adapterCalls: 3,
    });
    expect(calls).toEqual([
      { teamId: "github-team", adapter: "github", cron: "* * * * *", scheduledTime: 1710000000000 },
      { teamId: "multi-team", adapter: "internal-board", cron: "* * * * *", scheduledTime: 1710000000000 },
      { teamId: "multi-team", adapter: "linear", cron: "* * * * *", scheduledTime: 1710000000000 },
    ]);
  });

  it("continues polling remaining adapters after one adapter fails", async () => {
    const calls: Array<{ teamId: string; adapter: PollerAdapterName }> = [];
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const env = createEnv([
      { teamId: "failing-team", contentHash: hashFor("failing"), contentYaml: "tracker:\n  type: linear\n" },
      { teamId: "healthy-team", contentHash: hashFor("healthy"), contentYaml: "tracker:\n  type: github\n" },
    ]);

    try {
      const result = await runTrackerPoller(env, { cron: "* * * * *", scheduledTime: 1710000000000 }, {
        linear(invocation) {
          calls.push({ teamId: invocation.team.teamId, adapter: invocation.adapter });
          throw new Error("linear auth failed");
        },
        github(invocation) {
          calls.push({ teamId: invocation.team.teamId, adapter: invocation.adapter });
        },
      });

      expect(result).toMatchObject({ teamsSeen: 2, teamsEnabled: 2, adapterCalls: 2 });
      expect(calls).toEqual([
        { teamId: "failing-team", adapter: "linear" },
        { teamId: "healthy-team", adapter: "github" },
      ]);
      expect(consoleError).toHaveBeenCalledWith(JSON.stringify({
        event: "tracker_poller_adapter_error",
        teamId: "failing-team",
        adapter: "linear",
        message: "linear auth failed",
      }));
    } finally {
      consoleError.mockRestore();
    }
  });

  it("emits per-team adapter metrics to Workers Analytics Engine", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const metrics: AnalyticsEngineDataPoint[] = [];
    const env = createEnv([
      {
        teamId: "metrics-team",
        contentHash: hashFor("metrics"),
        contentYaml: "tracker:\n  github:\n    repo: octocat/hello-world\n  linear:\n    project_slug: alpha\n",
      },
    ]);
    env.TRACKER_POLLER_METRICS = {
      writeDataPoint(event?: AnalyticsEngineDataPoint) {
        if (event !== undefined) {
          metrics.push(event);
        }
      },
    };

    try {
      await runTrackerPoller(env, { cron: "* * * * *", scheduledTime: 1710000000000 }, {
        github() {
          throw new Error("github failed");
        },
        linear(invocation) {
          return {
            teamId: invocation.team.teamId,
            issuesSeen: 5,
            issuesNew: 2,
            issuesUpdated: 3,
          };
        },
      });

      expect(metrics).toHaveLength(2);
      expect(metrics[0]).toMatchObject({
        indexes: ["metrics-team"],
        blobs: ["tracker_poller_adapter", "metrics-team", "github", "* * * * *", "github failed"],
      });
      expect(metrics[0]?.doubles?.slice(1)).toEqual([0, 0, 0, 1, 1710000000000]);
      expect(metrics[1]).toMatchObject({
        indexes: ["metrics-team"],
        blobs: ["tracker_poller_adapter", "metrics-team", "linear", "* * * * *", ""],
      });
      expect(metrics[1]?.doubles?.slice(1)).toEqual([5, 2, 3, 0, 1710000000000]);
    } finally {
      consoleError.mockRestore();
    }
  });

  it("emits poll_duration metrics to OBSERVABILITY_METRICS binding per adapter invocation", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const observabilityPoints: AnalyticsEngineDataPoint[] = [];
    const env = createEnv([
      {
        teamId: "obs-team",
        contentHash: hashFor("obs"),
        contentYaml: "tracker:\n  github:\n    repo: octocat/hello-world\n  linear:\n    project_slug: alpha\n",
      },
    ]);
    env.OBSERVABILITY_METRICS = {
      writeDataPoint(event?: AnalyticsEngineDataPoint) {
        if (event !== undefined) {
          observabilityPoints.push(event);
        }
      },
    };

    try {
      await runTrackerPoller(env, { cron: "* * * * *", scheduledTime: 1710000000000 }, {
        github() {
          throw new Error("github failed");
        },
        linear(invocation) {
          return { teamId: invocation.team.teamId, issuesSeen: 3, issuesNew: 1, issuesUpdated: 2 };
        },
      });

      // #then — one poll_duration point per adapter call (error + success)
      expect(observabilityPoints).toHaveLength(2);
      expect(observabilityPoints[0]).toMatchObject({
        indexes: ["obs-team"],
        blobs: ["poll_duration", "obs-team", "github", "* * * * *", ""],
      });
      expect(observabilityPoints[0]?.doubles).toHaveLength(2);
      expect(observabilityPoints[0]?.doubles?.[0]).toBeGreaterThanOrEqual(0);
      expect(observabilityPoints[1]).toMatchObject({
        indexes: ["obs-team"],
        blobs: ["poll_duration", "obs-team", "linear", "* * * * *", ""],
      });
      expect(observabilityPoints[1]?.doubles).toHaveLength(2);
      expect(observabilityPoints[1]?.doubles?.[0]).toBeGreaterThanOrEqual(0);
    } finally {
      consoleError.mockRestore();
    }
  });

  it("uses default Linear and GitHub adapters with mocked tracker clients", async () => {
    const trackerRequests: Request[] = [];
    const coordinatorRequests: Request[] = [];
    const env = createEnv([
      {
        teamId: "github-team",
        contentHash: hashFor("github"),
        contentYaml: "tracker:\n  github:\n    repo: octocat/hello-world\n",
      },
      {
        teamId: "linear-team",
        contentHash: hashFor("linear"),
        contentYaml: "tracker:\n  linear:\n    project_slug: alpha\n",
      },
    ]);
    env.TRACKER_GITHUB_TOKEN = "github-secret";
    env.TRACKER_LINEAR_TOKEN = "linear-secret";
    env.TEAM_COORDINATOR = durableObjectNamespace(async (request) => {
      coordinatorRequests.push(request.clone());
      const body = await request.json();
      const issues = isRecord(body) && Array.isArray(body.issues) ? body.issues : [];
      return Response.json({ issueStats: { issuesNew: issues.length, issuesUpdated: 0 } });
    });

    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      trackerRequests.push(request);
      const url = new URL(request.url);

      if (url.hostname === "api.github.com") {
        return Response.json([githubIssuePayload({ number: 42, title: "Fix GitHub bug" })]);
      }
      if (url.hostname === "api.linear.app") {
        return Response.json({
          data: {
            issues: {
              nodes: [linearIssueNode({ id: "linear-1", identifier: "LIN-1", title: "Fix Linear bug", stateType: "unstarted" })],
              pageInfo: { hasNextPage: false },
            },
          },
        });
      }
      throw new Error(`unexpected tracker URL: ${request.url}`);
    });

    vi.stubGlobal("fetch", fetchMock);
    try {
      const result = await runTrackerPoller(env, { cron: "* * * * *", scheduledTime: 1710000000000 });

      expect(result).toMatchObject({ teamsSeen: 2, teamsEnabled: 2, adapterCalls: 2 });
      expect(trackerRequests.map((request) => new URL(request.url).hostname)).toEqual([
        "api.github.com",
        "api.linear.app",
      ]);
      expect(trackerRequests[0]?.headers.get("authorization")).toBe("Bearer github-secret");
      expect(trackerRequests[1]?.headers.get("authorization")).toBe("linear-secret");
      expect(coordinatorRequests).toHaveLength(2);
      await expect(coordinatorRequests[0]?.json()).resolves.toMatchObject({
        issues: [{ external_id: "octocat/hello-world#42", tracker: "github" }],
      });
      await expect(coordinatorRequests[1]?.json()).resolves.toMatchObject({
        issues: [{ external_id: "linear-1", tracker: "linear" }],
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("isolates rate-limited teams and skips them until Retry-After expires", async () => {
    const calls: Array<{ teamId: string; adapter: PollerAdapterName }> = [];
    const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const clockStart = 1710000300000;
    const backoffs = new Map<string, TeamBackoffFixture>();
    const rows = [
      {
        teamId: "limited-team",
        contentHash: hashFor("limited"),
        contentYaml: "tracker:\n  github:\n    repo: octocat/hello-world\n  linear:\n    project_slug: alpha\n",
      },
      { teamId: "healthy-team", contentHash: hashFor("healthy"), contentYaml: "tracker:\n  type: github\n" },
    ];

    try {
      vi.useFakeTimers();
      vi.setSystemTime(clockStart);

      const env = createEnv(rows, backoffs);
      const firstResult = await runTrackerPoller(env, { cron: "* * * * *", scheduledTime: 1710000000000 }, {
        github(invocation) {
          calls.push({ teamId: invocation.team.teamId, adapter: invocation.adapter });
          if (invocation.team.teamId === "limited-team") {
            throw Object.assign(new Error("github API rate limited"), { retryAfterMs: 120_000 });
          }
        },
        linear(invocation) {
          calls.push({ teamId: invocation.team.teamId, adapter: invocation.adapter });
        },
      });

      expect(firstResult).toMatchObject({ teamsSeen: 2, teamsEnabled: 2, teamsSkippedBackoff: 0, adapterCalls: 2 });
      expect(calls).toEqual([
        { teamId: "limited-team", adapter: "github" },
        { teamId: "healthy-team", adapter: "github" },
      ]);
      expect(consoleWarn).toHaveBeenCalledWith(JSON.stringify({
        event: "tracker_poller_team_backoff_set",
        teamId: "limited-team",
        adapter: "github",
        retryAfterMs: 120000,
        retryAtMs: clockStart + 120000,
        backoffCount: 1,
        message: "github API rate limited",
      }));

      calls.length = 0;
      vi.setSystemTime(clockStart + 60_000);
      const evictedIsolateEnv = createEnv(rows, backoffs);
      const skippedResult = await runTrackerPoller(evictedIsolateEnv, { cron: "* * * * *", scheduledTime: 1710000060000 }, {
        github(invocation) {
          calls.push({ teamId: invocation.team.teamId, adapter: invocation.adapter });
        },
        linear(invocation) {
          calls.push({ teamId: invocation.team.teamId, adapter: invocation.adapter });
        },
      });

      expect(skippedResult).toMatchObject({ teamsSkippedBackoff: 1, adapterCalls: 1 });
      expect(calls).toEqual([{ teamId: "healthy-team", adapter: "github" }]);

      calls.length = 0;
      vi.setSystemTime(clockStart + 120_000);
      const resumedResult = await runTrackerPoller(env, { cron: "* * * * *", scheduledTime: 1710000120000 }, {
        github(invocation) {
          calls.push({ teamId: invocation.team.teamId, adapter: invocation.adapter });
        },
        linear(invocation) {
          calls.push({ teamId: invocation.team.teamId, adapter: invocation.adapter });
        },
      });

      expect(resumedResult).toMatchObject({ teamsSkippedBackoff: 0, adapterCalls: 3 });
      expect(calls).toEqual([
        { teamId: "limited-team", adapter: "github" },
        { teamId: "limited-team", adapter: "linear" },
        { teamId: "healthy-team", adapter: "github" },
      ]);
    } finally {
      vi.useRealTimers();
      consoleWarn.mockRestore();
    }
  });
});

describe("enabledTrackersFromConfig", () => {
  const cases: Array<{ name: string; yaml: string; want: PollerAdapterName[] }> = [
    { name: "disabled tracker", yaml: "tracker:\n  enabled: false\n  type: linear\n", want: [] },
    { name: "typed linear tracker", yaml: "tracker:\n  enabled: true\n  type: linear\n", want: ["linear"] },
    { name: "inline github tracker", yaml: "tracker: github\n", want: ["github"] },
    { name: "typed plane tracker", yaml: "tracker:\n  type: plane\n", want: ["plane"] },
    { name: "nested plane tracker", yaml: "tracker:\n  plane:\n    workspace_slug: acme\n    project_id: proj-1\n", want: ["plane"] },
    { name: "nested adapters", yaml: "tracker:\n  github:\n    repos: []\n  internal_board:\n    enabled: true\n", want: ["github", "internal-board"] },
    { name: "plane combined with linear", yaml: "tracker:\n  type: linear\n  plane:\n    workspace_slug: acme\n", want: ["linear", "plane"] },
    { name: "no tracker config", yaml: "team:\n  name: acme\n", want: [] },
  ];

  it.each(cases)("returns configured adapters for $name", ({ yaml, want }) => {
    expect(enabledTrackersFromConfig(yaml)).toEqual(want);
  });
});

describe("tracker poller wrangler config", () => {
  it("is deployed as its own scheduled Worker", async () => {
    const wranglerToml = await import("../../wrangler.tracker-poller.toml?raw");

    expect(wranglerToml.default).toContain('main = "src/poller/index.ts"');
    expect(wranglerToml.default).toContain("[triggers]");
    expect(wranglerToml.default).toContain('crons = [ "* * * * *" ]');
    expect(wranglerToml.default).toContain("[env.staging.triggers]");
    expect(wranglerToml.default).toContain("[env.production.triggers]");
    expect(wranglerToml.default).toContain("[[analytics_engine_datasets]]");
    expect(wranglerToml.default).toContain('binding = "TRACKER_POLLER_METRICS"');
    expect(wranglerToml.default).toContain('binding = "OBSERVABILITY_METRICS"');
  });
});

type TeamConfigFixture = {
  teamId: string;
  contentHash: string;
  contentYaml: string;
};

type TeamBackoffFixture = {
  retryAtMs: number;
  adapter: PollerAdapterName;
  backoffCount: number;
};

function createEnv(rows: TeamConfigFixture[], backoffs = new Map<string, TeamBackoffFixture>()): PollerEnv {
  const db = {
    prepare(query: string) {
      return {
        bind(...values: unknown[]) {
          return d1Statement(query, values, rows, backoffs);
        },
        all<T>() {
          return Promise.resolve({ results: rows as T[] });
        },
      };
    },
  };

  return { CONTROL_PLANE_DB: db as unknown as D1Database };
}

function d1Statement(
  query: string,
  values: unknown[],
  rows: TeamConfigFixture[],
  backoffs: Map<string, TeamBackoffFixture>,
) {
  return {
    all<T>() {
      return Promise.resolve({ results: rows as T[] });
    },
    first<T>() {
      if (query.includes("FROM audit_log")) {
        return Promise.resolve(null);
      }
      expect(query).toContain("FROM tracker_poller_backoffs");
      const teamId = String(values[0]);
      const backoff = backoffs.get(teamId);
      if (backoff === undefined) {
        return Promise.resolve(null);
      }
      return Promise.resolve({
        retryAtMs: backoff.retryAtMs,
        adapter: backoff.adapter,
        backoffCount: backoff.backoffCount,
      } as T);
    },
    run() {
      const teamId = String(values[0]);
      if (query.includes("DELETE FROM tracker_poller_backoffs")) {
        backoffs.delete(teamId);
        return Promise.resolve({ success: true });
      }

      expect(query).toContain("INSERT INTO tracker_poller_backoffs");
      backoffs.set(teamId, {
        retryAtMs: Number(values[1]),
        adapter: values[2] as PollerAdapterName,
        backoffCount: Number(values[3]),
      });
      return Promise.resolve({ success: true });
    },
  };
}

function createExecutionContext(): ExecutionContext {
  return {
    passThroughOnException() {},
    waitUntil(_promise: Promise<unknown>) {},
    props: {},
  };
}

function hashFor(seed: string): string {
  return seed.padEnd(64, "0").slice(0, 64);
}

function durableObjectNamespace(handler: (request: Request) => Promise<Response>): DurableObjectNamespace {
  return {
    idFromName(name: string) {
      return { name };
    },
    idFromString(id: string) {
      return { id };
    },
    get() {
      return { fetch: handler };
    },
    jurisdiction() {
      return this;
    },
  } as unknown as DurableObjectNamespace;
}

function linearIssueNode(input: { id: string; identifier: string; title: string; stateType: string }): Record<string, unknown> {
  return {
    id: input.id,
    identifier: input.identifier,
    title: input.title,
    description: "",
    priority: 2,
    state: { name: "Todo", type: input.stateType },
    url: `https://linear.app/acme/${input.identifier}`,
    labels: { nodes: [{ name: "Bug" }] },
    createdAt: "2026-05-09T01:00:00Z",
    updatedAt: "2026-05-09T02:00:00Z",
    inverseRelations: { nodes: [] },
  };
}

function githubIssuePayload(input: { number: number; title: string }): Record<string, unknown> {
  return {
    number: input.number,
    node_id: `I_kwDOAAABc84AbCd${input.number}`,
    title: input.title,
    body: "",
    state: "open",
    labels: [{ name: "Bug" }],
    html_url: `https://github.com/octocat/hello-world/issues/${input.number}`,
    created_at: "2026-05-09T01:00:00Z",
    updated_at: "2026-05-09T02:00:00Z",
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
