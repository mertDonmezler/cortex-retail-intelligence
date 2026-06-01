import { NextRequest, NextResponse } from "next/server";
import { supabase, fetchAllRows } from "@/lib/supabase";
import { comparePeriods, type FactRow } from "@/lib/compute";

export const runtime = "nodejs";
export const revalidate = 0;
export const maxDuration = 60;

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
  const weekA = searchParams.get("a");
  const weekB = searchParams.get("b");
  try {
    // Karşılaştırılabilir haftaları döndür (retailer verilmişse)
    if (retailer && (!weekA || !weekB)) {
      const { data: weeks } = await supabase.from("weekly_summary")
        .select("week_start").eq("retailer", retailer).order("week_start", { ascending: false });
      return NextResponse.json({ weeks: (weeks ?? []).map((w) => w.week_start) });
    }
    if (!retailer || !weekA || !weekB) {
      return NextResponse.json({ error: "retailer, a, b gerekli" }, { status: 400 });
    }
    const [aRows, bRows] = await Promise.all([
      fetchAllRows((from, to) =>
        supabase.from("fact_weekly")
          .select("retailer, week_start, store, sku_name, barkod, sales_qty, sales_value, stock_qty")
          .eq("retailer", retailer).eq("week_start", weekA).order("id").range(from, to)
      ),
      fetchAllRows((from, to) =>
        supabase.from("fact_weekly")
          .select("retailer, week_start, store, sku_name, barkod, sales_qty, sales_value, stock_qty")
          .eq("retailer", retailer).eq("week_start", weekB).order("id").range(from, to)
      ),
    ]);
    const result = comparePeriods(toFacts(aRows), toFacts(bRows));
    return NextResponse.json({ a: weekA, b: weekB, ...result });
  } catch (e: any) {
    console.error("compare hatası:", e);
    return NextResponse.json({ error: "Sunucu hatası" }, { status: 500 });
  }
}
