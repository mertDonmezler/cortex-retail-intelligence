// Saf hesaplama fonksiyonları — Supabase'den ayrılmış, test edilebilir çekirdek.
// API route'lar: Supabase'den veri çek → bu fonksiyonları çağır → JSON dön.

import {
  momentum, anomalyScore, forecastNextWeek, weeksOfStock, wowPct, sellThrough,
  type WeekPoint,
} from "./analytics";
import { RETAILERS } from "./normalizers/types";

export interface FactRow {
  retailer: string;
  week_start: string;
  store: string | null;
  sku_name: string;
  barkod: string | null;
  sales_qty: number;
  sales_value: number | null;
  stock_qty: number;
}

export interface SummaryRow {
  retailer: string;
  week_start: string;
  sales_qty: number;
  sales_value: number | null;
  has_value: boolean;
  stock_qty: number;
  sku_count: number;
  store_count: number;
}

export interface Insight {
  severity: "critical" | "warning" | "positive" | "info";
  retailer: string;
  title: string;
  detail: string;
  metric?: string;
}

// ---------- Özet (fact → weekly_summary eşleniği, test ve fallback için) ----------
export function buildSummary(rows: FactRow[]): SummaryRow[] {
  const map = new Map<string, {
    qty: number; val: number; hasVal: boolean; stock: number;
    skus: Set<string>; stores: Set<string>;
  }>();
  for (const r of rows) {
    const key = `${r.retailer}|${r.week_start}`;
    let e = map.get(key);
    if (!e) { e = { qty: 0, val: 0, hasVal: false, stock: 0, skus: new Set(), stores: new Set() }; map.set(key, e); }
    e.qty += r.sales_qty;
    if (r.sales_value != null) { e.val += r.sales_value; e.hasVal = true; }
    e.stock += r.stock_qty;
    e.skus.add(r.sku_name);
    if (r.store) e.stores.add(r.store);
  }
  return [...map.entries()].map(([key, e]) => {
    const [retailer, week_start] = key.split("|");
    return {
      retailer, week_start,
      sales_qty: e.qty,
      sales_value: e.hasVal ? e.val : null,
      has_value: e.hasVal,
      stock_qty: e.stock,
      sku_count: e.skus.size,
      store_count: e.stores.size,
    };
  }).sort((a, b) => a.week_start.localeCompare(b.week_start));
}

// ---------- Perakendeci kart metrikleri ----------
export function retailerCardMetrics(summary: SummaryRow[], retailer: string, week: string) {
  const series = summary
    .filter((s) => s.retailer === retailer)
    .sort((a, b) => a.week_start.localeCompare(b.week_start));
  const idx = series.findIndex((s) => s.week_start === week);
  if (idx === -1) return null;
  const cur = series[idx];
  const prev = idx > 0 ? series[idx - 1] : null;
  const hist = series.slice(0, idx);
  const avgQty = hist.length ? hist.reduce((a, s) => a + s.sales_qty, 0) / hist.length : null;
  return {
    sales_qty: cur.sales_qty,
    sales_value: cur.has_value ? cur.sales_value : null,
    wow: wowPct(cur.sales_qty, prev?.sales_qty ?? null),
    vs_avg: avgQty && avgQty > 0 ? ((cur.sales_qty - avgQty) / avgQty) * 100 : null,
    history_weeks: hist.length,
    spark: series.slice(0, idx + 1).slice(-10).map((s) => s.sales_qty),
  };
}

