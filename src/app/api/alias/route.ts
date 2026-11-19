import { NextRequest, NextResponse } from "next/server";
import { supabase, supabaseAdmin, fetchAllRows } from "@/lib/supabase";

export const runtime = "nodejs";
export const revalidate = 0;
export const maxDuration = 60;

// Ürün takma-ad önerileri: listele (GET), onayla/reddet + matview yenile (POST).
export async function GET() {
  try {
    // TAM LISTE, KARARLI SIRA. Eski sorguda ne `.range()` ne de acik bir limit
    // vardi: PostgREST 1.000 satirda SESSIZCE kesiyor ve `confidence` hem
    // benzersiz hem de NOT NULL degil. match:toyzz her kosuda Toyzz'un her
    // benzersiz adina satir yazdigi icin tablo buyuyor; 1.000'i gectigi gun
    // /eslesme eksik liste gosterir ve kalan oneriler ONAYLANAMAZ hale gelir.
    // Sayfalama benzersiz anahtarla (id) yapilir, siralama istemcide.
    const all = await fetchAllRows<{
      id: number; retailer: string; sku_name: string; barkod: string;
      match_name: string | null; confidence: number | null; status: string; candidates: any;
    }>((from, to) =>
      supabase.from("product_alias")
        .select("id, retailer, sku_name, barkod, match_name, confidence, status, candidates")
        .order("id", { ascending: true }).range(from, to)
    );
    all.sort((a, b) => (b.confidence ?? -1) - (a.confidence ?? -1));
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

    const { id, status, barkod, match_name } = body;
    if (!id || !["approved", "rejected", "suggested"].includes(status)) {
      return NextResponse.json({ error: "id ve geçerli status gerekli" }, { status: 400 });
    }
    // Onaylarken /eslesme'den seçilen/düzeltilen aday EAN'i kabul et (8-14 hane).
    const patch: Record<string, unknown> = { status, updated_at: new Date().toISOString() };
    if (typeof barkod === "string" && /^\d{8,14}$/.test(barkod)) patch.barkod = barkod;
    if (typeof match_name === "string" && match_name.trim()) patch.match_name = match_name.trim();
    const { error } = await db.from("product_alias").update(patch).eq("id", id);
    if (error) throw error;
    return NextResponse.json({ ok: true });
  } catch (e: any) {
    console.error("alias POST:", e);
    return NextResponse.json({ error: "Sunucu hatası" }, { status: 500 });
  }
}
