import { NextResponse } from "next/server";
import { supabase, fetchAllRows } from "@/lib/supabase";
import { groupDeadStock, type CoverageItem } from "@/lib/compute";

export const runtime = "nodejs";
export const revalidate = 0;
export const maxDuration = 60;

// Ağ geneli ürün coverage'ı (product_coverage matview) → ürün bazında firmalar
// arası birleştirilmiş liste. Filtreleme/eşik istemci tarafında (liste küçük).
export async function GET() {
  try {
    const rows = await fetchAllRows<any>((from, to) =>
      supabase.from("product_coverage")
        .select("retailer, product_key, barkod, sku_name, avg_weekly, last_stock, coverage_weeks")
        .order("product_key").order("retailer").range(from, to)
    );
    const items: CoverageItem[] = rows.map((r) => ({
      retailer: r.retailer,
      product_key: r.product_key,
      barkod: r.barkod ?? null,
      sku_name: r.sku_name ?? "",
      avg_weekly: Number(r.avg_weekly ?? 0),
      last_stock: Number(r.last_stock ?? 0),
      coverage_weeks: r.coverage_weeks == null ? null : Number(r.coverage_weeks),
    }));
    const products = groupDeadStock(items);
    return NextResponse.json({ products, count: products.length });
  } catch (e: any) {
    console.error("dead-stock hatası:", e);
    return NextResponse.json({ error: "Sunucu hatası" }, { status: 500 });
  }
}