// ---------- Insights üretimi ----------
export function generateInsights(
  summary: SummaryRow[],
  skuRisk: { retailer: string; sku: string; wos: number; sales: number; stock: number }[] = []
): Insight[] {
  const insights: Insight[] = [];

  for (const retailer of RETAILERS) {
    const series: WeekPoint[] = summary
      .filter((s) => s.retailer === retailer)
      .sort((a, b) => a.week_start.localeCompare(b.week_start))
      .map((s) => ({ week_start: s.week_start, sales_qty: s.sales_qty, sales_value: s.sales_value, stock_qty: s.stock_qty }));
    if (series.length < 2) continue;

    const last = series[series.length - 1];
    const prev = series[series.length - 2];
    // WoW sinyali CİRO (TL) bazlı; ciro yoksa adet'e düşer.
    const wowV = last.sales_value != null && prev.sales_value != null ? wowPct(last.sales_value, prev.sales_value) : null;
    const wowIsVal = wowV != null;
    const wow = wowV ?? wowPct(last.sales_qty, prev.sales_qty);
    const mom = momentum(series, 4);
    const anom = anomalyScore(series);
    const fc = forecastNextWeek(series, 4);

    if (wow != null && Math.abs(wow) >= 25) {
      insights.push({
        severity: wow > 0 ? "positive" : "warning",
        retailer,
        title: `${retailer} ${wow > 0 ? "sıçradı" : "düştü"}: ${wow >= 0 ? "+" : ""}${wow.toFixed(0)}%`,
        detail: wowIsVal
          ? `Ciro geçen hafta ₺${Math.round(prev.sales_value!).toLocaleString("tr-TR")} → bu hafta ₺${Math.round(last.sales_value!).toLocaleString("tr-TR")}.`
          : `Geçen hafta ${Math.round(prev.sales_qty).toLocaleString("tr-TR")} adetten bu hafta ${Math.round(last.sales_qty).toLocaleString("tr-TR")} adede.`,
        metric: `${wow >= 0 ? "+" : ""}${wow.toFixed(1)}% WoW${wowIsVal ? " (TL)" : ""}`,
      });
    }
    if (mom != null && Math.abs(mom) >= 8) {
      insights.push({
        severity: mom > 0 ? "positive" : "info",
        retailer,
        title: `${retailer} ${mom > 0 ? "ivme kazanıyor" : "ivme kaybediyor"}`,
        detail: `Son 4 haftalık trend ${mom > 0 ? "yukarı" : "aşağı"} yönlü (${mom >= 0 ? "+" : ""}${mom.toFixed(1)}%/hafta).`,
        metric: `momentum ${mom >= 0 ? "+" : ""}${mom.toFixed(1)}%`,
      });
    }
    if (anom?.isAnomaly) {
      insights.push({
        severity: anom.z > 0 ? "positive" : "warning",
        retailer,
        title: `${retailer} olağandışı hafta`,
        detail: `Bu haftanın satışı geçmiş ortalamadan ${Math.abs(anom.z).toFixed(1)} standart sapma ${anom.z > 0 ? "yukarıda" : "aşağıda"}.`,
        metric: `z=${anom.z.toFixed(1)}`,
      });
    }
    if (fc != null) {
      insights.push({
        severity: "info",
        retailer,
        title: `${retailer} gelecek hafta tahmini`,
        detail: `Trend + ağırlıklı ortalamaya göre ~${Math.round(fc).toLocaleString("tr-TR")} adet bekleniyor.`,
        metric: `~${Math.round(fc).toLocaleString("tr-TR")} adet`,
      });
    }
  }

  for (const r of skuRisk) {
    insights.push({
      severity: "critical",
      retailer: r.retailer,
      title: `${r.retailer}: "${r.sku.slice(0, 40)}" tükenmek üzere`,
      detail: `Stok ${r.stock}, haftalık ~${r.sales} satıyor → tahminen ${r.wos.toFixed(1)} hafta içinde biter.`,
      metric: `${r.wos.toFixed(1)} hafta`,
    });
  }

  const order = { critical: 0, warning: 1, positive: 2, info: 3 };
  insights.sort((a, b) => order[a.severity] - order[b.severity]);
  return insights;
}

// Stockout riski olan SKU'ları bul (son 4 hafta satış hızı + son stok)
export function findStockoutRisks(
  rows: FactRow[], retailer: string, recentWeeks: string[]
): { retailer: string; sku: string; wos: number; sales: number; stock: number }[] {
  const latest = recentWeeks[recentWeeks.length - 1];
  const salesBy = new Map<string, Map<string, number>>();
  const stockLatest = new Map<string, number>();
  for (const r of rows) {
    if (!salesBy.has(r.sku_name)) salesBy.set(r.sku_name, new Map());
    const m = salesBy.get(r.sku_name)!;
    m.set(r.week_start, (m.get(r.week_start) ?? 0) + r.sales_qty);
    if (r.week_start === latest) stockLatest.set(r.sku_name, (stockLatest.get(r.sku_name) ?? 0) + r.stock_qty);
  }
  const risks: { retailer: string; sku: string; wos: number; sales: number; stock: number }[] = [];
  for (const [sku, wmap] of salesBy) {
    const vals = recentWeeks.map((w) => wmap.get(w) ?? 0);
    const avg = vals.reduce((a, b) => a + b, 0) / vals.length;
    const stock = stockLatest.get(sku) ?? 0;
    const wos = weeksOfStock(stock, avg);
    if (wos != null && wos < 2 && avg >= 3) risks.push({ retailer, sku, wos, sales: Math.round(avg), stock });
  }
  risks.sort((a, b) => a.wos - b.wos);
  return risks.slice(0, 2);
}

