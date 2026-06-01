// Unified veri şeması — tüm normalizer'lar bu tipi döndürür.
// Python tarafındaki UNIFIED_COLUMNS'un TypeScript karşılığı.

export type Retailer = "Nezih" | "Huppaluppo" | "Armağan" | "Toyzz" | "DR";

export const RETAILERS: Retailer[] = ["Nezih", "Huppaluppo", "Armağan", "Toyzz", "DR"];

export interface UnifiedRow {
  retailer: Retailer;
  week_start: string;   // ISO date "YYYY-MM-DD"
  week_end: string;     // ISO date
  store: string | null;
  sku_name: string;
  sku_id: string | null;
  barkod: string | null;
  price: number | null;
  sales_qty: number;
  sales_value: number | null;
  stock_qty: number;
  source_file: string;
}

export interface NormalizeResult {
  rows: UnifiedRow[];
  weekStart: string;
  weekEnd: string;
}
