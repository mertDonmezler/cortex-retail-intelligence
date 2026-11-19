// ── FATURA FİYATI: D&R'da TL'nin dayanağı (2026-10-29) ───────────────────────
// SORUN: D&R'ın haftalık dosyası (Satin Alma - Kategori) fiyat taşımıyor; ciro
// enrichment'la kanallar arası medyandan dolduruluyordu. Turkuvaz fatura denetimi
// (Ocak–Ekim 2026, 406 kalem) bu fiyatın 100 üründen yalnız 28'inde faturaya ±%5
// yakın olduğunu gösterdi; 57'si düşük, 15'i yüksek. Sebep iki katlı:
//   1. ASEPTO mağaza dosyasındaki "Satis Tutar" KDV hariç saklanıyordu; okuma
//      anında bir daha 1,2'ye bölündü (normalizers/asepto.ts'te düzeltildi),
//   2. fiyat yıl içinde değişiyor (31/107 barkod; ör. metal kutu net 352,89 →
//      441,23) ama medyan tüm geçmişe bakıyor.
//
// ÇÖZÜM: bizim D&R'a kestiğimiz faturanın net birim fiyatı, D&R'ın bize ödediği
// tutarın kendisi. CORTEX'in para modeli net = PSF × (1 − marj) / 1,2 olduğundan
// faturadaki net, PSF'ye geri çevrilip (net / netFactor) satıra yazılır; ekranda
// okunan net kazanç böylece birebir fatura fiyatı olur. Doğrulama: Beşiktaş metal
// kutu faturada 352,89 TL → 352,89 / (0,53 / 1,2) = 799,00 TL PSF, rafta 799.
//
// HANGİ FATURA — FIFO: D&R satıştan öder ve her birimi geldiği partinin fatura
// fiyatından öder; önce eski parti satılır. "Son fatura" kuralı ilk sürümdü ve
// ölçülünce yanıltıcı çıktı (Nisan–Ekim 2026, faturalı ürünler):
//   • fiyat artışında abartıyor: FB First metal kutu Şubat'ta 1.200 adet 799'dan,
//     Ağustos'ta 20 adet 999'dan faturalandı; satılan birimler hâlâ 799'luk parti,
//   • küçük özel partide sapıyor: Labubu 864 adet 102,75; Ağustos'ta 36 adet 71,32,
//   • fiyat indiriminde eksik: BJK Pulls Ocak'ta 1.080 adet 179'dan, Mart'tan beri 99.
//   Toplamda son fatura FIFO'dan %3,4 yüksek, üründe %15–40 (Kpop, poster, First).
// Kural: haftanın son gününe kadar kesilmiş faturalar en yeniden eskiye dizilir;
// hafta sonunda kanalda kalan stok en yeni partilerdir, o hafta satılan birimler
// onların HEMEN ALTINDAKİ partilerden gelir. Faturalı birim biterse geri kalan
// listeden önceki partilerdendir (fiyatı bilinmez) → en eski faturanın fiyatı.
// Stok yalnız mağaza rafı (D&R deposu bilinmiyor): gerçek FIFO bundan biraz daha
// eskiye bakar; kural bu yüzden "son fatura" ile tam FIFO arasında, temkinli yanda.
// Haftadan önce hiç fatura yoksa (ürün listeden önce satılmış) çağıran karar
// verir: enrichment önce haftanın kendi dosya kanıtına, sonra ilk sonraki faturaya.
//
// SAF FONKSİYONLAR + TEK YÜKLEYİCİ: indeks/sorgu DB'ye dokunmaz (test edilir);
// `faturaIndeksiYukle` tablo yoksa null döner ve sistem eski davranışla çalışır.
import type { SupabaseClient } from "@supabase/supabase-js";
import { fetchAllRows } from "./supabase";
import { netFactor } from "./margins";

// Faturası tabloda tutulan kanallar. Yeni kanal eklenince fatura listesi
// yüklenmeli; liste boşken davranış eskisiyle aynı kalır.
export const FATURALI_KANAL = new Set(["DR"]);

export type FaturaSatiri = {
  barkod: string | null;
  tarih: string; // YYYY-MM-DD
  net_fiyat: number; // KDV hariç net birim fiyat
  miktar: number;
  iade?: boolean | null;
};

type Nokta = { tarih: string; net: number; adet: number };
// barkod → tarih sırasına göre partiler (gün başına bir parti; aynı gün birden çok
// kalem varsa adet ağırlıklı ortalama)
export type FaturaIndeksi = Map<string, Nokta[]>;

// Fatura barkodu → CORTEX barkodu. Teneke kutu varyantları faturada
// "5053307076952-2" gibi ekli geliyor; CORTEX'te tek EAN. Stok koduyla gelen
// barkodsuz kalemler ("Worl3939105312023") hiçbir satıra eşleşmez → null.
export function faturaBarkodu(v: unknown): string | null {
  const b = String(v ?? "")
    .trim()
    .replace(/\.0$/, "");
  const m = /^(\d{8,14})(?:-\d{1,2})?$/.exec(b);
  return m ? m[1] : null;
}

