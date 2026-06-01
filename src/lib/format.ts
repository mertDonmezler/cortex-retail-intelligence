// Client tarafı tipler ve yardımcılar
export interface WeeklySummary {
  retailer: string;
  week_start: string;
  week_end: string;
  sales_qty: number;
  sales_value: number | null;
  has_value: boolean;
  stock_qty: number;
  sku_count: number;
  store_count: number;
}

export interface Freshness {
  retailer: string;
  last_week: string | null;
  week_count: number;
  last_import: string | null;
}

export const RETAILERS = ["Nezih", "Huppaluppo", "Armağan", "Toyzz", "DR"];

export function fmtInt(n: number): string {
  return Math.round(n).toLocaleString("tr-TR");
}
export function fmtMoney(n: number | null): string {
  if (n == null) return "₺—";
  return "₺" + Math.round(n).toLocaleString("tr-TR");
}
export function fmtPct(p: number | null): string {
  if (p == null) return "—";
  return (p >= 0 ? "+" : "") + p.toFixed(1) + "%";
}
export function fmtDate(d: string | null): string {
  if (!d) return "—";
  return new Date(d).toLocaleDateString("tr-TR", { day: "2-digit", month: "short", year: "numeric" });
}
export function fmtDateTime(d: string | null): string {
  if (!d) return "—";
  return new Date(d).toLocaleString("tr-TR", { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
}
