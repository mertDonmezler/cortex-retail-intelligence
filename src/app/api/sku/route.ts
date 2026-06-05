import { NextRequest, NextResponse } from "next/server";
import { supabase, fetchAllRows } from "@/lib/supabase";

export const runtime = "nodejs";
export const revalidate = 0;
export const maxDuration = 60;

// Bir perakendeci + hafta için en çok satan SKU'lar (kart hover/expand).
export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const retailer = searchParams.get("retailer");
  const week = searchParams.get("week");
  if (!retailer || !week) {
    return NextResponse.json({ error: "retailer ve week gerekli" }, { status: 400 });
  }
  try {
    // sku_weekly: mağaza boyutu çökertilmiş SKU-hafta matview'i. Eski mağaza-bazlı
    // haftalarda fact_weekly on binlerce satır döndürürken bu birkaç yüz satır.
    const data = await fetchAllRows((from, to) =>
      supabase
        .from("sku_weekly")
        .select("sku_name, sales_qty")
        .eq("retailer", retailer)
        .eq("week_start", week)
        .order("sku_name")
        .range(from, to)
    );

    const agg = new Map<string, number>();
    for (const r of data) {
      agg.set(r.sku_name, (agg.get(r.sku_name) ?? 0) + Number(r.sales_qty));
    }
    const top = [...agg.entries()]
      .map(([sku_name, sales_qty]) => ({ sku_name, sales_qty }))
      .sort((a, b) => b.sales_qty - a.sales_qty)
      .slice(0, 5);

    return NextResponse.json({ top });
  } catch (e: any) {
    console.error("sku rotası hatası:", e);
    return NextResponse.json({ error: "Sunucu hatası" }, { status: 500 });
  }
}
