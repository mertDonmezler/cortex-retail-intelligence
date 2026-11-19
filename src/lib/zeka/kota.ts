// CORTEX ASİSTANI — KOTA VE HARCAMA KAYDI (kredi kontrolü).
//
// Oturum başına 10 dakikada en fazla 10 soru (haftalık not da bir soru sayılır).
// Oturum = cortex_auth çerezindeki nonce'un SHA-256 özeti: aynı PIN'le giren her
// tarayıcı ayrı oturumdur, çerezin kendisi hiçbir yere yazılmaz.
//
// Sayaç `zeka_kullanim` tablosunda (supabase/zeka-kullanim.sql). Tablo yoksa
// (SQL henüz çalıştırılmadı) süreç belleğine düşer: Vercel'de örnekler arası
// paylaşılmadığı için yaklaşık bir sınırdır, ama asistan durmaz.
import { createHash } from "crypto";
import type { NextRequest } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";

export const KOTA_LIMIT = 10;
export const KOTA_PENCERE_MS = 10 * 60 * 1000;
const TABLO = "zeka_kullanim";

export type Kota = { limit: number; kalan: number; sifirlanmaSn: number; buAyUsd: number | null };

export function oturumAnahtari(req: NextRequest): string {
  const deger = req.cookies.get("cortex_auth")?.value ?? "";
  const nonce = deger.split(".")[1] || deger || "anonim";
  return createHash("sha256").update(nonce).digest("hex").slice(0, 32);
}

// Tablo yoksa yedek: süreç belleği (örnek başına).
const bellek = new Map<string, number[]>();
let tabloVar: boolean | null = null;

async function sonIstekler(db: SupabaseClient, oturum: string): Promise<number[]> {
  const esik = Date.now() - KOTA_PENCERE_MS;
  if (tabloVar !== false) {
    const { data, error } = await db.from(TABLO).select("ts").eq("oturum", oturum)
      .gte("ts", new Date(esik).toISOString()).order("ts", { ascending: true }).limit(KOTA_LIMIT + 5);
    if (!error) { tabloVar = true; return (data ?? []).map((r: any) => Date.parse(r.ts)); }
    if (tabloVar === null) console.warn("zeka_kullanim okunamadı, kota süreç belleğinde tutulacak:", error.message);
    tabloVar = false;
  }
  const liste = (bellek.get(oturum) ?? []).filter((t) => t >= esik);
  bellek.set(oturum, liste);
  return liste;
}

export function kotaHesapla(zamanlar: number[]): Omit<Kota, "buAyUsd"> {
  const kalan = Math.max(0, KOTA_LIMIT - zamanlar.length);
  const ilk = zamanlar[0];
  const sifirlanmaSn = zamanlar.length >= KOTA_LIMIT && ilk ? Math.max(1, Math.ceil((ilk + KOTA_PENCERE_MS - Date.now()) / 1000)) : 0;
  return { limit: KOTA_LIMIT, kalan, sifirlanmaSn };
}

export async function buAyHarcama(db: SupabaseClient): Promise<number | null> {
  if (tabloVar === false) return null;
  const ay = new Date(); ay.setUTCDate(1); ay.setUTCHours(0, 0, 0, 0);
  const { data, error } = await db.from(TABLO).select("maliyet_usd").gte("ts", ay.toISOString()).not("maliyet_usd", "is", null).limit(10000);
  if (error) return null;
  return Math.round((data ?? []).reduce((t: number, r: any) => t + (Number(r.maliyet_usd) || 0), 0) * 100) / 100;
}

export async function kotaDurumu(db: SupabaseClient, oturum: string): Promise<Kota> {
  const [z, ay] = await Promise.all([sonIstekler(db, oturum), buAyHarcama(db)]);
  return { ...kotaHesapla(z), buAyUsd: ay };
}

