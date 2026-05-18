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

describe("PageShell — id/style/className passthrough (shell-migration unblock)", () => {
  it("forwards id and inline style to the root (preserves Ops steel accent / anchors)", () => {
    const { container } = render(
      <PageShell
        id="ops-console-shell-root"
        style={{ ["--kumo-brand" as string]: "#71717a" }}
        nav={<aside />}
      >
        x
      </PageShell>,
    );
    const root = container.querySelector("[data-page-shell]") as HTMLElement;
    expect(root.id).toBe("ops-console-shell-root");
    expect(root.style.getPropertyValue("--kumo-brand")).toBe("#71717a");
  });

  it("appends className to the canonical token set without replacing it", () => {
    const { container } = render(
      <PageShell className="extra-shell-class" nav={<aside />}>
        x
      </PageShell>,
    );
    const root = container.querySelector("[data-page-shell]") as HTMLElement;
    expect(root.className).toContain(
      "flex min-h-screen flex-col bg-kumo-canvas text-kumo-default",
    );
    expect(root.className).toContain("extra-shell-class");
  });

  it("still emits the exact canonical tokens when no passthrough is given (regression)", () => {
    const { container } = render(<PageShell nav={<aside />}>x</PageShell>);
    const root = container.querySelector("[data-page-shell]") as HTMLElement;
    expect(root.className).toBe(
      "flex min-h-screen flex-col bg-kumo-canvas text-kumo-default",
    );
    expect(root.id).toBe("");
  });
});
describe("PageShell — preHeader slot (tenant impersonation/summary placement)", () => {
  it("renders preHeader content before the header band and OUTSIDE nav/main", () => {
    const { container } = render(
      <PageShell
        preHeader={<div data-testid="pre">PRE</div>}
        header={<span>brand</span>}
        nav={<aside data-testid="nav" />}
      >
        <p data-testid="body">body</p>
      </PageShell>,
    );
    const root = container.querySelector("[data-page-shell]") as HTMLElement;
    const pre = container.querySelector("[data-page-shell-preheader]") as HTMLElement;
    const band = container.querySelector("[data-page-shell-header]") as HTMLElement;
    const flex = container.querySelector("[data-page-shell-body]") as HTMLElement;
    // present + is a direct child of root
    expect(pre).not.toBeNull();
    expect(pre.parentElement).toBe(root);
    // NOT wrapped in the header band chrome
    expect(pre.closest("[data-page-shell-header]")).toBeNull();
    // NOT inside the nav/main flex container
    expect(pre.closest("[data-page-shell-body]")).toBeNull();
    // DOM order: preHeader comes before the header band, which comes before body flex
    const kids = Array.from(root.children);
    expect(kids.indexOf(pre)).toBeLessThan(kids.indexOf(band));
    expect(kids.indexOf(band)).toBeLessThan(kids.indexOf(flex));
    expect(screen.getByTestId("pre")).toBeTruthy();
  });

  it("omits the preHeader region entirely when not provided (backward compatible)", () => {
    const { container } = render(
      <PageShell header={<span>h</span>} nav={<aside />}>x</PageShell>,
    );
    expect(container.querySelector("[data-page-shell-preheader]")).toBeNull();
  });

  it("supports preHeader with NO header band (tenant non-owner has banner+summary, header optional)", () => {
    const { container } = render(
      <PageShell preHeader={<div data-testid="pre2" />} nav={<aside />}>x</PageShell>,
    );
    expect(container.querySelector("[data-page-shell-preheader]")).not.toBeNull();
    expect(container.querySelector("[data-page-shell-header]")).toBeNull();
  });
});
