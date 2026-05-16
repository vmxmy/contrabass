import React from "react";
import { createRoute } from "@tanstack/react-router";
import { rootRoute } from "./__root";
import { IdentityBar } from "../identity-bar";
import { UsageDashboard } from "../dashboard/views/usage-dashboard";

export const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  component: UserView,
});

function UserView() {
  return (
    <>
      <IdentityBar />

      <section id="usage-panel-root" className="mb-14">
        <UsageDashboard />
      </section>
    </>
  );
}
