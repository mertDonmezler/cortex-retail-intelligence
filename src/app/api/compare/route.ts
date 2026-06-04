import { NextRequest, NextResponse } from "next/server";
import { supabase, fetchAllRows } from "@/lib/supabase";
import { comparePeriods } from "@/lib/compute";
import { getApprovedAliases } from "@/lib/aliases";
import { toNetFacts, FACT_COLS } from "@/lib/rows";

export const runtime = "nodejs";
export const revalidate = 0;
export const maxDuration = 60;

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const retailer = searchParams.get("retailer");
  const weekA = searchParams.get("a");
  const weekB = searchParams.get("b");
  try {
    // Karşılaştırılabilir haftaları döndür (retailer verilmişse)
    if (retailer && (!weekA || !weekB)) {
      const { data: weeks } = await supabase.from("weekly_summary")
        .select("week_start").eq("retailer", retailer).order("week_start", { ascending: false });
      return NextResponse.json({ weeks: (weeks ?? []).map((w) => w.week_start) });
    }
    if (!retailer || !weekA || !weekB) {
      return NextResponse.json({ error: "retailer, a, b gerekli" }, { status: 400 });
    }
    const [aRows, bRows] = await Promise.all([
      fetchAllRows((from, to) =>
        supabase.from("fact_weekly")
          .select(FACT_COLS)
          .eq("retailer", retailer).eq("week_start", weekA).order("id").range(from, to)
      ),
      fetchAllRows((from, to) =>
        supabase.from("fact_weekly")
          .select(FACT_COLS)
          .eq("retailer", retailer).eq("week_start", weekB).order("id").range(from, to)
      ),
    ]);
    const aliases = await getApprovedAliases();
    const result = comparePeriods(toNetFacts(aRows), toNetFacts(bRows), aliases);
    return NextResponse.json({ a: weekA, b: weekB, ...result });
  } catch (e: any) {
    console.error("compare hatası:", e);
    return NextResponse.json({ error: "Sunucu hatası" }, { status: 500 });
  }
}
