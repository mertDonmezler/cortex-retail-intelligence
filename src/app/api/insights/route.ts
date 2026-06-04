import { NextResponse } from "next/server";
import { supabase, fetchAllRows } from "@/lib/supabase";
import { generateInsights, findStockoutRisks } from "@/lib/compute";
import { RETAILERS } from "@/lib/normalizers/types";
import { netRows } from "@/lib/margins";
import { toFacts, toSummary, FACT_COLS } from "@/lib/rows";

export const runtime = "nodejs";
export const revalidate = 0;
export const maxDuration = 60;

export async function GET() {
  try {
    const { data: summary } = await supabase
      .from("weekly_summary").select("*").order("week_start", { ascending: true });
    if (!summary?.length) return NextResponse.json({ insights: [] });

    const summaryRows = toSummary(summary);

    const allRisks: any[] = [];
    for (const retailer of RETAILERS) {
      try {
        const weeks = [...new Set(summaryRows.filter((s) => s.retailer === retailer).map((s) => s.week_start))].sort();
        if (weeks.length < 2) continue;
        const recent = weeks.slice(-4);
        const rows = await fetchAllRows((from, to) =>
          supabase
            .from("fact_weekly")
            .select(FACT_COLS)
            .eq("retailer", retailer).in("week_start", recent).order("id").range(from, to)
        );
        allRisks.push(...findStockoutRisks(toFacts(rows), retailer, recent));
      } catch (e) {
        // Tek perakendecinin hatası tüm paneli düşürmesin
        console.warn(`insights ${retailer} atlandı:`, e);
      }
    }

    // Ciro sinyalleri net kazanç üzerinden (çalışma marjı + KDV)
    const insights = generateInsights(netRows(summaryRows), allRisks);
    return NextResponse.json({ insights });
  } catch (e: any) {
    console.error("insights hatası:", e);
    return NextResponse.json({ error: "Sunucu hatası" }, { status: 500 });
  }
}
