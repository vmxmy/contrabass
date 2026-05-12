/**
 * Playwright configuration for LiteLLM Portal E2E tests.
 *
 * Prerequisites for a real run:
 *   1. Start the worker:  pnpm dev:litellm-portal
 *      (sets LITELLM_PORTAL_DEV_AUTH=true which enables the x-litellm-portal-dev-email header)
 *   2. The baseURL below must match the wrangler dev port (default 8787).
 *
 * Auth is injected via the `x-litellm-portal-dev-email` request header — see
 * `src/litellm-portal/auth.ts` for the dev-auth gate. Each spec sets the header
 * in `extraHTTPHeaders` to simulate a specific user or admin identity.
 */

import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: true,
  forbidOnly: !!process.env["CI"],
  retries: process.env["CI"] ? 2 : 0,
  workers: process.env["CI"] ? 1 : undefined,
  reporter: process.env["CI"]
    ? [["github"], ["html", { outputFolder: "playwright-report", open: "never" }]]
    : "list",
  use: {
    /**
     * Base URL: wrangler dev default for wrangler.litellm-portal.toml.
     * Override with PLAYWRIGHT_BASE_URL env var for preview deployments.
     */
    baseURL: process.env["PLAYWRIGHT_BASE_URL"] ?? "http://127.0.0.1:8787",
    trace: "on-first-retry",
    screenshot: "only-on-failure",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  outputDir: "test-results",
});
