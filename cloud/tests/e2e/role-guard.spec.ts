/**
 * E2E: role-guard.spec.ts
 *
 * Verifies that a non-admin user who navigates directly to /#admin
 * is redirected back to / (or the admin section is simply not rendered).
 *
 * The portal implements this as a client-side guard: App() only renders
 * <AdminSection> when role === "admin". When the role resolves to "user"
 * or "none", the admin panel is never mounted regardless of the URL hash.
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

test.describe("Role guard — non-admin cannot access admin section", () => {
  test("non-admin visiting /#admin does not see admin section", async ({ page }) => {
    // Mock /api/me to return user role
    await page.route("/api/me", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ role: "user" }),
      });
    });

    await page.goto("/#admin");
    await page.waitForLoadState("networkidle");

    // Admin section must NOT be visible
    await expect(page.getByText("全局管理（只读）")).toHaveCount(0);

    // The portal tabs nav must NOT be rendered for non-admins
    await expect(page.locator("#portal-tabs-root")).toHaveCount(0);

    // The admin-root element must NOT be present in the DOM
    await expect(page.locator("#admin-root")).toHaveCount(0);
  });

  test("non-admin always sees user panel even on /#admin", async ({ page }) => {
    await page.route("/api/me", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ role: "user" }),
      });
    });

    await page.goto("/#admin");
    await page.waitForLoadState("networkidle");

    // User panel should still be shown
    await expect(page.locator("#user-panel")).toBeVisible();
  });

  test("role=none gets no admin section either", async ({ page }) => {
    await page.route("/api/me", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ role: "none" }),
      });
    });

    await page.goto("/#admin");
    await page.waitForLoadState("networkidle");

    await expect(page.locator("#admin-root")).toHaveCount(0);
    await expect(page.getByText("仅管理员可见")).toHaveCount(0);
  });
});
