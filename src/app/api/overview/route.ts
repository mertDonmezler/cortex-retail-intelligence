import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/supabase";
import { execOverview } from "@/lib/compute";
import { netRows } from "@/lib/margins";
import { toSummary } from "@/lib/rows";

export const runtime = "nodejs";
export const revalidate = 0;

export async function GET(req: NextRequest) {
  const week = new URL(req.url).searchParams.get("week") || undefined;
  try {
    const { data: summary, error } = await supabase
      .from("weekly_summary").select("*").order("week_start", { ascending: true });
    if (error) throw error;
    const rows = toSummary(summary ?? []);
    // Hafta seçici için tüm haftalar (yeni → eski)
    const weeks = [...new Set(rows.map((r) => r.week_start))].sort().reverse();
    // Ciro = net kazanç (çalışma marjı + KDV düşülmüş)
    return NextResponse.json({ ...execOverview(netRows(rows), week), weeks });
  } catch (e: any) {
    console.error("overview hatası:", e);
    return NextResponse.json({ error: "Sunucu hatası" }, { status: 500 });
  }
}
