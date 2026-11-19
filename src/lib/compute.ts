// Saf hesaplama fonksiyonları — Supabase'den ayrılmış, test edilebilir çekirdek.
// API route'lar: Supabase'den veri çek → bu fonksiyonları çağır → JSON dön.

import { gorunenAd } from "./urun-arama";
import {
  momentum,
  anomalyScore,
  forecastNextWeek,
  weeksOfStock,
  wowPct,
  sellThrough,
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
  /** Sinyalin dayandığı veri haftası (firmanın son raporu). Eskiden yoktu:
   *  Nezih için "gelecek hafta tahmini" 4 hafta geçmiş bir haftayı tahmin
   *  ediyordu ve ekranda bunu söyleyen tek işaret yoktu. */
  week?: string;
}

// ---------- Özet (fact → weekly_summary eşleniği, test ve fallback için) ----------
export function buildSummary(rows: FactRow[]): SummaryRow[] {
  const map = new Map<
    string,
    {
      qty: number;
      val: number;
      hasVal: boolean;
      stock: number;
      skus: Set<string>;
      stores: Set<string>;
    }
  >();
  for (const r of rows) {
    const key = `${r.retailer}|${r.week_start}`;
    let e = map.get(key);
    if (!e) {
      e = {
        qty: 0,
        val: 0,
        hasVal: false,
        stock: 0,
        skus: new Set(),
        stores: new Set(),
      };
      map.set(key, e);
    }
    e.qty += r.sales_qty;
    if (r.sales_value != null) {
      e.val += r.sales_value;
      e.hasVal = true;
    }
    e.stock += r.stock_qty;
    e.skus.add(r.sku_name);
    if (r.store) e.stores.add(r.store);
  }
  return [...map.entries()]
    .map(([key, e]) => {
      const [retailer, week_start] = key.split("|");
      return {
        retailer,
        week_start,
        sales_qty: e.qty,
        sales_value: e.hasVal ? e.val : null,
        has_value: e.hasVal,
        stock_qty: e.stock,
        sku_count: e.skus.size,
        store_count: e.stores.size,
      };
    })
    .sort((a, b) => a.week_start.localeCompare(b.week_start));
}

// SİLİNDİ (denetim 2026-09-07): retailerCardMetrics — eski perakendeci
// kartlarının metriği; kartlar kaldırıldığından beri uygulamada çağıranı yoktu
// (yalnız testte). Aynı WoW/kohort hesabı execOverview içinde yaşıyor.

