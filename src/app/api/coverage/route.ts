import { NextRequest, NextResponse } from "next/server";
import { supabase, fetchAllRows } from "@/lib/supabase";
import { computeCoverage, summarizeCoverage, type CoverageRow } from "@/lib/compute";

export const runtime = "nodejs";
export const revalidate = 0;
export const maxDuration = 60;

// SKU coverage (stok süresi). retailer zorunlu. store verilirse o mağaza özelinde
// anlık hesap; verilmezse firma geneli (sku_coverage matview'ından).
export async function GET(req: NextRequest) {
  const sp = new URL(req.url).searchParams;
  const retailer = sp.get("retailer");
  const store = sp.get("store") || null;
  if (!retailer) return NextResponse.json({ error: "retailer gerekli" }, { status: 400 });

  try {
    let rows: CoverageRow[];

    if (store) {
      // Mağaza bazlı: tek mağazanın tüm haftalık satırları (sınırlı) → anlık coverage
      const facts = await fetchAllRows<{ sku_name: string; week_start: string; sales_qty: number; stock_qty: number }>(
        (from, to) =>
          supabase.from("fact_weekly")
            .select("sku_name, week_start, sales_qty, stock_qty")
            .eq("retailer", retailer).eq("store", store).order("id").range(from, to)
      );
      rows = computeCoverage(facts);
    } else {
      // Firma geneli: önceden hesaplanmış matview
      const { data, error } = await supabase
        .from("sku_coverage")
        .select("sku_name, avg_weekly, last_stock, coverage_weeks")
        .eq("retailer", retailer);
      if (error) throw error;
      rows = (data ?? []).map((r) => ({
        sku_name: r.sku_name,
        avg_weekly: Number(r.avg_weekly),
        last_stock: Number(r.last_stock),
        coverage: r.coverage_weeks == null ? null : Number(r.coverage_weeks),
      }));
    }

    const { skus, summary } = summarizeCoverage(rows);
    return NextResponse.json({ scope: store ? "magaza" : "firma", retailer, store, summary, skus });
  } catch (e: any) {
    console.error("coverage hatası:", e);
    return NextResponse.json({ error: "Sunucu hatası" }, { status: 500 });
  }
}