// ---------- Stok alarm ----------
export function computeStockAlerts(
  latestRows: FactRow[], prevRows: FactRow[], critical: number, dropPct: number
) {
  const agg = (rows: FactRow[], field: "stock_qty" | "sales_qty") => {
    const m = new Map<string, number>();
    for (const r of rows) m.set(r.sku_name, (m.get(r.sku_name) ?? 0) + r[field]);
    return m;
  };
  const stockNow = agg(latestRows, "stock_qty");
  const salesNow = agg(latestRows, "sales_qty");
  const stockPrev = agg(prevRows, "stock_qty");

  const criticalList: any[] = [];
  const decliningList: any[] = [];
  for (const [sku, stock] of stockNow) {
    const sales = salesNow.get(sku) ?? 0;
    if (stock <= critical) criticalList.push({ sku_name: sku, stock_qty: stock, sales_qty: sales });
    const ps = stockPrev.get(sku);
    if (ps && ps > 0) {
      const pct = ((stock - ps) / ps) * 100;
      if (pct <= -dropPct) decliningList.push({ sku_name: sku, prev: ps, now: stock, pct: Math.round(pct * 10) / 10, sales_qty: sales });
    }
  }
  criticalList.sort((a, b) => a.stock_qty - b.stock_qty);
  decliningList.sort((a, b) => a.pct - b.pct);
  return { critical: criticalList, declining: decliningList.slice(0, 30) };
}

// ---------- Sipariş önceliği: hızlı satıp stoğu yetmeyecek SKU'lar ----------
// Tek başına "düşük stok" ölü/kayıp stoğu öne çıkarır ve aksiyon üretmez.
// Asıl sinyal: son haftalarda istikrarlı satan AMA mevcut stoğu bu hıza
// yetmeyecek ürünler. Hız = son N haftanın HAFTALIK ORTALAMA satışı (tek
// haftanın oynaklığını törpüler); stok = en güncel haftanın stoğu.
export interface ReorderRow {
  sku_name: string;
  barkod: string | null;
  avg_sales: number;    // son N haftanın haftalık ortalama satışı (hız)
  last_sales: number;   // son hafta satış
  stock_qty: number;    // son hafta stok
  sales_value: number;  // son hafta ciro (TL)
  cover: number | null; // kaç hafta yeter = stok / haftalık ort. satış
  weeks_used: number;   // ortalama kaç hafta üzerinden alındı
  status: "tükendi" | "acil" | "izle" | "yeterli";
}

// recentRows: son N haftanın tüm fact satırları; weeks: o N haftanın listesi.
export function reorderPriority(recentRows: FactRow[], weeks: string[], minAvg = 10): ReorderRow[] {
  if (!weeks.length) return [];
  const sorted = [...weeks].sort();
  const latest = sorted[sorted.length - 1];
  const n = sorted.length;
  const inWindow = new Set(sorted);

  type Agg = { sku: string; barkod: string | null; total: number; last: number; stock: number; val: number };
  const m = new Map<string, Agg>();
  for (const r of recentRows) {
    if (!inWindow.has(r.week_start)) continue;
    const e = m.get(r.sku_name) ?? { sku: r.sku_name, barkod: r.barkod ?? null, total: 0, last: 0, stock: 0, val: 0 };
    e.total += r.sales_qty;
    if (r.week_start === latest) {
      e.last += r.sales_qty;
      e.stock += r.stock_qty;
      e.val += r.sales_value ?? 0;
    }
    if (!e.barkod && r.barkod) e.barkod = r.barkod;
    m.set(r.sku_name, e);
  }

  const out: ReorderRow[] = [];
  for (const e of m.values()) {
    const avg = e.total / n; // haftalık ortalama (pencere boyu = n hafta)
    if (avg < minAvg) continue; // yalnızca anlamlı satanlar (gürültüyü ele)
    const cover = avg > 0 ? e.stock / avg : null;
    let status: ReorderRow["status"];
    if (e.stock <= 0) status = "tükendi";          // satıyor ama stok bitti → kayıp satış
    else if ((cover ?? 0) < 1) status = "acil";    // ort. hıza bu hafta bile yetmez
    else if ((cover ?? 0) < 2) status = "izle";
    else status = "yeterli";
    out.push({
      sku_name: e.sku, barkod: e.barkod,
      avg_sales: Math.round(avg * 10) / 10,
      last_sales: e.last, stock_qty: e.stock, sales_value: e.val,
      cover: cover == null ? null : Math.round(cover * 10) / 10,
      weeks_used: n, status,
    });
  }
  // En acil önce: düşük kapsam (stok/ort. satış) → eşitlikte yüksek ort. satış
  out.sort((a, b) => {
    const ca = a.cover ?? 0, cb = b.cover ?? 0;
    if (ca !== cb) return ca - cb;
    return b.avg_sales - a.avg_sales;
  });
  return out;
}

