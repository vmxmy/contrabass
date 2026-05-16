import { isRecord } from "../utils";
import { numberLikeField, firstString } from "../litellm";

export type DailyRow = {
  date: string;
  spend: number;
  requests: number;
  totalTokens: number;
  models: Array<{ model: string; spend: number; totalTokens: number; requests: number }>;
};

function metrics(rec: Record<string, unknown>) {
  return {
    spend: numberLikeField(rec, "spend") ?? 0,
    requests: Math.trunc(numberLikeField(rec, "api_requests") ?? 0),
    totalTokens: Math.trunc(numberLikeField(rec, "total_tokens") ?? 0),
  };
}

/** Pure: LiteLLM daily/activity body → per-day rows, ascending by date. */
export function parseDailyActivity(body: unknown): DailyRow[] {
  if (!isRecord(body) || !Array.isArray(body.results)) return [];
  const rows: DailyRow[] = [];
  for (const day of body.results) {
    if (!isRecord(day)) continue;
    const date = firstString(day, ["date"]);
    if (date === undefined) continue;
    const m = isRecord(day.metrics) ? metrics(day.metrics) : { spend: 0, requests: 0, totalTokens: 0 };
    const models: DailyRow["models"] = [];
    const bm = isRecord(day.breakdown) && isRecord(day.breakdown.models) ? day.breakdown.models : {};
    for (const [model, entry] of Object.entries(bm)) {
      if (!isRecord(entry) || !isRecord(entry.metrics)) continue;
      const em = metrics(entry.metrics);
      models.push({ model, spend: em.spend, totalTokens: em.totalTokens, requests: em.requests });
    }
    rows.push({ date, ...m, models });
  }
  return rows.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}
