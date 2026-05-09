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
});

describe("enabledTrackersFromConfig", () => {
  const cases: Array<{ name: string; yaml: string; want: PollerAdapterName[] }> = [
    { name: "disabled tracker", yaml: "tracker:\n  enabled: false\n  type: linear\n", want: [] },
    { name: "typed linear tracker", yaml: "tracker:\n  enabled: true\n  type: linear\n", want: ["linear"] },
    { name: "inline github tracker", yaml: "tracker: github\n", want: ["github"] },
    { name: "nested adapters", yaml: "tracker:\n  github:\n    repos: []\n  internal_board:\n    enabled: true\n", want: ["github", "internal-board"] },
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
  });
});

type TeamConfigFixture = {
  teamId: string;
  contentHash: string;
  contentYaml: string;
};

function createEnv(rows: TeamConfigFixture[]): PollerEnv {
  const statement = {
    all<T>() {
      return Promise.resolve({ results: rows as T[] });
    },
  };
  const db = {
    prepare(_query: string) {
      return statement;
    },
  };

  return { CONTROL_PLANE_DB: db as unknown as D1Database };
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
