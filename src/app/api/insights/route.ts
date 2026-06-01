import { NextResponse } from "next/server";
import { supabase, fetchAllRows } from "@/lib/supabase";
import { generateInsights, findStockoutRisks, type FactRow, type SummaryRow } from "@/lib/compute";
import { RETAILERS } from "@/lib/normalizers/types";

export const runtime = "nodejs";
export const revalidate = 0;
export const maxDuration = 60;

export async function GET() {
  try {
    const { data: summary } = await supabase
      .from("weekly_summary").select("*").order("week_start", { ascending: true });
    if (!summary?.length) return NextResponse.json({ insights: [] });

    const summaryRows: SummaryRow[] = summary.map((s) => ({
      retailer: s.retailer, week_start: s.week_start,
      sales_qty: Number(s.sales_qty),
      sales_value: s.sales_value != null ? Number(s.sales_value) : null,
      has_value: !!s.has_value, stock_qty: Number(s.stock_qty),
      sku_count: Number(s.sku_count ?? 0), store_count: Number(s.store_count ?? 0),
    }));

    const allRisks: any[] = [];
    for (const retailer of RETAILERS) {
      const weeks = [...new Set(summaryRows.filter((s) => s.retailer === retailer).map((s) => s.week_start))].sort();
      if (weeks.length < 2) continue;
      const recent = weeks.slice(-4);
      const rows = await fetchAllRows((from, to) =>
        supabase
          .from("fact_weekly")
          .select("retailer, week_start, store, sku_name, barkod, sales_qty, sales_value, stock_qty")
          .eq("retailer", retailer).in("week_start", recent).order("id").range(from, to)
      );
      const facts: FactRow[] = rows.map((r) => ({
        retailer: r.retailer, week_start: r.week_start, store: r.store,
        sku_name: r.sku_name, barkod: r.barkod,
        sales_qty: Number(r.sales_qty),
        sales_value: r.sales_value != null ? Number(r.sales_value) : null,
        stock_qty: Number(r.stock_qty),
      }));
      allRisks.push(...findStockoutRisks(facts, retailer, recent));
    }

    const insights = generateInsights(summaryRows, allRisks);
    return NextResponse.json({ insights });
  } catch (e: any) {
    console.error("insights hatası:", e);
    return NextResponse.json({ error: "Sunucu hatası" }, { status: 500 });
  }
}
