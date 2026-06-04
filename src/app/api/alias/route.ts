import { NextRequest, NextResponse } from "next/server";
import { supabase, supabaseAdmin } from "@/lib/supabase";

export const runtime = "nodejs";
export const revalidate = 0;
export const maxDuration = 60;

// Ürün takma-ad önerileri: listele (GET), onayla/reddet + matview yenile (POST).
export async function GET() {
  try {
    const { data, error } = await supabase
      .from("product_alias")
      .select("id, retailer, sku_name, barkod, match_name, confidence, status")
      .order("confidence", { ascending: false });
    if (error) throw error;
    const all = data ?? [];
    return NextResponse.json({
      suggestions: all.filter((a) => a.status === "suggested"),
      approved: all.filter((a) => a.status === "approved"),
      rejectedCount: all.filter((a) => a.status === "rejected").length,
    });
  } catch (e: any) {
    console.error("alias GET:", e);
    return NextResponse.json({ error: "Sunucu hatası" }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({} as any));
    const db = supabaseAdmin();

    // Yalnız product_coverage'ı yenile (alias değişimi sadece onu etkiler; tüm
    // matview'leri yenilemek free-tier statement_timeout'unu aşıyordu).
    if (body.refresh) {
      const { error } = await db.rpc("refresh_product_coverage");
      if (error) throw error;
      return NextResponse.json({ ok: true, refreshed: true });
    }

    const { id, status } = body;
    if (!id || !["approved", "rejected", "suggested"].includes(status)) {
      return NextResponse.json({ error: "id ve geçerli status gerekli" }, { status: 400 });
    }
    const { error } = await db
      .from("product_alias")
      .update({ status, updated_at: new Date().toISOString() })
      .eq("id", id);
    if (error) throw error;
    return NextResponse.json({ ok: true });
  } catch (e: any) {
    console.error("alias POST:", e);
    return NextResponse.json({ error: "Sunucu hatası" }, { status: 500 });
  }
}
