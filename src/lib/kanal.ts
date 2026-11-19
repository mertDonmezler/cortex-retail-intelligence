// ── KANAL SAYFASI — saf hesaplar ve ad/slug eşlemesi ──
//
// "Kanal" ekranı bir firmanın TÜM ürünlerini tek tabloda gösterir: bu hafta,
// geçen hafta, değişim, son 4 hafta ortalaması, stok, kapsam, brüt/net ciro,
// ve istenirse tüm haftalar kolon kolon açılır.
//
// Buradaki fonksiyonlar SAF tutuldu (DB yok, fetch yok) — scripts/test.ts
// bunları doğrudan sınıyor. API yalnız veri çekip bunları çağırır.
import { gecikmeHaftasi, GECIKME_ROZET } from "./compute";

import { RETAILERS } from "./normalizers/types";

// URL'de Türkçe karakter ve "&" taşımamak için sabit slug'lar. Slug DEĞİŞTİRİLEMEZ:
// kaydedilmiş bağlantılar bozulur.
const SLUG: Record<string, string> = {
  Toyzz: "toyzz", DR: "dr", Nezih: "nezih", "Armağan": "armagan", Huppaluppo: "huppaluppo",
};
// Ekranda görünen ad — "DR" veritabanı anahtarı, kullanıcı "D&R" görür.
const AD: Record<string, string> = { DR: "D&R" };

export function slugOf(retailer: string): string {
  return SLUG[retailer] ?? retailer.toLowerCase();
}
export function retailerFromSlug(slug: string): string | null {
  const s = String(slug ?? "").toLowerCase();
  for (const r of RETAILERS) if (SLUG[r] === s) return r;
  return null;
}
export function kanalAdi(retailer: string): string {
  return AD[retailer] ?? retailer;
}
/** Menü sırası — büyükten küçüğe değil, kullanıcının alışkın olduğu sıra. */
export const KANALLAR: string[] = ["Toyzz", "DR", "Nezih", "Armağan", "Huppaluppo"];

// ── Hafta serisi tipleri ──
export interface HaftaKayit { qty: number; value: number | null; stock: number }
export interface KanalSku {
  sku_name: string;
  barkod: string | null;
  psf: number | null;
  /** PSF nereden geldi — ekranda tahmini fiyatı işaretlemek için. */
  psfKaynak: "rapor" | "ciro" | "fiyat-listesi" | null;
  seri: Record<string, HaftaKayit>;
  qty: number;          // bu hafta adet
  prevQty: number;      // geçen hafta adet
  stock: number;        // bu hafta stok
  prevStock: number;
  brut: number | null;  // bu hafta brüt PSF cirosu
  net: number | null;   // bu hafta net karşılık
  hiz: number;          // son N raporlanan haftanın ortalaması
  kapsam: number | null;// stok / hız (hafta)
  degisim: number | null; // adet değişimi %
  ilkHafta: string;     // katalogda ilk görüldüğü hafta
  satanHafta: number;   // satış > 0 olan hafta sayısı
}

/** Adet değişimi yüzdesi. Payda 0 ise oran tanımsızdır (∞ değil) → null. */
export function degisimYuzde(cur: number, prev: number): number | null {
  if (!prev) return null;
  return ((cur - prev) / prev) * 100;
}

/**
 * HIZ: son `n` RAPORLANAN hafta üzerinden ortalama.
 * Payda, ürünün rafta olduğu hafta sayısıdır (en az 1) — pencerenin boyu değil.
 * Neden: ürün 3 hafta önce katalogda yokken 4'e bölmek hızı yapay düşürür ve
 * kapsamı şişirir. Aynı kural compute.ts/findStockoutRisks'te de geçerli.
 */
export function hizHesapla(seri: Record<string, HaftaKayit>, haftalar: string[], n = 4): number {
  const pencere = haftalar.slice(-n);
  let toplam = 0, rafta = 0;
  for (const w of pencere) {
    const k = seri[w];
    if (!k) continue;          // o hafta katalogda yok → paydaya girmez
    toplam += k.qty; rafta++;
  }
  if (!rafta) return 0;
  return Math.round((toplam / rafta) * 10) / 10;
}

/** KAPSAM: eldeki stok mevcut hızla kaç hafta yeter. Hız 0 ise tanımsız (∞ değil). */
export function kapsamHesapla(stock: number, hiz: number): number | null {
  if (!hiz || hiz <= 0) return null;
  return Math.round((stock / hiz) * 10) / 10;
}

