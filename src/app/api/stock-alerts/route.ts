import { NextRequest, NextResponse } from "next/server";
import { supabase, fetchAllRows } from "@/lib/supabase";
import { reorderPriority } from "@/lib/compute";
import { toNetFacts, SKU_COLS } from "@/lib/rows";

export const runtime = "nodejs";
export const revalidate = 0;
export const maxDuration = 60;

const WINDOW = 4; // hız ortalaması için son kaç hafta

// Sipariş önceliği: son WINDOW haftanın HAFTALIK ORTALAMA satışı ≥ minSales olan
// ürünleri, stoğun kaç hafta yeteceğine (stok / ort. satış) göre en acilden sırala.
export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const retailer = searchParams.get("retailer");
  const minSales = Math.max(1, Number(searchParams.get("minSales") ?? 10));
  if (!retailer) return NextResponse.json({ error: "retailer gerekli" }, { status: 400 });
  try {
    const { data: wkRows } = await supabase
      .from("weekly_summary").select("week_start")
      .eq("retailer", retailer).order("week_start", { ascending: false }).limit(WINDOW);
    const weeks = [...new Set((wkRows ?? []).map((w) => w.week_start as string))]; // yeni → eski
    if (!weeks.length) {
      return NextResponse.json({ latest: null, minSales, weeksUsed: 0, items: [], counts: { tukendi: 0, acil: 0, izle: 0 } });
    }
    const latest = weeks[0];

    const rows = await fetchAllRows((from, to) =>
      supabase.from("sku_weekly")
        .select(SKU_COLS)
        .eq("retailer", retailer).in("week_start", weeks).order("week_start").order("sku_name").range(from, to)
    );

    const items = reorderPriority(toNetFacts(rows), weeks, minSales);
    const counts = {
      tukendi: items.filter((i) => i.status === "tükendi").length,
      acil: items.filter((i) => i.status === "acil").length,
      izle: items.filter((i) => i.status === "izle").length,
    };
    return NextResponse.json({ latest, minSales, weeksUsed: weeks.length, items, counts });
  } catch (e: any) {
    console.error("stock-alerts hatası:", e);
    return NextResponse.json({ error: "Sunucu hatası" }, { status: 500 });
  }
}
