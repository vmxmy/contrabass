/**
 * @vitest-environment happy-dom
 */
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { I18nProvider } from "@lingui/react";
import { setupI18n } from "../i18n/setup";
import { BlockErrorBoundary } from "./error-boundary";

const i18n = setupI18n("zh-CN");
afterEach(cleanup);

function Boom(): React.ReactElement {
  throw new Error("chart runtime exploded");
}

describe("§F.4 BlockErrorBoundary (V2.0 §2.4)", () => {
  it("a throwing child degrades to an inline error panel; siblings unaffected", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    render(
      <I18nProvider i18n={i18n}>
        <div>
          <span data-testid="sibling">healthy sibling</span>
          <BlockErrorBoundary blockLabel="用量图表">
            <Boom />
          </BlockErrorBoundary>
        </div>
      </I18nProvider>,
    );
    // sibling intact (no full-page crash):
    expect(screen.getByTestId("sibling").textContent).toBe("healthy sibling");
    // inline error panel rendered with a humane message + a retry affordance:
    expect(screen.getByRole("button", { name: /重试|retry/i })).toBeTruthy();
    expect(screen.queryByText(/chart runtime exploded|Cannot read|undefined/i)).toBeNull();
    spy.mockRestore();
  });

  it("renders children unchanged when nothing throws (transparent on happy path)", () => {
    render(
      <I18nProvider i18n={i18n}>
        <BlockErrorBoundary blockLabel="用量图表">
          <span data-testid="ok">content</span>
        </BlockErrorBoundary>
      </I18nProvider>,
    );
    expect(screen.getByTestId("ok").textContent).toBe("content");
  });
});
