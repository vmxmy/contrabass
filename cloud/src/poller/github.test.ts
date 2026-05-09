import { describe, expect, it, vi } from "vitest";

import { GitHubAuthError, GitHubClient, GitHubRateLimitError, normalizeGitHubIssue, pollGitHub } from "./github";
import type { PollerEnv, PollerInvocation } from "./index";

describe("GitHubClient", () => {
  it("fetches, paginates, normalizes, and filters GitHub issues", async () => {
    const requests: Request[] = [];
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      requests.push(request);
      const url = new URL(request.url);
      const page = url.searchParams.get("page");
      if (page === "1") {
        return Response.json([
          githubIssue({ number: 42, title: "Fix parser panic", labels: ["Bug", "P0"] }),
          githubIssue({ number: 43, title: "PR item", pullRequest: true }),
        ]);
      }
      return Response.json([githubIssue({ number: 44, title: "Improve logs", labels: ["Enhancement"] })]);
    });

    const client = new GitHubClient({
      token: "ghp_token",
      endpoint: "https://github.test/api/v3",
      repos: [{ owner: "octocat", repo: "hello-world" }],
      labels: ["bug", "p0"],
      assignee: "bot-user",
      fetcher,
      pageSize: 2,
    });

    const issues = await client.fetchIssues();

    expect(issues.map((issue) => issue.id)).toEqual(["42", "44"]);
    expect(issues[0]).toMatchObject({
      external_id: "octocat/hello-world#42",
      identifier: "octocat/hello-world#42",
      title: "Fix parser panic",
      state: "unclaimed",
      labels: ["bug", "p0"],
      branch_name: "symphony/hello-world-42",
      blocked_by: ["10", "11"],
      model_override: "gpt-5.5",
      tracker_meta: {
        provider: "github",
        github_node_id: "I_kwDOAAABc84AbCd42",
        github_state: "open",
        repository: "octocat/hello-world",
      },
    });
    expect(requests).toHaveLength(2);
    expect(requests[0]?.headers.get("authorization")).toBe("Bearer ghp_token");
    expect(requests[0]?.headers.get("accept")).toBe("application/vnd.github+json");
    expect(requests[0]?.headers.get("x-github-api-version")).toBe("2022-11-28");
    expect(new URL(requests[0]?.url ?? "").pathname).toBe("/api/v3/repos/octocat/hello-world/issues");
    expect(new URL(requests[0]?.url ?? "").searchParams.get("labels")).toBe("bug,p0");
    expect(new URL(requests[0]?.url ?? "").searchParams.get("assignee")).toBe("bot-user");
  });

  it("maps GitHub HTTP errors to structured errors", async () => {
    const rateLimited = new GitHubClient({
      token: "token",
      repos: [{ owner: "octocat", repo: "hello-world" }],
      fetcher: async () => new Response("slow down", { status: 429, headers: { "Retry-After": "7" } }),
    });
    await expect(rateLimited.fetchIssues()).rejects.toMatchObject({
      name: "GitHubRateLimitError",
      retryAfterMs: 7000,
    } satisfies Partial<GitHubRateLimitError>);

    const unauthorized = new GitHubClient({
      token: "token",
      repos: [{ owner: "octocat", repo: "hello-world" }],
      fetcher: async () => new Response("bad token", { status: 401 }),
    });
    await expect(unauthorized.fetchIssues()).rejects.toMatchObject({
      name: "GitHubAuthError",
      statusCode: 401,
    } satisfies Partial<GitHubAuthError>);
  });

  it("honors HTTP-date Retry-After values", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-09T01:00:00Z"));
    try {
      const rateLimited = new GitHubClient({
        token: "token",
        repos: [{ owner: "octocat", repo: "hello-world" }],
        fetcher: async () => new Response("slow down", {
          status: 429,
          headers: { "Retry-After": "Sat, 09 May 2026 01:02:00 GMT" },
        }),
      });

      await expect(rateLimited.fetchIssues()).rejects.toMatchObject({
        name: "GitHubRateLimitError",
        retryAfterMs: 120000,
      } satisfies Partial<GitHubRateLimitError>);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("pollGitHub", () => {
  it("loads tracker config, resolves the team secret, and posts matching issues to TeamCoordinator", async () => {
    const postedRequests: Request[] = [];
    const env: PollerEnv = {
      TRACKER_TEAM_ALPHA_GITHUB_TOKEN: "github-secret",
      TEAM_COORDINATOR: durableObjectNamespace(async (request) => {
        postedRequests.push(request);
        return Response.json({ board: { open: [], claimed: [], running: [], done: [] } });
      }),
    };
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      expect(request.headers.get("authorization")).toBe("Bearer github-secret");
      const url = new URL(request.url);
      expect(url.pathname).toBe("/repos/octocat/hello-world/issues");
      expect(url.searchParams.get("labels")).toBe("bug,p0");
      expect(url.searchParams.get("per_page")).toBe("5");
      return Response.json([githubIssue({ number: 42, title: "Fix parser panic", labels: ["Bug"] })]);
    });

    const result = await pollGitHub(invocation(env, `tracker:\n  github:\n    repos:\n      - octocat/hello-world\n    labels: bug,p0\n    page_size: 5\n`), fetcher);

    expect(result).toEqual({ teamId: "team-alpha", issuesSeen: 1, issuesPosted: 1 });
    expect(postedRequests).toHaveLength(1);
    const posted = postedRequests[0];
    expect(posted?.url).toBe("https://team-coordinator.internal/board/refresh");
    await expect(posted?.json()).resolves.toMatchObject({
      issues: [
        {
          issueRef: "octocat/hello-world#42",
          external_id: "octocat/hello-world#42",
          phase: "open",
          tracker: "github",
          issue: { id: "42", identifier: "octocat/hello-world#42", tracker_meta: { provider: "github" } },
        },
      ],
    });
  });

  it("supports owner/repo config and explicit token binding references", async () => {
    const env: PollerEnv = { GITHUB_TOKEN_REF: "bound-token" };
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      expect(request.headers.get("authorization")).toBe("Bearer bound-token");
      expect(new URL(request.url).pathname).toBe("/repos/acme/api/issues");
      return Response.json([]);
    });

    const result = await pollGitHub(invocation(env, `tracker:\n  github:\n    token: $GITHUB_TOKEN_REF\n    owner: acme\n    repo: api\n`), fetcher);

    expect(result).toEqual({ teamId: "team-alpha", issuesSeen: 0, issuesPosted: 0 });
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("rejects raw token config values instead of accepting inline credentials", async () => {
    const env: PollerEnv = {};
    const fetcher = vi.fn(async () => Response.json([]));

    await expect(pollGitHub(invocation(env, `tracker:\n  github:\n    token: ghp_inlineCredential\n    repo: octocat/hello-world\n`), fetcher))
      .rejects.toThrow("github tracker token must reference a secret binding with $NAME");
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("polls plural assignees from config and de-duplicates matching issues", async () => {
    const postedRequests: Request[] = [];
    const requestAssignees: Array<string | null> = [];
    const env: PollerEnv = {
      TRACKER_TEAM_ALPHA_GITHUB_TOKEN: "github-secret",
      TEAM_COORDINATOR: durableObjectNamespace(async (request) => {
        postedRequests.push(request);
        return Response.json({ board: { open: [], claimed: [], running: [], done: [] } });
      }),
    };
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      const assignee = new URL(request.url).searchParams.get("assignee");
      requestAssignees.push(assignee);
      return Response.json(
        assignee === "alice"
          ? [githubIssue({ number: 42, title: "Shared issue" })]
          : [
            githubIssue({ number: 42, title: "Shared issue" }),
            githubIssue({ number: 43, title: "Bob issue" }),
          ],
      );
    });

    const result = await pollGitHub(invocation(env, `tracker:\n  github:\n    repo: octocat/hello-world\n    assignees:\n      - alice\n      - bob\n`), fetcher);

    expect(result).toEqual({ teamId: "team-alpha", issuesSeen: 2, issuesPosted: 2 });
    expect(requestAssignees).toEqual(["alice", "bob"]);
    expect(postedRequests).toHaveLength(1);
    await expect(postedRequests[0]?.json()).resolves.toMatchObject({
      issues: [
        { external_id: "octocat/hello-world#42" },
        { external_id: "octocat/hello-world#43" },
      ],
    });
  });

  it("writes an audit marker for invalid GitHub credentials and skips until the secret changes", async () => {
    const auditRuns: Array<{ query: string; values: unknown[] }> = [];
    const env: PollerEnv = {
      TRACKER_TEAM_ALPHA_GITHUB_TOKEN: "bad-token",
      CONTROL_PLANE_DB: auditDb(auditRuns),
    };
    const fetcher = vi.fn(async () => (
      env.TRACKER_TEAM_ALPHA_GITHUB_TOKEN === "bad-token"
        ? new Response("bad token", { status: 401 })
        : Response.json([])
    ));

    const firstResult = await pollGitHub(invocation(env, `tracker:\n  github:\n    repo: octocat/hello-world\n`), fetcher);

    expect(firstResult).toEqual({ teamId: "team-alpha", issuesSeen: 0, issuesPosted: 0 });
    expect(fetcher).toHaveBeenCalledOnce();
    expect(auditRuns).toHaveLength(1);
    expect(auditRuns[0]?.query).toContain("INSERT INTO audit_log");
    expect(auditRuns[0]?.values).toEqual(expect.arrayContaining([
      "team-alpha",
      "tracker-poller:github",
    ]));
    expect(String(auditRuns[0]?.values[3])).toMatch(/^tracker\/team-alpha\/github\/auth-failure\//u);
    expect(JSON.parse(String(auditRuns[0]?.values[5]))).toMatchObject({
      provider: "github",
      contentHash: "hash",
      secretTarget: "tracker/team-alpha/github",
      statusCode: 401,
    });

    const skippedResult = await pollGitHub(invocation(env, `tracker:\n  github:\n    repo: octocat/hello-world\n`), fetcher);

    expect(skippedResult).toEqual({ teamId: "team-alpha", issuesSeen: 0, issuesPosted: 0 });
    expect(fetcher).toHaveBeenCalledOnce();
    expect(auditRuns).toHaveLength(1);

    env.TRACKER_TEAM_ALPHA_GITHUB_TOKEN = "refreshed-token";
    const refreshedResult = await pollGitHub(invocation(env, `tracker:\n  github:\n    repo: octocat/hello-world\n`), fetcher);

    expect(refreshedResult).toEqual({ teamId: "team-alpha", issuesSeen: 0, issuesPosted: 0 });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("requires TeamCoordinator binding before dropping fetched issues", async () => {
    const env: PollerEnv = { TRACKER_TEAM_ALPHA_GITHUB_TOKEN: "github-secret" };
    const fetcher = vi.fn(async () => Response.json([githubIssue({ number: 42, title: "Fix parser panic" })]));

    await expect(pollGitHub(invocation(env, `tracker:\n  github:\n    repo: octocat/hello-world\n`), fetcher))
      .rejects.toThrow("TEAM_COORDINATOR binding required for GitHub poller");
  });
});

describe("normalizeGitHubIssue", () => {
  it("keeps sparse GitHub API fixtures compatible", () => {
    expect(normalizeGitHubIssue({ owner: "octocat", repo: "hello-world" }, { number: 7 })).toMatchObject({
      id: "7",
      identifier: "octocat/hello-world#7",
      labels: [],
      blocked_by: [],
      tracker_meta: { provider: "github", github_state: "" },
    });
  });
});

function invocation(env: PollerEnv, contentYaml: string): PollerInvocation {
  return {
    team: { teamId: "team-alpha", contentHash: "hash", contentYaml },
    adapter: "github",
    scheduledTime: 1710000000000,
    cron: "* * * * *",
    env,
  };
}

function githubIssue(input: { number: number; title: string; labels?: string[]; pullRequest?: boolean }): Record<string, unknown> {
  return {
    number: input.number,
    node_id: `I_kwDOAAABc84AbCd${input.number}`,
    title: input.title,
    body: "Body\nBlocked by: #10, #11\n<!-- model: gpt-5.5 -->",
    state: "open",
    html_url: `https://github.com/octocat/hello-world/issues/${input.number}`,
    created_at: "2026-05-09T01:00:00Z",
    updated_at: "2026-05-09T02:00:00Z",
    labels: (input.labels ?? []).map((name) => ({ name })),
    ...(input.pullRequest === true ? { pull_request: { url: "https://api.github.test/pulls/43" } } : {}),
  };
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

function auditDb(runs: Array<{ query: string; values: unknown[] }>): D1Database {
  return {
    prepare(query: string) {
      return {
        bind(...values: unknown[]) {
          return {
            first() {
              const targetId = values[1];
              const found = runs.find((run) => run.values[1] === "team-alpha" && run.values[3] === targetId);
              return Promise.resolve(found === undefined ? null : { id: found.values[0] });
            },
            run() {
              runs.push({ query, values });
              return Promise.resolve({ success: true });
            },
          };
        },
      };
    },
  } as unknown as D1Database;
}
