import { NextRequest, NextResponse } from "next/server";
import { supabase, fetchAllRows } from "@/lib/supabase";
import { computeStockAlerts, type FactRow } from "@/lib/compute";

export const runtime = "nodejs";
export const revalidate = 0;

function toFacts(rows: any[]): FactRow[] {
  return (rows ?? []).map((r) => ({
    retailer: r.retailer, week_start: r.week_start, store: r.store ?? null,
    sku_name: r.sku_name, barkod: r.barkod ?? null,
    sales_qty: Number(r.sales_qty),
    sales_value: r.sales_value != null ? Number(r.sales_value) : null,
    stock_qty: Number(r.stock_qty),
  }));
}

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const retailer = searchParams.get("retailer");
  const critical = Number(searchParams.get("critical") ?? 10);
  const drop = Number(searchParams.get("drop") ?? 30);
  if (!retailer) return NextResponse.json({ error: "retailer gerekli" }, { status: 400 });
  try {
    const { data: weeks } = await supabase
      .from("weekly_summary").select("week_start")
      .eq("retailer", retailer).order("week_start", { ascending: false }).limit(2);
    if (!weeks?.length) return NextResponse.json({ latest: null, critical: [], declining: [], hasPrev: false });
    const latest = weeks[0].week_start;
    const prev = weeks[1]?.week_start ?? null;

    const [latestRows, prevRows] = await Promise.all([
      fetchAllRows((from, to) =>
        supabase.from("fact_weekly")
          .select("retailer, week_start, store, sku_name, barkod, sales_qty, sales_value, stock_qty")
          .eq("retailer", retailer).eq("week_start", latest).order("id").range(from, to)
      ),
      prev ? fetchAllRows((from, to) =>
        supabase.from("fact_weekly")
          .select("retailer, week_start, store, sku_name, barkod, sales_qty, sales_value, stock_qty")
          .eq("retailer", retailer).eq("week_start", prev).order("id").range(from, to)
      ) : Promise.resolve([]),
    ]);

    const { critical: crit, declining } = computeStockAlerts(
      toFacts(latestRows), toFacts(prevRows), critical, drop
    );
    return NextResponse.json({ latest, hasPrev: !!prev, critical: crit, declining });
  } catch (e: any) {
    console.error("stock-alerts hatası:", e);
    return NextResponse.json({ error: "Sunucu hatası" }, { status: 500 });
  }
}
