const numberFormatter = new Intl.NumberFormat("zh-CN");

/** Format a numeric value as a USD dollar amount with two decimal places. */
export function fmt(value: unknown): string {
  return "$" + Number(value || 0).toFixed(2);
}

/** Format a numeric value as a locale integer string. */
export function fmtInt(value: unknown): string {
  return numberFormatter.format(Number(value || 0));
}
