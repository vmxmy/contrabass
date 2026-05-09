import { describe, expect, it, vi } from "vitest";

import { LinearAuthError, LinearClient, LinearRateLimitError, normalizeLinearIssue, pollLinear } from "./linear";
import type { PollerEnv, PollerInvocation } from "./index";

describe("LinearClient", () => {
  it("fetches, paginates, normalizes, and filters Linear issues", async () => {
    const requests: Array<{ authorization: string | null; body: unknown }> = [];
    const fetcher = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      requests.push({
        authorization: headersFrom(init?.headers).get("authorization"),
        body: JSON.parse(String(init?.body)),
      });
      const request = requests.at(-1)?.body;
      const variables = isRecord(request) && isRecord(request.variables) ? request.variables : {};
      const after = variables.after;
      return Response.json({
        data: {
          issues: after === undefined
            ? {
              nodes: [
                linearIssueNode({ id: "issue-1", identifier: "LIN-1", title: "Fix bug", stateType: "unstarted" }),
                linearIssueNode({ id: "issue-done", identifier: "LIN-2", title: "Done", stateType: "completed" }),
              ],
              pageInfo: { hasNextPage: true, endCursor: "cursor-1" },
            }
            : {
              nodes: [linearIssueNode({ id: "issue-3", identifier: "LIN-3", title: "Started", stateType: "started" })],
              pageInfo: { hasNextPage: false, endCursor: null },
            },
        },
      });
    });

    const client = new LinearClient({ token: "linear-token", endpoint: "https://linear.test/graphql", fetcher, pageSize: 2 });
    const issues = await client.fetchIssues("query FetchIssues { issues { nodes { id } } }", { projectSlug: "team-project" });

    expect(issues.map((issue) => issue.id)).toEqual(["issue-1", "issue-3"]);
    expect(issues[0]).toMatchObject({
      external_id: "issue-1",
      identifier: "LIN-1",
      title: "Fix bug",
      state: "unclaimed",
      labels: ["bug"],
      blocked_by: ["LIN-0"],
      branch_name: "symphony/lin-1",
      model_override: "gpt-5.5",
      tracker_meta: { provider: "linear", linear_state: "Todo", linear_state_type: "unstarted" },
    });
    expect(issues[1]?.state).toBe("claimed");
    expect(requests).toHaveLength(2);
    expect(requests[0]?.authorization).toBe("linear-token");
    expect(requests.map((request) => {
      const body = isRecord(request.body) ? request.body : {};
      const variables = isRecord(body.variables) ? body.variables : {};
      return variables.after;
    })).toEqual([undefined, "cursor-1"]);
  });

  it("maps Linear HTTP errors to structured errors", async () => {
    const rateLimited = new LinearClient({
      token: "token",
      fetcher: async () => new Response("slow down", { status: 429, headers: { "Retry-After": "7" } }),
    });
    await expect(rateLimited.fetchIssues("query", {})).rejects.toMatchObject({
      name: "LinearRateLimitError",
      retryAfterMs: 7000,
    } satisfies Partial<LinearRateLimitError>);

    const unauthorized = new LinearClient({
      token: "token",
      fetcher: async () => new Response("bad token", { status: 401 }),
    });
    await expect(unauthorized.fetchIssues("query", {})).rejects.toMatchObject({
      name: "LinearAuthError",
      statusCode: 401,
    } satisfies Partial<LinearAuthError>);
  });

  it("honors HTTP-date Retry-After values", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-09T01:00:00Z"));
    try {
      const rateLimited = new LinearClient({
        token: "token",
        fetcher: async () => new Response("slow down", {
          status: 429,
          headers: { "Retry-After": "Sat, 09 May 2026 01:02:00 GMT" },
        }),
      });

      await expect(rateLimited.fetchIssues("query", {})).rejects.toMatchObject({
        name: "LinearRateLimitError",
        retryAfterMs: 120000,
      } satisfies Partial<LinearRateLimitError>);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("pollLinear", () => {
  it("loads tracker config, resolves the team secret, and posts open issues to TeamCoordinator", async () => {
    const postedRequests: Request[] = [];
    const env: PollerEnv = {
      TRACKER_TEAM_ALPHA_LINEAR_TOKEN: "linear-secret",
      TEAM_COORDINATOR: durableObjectNamespace(async (request) => {
        postedRequests.push(request);
        return Response.json({ board: { open: [], claimed: [], running: [], done: [] } });
      }),
    };
    const fetcher = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(headersFrom(init?.headers).get("authorization")).toBe("linear-secret");
      const body = JSON.parse(String(init?.body));
      expect(body).toMatchObject({ variables: { projectSlug: "alpha", first: 5 } });
      return Response.json({
        data: {
          issues: {
            nodes: [linearIssueNode({ id: "issue-1", identifier: "LIN-1", title: "Fix bug", stateType: "unstarted" })],
            pageInfo: { hasNextPage: false },
          },
        },
      });
    });

    const result = await pollLinear(invocation(env, `tracker:\n  linear:\n    project_slug: alpha\n    page_size: 5\n`), fetcher);

    expect(result).toEqual({ teamId: "team-alpha", issuesSeen: 1, issuesNew: 1, issuesUpdated: 0 });
    expect(postedRequests).toHaveLength(1);
    const posted = postedRequests[0];
    expect(posted?.url).toBe("https://team-coordinator.internal/board/refresh");
    await expect(posted?.json()).resolves.toMatchObject({
      issues: [
        {
          issueRef: "LIN-1",
          external_id: "issue-1",
          phase: "open",
          tracker: "linear",
          issue: { id: "issue-1", identifier: "LIN-1", tracker_meta: { provider: "linear" } },
        },
      ],
    });
  });

  it("supports saved GraphQL query and explicit token binding references", async () => {
    const env: PollerEnv = { LINEAR_TOKEN_REF: "bound-token" };
    const fetcher = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(headersFrom(init?.headers).get("authorization")).toBe("bound-token");
      const body = JSON.parse(String(init?.body));
      expect(body.query).toContain("query TeamIssues");
      expect(body.variables).toEqual({ first: 50 });
      return Response.json({ data: { issues: { nodes: [], pageInfo: { hasNextPage: false } } } });
    });

    const result = await pollLinear(invocation(env, `tracker:\n  linear:\n    token: $LINEAR_TOKEN_REF\n    query: |\n      query TeamIssues($first: Int!) {\n        issues(first: $first) { nodes { id } pageInfo { hasNextPage endCursor } }\n      }\n`), fetcher);

    expect(result).toEqual({ teamId: "team-alpha", issuesSeen: 0, issuesNew: 0, issuesUpdated: 0 });
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("requires TeamCoordinator binding before dropping fetched issues", async () => {
    const env: PollerEnv = { TRACKER_TEAM_ALPHA_LINEAR_TOKEN: "linear-secret" };
    const fetcher = vi.fn(async () => Response.json({
      data: {
        issues: {
          nodes: [linearIssueNode({ id: "issue-1", identifier: "LIN-1", title: "Fix bug", stateType: "unstarted" })],
          pageInfo: { hasNextPage: false },
        },
      },
    }));

    await expect(pollLinear(invocation(env, `tracker:\n  linear:\n    project_slug: alpha\n`), fetcher))
      .rejects.toThrow("TEAM_COORDINATOR binding required for Linear poller");
  });
});

