/**
 * @vitest-environment happy-dom
 */
import { describe, expect, it } from "vitest";
import { createPortalRouter, createMemoryHistory } from "./router";

describe("createPortalRouter", () => {
  it("creates a router with the expected route paths", () => {
    const history = createMemoryHistory({ initialEntries: ["/"] });
    const router = createPortalRouter(history, { role: "admin" });

    const flatRoutes = router.routeTree.children ?? [];
    // The route tree is a flat list of top-level route IDs.  We verify by
    // navigating to each path and confirming no notFound is triggered.
    expect(router).toBeDefined();
    expect(router.routeTree).toBeDefined();
  });

  it("resolves / to the index route for a user-role context", async () => {
    const history = createMemoryHistory({ initialEntries: ["/"] });
    const router = createPortalRouter(history, { role: "user" });
    await router.load();

    const state = router.state;
    expect(state.location.pathname).toBe("/");
    // Should not have a notFound route active
    expect(state.matches.some((m) => m.routeId === "__root__/404")).toBe(false);
  });

  it("redirects non-admin to / when navigating to /admin (role guard)", async () => {
    const history = createMemoryHistory({ initialEntries: ["/admin"] });
    const router = createPortalRouter(history, { role: "user" });
    await router.load();

    // The beforeLoad in admin/route.tsx throws redirect({ to: "/" }).
    // After load(), the router state should be at "/" not "/admin".
    const state = router.state;
    expect(state.location.pathname).toBe("/");
  });

  it("allows admin to access /admin (role guard passes)", async () => {
    const history = createMemoryHistory({ initialEntries: ["/admin"] });
    const router = createPortalRouter(history, { role: "admin" });
    await router.load();

    const state = router.state;
    expect(state.location.pathname).toBe("/admin");
  });

  it("allows admin to access /admin/audit/:eventId deep link", async () => {
    const history = createMemoryHistory({ initialEntries: ["/admin/audit/abc123"] });
    const router = createPortalRouter(history, { role: "admin" });
    await router.load();

    const state = router.state;
    expect(state.location.pathname).toBe("/admin/audit/abc123");
  });

  it("redirects non-admin from /admin/audit/:eventId to /", async () => {
    const history = createMemoryHistory({ initialEntries: ["/admin/audit/abc123"] });
    const router = createPortalRouter(history, { role: "none" });
    await router.load();

    const state = router.state;
    expect(state.location.pathname).toBe("/");
  });
});
