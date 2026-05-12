import React from "react";
import { createRoute } from "@tanstack/react-router";
import { rootRoute } from "./__root";
import {
  HeroStats,
  TeamsAccessCard,
  ModelAccessCard,
  ApiKeysCard,
  UsagePanel,
} from "../app";

export const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  component: UserView,
});

function UserView() {
  return (
    <>
      <div id="hero-stats-root" className="mb-14">
        <HeroStats />
      </div>

      <section id="usage-panel-root" className="mb-14">
        <UsagePanel />
      </section>

      <section className="mb-10 grid grid-cols-1 gap-5 md:grid-cols-[1fr_2fr]">
        <div id="teams-root">
          <TeamsAccessCard />
        </div>
        <div id="models-root">
          <ModelAccessCard />
        </div>
      </section>

      <div id="keys-root">
        <ApiKeysCard />
      </div>
    </>
  );
}
