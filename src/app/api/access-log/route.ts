import { NextResponse } from "next/server";
import { supabaseAdmin, fetchAllRows } from "@/lib/supabase";

export const runtime = "nodejs";
export const revalidate = 0;
// Vercel varsayılanı 10 sn; service-role client'ın soğuk kurulumu + 500 satır
// okuma bunu zorlayabiliyor. Ağır route'lar 60 kullanıyor, buna 30 yeterli.
export const maxDuration = 30;

// Erişim kaydı özeti — "kaç kez girildi, ne zaman, hatalı deneme var mı".
// Tablo anon anahtarla okunamaz (RLS + revoke); burada service-role ile okunur.
// Bu rota da tüm /api/* gibi middleware PIN kapısının arkasında.
const DAYS = 30;

export async function GET() {
  try {
    const db = supabaseAdmin();
    const since = new Date();
    since.setUTCDate(since.getUTCDate() - DAYS);
    const sinceIso = since.toISOString();

    // TAM KÜME, KIRPMASIZ. Eskiden `.limit(500)` vardı: 30 günde 500'den çok olay
    // olsaydı "giriş sayısı" ve "hatalı PIN" sayaçları sessizce eksik çıkardı —
    // bu projenin kapatmaya çalıştığı hata sınıfı (sessiz kırpma). Sayfalı tam
    // çekim; sıra benzersiz anahtarı kapsıyor (ts, id).
    const rows = await fetchAllRows<{ id: number; ts: string; event: string; user_label: string | null; ip: string | null; user_agent: string | null }>(
      (from, to) => db.from("access_log")
        .select("id, ts, event, user_label, ip, user_agent")
        .gte("ts", sinceIso)
        .order("ts", { ascending: false }).order("id", { ascending: false })
        .range(from, to),
      { label: "access_log 30 gün" }
    );
    const ok = rows.filter((r) => r.event === "login_ok");
    const fail = rows.filter((r) => r.event === "login_fail");

    // Gün bazında giriş sayısı (grafik/şerit için) — yerel değil UTC gün anahtarı.
    const perDay = new Map<string, number>();
    for (const r of ok) {
      const d = String(r.ts).slice(0, 10);
      perDay.set(d, (perDay.get(d) ?? 0) + 1);
    }

    return NextResponse.json({
      days: DAYS,
      summary: {
        logins: ok.length,
        failed: fail.length,
        activeDays: perDay.size,
        uniqueIps: new Set(ok.map((r) => r.ip).filter(Boolean)).size,
        lastLogin: ok[0]?.ts ?? null,
      },
      perDay: [...perDay.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([day, count]) => ({ day, count })),
      recent: rows.slice(0, 25),
    });
  } catch (e: any) {
    console.error("access-log hatası:", e);
    return NextResponse.json({ error: "Sunucu hatası" }, { status: 500 });
  }
}
