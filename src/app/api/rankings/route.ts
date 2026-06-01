import { NextRequest, NextResponse } from "next/server";
import { supabase, fetchAllRows } from "@/lib/supabase";
import { globalRankings, categoryBreakdown, type FactRow } from "@/lib/compute";
import { RETAILERS } from "@/lib/normalizers/types";

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
  const sp = new URL(req.url).searchParams;
  const week = sp.get("week") || undefined;
  const metric = sp.get("metric") === "qty" ? "qty" : "value"; // büyüme bazı — varsayılan ciro
  try {
    // Hafta seçici için tüm haftalar (yeni → eski)
    const { data: wkRows } = await supabase.from("weekly_summary").select("week_start");
    const allWeeks = [...new Set((wkRows ?? []).map((w) => w.week_start))].sort().reverse();

    // Gösterilecek hafta = seçili hafta; yoksa en güncel hafta.
    const focus = week || allWeeks[0] || null;
    // Geçen hafta = seçili haftanın tam 7 gün öncesi (kanonik Pazartesi).
    let prevWeek: string | null = null;
    if (focus) {
      const pd = new Date(focus + "T00:00:00Z");
      pd.setUTCDate(pd.getUTCDate() - 7);
      prevWeek = pd.toISOString().slice(0, 10);
    }

    const latestRows: FactRow[] = [];
    const prevByKey = new Map<string, { qty: number; val: number }>();
    if (focus) for (const retailer of RETAILERS) {
      // STRICT: yalnızca TAM o haftanın verisi. O hafta yoksa bu perakendeci hiç
      // dahil edilmez (eskiden as-of ile geçen haftanın verisi karışıyordu).
      const lr = await fetchAllRows((from, to) =>
        supabase.from("fact_weekly")
          .select("retailer, week_start, store, sku_name, barkod, sales_qty, sales_value, stock_qty")
          .eq("retailer", retailer).eq("week_start", focus).order("id").range(from, to)
      );
      if (!lr.length) continue;
      latestRows.push(...toFacts(lr));
      if (prevWeek) {
        const pr = await fetchAllRows((from, to) =>
          supabase.from("fact_weekly")
            .select("retailer, sku_name, sales_qty, sales_value").eq("retailer", retailer).eq("week_start", prevWeek).order("id").range(from, to)
        );
        for (const r of pr) {
          const k = `${r.retailer}|${r.sku_name}`;
          const e = prevByKey.get(k) ?? { qty: 0, val: 0 };
          e.qty += Number(r.sales_qty); e.val += Number(r.sales_value ?? 0);
          prevByKey.set(k, e);
        }
      }
    }
    const rankings = globalRankings(latestRows, prevByKey, metric);
    const categories = {
      brand: categoryBreakdown(latestRows, "brand"),
      team: categoryBreakdown(latestRows, "team"),
      type: categoryBreakdown(latestRows, "type"),
    };
    return NextResponse.json({ ...rankings, categories, weeks: allWeeks, week: focus, metric });
  } catch (e: any) {
    console.error("rankings hatası:", e);
    return NextResponse.json({ error: "Sunucu hatası" }, { status: 500 });
  }
}