// ---------- Ürün cross-retailer pivot ----------
export function pivotProduct(rows: FactRow[]) {
  const weeksSet = new Set<string>();
  const byRetailer = new Map<string, Map<string, { qty: number; val: number; stock: number }>>();
  let name = "";
  for (const r of rows) {
    name = r.sku_name;
    weeksSet.add(r.week_start);
    if (!byRetailer.has(r.retailer)) byRetailer.set(r.retailer, new Map());
    const m = byRetailer.get(r.retailer)!;
    const e = m.get(r.week_start) ?? { qty: 0, val: 0, stock: 0 };
    e.qty += r.sales_qty; e.val += r.sales_value ?? 0; e.stock += r.stock_qty;
    m.set(r.week_start, e);
  }
  const weeks = [...weeksSet].sort();
  const series = weeks.map((w) => {
    const row: Record<string, number | string> = { week: w };
    for (const [ret, m] of byRetailer) row[ret] = m.get(w)?.qty ?? 0;
    return row;
  });
  const retailers = [...byRetailer.keys()];
  const totals = retailers.map((ret) => {
    const m = byRetailer.get(ret)!;
    let qty = 0, val = 0; for (const e of m.values()) { qty += e.qty; val += e.val; }
    const lastWeek = weeks[weeks.length - 1];
    return { retailer: ret, total_qty: qty, total_val: val, last_stock: m.get(lastWeek)?.stock ?? 0 };
  });
  return { name, weeks, series, retailers, totals };
}

// ═══════════════════════ ÜRÜN ZEKASI (isim parsing) ═══════════════════════

export interface ProductMeta { brand: string; team: string; type: string; }

const TEAM_PATTERNS: [RegExp, string][] = [
  [/be[şs]ikta[şs]|bjk/i, "Beşiktaş"],
  [/galatasaray|g\.?saray|\bgs\b/i, "Galatasaray"],
  [/fenerbah[çc]e|f\.?bah[çc]e|\bfb\b/i, "Fenerbahçe"],
  [/trabzonspor|\bts\b/i, "Trabzonspor"],
  [/uefa|[şs]amp\.?\s*lig|champions/i, "UEFA/Şampiyonlar Ligi"],
];
const BRAND_PATTERNS: [RegExp, string][] = [
  [/mythos/i, "Mythos"],
  [/topps|topss/i, "Topps"],
  [/panini/i, "Panini"],
  [/match\s*attax/i, "Match Attax"],
];
const TYPE_PATTERNS: [RegExp, string][] = [
  [/mega/i, "Mega Paket"],
  [/booster/i, "Booster"],
  [/starter|ba[şs]lang/i, "Starter"],
  [/album|albüm/i, "Albüm"],
  [/sticker|stic\b|[çc]ıkartma|[çc]krtm/i, "Sticker"],
  [/kutu|karton\s*kutu|kartonkutu/i, "Kutu"],
  [/zarf/i, "Zarf"],
  [/paket|pkt|\bpk\b/i, "Paket"],
  [/kart|card/i, "Kart"],
  [/poster/i, "Poster"],
];

export function parseProductMeta(skuName: string): ProductMeta {
  const find = (pats: [RegExp, string][], dflt: string) => {
    for (const [re, label] of pats) if (re.test(skuName)) return label;
    return dflt;
  };
  return {
    brand: find(BRAND_PATTERNS, "Diğer"),
    team: find(TEAM_PATTERNS, "Genel"),
    type: find(TYPE_PATTERNS, "Diğer"),
  };
}

// Bir boyuta göre (brand|team|type) kategori kırılımı — tek hafta.
export function categoryBreakdown(
  rows: FactRow[], dimension: "brand" | "team" | "type"
): { key: string; sales_qty: number; sales_value: number; sku_count: number }[] {
  const map = new Map<string, { qty: number; val: number; skus: Set<string> }>();
  for (const r of rows) {
    const meta = parseProductMeta(r.sku_name);
    const key = meta[dimension];
    let e = map.get(key);
    if (!e) { e = { qty: 0, val: 0, skus: new Set() }; map.set(key, e); }
    e.qty += r.sales_qty; e.val += r.sales_value ?? 0; e.skus.add(r.sku_name);
  }
  return [...map.entries()]
    .map(([key, e]) => ({ key, sales_qty: e.qty, sales_value: e.val, sku_count: e.skus.size }))
    .sort((a, b) => b.sales_qty - a.sales_qty);
}

// ═══════════════════════ MAĞAZA ZEKASI ═══════════════════════

export interface StorePerf {
  store: string; sales_qty: number; sales_value: number; stock_qty: number; sku_count: number;
}

// Mağaza bazlı performans — sadece store dolu olan (mağaza-bazlı) perakendeciler.
export function storePerformance(rows: FactRow[]): StorePerf[] {
  const map = new Map<string, { qty: number; val: number; stock: number; skus: Set<string> }>();
  for (const r of rows) {
    if (!r.store) continue;
    let e = map.get(r.store);
    if (!e) { e = { qty: 0, val: 0, stock: 0, skus: new Set() }; map.set(r.store, e); }
    e.qty += r.sales_qty; e.val += r.sales_value ?? 0; e.stock += r.stock_qty; e.skus.add(r.sku_name);
  }
  return [...map.entries()]
    .map(([store, e]) => ({ store, sales_qty: e.qty, sales_value: e.val, stock_qty: e.stock, sku_count: e.skus.size }))
    .sort((a, b) => b.sales_qty - a.sales_qty);
}

