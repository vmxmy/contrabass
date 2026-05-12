/**
 * E2E: admin-pagination.spec.ts
 *
 * Verifies that an admin user can paginate the admin users table:
 *   - Page 1 is loaded by default
 *   - Clicking "next page" triggers a fetch for page 2
 *   - The table updates with page-2 data
 *
 * Auth: dev-auth header with an admin email.
 * Requires: wrangler dev --config wrangler.litellm-portal.toml (LITELLM_PORTAL_DEV_AUTH=true)
 */

import { test, expect } from "@playwright/test";

const ADMIN_EMAIL = "admin@example.com";

test.use({
  extraHTTPHeaders: {
    "x-litellm-portal-dev-email": ADMIN_EMAIL,
  },
});

const PAGE_SIZE = 20;

function makeUsers(page: number, count: number) {
  return Array.from({ length: count }, (_, i) => ({
    userId: `user-p${page}-${i}`,
    email: `p${page}-user${i}@example.com`,
    spend: 0,
    maxBudget: null,
    teamIds: [],
    role: "internal_user",
    found: true,
    raw: {},
  }));
}

test.describe("Admin users pagination", () => {
  test("page 1 is loaded by default", async ({ page }) => {
    await page.route("/api/me", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ role: "admin" }),
      });
    });

    await page.route("/api/admin/users*", async (route) => {
      const url = new URL(route.request().url());
      const pg = Number(url.searchParams.get("page") ?? "1");
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          users: makeUsers(pg, PAGE_SIZE),
          totalCount: PAGE_SIZE * 3,
          page: pg,
          pageSize: PAGE_SIZE,
        }),
      });
    });

    await page.goto("/#admin");
    await page.waitForLoadState("networkidle");

    // First page user email should appear in the admin users table
    await expect(page.getByText("p1-user0@example.com")).toBeVisible();
  });

  test("next page loads page-2 data", async ({ page }) => {
    await page.route("/api/me", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ role: "admin" }),
      });
    });

    let requestedPage = 1;
    await page.route("/api/admin/users*", async (route) => {
      const url = new URL(route.request().url());
      requestedPage = Number(url.searchParams.get("page") ?? "1");
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          users: makeUsers(requestedPage, PAGE_SIZE),
          totalCount: PAGE_SIZE * 3,
          page: requestedPage,
          pageSize: PAGE_SIZE,
        }),
      });
    });

    await page.goto("/#admin");
    await page.waitForLoadState("networkidle");

    // Click "next page" pagination control (aria-label may vary; use the chevron/next button)
    const nextBtn = page.getByRole("button", { name: /下一页|next/i });
    await expect(nextBtn).toBeVisible();
    await nextBtn.click();

    await page.waitForResponse((resp) => resp.url().includes("/api/admin/users") && resp.status() === 200);

    // Page 2 data should now appear
    await expect(page.getByText("p2-user0@example.com")).toBeVisible();
    expect(requestedPage).toBe(2);
  });
});
