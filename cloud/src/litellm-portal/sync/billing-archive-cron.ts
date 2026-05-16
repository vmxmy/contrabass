import { litellmFetch } from "../litellm";
import { readJson } from "../utils";
import { parseDailyActivity } from "../usage/daily-activity";
import type { LiteLLMPortalEnv } from "../types";

/** Minimal IndexDO surface we need. Inline to avoid pulling cloudflare:workers into tests. */
type IndexDOStub = {
  listTeams(): Promise<Array<{ id: string; alias: string }>>;
};

/** Result summary of one monthly billing-archive cron run. */
export type MonthlyBillingArchiveResult = {
  yearMonth: string;
  teams: number;
  objectKey: string;
  written: boolean;
  errors: Array<{ teamId: string; reason: string }>;
};

const CSV_HEADER =
  "team_id,team_alias,period_start,period_end,total_spend_usd,total_requests,total_tokens,top_model,top_model_spend_usd,generated_at";

/** RFC-4180: quote a field iff it contains a comma, quote, CR or LF;
 *  internal double-quotes are doubled. */
function csvField(value: string): string {
  if (/[",\r\n]/u.test(value)) {
    return `"${value.replace(/"/gu, '""')}"`;
  }
  return value;
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

/** Run the monthly per-team billing archive.
 *
 *  Computes the PREVIOUS full UTC month relative to `now`, fetches each team's
 *  /team/daily/activity for that window, aggregates spend/requests/tokens and
 *  the top model by spend, and writes one RFC-4180 CSV (one row per team,
 *  including zero-spend teams) to R2 at billing/YYYY/MM.csv.
 *
 *  Idempotent: a pre-existing object for the period is left untouched.
 *  Per-team failures do NOT abort the loop — the error is pushed to the result
 *  errors array and that team is emitted with zero totals.
 *
 *  Defensive: returns gracefully if bindings are unset. */
export async function runMonthlyBillingArchive(
  env: LiteLLMPortalEnv,
  now = new Date(),
): Promise<MonthlyBillingArchiveResult> {
  const prevMonthEnd = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 0));
  const year = prevMonthEnd.getUTCFullYear();
  const month = prevMonthEnd.getUTCMonth() + 1;
  const yearMonth = `${year}-${pad2(month)}`;
  const periodStart = `${yearMonth}-01`;
  const periodEnd = `${yearMonth}-${pad2(prevMonthEnd.getUTCDate())}`;
  const objectKey = `billing/${year}/${pad2(month)}.csv`;

  if (!env.BILLING_ARCHIVE_R2) {
    return {
      yearMonth,
      teams: 0,
      objectKey,
      written: false,
      errors: [{ teamId: "(global)", reason: "BILLING_ARCHIVE_R2 binding not configured" }],
    };
  }
  if (!env.INDEX_DO) {
    return {
      yearMonth,
      teams: 0,
      objectKey,
      written: false,
      errors: [{ teamId: "(global)", reason: "INDEX_DO binding not configured" }],
    };
  }

  if (await env.BILLING_ARCHIVE_R2.head(objectKey)) {
    return { yearMonth, teams: 0, objectKey, written: false, errors: [] };
  }

  const idxStub = env.INDEX_DO.get(env.INDEX_DO.idFromName("index")) as unknown as IndexDOStub;
  const teams = await idxStub.listTeams();
  const errors: Array<{ teamId: string; reason: string }> = [];
  const generatedAt = new Date().toISOString();
  const lines = [CSV_HEADER];

  for (const team of teams) {
    let totalSpend = 0;
    let totalRequests = 0;
    let totalTokens = 0;
    let topModel = "";
    let topModelSpend = 0;

    try {
      const response = await litellmFetch(
        env,
        `/team/daily/activity?team_ids=${encodeURIComponent(team.id)}&start_date=${periodStart}&end_date=${periodEnd}&page_size=1000`,
      );
      if (!response.ok) {
        throw new Error(`litellm /team/daily/activity ${response.status}`);
      }
      const body = await readJson(response);
      const rows = parseDailyActivity(body);

      const spendByModel = new Map<string, number>();
      for (const row of rows) {
        totalSpend += row.spend;
        totalRequests += row.requests;
        totalTokens += row.totalTokens;
        for (const m of row.models) {
          spendByModel.set(m.model, (spendByModel.get(m.model) ?? 0) + m.spend);
        }
      }
      for (const [model, spend] of spendByModel) {
        if (spend > topModelSpend) {
          topModel = model;
          topModelSpend = spend;
        }
      }
    } catch (err) {
      const reason = err instanceof Error ? err.message.slice(0, 200) : String(err).slice(0, 200);
      errors.push({ teamId: team.id, reason });
      totalSpend = 0;
      totalRequests = 0;
      totalTokens = 0;
      topModel = "";
      topModelSpend = 0;
    }

    lines.push(
      [
        csvField(team.id),
        csvField(team.alias ?? ""),
        periodStart,
        periodEnd,
        totalSpend.toFixed(6),
        String(Math.trunc(totalRequests)),
        String(Math.trunc(totalTokens)),
        csvField(topModel),
        topModelSpend.toFixed(6),
        generatedAt,
      ].join(","),
    );
  }

  const csv = lines.join("\n");
  await env.BILLING_ARCHIVE_R2.put(objectKey, csv, {
    httpMetadata: { contentType: "text/csv" },
  });

  return { yearMonth, teams: teams.length, objectKey, written: true, errors };
}
