import { describe, expect, it } from "vitest";

import { handleRequest } from "./index";

describe("cloud worker scaffold", () => {
  it("returns an explicit placeholder response", async () => {
    const response = handleRequest();

    await expect(response.json()).resolves.toEqual({
      service: "contrabass-cloud",
      status: "not_configured",
    });
    expect(response.status).toBe(503);
  });
});
