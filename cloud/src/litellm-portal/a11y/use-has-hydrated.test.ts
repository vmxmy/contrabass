/**
 * @vitest-environment happy-dom
 */
import React from "react";
import { describe, expect, it } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { renderToString } from "react-dom/server";
import { useHasHydrated } from "./use-has-hydrated";

function Probe({ onValue }: { onValue: (v: boolean) => void }) {
  onValue(useHasHydrated());
  return null;
}

describe("useHasHydrated", () => {
  it("returns false during SSR / the first (hydration) render", () => {
    // #given/#when — SSR never runs effects, mirroring the hydration render.
    let value: boolean | undefined;
    renderToString(React.createElement(Probe, { onValue: (v) => (value = v) }));

    // #then — first render must be deterministic (SSR-equivalent).
    expect(value).toBe(false);
  });

  it("flips to true after effects flush (post-hydration)", async () => {
    // #given
    const { result } = renderHook(() => useHasHydrated());

    // #when — effects run only after the first commit (client-only).
    await act(async () => {});

    // #then
    expect(result.current).toBe(true);
  });
});
