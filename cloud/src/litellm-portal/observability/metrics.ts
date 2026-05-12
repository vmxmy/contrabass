import type { LiteLLMPortalEnv } from "../types";

export type MetricPoint = {
  route: string;
  status: number;
  latencyMs: number;
  upstreamMs: number;
  role: string;
  cacheHit: boolean;
};

export function recordMetric(env: LiteLLMPortalEnv, point: MetricPoint): void {
  if (!env.METRICS_AE) {
    return;
  }
  env.METRICS_AE.writeDataPoint({
    blobs: [point.route, String(point.status), point.role],
    doubles: [point.latencyMs, point.upstreamMs],
    indexes: [point.cacheHit ? "1" : "0"],
  });
}
