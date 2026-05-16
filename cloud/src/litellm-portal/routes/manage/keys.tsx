import React from "react";
import { createRoute } from "@tanstack/react-router";
import { manageRoute } from "./route";
import { ApiKeysCard, ModelAccessCard, TeamsAccessCard } from "../../app";

export const manageKeysRoute = createRoute({
  getParentRoute: () => manageRoute,
  path: "/keys",
  component: ManageKeysPage,
});

export function ManageKeysPage() {
  return (
    <div className="space-y-8" id="keys-root">
      <section className="grid grid-cols-1 gap-5 md:grid-cols-[1fr_2fr]">
        <div id="teams-root">
          <TeamsAccessCard />
        </div>
        <div id="models-root">
          <ModelAccessCard />
        </div>
      </section>
      <ApiKeysCard />
    </div>
  );
}
