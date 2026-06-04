// Supabase satır → tip dönüşümü + ortak SELECT kolonları (tek kaynak).
// Tüm API route'lar fact_weekly / weekly_summary okurken buradaki helper'ları
// kullanır; böylece FactRow/SummaryRow şeması ve kolon listesi tek yerde yönetilir.
import type { FactRow, SummaryRow } from "./compute";
import { netRows } from "./margins";

// fact_weekly'den çekilen standart kolon kümesi.
export const FACT_COLS =
  "retailer, week_start, store, sku_name, barkod, sales_qty, sales_value, stock_qty";

// Ham DB satırları → FactRow[] (ciro BRÜT — net için toNetFacts kullan).
export function toFacts(rows: any[]): FactRow[] {
  return (rows ?? []).map((r) => ({
    retailer: r.retailer,
    week_start: r.week_start,
    store: r.store ?? null,
    sku_name: r.sku_name,
    barkod: r.barkod ?? null,
    sales_qty: Number(r.sales_qty),
    sales_value: r.sales_value != null ? Number(r.sales_value) : null,
    stock_qty: Number(r.stock_qty),
  }));
}

// Ciro net kazanca çevrilmiş fact satırları (margins köprüsü).
export function toNetFacts(rows: any[]): FactRow[] {
  return netRows(toFacts(rows));
}

// weekly_summary satırları → SummaryRow[] (ciro BRÜT).
export function toSummary(rows: any[]): SummaryRow[] {
  return (rows ?? []).map((s) => ({
    retailer: s.retailer,
    week_start: s.week_start,
    sales_qty: Number(s.sales_qty),
    sales_value: s.sales_value != null ? Number(s.sales_value) : null,
    has_value: !!s.has_value,
    stock_qty: Number(s.stock_qty),
    sku_count: Number(s.sku_count ?? 0),
    store_count: Number(s.store_count ?? 0),
  }));
}

// Ciro net kazanca çevrilmiş özet satırları.
export function toNetSummary(rows: any[]): SummaryRow[] {
  return netRows(toSummary(rows));
}