/**
 * PSF SEÇİMİ — zincirli yedek. Firmalar arasında fiyat kaynağı değişiyor:
 * Toyzz/Armağan raporunda PSF var (231/231, 147/147); Huppaluppo'da hiç yok
 * (0/49) ama ciro var → birim fiyat cirodan türetilir; D&R'de 273 üründen
 * yalnız 80'inde PSF var, kalanı barkodlu fiyat listesinden gelir.
 * Sıra bilinçli: firmanın kendi raporu > kendi cirosu > dış fiyat listesi.
 */
export function psfSec(
  raporPsf: number | null | undefined,
  seri: Record<string, HaftaKayit>,
  haftalar: string[],
  listePsf: number | null | undefined
): { psf: number | null; kaynak: KanalSku["psfKaynak"] } {
  // Kaynak dosyalarda PSF kayan nokta artığı taşıyor (2549.9900000000002 gibi,
  // 232 kalemin 30'unda). Ciroda etkisi trilyonda bir kuruş ama ekranda ve
  // CSV'de çirkin görünüyor ve eşitlik karşılaştırmasını bozuyor → 2 haneye sabitlenir.
  if (raporPsf != null && raporPsf > 0) return { psf: Math.round(raporPsf * 100) / 100, kaynak: "rapor" };
  // En YENİ satışlı haftadan geriye doğru: birim fiyat = ciro / adet.
  for (let i = haftalar.length - 1; i >= 0; i--) {
    const k = seri[haftalar[i]];
    if (k && k.qty > 0 && k.value != null && k.value > 0) {
      return { psf: Math.round((k.value / k.qty) * 100) / 100, kaynak: "ciro" };
    }
  }
  if (listePsf != null && listePsf > 0) return { psf: listePsf, kaynak: "fiyat-listesi" };
  return { psf: null, kaynak: null };
}

/**
 * Bir SKU'nun satırını kurar. `haftalar` firmanın KENDİ raporladığı haftalar
 * (artan sırada); son eleman "bu hafta", bir öncesi "geçen hafta".
 */
export function skuSatiri(
  sku_name: string,
  barkod: string | null,
  seri: Record<string, HaftaKayit>,
  haftalar: string[],
  raporPsf: number | null | undefined,
  listePsf: number | null | undefined,
  netCarpan: number,
  hizPencere = 4
): KanalSku {
  const son = haftalar[haftalar.length - 1];
  const onceki = haftalar[haftalar.length - 2];
  const cur = seri[son] ?? { qty: 0, value: null, stock: 0 };
  const prev = onceki ? (seri[onceki] ?? { qty: 0, value: null, stock: 0 }) : { qty: 0, value: null, stock: 0 };
  const { psf, kaynak } = psfSec(raporPsf, seri, haftalar, listePsf);
  // BRÜT: firmanın bildirdiği ciro varsa O kullanılır (gerçek rakam), yoksa
  // PSF × adet ile türetilir. Türetilmiş olan ekranda ayrıca işaretlenmez —
  // çünkü iki firmada ciro zaten PSF × adet olarak geliyor; ayrım bilgi taşımaz.
  const brut = cur.value != null && cur.value > 0 ? cur.value : (psf != null ? Math.round(psf * cur.qty * 100) / 100 : null);
  const hiz = hizHesapla(seri, haftalar, hizPencere);
  const ilkHafta = haftalar.find((w) => seri[w] != null) ?? son;
  let satanHafta = 0;
  for (const w of haftalar) if ((seri[w]?.qty ?? 0) > 0) satanHafta++;
  return {
    sku_name, barkod, psf, psfKaynak: kaynak, seri,
    qty: cur.qty, prevQty: prev.qty, stock: cur.stock, prevStock: prev.stock,
    brut, net: brut == null ? null : Math.round(brut * netCarpan * 100) / 100,
    hiz, kapsam: kapsamHesapla(cur.stock, hiz),
    degisim: degisimYuzde(cur.qty, prev.qty),
    ilkHafta, satanHafta,
  };
}


