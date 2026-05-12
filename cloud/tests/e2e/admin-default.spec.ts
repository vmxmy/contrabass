/**
 * E2E: admin-default.spec.ts
 *
 * Verifies that a user with admin role:
 *   - Sees the segmented tab bar (portal tabs)
 *   - Defaults to the admin tab when hash is #admin
 *   - Can switch back to user tab
 *
 * Auth: dev-auth header with an admin email.
 * Requires: wrangler dev --config wrangler.litellm-portal.toml (LITELLM_PORTAL_DEV_AUTH=true)
 * The worker resolves the admin role by calling LiteLLM /user/list — in dev the mock
 * or a real LiteLLM instance must return proxy_admin for this email.
 */

import { test, expect } from "@playwright/test";

const ADMIN_EMAIL = "admin@example.com";

test.use({
  extraHTTPHeaders: {
    "x-litellm-portal-dev-email": ADMIN_EMAIL,
  },
});

test.describe("Admin default tab", () => {
  test("admin visiting /#admin sees admin section", async ({ page }) => {
    // Mock /api/me to return admin role (avoids needing a live LiteLLM instance)
    await page.route("/api/me", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ role: "admin" }),
      });
    });

    await page.goto("/#admin");
    await page.waitForLoadState("networkidle");

    // Portal tabs nav is rendered for admins
    await expect(page.locator("#portal-tabs-root")).toBeVisible();

    // Admin section heading
    await expect(page.getByText("全局管理（只读）")).toBeVisible();

    // Admin-root panel is shown
    const adminRoot = page.locator("#admin-root");
    await expect(adminRoot).toBeVisible();
  });

  test("admin can switch to user tab", async ({ page }) => {
    await page.route("/api/me", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ role: "admin" }),
      });
    });

    await page.goto("/#admin");
    await page.waitForLoadState("networkidle");

    // Click the "个人视图" tab
    await page.getByRole("tab", { name: "个人视图" }).click();

    // User panel should now be visible
    await expect(page.locator("#user-panel")).toBeVisible();
  });

  test("admin tab shows admin badge", async ({ page }) => {
    await page.route("/api/me", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ role: "admin" }),
      });
    });

    await page.goto("/#admin");
    await page.waitForLoadState("networkidle");

    // The admin-only badge
    await expect(page.getByText("仅管理员可见")).toBeVisible();
  });
});
