import { NextRequest, NextResponse } from "next/server";
import { supabase, fetchAllRows } from "@/lib/supabase";
import { storePerformance, type FactRow } from "@/lib/compute";

export const runtime = "nodejs";
export const revalidate = 0;
export const maxDuration = 60;

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const retailer = searchParams.get("retailer");
  const week = searchParams.get("week");
  if (!retailer) return NextResponse.json({ error: "retailer gerekli" }, { status: 400 });
  try {
    const { data: weeks } = await supabase.from("weekly_summary")
      .select("week_start, store_count").eq("retailer", retailer)
      .gt("store_count", 0).order("week_start", { ascending: false });
    if (!weeks?.length) {
      return NextResponse.json({ stores: [], weeks: [], week: null, storeLevel: false });
    }
    const wk = week && weeks.some((w) => w.week_start === week) ? week : weeks[0].week_start;
    const rows = await fetchAllRows((from, to) =>
      supabase.from("fact_weekly")
        .select("retailer, week_start, store, sku_name, barkod, sales_qty, sales_value, stock_qty")
        .eq("retailer", retailer).eq("week_start", wk).order("id").range(from, to)
    );
    const facts: FactRow[] = rows.map((r) => ({
      retailer: r.retailer, week_start: r.week_start, store: r.store ?? null,
      sku_name: r.sku_name, barkod: r.barkod ?? null,
      sales_qty: Number(r.sales_qty),
      sales_value: r.sales_value != null ? Number(r.sales_value) : null,
      stock_qty: Number(r.stock_qty),
    }));
    const stores = storePerformance(facts);
    return NextResponse.json({ stores, week: wk, storeLevel: true, weeks: weeks.map((w) => w.week_start) });
  } catch (e: any) {
    console.error("stores rotası hatası:", e);
    return NextResponse.json({ error: "Sunucu hatası" }, { status: 500 });
  }
}
