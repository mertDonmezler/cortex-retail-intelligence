import { NextResponse } from "next/server";
import { supabase } from "@/lib/supabase";

export const runtime = "nodejs";
export const revalidate = 0;

// Tüm haftalık özet + tazelik — kartlar ve trend için.
export async function GET() {
  try {
    const [{ data: summary, error: e1 }, { data: fresh, error: e2 }] = await Promise.all([
      supabase.from("weekly_summary").select("*").order("week_start", { ascending: true }),
      supabase.from("data_freshness").select("*"),
    ]);
    if (e1) throw new Error(e1.message);
    if (e2) throw new Error(e2.message);
    return NextResponse.json({ summary: summary ?? [], freshness: fresh ?? [] });
  } catch (e: any) {
    console.error("dashboard hatası:", e);
    return NextResponse.json({ error: "Sunucu hatası" }, { status: 500 });
  }
}
