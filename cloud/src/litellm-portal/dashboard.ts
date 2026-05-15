import {
  DASHBOARD_WINDOWS,
  WINDOW_SPEC,
  type DashboardWindow,
  type DashboardGrain,
  type DashboardScope,
  type UsageScope,
} from "./dashboard-schemas";

export type ParsedDashboardRequest =
  | { ok: true; window: DashboardWindow; grain: DashboardGrain; grainFallback: boolean }
  | { ok: false; body: { error: string; allowed: string[] } };

function isWindow(v: string): v is DashboardWindow {
  return (DASHBOARD_WINDOWS as readonly string[]).includes(v);
}

export function parseDashboardRequest(url: URL): ParsedDashboardRequest {
  const rawWindow = url.searchParams.get("window") ?? "30d";
  if (!isWindow(rawWindow)) {
    return { ok: false, body: { error: "unsupported_usage_window", allowed: [...DASHBOARD_WINDOWS] } };
  }
  const auto = WINDOW_SPEC[rawWindow].autoGrain;
  const rawGrain = url.searchParams.get("grain");
  if (rawGrain == null) {
    return { ok: true, window: rawWindow, grain: auto, grainFallback: false };
  }
  if (rawGrain === auto) {
    return { ok: true, window: rawWindow, grain: auto, grainFallback: false };
  }
  // Incompatible explicit grain → fall back to auto, flag it (non-blocking).
  return { ok: true, window: rawWindow, grain: auto, grainFallback: true };
}

export function toUsageScope(scope: DashboardScope): UsageScope {
  return scope.kind === "global" ? { kind: "global" } : { kind: "user", userId: scope.userId };
}
