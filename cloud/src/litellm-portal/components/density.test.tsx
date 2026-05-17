/**
 * @vitest-environment happy-dom
 */
import React from "react";
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { DensityProvider, useDensity, densityClasses, resolveDensity } from "./density";

afterEach(cleanup);

function Probe() {
  const d = useDensity();
  return <span data-testid="d">{d}</span>;
}

describe("density context (§A.2)", () => {
  it("defaults to comfortable with no provider", () => {
    render(<Probe />);
    expect(screen.getByTestId("d").textContent).toBe("comfortable");
  });

  it("provider overrides to compact", () => {
    render(
      <DensityProvider density="compact">
        <Probe />
      </DensityProvider>,
    );
    expect(screen.getByTestId("d").textContent).toBe("compact");
  });

  it("densityClasses maps to existing DESIGN.md spacing (no new numbers), incl. the §F.1 table tier", () => {
    expect(densityClasses("comfortable")).toEqual({
      card: "p-6",
      stack: "space-y-6",
      grid: "gap-4",
      // §F.1 (V2.0 §1.2): table cell density. Comfortable = the Phase-1/2
      // table padding; compact = B-端 cockpit density.
      cell: "px-4 py-3",
      row: "h-auto",
    });
    expect(densityClasses("compact")).toEqual({
      card: "p-4",
      stack: "space-y-4",
      grid: "gap-4",
      cell: "px-3 py-1.5",
      row: "h-9",
    });
  });

  it("resolveDensity: preference wins over shell default; invalid/absent → shell default (§F.1)", () => {
    // SSR-safe pure resolver (no window/localStorage). The shell passes its
    // default; the hydrated preference (if a valid Density) overrides.
    expect(resolveDensity(undefined, "compact")).toBe("compact");
    expect(resolveDensity(undefined, "comfortable")).toBe("comfortable");
    expect(resolveDensity("comfortable", "compact")).toBe("comfortable");
    expect(resolveDensity("compact", "comfortable")).toBe("compact");
    expect(resolveDensity("bogus" as unknown as undefined, "compact")).toBe("compact");
  });
});
