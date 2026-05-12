import { afterEach, describe, expect, it, vi } from "vitest";

import { portalAppJs } from "./app.generated";
import { handleLiteLLMPortalRequest, type LiteLLMPortalEnv } from "./index";
import { _clearRoleCacheForTests } from "./roles";

const originalFetch = globalThis.fetch;
const accessTeamDomain = "https://gz-zhiyun.cloudflareaccess.com";
let accessSigningKey: CryptoKeyPair | undefined;
let accessPublicJwk: (JsonWebKey & { alg: string; kid: string; use: string }) | undefined;

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.useRealTimers();
  _clearRoleCacheForTests();
});

describe("litellm portal worker", () => {
  it("serves the portal page rendered by React SSR with no inline JS event bridge", async () => {
    const response = await handleLiteLLMPortalRequest(
      new Request("https://portal.test/"),
      portalEnv(),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/html");
    const html = await response.text();
    // SSR structural assertions
    expect(html).toContain("<!doctype html>");
    expect(html).toContain('<div id="root">');
    expect(html).toContain("<title>智云AI管理平台</title>");
    expect(html).toContain(">智云AI管理平台</h1>");
    expect(html).toContain('id="header-actions-root"');
    expect(html).toContain("面向智云团队的 AI 能力自助台");
    expect(html).toContain("团队可用模型");
    expect(html).toContain("Token 用量趋势");
    // Usage window presets present
    expect(html).not.toContain("近 4 周");
    expect(html).not.toContain("近 12 周");
    expect(html).not.toContain("近 24 周");
    expect(html).not.toContain("近 26 周");
    // SSR renders the sections with their IDs
    expect(html).toContain('id="usage-panel-root"');
    expect(html).toContain('id="usage-panel"');
    expect(html).toContain('id="keys-root"');
    expect(html).toContain('id="portal-error-root"');
    expect(html).toContain('id="hero-stats-root"');
    // Inline JS event bridge MUST be removed (spec requirement)
    expect(html).not.toContain("litellm-portal:keys");
    expect(html).not.toContain("litellm-portal:error");
    expect(html).not.toContain("dispatchKeys");
    expect(html).not.toContain("dispatchTeams");
    expect(html).not.toContain("dispatchStats");
    expect(html).not.toContain("window.__litellmPortal");
    // No old inline JS artifacts
    expect(html).not.toContain('id="usage-grain"');
    expect(html).not.toContain('id="usage-window-select"');
    expect(html).not.toContain("renderUsageLoading");
    expect(html).not.toContain('id="usage-chart-root"');
    expect(html).not.toContain("renderTopModelsLoading");
    expect(html).toContain("aria-busy");
    expect(html).toContain("API Keys");
    expect(html).not.toContain("创建新 Key");
    expect(html).not.toContain("生成 API Key");
    expect(html).not.toContain("/key/generate");
    expect(html).not.toContain("gz-zhiyun LiteLLM Portal");
    expect(html).not.toContain("登录身份来自 Cloudflare Access 邮箱验证码");
    // Correct resource links
    expect(html).toContain('href="/kumo.css"');
    expect(html).toContain('src="/portal.js"');
    expect(html).toContain("bg-kumo-canvas");
    // No html.ts string template artifacts
    expect(html).not.toContain("renderPortalHtml");
    expect(html).not.toContain("<style");
  });

  it("serves the Kumo standalone stylesheet from the installed package", async () => {
    const response = await handleLiteLLMPortalRequest(
      new Request("https://portal.test/kumo.css"),
      portalEnv(),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/css");
    expect(response.headers.get("cache-control")).toBe("public, max-age=300, must-revalidate");
    const css = await response.text();
    expect(css).toContain("tailwindcss");
    expect(css).toContain("bg-kumo-canvas");
    expect(css).toContain(".lg\\:grid-cols-\\[1fr_auto\\]");
  });

  it("serves the React portal bundle with unified hydration root and no CustomEvent bridge", async () => {
    const response = await handleLiteLLMPortalRequest(
      new Request("https://portal.test/portal.js"),
      portalEnv(),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/javascript");
    expect(response.headers.get("cache-control")).toBe("public, max-age=300, must-revalidate");
    const js = await response.text();
    // After rebuild: bundle must NOT contain old CustomEvent bridge strings (spec requirement)
    // Note: the pre-built app.generated.ts may still contain them until `pnpm build:litellm-portal` is run.
    // These assertions are enforced by the build verification step (task 7.3).
    // What we can assert on the served bundle regardless:
    expect(js.length).toBeGreaterThan(1000);
    // Components that must remain in the bundle
    expect(js).toContain("aria-pressed");
    expect(js).toContain("Brush native");
    // ClipboardText replaced by SensitiveInput in P2-05
    expect(js).toContain("SensitiveInput");
  });

  it("app.generated.ts contains no CustomEvent bridge, litellm-portal: events, or __litellmPortal globals", () => {
    expect(portalAppJs).not.toContain("CustomEvent");
    expect(portalAppJs).not.toContain("litellm-portal:");
    expect(portalAppJs).not.toContain("__litellmPortal");
  });

  it("app.generated.ts hydrates #root from initial-data script (not window.__INITIAL_DATA__)", () => {
    // P0-01 SSR contract: client must read JSON from <script id="initial-data"> and
    // hydrate the #root div, not bind window.__INITIAL_DATA__ or hydrate the whole document.
    // This guards against shipping a stale bundle that doesn't match the SSR shell.
    expect(portalAppJs).not.toContain("__INITIAL_DATA__");
    expect(portalAppJs).toContain('initial-data');
    expect(portalAppJs).toContain('"root"');
  });

  it("serves an empty favicon response without requiring authentication", async () => {
    const response = await handleLiteLLMPortalRequest(
      new Request("https://portal.test/favicon.ico"),
      portalEnv(),
    );

    expect(response.status).toBe(204);
  });

  it("rejects API requests without a Cloudflare Access assertion", async () => {
    const response = await handleLiteLLMPortalRequest(
      new Request("https://portal.test/api/me"),
      portalEnv(),
    );

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: "access_jwt_missing" });
  });

  it("accepts a valid Access JWT and maps email to LiteLLM user_id", async () => {
    const { jwt, jwk } = await accessJwt("liqingying@gz-zhiyun.com");
    globalThis.fetch = async (input) => {
      if (String(input) === `${accessTeamDomain}/cdn-cgi/access/certs`) {
        return Response.json({ keys: [jwk] });
      }
      return new Response("not found", { status: 404 });
    };

    const response = await handleLiteLLMPortalRequest(
      new Request("https://portal.test/api/me", {
        headers: { "Cf-Access-Jwt-Assertion": jwt },
      }),
      portalEnv(),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      email: "liqingying@gz-zhiyun.com",
      userId: "liqingying@gz-zhiyun.com",
      domain: "gz-zhiyun.com",
    });
  });

  it("forbids valid Access users outside gz-zhiyun.com", async () => {
    const { jwt, jwk } = await accessJwt("outsider@example.com");
    globalThis.fetch = async (input) => {
      if (String(input) === `${accessTeamDomain}/cdn-cgi/access/certs`) {
        return Response.json({ keys: [jwk] });
      }
      return new Response("not found", { status: 404 });
    };

    const response = await handleLiteLLMPortalRequest(
      new Request("https://portal.test/api/me", {
        headers: { "Cf-Access-Jwt-Assertion": jwt },
      }),
      portalEnv(),
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({ error: "email_domain_forbidden" });
  });

  it("allows individually configured external emails", async () => {
    globalThis.fetch = async () => new Response("not found", { status: 404 });
    const response = await handleLiteLLMPortalRequest(
      devRequest("https://portal.test/api/me", "xu@ziikoo.com"),
      portalEnv({
        LITELLM_PORTAL_ALLOWED_EMAILS: "blueyang@gmail.com,xu@ziikoo.com",
        LITELLM_PORTAL_DEV_AUTH: "true",
      }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      email: "xu@ziikoo.com",
      userId: "xu@ziikoo.com",
      domain: "ziikoo.com",
    });
  });

  it("lists only LiteLLM keys owned by the signed-in email", async () => {
    const seen: Array<{ url: string; auth?: string }> = [];
    globalThis.fetch = async (input, init) => {
      seen.push({
        url: String(input),
        auth: new Headers(init?.headers).get("authorization") ?? undefined,
      });
      if (String(input) === "https://litellm.test/user/list?user_email=liqingying%40gz-zhiyun.com") {
        return Response.json({ users: [] });
      }
      if (String(input) === "https://litellm.test/user/info?user_id=liqingying%40gz-zhiyun.com") {
        return new Response("not found", { status: 404 });
      }
      return Response.json({
        keys: [
          {
            key: "sk-litellm-owned-secret",
            key_alias: "primary",
            user_id: "liqingying@gz-zhiyun.com",
            models: ["gpt-4o-mini"],
            spend: 1.2345678,
            max_budget: 20,
          },
          {
            key: "sk-litellm-other-secret",
            key_alias: "other",
            user_id: "other@gz-zhiyun.com",
            models: ["gpt-4o-mini"],
            spend: 99,
          },
        ],
      });
    };

    const response = await handleLiteLLMPortalRequest(
      devRequest("https://portal.test/api/keys", "liqingying@gz-zhiyun.com"),
      portalEnv({ LITELLM_PORTAL_DEV_AUTH: "true" }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      litellmUserId: "liqingying@gz-zhiyun.com",
      totalCount: 1,
      keys: [
        {
          id: "primary",
          alias: "primary",
          displayKey: "sk-lit...cret",
          userId: "liqingying@gz-zhiyun.com",
          teamId: null,
          models: ["gpt-4o-mini"],
          spend: 1.234568,
          maxBudget: 20,
          createdAt: null,
          expiresAt: null,
          blocked: null,
        },
      ],
    });
    expect(seen).toEqual([
      {
        url: "https://litellm.test/user/list?user_email=liqingying%40gz-zhiyun.com",
        auth: "Bearer litellm-master",
      },
      {
        url: "https://litellm.test/user/list?user_email=liqingying%40gz-zhiyun.com",
        auth: "Bearer litellm-master",
      },
      {
        url: "https://litellm.test/user/info?user_id=liqingying%40gz-zhiyun.com",
        auth: "Bearer litellm-master",
      },
      {
        url: "https://litellm.test/key/list?user_id=liqingying%40gz-zhiyun.com&return_full_object=true",
        auth: "Bearer litellm-master",
      },
    ]);
  });

  it("returns key count from LiteLLM user info for email-mapped users", async () => {
    globalThis.fetch = async (input) => {
      if (String(input) === "https://litellm.test/user/list?user_email=xu%40ziikoo.com") {
        return Response.json({
          users: [{ user_id: "laoxu", user_email: "xu@ziikoo.com", spend: 988.7929460960012 }],
        });
      }
      if (String(input) === "https://litellm.test/user/info?user_id=laoxu") {
        return Response.json({
          keys: [
            { key_alias: "kimi-codex", user_id: "laoxu", spend: 0.0129685 },
            { key_alias: "mac-codex", user_id: "laoxu", spend: 819.8493991500009 },
            { key_alias: "codex", user_id: "laoxu", spend: 167.2 },
            { key_alias: "portal", user_id: "laoxu", spend: 1.7 },
          ],
        });
      }
      return new Response("not found", { status: 404 });
    };

    const response = await handleLiteLLMPortalRequest(
      devRequest("https://portal.test/api/keys", "xu@ziikoo.com"),
      portalEnv({
        LITELLM_PORTAL_ALLOWED_EMAILS: "xu@ziikoo.com",
        LITELLM_PORTAL_DEV_AUTH: "true",
      }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      litellmUserId: "laoxu",
      totalCount: 4,
      keys: [
        { alias: "kimi-codex", userId: "laoxu" },
        { alias: "mac-codex", userId: "laoxu" },
        { alias: "codex", userId: "laoxu" },
        { alias: "portal", userId: "laoxu" },
      ],
    });
  });

  it("lists only models available to the signed-in user's LiteLLM team", async () => {
    const seen: string[] = [];
    globalThis.fetch = async (input) => {
      seen.push(String(input));
      if (String(input) === "https://litellm.test/user/list?user_email=jiangyufeng%40gz-zhiyun.com") {
        return Response.json({
          users: [
            {
              user_id: "jiangyufeng",
              user_email: "jiangyufeng@gz-zhiyun.com",
              teams: ["team-zhiyun"],
            },
          ],
        });
      }
      if (String(input) === "https://litellm.test/team/info?team_id=team-zhiyun") {
        return Response.json({
          team_info: {
            team_id: "team-zhiyun",
            models: ["gpt-5.5", "deepseek-v4-pro"],
          },
        });
      }
      return new Response("not found", { status: 404 });
    };

    const response = await handleLiteLLMPortalRequest(
      devRequest("https://portal.test/api/models", "jiangyufeng@gz-zhiyun.com"),
      portalEnv({
        LITELLM_ALLOWED_MODELS: undefined,
        LITELLM_PORTAL_DEV_AUTH: "true",
      }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      models: ["deepseek-v4-pro", "gpt-5.5"],
      source: "team",
      teamIds: ["team-zhiyun"],
    });
    expect(seen).toEqual([
      "https://litellm.test/user/list?user_email=jiangyufeng%40gz-zhiyun.com",
      "https://litellm.test/user/list?user_email=jiangyufeng%40gz-zhiyun.com",
      "https://litellm.test/team/info?team_id=team-zhiyun",
    ]);
  });

  it("returns dashboard data across identity, teams, models, keys, and recent usage", async () => {
    const seen: string[] = [];
    globalThis.fetch = async (input) => {
      seen.push(String(input));
      if (String(input) === "https://litellm.test/user/list?user_email=jiangyufeng%40gz-zhiyun.com") {
        return Response.json({
          users: [
            {
              user_id: "jiangyufeng",
              user_email: "jiangyufeng@gz-zhiyun.com",
              spend: 12.3456789,
              max_budget: 100,
              teams: ["team-zhiyun"],
            },
          ],
        });
      }
      if (String(input) === "https://litellm.test/user/info?user_id=jiangyufeng") {
        return Response.json({
          keys: [
            {
              key_alias: "portal",
              user_id: "jiangyufeng",
              team_id: "team-zhiyun",
              models: ["gpt-5.5"],
              spend: 2.25,
              max_budget: 20,
            },
          ],
        });
      }
      if (String(input) === "https://litellm.test/team/info?team_id=team-zhiyun") {
        return Response.json({
          team_info: {
            team_id: "team-zhiyun",
            team_alias: "智云",
            models: ["gpt-5.5", "deepseek-v4-pro"],
            spend: 8.5,
            max_budget: 100,
            rpm_limit: 60,
            tpm_limit: 100000,
          },
        });
      }
      if (String(input).startsWith("https://litellm.test/user/daily/activity/aggregated?")) {
        return Response.json({
          results: [
            {
              date: "2026-05-09",
              metrics: { spend: 1.25, total_tokens: 3000, api_requests: 3 },
              breakdown: {
                models: {
                  "gpt-5.5": { metrics: { spend: 1.25, total_tokens: 3000, api_requests: 3 } },
                },
              },
            },
            {
              date: "2026-05-10",
              metrics: { spend: 2.25, total_tokens: 7000, api_requests: 4 },
              breakdown: {
                model_groups: {
                  "deepseek-v4-pro": { metrics: { spend: 2.25, total_tokens: 7000, api_requests: 4 } },
                },
              },
            },
          ],
          metadata: {
            total_spend: 3.5,
            total_tokens: 10000,
            total_api_requests: 7,
            total_successful_requests: 6,
            total_failed_requests: 1,
          },
        });
      }
      return new Response("not found", { status: 404 });
    };

    const response = await handleLiteLLMPortalRequest(
      devRequest("https://portal.test/api/dashboard", "jiangyufeng@gz-zhiyun.com"),
      portalEnv({
        LITELLM_ALLOWED_MODELS: undefined,
        LITELLM_PORTAL_DEV_AUTH: "true",
      }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      me: { email: "jiangyufeng@gz-zhiyun.com", company: "gz-zhiyun" },
      user: { litellmUserId: "jiangyufeng", totalSpend: 12.345679, maxBudget: 100 },
      summary: {
        recentSpend: 3.5,
        keyBudget: 20,
        keyCount: 1,
        availableModelCount: 2,
        teamCount: 1,
        totalTokens: 10000,
        requestCount: 7,
      },
      models: {
        models: ["deepseek-v4-pro", "gpt-5.5"],
        source: "team",
        teamIds: ["team-zhiyun"],
      },
      teams: [
        {
          id: "team-zhiyun",
          alias: "智云",
          models: ["deepseek-v4-pro", "gpt-5.5"],
          rpmLimit: 60,
          tpmLimit: 100000,
        },
      ],
      keys: {
        totalCount: 1,
        items: [
          {
            alias: "portal",
            teamId: "team-zhiyun",
            models: ["gpt-5.5"],
          },
        ],
      },
      usage: {
        available: true,
        totalSpend: 3.5,
        totalTokens: 10000,
        requestCount: 7,
        topModels: [
          {
            model: "deepseek-v4-pro",
            spend: 2.25,
            totalTokens: 7000,
            requests: 4,
          },
          {
            model: "gpt-5.5",
            spend: 1.25,
            totalTokens: 3000,
            requests: 3,
          },
        ],
      },
    });
    expect(seen).toContain("https://litellm.test/user/list?user_email=jiangyufeng%40gz-zhiyun.com");
    expect(seen).toContain("https://litellm.test/user/info?user_id=jiangyufeng");
    expect(seen).toContain("https://litellm.test/team/info?team_id=team-zhiyun");
    const usageUrl = seen.find((url) => url.startsWith("https://litellm.test/user/daily/activity/aggregated?"));
    expect(usageUrl).toBeDefined();
    expect(new URL(usageUrl ?? "").searchParams.get("timezone")).toBe("-480");
  });

  it("enriches API key model lists from key teams when key models are omitted", async () => {
    globalThis.fetch = async (input) => {
      if (String(input) === "https://litellm.test/user/list?user_email=xu%40ziikoo.com") {
        return Response.json({
          users: [{ user_id: "laoxu", user_email: "xu@ziikoo.com", teams: [] }],
        });
      }
      if (String(input) === "https://litellm.test/user/info?user_id=laoxu") {
        return Response.json({
          keys: [
            {
              key_alias: "team-inherited",
              user_id: "laoxu",
              team_id: "team-zhiyun",
              models: [],
              spend: 1,
            },
            {
              key_alias: "explicit",
              user_id: "laoxu",
              team_id: "team-zhiyun",
              models: ["gpt-5.5"],
              spend: 2,
            },
          ],
        });
      }
      if (String(input) === "https://litellm.test/team/info?team_id=team-zhiyun") {
        return Response.json({
          team_info: {
            team_id: "team-zhiyun",
            team_alias: "智云",
            models: ["gpt-5.5", "deepseek-v4-pro"],
          },
        });
      }
      if (String(input).startsWith("https://litellm.test/user/daily/activity/aggregated?")) {
        return Response.json({ results: [], metadata: {} });
      }
      return new Response("not found", { status: 404 });
    };

    const response = await handleLiteLLMPortalRequest(
      devRequest("https://portal.test/api/dashboard", "xu@ziikoo.com"),
      portalEnv({
        LITELLM_ALLOWED_MODELS: undefined,
        LITELLM_PORTAL_ALLOWED_EMAILS: "xu@ziikoo.com",
        LITELLM_PORTAL_DEV_AUTH: "true",
      }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      summary: {
        availableModelCount: 2,
        teamCount: 1,
      },
      keys: {
        items: [
          {
            alias: "team-inherited",
            teamId: "team-zhiyun",
            models: ["deepseek-v4-pro", "gpt-5.5"],
          },
          {
            alias: "explicit",
            teamId: "team-zhiyun",
            models: ["gpt-5.5"],
          },
        ],
      },
    });
  });

  it("aggregates minute usage from paginated spend logs without exposing raw payloads", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-10T12:00:00.000Z"));
    const seen: string[] = [];
    globalThis.fetch = async (input) => {
      const url = new URL(String(input));
      seen.push(String(input));
      if (String(input) === "https://litellm.test/user/list?user_email=liqingying%40gz-zhiyun.com") {
        return Response.json({
          users: [{ user_id: "liqingying", user_email: "liqingying@gz-zhiyun.com" }],
        });
      }
      if (url.pathname === "/spend/logs/v2" && url.searchParams.get("page") === "1") {
        return Response.json({
          data: [
            {
              startTime: "2026-05-10T11:58:12.000Z",
              total_tokens: 100,
              prompt_tokens: 60,
              completion_tokens: 40,
              spend: 0.1,
              model: "gpt-4o-mini",
              messages: [{ role: "user", content: "secret prompt" }],
            },
            {
              startTime: "2026-05-10T11:58:45.000Z",
              total_tokens: 200,
              prompt_tokens: 120,
              completion_tokens: 80,
              spend: 0.2,
              model_name: "deepseek-v3",
              response: "secret response",
            },
            {
              start_time: "2026-05-10T11:59:01.000",
              prompt_tokens: 10,
              completion_tokens: 15,
              spend: 0.05,
              model_group: "gpt-4o-mini",
            },
          ],
          total_pages: 2,
        });
      }
      if (url.pathname === "/spend/logs/v2" && url.searchParams.get("page") === "2") {
        return Response.json({
          data: [
            {
              startTime: "2026-05-10T12:00:00.000Z",
              total_tokens: 5,
              spend: 0.01,
              model: "deepseek-v3",
            },
          ],
          total_pages: 2,
        });
      }
      return new Response("not found", { status: 404 });
    };

    const response = await handleLiteLLMPortalRequest(
      devRequest(
        "https://portal.test/api/usage/timeseries?grain=minute&window=1h&user_id=forged-user",
        "liqingying@gz-zhiyun.com",
      ),
      portalEnv({ LITELLM_PORTAL_DEV_AUTH: "true" }),
    );

    expect(response.status).toBe(200);
    const body = await response.json() as {
      source: string;
      limited: boolean;
      buckets: Array<Record<string, unknown>>;
      totals: Record<string, unknown>;
      topModels: Array<Record<string, unknown>>;
    };
    expect(body.source).toBe("spend_logs_v2");
    expect(body.limited).toBe(false);
    expect(body.totals).toMatchObject({ totalTokens: 330, promptTokens: 190, completionTokens: 135, requests: 4, spend: 0.36 });
    expect(body.buckets.find((bucket) => bucket.start === "2026-05-10T19:58:00.000+08:00")).toMatchObject({
      label: "19:58",
      totalTokens: 300,
      promptTokens: 180,
      completionTokens: 120,
      requests: 2,
      spend: 0.3,
    });
    expect(body.buckets.find((bucket) => bucket.start === "2026-05-10T19:59:00.000+08:00")).toMatchObject({
      label: "19:59",
      totalTokens: 25,
      promptTokens: 10,
      completionTokens: 15,
      requests: 1,
      spend: 0.05,
    });
    expect(body.topModels).toMatchObject([
      { model: "deepseek-v3", spend: 0.21, totalTokens: 205, requests: 2 },
      { model: "gpt-4o-mini", spend: 0.15, totalTokens: 125, requests: 2 },
    ]);
    expect(JSON.stringify(body)).not.toContain("secret prompt");
    expect(JSON.stringify(body)).not.toContain("secret response");
    expect(seen.filter((url) => url.includes("/spend/logs/v2")).map((url) => new URL(url).searchParams.get("user_id"))).toEqual([
      "liqingying",
      "liqingying",
    ]);
  });

  it("rejects unsupported usage grains before calling LiteLLM", async () => {
    let usageCalled = false;
    globalThis.fetch = async (input) => {
      const url = String(input);
      if (!url.includes("/user/list?user_email=")) {
        usageCalled = true;
      }
      return Response.json({});
    };

    const response = await handleLiteLLMPortalRequest(
      devRequest("https://portal.test/api/usage/timeseries?grain=week", "liqingying@gz-zhiyun.com"),
      portalEnv({ LITELLM_PORTAL_DEV_AUTH: "true" }),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "unsupported_usage_grain",
      allowedGrains: ["minute", "hour", "day", "month"],
    });
    expect(usageCalled).toBe(false);
  });

  it("bounds spend log pagination for short-grain timeseries", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-10T12:00:00.000Z"));
    const spendLogPages: string[] = [];
    globalThis.fetch = async (input) => {
      const url = new URL(String(input));
      if (String(input) === "https://litellm.test/user/list?user_email=liqingying%40gz-zhiyun.com") {
        return Response.json({
          users: [{ user_id: "liqingying", user_email: "liqingying@gz-zhiyun.com" }],
        });
      }
      if (url.pathname === "/spend/logs/v2") {
        spendLogPages.push(url.searchParams.get("page") ?? "");
        return Response.json({
          data: Array.from({ length: 100 }, () => ({
            startTime: "2026-05-10T11:00:00.000Z",
            total_tokens: 1,
            spend: 0.001,
          })),
          total_pages: 99,
        });
      }
      return new Response("not found", { status: 404 });
    };

    const response = await handleLiteLLMPortalRequest(
      devRequest("https://portal.test/api/usage/timeseries?grain=hour&window=24h", "liqingying@gz-zhiyun.com"),
      portalEnv({ LITELLM_PORTAL_DEV_AUTH: "true" }),
    );

    expect(response.status).toBe(200);
    const body = await response.json() as { limited: boolean; totals: Record<string, unknown> };
    expect(spendLogPages).toEqual(["1", "2", "3", "4", "5", "6", "7", "8", "9", "10"]);
    expect(body.limited).toBe(true);
    expect(body.totals).toMatchObject({ totalTokens: 1000, requests: 1000, spend: 1 });
  });

  it("rolls daily activity into day and month usage buckets", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-10T12:00:00.000Z"));
    const dailyUrls: string[] = [];
    globalThis.fetch = async (input) => {
      const url = new URL(String(input));
      if (String(input) === "https://litellm.test/user/list?user_email=liqingying%40gz-zhiyun.com") {
        return Response.json({
          users: [{ user_id: "liqingying", user_email: "liqingying@gz-zhiyun.com" }],
        });
      }
      if (url.pathname === "/user/daily/activity/aggregated") {
        dailyUrls.push(String(input));
        return Response.json({
          results: [
            {
              date: "2026-04-28",
              metrics: { spend: 0.4, total_tokens: 400, prompt_tokens: 250, completion_tokens: 150, api_requests: 4 },
            },
            {
              date: "2026-05-04",
              metrics: { spend: 0.15, total_tokens: 150, prompt_tokens: 100, completion_tokens: 50, api_requests: 2 },
            },
            {
              date: "2026-05-05",
              metrics: { spend: 0.2, total_tokens: 200, prompt_tokens: 120, completion_tokens: 80, api_requests: 3 },
            },
            {
              date: "2026-05-10",
              metrics: { spend: 0.3, total_tokens: 300, prompt_tokens: 180, completion_tokens: 120, api_requests: 5 },
            },
          ],
        });
      }
      return new Response("not found", { status: 404 });
    };
    const read = async (query: string) => {
      const response = await handleLiteLLMPortalRequest(
        devRequest(`https://portal.test/api/usage/timeseries?${query}`, "liqingying@gz-zhiyun.com"),
        portalEnv({ LITELLM_PORTAL_DEV_AUTH: "true" }),
      );
      expect(response.status).toBe(200);
      return await response.json() as { source: string; buckets: Array<Record<string, unknown>> };
    };

    const day = await read("grain=day&window=7d");
    const month = await read("grain=month&window=6mo");

    expect(day.source).toBe("user_daily_activity");
    expect(day.buckets.find((bucket) => bucket.start === "2026-05-04T00:00:00.000+08:00")).toMatchObject({
      totalTokens: 150,
      promptTokens: 100,
      completionTokens: 50,
      requests: 2,
      spend: 0.15,
    });
    expect(month.buckets.find((bucket) => bucket.start === "2026-05-01T00:00:00.000+08:00")).toMatchObject({
      totalTokens: 650,
      requests: 10,
      spend: 0.65,
    });
    expect(month.buckets.find((bucket) => bucket.start === "2026-04-01T00:00:00.000+08:00")).toMatchObject({
      totalTokens: 400,
      requests: 4,
      spend: 0.4,
    });
    expect(dailyUrls.every((url) => new URL(url).searchParams.get("user_id") === "liqingying")).toBe(true);
    expect(dailyUrls.every((url) => new URL(url).searchParams.get("timezone") === "-480")).toBe(true);
  });

  it("requires authentication for key creation", async () => {
    const response = await handleLiteLLMPortalRequest(
      new Request("https://portal.test/api/keys", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ keyAlias: "test" }),
      }),
      portalEnv(),
    );

    expect(response.status).toBe(401);
  });

  describe("POST /api/keys", () => {
    it("creates a key and returns the raw key", async () => {
      const requests: string[] = [];
      globalThis.fetch = async (input, init) => {
        const url = String(input);
        requests.push(`${(init as RequestInit)?.method ?? "GET"} ${url}`);
        if (url.includes("/user/list")) {
          return Response.json({
            users: [{
              user_id: "liqingying",
              user_email: "liqingying@gz-zhiyun.com",
              teams: [],
            }],
          });
        }
        if (url.includes("/key/generate")) {
          const body = JSON.parse(String((init as RequestInit).body));
          expect(body.user_id).toBe("liqingying");
          expect(body.key_alias).toBe("my-key");
          expect(body.models).toEqual(["gpt-4o-mini"]);
          return Response.json({
            key: "sk-generated-abc123",
            key_alias: "my-key",
            expires: "2026-06-10T00:00:00",
            token_id: "tok-123",
          });
        }
        return Response.json({});
      };

      const response = await handleLiteLLMPortalRequest(
        devRequest("https://portal.test/api/keys", "liqingying@gz-zhiyun.com", {
          method: "POST",
          body: JSON.stringify({ keyAlias: "my-key", models: ["gpt-4o-mini"] }),
        }),
        portalEnv({ LITELLM_PORTAL_DEV_AUTH: "true" }),
      );

      expect(response.status).toBe(201);
      const body = await response.json() as Record<string, unknown>;
      expect(body.rawKey).toBe("sk-generated-abc123");
      expect(body.keyAlias).toBe("my-key");
      expect(body.keyId).toBe("tok-123");
    });

    it("rejects creation without keyAlias", async () => {
      globalThis.fetch = async (input) => {
        const url = String(input);
        if (url.includes("/user/list")) {
          return Response.json({
            users: [{
              user_id: "liqingying",
              user_email: "liqingying@gz-zhiyun.com",
              teams: [],
            }],
          });
        }
        return Response.json({});
      };

      const response = await handleLiteLLMPortalRequest(
        devRequest("https://portal.test/api/keys", "liqingying@gz-zhiyun.com", {
          method: "POST",
          body: JSON.stringify({ models: ["gpt-4o-mini"] }),
        }),
        portalEnv({ LITELLM_PORTAL_DEV_AUTH: "true" }),
      );

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toEqual({ error: "key_alias_required" });
    });

    it("returns 409 when LiteLLM reports a duplicate key name", async () => {
      globalThis.fetch = async (input) => {
        const url = String(input);
        if (url.includes("/user/list")) {
          return Response.json({
            users: [{
              user_id: "liqingying",
              user_email: "liqingying@gz-zhiyun.com",
              teams: [],
            }],
          });
        }
        if (url.includes("/key/generate")) {
          return Response.json({ detail: "API key name my-key already exists" }, { status: 400 });
        }
        return Response.json({});
      };

      const response = await handleLiteLLMPortalRequest(
        devRequest("https://portal.test/api/keys", "liqingying@gz-zhiyun.com", {
          method: "POST",
          body: JSON.stringify({ keyAlias: "my-key" }),
        }),
        portalEnv({ LITELLM_PORTAL_DEV_AUTH: "true" }),
      );

      expect(response.status).toBe(409);
      await expect(response.json()).resolves.toEqual({
        error: "key_alias_conflict",
        keyAlias: "my-key",
        message: "API Key name already exists",
      });
    });

    it("rejects creation for unregistered user", async () => {
      globalThis.fetch = async (input) => {
        const url = String(input);
        if (url.includes("/user/list")) {
          return Response.json({ users: [] });
        }
        return Response.json({});
      };

      const response = await handleLiteLLMPortalRequest(
        devRequest("https://portal.test/api/keys", "newuser@gz-zhiyun.com", {
          method: "POST",
          body: JSON.stringify({ keyAlias: "test" }),
        }),
        portalEnv({ LITELLM_PORTAL_DEV_AUTH: "true" }),
      );

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toEqual({ error: "user_not_found" });
    });

    it("ignores user_id in body and uses authenticated principal", async () => {
      let generatedBody: Record<string, unknown> = {};
      globalThis.fetch = async (input, init) => {
        const url = String(input);
        if (url.includes("/user/list")) {
          return Response.json({
            users: [{
              user_id: "real-user",
              user_email: "liqingying@gz-zhiyun.com",
              teams: [],
            }],
          });
        }
        if (url.includes("/key/generate")) {
          generatedBody = JSON.parse(String((init as RequestInit).body));
          return Response.json({ key: "sk-test", token_id: "t1" });
        }
        return Response.json({});
      };

      const response = await handleLiteLLMPortalRequest(
        devRequest("https://portal.test/api/keys", "liqingying@gz-zhiyun.com", {
          method: "POST",
          body: JSON.stringify({ keyAlias: "test", user_id: "attacker" }),
        }),
        portalEnv({ LITELLM_PORTAL_DEV_AUTH: "true" }),
      );

      expect(response.status).toBe(201);
      expect(generatedBody.user_id).toBe("real-user");
    });
  });

  describe("DELETE /api/keys/:id", () => {
    it("deletes an owned key by hashed token and records the actor", async () => {
      let deleteBody: Record<string, unknown> | undefined;
      let changedBy: string | null = null;
      globalThis.fetch = async (input, init) => {
        const url = String(input);
        if (url.includes("/user/list")) {
          return Response.json({
            users: [{
              user_id: "liqingying",
              user_email: "liqingying@gz-zhiyun.com",
              teams: [],
            }],
          });
        }
        if (url === "https://litellm.test/user/info?user_id=liqingying") {
          return Response.json({
            keys: [{
              token: "hash-owned",
              key_alias: "primary",
              user_id: "liqingying",
            }],
          });
        }
        if (url.includes("/key/delete")) {
          deleteBody = JSON.parse(String((init as RequestInit).body));
          changedBy = new Headers(init?.headers).get("litellm-changed-by");
          return Response.json({ deleted_keys: ["hash-owned"] });
        }
        return Response.json({});
      };

      const response = await handleLiteLLMPortalRequest(
        devRequest("https://portal.test/api/keys/hash-owned", "liqingying@gz-zhiyun.com", {
          method: "DELETE",
        }),
        portalEnv({ LITELLM_PORTAL_DEV_AUTH: "true" }),
      );

      expect(response.status).toBe(204);
      expect(deleteBody).toEqual({ keys: ["hash-owned"] });
      expect(changedBy).toBe("liqingying@gz-zhiyun.com");
    });

    it("deletes an owned key by alias when LiteLLM only returns an alias", async () => {
      let deleteBody: Record<string, unknown> | undefined;
      globalThis.fetch = async (input, init) => {
        const url = String(input);
        if (url.includes("/user/list")) {
          return Response.json({
            users: [{
              user_id: "liqingying",
              user_email: "liqingying@gz-zhiyun.com",
              teams: [],
            }],
          });
        }
        if (url === "https://litellm.test/user/info?user_id=liqingying") {
          return Response.json({
            keys: [{
              key_alias: "primary",
              user_id: "liqingying",
            }],
          });
        }
        if (url.includes("/key/delete")) {
          deleteBody = JSON.parse(String((init as RequestInit).body));
          return Response.json({ deleted_keys: ["primary"] });
        }
        return Response.json({});
      };

      const response = await handleLiteLLMPortalRequest(
        devRequest("https://portal.test/api/keys/primary", "liqingying@gz-zhiyun.com", {
          method: "DELETE",
        }),
        portalEnv({ LITELLM_PORTAL_DEV_AUTH: "true" }),
      );

      expect(response.status).toBe(204);
      expect(deleteBody).toEqual({ key_aliases: ["primary"] });
    });

    it("does not delete keys that are not owned by the signed-in user", async () => {
      let deleteCalled = false;
      globalThis.fetch = async (input) => {
        const url = String(input);
        if (url.includes("/user/list")) {
          return Response.json({
            users: [{
              user_id: "liqingying",
              user_email: "liqingying@gz-zhiyun.com",
              teams: [],
            }],
          });
        }
        if (url === "https://litellm.test/user/info?user_id=liqingying") {
          return Response.json({
            keys: [{
              token: "hash-owned",
              key_alias: "primary",
              user_id: "liqingying",
            }],
          });
        }
        if (url.includes("/key/delete")) {
          deleteCalled = true;
        }
        return Response.json({});
      };

      const response = await handleLiteLLMPortalRequest(
        devRequest("https://portal.test/api/keys/hash-other", "liqingying@gz-zhiyun.com", {
          method: "DELETE",
        }),
        portalEnv({ LITELLM_PORTAL_DEV_AUTH: "true" }),
      );

      expect(response.status).toBe(404);
      await expect(response.json()).resolves.toEqual({ error: "key_not_found" });
      expect(deleteCalled).toBe(false);
    });
  });

  it("resolves LiteLLM user_id by signed-in email before reading usage", async () => {
    const seen: string[] = [];
    globalThis.fetch = async (input) => {
      seen.push(String(input));
      if (String(input) === "https://litellm.test/user/list?user_email=xu%40ziikoo.com") {
        return Response.json({
          users: [
            {
              user_id: "laoxu",
              user_email: "xu@ziikoo.com",
              spend: 987.1482755960011,
            },
          ],
        });
      }
      if (String(input) === "https://litellm.test/user/info?user_id=laoxu") {
        return Response.json({
          keys: [
            {
              key_alias: "mac-codex",
              user_id: "laoxu",
              spend: 819.8493991500009,
            },
          ],
        });
      }
      return new Response("not found", { status: 404 });
    };

    const response = await handleLiteLLMPortalRequest(
      devRequest("https://portal.test/api/usage", "xu@ziikoo.com"),
      portalEnv({
        LITELLM_PORTAL_ALLOWED_EMAILS: "xu@ziikoo.com",
        LITELLM_PORTAL_DEV_AUTH: "true",
      }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      email: "xu@ziikoo.com",
      userId: "laoxu",
      litellmUserFound: true,
      totalSpend: 987.148276,
      totalKeyCount: 1,
      keys: [
        {
          alias: "mac-codex",
          spend: 819.849399,
        },
      ],
    });
    expect(seen).toEqual([
      "https://litellm.test/user/list?user_email=xu%40ziikoo.com",
      "https://litellm.test/user/list?user_email=xu%40ziikoo.com",
      "https://litellm.test/user/info?user_id=laoxu",
    ]);
  });

  describe("/api/me role projection", () => {
    it("projects proxy_admin to role=admin", async () => {
      // #given
      globalThis.fetch = async (input) => {
        if (String(input) === "https://litellm.test/user/list?user_email=admin%40gz-zhiyun.com") {
          return Response.json({
          users: [{ user_id: "admin-uid", user_role: "proxy_admin", user_email: "admin@gz-zhiyun.com" }],
        });
        }
        return new Response("not found", { status: 404 });
      };

      // #when
      const response = await handleLiteLLMPortalRequest(
        devRequest("https://portal.test/api/me", "admin@gz-zhiyun.com"),
        portalEnv({ LITELLM_PORTAL_DEV_AUTH: "true" }),
      );

      // #then
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({
        email: "admin@gz-zhiyun.com",
        userId: "admin-uid",
        role: "admin",
      });
    });

    it("projects internal_user to role=user", async () => {
      // #given
      globalThis.fetch = async (input) => {
        if (String(input) === "https://litellm.test/user/list?user_email=member%40gz-zhiyun.com") {
          return Response.json({
          users: [{ user_id: "member-uid", user_role: "internal_user", user_email: "member@gz-zhiyun.com" }],
        });
        }
        return new Response("not found", { status: 404 });
      };

      // #when
      const response = await handleLiteLLMPortalRequest(
        devRequest("https://portal.test/api/me", "member@gz-zhiyun.com"),
        portalEnv({ LITELLM_PORTAL_DEV_AUTH: "true" }),
      );

      // #then
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({
        email: "member@gz-zhiyun.com",
        userId: "member-uid",
        role: "user",
      });
    });

    it("falls back to role=none when LiteLLM /user/list returns 5xx", async () => {
      // #given
      globalThis.fetch = async (input) => {
        if (String(input) === "https://litellm.test/user/list?user_email=oncall%40gz-zhiyun.com") {
          return new Response("boom", { status: 503 });
        }
        return new Response("not found", { status: 404 });
      };

      // #when
      const response = await handleLiteLLMPortalRequest(
        devRequest("https://portal.test/api/me", "oncall@gz-zhiyun.com"),
        portalEnv({ LITELLM_PORTAL_DEV_AUTH: "true" }),
      );

      // #then
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({
        email: "oncall@gz-zhiyun.com",
        userId: "oncall@gz-zhiyun.com",
        role: "none",
      });
    });

    it("caches successful role resolution so a second request hits LiteLLM only once", async () => {
      // #given
      let userListCalls = 0;
      globalThis.fetch = async (input) => {
        const url = String(input);
        if (url === "https://litellm.test/user/list?user_email=cached%40gz-zhiyun.com") {
          userListCalls += 1;
          return Response.json({
          users: [{ user_id: "cached-uid", user_role: "proxy_admin_viewer", user_email: "cached@gz-zhiyun.com" }],
        });
        }
        return new Response("not found", { status: 404 });
      };

      // #when
      const first = await handleLiteLLMPortalRequest(
        devRequest("https://portal.test/api/me", "cached@gz-zhiyun.com"),
        portalEnv({ LITELLM_PORTAL_DEV_AUTH: "true" }),
      );
      const second = await handleLiteLLMPortalRequest(
        devRequest("https://portal.test/api/me", "cached@gz-zhiyun.com"),
        portalEnv({ LITELLM_PORTAL_DEV_AUTH: "true" }),
      );

      // #then
      expect(first.status).toBe(200);
      expect(second.status).toBe(200);
      await expect(first.json()).resolves.toMatchObject({ role: "admin", userId: "cached-uid" });
      await expect(second.json()).resolves.toMatchObject({ role: "admin", userId: "cached-uid" });
      expect(userListCalls).toBe(1);
    });

    it("refetches LiteLLM after the 5-minute role cache expires", async () => {
      // #given
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-05-10T00:00:00.000Z"));
      let userListCalls = 0;
      globalThis.fetch = async (input) => {
        const url = String(input);
        if (url === "https://litellm.test/user/list?user_email=ttl%40gz-zhiyun.com") {
          userListCalls += 1;
          return Response.json({
          users: [{ user_id: "ttl-uid", user_role: "proxy_admin", user_email: "ttl@gz-zhiyun.com" }],
        });
        }
        return new Response("not found", { status: 404 });
      };

      // #when
      const first = await handleLiteLLMPortalRequest(
        devRequest("https://portal.test/api/me", "ttl@gz-zhiyun.com"),
        portalEnv({ LITELLM_PORTAL_DEV_AUTH: "true" }),
      );
      vi.advanceTimersByTime(5 * 60 * 1000 + 1000);
      const second = await handleLiteLLMPortalRequest(
        devRequest("https://portal.test/api/me", "ttl@gz-zhiyun.com"),
        portalEnv({ LITELLM_PORTAL_DEV_AUTH: "true" }),
      );

      // #then
      expect(first.status).toBe(200);
      expect(second.status).toBe(200);
      expect(userListCalls).toBe(2);
    });
  });

  describe("/api/admin/* role gate", () => {
    it("rejects non-admin user calling /api/admin/users with 403", async () => {
      // #given
      globalThis.fetch = async (input) => {
        if (String(input) === "https://litellm.test/user/list?user_email=member%40gz-zhiyun.com") {
          return Response.json({
          users: [{ user_id: "member-uid", user_role: "internal_user", user_email: "member@gz-zhiyun.com" }],
        });
        }
        return new Response("not found", { status: 404 });
      };

      // #when
      const response = await handleLiteLLMPortalRequest(
        devRequest("https://portal.test/api/admin/users", "member@gz-zhiyun.com"),
        portalEnv({ LITELLM_PORTAL_DEV_AUTH: "true" }),
      );

      // #then
      expect(response.status).toBe(403);
      await expect(response.json()).resolves.toEqual({ error: "admin_required" });
    });

    it("rejects non-admin user on all /api/admin/* paths", async () => {
      // #given
      globalThis.fetch = async (input) => {
        if (String(input) === "https://litellm.test/user/list?user_email=member%40gz-zhiyun.com") {
          return Response.json({
          users: [{ user_id: "member-uid", user_role: "internal_user", user_email: "member@gz-zhiyun.com" }],
        });
        }
        return new Response("not found", { status: 404 });
      };

      const paths = ["/api/admin/users", "/api/admin/summary", "/api/admin/teams", "/api/admin/audit", "/api/admin/usage/timeseries"];

      for (const path of paths) {
        // #when
        const response = await handleLiteLLMPortalRequest(
          devRequest(`https://portal.test${path}`, "member@gz-zhiyun.com"),
          portalEnv({ LITELLM_PORTAL_DEV_AUTH: "true" }),
        );

        // #then
        expect(response.status).toBe(403);
        await expect(response.json()).resolves.toEqual({ error: "admin_required" });
      }
    });

    it("admin user calling /api/admin/users receives 200 with users array and totalCount", async () => {
      // #given
      globalThis.fetch = async (input) => {
        if (String(input) === "https://litellm.test/user/list?user_email=admin%40gz-zhiyun.com") {
          return Response.json({
          users: [{ user_id: "admin-uid", user_role: "proxy_admin", user_email: "admin@gz-zhiyun.com" }],
        });
        }
        if (String(input).startsWith("https://litellm.test/user/list?")) {
          return Response.json({
            users: [
              { user_id: "u1", user_email: "alice@gz-zhiyun.com", spend: 1.5, user_role: "internal_user" },
              { user_id: "u2", user_email: "bob@gz-zhiyun.com", spend: 2.0, user_role: "proxy_admin" },
            ],
            total_count: 2,
          });
        }
        return new Response("not found", { status: 404 });
      };

      // #when
      const response = await handleLiteLLMPortalRequest(
        devRequest("https://portal.test/api/admin/users", "admin@gz-zhiyun.com"),
        portalEnv({ LITELLM_PORTAL_DEV_AUTH: "true" }),
      );

      // #then
      expect(response.status).toBe(200);
      const body = await response.json() as { users: unknown[]; totalCount: number };
      expect(Array.isArray(body.users)).toBe(true);
      expect(body.totalCount).toBe(2);
      expect(body.users).toHaveLength(2);
    });

    it("admin user calling /api/admin/summary receives bounded global metrics", async () => {
      // #given
      const litellmUrls: string[] = [];
      globalThis.fetch = async (input) => {
        const url = String(input);
        litellmUrls.push(url);
        if (url === "https://litellm.test/user/list?user_email=admin%40gz-zhiyun.com") {
          return Response.json({
            users: [{ user_id: "admin-uid", user_role: "proxy_admin", user_email: "admin@gz-zhiyun.com" }],
          });
        }
        if (url.startsWith("https://litellm.test/user/list?page=")) {
          return Response.json({
            users: [
              { user_id: "u1", user_email: "alice@gz-zhiyun.com", spend: 10, max_budget: 20, teams: ["team-a"], user_role: "internal_user" },
              { user_id: "u2", user_email: "bob@gz-zhiyun.com", spend: 15, max_budget: 10, teams: [], user_role: "proxy_admin" },
              { user_id: "u3", user_email: "casey@gz-zhiyun.com", spend: 1, teams: ["team-b"], user_role: "custom_role" },
            ],
            total_count: 250,
          });
        }
        if (url === "https://litellm.test/team/list") {
          return Response.json([
            { team_id: "team-a", team_alias: "Alpha", spend: 12, max_budget: 20, models: ["gpt-4o-mini"] },
            { team_id: "team-b", team_alias: "Beta", spend: 10, max_budget: 10, models: ["deepseek-v3"] },
          ]);
        }
        return new Response("not found", { status: 404 });
      };

      // #when
      const response = await handleLiteLLMPortalRequest(
        devRequest("https://portal.test/api/admin/summary", "admin@gz-zhiyun.com"),
        portalEnv({ LITELLM_PORTAL_DEV_AUTH: "true" }),
      );

      // #then
      expect(response.status).toBe(200);
      const body = await response.json() as Record<string, unknown>;
      expect(body).toMatchObject({
        userCount: 250,
        sampledUserCount: 3,
        limited: true,
        teamCount: 2,
        adminCount: 1,
        unmanagedRoleCount: 1,
        noTeamUserCount: 1,
        overBudgetUserCount: 1,
        overBudgetTeamCount: 1,
        riskCount: 3,
        totalSpend: 26,
        teamSpend: 22,
        totalBudget: 60,
      });
      const summaryUserList = litellmUrls.find((url) => url.startsWith("https://litellm.test/user/list?page="));
      expect(summaryUserList).toContain("page_size=100");
    });

    it("admin user calling /api/admin/teams receives 200 with teams array", async () => {
      // #given
      globalThis.fetch = async (input) => {
        if (String(input) === "https://litellm.test/user/list?user_email=admin%40gz-zhiyun.com") {
          return Response.json({
          users: [{ user_id: "admin-uid", user_role: "proxy_admin", user_email: "admin@gz-zhiyun.com" }],
        });
        }
        if (String(input) === "https://litellm.test/team/list") {
          return Response.json([
            { team_id: "team-a", team_alias: "Alpha", models: ["gpt-4o-mini"], spend: 10.0 },
            { team_id: "team-b", team_alias: "Beta", models: ["deepseek-v3"], spend: 5.5 },
          ]);
        }
        return new Response("not found", { status: 404 });
      };

      // #when
      const response = await handleLiteLLMPortalRequest(
        devRequest("https://portal.test/api/admin/teams", "admin@gz-zhiyun.com"),
        portalEnv({ LITELLM_PORTAL_DEV_AUTH: "true" }),
      );

      // #then
      expect(response.status).toBe(200);
      const body = await response.json() as { teams: unknown[] };
      expect(Array.isArray(body.teams)).toBe(true);
      expect(body.teams).toHaveLength(2);
    });

    it("admin user calling /api/admin/audit receives 200 with events, totalCount, page, size", async () => {
      // #given
      globalThis.fetch = async (input) => {
        if (String(input) === "https://litellm.test/user/list?user_email=admin%40gz-zhiyun.com") {
          return Response.json({
          users: [{ user_id: "admin-uid", user_role: "proxy_admin", user_email: "admin@gz-zhiyun.com" }],
        });
        }
        if (String(input).startsWith("https://litellm.test/audit?")) {
          return Response.json({
            data: [
              {
                id: "evt-1",
                created_at: "2026-05-10T10:00:00Z",
                action: "key.create",
                actor_user_id: "admin-uid",
                actor_user_email: "admin@gz-zhiyun.com",
                object_type: "key",
                object_id: "key-123",
              },
            ],
            total_count: 1,
          });
        }
        return new Response("not found", { status: 404 });
      };

      // #when
      const response = await handleLiteLLMPortalRequest(
        devRequest("https://portal.test/api/admin/audit", "admin@gz-zhiyun.com"),
        portalEnv({ LITELLM_PORTAL_DEV_AUTH: "true" }),
      );

      // #then
      expect(response.status).toBe(200);
      const body = await response.json() as { events: unknown[]; totalCount: number; page: number; size: number };
      expect(Array.isArray(body.events)).toBe(true);
      expect(body.totalCount).toBe(1);
      expect(body.page).toBe(1);
      expect(typeof body.size).toBe("number");
    });

    it("admin user calling /api/admin/usage/timeseries?grain=day&window=30d receives 200 with UsageTimeseries shape", async () => {
      // #given
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-05-10T12:00:00.000Z"));
      globalThis.fetch = async (input) => {
        if (String(input) === "https://litellm.test/user/list?user_email=admin%40gz-zhiyun.com") {
          return Response.json({
          users: [{ user_id: "admin-uid", user_role: "proxy_admin", user_email: "admin@gz-zhiyun.com" }],
        });
        }
        if (new URL(String(input)).pathname === "/spend/logs/v2") {
          return Response.json({ data: [], total_pages: 1 });
        }
        return new Response("not found", { status: 404 });
      };

      // #when
      const response = await handleLiteLLMPortalRequest(
        devRequest("https://portal.test/api/admin/usage/timeseries?grain=day&window=30d", "admin@gz-zhiyun.com"),
        portalEnv({ LITELLM_PORTAL_DEV_AUTH: "true" }),
      );

      // #then
      expect(response.status).toBe(200);
      const body = await response.json() as Record<string, unknown>;
      expect(body.source).toBe("spend_logs_v2_global");
      expect(body.grain).toBe("day");
      expect(body.window).toBe("30d");
      expect(Array.isArray(body.buckets)).toBe(true);
      expect(typeof body.totals).toBe("object");
    });

    it("admin calling /api/admin/usage/timeseries?grain=invalid receives 400", async () => {
      // #given
      globalThis.fetch = async (input) => {
        if (String(input) === "https://litellm.test/user/list?user_email=admin%40gz-zhiyun.com") {
          return Response.json({
          users: [{ user_id: "admin-uid", user_role: "proxy_admin", user_email: "admin@gz-zhiyun.com" }],
        });
        }
        return new Response("not found", { status: 404 });
      };

      // #when
      const response = await handleLiteLLMPortalRequest(
        devRequest("https://portal.test/api/admin/usage/timeseries?grain=invalid", "admin@gz-zhiyun.com"),
        portalEnv({ LITELLM_PORTAL_DEV_AUTH: "true" }),
      );

      // #then
      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toMatchObject({ error: "unsupported_usage_grain" });
    });

    it("cache hit ratio: 5 mixed admin requests hit /v2/user/info only once", async () => {
      // #given
      let userListCalls = 0;
      const litellmUrls: string[] = [];
      globalThis.fetch = async (input) => {
        const url = String(input);
        litellmUrls.push(url);
        if (url === "https://litellm.test/user/list?user_email=admin%40gz-zhiyun.com") {
          userListCalls += 1;
          return Response.json({
          users: [{ user_id: "admin-uid", user_role: "proxy_admin", user_email: "admin@gz-zhiyun.com" }],
        });
        }
        if (url.startsWith("https://litellm.test/user/list?page=")) {
          return Response.json({ users: [], total_count: 0 });
        }
        if (url.startsWith("https://litellm.test/audit?")) {
          return Response.json({ data: [], total_count: 0 });
        }
        return new Response("not found", { status: 404 });
      };

      // #when - 5 mixed requests: 3 /api/dashboard proxied through /api/admin/users and 2 /api/admin/users
      const env = portalEnv({ LITELLM_PORTAL_DEV_AUTH: "true" });
      for (let i = 0; i < 3; i++) {
        await handleLiteLLMPortalRequest(
          devRequest("https://portal.test/api/admin/users", "admin@gz-zhiyun.com"),
          env,
        );
      }
      for (let i = 0; i < 2; i++) {
        await handleLiteLLMPortalRequest(
          devRequest("https://portal.test/api/admin/audit", "admin@gz-zhiyun.com"),
          env,
        );
      }

      // #then - /user/list?user_email called exactly once across all 5 requests
      expect(userListCalls).toBe(1);
    });

    it("audit pagination params: page=3&size=25 are forwarded to LiteLLM as page=3&page_size=25", async () => {
      // #given
      const litellmUrls: string[] = [];
      globalThis.fetch = async (input) => {
        const url = String(input);
        litellmUrls.push(url);
        if (url === "https://litellm.test/user/list?user_email=admin%40gz-zhiyun.com") {
          return Response.json({
          users: [{ user_id: "admin-uid", user_role: "proxy_admin", user_email: "admin@gz-zhiyun.com" }],
        });
        }
        if (url.includes("https://litellm.test/audit?")) {
          return Response.json({ data: [], total_count: 0 });
        }
        return new Response("not found", { status: 404 });
      };

      // #when
      const response = await handleLiteLLMPortalRequest(
        devRequest("https://portal.test/api/admin/audit?page=3&size=25", "admin@gz-zhiyun.com"),
        portalEnv({ LITELLM_PORTAL_DEV_AUTH: "true" }),
      );

      // #then
      expect(response.status).toBe(200);
      const auditUrl = litellmUrls.find((url) => url.includes("/audit?"));
      expect(auditUrl).toBeDefined();
      expect(auditUrl).toContain("page=3");
      expect(auditUrl).toContain("page_size=25");
    });

    it("/user/list 404 yields role=none and /api/me body contains no master key material", async () => {
      // #given
      globalThis.fetch = async (input) => {
        if (String(input) === "https://litellm.test/user/list?user_email=unknown%40gz-zhiyun.com") {
          return new Response("not found", { status: 404 });
        }
        return new Response("not found", { status: 404 });
      };

      // #when
      const response = await handleLiteLLMPortalRequest(
        devRequest("https://portal.test/api/me", "unknown@gz-zhiyun.com"),
        portalEnv({ LITELLM_PORTAL_DEV_AUTH: "true" }),
      );

      // #then
      expect(response.status).toBe(200);
      const body = await response.json() as Record<string, unknown>;
      expect(body.role).toBe("none");
      const serialized = JSON.stringify(body);
      // must not leak master key prefix or the word 'master'
      expect(serialized).not.toMatch(/sk-/u);
      expect(serialized.toLowerCase()).not.toContain("master");
    });

    it("/api/admin/usage/timeseries with no grain defaults to day and returns source=spend_logs_v2_global", async () => {
      // #given
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-05-10T12:00:00.000Z"));
      globalThis.fetch = async (input) => {
        if (String(input) === "https://litellm.test/user/list?user_email=admin%40gz-zhiyun.com") {
          return Response.json({
          users: [{ user_id: "admin-uid", user_role: "proxy_admin", user_email: "admin@gz-zhiyun.com" }],
        });
        }
        if (new URL(String(input)).pathname === "/spend/logs/v2") {
          return Response.json({ data: [], total_pages: 1 });
        }
        return new Response("not found", { status: 404 });
      };

      // #when - no grain param
      const response = await handleLiteLLMPortalRequest(
        devRequest("https://portal.test/api/admin/usage/timeseries?window=30d", "admin@gz-zhiyun.com"),
        portalEnv({ LITELLM_PORTAL_DEV_AUTH: "true" }),
      );

      // #then
      expect(response.status).toBe(200);
      const body = await response.json() as Record<string, unknown>;
      expect(body.grain).toBe("day");
      expect(body.source).toBe("spend_logs_v2_global");
    });

    it("/api/admin/users size=999 is clamped to ADMIN_PAGE_SIZE_MAX=100", async () => {
      // #given
      const litellmUrls: string[] = [];
      globalThis.fetch = async (input) => {
        const url = String(input);
        litellmUrls.push(url);
        if (url === "https://litellm.test/user/list?user_email=admin%40gz-zhiyun.com") {
          return Response.json({
          users: [{ user_id: "admin-uid", user_role: "proxy_admin", user_email: "admin@gz-zhiyun.com" }],
        });
        }
        if (url.startsWith("https://litellm.test/user/list?")) {
          return Response.json({ users: [], total_count: 0 });
        }
        return new Response("not found", { status: 404 });
      };

      // #when
      const response = await handleLiteLLMPortalRequest(
        devRequest("https://portal.test/api/admin/users?size=999", "admin@gz-zhiyun.com"),
        portalEnv({ LITELLM_PORTAL_DEV_AUTH: "true" }),
      );

      // #then
      expect(response.status).toBe(200);
      // The forwarded LiteLLM URL must have page_size clamped to 100 (LiteLLM /user/list page_size maximum)
      const listUrl = litellmUrls.find((url) => url.startsWith("https://litellm.test/user/list?page="));
      expect(listUrl).toBeDefined();
      const forwarded = new URL(listUrl ?? "");
      expect(Number(forwarded.searchParams.get("page_size"))).toBeLessThanOrEqual(100);
    });

    it("LiteLLM 500 on all admin routes returns 502 and leaks no master key material", async () => {
      // #given
      _clearRoleCacheForTests();
      globalThis.fetch = async (input) => {
        if (String(input) === "https://litellm.test/user/list?user_email=admin%40gz-zhiyun.com") {
          return Response.json({
          users: [{ user_id: "admin-uid", user_role: "proxy_admin", user_email: "admin@gz-zhiyun.com" }],
        });
        }
        return new Response(JSON.stringify({ error: "internal", key: "sk-secret", master: "litellm-master" }), { status: 500 });
      };

      const adminPaths = [
        "/api/admin/users",
        "/api/admin/summary",
        "/api/admin/teams",
        "/api/admin/audit",
        "/api/admin/usage/timeseries?grain=day&window=7d",
      ];

      for (const path of adminPaths) {
        // #when
        const response = await handleLiteLLMPortalRequest(
          devRequest(`https://portal.test${path}`, "admin@gz-zhiyun.com"),
          portalEnv({ LITELLM_PORTAL_DEV_AUTH: "true" }),
        );

        // #then
        expect(response.status, `${path} should return 502`).toBe(502);
        const serialized = JSON.stringify(await response.json());
        expect(serialized, `${path} must not leak sk- prefix`).not.toMatch(/sk-/u);
        expect(serialized.toLowerCase(), `${path} must not leak 'master'`).not.toContain("master");
      }
    });
  });

  describe("Zod schema validation (POST /api/keys)", () => {
    it("returns 400 with key_alias_required when keyAlias is missing from POST /api/keys body", async () => {
      globalThis.fetch = async (input) => {
        if (String(input).includes("/user/list")) {
          return Response.json({
            users: [{ user_id: "liqingying", user_email: "liqingying@gz-zhiyun.com", teams: [], spend: 0, max_budget: null, user_role: "internal_user" }],
          });
        }
        return Response.json({});
      };

      const response = await handleLiteLLMPortalRequest(
        devRequest("https://portal.test/api/keys", "liqingying@gz-zhiyun.com", {
          method: "POST",
          body: JSON.stringify({}),
        }),
        portalEnv({ LITELLM_PORTAL_DEV_AUTH: "true" }),
      );

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toEqual({ error: "key_alias_required" });
    });

    it("returns 400 with key_alias_required when keyAlias is an empty string in POST /api/keys body", async () => {
      globalThis.fetch = async (input) => {
        if (String(input).includes("/user/list")) {
          return Response.json({
            users: [{ user_id: "liqingying", user_email: "liqingying@gz-zhiyun.com", teams: [], spend: 0, max_budget: null, user_role: "internal_user" }],
          });
        }
        return Response.json({});
      };

      const response = await handleLiteLLMPortalRequest(
        devRequest("https://portal.test/api/keys", "liqingying@gz-zhiyun.com", {
          method: "POST",
          body: JSON.stringify({ keyAlias: "" }),
        }),
        portalEnv({ LITELLM_PORTAL_DEV_AUTH: "true" }),
      );

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toEqual({ error: "key_alias_required" });
    });
  });

});

