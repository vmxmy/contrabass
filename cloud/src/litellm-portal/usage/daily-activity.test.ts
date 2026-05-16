import { describe, it, expect } from "vitest";
import { parseDailyActivity } from "./daily-activity";

const body = { results: [
  { date: "2026-05-16", metrics: { spend: 21.5, total_tokens: 1000, api_requests: 215 },
    breakdown: { models: { "glm-5.1": { metrics: { spend: 1.5, total_tokens: 100, api_requests: 5 } },
                           "kimi":   { metrics: { spend: 20,  total_tokens: 900, api_requests: 210 } } } } },
  { date: "2026-05-15", metrics: { spend: 0, total_tokens: 0, api_requests: 0 }, breakdown: { models: {} } },
]};

describe("parseDailyActivity", () => {
  it("maps results to typed per-day rows + model slices", () => {
    const rows = parseDailyActivity(body);
    expect(rows).toEqual([
      { date: "2026-05-15", spend: 0, requests: 0, totalTokens: 0, models: [] },
      { date: "2026-05-16", spend: 21.5, requests: 215, totalTokens: 1000, models: [
        { model: "glm-5.1", spend: 1.5, requests: 5, totalTokens: 100 },
        { model: "kimi", spend: 20, requests: 210, totalTokens: 900 },
      ] },
    ]); // sorted ascending by date
  });
  it("returns [] for junk / missing results", () => {
    expect(parseDailyActivity({})).toEqual([]);
    expect(parseDailyActivity(null)).toEqual([]);
    expect(parseDailyActivity({ results: "x" })).toEqual([]);
  });
  it("handles missing metrics/breakdown fields with safe defaults", () => {
    const partial = { results: [
      { date: "2026-05-16" },
      { date: "2026-05-17", metrics: { spend: 5 }, breakdown: null },
      { date: "2026-05-18", metrics: null, breakdown: { models: { "bad": { no_metrics: true } } } },
      null,
    ]};
    const rows = parseDailyActivity(partial);
    expect(rows).toEqual([
      { date: "2026-05-16", spend: 0, requests: 0, totalTokens: 0, models: [] },
      { date: "2026-05-17", spend: 5, requests: 0, totalTokens: 0, models: [] },
      { date: "2026-05-18", spend: 0, requests: 0, totalTokens: 0, models: [] },
    ]);
  });
});