// ═══════════════════════ ÜRÜN KİMLİĞİ (kanonik anahtar) ═══════════════════════
// Aynı ürünü firmalar arası birleştirmek için: barkod (varsa) → ONAYLI alias
// barkodu (Toyzz vb. isim eşleşmesi) → 'NAME:'||isim (eşleşemeyen tek-firma kalır).
export type AliasMap = Map<string, string>; // `${retailer}|${sku_name}` → barkod
export function productKey(retailer: string, sku_name: string, barkod: string | null | undefined, aliases?: AliasMap): string {
  if (barkod) return barkod;
  const a = aliases?.get(`${retailer}|${sku_name}`);
  return a ?? "NAME:" + sku_name;
}

// ═══════════════════════ GLOBAL SIRALAMALAR ═══════════════════════

export interface RankedSku {
  sku_name: string; retailers: string[]; barkod: string | null;
  sales_qty: number; sales_value: number; stock_qty: number; prev_qty: number; prev_val: number; growth: number | null;
}

// Tüm perakendeciler genelinde SKU sıralaması (top sellers + risers + fallers).
// Büyüme (growth) varsayılan CİRO (TL) bazlı; metric="qty" ile adet bazlı.
export function globalRankings(
  latestRows: FactRow[],
  prevByKey: Map<string, { qty: number; val: number }>,
  metric: "value" | "qty" = "value",
  aliases?: AliasMap
): { top: RankedSku[]; risers: RankedSku[]; fallers: RankedSku[] } {
  // Kanonik ürün anahtarıyla (barkod/alias/isim) firmalar arası birleştir.
  const map = new Map<string, { name: string; barkod: string | null; retailers: Set<string>; qty: number; val: number; stock: number }>();
  for (const r of latestRows) {
    const key = productKey(r.retailer, r.sku_name, r.barkod, aliases);
    let e = map.get(key);
    if (!e) { e = { name: r.sku_name, barkod: r.barkod ?? null, retailers: new Set(), qty: 0, val: 0, stock: 0 }; map.set(key, e); }
    e.qty += r.sales_qty; e.val += r.sales_value ?? 0; e.stock += r.stock_qty; e.retailers.add(r.retailer);
    if (!e.barkod && r.barkod) e.barkod = r.barkod;
    if (r.sku_name.length > e.name.length) e.name = r.sku_name; // temsili (en uzun) isim
  }
  const useVal = metric === "value";
  const ranked: RankedSku[] = [...map.entries()].map(([key, e]) => {
    const p = prevByKey.get(key) ?? { qty: 0, val: 0 };
    const cur = useVal ? e.val : e.qty;
    const prevM = useVal ? p.val : p.qty;
    const growth = prevM > 0 ? ((cur - prevM) / prevM) * 100 : null;
    return { sku_name: e.name, retailers: [...e.retailers].sort(), barkod: e.barkod, sales_qty: e.qty, sales_value: e.val, stock_qty: e.stock, prev_qty: p.qty, prev_val: p.val, growth };
  });

  const top = [...ranked].sort((a, b) => b.sales_qty - a.sales_qty).slice(0, 20);
  // Anlamlı hareket eşiği metriğe göre (ciro: TL tabanı, adet: adet tabanı)
  const floor = useVal ? 100 : 5;
  const movers = ranked.filter((r) => {
    const cur = useVal ? r.sales_value : r.sales_qty;
    const prevM = useVal ? r.prev_val : r.prev_qty;
    return r.growth != null && prevM >= floor && cur >= floor;
  });
  const risers = [...movers].sort((a, b) => (b.growth ?? 0) - (a.growth ?? 0)).slice(0, 15);
  const fallers = [...movers].sort((a, b) => (a.growth ?? 0) - (b.growth ?? 0)).slice(0, 15);
  return { top, risers, fallers };
}

// ═══════════════════════ EXECUTIVE ÖZET ═══════════════════════

export interface ExecOverview {
  network: {
    sales_qty: number; sales_value: number; stock_qty: number;
    sku_count: number; retailer_count: number;
    wow_qty: number | null; wow_value: number | null;
  };
  latest_week: string | null;
  prev_week: string | null;
  retailers: {
    retailer: string; sales_qty: number; sales_value: number | null;
    wow: number | null; value_wow: number | null; share: number;
    has_data: boolean; status: "up" | "down" | "flat" | "nodata";
  }[];
  best: { retailer: string; wow: number } | null;
  worst: { retailer: string; wow: number } | null;
}

