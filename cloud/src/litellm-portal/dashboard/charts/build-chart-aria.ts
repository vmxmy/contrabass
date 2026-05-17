/**
 * Pure, SSR-safe, macro-free chart aria-description builder (Phase-3 §A.1).
 * The localized template is built by the t`` macro in the dashboard (already
 * inside I18nProvider) and injected into TrendChart, keeping the chart island
 * macro-free and SSR/hydration deterministic. Unknown placeholders are left
 * literal (never throws).
 */
export function buildChartAriaDescription(
  v: { windowLabel: string; points: number; grain: string },
  opts: { template: string },
): string {
  return opts.template
    .replace("{window}", v.windowLabel)
    .replace("{points}", String(v.points))
    .replace("{grain}", v.grain);
}
