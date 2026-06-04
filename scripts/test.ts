// CORTEX test harness — gerçek Excel verisiyle tüm iş mantığını uçtan uca test eder.
// Supabase'e gerek yok: seed/ klasöründeki Excel'leri parse eder, in-memory işler.
//
//   npx tsx scripts/test.ts   (veya: npm test)
//
// Çıkış kodu 0 = tüm testler geçti, 1 = en az bir test başarısız.

import { readFileSync, readdirSync, existsSync } from "fs";
import { join } from "path";
import { normalizeFile } from "../src/lib/normalizers/index";
import { netFactor } from "../src/lib/margins";
import { channelSummaries, consignmentKpis, reconcileChannels, aging, salesCollectionSchedule } from "../src/lib/consignment";
import type { ConsignmentLine } from "../src/lib/normalizers/types";
import { parseWeekFromFilename } from "../src/lib/normalizers/week-parser";
import type { Retailer, UnifiedRow } from "../src/lib/normalizers/types";
import {
  linregSlope, momentum, forecastNextWeek, anomalyScore, sellThrough, weeksOfStock, wowPct,
} from "../src/lib/analytics";
import {
  buildSummary, retailerCardMetrics, generateInsights, findStockoutRisks,
  computeStockAlerts, reorderPriority, pivotProduct, parseProductMeta, categoryBreakdown,
  storePerformance, globalRankings, execOverview, comparePeriods, type FactRow,
} from "../src/lib/compute";

let passed = 0, failed = 0;
const failures: string[] = [];

function check(name: string, cond: boolean, extra = "") {
  if (cond) { passed++; }
  else { failed++; failures.push(`✗ ${name}${extra ? " — " + extra : ""}`); console.log(`  ✗ ${name}${extra ? " — " + extra : ""}`); }
}
function approx(a: number, b: number, tol = 0.01) { return Math.abs(a - b) <= tol; }
function section(t: string) { console.log(`\n━━ ${t} ━━`); }

// ───────────────────────── 1. ANALYTICS UNIT TESTS ─────────────────────────
section("1. Analytics (unit)");
check("linregSlope artan seri pozitif", linregSlope([1, 2, 3, 4]) > 0);
check("linregSlope azalan seri negatif", linregSlope([4, 3, 2, 1]) < 0);
check("linregSlope düz seri ~0", approx(linregSlope([5, 5, 5]), 0));
check("linregSlope tek eleman 0", linregSlope([5]) === 0);

check("momentum artan pozitif", (momentum([
  { week_start: "1", sales_qty: 10, sales_value: null, stock_qty: 0 },
  { week_start: "2", sales_qty: 20, sales_value: null, stock_qty: 0 },
  { week_start: "3", sales_qty: 30, sales_value: null, stock_qty: 0 },
  { week_start: "4", sales_qty: 40, sales_value: null, stock_qty: 0 },
], 4) ?? 0) > 0);
check("momentum tek hafta null", momentum([{ week_start: "1", sales_qty: 10, sales_value: null, stock_qty: 0 }]) === null);

check("forecast makul aralıkta", (() => {
  const f = forecastNextWeek([
    { week_start: "1", sales_qty: 100, sales_value: null, stock_qty: 0 },
    { week_start: "2", sales_qty: 110, sales_value: null, stock_qty: 0 },
    { week_start: "3", sales_qty: 120, sales_value: null, stock_qty: 0 },
    { week_start: "4", sales_qty: 130, sales_value: null, stock_qty: 0 },
  ], 4);
  return f != null && f > 110 && f < 160;
})());
check("forecast negatif olmaz", (forecastNextWeek([
  { week_start: "1", sales_qty: 5, sales_value: null, stock_qty: 0 },
  { week_start: "2", sales_qty: 0, sales_value: null, stock_qty: 0 },
], 4) ?? -1) >= 0);