describe("normalizeLinearIssue", () => {
  it("keeps fixtures without state type claimable-compatible", () => {
    expect(normalizeLinearIssue(linearIssueNode({ id: "issue-1", identifier: "LIN-1", title: "Todo", stateType: "" }))).toMatchObject({
      state: "unclaimed",
      tracker_meta: { linear_state_type: "" },
    });
  });
});

function invocation(env: PollerEnv, contentYaml: string): PollerInvocation {
  return {
    team: { teamId: "team-alpha", contentHash: "hash", contentYaml },
    adapter: "linear",
    scheduledTime: 1710000000000,
    cron: "* * * * *",
    env,
  };
}

function linearIssueNode(input: { id: string; identifier: string; title: string; stateType: string }): Record<string, unknown> {
  return {
    id: input.id,
    identifier: input.identifier,
    title: input.title,
    description: "Body\n<!-- model: gpt-5.5 -->",
    priority: 2,
    state: { name: input.stateType === "started" ? "In Progress" : "Todo", type: input.stateType },
    url: `https://linear.app/acme/${input.identifier}`,
    labels: { nodes: [{ name: "Bug" }] },
    createdAt: "2026-05-09T01:00:00Z",
    updatedAt: "2026-05-09T02:00:00Z",
    inverseRelations: { nodes: [{ type: "blocks", issue: { identifier: "LIN-0" } }] },
  };
}

function headersFrom(headers: HeadersInit | undefined): Headers {
  return new Headers(headers);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
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
