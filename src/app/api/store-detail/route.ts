import { NextRequest, NextResponse } from "next/server";
import { supabase, fetchAllRows } from "@/lib/supabase";
import { netFactor } from "@/lib/margins";

export const runtime = "nodejs";
export const revalidate = 0;
export const maxDuration = 60;

// Bir mağazanın (retailer, week, store) SKU kırılımı: o şubede ne satıldı.
export async function GET(req: NextRequest) {
  const sp = new URL(req.url).searchParams;
  const retailer = sp.get("retailer");
  const week = sp.get("week");
  const store = sp.get("store");
  if (!retailer || !week || !store) {
    return NextResponse.json({ error: "retailer, week, store gerekli" }, { status: 400 });
  }
  try {
    const rows = await fetchAllRows((from, to) =>
      supabase.from("fact_weekly")
        .select("sku_name, barkod, sales_qty, sales_value, stock_qty")
        .eq("retailer", retailer).eq("week_start", week).eq("store", store)
        .order("id").range(from, to)
    );
    const nf = netFactor(retailer); // ciro net kazanca çevrilir
    const agg = new Map<string, { sku_name: string; barkod: string | null; qty: number; val: number; stock: number }>();
    for (const r of rows) {
      const e = agg.get(r.sku_name) ?? { sku_name: r.sku_name, barkod: r.barkod ?? null, qty: 0, val: 0, stock: 0 };
      e.qty += Number(r.sales_qty);
      e.val += Number(r.sales_value ?? 0) * nf;
      e.stock += Number(r.stock_qty);
      if (!e.barkod && r.barkod) e.barkod = r.barkod;
      agg.set(r.sku_name, e);
    }
    const skus = [...agg.values()]
      .map((e) => ({ sku_name: e.sku_name, barkod: e.barkod, sales_qty: e.qty, sales_value: e.val, stock_qty: e.stock }))
      .sort((a, b) => b.sales_qty - a.sales_qty);
    return NextResponse.json({ retailer, week, store, skus });
  } catch (e: any) {
    console.error("store-detail hatası:", e);
    return NextResponse.json({ error: "Sunucu hatası" }, { status: 500 });
  }
}