// Tüm ağın yönetici özeti — en güncel ortak/maksimum hafta bazında.
export function execOverview(summary: SummaryRow[], targetWeek?: string): ExecOverview {
  const allWeeks = [...new Set(summary.map((s) => s.week_start))].sort();
  const networkLatest = allWeeks[allWeeks.length - 1] ?? null;
  // Gösterilecek hafta: verilmişse o, yoksa en güncel.
  const focus = targetWeek ?? networkLatest;

  if (!focus) {
    return {
      network: { sales_qty: 0, sales_value: 0, stock_qty: 0, sku_count: 0, retailer_count: 0, wow_qty: null, wow_value: null },
      latest_week: null, prev_week: null, retailers: [], best: null, worst: null,
    };
  }

  // Geçen hafta = seçili haftanın tam 7 gün öncesi (kanonik Pazartesi).
  const pd = new Date(focus + "T00:00:00Z");
  pd.setUTCDate(pd.getUTCDate() - 7);
  const prevWeek = pd.toISOString().slice(0, 10);

  const byKey = new Map(summary.map((s) => [`${s.retailer}|${s.week_start}`, s]));
  const retailersInData = [...new Set(summary.map((s) => s.retailer))];

  let netQty = 0, netVal = 0, netStock = 0, netSku = 0;
  // Ağ WoW'u yalnızca HEM bu hafta HEM geçen hafta verisi olan perakendeciler üzerinden
  let bothQty = 0, bothPrevQty = 0, bothVal = 0, bothPrevVal = 0;
  const retailers: ExecOverview["retailers"] = [];

  for (const ret of retailersInData) {
    const cur = byKey.get(`${ret}|${focus}`);
    const prevRec = byKey.get(`${ret}|${prevWeek}`);
    if (!cur) {
      // O haftada veri yok → "veri yok" satırı (sahte büyüme gösterilmez)
      retailers.push({ retailer: ret, sales_qty: 0, sales_value: null, wow: null, value_wow: null, share: 0, has_data: false, status: "nodata" });
      continue;
    }
    const value = cur.has_value ? cur.sales_value : null;
    netQty += cur.sales_qty; netVal += value ?? 0; netStock += cur.stock_qty; netSku += cur.sku_count;
    // Büyüme yalnızca geçen hafta verisi varsa (yoksa null → UI "—" gösterir)
    const wow = prevRec ? wowPct(cur.sales_qty, prevRec.sales_qty) : null;
    const value_wow = (prevRec && prevRec.sales_value != null && value != null)
      ? wowPct(value, prevRec.sales_value) : null;
    if (prevRec) {
      bothQty += cur.sales_qty; bothPrevQty += prevRec.sales_qty;
      if (prevRec.sales_value != null && value != null) { bothVal += value; bothPrevVal += prevRec.sales_value; }
    }
    retailers.push({
      retailer: ret, sales_qty: cur.sales_qty, sales_value: value,
      wow, value_wow, share: 0, has_data: true,
      status: wow == null ? "nodata" : wow > 2 ? "up" : wow < -2 ? "down" : "flat",
    });
  }
  for (const r of retailers) r.share = netQty > 0 ? (r.sales_qty / netQty) * 100 : 0;
  // Veri olanlar önce, sonra satışa göre azalan
  retailers.sort((a, b) => (b.has_data ? 1 : 0) - (a.has_data ? 1 : 0) || b.sales_qty - a.sales_qty);

  // "Haftanın yıldızı / dikkat geren" CİRO (TL) büyümesine göre; TL yoksa adet'e düşer.
  const vPool = retailers.filter((r) => r.has_data && r.value_wow != null);
  const usingVal = vPool.length > 0;
  const pool = usingVal ? vPool : retailers.filter((r) => r.has_data && r.wow != null);
  const m = (r: ExecOverview["retailers"][number]) => (usingVal ? r.value_wow! : r.wow!);
  const best = pool.length ? pool.reduce((a, b) => (m(b) > m(a) ? b : a)) : null;
  const worst = pool.length ? pool.reduce((a, b) => (m(b) < m(a) ? b : a)) : null;

  return {
    network: {
      sales_qty: netQty, sales_value: netVal, stock_qty: netStock,
      sku_count: netSku, retailer_count: retailers.filter((r) => r.has_data).length,
      wow_qty: bothPrevQty > 0 ? wowPct(bothQty, bothPrevQty) : null,
      wow_value: bothPrevVal > 0 ? wowPct(bothVal, bothPrevVal) : null,
    },
    latest_week: focus, prev_week: prevWeek,
    retailers,
    best: best ? { retailer: best.retailer, wow: m(best) } : null,
    worst: worst ? { retailer: worst.retailer, wow: m(worst) } : null,
  };
}

