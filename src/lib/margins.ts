// Kanal çalışma koşulları (2026-06 tablosu).
// NET KAZANÇ = PSF brüt × (1 − çalışma marjı%) ÷ (1 + KDV).
//   Örn. 100 ₺, marj %35 → 65 → ÷1,20 = 54,17 ₺.
// "Para gösterdiğimiz" her yerde ciro = bu net değerdir; ham (brüt) veri DB'de
// kalır, dönüşüm okuma anında yapılır (marj değişince tek nokta).
export interface ChannelTerms {
  margin: number; // çalışma marjı % (kanalın aldığı pay)
  payment: string; // ödeme tipi (bilgi)
  vadeDays: number | null; // vade gün (bilgi)
}

export const KDV_RATE = 0.2;

export const CHANNEL_TERMS: Record<string, ChannelTerms> = {
  Toyzz: { margin: 50, payment: "Satıştan Ödeme", vadeDays: 90 }, // 2026-10-29: 150 değil 90 (kullanıcı teyidi)
  DR: { margin: 47, payment: "Satıştan Ödeme", vadeDays: 90 },
  Armağan: { margin: 47, payment: "Satıştan Ödeme", vadeDays: 95 },
  Huppaluppo: { margin: 45, payment: "Satıştan Ödeme", vadeDays: 30 },
  Nezih: { margin: 43, payment: "Faturadan", vadeDays: 150 },
};

// Kanal adı toleransı: raporlarda/tablolarda ad küçük farklarla gelebiliyor
// ("toyzz", "TOYZZ", sonunda boşluk, "D&R" ↔ "DR"). Bu fark tanımsız kanala
// düşmek demek, o da aşağıdaki nedenle cirosu ~2× şişmiş bir kanal demek —
// yani bir harf farkı sessizce yanlış rakam üretiyordu. Anahtarlar bir kez
// katlanıp (fold) sözlüğe alınır; bilinen 5 kanalın davranışı değişmez.
// KÜÇÜLTME TÜRKÇE LOCALE İLE YAPILMAZ.
// toLocaleLowerCase("tr") ASCII "I" harfini "ı"ya çeviriyor:
//   fold("Nezih") = "nezih"   ama   fold("NEZIH") = "nezıh"  → EŞLEŞMEZ
// Eşleşmeyen ad tanımsız kanala düşüyor, netFactor 0,8333 dönüyor ve o kanalın
// net cirosu gerçeğin ~1,75 katı çıkıyor (aşağıdaki nota bak). Raporlarda ve
// elle yazılan filtrelerde büyük harfli ad son derece olağan.
// Çözüm: Türkçe'ye özgü harfler AÇIKÇA eşlenir, küçültme locale'siz yapılır —
// week-parser.ts'teki foldTr ile aynı yaklaşım.
const TR_HARF: Record<string, string> = {
  İ: "i",
  I: "i",
  ı: "i",
  Ş: "s",
  ş: "s",
  Ğ: "g",
  ğ: "g",
  Ü: "u",
  ü: "u",
  Ö: "o",
  ö: "o",
  Ç: "c",
  ç: "c",
};
function fold(s: string): string {
  return s
    .replace(/&/g, "")
    .replace(/\s+/g, "")
    .replace(/[İIıŞşĞğÜüÖöÇç]/g, (c) => TR_HARF[c] ?? c)
    .toLowerCase();
}
const TERMS_BY_FOLD = new Map(
  Object.entries(CHANNEL_TERMS).map(([k, v]) => [fold(k), v]),
);

// Bilinmeyen kanal bir kez loglanır (her satırda değil): netFactor satır başına
// çağrılıyor, uyarıyı frenlemezsek tek istek binlerce satır log basar.
const warnedChannels = new Set<string>();

export function termsOf(retailer: string): ChannelTerms | null {
  return CHANNEL_TERMS[retailer] ?? TERMS_BY_FOLD.get(fold(retailer)) ?? null;
}

// Brüt PSF cirosunu net kazanca çeviren çarpan (kanala göre).
//
// TANIMSIZ KANAL ARTIK SESSİZ DEĞİL. Eski davranış: bilinmeyen kanalda marj %0
// varsayılıp yalnız KDV düşülüyordu (çarpan 0,8333). Bilinen kanalların çarpanı
// 0,4167-0,4750 aralığında olduğu için bu, o kanalın net cirosunu GERÇEĞİN ~2
// KATI gösteriyordu ve hiçbir yerde uyarı yoktu. Gerçekleşme yolu teorik değil:
// yeni bir kanal eklenip bu tabloya yazılmazsa, ya da bir firmanın adı raporda
// farklı yazılırsa (ör. "D&R") o kanal buraya düşer.
// Çarpan değeri BİLİNÇLİ olarak korundu (null döndürmek çağıran 20+ yeri
// NaN/çökme riskiyle değiştirmek olurdu); ama artık sunucu logunda görünür ve
// `termsOf` ile çağıran taraf kanalın tanımlı olup olmadığını sorabilir.
export function netFactor(retailer: string): number {
  const t = termsOf(retailer);
  if (!t && !warnedChannels.has(retailer)) {
    warnedChannels.add(retailer);
    console.error(
      `margins: TANIMSIZ KANAL "${retailer}" — marj %0 varsayıldı, bu kanalın net cirosu ` +
        `gerçeğin ~2 katı görünüyor. lib/margins.ts içindeki CHANNEL_TERMS'e ekle.`,
    );
  }
  const m = t ? t.margin : 0;
  return (1 - m / 100) / (1 + KDV_RATE);
}

// Satır dizisinde sales_value'yu net kazanca çevirir (retailer alanına göre).
export function netRows<
  T extends { retailer: string; sales_value: number | null },
>(rows: T[]): T[] {
  return rows.map((r) => ({
    ...r,
    sales_value:
      r.sales_value == null
        ? null
        : Number(r.sales_value) * netFactor(r.retailer),
  }));
}
