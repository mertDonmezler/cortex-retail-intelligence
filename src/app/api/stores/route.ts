import { NextRequest, NextResponse } from "next/server";
import { supabase, fetchAllRows } from "@/lib/supabase";
import { netFactor } from "@/lib/margins";
import { STORE_COLS } from "@/lib/rows";

export const runtime = "nodejs";
export const revalidate = 0;
export const maxDuration = 60;

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const retailer = searchParams.get("retailer");
  const week = searchParams.get("week");
  // retailer verilmezse: keşif modu — mağaza-bazlı veri sağlayan perakendeciler
  // ve her birinin EN GÜNCEL store haftası. Sayfa bununla default'unu seçer
  // (hardcode yerine; bir perakendeci store göndermeyi bıraksa/başlasa kendini onarır).
  if (!retailer) {
    try {
      const { data } = await supabase.from("weekly_summary")
        .select("retailer, week_start").gt("store_count", 0)
        .order("week_start", { ascending: false });
      const latest = new Map<string, string>();
      for (const r of data ?? []) if (!latest.has(r.retailer)) latest.set(r.retailer, r.week_start);
      const retailers = [...latest.entries()]
        .map(([retailer, week]) => ({ retailer, week }))
        .sort((a, b) => (a.week < b.week ? 1 : -1)); // en taze hafta önce
      return NextResponse.json({ discovery: true, retailers, default: retailers[0]?.retailer ?? null });
    } catch (e: any) {
      console.error("stores keşif hatası:", e);
      return NextResponse.json({ discovery: true, retailers: [], default: null });
    }
  }
  try {
    const { data: weeks } = await supabase.from("weekly_summary")
      .select("week_start, store_count").eq("retailer", retailer)
      .gt("store_count", 0).order("week_start", { ascending: false });
    if (!weeks?.length) {
      return NextResponse.json({ stores: [], weeks: [], week: null, storeLevel: false });
    }
    const wk = week && weeks.some((w) => w.week_start === week) ? week : weeks[0].week_start;
    const rows = await fetchAllRows<any>((from, to) =>
      supabase.from("store_weekly")
        .select(STORE_COLS)
        .eq("retailer", retailer).eq("week_start", wk).order("store").range(from, to)
    );
    const nf = netFactor(retailer); // ciro net kazanca
    const stores = rows
      .map((r) => ({
        store: r.store, sales_qty: Number(r.sales_qty), sales_value: Number(r.sales_value) * nf,
        stock_qty: Number(r.stock_qty), sku_count: Number(r.sku_count),
      }))
      .sort((a, b) => b.sales_qty - a.sales_qty);
    return NextResponse.json({ stores, week: wk, storeLevel: true, weeks: weeks.map((w) => w.week_start) });
  } catch (e: any) {
    console.error("stores rotası hatası:", e);
    return NextResponse.json({ error: "Sunucu hatası" }, { status: 500 });
  }
}
