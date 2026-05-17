/**
 * @vitest-environment happy-dom
 */
import React from "react";
import { describe, expect, it } from "vitest";
import { act, render } from "@testing-library/react";
import { renderToString } from "react-dom/server";
import { SsrSafeSkeleton } from "./ssr-safe-skeleton";

describe("SsrSafeSkeleton", () => {
  it("SSR output is the deterministic placeholder, never Kumo SkeletonLine", () => {
    // #given/#when — server render is the #418-relevant path.
    const html = renderToString(
      <SsrSafeSkeleton minWidth={80} maxWidth={120} blockHeight={12} />,
    );

    // #then
    expect(html).toContain("data-ssr-skeleton-placeholder");
    expect(html).not.toContain("skeleton-line");
    expect(html).not.toContain("--skeleton-width");
    expect(html).not.toContain("--shimmer");
  });

  it("SSR placeholder geometry is literal props — no Math.random-derived style", () => {
    // #given/#when
    const html = renderToString(<SsrSafeSkeleton minWidth={64} blockHeight={20} />);

    // #then — width/height are the literal props; no random %/duration/delay.
    expect(html).toContain("width:64px");
    expect(html).toContain("height:20px");
    expect(html).not.toContain("--skeleton-width");
    expect(html).not.toContain("--shimmer");
  });

  it("swaps to the real Kumo SkeletonLine after effects flush (post-hydration, client-only)", async () => {
    // #given
    const { container } = render(<SsrSafeSkeleton minWidth={80} maxWidth={120} blockHeight={12} />);

    // #when — the post-commit effect flips the hydration gate (client-only).
    await act(async () => {});

    // #then
    expect(container.querySelector("[data-ssr-skeleton-placeholder]")).toBeNull();
    expect(container.querySelector(".skeleton-line")).not.toBeNull();
  });
});
