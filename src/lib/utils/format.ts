// Money + date formatting. Same conventions as ledger-core and recon:
// 2 decimals, comma thousands, parens for negatives.

import type { Decimal } from "decimal.js";

export function formatMoney(value: Decimal | string | number | null | undefined): string {
  if (value === null || value === undefined) return "—";
  const num =
    typeof value === "object" && "toNumber" in value ? (value as Decimal).toNumber() : Number(value);
  if (Number.isNaN(num)) return "—";
  const abs = Math.abs(num).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return num < 0 ? `(${abs})` : abs;
}

export function formatPercent(value: Decimal | string | number | null | undefined): string {
  if (value === null || value === undefined) return "—";
  const num =
    typeof value === "object" && "toNumber" in value ? (value as Decimal).toNumber() : Number(value);
  if (Number.isNaN(num)) return "—";
  return `${num.toFixed(2)}%`;
}

export function formatDate(d: Date | string | null | undefined): string {
  if (!d) return "—";
  const date = typeof d === "string" ? new Date(d) : d;
  return date.toISOString().slice(0, 10);
}

export function formatMonth(d: Date | string | null | undefined): string {
  if (!d) return "—";
  const date = typeof d === "string" ? new Date(d) : d;
  return date.toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    timeZone: "UTC",
  });
}
