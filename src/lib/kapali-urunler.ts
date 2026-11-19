// KAPANMIŞ ÜRÜNLER — satıştan çekilmiş / tasfiye edilmiş kalemler.
//
// NEDEN BU DOSYA VAR: bir ürün firmanın haftalık raporundan düştüğünde sistem
// onu "bayat" sayar ve STOK TEYİDİ ister — çünkü stoğun gerçekten orada olup
// olmadığı BİLİNMEZ. Doğru davranış budur: bilinmeyen bir stok üzerinde çek /
// likide et kararı üretmek yanlış olur.
//
// Ama teyit alındıktan sonra cevabın kaydedileceği bir yer gerekiyor, yoksa
// sistem aynı soruyu her hafta yeniden soruyor. Bu dosya o cevabı tutar.
//
// TARİHİ SİLMİYORUZ: bu kalemlerin geçmiş satış ve stok verileri fact_weekly'de
// aynen duruyor (Şubat'ta o stok GERÇEKTEN vardı). Kapatılan tek şey, son
// bilinen stoğun BUGÜNÜN stoğu gibi taşınması ve karar üretmesi.
//
// NİYE KOD, NİYE TABLO DEĞİL: kapanma nadir bir olay (bugün 8 kalem) ve her
// biri bir insan kararı — kim, ne zaman, hangi gerekçeyle kapattı bilgisi
// sürüm kontrolünde durması gereken bir kayıt. Sayı büyürse tabloya taşınır.
//
// EKLEME KURALI: `sku_name` firmanın raporunda geçen adın BİREBİR aynısı olmalı
// (normalizasyon sonrası hâli — sondaki ", N/A" atılmış, çoklu boşluk teke
// inmiş). Barkod varsa yaz; barkodsuz gelen firmalarda (Toyzz) null kalır ve
// eşleşme ad üzerinden yapılır.

export interface KapaliUrun {
  retailer: string;
  sku_name: string;
  barkod: string | null;
  /** Kapanma nedeni — ekranda ve raporlarda bu metin gösterilir. */
  neden: "tasfiye" | "satistan-cekildi" | "iade-alindi";
  /** Kararın alındığı tarih (YYYY-MM-DD) — geçmişe dönük soruların cevabı. */
  tarih: string;
  /** Kapanma anındaki son bilinen stok — izlenebilirlik için, hesapta KULLANILMAZ. */
  sonStok: number;
}

// 2026-09-01: Sevimli Canavar serisi, Taraftar Kupaları ve üç küçük Nezih kalemi
// tasfiye edildi (satıştan çekilip elden çıkarıldı). Toplam 8 kalem / 7.925 adet /
// ₺923.906 raf değeri. Bu kalemler Şubat-Haziran arasında firmaların raporlarından
// düşmüştü ve o tarihten beri "teyit bekliyor" olarak duruyorlardı.
export const KAPALI_URUNLER: KapaliUrun[] = [
  { retailer: "Toyzz", sku_name: "ASP-MYT-KART SEVİMLİ CANAVAR SÜRPRİZ PAKET 7Lİ 36D.", barkod: null, neden: "tasfiye", tarih: "2026-09-01", sonStok: 7037 },
  { retailer: "Toyzz", sku_name: "ASP-KUPA SEVİMLİ CANAVAR 12A.", barkod: "8682053874733", neden: "tasfiye", tarih: "2026-09-01", sonStok: 828 },
  { retailer: "DR", sku_name: "Mythos Beşiktaş Taraftar Kupaları", barkod: "8697788710171", neden: "tasfiye", tarih: "2026-09-01", sonStok: 26 },
  { retailer: "DR", sku_name: "Mythos Fenerbahçe Taraftar Kupaları", barkod: "8697788738588", neden: "tasfiye", tarih: "2026-09-01", sonStok: 19 },
  { retailer: "DR", sku_name: "Mythos Galatasaray Taraftar Kupalar", barkod: "8697788750580", neden: "tasfiye", tarih: "2026-09-01", sonStok: 11 },
  { retailer: "Nezih", sku_name: "Topps Match Attax Extra - Starter Pack", barkod: "5053307074651", neden: "tasfiye", tarih: "2026-09-01", sonStok: 2 },
  { retailer: "Nezih", sku_name: "Mythos GTA Efsaneleri", barkod: "9786259502502", neden: "tasfiye", tarih: "2026-09-01", sonStok: 1 },
  { retailer: "Nezih", sku_name: "Mythos Mythos Cards Mystery Box", barkod: "8684051260327", neden: "tasfiye", tarih: "2026-09-01", sonStok: 1 },
];

// Hızlı arama için iki indeks: (firma|ad) ve (firma|barkod).
// İkisi birlikte tutuluyor çünkü firmalar arasında anahtar tutarsız — Toyzz
// barkod göndermiyor, D&R gönderiyor; aynı ürün iki firmada iki farklı adla
// geçebiliyor. Tek anahtara güvenmek bu sistemde daha önce yanlış pozitif
// üretmişti (bkz. api/routing içindeki bayat tespiti notu).
const AD_INDEX = new Set(KAPALI_URUNLER.map((k) => k.retailer + "|" + k.sku_name));
const BARKOD_INDEX = new Set(
  KAPALI_URUNLER.filter((k) => k.barkod).map((k) => k.retailer + "|" + k.barkod)
);

/** Bu kalem kapandı mı? Ad VEYA barkod eşleşmesi yeterlidir. */
export function kapaliMi(retailer: string, sku_name?: string | null, barkod?: string | null): boolean {
  if (sku_name && AD_INDEX.has(retailer + "|" + sku_name)) return true;
  if (barkod && BARKOD_INDEX.has(retailer + "|" + barkod)) return true;
  return false;
}

/** Kapanma kaydını döndürür (neden/tarih göstermek için). */
export function kapaliKayit(retailer: string, sku_name?: string | null, barkod?: string | null): KapaliUrun | null {
  return (
    KAPALI_URUNLER.find(
      (k) =>
        k.retailer === retailer &&
        ((sku_name != null && k.sku_name === sku_name) || (barkod != null && k.barkod === barkod))
    ) ?? null
  );
}

export const KAPALI_TOPLAM = {
  n: KAPALI_URUNLER.length,
  stok: KAPALI_URUNLER.reduce((a, k) => a + k.sonStok, 0),
};
