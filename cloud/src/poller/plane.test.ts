import { describe, expect, it, vi } from "vitest";

import { normalizePlaneIssue, PlaneClient, PlaneRateLimitError, pollPlane } from "./plane";
import type { PollerEnv, PollerInvocation } from "./index";

describe("PlaneClient", () => {
  it("fetches work items with cursor pagination and excludes terminal states", async () => {
    const requests: Array<{ url: string; apiKey: string | null }> = [];
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      requests.push({ url: url.pathname + url.search, apiKey: headersFrom(init?.headers).get("x-api-key") });

      const cursor = url.searchParams.get("cursor");

      if (cursor === null) {
        return Response.json({
          results: [
            planeWorkItemPayload({ id: "issue-1", sequence_id: 1, name: "Fix bug", state: { id: "state-todo", name: "Todo", group: "unstarted" } }),
            planeWorkItemPayload({ id: "issue-2", sequence_id: 2, name: "Done item", state: { id: "state-done", name: "Done", group: "completed" } }),
          ],
          next_cursor: "2:1:0",
          next_page_results: true,
          total_results: 3,
        });
      }
      return Response.json({
        results: [
          planeWorkItemPayload({ id: "issue-3", sequence_id: 3, name: "Started", state: { id: "state-progress", name: "In Progress", group: "started" } }),
        ],
        next_cursor: "",
        next_page_results: false,
        total_results: 3,
      });
    });

    const client = new PlaneClient({ token: "plane-secret", host: "https://plane.test", fetcher, pageSize: 2 });
    const issues = await client.fetchWorkItems("acme", "proj-1");

    expect(issues).toHaveLength(2);
    expect(issues[0]?.id).toBe("issue-1");
    expect(issues[0]?.state).toBe("unclaimed");
    expect(issues[0]?.tracker_meta.plane_state_group).toBe("unstarted");
    expect(issues[1]?.id).toBe("issue-3");
    expect(issues[1]?.state).toBe("claimed");
    expect(issues[1]?.tracker_meta.plane_state_group).toBe("started");
    expect(requests).toHaveLength(2);
    expect(requests[0]?.apiKey).toBe("plane-secret");
    expect(requests[0]?.url).toContain("work-items");
    expect(requests[0]?.url).toContain("expand=state%2Clabels");
    expect(requests[0]?.url).toContain("per_page=2");
    expect(requests[1]?.url).toContain("cursor=2%3A1%3A0");
  });

  it("handles empty results", async () => {
    const fetcher = vi.fn(async () => Response.json({ results: [], next_cursor: "", next_page_results: false, total_results: 0 }));
    const client = new PlaneClient({ token: "plane-secret", host: "https://plane.test", fetcher });
    const issues = await client.fetchWorkItems("acme", "proj-1");

    expect(issues).toEqual([]);
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("maps HTTP errors to structured errors", async () => {
    const rateLimited = new PlaneClient({
      token: "token",
      fetcher: async () => new Response("slow down", { status: 429, headers: { "Retry-After": "7" } }),
    });
    await expect(rateLimited.fetchWorkItems("acme", "proj-1")).rejects.toMatchObject({
      name: "PlaneRateLimitError",
      retryAfterMs: 7000,
    } satisfies Partial<PlaneRateLimitError>);

    const unauthorized = new PlaneClient({
      token: "token",
      fetcher: async () => new Response("bad token", { status: 401 }),
    });
    await expect(unauthorized.fetchWorkItems("acme", "proj-1")).rejects.toThrow("plane API auth error (status 401)");

    const serverError = new PlaneClient({
      token: "token",
      fetcher: async () => new Response("internal error", { status: 500 }),
    });
    await expect(serverError.fetchWorkItems("acme", "proj-1")).rejects.toThrow("plane API error (status 500)");
  });

  it("requires non-empty token", () => {
    expect(() => new PlaneClient({ token: "" })).toThrow("plane API token required");
  });
});

