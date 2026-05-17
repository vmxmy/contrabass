/**
 * @vitest-environment happy-dom
 */
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, fireEvent } from "@testing-library/react";
import { I18nProvider } from "@lingui/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { setupI18n } from "../i18n/setup";
import { DensityToggle } from "./density-toggle";

const i18n = setupI18n("zh-CN");
afterEach(cleanup);

function wrap(ui: React.ReactElement) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <I18nProvider i18n={i18n}>{ui}</I18nProvider>
    </QueryClientProvider>,
  );
}

describe("§F.1 DensityToggle (V2.0 §1.2)", () => {
  it("renders the current density and a labelled, keyboard-reachable control", () => {
    wrap(<DensityToggle current="compact" onChange={() => {}} />);
    const btn = screen.getByRole("button", { name: /密度|density|紧凑|comfortable/i });
    expect(btn).toBeTruthy();
    expect(btn.getAttribute("aria-pressed") ?? btn.getAttribute("aria-label")).toBeTruthy();
  });

  it("invokes onChange with the toggled density on activation", () => {
    const onChange = vi.fn();
    wrap(<DensityToggle current="compact" onChange={onChange} />);
    fireEvent.click(screen.getByRole("button", { name: /密度|density|紧凑|comfortable/i }));
    expect(onChange).toHaveBeenCalledWith("comfortable");
  });
});