// ---------- Insights üretimi ----------
export function generateInsights(
  summary: SummaryRow[],
  skuRisk: {
    retailer: string;
    sku: string;
    wos: number;
    sales: number;
    stock: number;
    week?: string;
  }[] = [],
): Insight[] {
  const insights: Insight[] = [];

  for (const retailer of RETAILERS) {
    const series: WeekPoint[] = summary
      .filter((s) => s.retailer === retailer)
      .sort((a, b) => a.week_start.localeCompare(b.week_start))
      .map((s) => ({
        week_start: s.week_start,
        sales_qty: s.sales_qty,
        sales_value: s.sales_value,
        stock_qty: s.stock_qty,
      }));
    if (series.length < 2) continue;

    const last = series[series.length - 1];
    const prev = series[series.length - 2];
    // WoW sinyali CİRO (TL) bazlı; ciro yoksa adet'e düşer.
    const wowV =
      last.sales_value != null && prev.sales_value != null
        ? wowPct(last.sales_value, prev.sales_value)
        : null;
    const wowIsVal = wowV != null;
    const wow = wowV ?? wowPct(last.sales_qty, prev.sales_qty);
    const mom = momentum(series, 4);
    const anom = anomalyScore(series);
    const fc = forecastNextWeek(series, 4);

    // Her sinyal firmanın SON veri haftasını taşır; ekran "veri 3 Ağu · 4 hf
    // geride" diyebilsin. Bayat firmada bu etiket olmadan her sinyal güncel okunur.
    const week = last.week_start;
    if (wow != null && Math.abs(wow) >= 25) {
      insights.push({
        severity: wow > 0 ? "positive" : "warning",
        retailer,
        week,
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
        week,
        title: `${retailer} ${mom > 0 ? "ivme kazanıyor" : "ivme kaybediyor"}`,
        detail: `Son 4 haftalık trend ${mom > 0 ? "yukarı" : "aşağı"} yönlü (${mom >= 0 ? "+" : ""}${mom.toFixed(1)}%/hafta).`,
        metric: `momentum ${mom >= 0 ? "+" : ""}${mom.toFixed(1)}%`,
      });
    }
    if (anom?.isAnomaly) {
      insights.push({
        severity: anom.z > 0 ? "positive" : "warning",
        retailer,
        week,
        title: `${retailer} olağandışı hafta`,
        detail: `Bu haftanın satışı geçmiş ortalamadan ${Math.abs(anom.z).toFixed(1)} standart sapma ${anom.z > 0 ? "yukarıda" : "aşağıda"}.`,
        metric: `z=${anom.z.toFixed(1)}`,
      });
    }
    if (fc != null) {
      // "Gelecek hafta" DEĞİL "sonraki hafta": tahmin, verinin son haftasından
      // sonraki haftaya ait — bayat firmada o hafta çoktan geçmiş olabilir.
      insights.push({
        severity: "info",
        retailer,
        week,
        title: `${retailer} sonraki hafta tahmini`,
        detail: `Trend + ağırlıklı ortalamaya göre ~${Math.round(fc).toLocaleString("tr-TR")} adet bekleniyor (veri: ${week}).`,
        metric: `~${Math.round(fc).toLocaleString("tr-TR")} adet`,
      });
    }
  }

  for (const r of skuRisk) {
    insights.push({
      severity: "critical",
      retailer: r.retailer,
      week: r.week,
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
  rows: FactRow[],
  retailer: string,
  recentWeeks: string[],
): {
  retailer: string;
  sku: string;
  wos: number;
  sales: number;
  stock: number;
  week: string;
}[] {
  const latest = recentWeeks[recentWeeks.length - 1];
  const salesBy = new Map<string, Map<string, number>>();
  const stockLatest = new Map<string, number>();
  for (const r of rows) {
    if (!salesBy.has(r.sku_name)) salesBy.set(r.sku_name, new Map());
    const m = salesBy.get(r.sku_name)!;
    m.set(r.week_start, (m.get(r.week_start) ?? 0) + r.sales_qty);
    if (r.week_start === latest)
      stockLatest.set(
        r.sku_name,
        (stockLatest.get(r.sku_name) ?? 0) + r.stock_qty,
      );
  }
  const risks: {
    retailer: string;
    sku: string;
    wos: number;
    sales: number;
    stock: number;
    week: string;
  }[] = [];
  for (const [sku, wmap] of salesBy) {
    // BAYAT ÜRÜN STOCKOUT DEĞİLDİR. Ürün firmanın son raporunda yoksa stoğu
    // BİLİNMİYOR; eskiden `?? 0` ile 0 sayılıp "tükenmek üzere · stok 0" olarak
    // kritik uyarıya dönüyordu — bu sistemde "0 ile veri yok" karışması daha
    // önce yanlış alarm üretti, aynı hata sınıfı.
    if (!stockLatest.has(sku)) continue;
    // BÖLEN: ürünün pencerede RAFTA OLDUĞU hafta sayısı (en az 2) —
    // buildVelocityIndex / reorderPriority / routing.velOf ile AYNI kural.
    // Sabit pencere boyuna bölmek yeni ürünün hızını düşürüp riski gizliyordu.
    const first = recentWeeks.find((w) => wmap.has(w));
    const open = first
      ? recentWeeks.filter((w) => w >= first).length
      : recentWeeks.length;
    const vals = recentWeeks.map((w) => wmap.get(w) ?? 0);
    const avg = vals.reduce((a, b) => a + b, 0) / Math.max(2, open);
    const stock = stockLatest.get(sku) ?? 0;
    const wos = weeksOfStock(stock, avg);
    if (wos != null && wos < 2 && avg >= 3)
      risks.push({
        retailer,
        sku,
        wos,
        sales: Math.round(avg),
        stock,
        week: latest,
      });
  }
  risks.sort((a, b) => a.wos - b.wos);
  return risks.slice(0, 2);
}

// SİLİNDİ (denetim 2026-09-07): computeStockAlerts — eski "stok alarmı" ekranı
// kaldırıldığından beri uygulamada çağıranı yoktu. Yakın tükenme bugün
// reorderPriority (/api/stock-alerts), kapsam durumu coverageStatus (/api/stock)
// ile ölçülüyor.

// ---------- Sipariş önceliği: hızlı satıp stoğu yetmeyecek SKU'lar ----------
// Tek başına "düşük stok" ölü/kayıp stoğu öne çıkarır ve aksiyon üretmez.
// Asıl sinyal: son haftalarda istikrarlı satan AMA mevcut stoğu bu hıza
// yetmeyecek ürünler. Hız = son N haftanın HAFTALIK ORTALAMA satışı (tek
// haftanın oynaklığını törpüler); stok = en güncel haftanın stoğu.
export interface ReorderRow {
  sku_name: string;
  barkod: string | null;
  avg_sales: number; // son N haftanın haftalık ortalama satışı (hız)
  ewma: number; // üstel ağırlıklı hız (α=0.4; yeni haftalar baskın) — ivmeyi yakalar
  trend: "up" | "down" | "flat"; // ewma / düz ortalama: ≥+%15 up, ≤−%15 down
  last_sales: number; // son hafta satış
  stock_qty: number; // son hafta stok
  sales_value: number; // son hafta ciro (TL)
  cover: number | null; // kaç hafta yeter = stok / haftalık ort. satış
  cover_ewma: number | null; // stok / EWMA hız — ivmelenen üründe daha gerçekçi (erken uyarı)
  weeks_used: number; // ortalama kaç hafta üzerinden alındı
  status: "tükendi" | "acil" | "izle" | "yeterli";
}

// Üstel ağırlıklı hareketli ortalama: düz ortalama tüm haftalara eşit ağırlık
// verir ve ivmeyi (yeni hızlanan/yavaşlayan ürünü) geç görür. EWMA son haftaları
// baskın tutar: α=0.4'te son 2 hafta ağırlığın ~%64'ünü taşır. Pencerede satış
// kaydı olmayan hafta gerçek 0'dır (ürün raftaydı, satmadı) — seri 0 ile doldurulur.
export function ewmaVelocity(series: number[], alpha = 0.4): number {
  if (!series.length) return 0;
  let v = series[0];
  for (let i = 1; i < series.length; i++)
    v = alpha * series[i] + (1 - alpha) * v;
  return v;
}

// recentRows: son N haftanın tüm fact satırları; weeks: o N haftanın listesi.
export function reorderPriority(
  recentRows: FactRow[],
  weeks: string[],
  minAvg = 10,
): ReorderRow[] {
  if (!weeks.length) return [];
  const sorted = [...weeks].sort();
  const latest = sorted[sorted.length - 1];
  const n = sorted.length;
  const inWindow = new Set(sorted);

  type Agg = {
    sku: string;
    barkod: string | null;
    total: number;
    last: number;
    stock: number;
    val: number;
    wk: Map<string, number>;
  };
  const m = new Map<string, Agg>();
  for (const r of recentRows) {
    if (!inWindow.has(r.week_start)) continue;
    const e = m.get(r.sku_name) ?? {
      sku: r.sku_name,
      barkod: r.barkod ?? null,
      total: 0,
      last: 0,
      stock: 0,
      val: 0,
      wk: new Map(),
    };
    e.total += r.sales_qty;
    e.wk.set(r.week_start, (e.wk.get(r.week_start) ?? 0) + r.sales_qty);
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
    // HAFTALIK ORTALAMA — bölen, ürünün pencerede RAFTA OLDUĞU hafta sayısı
    // (en az 2). buildVelocityIndex ve /api/routing'teki velOf ile AYNI kural;
    // üçü ayrışırsa aynı ürün üç ekranda üç farklı hız gösterir. Sabit pencere
    // boyuna bölmek yeni ürünün hızını düşürüyordu: "DR Mythos GSChampionsEdition
    // 25/26Amblj" 3 haftada 503 adet satmış → gerçek 167,7/hf, 8'e bölünce 62,9
    // (kapsam 1,4 hf yerine 3,8 hf sanılıyor, yani stok bitişi geç haber veriliyor).
    const firstSeen = sorted.find((w) => e.wk.has(w));
    const openW = firstSeen ? sorted.filter((w) => w >= firstSeen).length : n;
    const avg = e.total / Math.max(2, openW);
    if (avg < minAvg) continue; // yalnızca anlamlı satanlar (gürültüyü ele)
    const cover = avg > 0 ? e.stock / avg : null;
    // EWMA hız + trend: karar eşikleri (status) düz ortalamada KALIR (istikrarlı,
    // test edilmiş); EWMA erken-uyarı sinyalidir — UI ivme okunu bundan çizer.
    const series = sorted.map((w) => e.wk.get(w) ?? 0);
    const ew = ewmaVelocity(series);
    const ratio = avg > 0 ? ew / avg : 1;
    const trend: ReorderRow["trend"] =
      ratio >= 1.15 ? "up" : ratio <= 0.85 ? "down" : "flat";
    let status: ReorderRow["status"];
    if (e.stock <= 0)
      status = "tükendi"; // satıyor ama stok bitti → kayıp satış
    else if ((cover ?? 0) < 1)
      status = "acil"; // ort. hıza bu hafta bile yetmez
    else if ((cover ?? 0) < 2) status = "izle";
    else status = "yeterli";
    out.push({
      sku_name: e.sku,
      barkod: e.barkod,
      avg_sales: Math.round(avg * 10) / 10,
      ewma: Math.round(ew * 10) / 10,
      trend,
      last_sales: e.last,
      stock_qty: e.stock,
      sales_value: e.val,
      cover: cover == null ? null : Math.round(cover * 10) / 10,
      cover_ewma: ew > 0 ? Math.round((e.stock / ew) * 10) / 10 : null,
      weeks_used: n,
      status,
    });
  }
  // En acil önce: düşük kapsam (stok/ort. satış) → eşitlikte yüksek ort. satış
  out.sort((a, b) => {
    const ca = a.cover ?? 0,
      cb = b.cover ?? 0;
    if (ca !== cb) return ca - cb;
    return b.avg_sales - a.avg_sales;
  });
  return out;
}

// ---------- Ürün cross-retailer pivot ----------
export function pivotProduct(rows: FactRow[]) {
  const weeksSet = new Set<string>();
  const byRetailer = new Map<
    string,
    Map<string, { qty: number; val: number; stock: number }>
  >();
  // Görünen ad arama listesiyle AYNI kuraldan (lib/urun-arama.ts gorunenAd):
  // sabit firma önceliği, Toyzz'ın "ASP-MYT-…" kod-adı en sonda.
  const adlar: { retailer: string; sku_name: string }[] = [];
  for (const r of rows) {
    adlar.push({ retailer: r.retailer, sku_name: r.sku_name });
    weeksSet.add(r.week_start);
    if (!byRetailer.has(r.retailer)) byRetailer.set(r.retailer, new Map());
    const m = byRetailer.get(r.retailer)!;
    const e = m.get(r.week_start) ?? { qty: 0, val: 0, stock: 0 };
    e.qty += r.sales_qty;
    e.val += r.sales_value ?? 0;
    e.stock += r.stock_qty;
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
    let qty = 0,
      val = 0;
    for (const e of m.values()) {
      qty += e.qty;
      val += e.val;
    }
    // SON STOK, FİRMANIN KENDİ son haftasından okunur. Önceden ürünün ağ genelindeki
    // son haftası (weeks[weeks.length-1]) kullanılıyordu; firmalar farklı haftalarda
    // veri gönderdiği için (ör. Armağan/Huppaluppo bir hafta geride) o firmanın o
    // haftada satırı olmuyor ve stok 0 görünüyordu — ağ genelinde stoğun %40'ı
    // (71.824 adet) ekranda kayboluyordu.
    const ownWeeks = [...m.keys()].sort();
    const ownLast = ownWeeks[ownWeeks.length - 1];
    return {
      retailer: ret,
      total_qty: qty,
      total_val: val,
      last_stock: (ownLast ? m.get(ownLast)?.stock : 0) ?? 0,
      last_week: ownLast ?? null,
    };
  });
  return { name: gorunenAd(adlar), weeks, series, retailers, totals };
}

// ═══════════════════════ ÜRÜN ZEKASI (isim parsing) ═══════════════════════

export interface ProductMeta {
  brand: string;
  team: string;
  type: string;
}

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
  rows: FactRow[],
  dimension: "brand" | "team" | "type",
): {
  key: string;
  sales_qty: number;
  sales_value: number;
  sku_count: number;
}[] {
  const map = new Map<
    string,
    { qty: number; val: number; skus: Set<string> }
  >();
  for (const r of rows) {
    const meta = parseProductMeta(r.sku_name);
    const key = meta[dimension];
    let e = map.get(key);
    if (!e) {
      e = { qty: 0, val: 0, skus: new Set() };
      map.set(key, e);
    }
    e.qty += r.sales_qty;
    e.val += r.sales_value ?? 0;
    e.skus.add(r.sku_name);
  }
  return [...map.entries()]
    .map(([key, e]) => ({
      key,
      sales_qty: e.qty,
      sales_value: e.val,
      sku_count: e.skus.size,
    }))
    .sort((a, b) => b.sales_qty - a.sales_qty);
}

// SİLİNDİ (denetim 2026-09-07): storePerformance — mağaza toplamı artık
// store_weekly matview'inden geliyor (/api/stores), JS'te yeniden hesaplanmıyor.

// ═══════════════════════ ÜRÜN KİMLİĞİ (kanonik anahtar) ═══════════════════════
// Aynı ürünü firmalar arası birleştirmek için: barkod (varsa) → ONAYLI alias
// barkodu (Toyzz vb. isim eşleşmesi) → 'NAME:'||isim (eşleşemeyen tek-firma kalır).
export type AliasMap = Map<string, string>; // `${retailer}|${sku_name}` → barkod
export function productKey(
  retailer: string,
  sku_name: string,
  barkod: string | null | undefined,
  aliases?: AliasMap,
): string {
  if (barkod) return barkod;
  const a = aliases?.get(`${retailer}|${sku_name}`);
  return a ?? "NAME:" + sku_name;
}

// ═══════════════════════ GLOBAL SIRALAMALAR ═══════════════════════

export interface RankedSku {
  sku_name: string;
  retailers: string[];
  barkod: string | null;
  sales_qty: number;
  sales_value: number;
  stock_qty: number;
  prev_qty: number;
  prev_val: number;
  growth: number | null;
}

// Tüm perakendeciler genelinde SKU sıralaması (top sellers + risers + fallers).
// Büyüme (growth) varsayılan CİRO (TL) bazlı; metric="qty" ile adet bazlı.
export function globalRankings(
  latestRows: FactRow[],
  prevByKey: Map<string, { qty: number; val: number }>,
  metric: "value" | "qty" = "value",
  aliases?: AliasMap,
): { top: RankedSku[]; risers: RankedSku[]; fallers: RankedSku[] } {
  // Kanonik ürün anahtarıyla (barkod/alias/isim) firmalar arası birleştir.
  const map = new Map<
    string,
    {
      name: string;
      barkod: string | null;
      retailers: Set<string>;
      qty: number;
      val: number;
      stock: number;
    }
  >();
  for (const r of latestRows) {
    const key = productKey(r.retailer, r.sku_name, r.barkod, aliases);
    let e = map.get(key);
    if (!e) {
      e = {
        name: r.sku_name,
        barkod: r.barkod ?? null,
        retailers: new Set(),
        qty: 0,
        val: 0,
        stock: 0,
      };
      map.set(key, e);
    }
    e.qty += r.sales_qty;
    e.val += r.sales_value ?? 0;
    e.stock += r.stock_qty;
    e.retailers.add(r.retailer);
    if (!e.barkod && r.barkod) e.barkod = r.barkod;
    if (r.sku_name.length > e.name.length) e.name = r.sku_name; // temsili (en uzun) isim
  }
  const useVal = metric === "value";
  const ranked: RankedSku[] = [...map.entries()].map(([key, e]) => {
    const p = prevByKey.get(key) ?? { qty: 0, val: 0 };
    const cur = useVal ? e.val : e.qty;
    const prevM = useVal ? p.val : p.qty;
    const growth = prevM > 0 ? ((cur - prevM) / prevM) * 100 : null;
    return {
      sku_name: e.name,
      retailers: [...e.retailers].sort(),
      barkod: e.barkod,
      sales_qty: e.qty,
      sales_value: e.val,
      stock_qty: e.stock,
      prev_qty: p.qty,
      prev_val: p.val,
      growth,
    };
  });

  const top = [...ranked]
    .sort((a, b) => b.sales_qty - a.sales_qty)
    .slice(0, 20);
  // Anlamlı hareket eşiği metriğe göre (ciro: TL tabanı, adet: adet tabanı)
  const floor = useVal ? 100 : 5;
  const movers = ranked.filter((r) => {
    const cur = useVal ? r.sales_value : r.sales_qty;
    const prevM = useVal ? r.prev_val : r.prev_qty;
    return r.growth != null && prevM >= floor && cur >= floor;
  });
  const risers = [...movers]
    .sort((a, b) => (b.growth ?? 0) - (a.growth ?? 0))
    .slice(0, 15);
  const fallers = [...movers]
    .sort((a, b) => (a.growth ?? 0) - (b.growth ?? 0))
    .slice(0, 15);
  return { top, risers, fallers };
}

// ═══════════════════════ EXECUTIVE ÖZET ═══════════════════════

export interface ExecOverview {
  network: {
    sales_qty: number;
    sales_value: number;
    stock_qty: number;
    sku_count: number;
    retailer_count: number;
    wow_qty: number | null;
    wow_value: number | null;
  };
  latest_week: string | null;
  prev_week: string | null;
  retailers: {
    retailer: string;
    sales_qty: number;
    sales_value: number | null;
    wow: number | null;
    value_wow: number | null;
    share: number;
    has_data: boolean;
    status: "up" | "down" | "flat" | "nodata";
  }[];
  best: { retailer: string; wow: number } | null;
  worst: { retailer: string; wow: number } | null;
}

// Tüm ağın yönetici özeti — en güncel ortak/maksimum hafta bazında.
export function execOverview(
  summary: SummaryRow[],
  targetWeek?: string,
): ExecOverview {
  const allWeeks = [...new Set(summary.map((s) => s.week_start))].sort();
  const networkLatest = allWeeks[allWeeks.length - 1] ?? null;
  // Gösterilecek hafta: verilmişse o, yoksa en güncel.
  const focus = targetWeek ?? networkLatest;

  if (!focus) {
    return {
      network: {
        sales_qty: 0,
        sales_value: 0,
        stock_qty: 0,
        sku_count: 0,
        retailer_count: 0,
        wow_qty: null,
        wow_value: null,
      },
      latest_week: null,
      prev_week: null,
      retailers: [],
      best: null,
      worst: null,
    };
  }

  // Geçen hafta = seçili haftanın tam 7 gün öncesi (kanonik Pazartesi).
  const pd = new Date(focus + "T00:00:00Z");
  pd.setUTCDate(pd.getUTCDate() - 7);
  const prevWeek = pd.toISOString().slice(0, 10);

  const byKey = new Map(
    summary.map((s) => [`${s.retailer}|${s.week_start}`, s]),
  );
  const retailersInData = [...new Set(summary.map((s) => s.retailer))];

  let netQty = 0,
    netVal = 0,
    netStock = 0,
    netSku = 0;
  // Ağ WoW'u yalnızca HEM bu hafta HEM geçen hafta verisi olan perakendeciler üzerinden
  let bothQty = 0,
    bothPrevQty = 0,
    bothVal = 0,
    bothPrevVal = 0;
  const retailers: ExecOverview["retailers"] = [];

  for (const ret of retailersInData) {
    const cur = byKey.get(`${ret}|${focus}`);
    const prevRec = byKey.get(`${ret}|${prevWeek}`);
    if (!cur) {
      // O haftada veri yok → "veri yok" satırı (sahte büyüme gösterilmez)
      retailers.push({
        retailer: ret,
        sales_qty: 0,
        sales_value: null,
        wow: null,
        value_wow: null,
        share: 0,
        has_data: false,
        status: "nodata",
      });
      continue;
    }
    const value = cur.has_value ? cur.sales_value : null;
    netQty += cur.sales_qty;
    netVal += value ?? 0;
    netStock += cur.stock_qty;
    netSku += cur.sku_count;
    // Büyüme yalnızca geçen hafta verisi varsa (yoksa null → UI "—" gösterir)
    const wow = prevRec ? wowPct(cur.sales_qty, prevRec.sales_qty) : null;
    const value_wow =
      prevRec && prevRec.sales_value != null && value != null
        ? wowPct(value, prevRec.sales_value)
        : null;
    if (prevRec) {
      bothQty += cur.sales_qty;
      bothPrevQty += prevRec.sales_qty;
      if (prevRec.sales_value != null && value != null) {
        bothVal += value;
        bothPrevVal += prevRec.sales_value;
      }
    }
    retailers.push({
      retailer: ret,
      sales_qty: cur.sales_qty,
      sales_value: value,
      wow,
      value_wow,
      share: 0,
      has_data: true,
      status:
        wow == null ? "nodata" : wow > 2 ? "up" : wow < -2 ? "down" : "flat",
    });
  }
  for (const r of retailers)
    r.share = netQty > 0 ? (r.sales_qty / netQty) * 100 : 0;
  // Veri olanlar önce, sonra satışa göre azalan
  retailers.sort(
    (a, b) =>
      (b.has_data ? 1 : 0) - (a.has_data ? 1 : 0) || b.sales_qty - a.sales_qty,
  );

  // "Haftanın yıldızı / dikkat geren" CİRO (TL) büyümesine göre; TL yoksa adet'e düşer.
  // Anlamlılık kapıları (kısmi/sığ haftalarda saçma sonuçları engeller):
  //  • taban: ağ cirosunun %5'i veya 25K'nın büyüğü altındaki kanal aday olamaz
  //    (15K'lık kanalın ±%20'si "haftanın yıldızı" haberi değildir);
  //  • en az 2 karşılaştırılabilir firma — tek firmalı haftada iki kartın da
  //    aynı firmayı göstermesi bilgi değil gürültüdür → ikisi de null.
  const valFloor = Math.max(25000, netVal * 0.05);
  const qtyFloor = Math.max(100, netQty * 0.05);
  const vPool = retailers.filter(
    (r) =>
      r.has_data && r.value_wow != null && (r.sales_value ?? 0) >= valFloor,
  );
  const usingVal = vPool.length > 0;
  const pool = usingVal
    ? vPool
    : retailers.filter(
        (r) => r.has_data && r.wow != null && r.sales_qty >= qtyFloor,
      );
  const m = (r: ExecOverview["retailers"][number]) =>
    usingVal ? r.value_wow! : r.wow!;
  const enough = pool.length >= 2;
  const best = enough ? pool.reduce((a, b) => (m(b) > m(a) ? b : a)) : null;
  const worst = enough ? pool.reduce((a, b) => (m(b) < m(a) ? b : a)) : null;

  return {
    network: {
      sales_qty: netQty,
      sales_value: netVal,
      stock_qty: netStock,
      sku_count: netSku,
      retailer_count: retailers.filter((r) => r.has_data).length,
      wow_qty: bothPrevQty > 0 ? wowPct(bothQty, bothPrevQty) : null,
      wow_value: bothPrevVal > 0 ? wowPct(bothVal, bothPrevVal) : null,
    },
    latest_week: focus,
    prev_week: prevWeek,
    retailers,
    best: best ? { retailer: best.retailer, wow: m(best) } : null,
    worst: worst ? { retailer: worst.retailer, wow: m(worst) } : null,
  };
}

// ═══════════════════════ DÖNEM KARŞILAŞTIRMA ═══════════════════════

export interface PeriodCompare {
  sku_name: string;
  retailer: string;
  a_qty: number;
  b_qty: number;
  delta: number;
  delta_pct: number | null;
}

// İki haftayı SKU bazında karşılaştır (a = baz, b = karşılaştırılan).
export function comparePeriods(
  aRows: FactRow[],
  bRows: FactRow[],
  aliases?: AliasMap,
): {
  gainers: PeriodCompare[];
  losers: PeriodCompare[];
  newSkus: PeriodCompare[];
  lostSkus: PeriodCompare[];
} {
  const aggKey = (rows: FactRow[]) => {
    const m = new Map<
      string,
      { retailer: string; name: string; qty: number }
    >();
    for (const r of rows) {
      const k = productKey(r.retailer, r.sku_name, r.barkod, aliases);
      const e = m.get(k) ?? { retailer: r.retailer, name: r.sku_name, qty: 0 };
      e.qty += r.sales_qty;
      if (r.sku_name.length > e.name.length) e.name = r.sku_name;
      m.set(k, e);
    }
    return m;
  };
  const a = aggKey(aRows),
    b = aggKey(bRows);
  const keys = new Set([...a.keys(), ...b.keys()]);

  const all: PeriodCompare[] = [];
  const newSkus: PeriodCompare[] = [];
  const lostSkus: PeriodCompare[] = [];
  for (const k of keys) {
    const meta = (a.get(k) ?? b.get(k))!;
    const retailer = meta.retailer,
      sku_name = meta.name;
    const aq = a.get(k)?.qty ?? 0;
    const bq = b.get(k)?.qty ?? 0;
    const delta = bq - aq;
    const delta_pct = aq > 0 ? (delta / aq) * 100 : null;
    const rec: PeriodCompare = {
      sku_name,
      retailer,
      a_qty: aq,
      b_qty: bq,
      delta,
      delta_pct,
    };
    if (aq === 0 && bq > 0) newSkus.push(rec);
    else if (aq > 0 && bq === 0) lostSkus.push(rec);
    else all.push(rec);
  }
  const gainers = [...all].sort((x, y) => y.delta - x.delta).slice(0, 20);
  const losers = [...all].sort((x, y) => x.delta - y.delta).slice(0, 20);
  newSkus.sort((x, y) => y.b_qty - x.b_qty);
  lostSkus.sort((x, y) => y.a_qty - x.a_qty);
  return {
    gainers,
    losers,
    newSkus: newSkus.slice(0, 20),
    lostSkus: lostSkus.slice(0, 20),
  };
}

// ═══════════════════════ COVERAGE (STOK SÜRESİ) ═══════════════════════
// coverage = son hafta stoğu / GÜNCEL haftalık satış hızı (son VELOCITY_WEEKS hafta).
// <COVERAGE_LOW hafta → kritik (sipariş gerek), >COVERAGE_HIGH → fazla (kampanya),
// arası sağlıklı.

export type CoverageStatus = "kritik" | "fazla" | "saglikli" | "yok";

export interface CoverageRow {
  sku_name: string;
  avg_weekly: number;
  last_stock: number;
  coverage: number | null; // hafta; satış yoksa null
  // BAYAT: ürün firmanın GÜNCEL haftalık raporunda artık yok — stoğu gerçek değil,
  // sadece son görüldüğü haftadan kalma bir kalıntı. Manşet toplamlarından çıkarılır.
  stale?: boolean;
  last_seen?: string | null; // en son görüldüğü hafta (week_start)
}

// ── EŞİKLER: TEK KAYNAK ──
// Bu sabitler artık /api/stock ve /stok tarafından İMPORT EDİLİR. Önceden aynı
// sayılar dört ayrı yerde elle yazılıydı: burada; stok/page.tsx'te "Az stok (<8 hf)"
// gibi UI metinlerinde; ölü stok renk skalasında 120/60 sihirli sayı olarak; ve
// varsayılan ölü-stok filtresinde. Biri değiştiğinde diğerleri sessizce kayıyordu.
// Eşik değişikliği artık tek satırdan yapılır, UI metinleri bu sabitlerden türer.
export const COVERAGE_LOW = 8; // hafta — altı: az stok / sipariş
export const COVERAGE_HIGH = 30; // hafta — üstü: fazla / kampanya
export const MIN_VELOCITY = 1; // "kritik" için anlamlı haftalık satış eşiği (gürültüyü ele)

// Ölü stok görünümü: varsayılan "ölü" eşiği ve renk skalasının kırmızı sınırı.
export const DEAD_STOCK_MIN_WEEKS = 60;
export const DEAD_STOCK_HIGH_WEEKS = 120;

// ── GÜNCEL HIZ PENCERESİ ──
// product_coverage.avg_weekly ve sku_coverage.avg_weekly = total_sales / toplam_hafta,
// yani ÖMÜR BOYU ortalamadır. Lansmanda patlayıp normale dönen üründe bu değer gerçek
// talebin katlarına çıkıyor: ölçülen örnek Toyzz "GALATASARAY PRE-SEASON 25/26 5+1"
// → ömür 886,9/hf ↔ son 8 hafta 76,6/hf; kapsam 2,6 hf sanılıp "az stok" işaretlenirken
// gerçekte 30,4 haftalık stok vardı. Karşılaştırılabilir 442 satırın 111'i (%25) ≥2×
// sapıyordu ve 66 "kritik" satırın 37'si bu yüzden SAHTEYDİ. Bu nedenle hız artık
// sku_weekly'den son VELOCITY_WEEKS hafta üzerinden hesaplanır — /yonlendirme ile
// AYNI ölçüt (böylece iki ekran aynı girdiyi paylaşır).
export const VELOCITY_WEEKS = 8;
// Çekilecek global hafta penceresi. Firmalar farklı haftalarda veri gönderdiği için
// global son 8 hafta bazı firmalara yalnız 6 hafta düşürüyordu (ölçüldü: Armağan 6,
// Huppaluppo 6); 12 hafta ile her firma kendi son 8 haftasını bu kümede buluyor.
export const WINDOW_WEEKS = 12;

// Durum etiketleri EŞİKLERDEN TÜRETİLİR — UI'da elle "<8 hf" yazılmaz.
export const COVERAGE_LABELS: Record<Exclude<CoverageStatus, "yok">, string> = {
  kritik: `Az stok (<${COVERAGE_LOW} hf)`,
  fazla: `Fazla / kampanya (>${COVERAGE_HIGH} hf)`,
  saglikli: `Sağlıklı (${COVERAGE_LOW}–${COVERAGE_HIGH} hf)`,
};

export function coverageStatus(
  coverage: number | null,
  avgWeekly: number,
  stock: number,
): CoverageStatus {
  // Yavaş/satmayan ürünler: "kritik" sayılmaz (acil sipariş değil). Stoklu ve
  // satmıyorsa/aşırı stoklu ise "fazla" (ölü stok/kampanya), değilse ihmal edilir.
  if (avgWeekly < MIN_VELOCITY) {
    if (stock > 0 && (coverage == null || coverage > COVERAGE_HIGH))
      return "fazla";
    return "yok";
  }
  if (coverage == null) return "yok";
  if (coverage < COVERAGE_LOW) return "kritik"; // hızlı satıyor + stok az → sipariş
  if (coverage > COVERAGE_HIGH) return "fazla"; // çok stok → kampanya
  return "saglikli";
}

// ── GÜNCEL HIZ ENDEKSİ (sku_weekly → kanal bazlı son N hafta) ──
// Matview'lerin ömür ortalaması yerine kullanılır. Kanal (firma) başına ayrı pencere
// tutulur: firmalar farklı haftalarda veri gönderdiği için "son 8 hafta" her firma
// için farklı tarihlere denk gelir.
export interface SkuWeekRow {
  retailer: string;
  week_start: string;
  sku_name: string;
  barkod?: string | null;
  sales_qty?: number | string | null;
  // Rafa geliş haftası için (stok > 0 ya da satış ≠ 0). Yoksa eski davranış.
  stock_qty?: number | string | null;
}

export interface VelocityIndex {
  weeksOf: Map<string, string[]>; // kanal → kendi haftaları (artan)
  currentWeek: Map<string, string>; // kanal → en güncel haftası
  velocity: Map<string, number>; // `${retailer}|${key}` → son N hafta ortalama adet
  currentKeys: Set<string>; // güncel haftada görülen `${retailer}|${key}`
  currentNames: Set<string>; // güncel haftada görülen `${retailer}|${sku_name}`
  lastSeen: Map<string, string>; // `${retailer}|${key}` → son görülme haftası
  lastSeenName: Map<string, string>; // `${retailer}|${sku_name}` → son görülme haftası
}

// keyOf: satırların hangi anahtara toplanacağını belirler — ağ görünümünde ürün
// anahtarı (barkod/alias/NAME:), firma görünümünde doğrudan sku_name. İsim bazlı
// kümeler keyOf'tan BAĞIMSIZ olarak her zaman doldurulur (bayat kontrolünün ikinci
// kanıtı için; bkz. isStale).
export function buildVelocityIndex(
  rows: SkuWeekRow[],
  keyOf: (row: SkuWeekRow) => string,
  velocityWeeks = VELOCITY_WEEKS,
): VelocityIndex {
  const weekSet = new Map<string, Set<string>>();
  for (const r of rows) {
    let s = weekSet.get(r.retailer);
    if (!s) {
      s = new Set();
      weekSet.set(r.retailer, s);
    }
    s.add(r.week_start);
  }
  const weeksOf = new Map<string, string[]>();
  const currentWeek = new Map<string, string>();
  const winOf = new Map<string, Set<string>>(); // kanal → hız penceresi haftaları
  for (const [ret, s] of weekSet) {
    const w = [...s].sort();
    weeksOf.set(ret, w);
    currentWeek.set(ret, w[w.length - 1]);
    winOf.set(ret, new Set(w.slice(-velocityWeeks)));
  }

  const sums = new Map<string, number>();
  const currentKeys = new Set<string>();
  const currentNames = new Set<string>();
  const lastSeen = new Map<string, string>();
  const lastSeenName = new Map<string, string>();
  // firstIn: ürünün hız penceresine İLK göründüğü hafta (bölen için — aşağıya bak)
  const firstIn = new Map<string, string>();
  // rafIn: ürünün İLK RAFTA olduğu hafta (stok > 0 ya da satış ≠ 0), verilen tüm
  // satırlar üzerinden. routing velOf'taki `raf` ile aynı tanım.
  const rafIn = new Map<string, string>();
  for (const r of rows) {
    const k = r.retailer + "|" + keyOf(r);
    const n = r.retailer + "|" + r.sku_name;
    if (Number(r.stock_qty ?? 0) > 0 || Number(r.sales_qty ?? 0) !== 0) {
      const p = rafIn.get(k);
      if (p == null || r.week_start < p) rafIn.set(k, r.week_start);
    }
    if (winOf.get(r.retailer)?.has(r.week_start)) {
      sums.set(k, (sums.get(k) ?? 0) + Number(r.sales_qty ?? 0));
      const f = firstIn.get(k);
      if (f == null || r.week_start < f) firstIn.set(k, r.week_start);
    }
    if (currentWeek.get(r.retailer) === r.week_start) {
      currentKeys.add(k);
      currentNames.add(n);
    }
    const pk = lastSeen.get(k);
    if (pk == null || r.week_start > pk) lastSeen.set(k, r.week_start);
    const pn = lastSeenName.get(n);
    if (pn == null || r.week_start > pn) lastSeenName.set(n, r.week_start);
  }
  // HIZ = pencere toplamı ÷ ürünün pencerede RAFTA OLDUĞU hafta sayısı.
  //
  // Satmayan hafta gerçek 0'dır ve ortalamayı bölmelidir — bu yüzden bölen "satış
  // görülen hafta sayısı" DEĞİL. Ama ürünün henüz VAR OLMADIĞI hafta da 0 sayılırsa
  // yeni ürünün hızı yapay olarak düşüyor. Ölçülen: "DR Mythos GSChampionsEdition
  // 25/26Amblj" 3 haftadır listede ve 503 adet satmış → gerçek hız ~168/hf, sabit
  // 8'e bölünce 62,9/hf (2,7× düşük). Sonuç: kapsam 3,8 hf yerine 10 hf sanılıyor,
  // sevk önerisi 266 adet çıkıyor, gerçek ihtiyaç ~1.100 adet — yani hızlı satan
  // yeni ürün tam patladığı anda az sevk ediliyor.
  //
  // Ürün ilk göründüğü haftadan İTİBAREN sayılır; satmayı bırakmış ürün bu yüzden
  // cezasını alır (first erken → bölen büyük → hız düşer), yeni ürün ise şişmez.
  // Bölen EN AZ 2: tek haftalık veri (raf yerleşimi/lansman etkisi taşır) büyük bir
  // sipariş için fazla incedir; ikinci hafta gerçek hızı gösterince kendini düzeltir.
  //
  // AYNI KURAL /api/routing içindeki velOf'ta da uygulanıyor. İki taraf ayrışırsa
  // aynı ürün iki ekranda farklı hız gösterir — bu sistemde tam olarak bu hata
  // sınıfı ölçüldü ve düzeltildi, o yüzden birini değiştiren diğerini de değiştirmeli.
  //
  // RAF ÖNCESİ HAFTALAR SAYILMAZ (routing'e 2026-09-28'de girdi, buraya 2026-10-29'da
  // taşındı). Firmalar ürünü rafa gelmeden haftalarca 0 stok / 0 satışla listeliyor;
  // o haftalar bölene girince en sıcak lansman ürünlerinin hızı düşük çıkıyordu.
  // Ölçülen: /stok ile /yonlendirme 6 Toyzz ürününde ayrışıyordu, hepsi yeni
  // sezon lansmanı, oran tam 6/8 (ör. BJK Pre-Season 26/27: /stok 369,5/hf ↔ 492,7/hf).
  const velocity = new Map<string, number>();
  for (const [k, total] of sums) {
    const ret = k.slice(0, k.indexOf("|"));
    const win = [...(winOf.get(ret) ?? [])];
    const first = rafIn.get(k) ?? firstIn.get(k);
    const open = first ? win.filter((w) => w >= first).length : win.length;
    const n = Math.max(2, open);
    velocity.set(k, win.length > 0 ? total / n : 0);
  }
  return {
    weeksOf,
    currentWeek,
    velocity,
    currentKeys,
    currentNames,
    lastSeen,
    lastSeenName,
  };
}

export function velocityOf(
  idx: VelocityIndex,
  retailer: string,
  key: string,
): number {
  return idx.velocity.get(retailer + "|" + key) ?? 0;
}

// BAYAT tespiti: ürün firmanın GÜNCEL haftalık raporunda yok mu?
// İKİ anahtar birlikte kontrol edilir (muhafazakâr taraf). Sebep ölçüldü: sku_weekly
// (retailer, week_start, sku_name) ile gruplu ve barkodu (array_agg(barkod))[1] ile
// TEK keyfi değere indiriyor. Aynı isim altında birden çok barkod taşıyan 6 satırda
// (Huppaluppo 4 + DR 2) ürün anahtarı eşleşmesi kayboluyor ve ürün yanlışlıkla "bayat"
// görünüyordu — yalnız anahtarla bakınca 14 satır/8.259 adet, isimle birlikte bakınca
// 10 satır/7.925 adet. Fark (334 adet) tamamı YANLIŞ POZİTİFTİ: canlı stoğu manşetten
// düşürmek, bayatı kaçırmaktan daha kötü.
export function isStale(
  idx: VelocityIndex,
  retailer: string,
  key: string,
  sku_name: string,
): boolean {
  // Firma pencerede hiç görünmüyorsa karar veremeyiz (veri yokluğu ≠ bayat).
  if (!idx.currentWeek.has(retailer)) return false;
  return (
    !idx.currentKeys.has(retailer + "|" + key) &&
    !idx.currentNames.has(retailer + "|" + sku_name)
  );
}

export function lastSeenOf(
  idx: VelocityIndex,
  retailer: string,
  key: string,
  sku_name: string,
): string | null {
  return (
    idx.lastSeen.get(retailer + "|" + key) ??
    idx.lastSeenName.get(retailer + "|" + sku_name) ??
    null
  );
}

// Ham fact satırlarından SKU bazında coverage (mağaza-bazlı tek mağaza için kullanılır).
// velocityWeeks verilirse hız ömür ortalaması yerine veri kümesinin SON N HAFTASI
// üzerinden hesaplanır (ağ/firma görünümleriyle aynı ölçüt).
export function computeCoverage(
  rows: {
    sku_name: string;
    week_start: string;
    sales_qty: number;
    stock_qty: number;
  }[],
  velocityWeeks?: number,
): CoverageRow[] {
  const m = new Map<
    string,
    {
      weeks: Set<string>;
      total: number;
      byWeek: Map<string, number>;
      stockByWeek: Map<string, number>;
    }
  >();
  const allWeeks = new Set<string>();
  for (const r of rows) {
    allWeeks.add(r.week_start);
    let e = m.get(r.sku_name);
    if (!e) {
      e = {
        weeks: new Set(),
        total: 0,
        byWeek: new Map(),
        stockByWeek: new Map(),
      };
      m.set(r.sku_name, e);
    }
    e.weeks.add(r.week_start);
    e.total += Number(r.sales_qty);
    e.byWeek.set(
      r.week_start,
      (e.byWeek.get(r.week_start) ?? 0) + Number(r.sales_qty),
    );
    e.stockByWeek.set(
      r.week_start,
      (e.stockByWeek.get(r.week_start) ?? 0) + Number(r.stock_qty),
    );
  }
  const sorted = [...allWeeks].sort();
  const current = sorted.length ? sorted[sorted.length - 1] : null;
  const win =
    velocityWeeks && velocityWeeks > 0 ? sorted.slice(-velocityWeeks) : null;

  const out: CoverageRow[] = [];
  for (const [sku, e] of m) {
    const own = [...e.weeks].sort();
    const lastWeek = own[own.length - 1]!;
    const lastStock = e.stockByWeek.get(lastWeek) ?? 0;
    const avg = win
      ? win.reduce((a, w) => a + (e.byWeek.get(w) ?? 0), 0) / win.length
      : e.weeks.size > 0
        ? e.total / e.weeks.size
        : 0;
    out.push({
      sku_name: sku,
      avg_weekly: avg,
      last_stock: lastStock,
      coverage: avg > 0 ? lastStock / avg : null,
      // Bu mağazanın son raporunda görünmüyorsa stok kalıntıdır.
      stale: current != null && lastWeek !== current,
      last_seen: lastWeek,
    });
  }
  return out;
}

// ═══════════════════════ ÖLÜ STOK (ağ geneli, firmalar arası) ═══════════════════════
// product_coverage matview satırları (her satır bir ürün×firma) → ürün bazında
// firmalar arası birleştirilir. Ağ coverage = toplam stok / toplam haftalık hız.
// Coverage null + stok>0 = hiç satmayan (sonsuz coverage = en ölü).

export interface CoverageItem {
  retailer: string;
  product_key: string;
  barkod: string | null;
  sku_name: string;
  avg_weekly: number;
  last_stock: number;
  coverage_weeks: number | null;
  stale?: boolean; // firmanın güncel raporunda yok (bkz. isStale)
}
export interface DeadStockFirm {
  retailer: string;
  sku_name?: string;
  stock: number;
  velocity: number;
  coverage: number | null;
  stale?: boolean;
}
export interface DeadStockProduct {
  product_key: string;
  barkod: string | null;
  name: string;
  total_stock: number;
  total_velocity: number;
  coverage: number | null; // ağ geneli
  never_sold: boolean; // hiçbir firmada satmıyor ama stok var
  max_firm_coverage: number | null; // en yüksek firma coverage (∞ → null)
  stale?: boolean; // TÜM firmalarda bayat (hiçbir güncel raporda yok)
  stale_stock?: number; // bayat firmalardaki stok toplamı
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
    const name =
      [...arr].sort((a, b) => b.sku_name.length - a.sku_name.length)[0]
        ?.sku_name || pk.replace(/^NAME:/, "");
    const barkod = arr.find((r) => r.barkod)?.barkod ?? null;
    // YANIT BOYUTU: firma satırındaki sku_name ürün adıyla aynıysa TEKRAR EDİLMEZ
    // (UI eksikse p.name'e düşer). Aynı isim yanıtta 3 kez geçiyordu: items[],
    // products[].name ve products[].firms[].sku_name.
    const firms: DeadStockFirm[] = arr
      .map((r) => ({
        retailer: r.retailer,
        ...(r.sku_name && r.sku_name !== name ? { sku_name: r.sku_name } : {}),
        stock: r.last_stock,
        velocity: r.avg_weekly,
        coverage: r.coverage_weeks,
        ...(r.stale ? { stale: true } : {}),
      }))
      .sort((a, b) => b.stock - a.stock);
    // en yüksek firma coverage (hiç satmayan-stoklu firma varsa ∞ = null)
    let maxFirm = 0;
    let inf = false;
    for (const f of firms) {
      if (f.coverage == null) {
        if (f.stock > 0) inf = true;
      } else if (f.coverage > maxFirm) maxFirm = f.coverage;
    }
    const staleStock = arr.reduce(
      (a, r) => a + (r.stale ? r.last_stock : 0),
      0,
    );
    const allStale = arr.length > 0 && arr.every((r) => r.stale);
    out.push({
      product_key: pk,
      barkod,
      name,
      total_stock,
      total_velocity,
      coverage,
      never_sold: coverage == null && total_stock > 0,
      max_firm_coverage: inf ? null : maxFirm,
      ...(allStale ? { stale: true } : {}),
      ...(staleStock > 0 ? { stale_stock: staleStock } : {}),
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
// BAYAT satırlar listede KALIR (rozetli) ama sayımlara girmez: stoğu firmanın güncel
// raporunda olmadığı için "az stok / fazla" kararına dayanak olamaz.
export function summarizeCoverage(rows: CoverageRow[]) {
  const order: Record<CoverageStatus, number> = {
    kritik: 0,
    fazla: 1,
    saglikli: 2,
    yok: 9,
  };
  const items = rows
    .map((r) => ({
      ...r,
      status: coverageStatus(r.coverage, r.avg_weekly, r.last_stock),
    }))
    .filter((r) => r.status !== "yok")
    .sort(
      (a, b) =>
        // Bayatlar en sona: listede görünsünler ama aksiyon sırasını kirletmesinler.
        Number(a.stale ?? false) - Number(b.stale ?? false) ||
        order[a.status] - order[b.status] ||
        // kritikler en düşük coverage önce; fazlalar en yüksek coverage önce
        (a.status === "kritik"
          ? (a.coverage ?? 0) - (b.coverage ?? 0)
          : (b.coverage ?? 1e9) - (a.coverage ?? 1e9)),
    );
  const live = items.filter((i) => !i.stale);
  const stale = items.filter((i) => i.stale);
  return {
    skus: items,
    summary: {
      kritik: live.filter((i) => i.status === "kritik").length,
      fazla: live.filter((i) => i.status === "fazla").length,
      saglikli: live.filter((i) => i.status === "saglikli").length,
      toplam: live.length,
      bayat: stale.length,
      bayat_stok: stale.reduce((a, i) => a + i.last_stock, 0),
    },
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// VERİ YAŞI VE GERİ ALINAMAZLIK — SAF FONKSİYONLAR
//
// Buradaki hiçbir fonksiyon I/O yapmaz ve `new Date()`'i İÇERİDEN OKUMAZ; tarih
// her zaman parametre olarak geçer. Sebep: bu kurallar para kararı üretiyor
// (bir kalemin indirimle yok edilip edilmeyeceğini belirliyorlar) ve test
// edilemeyen bir para kuralı savunulamaz. `/api/routing` ile `/api/stock` aynı
// fonksiyonları çağırır — iki ekranın aynı ürün için farklı sayı göstermesi bu
// projede daha önce üç kez yaşandı, tek kaynak kuralı onun için var.
//
// İKİ AYRI KAPI OLDUĞUNU AKILDA TUTMAK ŞART:
//   (A) KANIT KAPISI  — `likidasyonKapisi`. Veri yaşından BAĞIMSIZ. "Eski sezon"
//       etiketi taşıyan bir kalem hâlâ satıyorsa markdown'a yazılmaz.
//   (B) VERİ YAŞI     — `gecikmeHaftasi` / `kararGecikmesi` / `yaslandir` /
//       `kademeOf`. Yalnız ÇEK adedini kırpar ve geri alınamaz fiilleri askıya
//       alır; SEVK'i hiçbir kademede bastırmaz.
// Ölçüm (2026-09-07): yanlış likidasyonun %99'u (₺2,72 mn'un Nezih dışındaki
// tamamı) gecikmesi 0-1 hafta olan firmalardan geliyor. Yani (B) kapısı tek
// başına konsa para hatası yerinde kalırdı; (A) bu yüzden ayrı ve önce.
// ═══════════════════════════════════════════════════════════════════════════

const HAFTA_MS = 7 * 86400000;

/** Rozet/alarm eşiği (hafta). `/api/stores`'daki STALE_WEEKS ile aynı gerekçe:
 *  beş firmanın rapor aralığının medyanı 1 hafta, yani 1 haftalık gecikme
 *  normal kadanstır — 1'de rozet basmak 10 satırın 10'unu işaretliyordu. */
export const GECIKME_ROZET = 2;
/** Bu gecikmeden itibaren LİKİDASYON askıya alınır. Medyan kadansın 3 katı;
 *  ayrıca 4 haftalık ufukta "stok hız kadar erir" tahmincisinin net hatası
 *  konsinye kanalda −%12,5…−%26,5 ölçüldü: düzeltme aracının kendisi bu ufukta
 *  güvenilmezken geri alınamaz karar üretilemez. */
export const GECIKME_TASFIYE = 3;
/** Bu gecikmeden itibaren DEPO/TRANSFER de askıya alınır. SEVK ve TEYİT DEVAM
 *  EDER. 6 seçildi çünkü 12 haftalık veri penceresinden düşme uçurumundan önce
 *  ateşlenir: pencereden düşen firmanın hızı 0 görünür ve motor sessizce
 *  "ölü → tüm stoğu çek" der (ölçülen risk: 68 satır / ₺1.630.875). */
export const GECIKME_CEK = 6;
/** Bu gecikmeden sonra soru değişir: "stok ne olacak" değil, "hesap kapandı mı".
 *  Erime tahmini de bu ufuktan sonra yayınlanmaz (bkz. yaslandir). */
export const GECIKME_KAPANMA = 8;
/** "Hâlâ satıyor" eşiği. Yeni sabit değil — routing'deki DEAD ile aynı. */
export const LIKID_MIN_VEL = 1;
/** Emme ufku (hafta). Yeni sabit değil — routing'deki ABSORB ile aynı: motorun
 *  zaten "bu kanal bu kadarını emer" dediği pencere. 26 haftada satarak tükenen
 *  mal indirimle yok edilmez. */
export const LIKID_ABSORB = 26;
/** Kapsamı bu değerin altına inmiş ERİT kalemi için sevk hedefi (hafta).
 *  Normal hedef 8-10 hf; eski sezon etiketi taşıyan malda talebin sönme riski
 *  gerçek olduğu için hedef bilinçli olarak kısa tutulur. */
export const ERIT_SEVK_HEDEF = 4;
/** Türkiye kalıcı UTC+3 (2016'dan beri yaz saati uygulaması yok). Sunucu UTC
 *  çalıştığı için takvim haftası bu ofsetle türetilir: aksi halde Pazartesi
 *  00:00-03:00 yerel saatte fonksiyon bir hafta geriyi döndürüp TÜM firmaların
 *  gecikmesini 3 saat boyunca +1 gösteriyordu. */
export const TR_OFSET_SAAT = 3;

const isoGun = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/**
 * Son TAMAMLANMIŞ ISO haftasının Pazartesi'si.
 *
 * NEDEN AĞIN EN YENİ HAFTASI DEĞİL: ağın haftası, o haftayı raporlamış tek bir
 * firma yüzünden ilerliyor. Beş firma da göndermeyi bırakırsa ağ-tabanlı
 * gecikme herkeste 0 kalır ve sağlık skoru düşmek yerine YÜKSELİR (ölçüldü).
 * Takvim çapası bunu imkânsız kılar.
 */
export function sonTamamlanmisHafta(
  bugun: Date,
  ofsetSaat = TR_OFSET_SAAT,
): string {
  const t = new Date(bugun.getTime() + ofsetSaat * 3600000);
  const pazartesiFarki = (t.getUTCDay() + 6) % 7; // Pazartesi→0 … Pazar→6
  const buHaftaPazartesi =
    Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate()) -
    pazartesiFarki * 86400000;
  return isoGun(buHaftaPazartesi - HAFTA_MS);
}

/**
 * Firmanın son rapor haftasının yaşı (hafta). Veri yoksa 99.
 *
 * `Math.max(0, …)`: Huppaluppo kapanan haftayı aynı Pazartesi sabahı yüklüyor;
 * devam eden haftayı yüklerse fark negatif çıkar ve kademe mantığı tanımsız
 * davranırdı.
 */
export function gecikmeHaftasi(
  dataWeek: string | null | undefined,
  takvimHaftasi: string,
): number {
  if (!dataWeek) return 99;
  const d = Math.round(
    (Date.parse(takvimHaftasi) - Date.parse(dataWeek)) / HAFTA_MS,
  );
  return Number.isFinite(d) ? Math.max(0, d) : 99;
}

/**
 * KARAR GECİKMESİ — kademe (rozet/askı) kararının girdisi.
 *
 * `gecikmeHaftasi` "en yeni rapor kaç hafta önce" der; bu fonksiyon "kararı
 * dayandıracağım en yeni SAĞLAM nokta kaç hafta önce" der. Çapa, kendisi VE bir
 * öncesi raporlanmış en yeni haftadır.
 *
 * NEDEN: histerezis. Nezih 4 hafta geride; yalnız 17 Ağustos'u yüklerse düz
 * gecikme 4 → 2'ye iner ve tasfiye kararı hâlâ iki hafta eski veriyle yeniden
 * açılırdı. Çapa kuralıyla 10 Ağustos boşluğu durduğu için gecikme 4 kalır ve
 * firma ancak boşluğunu doldurunca askıdan çıkar. Kalıcı tablo gerekmez; durum
 * her istekte hafta serisinden türetilir.
 *
 * Bugünkü veriyle düz gecikmeyle BİREBİR aynı sonucu veriyor (Huppaluppo 0 ·
 * Toyzz/D&R/Armağan 1 · Nezih 4) — ölçüldü; fark yalnız boşluklu yüklemede doğar.
 * Hiç ardışık çift yoksa (yeni firma, tek haftalık geçmiş) düz gecikmeye düşer.
 */
export function kararGecikmesi(
  haftalar: string[],
  takvimHaftasi: string,
): number {
  if (!haftalar.length) return 99;
  const set = new Set(haftalar);
  const t = Date.parse(takvimHaftasi);
  for (let i = 0; i <= GECIKME_KAPANMA + 6; i++) {
    const w = isoGun(t - i * HAFTA_MS);
    if (set.has(w) && set.has(isoGun(t - (i + 1) * HAFTA_MS))) return i;
  }
  const enYeni = haftalar.reduce((m, w) => (w > m ? w : m), haftalar[0]);
  return gecikmeHaftasi(enYeni, takvimHaftasi);
}

/**
 * ERİME: rapor tarihinden bugüne muhtemelen satılmış adet.
 *
 * drenaj = round(hız × gecikme), stoğu geçemez. Hız YAYINLANAN değerle
 * (`r1(v)`) verilir — ekranda "1,0/hf" yazan satırın arkasında 0,96 ile karar
 * verilmesi bu kod tabanında bilinçli olarak reddedilmiş bir davranış
 * (bkz. routing sevkKritik notu: "ölçüt görünen sayıdır").
 *
 * GECIKME_KAPANMA ÜSTÜ YAYINLANMAZ: 8 haftadan uzun sessizlikte "stok hız kadar
 * erir" varsayımı ölçülen hatasıyla anlamsız; o satırlar zaten askıda olduğu
 * için tahmin yalnız ekranda durur, ve dayanağı olmayan bir "tahmini stok: 0"
 * basmak sistemin en tehlikeli çıktısı olurdu.
 */
export function yaslandir(
  stock: number,
  velocity: number,
  gecikmeHf: number,
): { drenaj: number; stokYaslandirilmis: number } {
  const s = Math.max(0, stock || 0);
  const g = Math.min(Math.max(0, gecikmeHf || 0), GECIKME_KAPANMA);
  const drenaj = Math.min(s, Math.max(0, Math.round((velocity || 0) * g)));
  return { drenaj, stokYaslandirilmis: s - drenaj };
}

export interface Kademe {
  rozet: boolean;
  likidasyonAcik: boolean;
  cekAcik: boolean;
  kapanmaSorusu: boolean;
  /** Ekranda basılan Türkçe durum metni. Y0/Y1/T2 gibi makine kodu üretilmez. */
  durum: string;
  /** Karar üretimi hakkında tek cümlelik özet. */
  karar: string;
}

/** Kademe: hangi fiiller açık, hangi metin basılır. SEVK ve TEYİT bu tabloda
 *  HİÇ YOK — hiçbir kademede bastırılmadıkları için. Hata yönü ölçümle
 *  sistematik: her firmada "fazla çek + eksik sevk", hiçbir ileri simülasyonda
 *  "eksik çek" çıkmadı. Bayat veri sevki yanlış değil EKSİK yapar; bastırmak
 *  geri gelmeyen tek kaybı kesinleştirir. */
export function kademeOf(gecikmeHf: number): Kademe {
  const g = Math.max(0, gecikmeHf || 0);
  const likidasyonAcik = g < GECIKME_TASFIYE;
  const cekAcik = g < GECIKME_CEK;
  const durum =
    g >= 99
      ? "veri yok"
      : !cekAcik
        ? "çek askıda"
        : !likidasyonAcik
          ? "tasfiye askıda"
          : g === 0
            ? "güncel"
            : g === 1
              ? "normal kadans"
              : "gecikmeli";
  return {
    rozet: g >= GECIKME_ROZET,
    likidasyonAcik,
    cekAcik,
    kapanmaSorusu: g >= GECIKME_KAPANMA,
    durum,
    karar: !cekAcik
      ? "çek askıda"
      : !likidasyonAcik
        ? "tasfiye askıda"
        : "üretiliyor",
  };
}

/**
 * DÜŞEN TALEP KAPISI (2026-10-16) — yönlendirme motorunun SEVK adedini besler.
 *
 * Motorun hızı son 8 rafta-haftanın ortalamasıdır; sönen üründe güncel talebin
 * katlarını gösterir ve rafı dolu ürüne sevk istenir. Bu kapı, son TREND_SON
 * rafta-haftanın ortalaması 8 hf ortalamasının TREND_ESIK katının altındaysa
 * güncel hızı döndürür; motor sevk adedini bununla hesaplar.
 *
 * Düşüş RAF BOŞALMASINDAN gelmemeli: son haftaların her biri satışından fazla
 * stokla kapanmış olmalı (boş raf satışı zaten düşürür; orada sevki kısmak
 * kaybı kesinleştirir). Haftası eksik (stok bilinmiyor) ya da toplam rafta-
 * haftası TREND_SON + 2'den az olan ürün kapıdan geçmez → null (eski davranış).
 *
 * @param acik  rafta geçen haftalar, eskiden yeniye: { satis, stok } (yoksa null)
 * @param v8    motorun 8 hf ortalama hızı
 */
export const TREND_SON = 3;
export const TREND_ESIK = 0.7;
export function dusenTalepHizi(
  acik: { satis: number | null; stok: number | null }[],
  v8: number,
): number | null {
  if (!(v8 > 0) || acik.length < TREND_SON + 2) return null;
  const son = acik.slice(-TREND_SON);
  for (const h of son) {
    if (h.satis == null || h.stok == null || h.stok <= 0 || h.stok < h.satis)
      return null;
  }
  const vSon = son.reduce((t, h) => t + (h.satis ?? 0), 0) / TREND_SON;
  return vSon < v8 * TREND_ESIK ? vSon : null;
}

export type LikidKapi = "tam" | "kismi" | "erit";

/**
 * KANIT KAPISI. Eski sezon etiketi tek başına markdown gerekçesi değildir.
 *
 * Motor bugün likidasyonu YALNIZ SKU adındaki sezon regex'inden doğuruyor: hız
 * yok, kapsam yok, rafın tamamı tam PSF ile indirime yazılıyor. Ölçüldü
 * (2026-09-07): 239 likidasyon kaleminin 61'i hâlâ satıyor — 20.580 adet /
 * ₺2.721.695 brüt, üzerinde haftalık ₺28.655 net akış; 22 kalem ≥5 adet/hf.
 * Uç örnek: Toyzz "ÇIKARTMA ALBÜMÜ GS ŞAMPİYON KADRO" 662 adet, 25,8/hf.
 *
 * `velocity` ve `coverage` YAYINLANAN değerlerle geçilir (r1 / Math.round);
 * ekranda "1,0/hf · 26 hf" okuyan kişi ile motorun aynı satırı görmesi şart.
 */
export function likidasyonKapisi(
  stock: number,
  velocity: number,
  coverage: number | null,
): { kapi: LikidKapi; pull: number; geriBirakilan: number } {
  const s = Math.max(0, stock || 0);
  if ((velocity || 0) < LIKID_MIN_VEL)
    return { kapi: "tam", pull: s, geriBirakilan: 0 };
  // Emme ufku içinde satarak tükeniyor → indirim yok.
  if (coverage == null || coverage <= LIKID_ABSORB)
    return { kapi: "erit", pull: 0, geriBirakilan: s };
  const birak = Math.min(s, Math.ceil(velocity * LIKID_ABSORB));
  const pull = s - birak;
  // REZERV KAPISI: rezerv (hız×26) tüm rafı yiyorsa pull 0 çıkar ve satır
  // motorun `pull > 0` süzgecinden sessizce düşerdi.
  //
  // BU DAL ULAŞILABİLİR — önceki not "tutarlı girdide ulaşılamaz" diyordu ve
  // YANLIŞTI (üretimde ölçüldü: 239 kapılı satırın 1'i buradan geçiyor).
  // Sebep, hız ile kapsamın BAĞIMSIZ yuvarlanması: Toyzz "FB Sezon Kartları
  // 25'li", stok 60, ham hız ~2,26 → r1 = 2,3 ve ham kapsam ~26,6 → round = 27.
  // Kapsam 27 > 26 olduğu için emme dalı ateşlenmiyor, ama rezerv
  // ceil(2,3×26) = 60 = rafın tamamı → pull 0. Yani bu dal, iki yuvarlamanın
  // arasındaki sınır bandını yakalayan gerçek bir kapı; kozmetik değil.
  if (pull <= 0) return { kapi: "erit", pull: 0, geriBirakilan: s };
  return { kapi: "kismi", pull, geriBirakilan: birak };
}

// ═══ RAF VARLIĞI (2026-10-29) ═══════════════════════════════════════════════
// Yönlendirme motoru kapsamı HAFTA cinsinden ölçüyordu; ürünün kaç mağazada
// durduğunu hiç bilmiyordu. Ölçüm (scratchpad/yonlendirme, 2026-10-29):
//   • D&R zincir verisi, mağaza başı hafta-başı stok → satış / iyi-stoklu haftalar:
//     3+ adet ~%100 · 2-3 adet %63 · 1-2 adet %27 · <1 adet ~%10.
//   • Armağan mağaza-içi kesit (aynı ürün-hafta, mağaza büyüklüğü düzeltilmiş):
//     1 adet %9 · 2 adet %23 · 3-4 adet %60 · 5-9 adet %73 · 10+ adet %111.
// Sonuç: raf mağaza başı birkaç adetin altına inince satış çöküyor. Motor bunu
// görmediği için 29.10'da D&R/Armağan'da haftada 3+ satan ve mağaza başı <4 adeti
// kalan 65 satırın 58'ine "çek" diyordu (14.470 adet). İnce raf satışı düşürür,
// düşen satış "fazla stok" sanılır, çekilir, raf daha da incelir.

// Ürünü taşıyabilecek mağaza sayısı. D&R 229 lokasyon raporluyor ama en yaygın
// ürünler bile ~180-190 mağazada (Mart 2026 mağaza verisi: ŞL Eco 185, GS First
// 179, BJK Pre-Season 186); kalanı depo/web/kapalı. Armağan 108 mağaza.
// Mağaza kırılımı göndermeyen kanallarda (Toyzz, Nezih, Huppaluppo) değer yok →
// raf varlığı hesabı kapalı, motor eski kapsam kuralıyla çalışır.
export const MAGAZA_TASIYABILEN: Record<string, number> = {
  DR: 190,
  Armağan: 100,
};
// Ürünü taşıyan mağaza başına haftalık satış. D&R Mart 2026'da her mağazada
// olmayan 77 ürünün medyanı 0,37 (p25 0,17 · p75 1,06). Taşıması gereken mağaza
// sayısı talepten türetilir: haftada 10 satan tin ~29 mağaza, 375 satan First 190.
export const SATIS_MAGAZA_BASI = 0.35;
export const MAGAZA_ASGARI = 10;
// Mağaza başı asgari raf stoğu — senaryoya göre. Eğrinin dirseği taşıyan mağaza
// başına ~3,6 adette (zincir eğrisi 229 tabanlı ölçüldü, 190 tabanına ×1,2).
export const RAF_ASGARI: Record<string, number> = {
  koruma: 5,
  denge: 4,
  agresif: 3,
};
// ASGARİ RAF TAVANI (hafta talep). Çok yavaş üründe "taban 10 mağaza × 4 adet"
// talebin onlarca haftasına denk geliyordu (29.10 denetimi: D&R ŞL Metal Kutu
// 1/hf satarken 39 adet = 39 haftalık sevk). Asgari raf en fazla bu kadar haftalık
// talep olur; hızlı üründe bağlamaz (Pulse 133/hf: 760 < 1.596).
export const RAF_TAVAN_HF = 12;
// Eski sezon ürünü burada satmıyor ama diğer kanallar toplamda en az bu kadar
// (adet/hf) satıyorsa indirimle tasfiye edilmez; çekilip satan kanala verilir.
export const AG_TALEP_ESIK = 5;
// İnce raf düzeltmesinin tavanı. Ölçüm: ince raftan sonra yeniden stoklanan 11
// vakada ham hız gerçekleşeni %65 eksik tahmin etti; ×2 tavanla WAPE %66 → %57,
// yanlılık −%65 → −%37. Daha yüksek tavan yanlılığı azaltıp hatayı büyütüyor.
export const SANSUR_TAVAN = 2;
// İYİMSER TAVAN — yalnız "bu sipariş çok mu fazla" hükmünde kullanılır. Raf incelmiş
// üründe gerçek talep belirsiz (Toz Pembe: raf doluyken 197-210/hf, ince rafta
// 18/hf; ×2 tavan 37 diyor). Siparişi haksız yere "çok fazla" diye reddetmek
// stoksuz ürünün satışını öldürür; bu yüzden ret eşiği iyimser talepten kurulur.
export const SANSUR_TAVAN_UST = 5;
// Satan üründe rafta tutulacak üst ufuk: bunun ÜSTÜNDEKİ stok çekilir, altı
// "satarak erisin". Konsinyede malı depoya çekmek nakit yaratmaz; çekmenin değeri
// ancak mal başka yerde satılacaksa ya da ömrü içinde burada satılamayacaksa var.
export const TUT_UFKU = 26;
// Sevk kararı → rafta (hafta). Etki hesabında sevk 2. haftanın başında rafta sayılır.
export const TESLIM_HF = 1;

// Ölçülen eğri, taşıyan mağaza başı stok cinsinden (D&R zincir ölçümü ×1,2).
const RAF_EGRISI: [number, number][] = [
  [0, 0],
  [0.9, 0.12],
  [1.8, 0.27],
  [3, 0.63],
  [3.6, 0.94],
  [4.8, 1],
];
/** Taşıyan mağaza başına x adet stokla satışın normale oranı (0-1). */
export function rafPayi(x: number): number {
  if (!(x > 0)) return 0;
  const son = RAF_EGRISI[RAF_EGRISI.length - 1];
  if (x >= son[0]) return son[1];
  for (let i = 1; i < RAF_EGRISI.length; i++) {
    const [x0, y0] = RAF_EGRISI[i - 1],
      [x1, y1] = RAF_EGRISI[i];
    if (x <= x1) return y0 + ((y1 - y0) * (x - x0)) / (x1 - x0);
  }
  return son[1];
}

/** Ürünü taşıması gereken mağaza sayısı; mağaza verisi olmayan kanalda null. */
export function tasiyanMagaza(retailer: string, talep: number): number | null {
  const ust = MAGAZA_TASIYABILEN[retailer];
  if (!ust) return null;
  const n = Math.ceil(Math.max(0, talep) / SATIS_MAGAZA_BASI);
  return Math.min(ust, Math.max(MAGAZA_ASGARI, n));
}

/**
 * İnce raf düzeltmeli talep. Satış, hız penceresinde raf incelmişse gerçek
 * talebin altında kalır; ölçülen eğriyle geri açılır, SANSUR_TAVAN ile sınırlı.
 * @param hiz   motorun hızı (düşen talep kapısından geçmişse güncel hız)
 * @param rafX  pencerede taşıyan mağaza başı ortalama hafta-başı stok; null → düzeltme yok
 */
export function sansurDuzeltilmisTalep(
  hiz: number,
  rafX: number | null,
  tavan: number = SANSUR_TAVAN,
): number {
  if (!(hiz > 0)) return 0;
  if (rafX == null) return hiz;
  return hiz / Math.max(rafPayi(rafX), 1 / tavan);
}

/** Verilen stokla bir haftada beklenen satış. Mağaza sayısı yoksa: min(talep, stok). */
export function haftalikSatis(
  stok: number,
  talep: number,
  magaza: number | null,
): number {
  const s = Math.max(0, stok),
    d = Math.max(0, talep);
  if (magaza == null) return Math.min(d, s);
  return Math.min(s, d * rafPayi(s / magaza));
}

/**
 * Ufuk boyunca beklenen satış; `ek` adet `gelis` haftasının başında rafa eklenir.
 * Sevkin etkisi = beklenenSatis(..., ek) − beklenenSatis(..., 0).
 */
export function beklenenSatis(
  stok: number,
  talep: number,
  magaza: number | null,
  ek = 0,
  ufuk = 4,
  gelis = TESLIM_HF,
): number {
  let s = Math.max(0, stok),
    top = 0;
  for (let h = 0; h < ufuk; h++) {
    if (h === gelis) s += ek;
    const sat = haftalikSatis(s, talep, magaza);
    top += sat;
    s -= sat;
  }
  return top;
}

/**
 * Sorun başlamadan kaç hafta var: mağaza verisi olan kanalda stok asgari rafın
 * (esik) altına inene kadar, olmayanda teslim süresi + 1 haftalık stok kalana kadar.
 * Sevk bundan TESLIM_HF önce verilmeli; 0 → zaten geç.
 */
export function sorunHaftasi(
  stok: number,
  talep: number,
  esik: number,
): number {
  if (!(talep > 0)) return Infinity;
  const tampon = esik > 0 ? esik : talep * (TESLIM_HF + 1);
  return Math.max(0, (stok - tampon) / talep);
}
