import { useEffect, useState } from "react";
import { ChartPalette } from "@cloudflare/kumo/components/chart";

export function isPortalDarkMode(): boolean {
  return typeof document !== "undefined" && document.documentElement.dataset.mode === "dark";
}

export function usePortalDarkMode(): boolean {
  const [dark, setDark] = useState(isPortalDarkMode);
  useEffect(() => {
    if (typeof document === "undefined" || typeof MutationObserver === "undefined") return;
    const o = new MutationObserver(() => setDark(isPortalDarkMode()));
    o.observe(document.documentElement, { attributes: true, attributeFilter: ["data-mode"] });
    return () => o.disconnect();
  }, []);
  return dark;
}

/** Axis/grid/text colors driven by Kumo's light/dark surfaces. */
export function kumoAxisColors(dark: boolean) {
  return {
    axisLine: dark ? "#3f3f46" : "#e7e5e4",
    splitLine: dark ? "#27272a" : "#f0eeec",
    label: dark ? "#a1a1aa" : "#78716c",
  };
}

export function categorical(i: number, dark: boolean): string {
  return ChartPalette.categorical(i, dark);
}

export const TOOLTIP_STYLE = (dark: boolean) => ({
  backgroundColor: dark ? "#1c1917" : "#ffffff",
  borderColor: dark ? "#3f3f46" : "#e7e5e4",
  textStyle: { color: dark ? "#e7e5e4" : "#1c1917", fontFamily: "ui-monospace, monospace" },
});