describe("normalizePlaneIssue", () => {
  it("maps Plane work item fields to poller issue shape", () => {
    const item = {
      id: "uuid-1",
      sequence_id: "42",
      name: "Fix login bug",
      description_html: "<p>Details</p>",
      state: { id: "state-progress", name: "In Progress", group: "started" },
      priority: "high",
      labels: [{ id: "label-1", name: "Bug" }, { id: "label-2", name: "Backend" }],
      created_at: "2026-05-09T01:00:00Z",
      updated_at: "2026-05-09T02:00:00Z",
    };

    const result = normalizePlaneIssue(item, "state-progress", "started", "acme", "proj-1");

    expect(result).toMatchObject({
      id: "uuid-1",
      external_id: "uuid-1",
      identifier: "42",
      title: "Fix login bug",
      description: "<p>Details</p>",
      state: "claimed",
      priority: 2,
      labels: ["bug", "backend"],
      branch_name: "symphony/42",
      blocked_by: [],
      created_at: "2026-05-09T01:00:00Z",
      updated_at: "2026-05-09T02:00:00Z",
      tracker_meta: {
        provider: "plane",
        plane_state_id: "state-progress",
        plane_state_group: "started",
        workspace_slug: "acme",
        project_id: "proj-1",
      },
    });
  });

  it("maps backlog/unstarted to unclaimed state", () => {
    const base = { id: "x", sequence_id: "1", name: "t", state: {} };
    expect(normalizePlaneIssue({ ...base, state: { id: "s1", name: "Backlog", group: "backlog" } }, "s1", "backlog", "acme", "proj-1").state).toBe("unclaimed");
    expect(normalizePlaneIssue({ ...base, state: { id: "s2", name: "Todo", group: "unstarted" } }, "s2", "unstarted", "acme", "proj-1").state).toBe("unclaimed");
  });

  it("extracts model override from description HTML", () => {
    const item = {
      id: "uuid-3",
      sequence_id: "99",
      name: "Model task",
      description_html: "<p>Use specific model</p>\n<!-- model: gpt-5.5 -->",
      state: { id: "s", name: "Todo", group: "unstarted" },
      labels: [],
    };
    expect(normalizePlaneIssue(item, "s", "unstarted", "acme", "proj-1").model_override).toBe("gpt-5.5");
  });

  it("maps priority strings to numbers", () => {
    const base = { id: "x", sequence_id: "1", name: "t", state: {} };
    expect(normalizePlaneIssue({ ...base, priority: "urgent" }, "s", "started", "acme", "proj-1").priority).toBe(1);
    expect(normalizePlaneIssue({ ...base, priority: "high" }, "s", "started", "acme", "proj-1").priority).toBe(2);
    expect(normalizePlaneIssue({ ...base, priority: "medium" }, "s", "started", "acme", "proj-1").priority).toBe(3);
    expect(normalizePlaneIssue({ ...base, priority: "low" }, "s", "started", "acme", "proj-1").priority).toBe(4);
    expect(normalizePlaneIssue({ ...base, priority: "none" }, "s", "started", "acme", "proj-1").priority).toBe(0);
    expect(normalizePlaneIssue({ ...base, priority: undefined }, "s", "started", "acme", "proj-1").priority).toBe(0);
  });
});