// ═══════════════════════ DÖNEM KARŞILAŞTIRMA ═══════════════════════

export interface PeriodCompare {
  sku_name: string; retailer: string;
  a_qty: number; b_qty: number; delta: number; delta_pct: number | null;
}

// İki haftayı SKU bazında karşılaştır (a = baz, b = karşılaştırılan).
export function comparePeriods(
  aRows: FactRow[], bRows: FactRow[], aliases?: AliasMap
): { gainers: PeriodCompare[]; losers: PeriodCompare[]; newSkus: PeriodCompare[]; lostSkus: PeriodCompare[] } {
  const aggKey = (rows: FactRow[]) => {
    const m = new Map<string, { retailer: string; name: string; qty: number }>();
    for (const r of rows) {
      const k = productKey(r.retailer, r.sku_name, r.barkod, aliases);
      const e = m.get(k) ?? { retailer: r.retailer, name: r.sku_name, qty: 0 };
      e.qty += r.sales_qty;
      if (r.sku_name.length > e.name.length) e.name = r.sku_name;
      m.set(k, e);
    }
    return m;
  };
  const a = aggKey(aRows), b = aggKey(bRows);
  const keys = new Set([...a.keys(), ...b.keys()]);

  const all: PeriodCompare[] = [];
  const newSkus: PeriodCompare[] = [];
  const lostSkus: PeriodCompare[] = [];
  for (const k of keys) {
    const meta = (a.get(k) ?? b.get(k))!;
    const retailer = meta.retailer, sku_name = meta.name;
    const aq = a.get(k)?.qty ?? 0;
    const bq = b.get(k)?.qty ?? 0;
    const delta = bq - aq;
    const delta_pct = aq > 0 ? (delta / aq) * 100 : null;
    const rec: PeriodCompare = { sku_name, retailer, a_qty: aq, b_qty: bq, delta, delta_pct };
    if (aq === 0 && bq > 0) newSkus.push(rec);
    else if (aq > 0 && bq === 0) lostSkus.push(rec);
    else all.push(rec);
  }
  const gainers = [...all].sort((x, y) => y.delta - x.delta).slice(0, 20);
  const losers = [...all].sort((x, y) => x.delta - y.delta).slice(0, 20);
  newSkus.sort((x, y) => y.b_qty - x.b_qty);
  lostSkus.sort((x, y) => y.a_qty - x.a_qty);
  return { gainers, losers, newSkus: newSkus.slice(0, 20), lostSkus: lostSkus.slice(0, 20) };
}

// ═══════════════════════ COVERAGE (STOK SÜRESİ) ═══════════════════════
// coverage = son hafta stoğu / ortalama haftalık satış (toplam satış / satış haftası).
// <8 hafta → kritik (sipariş gerek), >30 hafta → fazla (kampanya/aksiyon), 8-30 → sağlıklı.

export type CoverageStatus = "kritik" | "fazla" | "saglikli" | "yok";

export interface CoverageRow {
  sku_name: string;
  avg_weekly: number;
  last_stock: number;
  coverage: number | null; // hafta; satış yoksa null
}

const COVERAGE_LOW = 8;
const COVERAGE_HIGH = 30;
const MIN_VELOCITY = 1; // "kritik" için anlamlı haftalık satış eşiği (gürültüyü ele)

export function coverageStatus(coverage: number | null, avgWeekly: number, stock: number): CoverageStatus {
  // Yavaş/satmayan ürünler: "kritik" sayılmaz (acil sipariş değil). Stoklu ve
  // satmıyorsa/aşırı stoklu ise "fazla" (ölü stok/kampanya), değilse ihmal edilir.
  if (avgWeekly < MIN_VELOCITY) {
    if (stock > 0 && (coverage == null || coverage > COVERAGE_HIGH)) return "fazla";
    return "yok";
  }
  if (coverage == null) return "yok";
  if (coverage < COVERAGE_LOW) return "kritik"; // hızlı satıyor + stok az → sipariş
  if (coverage > COVERAGE_HIGH) return "fazla";  // çok stok → kampanya
  return "saglikli";
}

// Ham fact satırlarından SKU bazında coverage (mağaza-bazlı tek mağaza için kullanılır).
export function computeCoverage(
  rows: { sku_name: string; week_start: string; sales_qty: number; stock_qty: number }[]
): CoverageRow[] {
  const m = new Map<string, { weeks: Set<string>; total: number; stockByWeek: Map<string, number> }>();
  for (const r of rows) {
    let e = m.get(r.sku_name);
    if (!e) { e = { weeks: new Set(), total: 0, stockByWeek: new Map() }; m.set(r.sku_name, e); }
    e.weeks.add(r.week_start);
    e.total += Number(r.sales_qty);
    e.stockByWeek.set(r.week_start, (e.stockByWeek.get(r.week_start) ?? 0) + Number(r.stock_qty));
  }
  const out: CoverageRow[] = [];
  for (const [sku, e] of m) {
    const weeks = e.weeks.size;
    const avg = weeks > 0 ? e.total / weeks : 0;
    const lastWeek = [...e.weeks].sort().pop()!;
    const lastStock = e.stockByWeek.get(lastWeek) ?? 0;
    out.push({ sku_name: sku, avg_weekly: avg, last_stock: lastStock, coverage: avg > 0 ? lastStock / avg : null });
  }
  return out;
}

