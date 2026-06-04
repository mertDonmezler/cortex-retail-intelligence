// Kanal çalışma koşulları (2026-06 tablosu).
// NET KAZANÇ = PSF brüt × (1 − çalışma marjı%) ÷ (1 + KDV).
//   Örn. 100 ₺, marj %35 → 65 → ÷1,20 = 54,17 ₺.
// "Para gösterdiğimiz" her yerde ciro = bu net değerdir; ham (brüt) veri DB'de
// kalır, dönüşüm okuma anında yapılır (marj değişince tek nokta).
export interface ChannelTerms {
  margin: number;        // çalışma marjı % (kanalın aldığı pay)
  payment: string;       // ödeme tipi (bilgi)
  vadeDays: number | null; // vade gün (bilgi)
}

export const KDV_RATE = 0.20;

export const CHANNEL_TERMS: Record<string, ChannelTerms> = {
  Toyzz: { margin: 50, payment: "Satıştan Ödeme", vadeDays: 150 },
  DR: { margin: 47, payment: "Satıştan Ödeme", vadeDays: 90 },
  "Armağan": { margin: 47, payment: "Satıştan Ödeme", vadeDays: 95 },
  Huppaluppo: { margin: 45, payment: "Satıştan Ödeme", vadeDays: 30 },
  Nezih: { margin: 43, payment: "Faturadan", vadeDays: 150 },
};

// Brüt PSF cirosunu net kazanca çeviren çarpan (kanala göre).
export function netFactor(retailer: string): number {
  const t = CHANNEL_TERMS[retailer];
  const m = t ? t.margin : 0; // tanımsız kanal → marj 0 (yalnız KDV düşülür)
  return (1 - m / 100) / (1 + KDV_RATE);
}

// Satır dizisinde sales_value'yu net kazanca çevirir (retailer alanına göre).
export function netRows<T extends { retailer: string; sales_value: number | null }>(rows: T[]): T[] {
  return rows.map((r) => ({
    ...r,
    sales_value: r.sales_value == null ? null : Number(r.sales_value) * netFactor(r.retailer),
  }));
}
