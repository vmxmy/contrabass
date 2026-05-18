const numberFormatter = new Intl.NumberFormat("zh-CN");

/** Format a numeric value as a USD dollar amount with two decimal places. */
export function fmt(value: unknown): string {
  return "$" + Number(value || 0).toFixed(2);
}

/** Format a numeric value as a locale integer string. */
export function fmtInt(value: unknown): string {
  return numberFormatter.format(Number(value || 0));
}

/**
 * Format a large numeric value in compact notation (e.g. 1.4B, 138万).
 * Falls back to fmtInt for smaller numbers.
 */
export function fmtCompact(value: unknown): string {
  const num = Number(value || 0);
  if (num === 0) return "0";
  if (num >= 1_000_000_000) return (num / 1_000_000_000).toFixed(1).replace(/\.0$/, "") + "B";
  if (num >= 10_000_000) return (num / 10_000_000).toFixed(1).replace(/\.0$/, "") + "千万";
  if (num >= 1_000_000) return (num / 1_000_000).toFixed(1).replace(/\.0$/, "") + "M";
  if (num >= 10_000) return (num / 10_000).toFixed(1).replace(/\.0$/, "") + "万";
  if (num >= 1_000) return (num / 1_000).toFixed(1).replace(/\.0$/, "") + "k";
  return String(num);
}