check("anomali normal seri yakalanmaz", anomalyScore([
  { week_start: "1", sales_qty: 100, sales_value: null, stock_qty: 0 },
  { week_start: "2", sales_qty: 102, sales_value: null, stock_qty: 0 },
  { week_start: "3", sales_qty: 98, sales_value: null, stock_qty: 0 },
  { week_start: "4", sales_qty: 101, sales_value: null, stock_qty: 0 },
])?.isAnomaly === false);
check("anomali spike yakalanır", anomalyScore([
  { week_start: "1", sales_qty: 100, sales_value: null, stock_qty: 0 },
  { week_start: "2", sales_qty: 102, sales_value: null, stock_qty: 0 },
  { week_start: "3", sales_qty: 98, sales_value: null, stock_qty: 0 },
  { week_start: "4", sales_qty: 500, sales_value: null, stock_qty: 0 },
])?.isAnomaly === true);

check("sellThrough hesap", approx(sellThrough(25, 75)!, 25));
check("sellThrough sıfır payda null", sellThrough(0, 0) === null);
check("weeksOfStock hesap", approx(weeksOfStock(100, 25)!, 4));
check("weeksOfStock satış yok null", weeksOfStock(100, 0) === null);
check("wowPct hesap", approx(wowPct(120, 100)!, 20));
check("wowPct sıfır baz null", wowPct(120, 0) === null);

// ───────────────────────── 2. WEEK PARSER ─────────────────────────
section("2. Week parser");
const wpCases: [string, string, string][] = [
  ["Nezih 04.05-10.05.xlsx", "2026-05-04", "2026-05-10"],
  ["ASEPTO SATIŞ STOK 29 Aralık - 4 Ocak.xlsx", "2025-12-29", "2026-01-04"],
  ["23 Şubat-1 Mart-Asepto.xlsx", "2026-02-23", "2026-03-01"],
  ["11-17 Mayıs-Asepto.xlsx", "2026-05-11", "2026-05-17"],
  ["19.05-25.05.xlsx", "2026-05-19", "2026-05-25"],
  ["1-7 Aralık -Asepto.xlsx", "2025-12-01", "2025-12-07"],
];
for (const [fn, es, ee] of wpCases) {
  const w = parseWeekFromFilename(fn);
  check(`parse "${fn}"`, w?.start === es && w?.end === ee, w ? `${w.start}→${w.end}` : "null");
}
check("parse bilinmeyen null", parseWeekFromFilename("rastgele_dosya.xlsx") === null);

// ───────────────────────── 3. NORMALIZERS (gerçek Excel) ─────────────────────────
section("3. Normalizers (gerçek dosyalar)");
const FOLDERS: Record<string, Retailer> = { toyzz: "Toyzz", dr: "DR", nezih: "Nezih" };
let allRows: UnifiedRow[] = [];
let fileCount = 0, emptyCount = 0;

