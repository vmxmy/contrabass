import type { JsonValue } from "./types";

export function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function uniqueSorted(values: string[]): string[] {
  return [...new Set(values)].sort();
}

export function roundCurrency(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

export function nullableRoundCurrency(value: number | undefined): number | null {
  return value === undefined ? null : roundCurrency(value);
}

export function sumNumbers(values: number[]): number {
  return values.reduce((sum, value) => sum + value, 0);
}

export function sumDefinedNumbers(values: Array<number | null | undefined>): number | null {
  const numbers = values.filter((value): value is number => typeof value === "number");
  return numbers.length === 0 ? null : roundCurrency(sumNumbers(numbers));
}

export function dateOnly(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export function csv(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return undefined;
  }
}

export function securityHeaders(): Record<string, string> {
  return {
    "referrer-policy": "same-origin",
    "x-content-type-options": "nosniff",
  };
}

export function jsonResponse(body: Record<string, JsonValue>, status = 200): Response {
  return Response.json(body, { status, headers: securityHeaders() });
}

export function htmlResponse(html: string): Response {
  return new Response(html, {
    headers: {
      ...securityHeaders(),
      "content-type": "text/html; charset=utf-8",
    },
  });
}

export function cssResponse(css: string): Response {
  return new Response(css, {
    headers: {
      ...securityHeaders(),
      "cache-control": "public, max-age=300, must-revalidate",
      "content-type": "text/css; charset=utf-8",
    },
  });
}

export function javascriptResponse(js: string): Response {
  return new Response(js, {
    headers: {
      ...securityHeaders(),
      "cache-control": "public, max-age=300, must-revalidate",
      "content-type": "application/javascript; charset=utf-8",
    },
  });
}