describe("pollPlane", () => {
  it("loads tracker config, resolves token, fetches work items, and posts to TeamCoordinator", async () => {
    const postedRequests: Request[] = [];
    const env: PollerEnv = {
      PLANE_API_KEY: "plane-secret",
      TEAM_COORDINATOR: durableObjectNamespace(async (request) => {
        postedRequests.push(request);
        return Response.json({ issueStats: { issuesNew: 2, issuesUpdated: 0 } });
      }),
    };

    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(headersFrom(init?.headers).get("x-api-key")).toBe("plane-secret");
      return Response.json({
        results: [
          planeWorkItemPayload({ id: "issue-1", sequence_id: 1, name: "Fix bug", state: { id: "state-todo", name: "Todo", group: "unstarted" } }),
          planeWorkItemPayload({ id: "issue-2", sequence_id: 2, name: "Another", state: { id: "state-todo", name: "Todo", group: "unstarted" } }),
        ],
        next_cursor: "",
        next_page_results: false,
        total_results: 2,
      });
    });

    const result = await pollPlane(
      invocation(env, "tracker:\n  plane:\n    workspace_slug: acme\n    project_id: proj-1\n"),
      fetcher,
    );

    expect(result).toEqual({ teamId: "team-alpha", issuesSeen: 2, issuesNew: 2, issuesUpdated: 0 });
    expect(postedRequests).toHaveLength(1);
    const posted = postedRequests[0];
    expect(posted?.url).toBe("https://team-coordinator.internal/board/refresh");
    expect(posted?.headers.get("x-contrabass-source")).toBe("tracker-poller-plane");
    await expect(posted?.json()).resolves.toMatchObject({
      issues: [
        { issueRef: "1", external_id: "issue-1", phase: "open", tracker: "plane" },
        { issueRef: "2", external_id: "issue-2", phase: "open", tracker: "plane" },
      ],
    });
  });

  it("resolves token from env ref $PLANE_API_KEY", async () => {
    const env: PollerEnv = { MY_PLANE_TOKEN: "ref-token" };
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(headersFrom(init?.headers).get("x-api-key")).toBe("ref-token");
      return Response.json({ results: [], next_cursor: "", next_page_results: false, total_results: 0 });
    });

    const result = await pollPlane(
      invocation(env, "tracker:\n  plane:\n    api_key: $MY_PLANE_TOKEN\n    workspace_slug: acme\n    project_id: proj-1\n"),
      fetcher,
    );
    expect(result.issuesSeen).toBe(0);
  });

  it("throws when token is not found", async () => {
    const env: PollerEnv = {};
    await expect(
      pollPlane(invocation(env, "tracker:\n  plane:\n    workspace_slug: acme\n    project_id: proj-1\n"), async () => new Response()),
    ).rejects.toThrow("plane tracker secret binding not found for team team-alpha");
  });

  it("throws when workspace_slug is missing", async () => {
    const env: PollerEnv = { PLANE_API_KEY: "token" };
    await expect(
      pollPlane(invocation(env, "tracker:\n  plane:\n    project_id: proj-1\n"), async () => new Response()),
    ).rejects.toThrow("requires workspace_slug");
  });

  it("throws when project_id is missing", async () => {
    const env: PollerEnv = { PLANE_API_KEY: "token" };
    await expect(
      pollPlane(invocation(env, "tracker:\n  plane:\n    workspace_slug: acme\n"), async () => new Response()),
    ).rejects.toThrow("requires project_id");
  });

  it("requires TeamCoordinator binding when issues are found", async () => {
    const env: PollerEnv = { PLANE_API_KEY: "plane-secret" };
    const fetcher = vi.fn(async () => Response.json({
      results: [planeWorkItemPayload({ id: "issue-1", sequence_id: 1, name: "Bug", state: { id: "state-todo", name: "Todo", group: "unstarted" } })],
      next_cursor: "",
      next_page_results: false,
      total_results: 1,
    }));

    await expect(
      pollPlane(invocation(env, "tracker:\n  plane:\n    workspace_slug: acme\n    project_id: proj-1\n"), fetcher),
    ).rejects.toThrow("TEAM_COORDINATOR binding required for Plane poller");
  });
});

function invocation(env: PollerEnv, contentYaml: string): PollerInvocation {
  return {
    team: { teamId: "team-alpha", contentHash: "hash", contentYaml },
    adapter: "plane",
    scheduledTime: 1710000000000,
    cron: "* * * * *",
    env,
  };
}

function planeWorkItemPayload(input: { id: string; sequence_id: number; name: string; state: Record<string, unknown> }): Record<string, unknown> {
  return {
    id: input.id,
    sequence_id: input.sequence_id,
    name: input.name,
    description_html: "<p>Description</p>",
    state: input.state,
    priority: "medium",
    labels: [{ id: "label-1", name: "Bug" }],
    assignees: [],
    created_at: "2026-05-09T01:00:00Z",
    updated_at: "2026-05-09T02:00:00Z",
  };
}

function headersFrom(headers: HeadersInit | undefined): Headers {
  return new Headers(headers);
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