const seedRoot = join(process.cwd(), "seed");
if (!existsSync(seedRoot)) {
  console.log("\n⚠ seed/ klasörü yok — normalizer & entegrasyon testleri atlanıyor.");
  console.log("  (Excel'leri seed/toyzz, seed/dr, seed/nezih altına koyup tekrar çalıştır.)");
} else {
  for (const [folder, retailer] of Object.entries(FOLDERS)) {
    const dir = join(seedRoot, folder);
    if (!existsSync(dir)) continue;
    for (const file of readdirSync(dir).filter((f) => /\.xlsx?$/i.test(f) && !f.startsWith("~$"))) {
      try {
        const buf = readFileSync(join(dir, file));
        const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
        const rows = normalizeFile(ab as ArrayBuffer, retailer, file);
        allRows = allRows.concat(rows);
        fileCount++;
      } catch (e: any) {
        if (e.message.includes("boş")) emptyCount++;
        else { failed++; failures.push(`✗ normalize ${folder}/${file}: ${e.message}`); }
      }
    }
  }

  check("en az 40 dosya işlendi", fileCount >= 40, `${fileCount} dosya`);
  check("boş dosyalar yakalandı", emptyCount >= 1, `${emptyCount} boş`);
  check("toplam satır > 300K", allRows.length > 300000, `${allRows.length} satır`);
  check("tüm satırlarda retailer var", allRows.every((r) => r.retailer));
  check("tüm satırlarda geçerli week_start", allRows.every((r) => /^\d{4}-\d{2}-\d{2}$/.test(r.week_start)));
  check("sales_qty makul aralıkta (iadeler dahil)", allRows.every((r) => r.sales_qty > -1000 && r.sales_qty < 1e6));
  check("net haftalık satış pozitif (iadeler toplamı bozmuyor)", (() => {
    const byWeek = new Map<string, number>();
    for (const r of allRows) byWeek.set(`${r.retailer}|${r.week_start}`, (byWeek.get(`${r.retailer}|${r.week_start}`) ?? 0) + r.sales_qty);
    return [...byWeek.values()].every((v) => v > 0);
  })());
  check("stock_qty sayı", allRows.every((r) => typeof r.stock_qty === "number" && !isNaN(r.stock_qty)));

  // Bilinen değer doğrulamaları (Python ETL ile birebir)
  const nezih1105 = allRows.filter((r) => r.retailer === "Nezih" && r.week_start === "2026-05-11");
  check("Nezih 11.05 = 442 adet", approx(nezih1105.reduce((a, r) => a + r.sales_qty, 0), 442, 0.5),
    `${nezih1105.reduce((a, r) => a + r.sales_qty, 0)}`);

  // DR Salı-başlangıçlı haftayı kanonik Pazartesi'ye (05-19 → 05-18) hizalar
  const dr1905 = allRows.filter((r) => r.retailer === "DR" && r.week_start === "2026-05-18");
  check("DR 18.05 (kanonik, 19.05 Salı→Pzt) = 5598 adet", approx(dr1905.reduce((a, r) => a + r.sales_qty, 0), 5598, 0.5),
    `${dr1905.reduce((a, r) => a + r.sales_qty, 0)}`);

  // ───────── 4. COMPUTE (gerçek veri) ─────────
  section("4. Compute katmanı (gerçek veri)");
  const facts: FactRow[] = allRows.map((r) => ({
    retailer: r.retailer, week_start: r.week_start, store: r.store,
    sku_name: r.sku_name, barkod: r.barkod, sales_qty: r.sales_qty,
    sales_value: r.sales_value, stock_qty: r.stock_qty,
  }));

  const summary = buildSummary(facts);
  check("summary boş değil", summary.length > 0, `${summary.length} satır`);
  check("summary 3 perakendeci", new Set(summary.map((s) => s.retailer)).size === 3);
  check("summary hafta sıralı", summary.every((s, i) => i === 0 || summary[i - 1].week_start <= s.week_start));

  // Kart metrikleri — her perakendecinin en güncel haftası
  for (const ret of ["Toyzz", "DR", "Nezih"]) {
    const weeks = [...new Set(summary.filter((s) => s.retailer === ret).map((s) => s.week_start))].sort();
    const latest = weeks[weeks.length - 1];
    const m = retailerCardMetrics(summary, ret, latest);
    check(`${ret} kart metriği üretildi`, m !== null);
    check(`${ret} kart sales_qty >= 0`, (m?.sales_qty ?? -1) >= 0);
    check(`${ret} kart spark dizi`, Array.isArray(m?.spark) && m!.spark.length > 0);
    check(`${ret} kart WoW sayı veya null`, m?.wow === null || typeof m?.wow === "number");
  }

  // Insights
  const insights = generateInsights(summary, []);
  check("insights dizi döndü", Array.isArray(insights));
  check("insights severity geçerli", insights.every((i) =>
    ["critical", "warning", "positive", "info"].includes(i.severity)));
  check("insights kritik önce sıralı", (() => {
    const ord = { critical: 0, warning: 1, positive: 2, info: 3 };
    return insights.every((ins, i) => i === 0 || ord[insights[i - 1].severity] <= ord[ins.severity]);
  })());
  check("insights her birinde başlık+detay", insights.every((i) => i.title && i.detail && i.retailer));

  // Stockout risk
  const drWeeks = [...new Set(facts.filter((f) => f.retailer === "DR").map((f) => f.week_start))].sort().slice(-4);
  const drRecent = facts.filter((f) => f.retailer === "DR" && drWeeks.includes(f.week_start));
  const risks = findStockoutRisks(drRecent, "DR", drWeeks);
  check("stockout risk dizi", Array.isArray(risks));
  check("stockout risk wos < 2", risks.every((r) => r.wos < 2));

  // Stok alarm
  const drAllWeeks = [...new Set(facts.filter((f) => f.retailer === "DR").map((f) => f.week_start))].sort();
  const lw = drAllWeeks[drAllWeeks.length - 1], pw = drAllWeeks[drAllWeeks.length - 2];
  const alerts = computeStockAlerts(
    facts.filter((f) => f.retailer === "DR" && f.week_start === lw),
    facts.filter((f) => f.retailer === "DR" && f.week_start === pw),
    10, 30
  );
  check("stok alarm critical dizi", Array.isArray(alerts.critical));
  check("stok alarm declining dizi", Array.isArray(alerts.declining));
  check("critical hepsi <= eşik", alerts.critical.every((c: any) => c.stock_qty <= 10));
  check("declining hepsi <= -30%", alerts.declining.every((d: any) => d.pct <= -30));

  // Sipariş önceliği (reorder) — son N haftanın haftalık ortalamasına göre
  const drWin = [...new Set(facts.filter((f) => f.retailer === "DR").map((f) => f.week_start))].sort().slice(-4);
  const reorder = reorderPriority(facts.filter((f) => f.retailer === "DR" && drWin.includes(f.week_start)), drWin, 10);
  check("reorder hepsi ort. satış >= 10", reorder.every((r) => r.avg_sales >= 10));
  check("reorder kapsam artan (aciliyet sırası)", reorder.every((r, i) => i === 0 || (reorder[i - 1].cover ?? 0) <= (r.cover ?? 0)));
  check("reorder tükendi => stok 0", reorder.filter((r) => r.status === "tükendi").every((r) => r.stock_qty <= 0));
  check("reorder weeks_used <= 4", reorder.every((r) => r.weeks_used <= 4));
  check("reorder boş giriş boş", reorderPriority([], [], 10).length === 0);

  // Net kazanç (çalışma marjı + KDV) — margins.ts
  check("net Toyzz %50: 1000 → ~416,7", Math.abs(1000 * netFactor("Toyzz") - 416.6667) < 0.1);
  check("net Nezih %43: 100 → 47,5", Math.abs(100 * netFactor("Nezih") - 47.5) < 0.001);
  check("net DR %47: 100 → ~44,17", Math.abs(100 * netFactor("DR") - 44.1667) < 0.01);
  check("net tanımsız kanal → yalnız KDV (÷1,2)", Math.abs(120 * netFactor("Bilinmeyen") - 100) < 0.001);

  // ───────── Sat-Öde / Konsinye (consignment.ts) ─────────
  const cl = (o: { r: string; inv: string; idate: string; due: string; qty: number; net: number; vat: number }): ConsignmentLine => ({
    retailer: o.r as any, cari_adi: o.r, cari_kodu: null, invoice_no: o.inv, belge_no: null,
    invoice_date: o.idate, due_date: o.due, line_no: null, stock_code: null, product_name: "X",
    ana_grup: null, alt_grup: null, qty: o.qty, unit_price_net: null,
    net_amount: o.net, vat: o.vat, total: o.net + o.vat, source_file: "t",
  });
  const clines = [
    cl({ r: "DR", inv: "A1", idate: "2026-02-01", due: "2026-05-01", qty: 10, net: 100, vat: 20 }),
    cl({ r: "Toyzz", inv: "B1", idate: "2026-02-10", due: "2026-07-10", qty: 5, net: 50, vat: 10 }),
  ];
  const cToday = "2026-06-01";
  const cDR = channelSummaries(clines, cToday).find((c) => c.retailer === "DR")!;
  check("consign DR total=net+vat=120", cDR.total === 120 && cDR.net === 100 && cDR.vat === 20);
  const cKpi = consignmentKpis(clines, cToday);
  check("consign KPI gross=net×1.2 (KDV %20)", Math.abs(cKpi.totalGross - cKpi.totalNet * 1.2) < 0.01);
  check("consign KPI kanal=2", cKpi.channelCount === 2);
  const cWk = [
    { retailer: "DR", week_start: "2026-01-01", net: 30 }, // sevk öncesi → sayılmamalı
    { retailer: "DR", week_start: "2026-03-01", net: 70 },
  ];
  const rDR = reconcileChannels(clines, cWk).find((r) => r.retailer === "DR")!;
  check("reconcile DR coverage ok", rDR.coverage === "ok");
  check("reconcile pencere: sevk öncesi satış elenir (soldNet=70)", rDR.soldNet === 70);
  check("reconcile DR sell%=70", Math.abs((rDR.sellThroughPct ?? 0) - 70) < 0.01);
  check("reconcile DR iade riski=30", rDR.returnRiskNet === 30);
  const rTZ = reconcileChannels(clines, cWk).find((r) => r.retailer === "Toyzz")!;
  check("reconcile satış verisi yok → coverage none", rTZ.coverage === "none");
  check("aging DR vadesi geçmiş → overdue=120", aging(clines, cToday).overdue === 120);
  const cSc = salesCollectionSchedule(cWk, cToday);
  check("salesSchedule toplam net=100", Math.abs((cSc.collectedTotal + cSc.upcomingTotal) - 100) < 0.01);

  // Ürün pivot — barkodu olan bir SKU seç
  const sampleBarkod = facts.find((f) => f.barkod && f.retailer === "Nezih")?.barkod;
  if (sampleBarkod) {
    const prodRows = facts.filter((f) => f.barkod === sampleBarkod);
    const pivot = pivotProduct(prodRows);
    check("pivot name var", !!pivot.name);
    check("pivot weeks sıralı", pivot.weeks.every((w, i) => i === 0 || pivot.weeks[i - 1] <= w));
    check("pivot series hafta sayısı eşleşir", pivot.series.length === pivot.weeks.length);
    check("pivot totals retailer eşleşir", pivot.totals.length === pivot.retailers.length);
  } else {
    check("pivot için örnek barkod bulundu", false, "barkodlu Nezih satırı yok");
  }

  // ───────── 5. EDGE CASES ─────────
  section("5. Edge cases");
  check("buildSummary boş giriş boş çıkış", buildSummary([]).length === 0);
  check("retailerCardMetrics olmayan hafta null", retailerCardMetrics(summary, "Toyzz", "1999-01-01") === null);
  check("generateInsights boş summary boş", generateInsights([], []).length === 0);
  check("computeStockAlerts boş giriş boş", (() => {
    const a = computeStockAlerts([], [], 10, 30);
    return a.critical.length === 0 && a.declining.length === 0;
  })());
  // ───────── 6. ÜRÜN ZEKASI & YENİ KATMANLAR ─────────
  section("6. Ürün zekası, mağaza, kategori, sıralama");

  // parseProductMeta
  check("parse Beşiktaş takım", parseProductMeta("Mythos Beşiktaş Kart First 25/26").team === "Beşiktaş");
  check("parse Galatasaray takım", parseProductMeta("Mythos Galatasaray First 2025/26").team === "Galatasaray");
  check("parse Mythos marka", parseProductMeta("Mythos Beşiktaş Booster").brand === "Mythos");
  check("parse Topps marka", parseProductMeta("Topps-UEFA 25 Şamp.Ligi Sticker").brand === "Topps");
  check("parse Booster tip", parseProductMeta("Mythos Beşiktaş Booster Paket").type === "Booster");
  check("parse Sticker tip", parseProductMeta("Topps Şampiyonlar Sticker").type === "Sticker");
  check("parse bilinmeyen → Diğer/Genel", (() => {
    const m = parseProductMeta("Rastgele Ürün XYZ");
    return m.brand === "Diğer" && m.team === "Genel";
  })());

  // categoryBreakdown — DR son hafta
  const drLatestWk = drAllWeeks[drAllWeeks.length - 1];
  const drLatestRows = facts.filter((f) => f.retailer === "DR" && f.week_start === drLatestWk);
  const byTeam = categoryBreakdown(drLatestRows, "team");
  const byBrand = categoryBreakdown(drLatestRows, "brand");
  const byType = categoryBreakdown(drLatestRows, "type");
  check("kategori team boş değil", byTeam.length > 0);
  check("kategori brand boş değil", byBrand.length > 0);
  check("kategori type boş değil", byType.length > 0);
  check("kategori satış sıralı (azalan)", byTeam.every((c, i) => i === 0 || byTeam[i - 1].sales_qty >= c.sales_qty));
  check("kategori toplam = ham toplam", (() => {
    const catTotal = byBrand.reduce((a, c) => a + c.sales_qty, 0);
    const rawTotal = drLatestRows.reduce((a, r) => a + r.sales_qty, 0);
    return approx(catTotal, rawTotal, 1);
  })());

  // storePerformance — DR eski format (mağaza-bazlı) bir hafta
  const drStoreWk = "2026-03-23"; // mağaza-bazlı dönem
  const drStoreRows = facts.filter((f) => f.retailer === "DR" && f.week_start === drStoreWk && f.store);
  if (drStoreRows.length > 0) {
    const stores = storePerformance(drStoreRows);
    check("mağaza performansı üretildi", stores.length > 0, `${stores.length} mağaza`);
    check("mağaza satış sıralı", stores.every((s, i) => i === 0 || stores[i - 1].sales_qty >= s.sales_qty));
    check("mağaza > 50 adet (DR çok şube)", stores.length > 50, `${stores.length}`);
    check("mağaza toplam = ham toplam", approx(
      stores.reduce((a, s) => a + s.sales_qty, 0),
      drStoreRows.reduce((a, r) => a + r.sales_qty, 0), 1));
  } else {
    check("mağaza-bazlı veri bulundu", false, "store dolu satır yok");
  }

  // globalRankings
  const latestByRetailer = new Map<string, string>();
  for (const ret of ["Toyzz", "DR", "Nezih"]) {
    const w = [...new Set(facts.filter((f) => f.retailer === ret).map((f) => f.week_start))].sort();
    if (w.length) latestByRetailer.set(ret, w[w.length - 1]);
  }
  const rankLatest = facts.filter((f) => latestByRetailer.get(f.retailer) === f.week_start);
  const prevByKey = new Map<string, { qty: number; val: number }>();
  for (const ret of ["Toyzz", "DR", "Nezih"]) {
    const w = [...new Set(facts.filter((f) => f.retailer === ret).map((f) => f.week_start))].sort();
    if (w.length < 2) continue;
    const pw = w[w.length - 2];
    for (const f of facts.filter((x) => x.retailer === ret && x.week_start === pw)) {
      const k = `${ret}|${f.sku_name}`;
      const e = prevByKey.get(k) ?? { qty: 0, val: 0 };
      e.qty += f.sales_qty; e.val += f.sales_value ?? 0;
      prevByKey.set(k, e);
    }
  }
  const rankings = globalRankings(rankLatest, prevByKey, "qty");
  check("rankings top dizi", Array.isArray(rankings.top) && rankings.top.length > 0);
  check("rankings top sıralı", rankings.top.every((r, i) => i === 0 || rankings.top[i - 1].sales_qty >= r.sales_qty));
  check("rankings risers büyüme pozitif", rankings.risers.every((r) => (r.growth ?? 0) >= 0 || rankings.risers.length === 0));
  check("rankings fallers büyüme negatif/sıralı", rankings.fallers.every((r, i) => i === 0 || (rankings.fallers[i - 1].growth ?? 0) <= (r.growth ?? 0)));
  check("rankings top max 20", rankings.top.length <= 20);

  // ───────── 7. EXECUTIVE ÖZET & DÖNEM KARŞILAŞTIRMA ─────────
  section("7. Executive özet & dönem karşılaştırma");

  const exec = execOverview(summary);
  check("exec latest_week var", exec.latest_week !== null);
  check("exec ağ satışı pozitif", exec.network.sales_qty > 0);
  check("exec perakendeci listesi dolu", exec.retailers.length > 0);
  check("exec payların toplamı ~100", (() => {
    const sum = exec.retailers.reduce((a, r) => a + r.share, 0);
    return approx(sum, 100, 0.5) || exec.retailers.length === 0;
  })());
  check("exec satış azalan sıralı", exec.retailers.every((r, i) => i === 0 || exec.retailers[i - 1].sales_qty >= r.sales_qty));
  check("exec status geçerli", exec.retailers.every((r) => ["up", "down", "flat", "nodata"].includes(r.status)));
  check("exec ağ satışı = perakendeci toplamı", approx(
    exec.network.sales_qty, exec.retailers.reduce((a, r) => a + r.sales_qty, 0), 1));
  check("exec best/worst tutarlı", (() => {
    if (!exec.best || !exec.worst) return true;
    return exec.best.wow >= exec.worst.wow;
  })());
  check("exec boş summary güvenli", (() => {
    const e = execOverview([]);
    return e.latest_week === null && e.retailers.length === 0 && e.network.sales_qty === 0;
  })());

  // Dönem karşılaştırma — DR son iki hafta
  const drCmpWeeks = [...new Set(facts.filter((f) => f.retailer === "DR").map((f) => f.week_start))].sort();
  if (drCmpWeeks.length >= 2) {
    const wa = drCmpWeeks[drCmpWeeks.length - 2], wb = drCmpWeeks[drCmpWeeks.length - 1];
    const aRows = facts.filter((f) => f.retailer === "DR" && f.week_start === wa);
    const bRows = facts.filter((f) => f.retailer === "DR" && f.week_start === wb);
    const cmp = comparePeriods(aRows, bRows);
    check("karşılaştırma gainers dizi", Array.isArray(cmp.gainers));
    check("karşılaştırma gainers delta azalan", cmp.gainers.every((c, i) => i === 0 || cmp.gainers[i - 1].delta >= c.delta));
    check("karşılaştırma losers delta artan", cmp.losers.every((c, i) => i === 0 || cmp.losers[i - 1].delta <= c.delta));
    check("yeni SKU'lar a=0 b>0", cmp.newSkus.every((c) => c.a_qty === 0 && c.b_qty > 0));
    check("kaybolan SKU'lar a>0 b=0", cmp.lostSkus.every((c) => c.a_qty > 0 && c.b_qty === 0));
    check("gainers max 20", cmp.gainers.length <= 20);
  } else {
    check("karşılaştırma için 2 hafta", false, "yetersiz hafta");
  }
  check("karşılaştırma boş giriş güvenli", (() => {
    const c = comparePeriods([], []);
    return c.gainers.length === 0 && c.losers.length === 0 && c.newSkus.length === 0;
  })());
}

// ───────────────────────── SONUÇ ─────────────────────────
console.log(`\n${"═".repeat(50)}`);
console.log(`SONUÇ: ${passed} geçti, ${failed} başarısız`);
if (failed > 0) {
  console.log("\nBaşarısız testler:");
  failures.forEach((f) => console.log("  " + f));
  process.exit(1);
} else {
  console.log("✓ TÜM TESTLER GEÇTİ — 0 hata");
  process.exit(0);
}
