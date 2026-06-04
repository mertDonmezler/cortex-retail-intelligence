// Client tarafı tipler ve yardımcılar
import { RETAILERS as CANON_RETAILERS } from "@/lib/normalizers/types";
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

// Perakendeci listesi + renk kimliği tek kaynaktan (eskiden 3+7 dosyada kopyaydı).
export const RETAILERS: string[] = CANON_RETAILERS;
export const RETAILER_COLORS: Record<string, string> = {
  Nezih: "#1FF80B", Huppaluppo: "#0bd1f8", Armağan: "#f8b00b", Toyzz: "#f80b8a", DR: "#9b6bff",
};
export function colorOf(retailer: string): string {
  return RETAILER_COLORS[retailer] ?? "#7d927d";
}

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
