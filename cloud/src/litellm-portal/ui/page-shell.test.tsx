/**
 * @vitest-environment happy-dom
 */
import React from "react";
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { PageShell } from "./page-shell";

afterEach(cleanup);

describe("PageShell — unified surface chrome (S2)", () => {
  it("renders the canvas wrapper, the nav slot and the main content region", () => {
    const { container } = render(
      <PageShell nav={<aside data-testid="nav">N</aside>}>
        <p>body-content</p>
      </PageShell>,
    );
    const root = container.querySelector("[data-page-shell]") as HTMLElement;
    expect(root).not.toBeNull();
    expect(root.className).toContain("min-h-screen");
    expect(root.className).toContain("bg-kumo-canvas");
    expect(screen.getByTestId("nav")).toBeTruthy();
    const main = container.querySelector("[data-page-shell-main]") as HTMLElement;
    expect(main.tagName).toBe("MAIN");
    expect(main.className).toContain("px-6");
    expect(main.className).toContain("py-8");
    expect(screen.getByText("body-content")).toBeTruthy();
  });

  it("omits the header band when no header prop is given (manage stays header-less)", () => {
    const { container } = render(
      <PageShell nav={<aside />}>x</PageShell>,
    );
    expect(container.querySelector("[data-page-shell-header]")).toBeNull();
  });

  it("renders the header band with the unified token set when header is given", () => {
    const { container } = render(
      <PageShell header={<span>brand</span>} nav={<aside />}>
        x
      </PageShell>,
    );
    const header = container.querySelector("[data-page-shell-header]") as HTMLElement;
    expect(header).not.toBeNull();
    expect(header.className).toContain("border-b");
    expect(header.className).toContain("bg-kumo-elevated");
    expect(screen.getByText("brand")).toBeTruthy();
  });

  it("emits a stable token contract (the S2 chrome matrix) so the 3 sidebar shells converge", () => {
    const { container } = render(<PageShell nav={<aside />}>x</PageShell>);
    const root = container.querySelector("[data-page-shell]") as HTMLElement;
    const main = container.querySelector("[data-page-shell-main]") as HTMLElement;
    // canonical tokens taken from the ops shell (cleanest header+sidebar)
    expect(root.className).toBe(
      "flex min-h-screen flex-col bg-kumo-canvas text-kumo-default",
    );
    expect(main.className).toBe(
      "min-w-0 flex-1 px-6 py-8 opacity-100 motion-safe:transition-opacity motion-safe:duration-150",
    );
  });
});
