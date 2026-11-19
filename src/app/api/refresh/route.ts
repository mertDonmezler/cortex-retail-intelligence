import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Kendi bütçesi. refresh_summaries() altı matview'i sırayla yeniliyor ve
// fonksiyonun kendisi `set local statement_timeout = '180000'` diyor — yani
// tasarımı gereği 60 sn'lik bir yolun içine sığmıyor.
export const maxDuration = 300;

// ── ÖZET GÖRÜNÜMLERİNİ YENİLE ──
//
// NEDEN AYRI UÇ: bu iş eskiden /api/upload isteğinin İÇİNDE yapılıyordu.
// Upload'ın bütçesi 60 sn; içinde silme + parça parça yazma + fiyat enrichment
// (ölçülen: önbeleksiz dilim 12,6 sn) + altı matview yenilemesi (ölçülen ikisi
// 13,4 + 6,4 sn) vardı. Bütçe dolduğunda platform fonksiyonu öldürüyor ve en
// kötü hâlde DELETE olmuş, INSERT yarıda kalmış, yanıt hiç dönmemiş oluyordu:
// kullanıcı "yükleme başarısız" görüyor, panelde hafta ya eksik ya eski.
//
// Ayrıştırınca yükleme yalnız YAZMA işini yapıyor ve yanıtını hızlı döndürüyor;
// yenileme bu uçta, kendi süresiyle ve TEKRAR ÇAĞRILABİLİR biçimde çalışıyor.
// Başarısız olursa veri kaybı yok — yalnız panel bir süre eski görünür ve
// kullanıcı düğmeye tekrar basabilir.
export async function POST() {
  const db = supabaseAdmin();
  const t0 = Date.now();
  try {
    const { error } = await db.rpc("refresh_summaries");
    if (error) throw new Error(error.message);
    return NextResponse.json({ ok: true, ms: Date.now() - t0 });
  } catch (e: any) {
    console.error("refresh_summaries hatası:", e?.message ?? e);
    return NextResponse.json(
      {
        ok: false,
        ms: Date.now() - t0,
        error: "Özet görünümleri yenilenemedi — veri yazıldı, panel bir süre eski görünebilir.",
      },
      { status: 500 }
    );
  }
}
