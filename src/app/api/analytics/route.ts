import { NextRequest, NextResponse } from "next/server";
import { supabase, fetchAllRows } from "@/lib/supabase";
import { sellThrough, weeksOfStock } from "@/lib/analytics";

export const runtime = "nodejs";
export const revalidate = 0;
export const maxDuration = 60;

// Bir perakendeci için SKU-level intelligence:
//   - stockout riski (kaç hafta yeter)
//   - sell-through (devir verimliliği)
//   - momentum (son haftalardaki yön)
export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const retailer = searchParams.get("retailer");
  if (!retailer) return NextResponse.json({ error: "retailer gerekli" }, { status: 400 });

  try {
    // Son 6 haftayı al (momentum + stockout için)
    const { data: weeks } = await supabase
      .from("weekly_summary").select("week_start")
      .eq("retailer", retailer).order("week_start", { ascending: false }).limit(6);
    if (!weeks?.length) return NextResponse.json({ skus: [], latest: null });

    const weekList = weeks.map((w) => w.week_start).reverse();
    const latest = weekList[weekList.length - 1];

    const rows = await fetchAllRows((from, to) =>
      supabase
        .from("fact_weekly")
        .select("sku_name, barkod, week_start, sales_qty, stock_qty, sales_value")
        .eq("retailer", retailer)
        .in("week_start", weekList)
        .order("id")
        .range(from, to)
    );

    // SKU bazında, hafta bazında topla
    type Agg = { sales: Map<string, number>; stock: Map<string, number>; value: number; barkod: string | null };
    const skuMap = new Map<string, Agg>();
    for (const r of rows) {
      let e = skuMap.get(r.sku_name);
      if (!e) { e = { sales: new Map(), stock: new Map(), value: 0, barkod: r.barkod }; skuMap.set(r.sku_name, e); }
      e.sales.set(r.week_start, (e.sales.get(r.week_start) ?? 0) + Number(r.sales_qty));
      e.stock.set(r.week_start, (e.stock.get(r.week_start) ?? 0) + Number(r.stock_qty));
      if (r.week_start === latest) e.value += Number(r.sales_value ?? 0);
    }

    const skus = [...skuMap.entries()].map(([sku_name, a]) => {
      const salesSeries = weekList.map((w) => a.sales.get(w) ?? 0);
      const latestStock = a.stock.get(latest) ?? 0;
      const latestSales = a.sales.get(latest) ?? 0;
      // Son 4 haftanın ort. satış hızı (stockout için)
      const recent = salesSeries.slice(-4).filter((_, i, arr) => i < arr.length);
      const avgSales = recent.length ? recent.reduce((x, y) => x + y, 0) / recent.length : 0;
      const wos = weeksOfStock(latestStock, avgSales);
      const st = sellThrough(latestSales, latestStock);
      const slope = salesSeries.length >= 2
        ? salesSeries[salesSeries.length - 1] - salesSeries[salesSeries.length - 2] : 0;
      return {
        sku_name,
        barkod: a.barkod,
        sales_qty: latestSales,
        stock_qty: latestStock,
        sales_value: a.value || null,
        sell_through: st,
        weeks_of_stock: wos,
        spark: salesSeries,
        trend: slope,
      };
    });

    return NextResponse.json({ latest, weeks: weekList, skus });
  } catch (e: any) {
    console.error("analytics hatası:", e);
    return NextResponse.json({ error: "Sunucu hatası" }, { status: 500 });
  }
}