// ═══════════════════════ KANAL ŞERİDİ (ana sayfa) ═══════════════════════
//
// Ana sayfada grafiğin üstünde duran beş kartın tek hesap yeri. Üç soruyu
// cevaplar ve ÜÇÜNÜ AYNI ANDA cevaplamak zorundadır:
//   1) Bu kanalın verisi güncel mi?
//   2) Adet geçen haftaya göre ne yaptı?
//   3) TL (net karşılık) geçen haftaya göre ne yaptı?
//
// NEDEN AYRI BİR FONKSİYON: aynı sayı eskiden iki bantta iki farklı tanımla
// hesaplanıyordu (VERİ DURUMU freshness'tan, FİRMA DEĞİŞİMİ overview'dan) ve
// ikisi Nezih'te ayrışıyordu. Tek tanım, tek yer, testli.
//
// KIYAS HER ZAMAN KANALIN KENDİ İKİ HAFTASI. Ağ kohortu kullanılmaz: firmalar
// aynı gün rapor göndermiyor, ortak hafta zorlandığında raporlamayan firma "0"
// gibi görünüyor. Kendi iki haftası kıyaslandığında payda hep dolu.
//
// İKİ HAFTA ARDIŞIK OLMAYABİLİR (ör. 27 Tem ↔ 03 Ağu değil, 20 Tem ↔ 03 Ağu).
// `ardisik` bunu söyler; ekran "geçen hafta" yerine iki tarihi de yazar.
export type OzetHafta = {
  retailer: string; week_start: string;
  sales_qty: number; sales_value: number | null; stock_qty: number;
};
export type KanalOzet = {
  retailer: string;
  dataWeek: string | null;
  prevWeek: string | null;
  ardisik: boolean;
  // İki rapor arasındaki hafta sayısı. Ekran "31 Ağu ↔ 07 Eyl" yerine
  // "bir önceki haftaya göre" yazabilsin diye var: kıyasın MESAFESİ sorulan şey,
  // iki tarihin kendisi değil. null = kıyas yok.
  araHafta: number | null;
  gecikmeHf: number;
  // İKİ AYRI EŞİK — denetimde yakalanan hata bunların tek bayrağa bindirilmesiydi.
  //   guncel: gecikmeHf === 0. TAM EŞİTLİK. "Bu rakam takvim haftasının kendisi."
  //           1 hafta geride olan kanal güncel DEĞİLDİR; tarihini göstermelidir.
  //   bayat:  gecikmeHf >= GECIKME_ROZET (2). Yorum kapısı: yüzdeye yeşil/kırmızı
  //           basılıp basılmayacağını, karşılaştırmaya girip girmeyeceğini belirler.
  // Eskiden tek `guncel = gecikmeHf < 2` vardı ve ekran 31 Ağustos verisine de
  // "GÜNCEL" yazıyordu — 7 Eylül'ünkiyle aynı tazelikte görünüyordu.
  guncel: boolean;
  bayat: boolean;
  adet: number;
  net: number | null;
  stok: number;
  adetWow: number | null;
  netWow: number | null;
};

// İki hafta arası kaç hafta? (aynı hafta 0, ardışık 1). Girdi kanonik Pazartesi
// olduğu için bölme tam sayı verir; yine de yuvarlanır (yaz saati vb. sürprizi).
function haftaFarki(a: string, b: string): number {
  const ms = Date.parse(b + "T00:00:00Z") - Date.parse(a + "T00:00:00Z");
  return Math.round(ms / (7 * 24 * 3600 * 1000));
}

export function kanalOzeti(
  rows: OzetHafta[], retailer: string, sinirHafta: string, referansHafta: string,
): KanalOzet {
  const bos: KanalOzet = {
    retailer, dataWeek: null, prevWeek: null, ardisik: false, araHafta: null,
    gecikmeHf: 99, guncel: false, bayat: true, adet: 0, net: null, stok: 0,
    adetWow: null, netWow: null,
  };
  const mine = rows
    .filter((r) => r.retailer === retailer && (!sinirHafta || r.week_start <= sinirHafta))
    .sort((a, b) => (a.week_start < b.week_start ? -1 : a.week_start > b.week_start ? 1 : 0));
  if (!mine.length) return bos;

  const cur = mine[mine.length - 1];
  const prev = mine.length > 1 ? mine[mine.length - 2] : null;
  const gecikmeHf = gecikmeHaftasi(cur.week_start, referansHafta);
  const cv = cur.sales_value;
  const pv = prev?.sales_value ?? null;
  return {
    retailer,
    dataWeek: cur.week_start,
    prevWeek: prev?.week_start ?? null,
    araHafta: prev ? haftaFarki(prev.week_start, cur.week_start) : null,
    ardisik: !!prev && haftaFarki(prev.week_start, cur.week_start) === 1,
    gecikmeHf,
    guncel: gecikmeHf === 0,
    bayat: gecikmeHf >= GECIKME_ROZET,
    adet: cur.sales_qty ?? 0,
    net: cv == null ? null : cv,
    stok: cur.stock_qty ?? 0,
    // Payda 0 ya da bilinmiyorsa yüzde YOK. 0'dan artışı "%100 büyüme" diye
    // yazmak bu veride sürekli yanlış alarm üretiyordu (degisimYuzde ile aynı kural).
    adetWow: prev && (prev.sales_qty ?? 0) > 0
      ? (((cur.sales_qty ?? 0) - prev.sales_qty) / prev.sales_qty) * 100 : null,
    netWow: cv != null && pv != null && pv > 0 ? ((cv - pv) / pv) * 100 : null,
  };
}