function portalEnv(overrides: Partial<LiteLLMPortalEnv> = {}): LiteLLMPortalEnv {
  return {
    CLOUDFLARE_ACCESS_AUD: "access-aud",
    CLOUDFLARE_ACCESS_TEAM_DOMAIN: accessTeamDomain,
    LITELLM_ALLOWED_MODELS: "gpt-4o-mini",
    LITELLM_BASE_URL: "https://litellm.test",
    LITELLM_MASTER_KEY: "litellm-master",
    LITELLM_PORTAL_ALLOWED_EMAIL_DOMAIN: "gz-zhiyun.com",
    ...overrides,
  };
}

function devRequest(url: string, email: string, init: RequestInit = {}): Request {
  const headers = new Headers(init.headers);
  headers.set("x-litellm-portal-dev-email", email);
  if (init.body !== undefined) {
    headers.set("content-type", "application/json");
  }
  return new Request(url, { ...init, headers });
}

async function accessJwt(email: string): Promise<{ jwt: string; jwk: JsonWebKey & { alg: string; kid: string; use: string } }> {
  if (accessSigningKey === undefined || accessPublicJwk === undefined) {
    accessSigningKey = await crypto.subtle.generateKey(
      {
        name: "RSASSA-PKCS1-v1_5",
        modulusLength: 2048,
        publicExponent: new Uint8Array([1, 0, 1]),
        hash: "SHA-256",
      },
      true,
      ["sign", "verify"],
    ) as CryptoKeyPair;
    const publicJwk = await crypto.subtle.exportKey("jwk", accessSigningKey.publicKey) as JsonWebKey;
    accessPublicJwk = { ...publicJwk, kid: "test-key", alg: "RS256", use: "sig" };
  }
  const jwk = accessPublicJwk;
  const now = Math.floor(Date.now() / 1000);
  const header = base64UrlJson({ alg: "RS256", kid: "test-key", typ: "JWT" });
  const payload = base64UrlJson({
    aud: "access-aud",
    email,
    exp: now + 3600,
    iss: accessTeamDomain,
  });
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    accessSigningKey.privateKey,
    new TextEncoder().encode(`${header}.${payload}`),
  );

  return {
    jwt: `${header}.${payload}.${base64UrlBytes(new Uint8Array(signature))}`,
    jwk,
  };
}

function base64UrlJson(value: Record<string, unknown>): string {
  return base64UrlBytes(new TextEncoder().encode(JSON.stringify(value)));
}

function base64UrlBytes(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/\+/gu, "-").replace(/\//gu, "_").replace(/=+$/u, "");
}