/** Soru başlamadan: hak varsa kaydı açar. Kayıt id'si (tablo varsa) sonradan kapatılır. */
export async function kotaAl(db: SupabaseClient, oturum: string, tur: "soru" | "not", soru: string, model: string, anahtar?: string):
  Promise<{ izin: boolean; kota: Omit<Kota, "buAyUsd">; id: number | null }> {
  const z = await sonIstekler(db, oturum);
  if (z.length >= KOTA_LIMIT) return { izin: false, kota: kotaHesapla(z), id: null };
  let id: number | null = null;
  if (tabloVar) {
    const satir: Record<string, unknown> = { oturum, tur, soru: soru.slice(0, 500), model };
    if (anahtar) satir.anahtar = anahtar;
    const { data, error } = await db.from(TABLO).insert(satir).select("id").single();
    if (error) console.warn("zeka_kullanim yazılamadı:", error.message); else id = data.id;
  } else {
    bellek.set(oturum, [...z, Date.now()]);
  }
  return { izin: true, kota: kotaHesapla([...z, Date.now()]), id };
}

export async function kotaKapat(db: SupabaseClient, id: number | null, s: {
  durum: string; model?: string; aracSayisi?: number; turSayisi?: number;
  giris?: number; cikis?: number; onbellek?: number; maliyetUsd?: number; sureMs: number; cevap?: string;
}) {
  if (!id) return;
  const { error } = await db.from(TABLO).update({
    durum: s.durum, model: s.model, arac_sayisi: s.aracSayisi, tur_sayisi: s.turSayisi,
    giris_token: s.giris, cikis_token: s.cikis, onbellek_token: s.onbellek, maliyet_usd: s.maliyetUsd, sure_ms: s.sureMs,
    ...(s.cevap != null ? { cevap: s.cevap.slice(0, 20000) } : {}),
  }).eq("id", id);
  if (error) console.warn("zeka_kullanim güncellenemedi:", error.message);
}

// ── Haftalık not önbelleği ──────────────────────────────────────────────────
// Not ~0,5 $ tutuyor ve aynı veriyle yeniden yazılınca aynı şeyi söylüyor.
// Anahtar = verinin imzası (her firmanın son raporlu haftası): yeni bir rapor
// yüklenince imza değişir, not kendiliğinden tazelenir. Not oturuma bağlı
// değildir — ekipten biri yazdırdıysa diğeri kayıttan okur.
export type KayitliNot = { id: number | null; ts: string; cevap: string; model: string; maliyetUsd: number; aracSayisi: number };
const notBellek = new Map<string, KayitliNot>();

export async function notBul(db: SupabaseClient, anahtar: string): Promise<KayitliNot | null> {
  if (tabloVar !== false) {
    const { data, error } = await db.from(TABLO).select("id, ts, cevap, model, maliyet_usd, arac_sayisi")
      .eq("tur", "not").eq("anahtar", anahtar).eq("durum", "tamam").not("cevap", "is", null)
      .order("ts", { ascending: false }).limit(1);
    if (!error) {
      const r: any = data?.[0];
      return r ? { id: r.id, ts: r.ts, cevap: r.cevap, model: r.model, maliyetUsd: Number(r.maliyet_usd) || 0, aracSayisi: r.arac_sayisi ?? 0 } : null;
    }
  }
  return notBellek.get(anahtar) ?? null;
}

export function notBellegeYaz(anahtar: string, n: KayitliNot) {
  notBellek.set(anahtar, n);
}

// ── Geri bildirim ───────────────────────────────────────────────────────────
/** Yalnız kendi oturumunun kaydına puan verilebilir. Tablo yoksa false. */
export async function puanVer(db: SupabaseClient, id: number, oturum: string, puan: 1 | -1 | null): Promise<boolean> {
  const { data, error } = await db.from(TABLO).update({ puan }).eq("id", id).eq("oturum", oturum).select("id");
  if (error) { console.warn("zeka_kullanim puan yazılamadı:", error.message); return false; }
  return (data ?? []).length > 0;
}
