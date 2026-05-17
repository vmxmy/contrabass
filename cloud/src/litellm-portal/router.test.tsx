/**
 * @vitest-environment happy-dom
 */
import { describe, expect, it } from "vitest";
import { createPortalRouter, createMemoryHistory } from "./router";

describe("createPortalRouter", () => {
  it("resolves / to the unified usage dashboard for a user-role context", async () => {
    const history = createMemoryHistory({ initialEntries: ["/"] });
    const router = createPortalRouter(history, { role: "user" });
    await router.load();

    expect(router.state.location.pathname).toBe("/");
    expect(router.state.matches.some((m) => m.routeId === "__root__/404")).toBe(false);
  });

  it("redirects /manage to /manage/keys", async () => {
    const history = createMemoryHistory({ initialEntries: ["/manage"] });
    const router = createPortalRouter(history, { role: "user" });
    await router.load();

    expect(router.state.location.pathname).toBe("/manage/keys");
  });

  it("allows non-admin users to access /manage/keys", async () => {
    const history = createMemoryHistory({ initialEntries: ["/manage/keys"] });
    const router = createPortalRouter(history, { role: "user" });
    await router.load();

    expect(router.state.location.pathname).toBe("/manage/keys");
  });

  it("redirects non-admin users away from admin-only manage routes", async () => {
    const history = createMemoryHistory({ initialEntries: ["/manage/audit/abc123"] });
    const router = createPortalRouter(history, { role: "none" });
    await router.load();

    expect(router.state.location.pathname).toBe("/");
  });

  it("allows admin users to access admin-only manage routes", async () => {
    const history = createMemoryHistory({ initialEntries: ["/manage/audit/abc123"] });
    const router = createPortalRouter(history, { role: "admin" });
    await router.load();

    expect(router.state.location.pathname).toBe("/manage/audit/abc123");
  });

  it("keeps /manage/keys resolving unchanged after the Tenant Portal shell lands", async () => {
    const history = createMemoryHistory({ initialEntries: ["/manage/keys"] });
    const router = createPortalRouter(history, { role: "user" });
    await router.load();

    expect(router.state.location.pathname).toBe("/manage/keys");
    expect(router.state.matches.some((m) => m.routeId === "__root__/404")).toBe(false);
  });

  it("redirects /manage to /manage/keys after Task 1 (legacy not regressed)", async () => {
    const history = createMemoryHistory({ initialEntries: ["/manage"] });
    const router = createPortalRouter(history, { role: "admin" });
    await router.load();

    expect(router.state.location.pathname).toBe("/manage/keys");
  });

  it("redirects legacy /admin links to the new destinations", async () => {
    const history = createMemoryHistory({ initialEntries: ["/admin/users/alice%40example.com"] });
    const router = createPortalRouter(history, { role: "admin" });
    await router.load();

    expect(router.state.location.pathname).toBe("/manage/users/alice%40example.com");
  });

  it("redirects legacy /preferences to /manage/preferences", async () => {
    const history = createMemoryHistory({ initialEntries: ["/preferences"] });
    const router = createPortalRouter(history, { role: "user" });
    await router.load();

    expect(router.state.location.pathname).toBe("/manage/preferences");
  });
});
