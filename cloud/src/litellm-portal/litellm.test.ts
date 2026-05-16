import { describe, it, expect, vi, afterEach } from "vitest";
import { createTeam, LiteLLMRequestError } from "./litellm";
import type { LiteLLMPortalEnv } from "./types";

const originalFetch = globalThis.fetch;

function makeEnv(): LiteLLMPortalEnv {
  return {
    LITELLM_BASE_URL: "https://litellm.test",
    LITELLM_MASTER_KEY: "master-key",
  } as unknown as LiteLLMPortalEnv;
}

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe("createTeam", () => {
  it("posts /team/new with mapped fields, omits team_id, returns generated id", async () => {
    // #given LiteLLM mints the team id
    let captured: { url: string; init: RequestInit } | null = null;
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      captured = { url: String(input), init: init ?? {} };
      return new Response(JSON.stringify({ team_id: "team_generated_123", team_alias: "Acme" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;

    // #when
    const result = await createTeam(
      makeEnv(),
      { alias: "Acme", models: ["gpt-4o"], maxBudget: 100, tpmLimit: 5000, rpmLimit: 60, budgetDuration: "30d" },
      "admin@x.com",
    );

    // #then response team_id is authoritative
    expect(result).toEqual({
      teamId: "team_generated_123",
      alias: "Acme",
      models: ["gpt-4o"],
      maxBudget: 100,
    });
    expect(captured!.url).toBe("https://litellm.test/team/new");
    expect(captured!.init.method).toBe("POST");
    const body = JSON.parse(String(captured!.init.body));
    expect(body).toEqual({
      team_alias: "Acme",
      models: ["gpt-4o"],
      max_budget: 100,
      tpm_limit: 5000,
      rpm_limit: 60,
      budget_duration: "30d",
    });
    // never send a client-chosen team_id
    expect(body).not.toHaveProperty("team_id");
    expect(new Headers(captured!.init.headers).get("litellm-changed-by")).toBe("admin@x.com");
    expect(new Headers(captured!.init.headers).get("authorization")).toBe("Bearer master-key");
  });

  it("omits optional fields when null/undefined", async () => {
    let captured: RequestInit = {};
    globalThis.fetch = vi.fn(async (_i: RequestInfo | URL, init?: RequestInit) => {
      captured = init ?? {};
      return new Response(JSON.stringify({ team_id: "t1" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;

    await createTeam(makeEnv(), { alias: "Bare", models: [], maxBudget: null });

    const body = JSON.parse(String(captured.body));
    expect(body).toEqual({ team_alias: "Bare", models: [] });
  });

  it("throws when LiteLLM response lacks a team_id", async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ team_alias: "NoId" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    ) as unknown as typeof fetch;

    await expect(createTeam(makeEnv(), { alias: "NoId", models: [] })).rejects.toBeInstanceOf(
      LiteLLMRequestError,
    );
  });

  it("propagates LiteLLMRequestError on non-2xx", async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ detail: "bad" }), {
        status: 422,
        headers: { "content-type": "application/json" },
      }),
    ) as unknown as typeof fetch;

    await expect(
      createTeam(makeEnv(), { alias: "X", models: [] }),
    ).rejects.toMatchObject({ status: 422 });
  });
});
