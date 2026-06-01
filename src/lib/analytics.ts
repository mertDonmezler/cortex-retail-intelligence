// Analytics motoru — türetilmiş metrikler. Saf fonksiyonlar, test edilebilir.
// Hem client hem server tarafında kullanılır.

export interface WeekPoint {
  week_start: string;
  sales_qty: number;
  sales_value: number | null;
  stock_qty: number;
}

/** Lineer regresyon eğimi (basit en küçük kareler). x = indeks, y = değer. */
export function linregSlope(values: number[]): number {
  const n = values.length;
  if (n < 2) return 0;
  const xs = values.map((_, i) => i);
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = values.reduce((a, b) => a + b, 0) / n;
  let num = 0, den = 0;
  for (let i = 0; i < n; i++) {
    num += (xs[i] - mx) * (values[i] - my);
    den += (xs[i] - mx) ** 2;
  }
  return den === 0 ? 0 : num / den;
}

/** Momentum: son `window` haftanın eğiminin, ortalama satışa oranı (%). */
export function momentum(series: WeekPoint[], window = 4): number | null {
  if (series.length < 2) return null;
  const recent = series.slice(-window);
  const qty = recent.map((p) => p.sales_qty);
  const slope = linregSlope(qty);
  const avg = qty.reduce((a, b) => a + b, 0) / qty.length;
  if (avg === 0) return null;
  return (slope / avg) * 100; // haftalık % değişim ivmesi
}

/** Hareketli ortalama tahmini: son `window` haftanın ağırlıklı ortalaması. */
export function forecastNextWeek(series: WeekPoint[], window = 4): number | null {
  if (series.length < 2) return null;
  const recent = series.slice(-window);
  // Son haftaya daha çok ağırlık (lineer ağırlık)
  let wsum = 0, vsum = 0;
  recent.forEach((p, i) => {
    const w = i + 1;
    wsum += w;
    vsum += w * p.sales_qty;
  });
  const wma = vsum / wsum;
  // Trend eğimini ekle
  const slope = linregSlope(recent.map((p) => p.sales_qty));
  return Math.max(0, wma + slope * 0.5);
}

/** Z-score bazlı anomali: son haftanın geçmiş ortalamadan sapması. */
export function anomalyScore(series: WeekPoint[]): { z: number; isAnomaly: boolean } | null {
  if (series.length < 4) return null;
  const hist = series.slice(0, -1).map((p) => p.sales_qty);
  const last = series[series.length - 1].sales_qty;
  const mean = hist.reduce((a, b) => a + b, 0) / hist.length;
  const variance = hist.reduce((a, b) => a + (b - mean) ** 2, 0) / hist.length;
  const sd = Math.sqrt(variance);
  if (sd === 0) return { z: 0, isAnomaly: false };
  const z = (last - mean) / sd;
  return { z, isAnomaly: Math.abs(z) >= 2 };
}

/** Sell-through rate: satış / (satış + stok). Stok devir verimliliği. */
export function sellThrough(salesQty: number, stockQty: number): number | null {
  const denom = salesQty + stockQty;
  if (denom === 0) return null;
  return (salesQty / denom) * 100;
}

/** Stockout tahmini: mevcut stok / haftalık satış hızı = kaç hafta yeter. */
export function weeksOfStock(stockQty: number, weeklySales: number): number | null {
  if (weeklySales <= 0) return null; // satış yoksa "sonsuz"
  return stockQty / weeklySales;
}

/** WoW yüzde değişim. */
export function wowPct(cur: number, prev: number | null): number | null {
  if (prev == null || prev === 0) return null;
  return ((cur - prev) / prev) * 100;
}

/** Geçmiş ortalamaya göre yüzde değişim. */
export function vsAvgPct(cur: number, series: WeekPoint[], uptoIndex: number): number | null {
  const hist = series.slice(0, uptoIndex).map((p) => p.sales_qty);
  if (!hist.length) return null;
  const avg = hist.reduce((a, b) => a + b, 0) / hist.length;
  if (avg === 0) return null;
  return ((cur - avg) / avg) * 100;
}
