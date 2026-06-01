import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/supabase";
import { execOverview, type SummaryRow } from "@/lib/compute";

export const runtime = "nodejs";
export const revalidate = 0;

export async function GET(req: NextRequest) {
  const week = new URL(req.url).searchParams.get("week") || undefined;
  try {
    const { data: summary, error } = await supabase
      .from("weekly_summary").select("*").order("week_start", { ascending: true });
    if (error) throw error;
    const rows: SummaryRow[] = (summary ?? []).map((s) => ({
      retailer: s.retailer, week_start: s.week_start,
      sales_qty: Number(s.sales_qty),
      sales_value: s.sales_value != null ? Number(s.sales_value) : null,
      has_value: !!s.has_value, stock_qty: Number(s.stock_qty),
      sku_count: Number(s.sku_count ?? 0), store_count: Number(s.store_count ?? 0),
    }));
    // Hafta seçici için tüm haftalar (yeni → eski)
    const weeks = [...new Set(rows.map((r) => r.week_start))].sort().reverse();
    return NextResponse.json({ ...execOverview(rows, week), weeks });
  } catch (e: any) {
    console.error("overview hatası:", e);
    return NextResponse.json({ error: "Sunucu hatası" }, { status: 500 });
  }
}
