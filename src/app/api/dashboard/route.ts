import { NextResponse } from "next/server";
import { supabase } from "@/lib/supabase";
import { netRows } from "@/lib/margins";

export const runtime = "nodejs";
export const revalidate = 0;
// Vercel varsayılanı 10 sn; matview soğukken (refresh sonrası ilk okuma) iki
// sorgu bunu zorlayabiliyor. Ağır route'lar 60 kullanıyor, buna 30 yeterli.
export const maxDuration = 30;

// Tüm haftalık özet + tazelik — kartlar ve trend için.
export async function GET() {
  try {
    const [{ data: summary, error: e1 }, { data: fresh, error: e2 }, { data: turetilen }] = await Promise.all([
      supabase.from("weekly_summary").select("*").order("week_start", { ascending: true }),
      supabase.from("data_freshness").select("*"),
      // TÜRETİLMİŞ HAFTALAR. Bir kez, aylık bir dosyadan "ay − yüklü haftalar"
      // kalıntısı olarak sentetik satırlar üretildi (Huppaluppo 2026-06-29: 49
      // satır, satış TAHMİN, week_end 2026-08-02 = 34 günlük "hafta"). Kaynağı
      // yalnız fact_weekly.source_file'da yazılıydı; hiçbir ekran göstermiyordu ve
      // trend grafiğinde gerçek bir hafta gibi duruyordu. Provenance import_log'da
      // (yükleme geçmişi) tutulur: dosya adı "TÜRETİLDİ" içeren kayıtlar.
      supabase.from("import_log").select("retailer, week_start, filename").ilike("filename", "%TÜRET%"),
    ]);
    if (e1) throw new Error(e1.message);
    if (e2) throw new Error(e2.message);
    const derived = (turetilen ?? []).map((l: any) => ({
      retailer: l.retailer as string, week_start: l.week_start as string, note: l.filename as string,
    }));
    // Ciro net kazanca çevrilir (çalışma marjı + KDV); adet/stok ham kalır.
    return NextResponse.json({ summary: netRows((summary ?? []) as any[]), freshness: fresh ?? [], derived });
  } catch (e: any) {
    console.error("dashboard hatası:", e);
    return NextResponse.json({ error: "Sunucu hatası" }, { status: 500 });
  }
}