// ═══════════════════════ ÖLÜ STOK (ağ geneli, firmalar arası) ═══════════════════════
// product_coverage matview satırları (her satır bir ürün×firma) → ürün bazında
// firmalar arası birleştirilir. Ağ coverage = toplam stok / toplam haftalık hız.
// Coverage null + stok>0 = hiç satmayan (sonsuz coverage = en ölü).

export interface CoverageItem {
  retailer: string; product_key: string; barkod: string | null; sku_name: string;
  avg_weekly: number; last_stock: number; coverage_weeks: number | null;
}
export interface DeadStockFirm {
  retailer: string; sku_name: string; stock: number; velocity: number; coverage: number | null;
}
export interface DeadStockProduct {
  product_key: string; barkod: string | null; name: string;
  total_stock: number; total_velocity: number; coverage: number | null; // ağ geneli
  never_sold: boolean;             // hiçbir firmada satmıyor ama stok var
  max_firm_coverage: number | null; // en yüksek firma coverage (∞ → null)
  firms: DeadStockFirm[];
}

export function groupDeadStock(items: CoverageItem[]): DeadStockProduct[] {
  const map = new Map<string, CoverageItem[]>();
  for (const it of items) {
    if (!map.has(it.product_key)) map.set(it.product_key, []);
    map.get(it.product_key)!.push(it);
  }
  const out: DeadStockProduct[] = [];
  for (const [pk, arr] of map) {
    const total_stock = arr.reduce((a, r) => a + r.last_stock, 0);
    const total_velocity = arr.reduce((a, r) => a + r.avg_weekly, 0);
    const coverage = total_velocity > 0 ? total_stock / total_velocity : null;
    const name = [...arr].sort((a, b) => b.sku_name.length - a.sku_name.length)[0]?.sku_name || pk.replace(/^NAME:/, "");
    const barkod = arr.find((r) => r.barkod)?.barkod ?? null;
    const firms: DeadStockFirm[] = arr
      .map((r) => ({ retailer: r.retailer, sku_name: r.sku_name, stock: r.last_stock, velocity: r.avg_weekly, coverage: r.coverage_weeks }))
      .sort((a, b) => b.stock - a.stock);
    // en yüksek firma coverage (hiç satmayan-stoklu firma varsa ∞ = null)
    let maxFirm = 0; let inf = false;
    for (const f of firms) {
      if (f.coverage == null) { if (f.stock > 0) inf = true; }
      else if (f.coverage > maxFirm) maxFirm = f.coverage;
    }
    out.push({
      product_key: pk, barkod, name, total_stock, total_velocity, coverage,
      never_sold: coverage == null && total_stock > 0,
      max_firm_coverage: inf ? null : maxFirm,
      firms,
    });
  }
  // Hiç satmayanlar (∞) önce, stoğa göre; sonra coverage azalan.
  out.sort((a, b) => {
    if (a.never_sold !== b.never_sold) return a.never_sold ? -1 : 1;
    if (a.never_sold && b.never_sold) return b.total_stock - a.total_stock;
    return (b.coverage ?? 0) - (a.coverage ?? 0);
  });
  return out;
}

// Coverage satırlarını durumla zenginleştir, sırala, özetle. ("yok" elenir.)
export function summarizeCoverage(rows: CoverageRow[]) {
  const order: Record<CoverageStatus, number> = { kritik: 0, fazla: 1, saglikli: 2, yok: 9 };
  const items = rows
    .map((r) => ({ ...r, status: coverageStatus(r.coverage, r.avg_weekly, r.last_stock) }))
    .filter((r) => r.status !== "yok")
    .sort((a, b) =>
      order[a.status] - order[b.status] ||
      // kritikler en düşük coverage önce; fazlalar en yüksek coverage önce
      (a.status === "kritik" ? (a.coverage ?? 0) - (b.coverage ?? 0) : (b.coverage ?? 1e9) - (a.coverage ?? 1e9))
    );
  return {
    skus: items,
    summary: {
      kritik: items.filter((i) => i.status === "kritik").length,
      fazla: items.filter((i) => i.status === "fazla").length,
      saglikli: items.filter((i) => i.status === "saglikli").length,
      toplam: items.length,
    },
  };
}
