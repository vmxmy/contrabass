import { describe, expect, it } from "vitest";

import type { PollerEnv, PollerInvocation } from "./index";
import { normalizeInternalBoardIssue, pollInternalBoard } from "./internal-board";

describe("pollInternalBoard", () => {
  it("reads D1 internal board rows and posts them to TeamCoordinator", async () => {
    const postedRequests: Request[] = [];
    const env: PollerEnv = {
      CONTROL_PLANE_DB: internalBoardDb([
        internalBoardRow({ id: "CB-2", status: "retry", blockers: [], updatedAt: "2026-05-09T02:00:00Z" }),
        internalBoardRow({ id: "CB-1", status: "todo", blockers: ["CB-0"], updatedAt: "2026-05-09T01:00:00Z" }),
      ]),
      TEAM_COORDINATOR: durableObjectNamespace(async (request) => {
        postedRequests.push(request);
        return Response.json({ board: { open: [], claimed: [], running: [], done: [] } });
      }),
    };

    const result = await pollInternalBoard(invocation(env));

    expect(result).toEqual({ teamId: "team-alpha", issuesSeen: 2, issuesNew: 2, issuesUpdated: 0 });
    expect(postedRequests).toHaveLength(1);
    const posted = postedRequests[0];
    expect(posted?.url).toBe("https://team-coordinator.internal/board/refresh");
    expect(posted?.headers.get("x-contrabass-source")).toBe("tracker-poller-internal-board");
    await expect(posted?.json()).resolves.toMatchObject({
      issues: [
        {
          issueRef: "CB-2",
          external_id: "internal-board:CB-2",
          phase: "open",
          tracker: "internal-board",
          issue: { id: "CB-2", state: "unclaimed", blocked_by: [], tracker_meta: { provider: "internal-board" } },
        },
        {
          issueRef: "CB-1",
          external_id: "internal-board:CB-1",
          phase: "open",
          tracker: "internal-board",
          issue: { id: "CB-1", state: "unclaimed", blocked_by: ["CB-0"] },
        },
      ],
    });
  });

  it("maps non-runnable board statuses away from the open phase", async () => {
    const postedRequests: Request[] = [];
    const env: PollerEnv = {
      CONTROL_PLANE_DB: internalBoardDb([
        internalBoardRow({ id: "CB-3", status: "in_progress", claimedBy: "worker-1" }),
        internalBoardRow({ id: "CB-4", status: "done" }),
      ]),
      TEAM_COORDINATOR: durableObjectNamespace(async (request) => {
        postedRequests.push(request);
        return Response.json({ ok: true });
      }),
    };

    await pollInternalBoard(invocation(env));

    await expect(postedRequests[0]?.json()).resolves.toMatchObject({
      issues: [
        { issueRef: "CB-3", phase: "claimed", issue: { state: "claimed", tracker_meta: { claimed_by: "worker-1" } } },
        { issueRef: "CB-4", phase: "done", issue: { state: "claimed" } },
      ],
    });
  });

  it("requires D1 and TeamCoordinator bindings before dropping rows", async () => {
    await expect(pollInternalBoard(invocation({}))).rejects.toThrow("CONTROL_PLANE_DB binding required for Internal Board poller");

    const env: PollerEnv = { CONTROL_PLANE_DB: internalBoardDb([internalBoardRow({ id: "CB-1" })]) };
    await expect(pollInternalBoard(invocation(env))).rejects.toThrow("TEAM_COORDINATOR binding required for Internal Board poller");
  });
});

describe("normalizeInternalBoardIssue", () => {
  it("preserves local-board fields and validates JSON columns", () => {
    expect(normalizeInternalBoardIssue(internalBoardRow({
      id: "CB-9",
      title: "Ship board adapter",
      body: "Implement D1 polling",
      labels: ["Poller", "Cloud"],
      status: "todo",
      priority: 3,
      assignee: "team-alpha",
      blockers: [],
      parentId: "CB-1",
      childIds: ["CB-10"],
      branchName: "feature/internal-board",
      trackerMeta: { source: "dashboard" },
    }))).toMatchObject({
      id: "CB-9",
      external_id: "internal-board:CB-9",
      identifier: "CB-9",
      title: "Ship board adapter",
      description: "Implement D1 polling",
      state: "unclaimed",
      priority: 3,
      labels: ["poller", "cloud"],
      branch_name: "feature/internal-board",
      blocked_by: [],
      assignee: "team-alpha",
      tracker_meta: {
        provider: "internal-board",
        internal_status: "todo",
        parent_id: "CB-1",
        child_ids: ["CB-10"],
        raw: { source: "dashboard" },
      },
    });

    expect(() => normalizeInternalBoardIssue({ ...internalBoardRow({ id: "CB-bad" }), labels: "{}" }))
      .toThrow("internal board row CB-bad labels must be a JSON array");
  });
});

function invocation(env: PollerEnv): PollerInvocation {
  return {
    team: { teamId: "team-alpha", contentHash: "hash", contentYaml: "tracker:\n  type: internal-board\n" },
    adapter: "internal-board",
    scheduledTime: 1710000000000,
    cron: "* * * * *",
    env,
  };
}

type InternalBoardRowFixture = Parameters<typeof normalizeInternalBoardIssue>[0];

type InternalBoardRowInput = {
  id: string;
  externalId?: string;
  title?: string;
  body?: string;
  labels?: string[];
  status?: "todo" | "in_progress" | "retry" | "done";
  priority?: number;
  assignee?: string | null;
  blockers?: string[];
  parentId?: string | null;
  childIds?: string[];
  branchName?: string | null;
  claimedBy?: string | null;
  trackerMeta?: Record<string, unknown>;
  createdAt?: string;
  updatedAt?: string;
};

function internalBoardRow(input: InternalBoardRowInput): InternalBoardRowFixture {
  return {
    id: input.id,
    externalId: input.externalId ?? `internal-board:${input.id}`,
    title: input.title ?? `Issue ${input.id}`,
    body: input.body ?? "Body",
    labels: JSON.stringify(input.labels ?? ["bug"]),
    status: input.status ?? "todo",
    priority: input.priority ?? 0,
    assignee: input.assignee ?? null,
    blockers: JSON.stringify(input.blockers ?? []),
    parentId: input.parentId ?? null,
    childIds: JSON.stringify(input.childIds ?? []),
    branchName: input.branchName ?? null,
    claimedBy: input.claimedBy ?? null,
    trackerMeta: JSON.stringify(input.trackerMeta ?? {}),
    createdAt: input.createdAt ?? "2026-05-09T00:00:00Z",
    updatedAt: input.updatedAt ?? "2026-05-09T00:00:00Z",
  };
}

function internalBoardDb(rows: InternalBoardRowFixture[]): D1Database {
  return {
    prepare(query: string) {
      return {
        bind(...values: unknown[]) {
          expect(query).toContain("FROM internal_board");
          expect(values).toEqual(["team-alpha"]);
          return {
            all<T>() {
              return Promise.resolve({ results: rows as T[] });
            },
          };
        },
      };
    },
  } as unknown as D1Database;
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