export function faturaIndeksi(satirlar: FaturaSatiri[]): FaturaIndeksi {
  // barkod → tarih → [tutar toplamı, adet toplamı]
  const gun = new Map<string, Map<string, [number, number]>>();
  for (const s of satirlar) {
    const bk = faturaBarkodu(s.barkod);
    const net = Number(s.net_fiyat),
      q = Number(s.miktar);
    // İade ve bedelsiz (0 TL numune) kalemler fiyat kanıtı değil.
    if (!bk || s.iade || !(net > 0) || !(q > 0)) continue;
    let g = gun.get(bk);
    if (!g) gun.set(bk, (g = new Map()));
    const a = g.get(s.tarih) ?? [0, 0];
    a[0] += net * q;
    a[1] += q;
    g.set(s.tarih, a);
  }
  const idx: FaturaIndeksi = new Map();
  for (const [bk, g] of gun) {
    idx.set(
      bk,
      [...g.entries()]
        .map(([tarih, [t, q]]) => ({ tarih, net: t / q, adet: q }))
        .sort((x, y) => x.tarih.localeCompare(y.tarih)),
    );
  }
  return idx;
}

// FIFO birim fiyatı: `tarih`e kadar (dahil) kesilmiş partilerde, en yeni `ust`
// birimin ALTINDAKİ `adet` birimin adet ağırlıklı net fiyatı (yukarıdaki kural).
//   • geçmiş hafta: ust = hafta sonu stoğu, adet = o haftanın satışı,
//   • rafın değeri: ust = 0, adet = eldeki stok (en yeni partiler),
//   • ust = 0, adet = 1 → en son faturanın fiyatı.
// Tarihten önce hiç fatura yoksa ilk sonraki fatura (once = false).
export function faturaNeti(
  idx: FaturaIndeksi,
  barkod: string,
  tarih: string,
  ust = 0,
  adet = 1,
): { net: number; tarih: string; once: boolean } | null {
  const L = idx.get(barkod);
  if (!L?.length) return null;
  const once = L.filter((p) => p.tarih <= tarih);
  if (!once.length) return { net: L[0].net, tarih: L[0].tarih, once: false };
  const a0 = Math.max(0, ust),
    q = Math.max(1, adet),
    a1 = a0 + q;
  let pos = 0,
    tutar = 0,
    kapsanan = 0;
  for (let i = once.length - 1; i >= 0 && pos < a1; i--) {
    const p = once[i];
    const o = Math.max(0, Math.min(pos + p.adet, a1) - Math.max(pos, a0));
    tutar += o * p.net;
    kapsanan += o;
    pos += p.adet;
  }
  // Faturalı birimlerin altına inildi: listeden önceki partiler → en eski fiyat.
  if (kapsanan < q) tutar += (q - kapsanan) * once[0].net;
  return { net: tutar / q, tarih: once[once.length - 1].tarih, once: true };
}

// Faturadaki net → CORTEX'in sakladığı PSF (KDV dahil perakende). Ters yönü
// okuma anındaki netFactor; ikisi aynı fonksiyondan geldiği için net birebir döner.
export function netFaturadanPsf(net: number, retailer: string): number {
  const f = netFactor(retailer);
  return f > 0 ? net / f : 0;
}

// Haftanın son günü (week_start + 6). Fatura bu güne kadar kesilmişse o haftanın
// satışına uygulanır.
export function haftaSonu(weekStart: string): string {
  const d = new Date(weekStart + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + 6);
  return d.toISOString().slice(0, 10);
}

// Tablo (supabase/fatura-fiyat.sql) yoksa ya da okunamazsa null: çağıranlar
// faturasız eski yola düşer, yükleme/motor bozulmaz.
export async function faturaIndeksiYukle(
  db: SupabaseClient,
  retailer: string,
): Promise<FaturaIndeksi | null> {
  if (!FATURALI_KANAL.has(retailer)) return null;
  try {
    const rows = await fetchAllRows<FaturaSatiri & { id: number }>(
      (from, to) =>
        db
          .from("fatura_fiyat")
          .select("id, barkod, tarih, net_fiyat, miktar, iade")
          .eq("retailer", retailer)
          .order("id")
          .range(from, to),
      { label: `fatura_fiyat ${retailer}` },
    );
    const idx = faturaIndeksi(rows);
    return idx.size ? idx : null;
  } catch (e) {
    console.error(
      `fatura_fiyat okunamadı (${retailer}) — medyan fiyata düşüldü:`,
      (e as Error).message,
    );
    return null;
  }
}
