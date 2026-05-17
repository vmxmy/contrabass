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
 *
 * webServer (§F.2 / Task 3B): builds + serves the SAME worker artifact the
 * deploy path uses (`dist/litellm-portal-worker/index.js` via
 * `build:litellm-portal`, served with `wrangler dev --no-bundle`). This is the
 * documented build+serve sequence from `portal-e2e.yml` / `deploy:litellm-portal`
 * — not a new server. `reuseExistingServer` lets a manually-started
 * `dev:litellm-portal` (the legacy local workflow) take precedence when present,
 * so the existing specs are unaffected; otherwise Playwright boots the built
 * worker headlessly (CI/staging-capable). The Lingui macro is only transformed
 * by `build:litellm-portal`, so a raw `wrangler dev` on the TS source 500s —
 * the built bundle is the only servable artifact for the SSR portal.
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
  webServer: {
    command:
      "node scripts/generate-litellm-portal-kumo-css.mjs && node scripts/build-litellm-portal-app.mjs && node scripts/build-litellm-portal-worker.mjs && wrangler dev dist/litellm-portal-worker/index.js --no-bundle --config wrangler.litellm-portal.toml --port 8787 --local --ip 127.0.0.1 --var LITELLM_PORTAL_DEV_AUTH:true",
    url: process.env["PLAYWRIGHT_BASE_URL"] ?? "http://127.0.0.1:8787",
    reuseExistingServer: !process.env["CI"],
    timeout: 180_000,
    stdout: "pipe",
    stderr: "pipe",
    env: {
      LITELLM_PORTAL_DEV_AUTH: "true",
      LITELLM_BASE_URL: process.env["LITELLM_BASE_URL"] ?? "http://localhost:14000",
      LITELLM_MASTER_KEY: process.env["LITELLM_MASTER_KEY"] ?? "sk-test-placeholder",
    },
  },
  outputDir: "test-results",
});
