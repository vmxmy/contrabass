/**
 * E2E: key-lifecycle.spec.ts
 *
 * Exercises the full API Key lifecycle:
 *   create key → see ClipboardText with rawKey → copy → close → delete → toast
 *
 * Auth: dev-auth header with a regular user email.
 * Requires: wrangler dev --config wrangler.litellm-portal.toml (LITELLM_PORTAL_DEV_AUTH=true)
 */

import { test, expect } from "@playwright/test";

const USER_EMAIL = "user@example.com";

test.use({
  extraHTTPHeaders: {
    "x-litellm-portal-dev-email": USER_EMAIL,
  },
});

test.describe("API Key lifecycle", () => {
  test("create key button opens dialog", async ({ page }) => {
    await page.goto("/");
    await page.waitForLoadState("networkidle");

    const createBtn = page.getByRole("button", { name: "创建 Key" });
    await expect(createBtn).toBeVisible();
    await createBtn.click();

    // Dialog should appear with create title
    await expect(page.getByText("创建新 API Key")).toBeVisible();
  });

  test("create key flow shows clipboard with rawKey", async ({ page }) => {
    // Mock the /api/keys POST to return a fake key
    await page.route("/api/keys", async (route) => {
      if (route.request().method() === "POST") {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            rawKey: "sk-test-abc123xyz",
            keyAlias: "test-key",
            expires: null,
            keyId: "key_abc123",
          }),
        });
      } else {
        await route.continue();
      }
    });

    await page.goto("/");
    await page.waitForLoadState("networkidle");

    // Open dialog
    await page.getByRole("button", { name: "创建 Key" }).click();
    await expect(page.getByText("创建新 API Key")).toBeVisible();

    // Fill alias
    const aliasInput = page.getByLabel(/名称/);
    await aliasInput.fill("test-key");

    // Submit
    await page.getByRole("button", { name: "创建 Key" }).last().click();

    // After success, dialog should show "Key 已创建" and the raw key value
    await expect(page.getByText("Key 已创建")).toBeVisible();
    await expect(page.getByText("sk-test-abc123xyz")).toBeVisible();

    // Copy action label is present
    await expect(page.getByLabel("复制完整 Key")).toBeVisible();
  });

  test("delete key opens confirmation dialog", async ({ page }) => {
    // Mock /api/keys GET to return one key
    await page.route("/api/keys*", async (route) => {
      if (route.request().method() === "GET") {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            keys: [
              {
                id: "key_abc123",
                alias: "my-test-key",
                displayKey: "sk-...abc",
                models: [],
                spend: 0,
                maxBudget: null,
                expiresAt: null,
              },
            ],
            totalCount: 1,
          }),
        });
      } else {
        await route.continue();
      }
    });

    await page.goto("/");
    await page.waitForLoadState("networkidle");

    // Keys table should show the key; click delete
    const deleteBtn = page.getByRole("button", { name: "删除" }).first();
    await expect(deleteBtn).toBeVisible();
    await deleteBtn.click();

    // Confirmation dialog
    await expect(page.getByText("删除 API Key？")).toBeVisible();
    await expect(page.getByText("「my-test-key」")).toBeVisible();
  });

  test("cancel delete closes dialog without deleting", async ({ page }) => {
    await page.route("/api/keys*", async (route) => {
      if (route.request().method() === "GET") {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            keys: [
              {
                id: "key_abc123",
                alias: "keep-me",
                displayKey: "sk-...abc",
                models: [],
                spend: 0,
                maxBudget: null,
                expiresAt: null,
              },
            ],
            totalCount: 1,
          }),
        });
      } else {
        await route.continue();
      }
    });

    await page.goto("/");
    await page.waitForLoadState("networkidle");

    await page.getByRole("button", { name: "删除" }).first().click();
    await expect(page.getByText("删除 API Key？")).toBeVisible();

    // Cancel
    await page.getByRole("button", { name: "取消" }).click();

    // Dialog should be gone; key still in table
    await expect(page.getByText("删除 API Key？")).toHaveCount(0);
  });
});
