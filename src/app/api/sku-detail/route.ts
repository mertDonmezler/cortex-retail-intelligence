import { NextRequest, NextResponse } from "next/server";
import { supabase, fetchAllRows } from "@/lib/supabase";
import { netFactor } from "@/lib/margins";

export const runtime = "nodejs";
export const revalidate = 0;
export const maxDuration = 60;

// Bir perakendeci + hafta için tüm SKU kırılımı (SKU bazında toplanmış).
export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const retailer = searchParams.get("retailer");
  const week = searchParams.get("week");
  if (!retailer) return NextResponse.json({ error: "retailer gerekli" }, { status: 400 });

  try {
    // Hafta verilmediyse en güncel haftayı bul
    let wk = week;
    if (!wk) {
      const { data: w } = await supabase.from("weekly_summary")
        .select("week_start").eq("retailer", retailer)
        .order("week_start", { ascending: false }).limit(1);
      wk = w?.[0]?.week_start ?? null;
    }
    if (!wk) return NextResponse.json({ week: null, skus: [], weeks: [] });

    const [rows, { data: allWeeks }] = await Promise.all([
      fetchAllRows((from, to) =>
        supabase.from("sku_weekly")
          .select("sku_name, sales_qty, sales_value, stock_qty")
          .eq("retailer", retailer).eq("week_start", wk)
          .order("sku_name").range(from, to)
      ),
      supabase.from("weekly_summary").select("week_start")
        .eq("retailer", retailer).order("week_start", { ascending: false }),
    ]);

    const agg = new Map<string, { qty: number; val: number; stock: number }>();
    for (const r of rows) {
      const e = agg.get(r.sku_name) ?? { qty: 0, val: 0, stock: 0 };
      e.qty += Number(r.sales_qty);
      e.val += Number(r.sales_value ?? 0);
      e.stock += Number(r.stock_qty);
      agg.set(r.sku_name, e);
    }
    const nf = netFactor(retailer); // ciro net kazanca çevrilir (çalışma marjı + KDV)
    const skus = [...agg.entries()]
      .map(([sku_name, v]) => {
        const val = v.val * nf;
        return {
          sku_name, sales_qty: v.qty, sales_value: val, stock_qty: v.stock,
          avg_price: v.qty > 0 ? Math.round((val / v.qty) * 100) / 100 : null,
        };
      })
      .sort((a, b) => b.sales_qty - a.sales_qty);

    return NextResponse.json({
      week: wk,
      weeks: [...new Set((allWeeks ?? []).map((w) => w.week_start))],
      skus,
    });
  } catch (e: any) {
    console.error("sku-detail hatası:", e);
    return NextResponse.json({ error: "Sunucu hatası" }, { status: 500 });
  }
}
