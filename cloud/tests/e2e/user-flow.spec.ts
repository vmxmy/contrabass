/**
 * E2E: user-flow.spec.ts
 *
 * Verifies that a regular (non-admin) user:
 *   - Can reach the portal home page
 *   - Sees HeroStats tiles
 *   - Does NOT see the admin tab / admin section
 *
 * Auth: dev-auth header with a non-admin email.
 * Requires: wrangler dev --config wrangler.litellm-portal.toml (LITELLM_PORTAL_DEV_AUTH=true)
 */

import { test, expect } from "@playwright/test";

const USER_EMAIL = "user@example.com";

test.use({
  extraHTTPHeaders: {
    "x-litellm-portal-dev-email": USER_EMAIL,
  },
});

test.describe("User portal flow", () => {
  test("home page loads and shows hero stats", async ({ page }) => {
    await page.goto("/");

    // The portal main element should be present
    await expect(page.locator("main")).toBeVisible();

    // HeroStats section renders four stat tiles
    const heroSection = page.locator("#hero-stats-root");
    await expect(heroSection).toBeVisible();

    // At least one stat tile is visible (the grid has 4 columns on xl)
    const tiles = heroSection.locator('[class*="rounded"]');
    await expect(tiles.first()).toBeVisible();
  });

  test("non-admin user does not see admin tab", async ({ page }) => {
    await page.goto("/");

    // Wait for the page to be interactive
    await page.waitForLoadState("networkidle");

    // The portal-tabs-root nav is only rendered for admins
    const adminTab = page.locator("#portal-tabs-root");
    await expect(adminTab).toHaveCount(0);

    // The admin-root panel should not be visible to non-admins
    const adminRoot = page.locator("#admin-root");
    await expect(adminRoot).toHaveCount(0);
  });

  test("user panel sections are rendered", async ({ page }) => {
    await page.goto("/");
    await page.waitForLoadState("networkidle");

    await expect(page.locator("#user-panel")).toBeVisible();
    await expect(page.locator("#teams-root")).toBeVisible();
    await expect(page.locator("#keys-root")).toBeVisible();
  });

  test("header shows logout button", async ({ page }) => {
    await page.goto("/");

    const logoutBtn = page.getByRole("button", { name: "退出登录" });
    await expect(logoutBtn).toBeVisible();
  });
});
