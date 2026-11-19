// CORTEX test harness — saf fonksiyonları sentetik veriyle, ETL/compute zincirini
// gerçek Excel verisiyle uçtan uca test eder. Supabase'e gerek yok.
//
//   npx tsx scripts/test.ts   (veya: npm test)
//
// Çıkış kodu 0 = tüm testler geçti, 1 = en az bir test başarısız VEYA seed/ yok.
//
// İKİ KATMAN:
//   A) seed'e gerek duymayan testler (analytics, week-parser, num, marj, compute
//      saf fonksiyonları) — her ortamda çalışır, sentetik ve deterministiktir.
//   B) seed/ klasörüne bağlı testler (normalizer'lar + gerçek veri entegrasyonu).
// seed/ yoksa B ATLANIR ve suite 1 ile çıkar: "sessiz yeşil" CI tehlikesini önler.

import { readFileSync, readdirSync, existsSync } from "fs";
import { join } from "path";
import * as XLSX from "xlsx";
import {
  normalizeFile,
  normalizeSkuName,
  checkRowHealth,
} from "../src/lib/normalizers/index";
import { netFactor, netRows } from "../src/lib/margins";
import { toNum, toNumOrNull } from "../src/lib/normalizers/num";
import {
  parseWeekFromFilename,
  canonicalWeek,
  // İç fonksiyonlar doğrudan test için export edildi (davranış değişmedi):
  smartYear,
  isoWeekMonday,
  isValidYmd,
  foldTr,
  weekFromToday,
  type WeekRange,
} from "../src/lib/normalizers/week-parser";
// Huppaluppo'nun TEK tarihleme yolu: hafta dosya İÇİNDEKİ aralıktan okunuyor.
import { weekFromTitle } from "../src/lib/normalizers/huppaluppo";
import {
  slugOf,
  retailerFromSlug,
  kanalAdi,
  degisimYuzde,
  hizHesapla,
  kapsamHesapla,
  psfSec,
  skuSatiri,
  KANALLAR,
  kanalOzeti,
  type OzetHafta,
} from "../src/lib/kanal";
// Sunum katmanından tek kural: "güncel" etiketi (bkz. lib/format.ts).
import { fmtHafta, fmtDate } from "../src/lib/format";
import { SURE, SOLUK, EGRI } from "../src/lib/hareket";
import { toyzzBarkodIsle } from "../src/lib/toyzz-barkod";
import { sorguParcala, gorunenAd } from "../src/lib/urun-arama";
import {
  aile,
  takim,
  sezon,
  oncekiSezon,
  karsilikAnahtari,
} from "../src/lib/urun-ailesi";
import { gecenYilHaftasi, urunDuzeyine } from "../src/lib/arsiv";
import { normalizeAsepto } from "../src/lib/normalizers/asepto";
import {
  faturaBarkodu,
  faturaIndeksi,
  faturaNeti,
  netFaturadanPsf,
  haftaSonu,
} from "../src/lib/fatura-fiyat";
import { kotaHesapla, KOTA_LIMIT, KOTA_PENCERE_MS } from "../src/lib/zeka/kota";
import {
  siparisAyristir,
  tabloMetni,
  eslestir,
  siparisHukmu,
  siparisKontrol,
  type MotorSatiri,
} from "../src/lib/siparis-kontrol";
import { drKategoriDepo } from "../src/lib/normalizers/dr-kategori";
// Net ciro köprüsü: DB satırı → FactRow/SummaryRow (para gösteren her ekran buradan geçer).
import {
  toFacts,
  toNetFacts,
  toSummary,
  toNetSummary,
  FACT_COLS,
  SKU_COLS,
  STORE_COLS,
} from "../src/lib/rows";
import {
  RETAILERS,
  type Retailer,
  type UnifiedRow,
} from "../src/lib/normalizers/types";
import {
  linregSlope,
  momentum,
  forecastNextWeek,
  anomalyScore,
  sellThrough,
  weeksOfStock,
  wowPct,
} from "../src/lib/analytics";
import {
  buildSummary,
  generateInsights,
  findStockoutRisks,
  reorderPriority,
  ewmaVelocity,
  pivotProduct,
  parseProductMeta,
  categoryBreakdown,
  globalRankings,
  productKey,
  execOverview,
  comparePeriods,
  coverageStatus,
  computeCoverage,
  summarizeCoverage,
  groupDeadStock,
  // EŞİKLER: testlerde 8/30/1 gibi sayılar ELLE YAZILMAZ — eşik değişince test
  // kendini güncellesin, sessizce eski eşiği doğrulamaya devam etmesin.
  COVERAGE_LOW,
  COVERAGE_HIGH,
  MIN_VELOCITY,
  VELOCITY_WEEKS,
  WINDOW_WEEKS,
  DEAD_STOCK_MIN_WEEKS,
  DEAD_STOCK_HIGH_WEEKS,
  COVERAGE_LABELS,
  // Veri yaşı + kanıt kapısı: saf fonksiyonlar ve eşikleri.
  sonTamamlanmisHafta,
  gecikmeHaftasi,
  kararGecikmesi,
  yaslandir,
  kademeOf,
  likidasyonKapisi,
  dusenTalepHizi,
  TREND_SON,
  TREND_ESIK,
  rafPayi,
  tasiyanMagaza,
  sansurDuzeltilmisTalep,
  haftalikSatis,
  beklenenSatis,
  sorunHaftasi,
  buildVelocityIndex,
  velocityOf,
  MAGAZA_TASIYABILEN,
  SATIS_MAGAZA_BASI,
  MAGAZA_ASGARI,
  SANSUR_TAVAN,
  TESLIM_HF,
  GECIKME_ROZET,
  GECIKME_TASFIYE,
  GECIKME_CEK,
  GECIKME_KAPANMA,
  LIKID_MIN_VEL,
  LIKID_ABSORB,
  TR_OFSET_SAAT,
  type FactRow,
  type SummaryRow,
  type AliasMap,
  type CoverageItem,
} from "../src/lib/compute";

let passed = 0,
  failed = 0,
  skipped = 0;
const failures: string[] = [];
const warnings: string[] = [];

function check(name: string, cond: boolean, extra = "") {
  if (cond) {
    passed++;
  } else {
    failed++;
    failures.push(`✗ ${name}${extra ? " — " + extra : ""}`);
    console.log(`  ✗ ${name}${extra ? " — " + extra : ""}`);
  }
}
function approx(a: number, b: number, tol = 0.01) {
  return Math.abs(a - b) <= tol;
}
function section(t: string) {
  console.log(`\n━━ ${t} ━━`);
}
// Gerçek bir hatayı test başarısızlığı YAPMADAN öne çıkarmak için (başka ajanlar
// o dosyayı düzeltiyor olabilir): rapor sonunda topluca yazdırılır.
function warn(msg: string) {
  warnings.push(msg);
  console.warn(`  ⚠ ${msg}`);
}

// ───────────────────────── 1. ANALYTICS UNIT TESTS ─────────────────────────
section("1. Analytics (unit)");
check("linregSlope artan seri pozitif", linregSlope([1, 2, 3, 4]) > 0);
check("linregSlope azalan seri negatif", linregSlope([4, 3, 2, 1]) < 0);
check("linregSlope düz seri ~0", approx(linregSlope([5, 5, 5]), 0));
check("linregSlope tek eleman 0", linregSlope([5]) === 0);

check(
  "momentum artan pozitif",
  (momentum(
    [
      { week_start: "1", sales_qty: 10, sales_value: null, stock_qty: 0 },
      { week_start: "2", sales_qty: 20, sales_value: null, stock_qty: 0 },
      { week_start: "3", sales_qty: 30, sales_value: null, stock_qty: 0 },
      { week_start: "4", sales_qty: 40, sales_value: null, stock_qty: 0 },
    ],
    4,
  ) ?? 0) > 0,
);
check(
  "momentum tek hafta null",
  momentum([
    { week_start: "1", sales_qty: 10, sales_value: null, stock_qty: 0 },
  ]) === null,
);

check(
  "forecast makul aralıkta",
  (() => {
    const f = forecastNextWeek(
      [
        { week_start: "1", sales_qty: 100, sales_value: null, stock_qty: 0 },
        { week_start: "2", sales_qty: 110, sales_value: null, stock_qty: 0 },
        { week_start: "3", sales_qty: 120, sales_value: null, stock_qty: 0 },
        { week_start: "4", sales_qty: 130, sales_value: null, stock_qty: 0 },
      ],
      4,
    );
    return f != null && f > 110 && f < 160;
  })(),
);
check(
  "forecast negatif olmaz",
  (forecastNextWeek(
    [
      { week_start: "1", sales_qty: 5, sales_value: null, stock_qty: 0 },
      { week_start: "2", sales_qty: 0, sales_value: null, stock_qty: 0 },
    ],
    4,
  ) ?? -1) >= 0,
);

check(
  "anomali normal seri yakalanmaz",
  anomalyScore([
    { week_start: "1", sales_qty: 100, sales_value: null, stock_qty: 0 },
    { week_start: "2", sales_qty: 102, sales_value: null, stock_qty: 0 },
    { week_start: "3", sales_qty: 98, sales_value: null, stock_qty: 0 },
    { week_start: "4", sales_qty: 101, sales_value: null, stock_qty: 0 },
  ])?.isAnomaly === false,
);
check(
  "anomali spike yakalanır",
  anomalyScore([
    { week_start: "1", sales_qty: 100, sales_value: null, stock_qty: 0 },
    { week_start: "2", sales_qty: 102, sales_value: null, stock_qty: 0 },
    { week_start: "3", sales_qty: 98, sales_value: null, stock_qty: 0 },
    { week_start: "4", sales_qty: 500, sales_value: null, stock_qty: 0 },
  ])?.isAnomaly === true,
);

check("sellThrough hesap", approx(sellThrough(25, 75)!, 25));
check("sellThrough sıfır payda null", sellThrough(0, 0) === null);
check("weeksOfStock hesap", approx(weeksOfStock(100, 25)!, 4));
check("weeksOfStock satış yok null", weeksOfStock(100, 0) === null);
check("wowPct hesap", approx(wowPct(120, 100)!, 20));
check("wowPct sıfır baz null", wowPct(120, 0) === null);

// ───────────────────────── 2. WEEK PARSER ─────────────────────────
// Yıl beklentisi TARİHE BAĞLI olmasın: haftalık veri her zaman GEÇMİŞTİR, bu yüzden
// hedef ay içinde bulunduğumuz aydan ileriyse bir önceki yıla düşer (smartYear ile
// aynı kural). Sabit yıl yazsaydık testler yıl dönümünde kendiliğinden kırılırdı.
section("2. Week parser (dosya adından hafta)");
function beklenenYil(ay: number): number {
  const now = new Date();
  return ay > now.getMonth() + 1 ? now.getFullYear() - 1 : now.getFullYear();
}
const iso = (y: number, m: number, d: number) =>
  `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;

// [dosya adı, başlangıç (ay,gün), bitiş (ay,gün)] — yıl kuralla türetilir.
const wpCases: [string, [number, number], [number, number]][] = [
  ["Nezih 04.05-10.05.xlsx", [5, 4], [5, 10]], // sayısal ay
  ["23 Şubat-1 Mart-Asepto.xlsx", [2, 23], [3, 1]], // iki Türkçe ay
  ["11-17 Mayıs-Asepto.xlsx", [5, 11], [5, 17]], // tek Türkçe ay
  ["19.05-25.05.xlsx", [5, 19], [5, 25]],
  ["1-7 Aralık -Asepto.xlsx", [12, 1], [12, 7]],
  ["18 Mayıs-24 Mayıs-Asepto.xlsx", [5, 18], [5, 24]],
  ["22 HAZİRAN-28 HAZİRAN.xlsx", [6, 22], [6, 28]], // Türkçe büyük İ (foldTr)
];
for (const [fn, [m1, d1], [m2, d2]] of wpCases) {
  const y1 = beklenenYil(m1);
  const y2 = m2 < m1 ? y1 + 1 : y1;
  const w = parseWeekFromFilename(fn);
  check(
    `parse "${fn}"`,
    w?.start === iso(y1, m1, d1) && w?.end === iso(y2, m2, d2),
    w
      ? `${w.start}→${w.end} (beklenen ${iso(y1, m1, d1)}→${iso(y2, m2, d2)})`
      : "null",
  );
}
// Türkçe büyük İ dalını AYRICA korur: "HAZİRAN".toLowerCase() birleşik nokta üretir
// ve foldTr olmadan ay sözlüğüyle eşleşmez → dosya sessizce weekFromToday'e düşer.
check(
  "büyük İ'li ay adı sessizce bugüne düşmüyor",
  parseWeekFromFilename("22 HAZİRAN-28 HAZİRAN.xlsx") !== null,
);
check(
  "küçük harfli aynı dosya aynı haftayı verir",
  (() => {
    const a = parseWeekFromFilename("22 HAZİRAN-28 HAZİRAN.xlsx");
    const b = parseWeekFromFilename("22 haziran-28 haziran.xlsx");
    return a != null && b != null && a.start === b.start && a.end === b.end;
  })(),
);

// İki-ay + yıl sınırı: "29 Aralık-4 Ocak" bitişi BİR SONRAKİ yıla taşımalı.
check(
  "iki-ay geçişi yıl sınırını aşıyor (29 Aralık-4 Ocak)",
  (() => {
    const w = parseWeekFromFilename(
      "ASEPTO SATIŞ STOK 29 Aralık - 4 Ocak.xlsx",
    );
    if (!w) return false;
    const y1 = +w.start.slice(0, 4),
      y2 = +w.end.slice(0, 4);
    return (
      w.start.slice(5) === "12-29" &&
      w.end.slice(5) === "01-04" &&
      y2 === y1 + 1
    );
  })(),
  parseWeekFromFilename("ASEPTO SATIŞ STOK 29 Aralık - 4 Ocak.xlsx")?.start +
    "→" +
    parseWeekFromFilename("ASEPTO SATIŞ STOK 29 Aralık - 4 Ocak.xlsx")?.end,
);

// W-NN dalı = ARMAĞAN'IN TEK tarihleme yolu. Bozulursa 4 dosya da weekFromToday'e
// düşer ve aynı haftaya yazılıp birbirini ezer.
check(
  "W-NN + açık yıl: 2026 W19 → 04.05.2026 Pazartesi",
  (() => {
    const w = parseWeekFromFilename("MYTHOS CARD W-19 2026 RAPOR.xlsx");
    return w?.start === "2026-05-04" && w?.end === "2026-05-10";
  })(),
  JSON.stringify(parseWeekFromFilename("MYTHOS CARD W-19 2026 RAPOR.xlsx")),
);
check(
  "W-NN yılsız: Pazartesi başlar, 7 günlük ve GEÇMİŞTE",
  (() => {
    const w = parseWeekFromFilename("MYTHOS CARD W-21 RAPOR.xlsx");
    if (!w) return false;
    const s = new Date(w.start + "T00:00:00Z"),
      e = new Date(w.end + "T00:00:00Z");
    return (
      s.getUTCDay() === 1 &&
      (e.getTime() - s.getTime()) / 86400000 === 6 &&
      s.getTime() <= Date.now()
    );
  })(),
  JSON.stringify(parseWeekFromFilename("MYTHOS CARD W-21 RAPOR.xlsx")),
);
check(
  "W-NN ardışık haftalar 7 gün arayla",
  (() => {
    const a = parseWeekFromFilename("MYTHOS CARD W-19 2026 RAPOR.xlsx");
    const b = parseWeekFromFilename("MYTHOS CARD W-20 2026 RAPOR.xlsx");
    if (!a || !b) return false;
    return (
      (new Date(b.start).getTime() - new Date(a.start).getTime()) / 86400000 ===
      7
    );
  })(),
);

// Takvimsel geçersizlik: uydurma tarih insert'i düşürmesin diye null dönmeli.
check(
  "geçersiz gün (31 Nisan) null",
  parseWeekFromFilename("31.04-06.05.xlsx") === null,
);
check(
  "geçersiz ISO hafta (w54) null",
  parseWeekFromFilename("w54_2026.xlsx") === null,
);
check(
  "parse bilinmeyen null",
  parseWeekFromFilename("rastgele_dosya.xlsx") === null,
);

// ───────── 2b. WEEK PARSER İÇ FONKSİYONLARI (doğrudan) ─────────
// Bu dosya haftalık verinin HANGİ haftaya yazılacağını belirliyor; yanlış çözüm
// veriyi yanlış haftaya gömer ve fark edilmesi çok zordur (dosya işlenir, satır
// sayısı doğru görünür, sadece tarih yanlıştır). Üç gerçek olay yaşandı: Türkçe
// büyük İ (foldTr), yıl sınırı (smartYear), tarihsiz dosyada yanlış hafta tahmini.
// Dosya adı üzerinden dolaylı test bu dalları tek tek zorlamıyordu — artık doğrudan.
section(
  "2b. Week parser iç fonksiyonları (foldTr / smartYear / isoWeekMonday / isValidYmd)",
);

// ── foldTr: Türkçe büyük harf katlaması ──
// Kaçış dizisiyle yazılır: birleşik nokta kaynakta görünmez, bir editör sessizce
// silerse test totolojiye dönüşür.
const BIRLESIK_NOKTA = "\u0307";
check(
  "foldTr: İ → i (HAZİRAN → haziran)",
  foldTr("HAZİRAN") === "haziran",
  JSON.stringify(foldTr("HAZİRAN")),
);
check(
  "foldTr: I → ı (MAYIS → mayıs, ARALIK → aralık)",
  foldTr("MAYIS") === "mayıs" && foldTr("ARALIK") === "aralık",
  `${foldTr("MAYIS")}/${foldTr("ARALIK")}`,
);
check(
  "foldTr: küçük harfli girdide ı ve i korunur",
  foldTr("mayıs") === "mayıs" && foldTr("nisan") === "nisan",
);
check(
  "foldTr: birleşik nokta (U+0307) çıktıda kalmaz",
  !foldTr("HAZİRAN").includes(BIRLESIK_NOKTA),
);
// foldTr'nin NEDEN var olduğunu kanıtlar: düz toLowerCase 8 karakterlik bozuk bir
// dize üretir ("hazi" + U+0307 + "ran") ve 7 karakterlik sözlük anahtarıyla eşleşmez.
check(
  "foldTr GEREKLİ: düz toLowerCase 'HAZİRAN'ı 8 karaktere bozuyor",
  "HAZİRAN".toLowerCase() !== "haziran" &&
    "HAZİRAN".toLowerCase().length === 8 &&
    "HAZİRAN".toLowerCase().includes(BIRLESIK_NOKTA) &&
    foldTr("HAZİRAN").length === 7,
  JSON.stringify("HAZİRAN".toLowerCase()),
);
check(
  "foldTr idempotent (iki kez uygulamak sonucu değiştirmez)",
  ["HAZİRAN", "MAYIS", "Şubat", "EKİM", "AĞUSTOS"].every(
    (s) => foldTr(foldTr(s)) === foldTr(s),
  ),
);
// 12 ayın TAMAMI büyük harfle çözülmeli: İ'li (NİSAN/HAZİRAN/EKİM) ve I'lı
// (MAYIS/KASIM/ARALIK) aylar katlanmazsa o dosyalar sessizce weekFromToday'e düşer.
const AYLAR_BUYUK = [
  "OCAK",
  "ŞUBAT",
  "MART",
  "NİSAN",
  "MAYIS",
  "HAZİRAN",
  "TEMMUZ",
  "AĞUSTOS",
  "EYLÜL",
  "EKİM",
  "KASIM",
  "ARALIK",
];
check(
  "12 Türkçe ayın hepsi BÜYÜK harfle parse edilir",
  AYLAR_BUYUK.every((ay) => parseWeekFromFilename(`1-7 ${ay}.xlsx`) !== null),
  AYLAR_BUYUK.filter(
    (ay) => parseWeekFromFilename(`1-7 ${ay}.xlsx`) === null,
  ).join(",") || "hepsi ok",
);
check(
  "12 ayda büyük ve küçük harfli ad AYNI haftayı verir",
  AYLAR_BUYUK.every((ay) => {
    const a = parseWeekFromFilename(`1-7 ${ay}.xlsx`),
      b = parseWeekFromFilename(`1-7 ${foldTr(ay)}.xlsx`);
    return a != null && b != null && a.start === b.start && a.end === b.end;
  }),
);

// ── smartYear: yıl sınırı ──
// Kural: haftalık veri HER ZAMAN geçmiştir → yıl, ay bugünden ileriyse bir öncekidir.
const BUGUN = new Date();
const BU_AY = BUGUN.getMonth() + 1;
check(
  "smartYear: içinde bulunduğumuz ay bu yılda kalır (geriye kaymaz)",
  smartYear(BU_AY) === BUGUN.getFullYear(),
  `${smartYear(BU_AY)}`,
);
check(
  "smartYear: 12 ayın HİÇBİRİ gelecek ay/yıl üretmez",
  (() => {
    for (let ay = 1; ay <= 12; ay++) {
      const y = smartYear(ay);
      if (y > BUGUN.getFullYear()) return false;
      if (y === BUGUN.getFullYear() && ay > BU_AY) return false;
    }
    return true;
  })(),
  Array.from({ length: 12 }, (_, i) => `${i + 1}:${smartYear(i + 1)}`).join(
    " ",
  ),
);
check(
  "smartYear: fallbackYear verilince o yıl baz alınır (bugüne eşit/geride ay)",
  smartYear(BU_AY, 2000) === 2000,
  `${smartYear(BU_AY, 2000)}`,
);
// Yıl sınırı GERİ yön: bugünden ileri bir ay (ör. Ağustos'tayken Aralık) önceki yıl.
check(
  "smartYear: bugünden İLERİ ay fallbackYear−1'e düşer (yıl sınırı, geri yön)",
  BU_AY === 12
    ? smartYear(12, 2000) === 2000
    : smartYear(BU_AY + 1, 2000) === 1999,
  `${BU_AY === 12 ? smartYear(12, 2000) : smartYear(BU_AY + 1, 2000)}`,
);
// Yıl sınırı İLERİ yön: Aralık asla Ocak'tan sonraki bir yıla yazılmaz.
check(
  "smartYear: Aralık yılı ≤ Ocak yılı ve fark en fazla 1",
  smartYear(12) <= smartYear(1) && smartYear(1) - smartYear(12) <= 1,
  `Ocak ${smartYear(1)} / Aralık ${smartYear(12)}`,
);
check(
  "smartYear gerçek olayı: 'Aralık' dosyası gelecek yıla YAZILMAZ",
  (() => {
    const w = parseWeekFromFilename("1-7 Aralık -Asepto.xlsx");
    return (
      w != null && new Date(w.start + "T00:00:00Z").getTime() <= Date.now()
    );
  })(),
  JSON.stringify(parseWeekFromFilename("1-7 Aralık -Asepto.xlsx")),
);

// ── isoWeekMonday: ISO hafta → Pazartesi ──
// Armağan dosyalarının TEK tarihleme yolu ("W-19 2026"); bozulursa 4 dosya aynı
// haftaya yazılıp birbirini ezer.
check(
  "isoWeekMonday: 2026 W19 → 2026-05-04 (bilinen değer, Pazartesi)",
  isoWeekMonday(2026, 19).toISOString().slice(0, 10) === "2026-05-04" &&
    isoWeekMonday(2026, 19).getUTCDay() === 1,
  isoWeekMonday(2026, 19).toISOString().slice(0, 10),
);
check(
  "isoWeekMonday: 11 yıl × 5 hafta, hepsi Pazartesi",
  (() => {
    for (let y = 2020; y <= 2030; y++)
      for (const w of [1, 9, 26, 40, 52]) {
        if (isoWeekMonday(y, w).getUTCDay() !== 1) return false;
      }
    return true;
  })(),
);
// ISO 8601: 1. hafta 4 Ocak'ı İÇEREN haftadır — bu yüzden Pazartesi önceki yıla taşabilir.
check(
  "isoWeekMonday: W1 her yıl 4 Ocak'ı içerir (ISO 8601 tanımı, 2018-2032)",
  (() => {
    for (let y = 2018; y <= 2032; y++) {
      const mon = isoWeekMonday(y, 1).getTime(),
        dort = Date.UTC(y, 0, 4);
      if (!(mon <= dort && dort <= mon + 6 * 86400000)) return false;
    }
    return true;
  })(),
);
check(
  "isoWeekMonday: 2026 W1 önceki yıla taşar (2025-12-29)",
  isoWeekMonday(2026, 1).toISOString().slice(0, 10) === "2025-12-29",
  isoWeekMonday(2026, 1).toISOString().slice(0, 10),
);
check(
  "isoWeekMonday: ardışık haftalar tam 7 gün arayla (2026 W1→W52)",
  (() => {
    for (let w = 1; w < 52; w++) {
      if (
        (isoWeekMonday(2026, w + 1).getTime() -
          isoWeekMonday(2026, w).getTime()) /
          86400000 !==
        7
      )
        return false;
    }
    return true;
  })(),
);
// dow > 4 dalı: yıl Cuma/Cumartesi/Pazar başlarsa W1 Pazartesi'si Ocak'a İLERİ kayar.
// Yalnız dow ≤ 4 durumunu test etmek bu dalı ölü bırakırdı.
check(
  "isoWeekMonday: yıl Cuma/Cumartesi/Pazar başlayınca W1 Ocak'a ileri kayar",
  isoWeekMonday(2021, 1).toISOString().slice(0, 10) === "2021-01-04" && // 1 Ocak Cuma
    isoWeekMonday(2022, 1).toISOString().slice(0, 10) === "2022-01-03" && // 1 Ocak Cumartesi
    isoWeekMonday(2023, 1).toISOString().slice(0, 10) === "2023-01-02", // 1 Ocak Pazar
  [2021, 2022, 2023]
    .map((y) => isoWeekMonday(y, 1).toISOString().slice(0, 10))
    .join(","),
);
check(
  "isoWeekMonday: 1 Ocak Pazartesi olan yıl W1 = 1 Ocak (2024)",
  isoWeekMonday(2024, 1).toISOString().slice(0, 10) === "2024-01-01",
);
check(
  "isoWeekMonday: 53 haftalı yıl çalışır (2020 W53 → 2020-12-28)",
  isoWeekMonday(2020, 53).toISOString().slice(0, 10) === "2020-12-28",
  isoWeekMonday(2020, 53).toISOString().slice(0, 10),
);

// ── isValidYmd: takvim geçerliliği ──
// Uydurma tarih (31 Şubat gibi) Postgres `date not null` insert'ini düşürür ve
// dosya sessizce kaybolur; bu yüzden parse aşamasında reddedilir.
check("isValidYmd: 31 Şubat geçersiz", !isValidYmd(2026, 2, 31));
check(
  "isValidYmd: 29 Şubat artık yılda geçerli, normal yılda değil",
  isValidYmd(2024, 2, 29) && !isValidYmd(2026, 2, 29),
);
check(
  "isValidYmd: 30 günlük aylarda 31. gün geçersiz (4/6/9/11)",
  [4, 6, 9, 11].every((m) => !isValidYmd(2026, m, 31)),
);
check(
  "isValidYmd: 31 günlük aylarda 31. gün geçerli",
  [1, 3, 5, 7, 8, 10, 12].every((m) => isValidYmd(2026, m, 31)),
);
check(
  "isValidYmd: ay 0/13 ve gün 0/32 reddedilir",
  !isValidYmd(2026, 0, 1) &&
    !isValidYmd(2026, 13, 1) &&
    !isValidYmd(2026, 1, 0) &&
    !isValidYmd(2026, 1, 32),
);
check(
  "isValidYmd: yıl sınırı günleri geçerli (1 Ocak / 31 Aralık)",
  isValidYmd(2026, 1, 1) && isValidYmd(2026, 12, 31),
);

// ── GELECEK TARİH: haftalık rapor daima BİTEN bir haftaya aittir ──
check(
  "W-NN yılsız: 1..53 haftaların hiçbiri gelecekte değil",
  (() => {
    for (let w = 1; w <= 53; w++) {
      const r = parseWeekFromFilename(`MYTHOS CARD W-${w} RAPOR.xlsx`);
      if (!r || new Date(r.start + "T00:00:00Z").getTime() > Date.now())
        return false;
    }
    return true;
  })(),
);
check(
  "Türkçe ay dalı: 12 ayın hiçbiri gelecek haftaya yazılmaz",
  AYLAR_BUYUK.every((ay) => {
    const r = parseWeekFromFilename(`1-7 ${ay}.xlsx`);
    return (
      r != null && new Date(r.start + "T00:00:00Z").getTime() <= Date.now()
    );
  }),
);
// BİLİNÇLİ TERCİH (davranış sabitlenir): dosya adında AÇIK yıl varsa (ISO aralık ya da
// "W-19 2026") o yıla güvenilir, gelecek bile olsa düzeltilmez. Geçmişe çekme yalnız
// yıl YAZILMAMIŞ dallar için geçerlidir. Bu ayrım bilinerek korunuyor.
check(
  "açık yıllı ISO aralık gelecekte olsa da olduğu gibi kabul edilir (yıla güvenilir)",
  (() => {
    const r = parseWeekFromFilename("rapor_2099-01-05_to_2099-01-11.xlsx");
    return r?.start === "2099-01-05" && r?.end === "2099-01-11";
  })(),
  JSON.stringify(parseWeekFromFilename("rapor_2099-01-05_to_2099-01-11.xlsx")),
);

// ───────── 2c. KANONİK HAFTA HİZALAMASI (canonicalWeek) ─────────
// Perakendeciler aynı haftayı farklı günle etiketliyor (DR Salı, Toyzz Pazartesi,
// bazı raporlar Pazar). Hepsi Pazartesi'ye çekilmezse aynı hafta iki ayrı gruba
// düşer; firma karşılaştırmaları ve WoW hesapları bozulur.
section("2c. Kanonik hafta hizalaması (canonicalWeek)");
check(
  "canonicalWeek: PAZARTESİ başlangıcı değişmez",
  (() => {
    const r = canonicalWeek({ start: "2026-05-11", end: "2026-05-17" });
    return r.start === "2026-05-11" && r.end === "2026-05-17";
  })(),
  JSON.stringify(canonicalWeek({ start: "2026-05-11", end: "2026-05-17" })),
);
// PAZAR en kötü durum: (0+6)%7 = 6 gün geri. Yanlış yönde hizalansa hafta bir ileri kayardı.
check(
  "canonicalWeek: PAZAR başlangıcı 6 gün geriye, başladığı haftaya iner",
  (() => {
    const r = canonicalWeek({ start: "2026-07-05", end: "2026-07-11" }); // 05.07.2026 Pazar
    return r.start === "2026-06-29" && r.end === "2026-07-05";
  })(),
  JSON.stringify(canonicalWeek({ start: "2026-07-05", end: "2026-07-11" })),
);
check(
  "canonicalWeek: SALI başlangıcı 1 gün geriye (DR'nin gerçek durumu)",
  (() => {
    const r = canonicalWeek({ start: "2026-05-19", end: "2026-05-25" });
    return r.start === "2026-05-18" && r.end === "2026-05-24";
  })(),
  JSON.stringify(canonicalWeek({ start: "2026-05-19", end: "2026-05-25" })),
);
check(
  "canonicalWeek: haftanın 7 gününün hepsi Pazartesi + 6 günlük aralık verir",
  (() => {
    for (let i = 0; i < 7; i++) {
      const g = new Date(Date.UTC(2026, 4, 11 + i)).toISOString().slice(0, 10);
      const r = canonicalWeek({ start: g, end: g });
      const s = new Date(r.start + "T00:00:00Z"),
        e = new Date(r.end + "T00:00:00Z");
      if (s.getUTCDay() !== 1 || (e.getTime() - s.getTime()) / 86400000 !== 6)
        return false;
    }
    return true;
  })(),
);
check(
  "canonicalWeek: aynı haftanın 7 farklı etiketi TEK haftada birleşir",
  (() => {
    const hafta = new Set<string>();
    for (let i = 0; i < 7; i++) {
      const g = new Date(Date.UTC(2026, 4, 11 + i)).toISOString().slice(0, 10);
      hafta.add(canonicalWeek({ start: g, end: g }).start);
    }
    return hafta.size === 1 && hafta.has("2026-05-11");
  })(),
);
check(
  "canonicalWeek idempotent (iki kez uygulamak değiştirmez)",
  (() => {
    const a = canonicalWeek({ start: "2026-05-19", end: "2026-05-25" });
    const b = canonicalWeek(a);
    return a.start === b.start && a.end === b.end;
  })(),
);
// Geçersiz tarihte girdiyi OLDUĞU GİBİ döndürüyor: bu yüzden geçersiz tarihi
// canonicalWeek'e vermeden ÖNCE elemek gerekiyor (bkz. 2d, weekFromTitle).
check(
  "canonicalWeek: geçersiz tarih çökmez, girdi aynen döner",
  canonicalWeek({ start: "2026-13-32", end: "2026-13-40" }).start ===
    "2026-13-32",
);

// ───────── 2d. HUPPALUPPO DOSYA-İÇİ TARİH ARALIĞI (weekFromTitle) ─────────
// Huppaluppo'da hafta dosya ADINDAN değil, dosya İÇİNDEKİ başlık aralığından okunur
// ("Stok Raporu … 11.05.2026-17.05.2026"). Bu tek yol bozulursa üç dosya da
// fallback haftaya (weekFromToday) düşer ve birbirini ezer.
section("2d. Huppaluppo dosya-içi tarih aralığı (weekFromTitle)");
const HUP_FALLBACK: WeekRange = { start: "1999-01-04", end: "1999-01-10" };
// Gerçek dosyaların başlık bölgesiyle aynı şekil: aralık 1. satırda, sütun başlıkları 2.
const hupBaslik = (deger: string, satirIdx = 0): any[][] => {
  const aoa: any[][] = [];
  for (let i = 0; i <= Math.max(satirIdx, 1); i++) aoa.push([null, null, null]);
  aoa[satirIdx] = ["Stok Raporu", null, null, null, deger, null];
  return aoa;
};
const hupHafta = (deger: string) =>
  weekFromTitle(hupBaslik(deger), HUP_FALLBACK);
check(
  "weekFromTitle: normal aralık (11.05.2026-17.05.2026) → o hafta",
  (() => {
    const w = hupHafta("11.05.2026-17.05.2026");
    return w.start === "2026-05-11" && w.end === "2026-05-17";
  })(),
  JSON.stringify(hupHafta("11.05.2026-17.05.2026")),
);
// GERÇEK OLAY + DÜZELTME: bir dosyada aralık TERS yazılıydı ("20.07.2026-16.07.2026")
// ve satış kolonu boştu. canonicalWeek yalnız `start`ı kullanıp bitişi +6 gün olarak
// yeniden kurduğu için hafta BÜYÜK tarihten türüyordu: 16.07 (Perşembe) yerine 20.07
// (Pazartesi) baz alınıp veri 2026-07-13 haftası yerine 2026-07-20 haftasına, yani
// BİR HAFTA İLERİYE yazılıyordu. Artık iki tarih sıralanıp küçüğü başlangıç sayılıyor.
check(
  "weekFromTitle: TERS aralıkta küçük tarih başlangıç sayılır (bir hafta ileri kayma YOK)",
  (() => {
    const ters = hupHafta("20.07.2026-16.07.2026");
    const duz = hupHafta("16.07.2026-20.07.2026");
    return (
      ters.start === "2026-07-13" &&
      ters.end === "2026-07-19" &&
      ters.start === duz.start &&
      ters.end === duz.end
    );
  })(),
  JSON.stringify(hupHafta("20.07.2026-16.07.2026")),
);
check(
  "weekFromTitle: tarih aralığı yok → fallback aynen döner",
  (() => {
    const w = weekFromTitle(
      [
        ["Stok Raporu", null],
        ["Barkod", "Satış"],
      ],
      HUP_FALLBACK,
    );
    return w.start === HUP_FALLBACK.start && w.end === HUP_FALLBACK.end;
  })(),
);
// BOZUK TARİH: regex "32.13.2026-40.14.2026"yi de eşliyor. canonicalWeek geçersiz
// tarihte girdiyi olduğu gibi döndürdüğü için week_start "2026-13-32" olabiliyordu;
// bu değer `\d{4}-\d{2}-\d{2}` KALIBINA UYDUĞU için şekil kontrollerinden geçer ama
// Postgres `date` insert'ini düşürür (dosya sessizce kaybolur). Artık isValidYmd ile
// eleniyor — week-parser'daki takvim kontrolüyle aynı kaynak.
check(
  "weekFromTitle: bozuk/uydurma tarih (32.13.2026) fallback'e düşer, geçersiz week_start üretmez",
  (() => {
    const w = hupHafta("32.13.2026-40.14.2026");
    return (
      w.start === HUP_FALLBACK.start &&
      isValidYmd(
        +w.start.slice(0, 4),
        +w.start.slice(5, 7),
        +w.start.slice(8, 10),
      )
    );
  })(),
  JSON.stringify(hupHafta("32.13.2026-40.14.2026")),
);
check(
  "weekFromTitle: aralığın YALNIZ bir ucu bozuksa da fallback (31.02 bitiş)",
  hupHafta("20.07.2026-31.02.2026").start === HUP_FALLBACK.start,
  JSON.stringify(hupHafta("20.07.2026-31.02.2026")),
);
check(
  "weekFromTitle: iki farklı ayı kapsayan aralık (29.06.2026-05.07.2026)",
  (() => {
    const w = hupHafta("29.06.2026-05.07.2026");
    return w.start === "2026-06-29" && w.end === "2026-07-05";
  })(),
  JSON.stringify(hupHafta("29.06.2026-05.07.2026")),
);
check(
  "weekFromTitle: tek haneli gün/ay sıfırla doldurulur (1.6.2026-7.6.2026)",
  (() => {
    const w = hupHafta("1.6.2026-7.6.2026");
    return w.start === "2026-06-01" && w.end === "2026-06-07";
  })(),
  JSON.stringify(hupHafta("1.6.2026-7.6.2026")),
);
check(
  "weekFromTitle: aralık 5. satıra kadar aranır (4. indeks bulunur)",
  weekFromTitle(hupBaslik("11.05.2026-17.05.2026", 4), HUP_FALLBACK).start ===
    "2026-05-11",
);
check(
  "weekFromTitle: 5. satırdan sonrası okunmaz → fallback (tarama sınırı sabit)",
  weekFromTitle(hupBaslik("11.05.2026-17.05.2026", 5), HUP_FALLBACK).start ===
    HUP_FALLBACK.start,
);
check(
  "weekFromTitle: sonuç HER ZAMAN Pazartesi ve 7 günlük (hangi güne etiketlenirse)",
  [
    "11.05.2026-17.05.2026",
    "13.05.2026-19.05.2026",
    "17.05.2026-23.05.2026",
    "20.07.2026-16.07.2026",
  ].every((a) => {
    const w = hupHafta(a);
    const s = new Date(w.start + "T00:00:00Z"),
      e = new Date(w.end + "T00:00:00Z");
    return s.getUTCDay() === 1 && (e.getTime() - s.getTime()) / 86400000 === 6;
  }),
);
// Delikli satır: sheet_to_json tamamen boş satırlarda dizi deliği bırakabiliyor;
// eski kod `for (const cell of row)` ile TypeError atardı (dosya tümden reddedilirdi).
check(
  "weekFromTitle: delikli/boş satır çökmez, sonraki satırdaki aralığı bulur",
  (() => {
    const aoa: any[][] = [
      undefined as any,
      ["Stok Raporu", null, "11.05.2026-17.05.2026"],
    ];
    const w = weekFromTitle(aoa, HUP_FALLBACK);
    return w.start === "2026-05-11";
  })(),
);
check(
  "weekFromTitle: boş aoa fallback döner",
  weekFromTitle([], HUP_FALLBACK).start === HUP_FALLBACK.start,
);

// ───────────────────────── 3. SAYI AYRIŞTIRMA (num.ts) ─────────────────────────
// Türkçe ondalık regresyonu ciroyu 1000× şişirir: "1.234,56" 1234,56 olmalı, 123456 değil.
section("3. Sayı ayrıştırma (Türkçe ondalık)");
check(
  "toNum TR ondalık '1.234,56' → 1234,56",
  approx(toNum("1.234,56"), 1234.56, 0.001),
  `${toNum("1.234,56")}`,
);
check(
  "toNum TR binlik '1.234' → 1234",
  toNum("1.234") === 1234,
  `${toNum("1.234")}`,
);
check(
  "toNum çoklu binlik '12.345.678'",
  toNum("12.345.678") === 12345678,
  `${toNum("12.345.678")}`,
);
check("toNum TR virgül '12,5' → 12,5", approx(toNum("12,5"), 12.5, 0.001));
check(
  "toNum para sembolü '₺1.250' → 1250",
  toNum("₺1.250") === 1250,
  `${toNum("₺1.250")}`,
);
check(
  "toNum negatif TR '-1.234,5'",
  approx(toNum("-1.234,5"), -1234.5, 0.001),
  `${toNum("-1.234,5")}`,
);
check(
  "toNum EN ondalık '1234.56' bozulmaz",
  approx(toNum("1234.56"), 1234.56, 0.001),
);
check("toNum sayı hücresi değişmez", toNum(1234.56) === 1234.56);
check(
  "toNum boş/çöp → 0",
  toNum("") === 0 &&
    toNum(null) === 0 &&
    toNum("abc") === 0 &&
    toNum("-") === 0,
);
check(
  "toNumOrNull boş → null, 0 → 0",
  toNumOrNull("") === null && toNumOrNull(0) === 0,
);
check("toNumOrNull çöp → null", toNumOrNull("abc") === null);
// Kritik ayrım: 1.234 binlik (1234) iken 1.2 ondalıktır (1,2).
check(
  "toNum '1.2' ondalık kalır (binlik sanılmaz)",
  approx(toNum("1.2"), 1.2, 0.001),
  `${toNum("1.2")}`,
);

// ───────────── 4. ÜRÜN ADI NORMALİZASYONU (çift-sayım kalkanı) ─────────────
// Bu regex bozulursa "X" ile "X, N/A" iki ayrı ürün sayılır ve isim-anahtarlı
// matview'lerde stok İKİ KEZ toplanır (D&R'de +70.818 adet hayalet stok).
section("4. Ürün adı normalizasyonu (normalizeSkuName)");
check(
  "sondaki ', N/A' atılır",
  normalizeSkuName("Mythos Kart, N/A") === "Mythos Kart",
  normalizeSkuName("Mythos Kart, N/A"),
);
check(
  "virgülsüz ' N/A' atılır",
  normalizeSkuName("Mythos Kart N/A") === "Mythos Kart",
);
check(
  "'n/a' küçük harf de atılır",
  normalizeSkuName("Mythos Kart, n/a  ") === "Mythos Kart",
);
check(
  "N/A eki ÇİFT SAYIMI kapatır (X == X, N/A)",
  normalizeSkuName("Mythos Beşiktaş Booster") ===
    normalizeSkuName("Mythos Beşiktaş Booster, N/A"),
);
check(
  "çoklu boşluk teke iner",
  normalizeSkuName("Mythos  Pulls") === "Mythos Pulls",
  normalizeSkuName("Mythos  Pulls"),
);
// NBSP kaçış dizisiyle YAZILIR: görünmez karakter kaynakta kalırsa bir editör
// sessizce normal boşluğa çevirir ve test totolojiye dönüşür.
const NBSP = "\u00A0";
check(
  "NBSP (U+00A0) normal boşluğa döner",
  (() => {
    const r = normalizeSkuName(`Mythos${NBSP}Kart`);
    return r === "Mythos Kart" && !r.includes(NBSP);
  })(),
  JSON.stringify(normalizeSkuName(`Mythos${NBSP}Kart`)),
);
check(
  "çoklu NBSP tek boşluğa iner",
  normalizeSkuName(`A${NBSP}${NBSP}B`) === "A B",
);
check(
  "NBSP'li ve normal boşluklu ad AYNI anahtara iner",
  normalizeSkuName(`Mythos${NBSP}Cards${NBSP}First`) ===
    normalizeSkuName("Mythos Cards First"),
);
check(
  "baş/sondaki NBSP de kırpılır",
  normalizeSkuName(`${NBSP}Mythos Kart${NBSP}`) === "Mythos Kart",
);
check(
  "sekme/satır sonu de tek boşluğa iner",
  normalizeSkuName("A\t\nB") === "A B",
);
check(
  "baş/son boşluk kırpılır",
  normalizeSkuName("   Mythos Kart   ") === "Mythos Kart",
);
check(
  "ortadaki N/A KORUNUR (yalnız sondaki ek atılır)",
  normalizeSkuName("N/A Serisi Kart") === "N/A Serisi Kart",
  normalizeSkuName("N/A Serisi Kart"),
);
check(
  "temiz ad değişmez",
  normalizeSkuName("Mythos Beşiktaş Kart First 25/26") ===
    "Mythos Beşiktaş Kart First 25/26",
);

// ───────────── 5. MARJ / NET KAZANÇ (margins.ts) ─────────────
// ciro = PSF × (1 − marj%) ÷ 1,20 — para gösterdiğimiz HER yüzey buradan geçer.
section("5. Net kazanç çarpanı (5 kanal)");
check(
  "net Toyzz %50: 1200 → 500",
  approx(1200 * netFactor("Toyzz"), 500, 0.001),
  `${1200 * netFactor("Toyzz")}`,
);
check("net DR %47: 100 → ~44,17", approx(100 * netFactor("DR"), 44.1667, 0.01));
check(
  "net Armağan %47: 100 → ~44,17",
  approx(100 * netFactor("Armağan"), 44.1667, 0.01),
);
check(
  "net Huppaluppo %45: 100 → ~45,83",
  approx(100 * netFactor("Huppaluppo"), 45.8333, 0.01),
  `${100 * netFactor("Huppaluppo")}`,
);
check(
  "net Nezih %43: 100 → 47,5",
  approx(100 * netFactor("Nezih"), 47.5, 0.001),
);
check(
  "tüm kanal çarpanları 0 ile 1 arasında",
  RETAILERS.every((r) => netFactor(r) > 0 && netFactor(r) < 1),
);
// RİSK: tanımsız kanal marj %0 varsayıp yalnız KDV düşer (0,8333). Yeni bir kanal
// margins.ts'e eklenmezse cirosu ~2× yüksek görünür. Test davranışı SABİTLER.
check(
  "tanımsız kanal → yalnız KDV (÷1,2 = 0,8333 çarpan)",
  approx(netFactor("Bilinmeyen Kanal"), 0.8333, 0.0001),
  `${netFactor("Bilinmeyen Kanal")}`,
);
warn(
  "margins.ts: tanımsız kanal marj %0 sayılıyor (çarpan 0,8333) — margins.ts'e eklenmemiş yeni bir kanalın cirosu ~2× yüksek görünür. Sessiz varsayılan yerine uyarı/`null` daha güvenli olur.",
);
check(
  "netRows kanal başına doğru çarpanı uygular",
  (() => {
    const nr = netRows([
      { retailer: "Toyzz", sales_value: 1200 },
      { retailer: "Nezih", sales_value: 100 },
      { retailer: "Bilinmeyen", sales_value: 120 },
      { retailer: "DR", sales_value: null },
    ]);
    return (
      approx(nr[0].sales_value!, 500, 0.001) &&
      approx(nr[1].sales_value!, 47.5, 0.001) &&
      approx(nr[2].sales_value!, 100, 0.001) &&
      nr[3].sales_value === null
    );
  })(),
);
check(
  "netRows diğer alanları bozmaz ve girişi mutasyona uğratmaz",
  (() => {
    const src = [{ retailer: "Toyzz", sales_value: 1200, sku_name: "X" }];
    const nr = netRows(src);
    return nr[0].sku_name === "X" && src[0].sales_value === 1200;
  })(),
);

// ───────── 5b. NET CİRO KÖPRÜSÜ (rows.ts: DB satırı → FactRow / SummaryRow) ─────────
// DB'de sales_value BRÜT (PSF) tutulur; net = PSF × (1 − kanal marjı%) ÷ 1,20 OKUMA
// ANINDA uygulanır ve para gösteren TÜM ekranlar bu köprüden geçer. Dönüşümün bir kez
// FAZLA ya da bir kez EKSİK uygulanması ciroyu yarıya/iki katına çevirir — bu hata bu
// projede GERÇEKTEN yapıldı (Aylık Özet ₺1,90M yerine ₺4,45M gösterdi). Köprü sıfır
// testle duruyordu.
section("5b. Net ciro köprüsü (rows.ts)");
// Beklenen net değerler BAĞIMSIZ yazıldı: netFactor'a değil, kanal marj tablosuna göre
// elle hesaplandı (Toyzz %50, DR %47, Armağan %47, Huppaluppo %45, Nezih %43; ÷1,20).
// Böylece netFactor'ı netFactor'la doğrulayan totoloji oluşmaz.
const NET_BEKLENEN: [Retailer, number, number][] = [
  ["Toyzz", 1200, 500], // 1200 × 0,50 ÷ 1,2
  ["DR", 1200, 530], // 1200 × 0,53 ÷ 1,2
  ["Armağan", 1200, 530],
  ["Huppaluppo", 1200, 550], // 1200 × 0,55 ÷ 1,2
  ["Nezih", 1200, 570], // 1200 × 0,57 ÷ 1,2
];
// Ham DB satırı taklidi (Supabase numeric kolonları string de döndürebilir).
const dbFact = (
  retailer: string,
  sales_value: any,
  extra: Record<string, any> = {},
) => ({
  retailer,
  week_start: "2026-05-11",
  store: "M1",
  sku_name: "Kart X",
  barkod: "8680000000001",
  sales_qty: 10,
  sales_value,
  stock_qty: 5,
  ...extra,
});
const dbSum = (
  retailer: string,
  sales_value: any,
  extra: Record<string, any> = {},
) => ({
  retailer,
  week_start: "2026-05-11",
  sales_qty: 10,
  sales_value,
  has_value: sales_value != null,
  stock_qty: 5,
  sku_count: 3,
  store_count: 2,
  ...extra,
});
for (const [ret, brut, net] of NET_BEKLENEN) {
  check(
    `toNetFacts: ${ret} brüt ${brut} → net ${net}`,
    approx(toNetFacts([dbFact(ret, brut)])[0].sales_value!, net, 0.01),
    `${toNetFacts([dbFact(ret, brut)])[0].sales_value}`,
  );
  check(
    `toNetSummary: ${ret} brüt ${brut} → net ${net}`,
    approx(toNetSummary([dbSum(ret, brut)])[0].sales_value!, net, 0.01),
    `${toNetSummary([dbSum(ret, brut)])[0].sales_value}`,
  );
  // toFacts/toSummary net dönüşüm YAPMAZ. Buraya net hesabı sızarsa toNetFacts
  // dönüşümü İKİ KEZ uygular ve ciro yarıya iner.
  check(
    `toFacts: ${ret} cirosu BRÜT kalır (net dönüşüm buraya sızmamalı)`,
    toFacts([dbFact(ret, brut)])[0].sales_value === brut,
    `${toFacts([dbFact(ret, brut)])[0].sales_value}`,
  );
}
check(
  "toNetFacts: 5 kanalın hepsi kendi çarpanını alıyor (hiçbir kanal diğerinin çarpanını almıyor)",
  (() => {
    const nf = toNetFacts(NET_BEKLENEN.map(([r, b]) => dbFact(r, b)));
    return (
      NET_BEKLENEN.every(([, , net], i) =>
        approx(nf[i].sales_value!, net, 0.01),
      ) && new Set(nf.map((r) => Math.round(r.sales_value! * 100))).size === 4
    ); // DR = Armağan
  })(),
  JSON.stringify(
    toNetFacts(NET_BEKLENEN.map(([r, b]) => dbFact(r, b))).map(
      (r) => r.sales_value,
    ),
  ),
);

// null / 0 ayrımı: null "ciro bilinmiyor", 0 "ciro sıfır" demektir; net dönüşüm
// null'ı 0'a çevirirse ciro bildirmeyen kanal satan kanal gibi toplama girer.
check(
  "toNetFacts: null ciro null KALIR (0'a çevrilmez)",
  toNetFacts([dbFact("DR", null)])[0].sales_value === null,
);
check(
  "toNetSummary: null ciro null KALIR",
  toNetSummary([dbSum("DR", null)])[0].sales_value === null,
);
check(
  "toNetFacts: sıfır ciro 0 kalır (null'a düşmez)",
  toNetFacts([dbFact("DR", 0)])[0].sales_value === 0,
);
check(
  "toFacts: sıfır ciro 0 kalır",
  toFacts([dbFact("DR", 0)])[0].sales_value === 0,
);

// Number() cast'leri: Supabase numeric/bigint kolonlarını STRING olarak döndürebiliyor.
check(
  "toFacts: string sayılar Number'a çevrilir",
  (() => {
    const f = toFacts([
      dbFact("DR", "1234.56", { sales_qty: "42", stock_qty: "7" }),
    ])[0];
    return (
      f.sales_qty === 42 &&
      f.stock_qty === 7 &&
      approx(f.sales_value!, 1234.56, 0.001) &&
      typeof f.sales_qty === "number" &&
      typeof f.sales_value === "number"
    );
  })(),
  JSON.stringify(
    toFacts([dbFact("DR", "1234.56", { sales_qty: "42", stock_qty: "7" })])[0],
  ),
);
check(
  "toFacts: string '0' ciro 0 olur (null sanılmaz)",
  toFacts([dbFact("DR", "0")])[0].sales_value === 0,
);
check(
  "toNetFacts: STRING brüt ciroya da doğru çarpan uygulanır (cast + marj birlikte)",
  approx(toNetFacts([dbFact("Toyzz", "1200")])[0].sales_value!, 500, 0.01),
  `${toNetFacts([dbFact("Toyzz", "1200")])[0].sales_value}`,
);
check(
  "toSummary: string sayılar Number'a çevrilir ve sayaçlar korunur",
  (() => {
    const s = toSummary([
      dbSum("DR", "1200", {
        sales_qty: "10",
        stock_qty: "5",
        sku_count: "3",
        store_count: "2",
      }),
    ])[0];
    return (
      s.sales_qty === 10 &&
      s.stock_qty === 5 &&
      s.sku_count === 3 &&
      s.store_count === 2 &&
      s.sales_value === 1200
    );
  })(),
);
check(
  "toFacts: store/barkod yoksa null (SKU_COLS matview'i store göndermiyor)",
  (() => {
    const f = toFacts([
      {
        retailer: "DR",
        week_start: "2026-05-11",
        sku_name: "X",
        sales_qty: 1,
        sales_value: 1,
        stock_qty: 1,
      },
    ])[0];
    return f.store === null && f.barkod === null;
  })(),
);
check(
  "toSummary: has_value boolean'a zorlanır (1/0/null)",
  (() => {
    const s = toSummary([
      dbSum("A", 1, { has_value: 1 }),
      dbSum("B", null, { has_value: 0 }),
      dbSum("C", null, { has_value: null }),
    ]);
    return (
      s[0].has_value === true &&
      s[1].has_value === false &&
      s[2].has_value === false
    );
  })(),
);
check(
  "toSummary: sku_count/store_count yoksa 0 (NaN değil)",
  (() => {
    const s = toSummary([
      {
        retailer: "A",
        week_start: "2026-05-11",
        sales_qty: 1,
        sales_value: 1,
        has_value: true,
        stock_qty: 0,
      },
    ])[0];
    return s.sku_count === 0 && s.store_count === 0;
  })(),
);
check(
  "dört köprü fonksiyonu da null/undefined girişte boş dizi döner (çökmez)",
  toFacts(null as any).length === 0 &&
    toSummary(null as any).length === 0 &&
    toNetFacts(undefined as any).length === 0 &&
    toNetSummary(undefined as any).length === 0,
);
check(
  "toNetFacts: sayısal olmayan alanlar korunur (ad, barkod, mağaza, hafta)",
  (() => {
    const f = toNetFacts([dbFact("Toyzz", 1200)])[0];
    return (
      f.sku_name === "Kart X" &&
      f.barkod === "8680000000001" &&
      f.store === "M1" &&
      f.week_start === "2026-05-11"
    );
  })(),
);

// ── ÇİFT UYGULAMA KALKANI ──
// Amaç doğruyu değil YANLIŞIN bariz olduğunu sabitlemek: gelecekte biri toNetFacts
// çıktısını tekrar netRows'a verirse (ya da toFacts'e net hesabı eklerse) ciro
// çarpanın KARESİNE düşer ve bu test o yolu belgeler.
check(
  "net dönüşüm İKİ KEZ uygulanınca ciro çarpanın karesine düşer (1200 → 500 → 208,33)",
  (() => {
    const birKez = toNetFacts([dbFact("Toyzz", 1200)])[0].sales_value!;
    const ikiKez = netRows(toNetFacts([dbFact("Toyzz", 1200)]))[0].sales_value!;
    return (
      approx(birKez, 500, 0.01) &&
      approx(ikiKez, 1200 * (0.5 / 1.2) ** 2, 0.01) &&
      ikiKez < birKez * 0.5
    );
  })(),
  `bir kez ${toNetFacts([dbFact("Toyzz", 1200)])[0].sales_value} / iki kez ${netRows(toNetFacts([dbFact("Toyzz", 1200)]))[0].sales_value}`,
);
check(
  "net dönüşüm HİÇ uygulanmazsa ciro 2 katından fazla görünür (eksik uygulama)",
  (() => {
    const brut = toFacts([dbFact("Toyzz", 1200)])[0].sales_value!;
    const net = toNetFacts([dbFact("Toyzz", 1200)])[0].sales_value!;
    return brut / net > 2 && approx(brut, 1200, 0.001);
  })(),
);
check(
  "çift uygulama 5 kanalın HEPSİNDE ciroyu düşürür (yön testi)",
  (() => {
    return NET_BEKLENEN.every(([ret, brut]) => {
      const bir = toNetFacts([dbFact(ret, brut)])[0].sales_value!;
      const iki = netRows(toNetFacts([dbFact(ret, brut)]))[0].sales_value!;
      return iki < bir * 0.6 && bir < brut;
    });
  })(),
);

// ── KOLON SÖZLEŞMESİ ──
// toFacts'in okuduğu her alan SELECT listesinde olmalı; kolon düşerse Number(undefined)
// = NaN üretilir ve NaN sessizce tüm toplamlara yayılır.
const kolonlar = (cols: string) => cols.split(",").map((c) => c.trim());
check(
  "FACT_COLS store içerir, SKU_COLS İÇERMEZ (mağaza boyutu çökertilmiş matview)",
  kolonlar(FACT_COLS).includes("store") &&
    !kolonlar(SKU_COLS).includes("store"),
  `FACT=${kolonlar(FACT_COLS).length} kolon, SKU=${kolonlar(SKU_COLS).length} kolon`,
);
check(
  "FACT_COLS ve SKU_COLS toFacts'in okuduğu tüm sayısal kolonları taşır",
  [
    "retailer",
    "week_start",
    "sku_name",
    "barkod",
    "sales_qty",
    "sales_value",
    "stock_qty",
  ].every(
    (k) => kolonlar(FACT_COLS).includes(k) && kolonlar(SKU_COLS).includes(k),
  ),
);
check(
  "STORE_COLS mağaza-hafta özeti için store ve sku_count taşır",
  kolonlar(STORE_COLS).includes("store") &&
    kolonlar(STORE_COLS).includes("sku_count"),
);
check(
  "FACT_COLS kolonlarından kurulan satır NaN üretmez (kolon düşerse yakalar)",
  (() => {
    const satir: Record<string, any> = {};
    for (const k of kolonlar(FACT_COLS)) {
      satir[k] = ["sales_qty", "sales_value", "stock_qty"].includes(k)
        ? "12"
        : "x";
    }
    const f = toFacts([satir])[0];
    return f.sales_qty === 12 && f.stock_qty === 12 && f.sales_value === 12;
  })(),
);
// GERÇEK KIRILGANLIK — rows.ts bu turda başka bir ajanın/kimsenin dosyası olduğu için
// DÜZELTİLMEDİ, yalnız işaretlendi: sayısal kolon eksik gelirse Number(undefined) NaN
// üretiyor, hiçbir uyarı yok ve NaN tüm ciro/adet toplamlarına yayılıyor.
if (
  isNaN(
    toFacts([{ retailer: "DR", week_start: "2026-05-11", sku_name: "X" }])[0]
      .sales_qty,
  )
) {
  warn(
    "rows.ts toFacts/toSummary: SELECT'ten sayısal kolon düşerse Number(undefined) = NaN üretiyor ve NaN sessizce tüm toplamlara yayılıyor (ekranda NaN ₺). Number(x ?? 0) ya da eksik kolonda açık hata daha güvenli olurdu.",
  );
}

// ───────────── 6. EWMA HIZ + SİPARİŞ ÖNCELİĞİ (sentetik) ─────────────
// Gerçek DR verisinde yalnız "izle"/"yeterli" tetikleniyor; dört durumun da
// gerçekten çalıştığını göstermek için sentetik veri şart.
section("6. EWMA hız + sipariş önceliği (sentetik)");
check(
  "ewma [10,20,30,40] = 28,24 (α=0,4, elle hesap)",
  approx(ewmaVelocity([10, 20, 30, 40]), 28.24, 0.0001),
  `${ewmaVelocity([10, 20, 30, 40])}`,
);
check("ewma boş seri 0", ewmaVelocity([]) === 0);
check("ewma tek eleman kendisi", ewmaVelocity([42]) === 42);
check(
  "ewma sabit seri = sabit",
  approx(ewmaVelocity([10, 10, 10, 10]), 10, 0.0001),
);
check(
  "ewma son haftaya ağırlık verir (artan seride düz ort. > değil)",
  ewmaVelocity([10, 20, 30, 40]) > (10 + 20 + 30 + 40) / 4,
);
check(
  "ewma azalan seride düz ortalamanın altında",
  ewmaVelocity([40, 30, 20, 10]) < (10 + 20 + 30 + 40) / 4,
  `${ewmaVelocity([40, 30, 20, 10])}`,
);

const RWK = ["2026-01-05", "2026-01-12", "2026-01-19", "2026-01-26"];
function reorderSatir(
  sku: string,
  haftalik: number[],
  sonStok: number,
): FactRow[] {
  return RWK.map((w, i) => ({
    retailer: "T",
    week_start: w,
    store: null,
    sku_name: sku,
    barkod: null,
    sales_qty: haftalik[i],
    sales_value: haftalik[i] * 10,
    // Stok yalnız SON haftadan okunur; önceki haftalara kasten farklı değer koyuyoruz.
    stock_qty: w === RWK[RWK.length - 1] ? sonStok : 999,
  }));
}
const rp = reorderPriority(
  [
    ...reorderSatir("TUKENDI", [20, 20, 20, 20], 0),
    ...reorderSatir("ACIL", [20, 20, 20, 20], 10),
    ...reorderSatir("IZLE", [20, 20, 20, 20], 30),
    ...reorderSatir("YETERLI", [20, 20, 20, 20], 200),
    ...reorderSatir("GURULTU", [5, 5, 5, 5], 100),
    ...reorderSatir("UP", [0, 0, 20, 60], 100),
    ...reorderSatir("DOWN", [60, 20, 0, 0], 100),
  ],
  RWK,
  10,
);
const rpBy = new Map(rp.map((r) => [r.sku_name, r]));
check(
  "reorder 'tükendi': satıyor ama son stok 0",
  rpBy.get("TUKENDI")?.status === "tükendi",
  rpBy.get("TUKENDI")?.status,
);
check(
  "reorder 'acil': kapsam < 1 hafta (stok 10 / hız 20)",
  rpBy.get("ACIL")?.status === "acil" && rpBy.get("ACIL")?.cover === 0.5,
  JSON.stringify(rpBy.get("ACIL")?.cover),
);
check(
  "reorder 'izle': kapsam 1-2 hafta (stok 30 / hız 20)",
  rpBy.get("IZLE")?.status === "izle" && rpBy.get("IZLE")?.cover === 1.5,
);
check(
  "reorder 'yeterli': kapsam ≥ 2 hafta (stok 200 / hız 20)",
  rpBy.get("YETERLI")?.status === "yeterli" &&
    rpBy.get("YETERLI")?.cover === 10,
);
check(
  "reorder dört durum da tetiklendi",
  new Set(rp.map((r) => r.status)).size === 4,
  [...new Set(rp.map((r) => r.status))].join(","),
);
check(
  "reorder minAvg altındaki gürültü elenir (hız 5 < 10)",
  !rpBy.has("GURULTU"),
);
check(
  "reorder stok SON haftadan okunur (999'lar sızmaz)",
  rpBy.get("ACIL")?.stock_qty === 10 && rpBy.get("YETERLI")?.stock_qty === 200,
);
check(
  "reorder haftalık ortalama = toplam / pencere",
  rpBy.get("IZLE")?.avg_sales === 20 && rpBy.get("IZLE")?.weeks_used === 4,
);
check(
  "reorder son hafta satışı ayrı tutulur",
  rpBy.get("UP")?.last_sales === 60 && rpBy.get("DOWN")?.last_sales === 0,
);
check(
  "reorder trend 'up' (ewma 28,8 / ort 20 = 1,44 ≥ 1,15)",
  rpBy.get("UP")?.trend === "up" && approx(rpBy.get("UP")!.ewma, 28.8, 0.05),
  `${rpBy.get("UP")?.trend}/${rpBy.get("UP")?.ewma}`,
);
check(
  "reorder trend 'down' (ewma 15,8 / ort 20 = 0,79 ≤ 0,85)",
  rpBy.get("DOWN")?.trend === "down" &&
    approx(rpBy.get("DOWN")!.ewma, 15.84, 0.05),
  `${rpBy.get("DOWN")?.trend}/${rpBy.get("DOWN")?.ewma}`,
);
check(
  "reorder trend 'flat' (±%15 bandı içinde)",
  rpBy.get("IZLE")?.trend === "flat",
);
check(
  "reorder cover_ewma = stok / ewma (ivmelenende daha kısa)",
  approx(rpBy.get("UP")!.cover_ewma!, 3.5, 0.05) &&
    rpBy.get("UP")!.cover_ewma! < rpBy.get("UP")!.cover!,
  `${rpBy.get("UP")?.cover_ewma} vs ${rpBy.get("UP")?.cover}`,
);
check(
  "reorder yavaşlayanda cover_ewma daha uzun (erken uyarı simetrik)",
  rpBy.get("DOWN")!.cover_ewma! > rpBy.get("DOWN")!.cover!,
  `${rpBy.get("DOWN")?.cover_ewma}`,
);
check(
  "reorder en acil önce sıralı (tükendi → acil → izle → yeterli)",
  rp[0].sku_name === "TUKENDI" &&
    rp[1].sku_name === "ACIL" &&
    rp[2].sku_name === "IZLE",
  rp.map((r) => r.sku_name).join(">"),
);
check("reorder boş giriş boş", reorderPriority([], [], 10).length === 0);
check(
  "reorder haftasız giriş boş (pencere yoksa hız tanımsız)",
  reorderPriority(reorderSatir("X", [20, 20, 20, 20], 5), [], 10).length === 0,
);

// ───────────── 7. KAPSAM (COVERAGE) — /api/stock'un tamamını besliyor ─────────────
section("7. Kapsam durumu ve hesabı (sentetik)");
// EŞİKLER ELLE YAZILMAZ: COVERAGE_LOW / COVERAGE_HIGH / MIN_VELOCITY compute.ts'ten
// import edilir. Önceden 8/30/1 testlere gömülüydü; eşik değişse testler eski eşiği
// doğrulamaya devam eder ve "geçiyor" diye yanlış güven verirdi.
check(
  "eşik sabitleri tutarlı (LOW < HIGH, hız eşiği pozitif)",
  COVERAGE_LOW < COVERAGE_HIGH && MIN_VELOCITY > 0,
  `${COVERAGE_LOW}/${COVERAGE_HIGH}/${MIN_VELOCITY}`,
);
check(
  "ölü stok eşikleri tutarlı (MIN < HIGH) ve kapsam üst eşiğinin üstünde",
  DEAD_STOCK_MIN_WEEKS < DEAD_STOCK_HIGH_WEEKS &&
    DEAD_STOCK_MIN_WEEKS > COVERAGE_HIGH,
  `${DEAD_STOCK_MIN_WEEKS}/${DEAD_STOCK_HIGH_WEEKS} vs kapsam üst ${COVERAGE_HIGH}`,
);
check(
  "hız penceresi çekilen pencereye sığar (VELOCITY_WEEKS ≤ WINDOW_WEEKS)",
  VELOCITY_WEEKS <= WINDOW_WEEKS && VELOCITY_WEEKS > 0,
  `${VELOCITY_WEEKS}/${WINDOW_WEEKS}`,
);
check(
  "COVERAGE_LABELS metinleri eşiklerden TÜRER (UI'da elle sayı yazılmaz)",
  COVERAGE_LABELS.kritik.includes(String(COVERAGE_LOW)) &&
    COVERAGE_LABELS.fazla.includes(String(COVERAGE_HIGH)) &&
    COVERAGE_LABELS.saglikli.includes(String(COVERAGE_LOW)) &&
    COVERAGE_LABELS.saglikli.includes(String(COVERAGE_HIGH)),
  JSON.stringify(COVERAGE_LABELS),
);

// Hız eşiğinin altı/üstü: sayı yerine eşikten türetilir.
const YAVAS = MIN_VELOCITY / 2; // "anlamlı satış" eşiğinin altı → kritik olamaz
const HIZLI = MIN_VELOCITY * 10; // eşiğin belirgin üstü
check(
  "kapsam: hız 0 + stok var + kapsam ∞ → fazla (ölü stok)",
  coverageStatus(null, 0, 500) === "fazla",
);
check("kapsam: hız 0 + stok 0 → yok", coverageStatus(null, 0, 0) === "yok");
check(
  `kapsam: yavaş satan (hız ${YAVAS} < ${MIN_VELOCITY}) az stok → yok (acil sipariş değil)`,
  coverageStatus(COVERAGE_LOW - 3, YAVAS, 2.5) === "yok",
);
check(
  `kapsam: yavaş satan + ${COVERAGE_HIGH} hafta üstü stok → fazla`,
  coverageStatus(COVERAGE_HIGH + 10, YAVAS, 20) === "fazla",
);
check(
  "kapsam: stok 0 + satış var → yok (kapsam null)",
  coverageStatus(null, HIZLI, 0) === "yok",
);
check(
  `kapsam: hızlı satan + ${COVERAGE_LOW / 2} hafta stok → kritik`,
  coverageStatus(COVERAGE_LOW / 2, HIZLI, 40) === "kritik",
);
check(
  `kapsam: ${COVERAGE_LOW - 0.1} hf kritik / ${COVERAGE_LOW} hf sağlıklı (alt sınır, eşik dahil sağlıklı)`,
  coverageStatus(COVERAGE_LOW - 0.1, HIZLI, 79) === "kritik" &&
    coverageStatus(COVERAGE_LOW, HIZLI, 80) === "saglikli",
);
check(
  `kapsam: ${COVERAGE_HIGH} hf sağlıklı / ${COVERAGE_HIGH + 0.1} hf fazla (üst sınır, eşik dahil sağlıklı)`,
  coverageStatus(COVERAGE_HIGH, HIZLI, 300) === "saglikli" &&
    coverageStatus(COVERAGE_HIGH + 0.1, HIZLI, 301) === "fazla",
);
check(
  `kapsam: hız tam eşikte (${MIN_VELOCITY}) normal dala girer`,
  coverageStatus(COVERAGE_LOW / 2, MIN_VELOCITY, 4) === "kritik",
);

const cov = computeCoverage([
  { sku_name: "A", week_start: "2026-01-05", sales_qty: 10, stock_qty: 0 },
  { sku_name: "A", week_start: "2026-01-12", sales_qty: 30, stock_qty: 60 },
  { sku_name: "A", week_start: "2026-01-12", sales_qty: 0, stock_qty: 40 }, // aynı hafta 2. mağaza
  { sku_name: "B", week_start: "2026-01-12", sales_qty: 0, stock_qty: 50 },
]);
const covA = cov.find((c) => c.sku_name === "A")!,
  covB = cov.find((c) => c.sku_name === "B")!;
check(
  "computeCoverage ortalama = toplam / BENZERSİZ hafta (40/2 = 20)",
  covA.avg_weekly === 20,
  `${covA.avg_weekly}`,
);
check(
  "computeCoverage son stok aynı haftadaki satırları toplar (60+40 = 100)",
  covA.last_stock === 100,
  `${covA.last_stock}`,
);
check(
  "computeCoverage kapsam = son stok / hız (100/20 = 5)",
  covA.coverage === 5,
);
check(
  "computeCoverage satış yoksa kapsam null (sonsuz)",
  covB.coverage === null && covB.last_stock === 50,
);
check("computeCoverage boş giriş boş", computeCoverage([]).length === 0);

// ── HIZ PENCERESİ (velocityWeeks) — ÜRETİMDE KULLANILAN YOL ──
// /api/stock hızı ÖMÜR ortalamasıyla değil son VELOCITY_WEEKS haftayla hesaplıyor.
// Neden: lansmanda patlayıp normale dönen üründe iki ölçüt katlarca ayrışıyor
// (ölçülmüş örnek: ömür 886,9/hf ↔ son 8 hafta 76,6/hf) ve ürün SAHTE "kritik"
// işaretleniyordu (66 kritik satırın 37'si bu yüzden yanlıştı). Pencere yolu
// test edilmiyordu; bu testler o düzeltmeyi kilitler.
const hfBasi = (i: number) =>
  new Date(Date.UTC(2026, 0, 5 + i * 7)).toISOString().slice(0, 10);
const lansmanRows = Array.from({ length: 10 }, (_, i) => ({
  sku_name: "LANSMAN",
  week_start: hfBasi(i),
  sales_qty: i === 0 ? 800 : 0,
  stock_qty: 100,
}));
const covOmur = computeCoverage(lansmanRows)[0];
const covPencere = computeCoverage(lansmanRows, VELOCITY_WEEKS)[0];
check(
  "computeCoverage: velocityWeeks yoksa hız ÖMÜR ortalaması (800/10 = 80)",
  approx(covOmur.avg_weekly, 80, 0.001) &&
    approx(covOmur.coverage!, 1.25, 0.001),
  `${covOmur.avg_weekly} → kapsam ${covOmur.coverage}`,
);
check(
  `computeCoverage: velocityWeeks=${VELOCITY_WEEKS} verilince hız SON pencereden (satmayan haftalar 0 sayılır)`,
  covPencere.avg_weekly === 0 && covPencere.coverage === null,
  `${covPencere.avg_weekly} → kapsam ${covPencere.coverage}`,
);
check(
  "computeCoverage: iki ölçüt zıt karar üretiyor (ömür → SAHTE kritik, pencere → fazla)",
  coverageStatus(covOmur.coverage, covOmur.avg_weekly, covOmur.last_stock) ===
    "kritik" &&
    coverageStatus(
      covPencere.coverage,
      covPencere.avg_weekly,
      covPencere.last_stock,
    ) === "fazla",
  `${coverageStatus(covOmur.coverage, covOmur.avg_weekly, covOmur.last_stock)} vs ${coverageStatus(covPencere.coverage, covPencere.avg_weekly, covPencere.last_stock)}`,
);
check(
  "computeCoverage: pencere yolunda da son stok firmanın SON haftasından okunur",
  covPencere.last_stock === 100 && covOmur.last_stock === 100,
);
check(
  "computeCoverage: pencere veri kümesinin son N haftası (eski haftalar hıza girmez)",
  (() => {
    // Aynı seri, ama satış SON haftada: pencere hızı 800/N, ömür hızı 80.
    const sonHafta = lansmanRows.map((r, i) => ({
      ...r,
      sales_qty: i === lansmanRows.length - 1 ? 800 : 0,
    }));
    const p = computeCoverage(sonHafta, VELOCITY_WEEKS)[0];
    return approx(p.avg_weekly, 800 / VELOCITY_WEEKS, 0.001);
  })(),
  `${
    computeCoverage(
      lansmanRows.map((r, i) => ({
        ...r,
        sales_qty: i === lansmanRows.length - 1 ? 800 : 0,
      })),
      VELOCITY_WEEKS,
    )[0].avg_weekly
  }`,
);
check(
  "computeCoverage: güncel haftada görünmeyen SKU 'stale' işaretlenir (kalıntı stok)",
  (() => {
    const rows = [
      {
        sku_name: "GUNCEL",
        week_start: hfBasi(0),
        sales_qty: 5,
        stock_qty: 10,
      },
      { sku_name: "GUNCEL", week_start: hfBasi(1), sales_qty: 5, stock_qty: 8 },
      { sku_name: "BAYAT", week_start: hfBasi(0), sales_qty: 5, stock_qty: 40 },
    ];
    const c = computeCoverage(rows);
    const g = c.find((x) => x.sku_name === "GUNCEL")!,
      b = c.find((x) => x.sku_name === "BAYAT")!;
    return g.stale === false && b.stale === true && b.last_seen === hfBasi(0);
  })(),
);

const sc = summarizeCoverage([
  { sku_name: "K", avg_weekly: 10, last_stock: 40, coverage: 4 }, // kritik
  { sku_name: "K2", avg_weekly: 10, last_stock: 20, coverage: 2 }, // kritik (daha acil)
  { sku_name: "F", avg_weekly: 2, last_stock: 200, coverage: 100 }, // fazla
  { sku_name: "S", avg_weekly: 10, last_stock: 150, coverage: 15 }, // sağlıklı
  { sku_name: "Y", avg_weekly: 0, last_stock: 0, coverage: null }, // yok → elenir
]);
check(
  "summarizeCoverage 'yok' satırları elenir",
  sc.skus.length === 4 && !sc.skus.some((s) => s.sku_name === "Y"),
  `${sc.skus.length}`,
);
check(
  "summarizeCoverage sayaçlar doğru",
  sc.summary.kritik === 2 &&
    sc.summary.fazla === 1 &&
    sc.summary.saglikli === 1 &&
    sc.summary.toplam === 4,
  JSON.stringify(sc.summary),
);
check(
  "summarizeCoverage kritik → fazla → sağlıklı sırası",
  sc.skus.map((s) => s.status).join(",") === "kritik,kritik,fazla,saglikli",
  sc.skus.map((s) => s.status).join(","),
);
check(
  "summarizeCoverage kritikler en acil (en düşük kapsam) önce",
  sc.skus[0].sku_name === "K2",
  sc.skus[0].sku_name,
);
check(
  "summarizeCoverage boş giriş boş özet",
  summarizeCoverage([]).skus.length === 0 &&
    summarizeCoverage([]).summary.toplam === 0,
);

// ───────────── 8. ÖLÜ STOK (firmalar arası birleştirme) ─────────────
section("8. Ölü stok gruplama (sentetik)");
const dsItems: CoverageItem[] = [
  {
    retailer: "DR",
    product_key: "B1",
    barkod: "B1",
    sku_name: "Kart kısa",
    avg_weekly: 10,
    last_stock: 100,
    coverage_weeks: 10,
  },
  {
    retailer: "Toyzz",
    product_key: "B1",
    barkod: null,
    sku_name: "Kart uzun ad",
    avg_weekly: 0,
    last_stock: 50,
    coverage_weeks: null,
  },
  {
    retailer: "DR",
    product_key: "NAME:Ölü Ürün",
    barkod: null,
    sku_name: "Ölü Ürün",
    avg_weekly: 0,
    last_stock: 700,
    coverage_weeks: null,
  },
  {
    retailer: "DR",
    product_key: "B2",
    barkod: "B2",
    sku_name: "Hızlı",
    avg_weekly: 50,
    last_stock: 100,
    coverage_weeks: 2,
  },
];
const ds = groupDeadStock(dsItems);
const dsBy = new Map(ds.map((d) => [d.product_key, d]));
check(
  "ölü stok: 4 satır → 3 ürün (aynı product_key birleşir)",
  ds.length === 3,
  `${ds.length}`,
);
check(
  "ölü stok: stok ve hız firmalar arası toplanır (100+50, 10+0)",
  dsBy.get("B1")!.total_stock === 150 && dsBy.get("B1")!.total_velocity === 10,
);
check(
  "ölü stok: ağ kapsamı = toplam stok / toplam hız (150/10 = 15)",
  dsBy.get("B1")!.coverage === 15,
);
check(
  "ölü stok: temsili ad EN UZUN olan",
  dsBy.get("B1")!.name === "Kart uzun ad",
  dsBy.get("B1")!.name,
);
check(
  "ölü stok: barkod barkodu OLAN firmadan alınır",
  dsBy.get("B1")!.barkod === "B1",
);
check(
  "ölü stok: hiç satmayan + stoklu firma varsa max_firm_coverage null (∞)",
  dsBy.get("B1")!.max_firm_coverage === null,
);
check(
  "ölü stok: hepsi satan üründe max_firm_coverage sayı",
  dsBy.get("B2")!.max_firm_coverage === 2,
);
check(
  "ölü stok: hiç satmayan ürün never_sold",
  dsBy.get("NAME:Ölü Ürün")!.never_sold === true &&
    dsBy.get("B1")!.never_sold === false,
);
check(
  "ölü stok: never_sold en başta (en ölü önce)",
  ds[0].product_key === "NAME:Ölü Ürün",
  ds[0].product_key,
);
check(
  "ölü stok: satanlar kapsam AZALAN sıralı (15 > 2)",
  ds[1].product_key === "B1" && ds[2].product_key === "B2",
  ds.map((d) => d.product_key).join(">"),
);
check(
  "ölü stok: firmalar stok azalan sıralı",
  dsBy.get("B1")!.firms[0].retailer === "DR",
);
check(
  "ölü stok: NAME: anahtarı addan türer (barkodsuz tek firma)",
  dsBy.get("NAME:Ölü Ürün")!.name === "Ölü Ürün",
);
check("ölü stok boş giriş boş", groupDeadStock([]).length === 0);

// ───────────── 9. ÜRÜN KİMLİĞİ (productKey) + ALIAS DALI ─────────────
// Alias dalı hiç test edilmemişti: onaylı alias çalışmazsa Toyzz (barkodsuz) satırları
// diğer firmalarla BİRLEŞMEZ ve ürün ağ genelinde iki ayrı kalem gibi görünür.
section("9. Ürün kimliği ve alias çözümü");
const aliases: AliasMap = new Map([["Toyzz|Kart X", "8680000000001"]]);
check(
  "productKey: barkod varsa barkod kazanır (alias'a bakmaz)",
  productKey("Toyzz", "Kart X", "111", aliases) === "111",
);
check(
  "productKey: barkod yok + onaylı alias → alias barkodu",
  productKey("Toyzz", "Kart X", null, aliases) === "8680000000001",
);
check(
  "productKey: alias yok → 'NAME:' anahtarına düşer",
  productKey("Toyzz", "Kart X", null) === "NAME:Kart X",
);
check(
  "productKey: alias haritası verilse de eşleşmeyen isim NAME:'e düşer",
  productKey("Toyzz", "Kart Y", null, aliases) === "NAME:Kart Y",
);
check(
  "productKey: alias perakendeciye ÖZGÜ (başka firmada eşleşmez)",
  productKey("Nezih", "Kart X", null, aliases) === "NAME:Kart X",
);
const fx = (
  retailer: string,
  sku_name: string,
  barkod: string | null,
  q: number,
  v: number,
  st: number,
): FactRow => ({
  retailer,
  week_start: "2026-01-12",
  store: null,
  sku_name,
  barkod,
  sales_qty: q,
  sales_value: v,
  stock_qty: st,
});
const aliasRows = [
  fx("Toyzz", "Kart X", null, 100, 1000, 50),
  fx("DR", "Kart X uzun ad", "8680000000001", 40, 400, 20),
];
check(
  "globalRankings: alias YOKken iki ayrı kalem",
  (() => {
    const t = globalRankings(aliasRows, new Map(), "qty").top;
    return t.length === 2 && t[0].sales_qty === 100;
  })(),
);
check(
  "globalRankings: alias VARken tek kalemde birleşir (140 adet, 2 firma)",
  (() => {
    const t = globalRankings(aliasRows, new Map(), "qty", aliases).top;
    return (
      t.length === 1 &&
      t[0].sales_qty === 140 &&
      t[0].retailers.join(",") === "DR,Toyzz"
    );
  })(),
  JSON.stringify(
    globalRankings(aliasRows, new Map(), "qty", aliases).top.map((t) => [
      t.sales_qty,
      t.retailers,
    ]),
  ),
);
check(
  "globalRankings: birleşende barkod ve stok da toplanır",
  (() => {
    const t = globalRankings(aliasRows, new Map(), "qty", aliases).top[0];
    return t.barkod === "8680000000001" && t.stock_qty === 70;
  })(),
);
check(
  "comparePeriods: alias iki firmayı aynı SKU sayar (yeni ürün sanmaz)",
  (() => {
    const a = [fx("DR", "Kart X uzun ad", "8680000000001", 40, 0, 0)];
    const b = [fx("Toyzz", "Kart X", null, 100, 0, 0)];
    const aliassiz = comparePeriods(a, b);
    const aliasli = comparePeriods(a, b, aliases);
    // Alias yoksa: biri "kaybolan" biri "yeni". Alias varsa: tek SKU, +60 delta.
    return (
      aliassiz.newSkus.length === 1 &&
      aliassiz.lostSkus.length === 1 &&
      aliasli.newSkus.length === 0 &&
      aliasli.lostSkus.length === 0 &&
      aliasli.gainers.length === 1 &&
      aliasli.gainers[0].delta === 60
    );
  })(),
);

// ───────────── 10. EXECUTIVE ÖZET ANLAMLILIK KAPILARI (sentetik) ─────────────
// Kapı: ciro tabanı max(25.000, ağ×%5) + en az 2 karşılaştırılabilir firma.
// Gerçek veride kapı devreye girdiğinde best/worst null olur ve eski test kendini
// iptal ediyordu (`if (!exec.best) return true`) — sentetik veri şart.
section("10. Executive özet: anlamlılık kapıları (sentetik)");
const S = (
  retailer: string,
  week_start: string,
  qty: number,
  val: number | null,
): SummaryRow => ({
  retailer,
  week_start,
  sales_qty: qty,
  sales_value: val,
  has_value: val != null,
  stock_qty: 0,
  sku_count: 1,
  store_count: 0,
});

const execTek = execOverview([
  S("DR", "2026-01-05", 1000, 500000),
  S("DR", "2026-01-12", 1200, 600000),
]);
check(
  "(a) tek firmalı haftada best NULL",
  execTek.best === null,
  JSON.stringify(execTek.best),
);
check(
  "(a) tek firmalı haftada worst NULL",
  execTek.worst === null,
  JSON.stringify(execTek.worst),
);
check(
  "(a) tek firmada ağ WoW'u yine hesaplanır (+%20)",
  approx(execTek.network.wow_value ?? 0, 20, 0.01),
  `${execTek.network.wow_value}`,
);

// Taban: ağ cirosu 1.810.000 → taban max(25.000, 90.500) = 90.500.
// SMALL 10.000 TL cirosuyla +%900 büyüse bile aday OLAMAZ.
const execTaban = execOverview([
  S("BIG1", "2026-01-05", 1000, 500000),
  S("BIG1", "2026-01-12", 2000, 1000000), // +%100
  S("BIG2", "2026-01-05", 1000, 1000000),
  S("BIG2", "2026-01-12", 800, 800000), // −%20
  S("SMALL", "2026-01-05", 10, 1000),
  S("SMALL", "2026-01-12", 100, 10000), // +%900 ama sığ
]);
check(
  "(b) taban altındaki küçük kanal best OLAMAZ (+%900 olsa bile)",
  execTaban.best?.retailer !== "SMALL",
  JSON.stringify(execTaban.best),
);
check(
  "(b) taban altındaki küçük kanal worst da OLAMAZ",
  execTaban.worst?.retailer !== "SMALL",
);
check(
  "(c) doğru kazanan seçilir: BIG1 +%100",
  execTaban.best?.retailer === "BIG1" && approx(execTaban.best!.wow, 100, 0.01),
  JSON.stringify(execTaban.best),
);
check(
  "(c) doğru kaybeden seçilir: BIG2 −%20",
  execTaban.worst?.retailer === "BIG2" &&
    approx(execTaban.worst!.wow, -20, 0.01),
  JSON.stringify(execTaban.worst),
);
check(
  "(d) best ve worst AYNI firma değil",
  execTaban.best!.retailer !== execTaban.worst!.retailer,
);
check(
  "(d) best WoW'u worst'tan büyük",
  execTaban.best!.wow > execTaban.worst!.wow,
);
check(
  "taban hesabı: SMALL ağ cirosunun %5'inin altında",
  10000 < Math.max(25000, execTaban.network.sales_value * 0.05),
);

// Ciro yoksa adet dalına düşer; adet tabanı max(100, ağ×%5).
const execAdet = execOverview([
  S("R1", "2026-01-05", 800, null),
  S("R1", "2026-01-12", 1000, null), // +%25
  S("R2", "2026-01-05", 1000, null),
  S("R2", "2026-01-12", 900, null), // −%10
  S("TINY", "2026-01-05", 5, null),
  S("TINY", "2026-01-12", 50, null), // +%900 ama 50 adet
]);
check(
  "ciro yoksa adet dalı çalışır: best R1 +%25",
  execAdet.best?.retailer === "R1" && approx(execAdet.best!.wow, 25, 0.01),
  JSON.stringify(execAdet.best),
);
check(
  "adet dalında da sığ kanal (50 adet < 100 taban) aday değil",
  execAdet.best?.retailer !== "TINY" && execAdet.worst?.retailer !== "TINY",
);
check(
  "adet dalı worst R2 −%10",
  execAdet.worst?.retailer === "R2" && approx(execAdet.worst!.wow, -10, 0.01),
);

// Geçen hafta verisi olmayan firma: sahte büyüme YOK, status "nodata".
const execNodata = execOverview([
  S("A", "2026-01-12", 500, 900000),
  S("B", "2026-01-05", 400, 800000),
]);
check(
  "geçen hafta verisi yoksa wow null + status nodata",
  (() => {
    const a = execNodata.retailers.find((r) => r.retailer === "A")!;
    return a.has_data === true && a.wow === null && a.status === "nodata";
  })(),
);
check(
  "o hafta verisi olmayan firma has_data=false, satış 0",
  (() => {
    const b = execNodata.retailers.find((r) => r.retailer === "B")!;
    return b.has_data === false && b.sales_qty === 0 && b.sales_value === null;
  })(),
);
check(
  "karşılaştırılabilir firma yoksa best/worst null",
  execNodata.best === null && execNodata.worst === null,
);
check(
  "prev_week seçili haftanın tam 7 gün öncesi",
  execNodata.prev_week === "2026-01-05",
);
check(
  "veri olan firma sıralamada önce gelir",
  execNodata.retailers[0].retailer === "A",
);
check(
  "exec boş summary güvenli",
  (() => {
    const e = execOverview([]);
    return (
      e.latest_week === null &&
      e.retailers.length === 0 &&
      e.network.sales_qty === 0 &&
      e.best === null
    );
  })(),
);
check(
  "exec targetWeek verilince o haftaya odaklanır",
  (() => {
    const e = execOverview(
      [
        S("DR", "2026-01-05", 1000, 500000),
        S("DR", "2026-01-12", 1200, 600000),
      ],
      "2026-01-05",
    );
    return e.latest_week === "2026-01-05" && e.network.sales_qty === 1000;
  })(),
);

// ───────────── 11. DÖNEM KARŞILAŞTIRMA (sentetik) ─────────────
section("11. Dönem karşılaştırma (sentetik)");
const cmpS = comparePeriods(
  [
    fx("T", "ARTAN", "1", 10, 0, 0),
    fx("T", "AZALAN", "2", 100, 0, 0),
    fx("T", "KAYBOLAN", "3", 50, 0, 0),
  ],
  [
    fx("T", "ARTAN", "1", 60, 0, 0),
    fx("T", "AZALAN", "2", 40, 0, 0),
    fx("T", "YENI", "4", 25, 0, 0),
  ],
);
check(
  "cmp artan delta +50 ve yüzde +%500",
  cmpS.gainers[0].sku_name === "ARTAN" &&
    cmpS.gainers[0].delta === 50 &&
    approx(cmpS.gainers[0].delta_pct!, 500, 0.01),
  JSON.stringify(cmpS.gainers[0]),
);
check(
  "cmp azalan en başta losers'ta (delta −60)",
  cmpS.losers[0].sku_name === "AZALAN" && cmpS.losers[0].delta === -60,
);
check(
  "cmp yeni SKU ayrı listede (a=0, b>0)",
  cmpS.newSkus.length === 1 &&
    cmpS.newSkus[0].sku_name === "YENI" &&
    cmpS.newSkus[0].a_qty === 0 &&
    cmpS.newSkus[0].b_qty === 25,
);
check(
  "cmp kaybolan SKU ayrı listede (a>0, b=0)",
  cmpS.lostSkus.length === 1 &&
    cmpS.lostSkus[0].sku_name === "KAYBOLAN" &&
    cmpS.lostSkus[0].b_qty === 0,
);
check(
  "cmp yeni/kaybolan gainers-losers'a KARIŞMAZ",
  !cmpS.gainers.some((g) => g.sku_name === "YENI" || g.sku_name === "KAYBOLAN"),
);
check(
  "cmp sıfır bazda delta_pct null (0'a bölme yok)",
  cmpS.newSkus[0].delta_pct === null,
);
check(
  "karşılaştırma boş giriş güvenli",
  (() => {
    const c = comparePeriods([], []);
    return (
      c.gainers.length === 0 &&
      c.losers.length === 0 &&
      c.newSkus.length === 0 &&
      c.lostSkus.length === 0
    );
  })(),
);

// ───────────── 12. ÜRÜN ZEKASI (isim parsing) ─────────────
section("12. Ürün zekası (isim parsing)");
check(
  "parse Beşiktaş takım",
  parseProductMeta("Mythos Beşiktaş Kart First 25/26").team === "Beşiktaş",
);
check(
  "parse Galatasaray takım",
  parseProductMeta("Mythos Galatasaray First 2025/26").team === "Galatasaray",
);
check(
  "parse Fenerbahçe takım",
  parseProductMeta("Mythos Cards Fenerbahçe First 2025/26").team ===
    "Fenerbahçe",
);
check(
  "parse Mythos marka",
  parseProductMeta("Mythos Beşiktaş Booster").brand === "Mythos",
);
check(
  "parse Topps marka",
  parseProductMeta("Topps-UEFA 25 Şamp.Ligi Sticker").brand === "Topps",
);
check(
  "parse Booster tip",
  parseProductMeta("Mythos Beşiktaş Booster Paket").type === "Booster",
);
check(
  "parse Sticker tip",
  parseProductMeta("Topps Şampiyonlar Sticker").type === "Sticker",
);
check(
  "parse UEFA/Şampiyonlar Ligi",
  parseProductMeta("Topps-UEFA 25 Şamp.Ligi Sticker").team ===
    "UEFA/Şampiyonlar Ligi",
);
check(
  "parse aksansız yazım da eşleşir (besiktas)",
  parseProductMeta("Mythos Besiktas Booster").team === "Beşiktaş",
);
check(
  "parse bilinmeyen → Diğer/Genel/Diğer",
  (() => {
    const m = parseProductMeta("Rastgele Ürün XYZ");
    return m.brand === "Diğer" && m.team === "Genel" && m.type === "Diğer";
  })(),
);
check(
  "parse boş ad çökmez",
  (() => {
    const m = parseProductMeta("");
    return m.brand === "Diğer" && m.team === "Genel";
  })(),
);

// ───────────── 14. DİĞER SAF FONKSİYON KENAR DURUMLARI ─────────────
section("14. Kenar durumları (sentetik)");
check("buildSummary boş giriş boş çıkış", buildSummary([]).length === 0);
check(
  "buildSummary ciro yoksa has_value=false ve sales_value null",
  (() => {
    const s = buildSummary([
      { ...fx("T", "X", null, 10, 0, 5), sales_value: null },
    ]);
    return (
      s.length === 1 && s[0].has_value === false && s[0].sales_value === null
    );
  })(),
);
check(
  "buildSummary mağaza ve SKU sayar, adet/stok toplar",
  (() => {
    const s = buildSummary([
      { ...fx("T", "X", null, 10, 100, 5), store: "M1" },
      { ...fx("T", "Y", null, 20, 200, 15), store: "M2" },
      { ...fx("T", "X", null, 5, 50, 5), store: "M2" },
    ]);
    return (
      s.length === 1 &&
      s[0].sales_qty === 35 &&
      s[0].stock_qty === 25 &&
      s[0].sku_count === 2 &&
      s[0].store_count === 2 &&
      s[0].sales_value === 350
    );
  })(),
);
check(
  "buildSummary hafta artan sıralı döner",
  (() => {
    const s = buildSummary([
      { ...fx("T", "X", null, 1, 0, 0), week_start: "2026-02-02" },
      { ...fx("T", "X", null, 1, 0, 0), week_start: "2026-01-05" },
    ]);
    return s[0].week_start === "2026-01-05" && s[1].week_start === "2026-02-02";
  })(),
);
check(
  "generateInsights boş summary boş",
  generateInsights([], []).length === 0,
);
check(
  "generateInsights tek haftalık firma için sinyal üretmez (WoW yok)",
  generateInsights([S("T", "2026-01-12", 1000, 100000)], []).length === 0,
);
check(
  "generateInsights stockout riskini kritik insight'a çevirir",
  (() => {
    const ins = generateInsights(
      [],
      [{ retailer: "DR", sku: "Kart X", wos: 1.2, sales: 100, stock: 120 }],
    );
    return (
      ins.length === 1 &&
      ins[0].severity === "critical" &&
      ins[0].retailer === "DR" &&
      ins[0].title.includes("Kart X")
    );
  })(),
);
// HER SİNYAL VERİ HAFTASINI TAŞIR: bayat firmada "sonraki hafta tahmini" geçmiş
// bir haftayı anlatıyor olabilir; ekran bunu ancak hafta alanıyla söyleyebilir.
// NOT: generateInsights kanonik RETAILERS listesini gezer; "T" gibi uydurma bir
// firma adı HİÇ sinyal üretmez. Bu yüzden gerçek bir firma adıyla test edilir
// (aksi halde boş listede `every` otomatik geçer — sessiz yeşil).
check(
  "generateInsights her sinyale veri haftasını yazar",
  (() => {
    const ins = generateInsights(
      [S("DR", "2026-01-05", 100, null), S("DR", "2026-01-12", 300, null)],
      [],
    );
    return ins.length > 0 && ins.every((i) => i.week === "2026-01-12");
  })(),
);
check(
  "generateInsights stockout riski hafta alanını taşır",
  (() => {
    const ins = generateInsights(
      [],
      [
        {
          retailer: "DR",
          sku: "K",
          wos: 1,
          sales: 10,
          stock: 5,
          week: "2026-02-02",
        },
      ],
    );
    return ins[0]?.week === "2026-02-02";
  })(),
);
// BAYAT ÜRÜN STOCKOUT DEĞİL: son haftada satırı olmayan ürünün stoğu BİLİNMİYOR,
// 0 değil. Eskiden `?? 0` ile "tükenmek üzere · stok 0" kritik uyarısı üretiyordu.
check(
  "findStockoutRisks: son haftada olmayan ürün risk sayılmaz",
  (() => {
    const w = ["2026-01-05", "2026-01-12", "2026-01-19"];
    const rows = [
      // BAYAT: ilk iki hafta 10/hf satıyor, son hafta raporda YOK
      fx("T", "BAYAT", null, 10, 0, 50),
      { ...fx("T", "BAYAT", null, 10, 0, 50), week_start: "2026-01-12" },
      // CANLI: üç hafta da var, stok 5, hız ~10 → gerçek risk
      fx("T", "CANLI", null, 10, 0, 50),
      { ...fx("T", "CANLI", null, 10, 0, 50), week_start: "2026-01-12" },
      { ...fx("T", "CANLI", null, 10, 0, 5), week_start: "2026-01-19" },
    ];
    const r = findStockoutRisks(rows, "T", w);
    return r.length === 1 && r[0].sku === "CANLI" && r[0].week === "2026-01-19";
  })(),
);
check(
  "findStockoutRisks bölen = rafta olduğu hafta (en az 2), pencere boyu değil",
  (() => {
    // Yalnız son 2 haftada var, 30+30 sattı, stok 20 → hız 30 (60/2), wos 0,67 → risk.
    // Pencere boyuna (4) bölünseydi hız 15, wos 1,33 → yine risk ama hız yanlış raporlanırdı.
    const w = ["2025-12-29", "2026-01-05", "2026-01-12", "2026-01-19"];
    const rows = [
      { ...fx("T", "YENI", null, 30, 0, 40), week_start: "2026-01-12" },
      { ...fx("T", "YENI", null, 30, 0, 20), week_start: "2026-01-19" },
    ];
    const r = findStockoutRisks(rows, "T", w);
    return r.length === 1 && r[0].sales === 30;
  })(),
);
check(
  "categoryBreakdown boş giriş boş",
  categoryBreakdown([], "brand").length === 0,
);
check(
  "pivotProduct boş giriş güvenli",
  (() => {
    const p = pivotProduct([]);
    return p.weeks.length === 0 && p.retailers.length === 0 && p.name === "";
  })(),
);
check(
  "pivotProduct son stoğu FİRMANIN kendi son haftasından okur",
  (() => {
    // DR 2 haftalık veri gönderdi, Toyzz yalnız 1. hafta. Toyzz'un stoğu KAYBOLMAMALI.
    const p = pivotProduct([
      { ...fx("DR", "Kart", "1", 10, 0, 100), week_start: "2026-01-05" },
      { ...fx("DR", "Kart", "1", 10, 0, 90), week_start: "2026-01-12" },
      { ...fx("Toyzz", "Kart", "1", 5, 0, 40), week_start: "2026-01-05" },
    ]);
    const t = p.totals.find((x) => x.retailer === "Toyzz")!;
    const d = p.totals.find((x) => x.retailer === "DR")!;
    return t.last_stock === 40 && d.last_stock === 90;
  })(),
  JSON.stringify(
    pivotProduct([
      { ...fx("DR", "Kart", "1", 10, 0, 100), week_start: "2026-01-05" },
      { ...fx("DR", "Kart", "1", 10, 0, 90), week_start: "2026-01-12" },
      { ...fx("Toyzz", "Kart", "1", 5, 0, 40), week_start: "2026-01-05" },
    ]).totals,
  ),
);
check(
  "findStockoutRisks yavaş satanı riske sokmaz (hız < 3)",
  findStockoutRisks([fx("T", "Yavaş", null, 1, 0, 1)], "T", ["2026-01-12"])
    .length === 0,
);
// BÖLEN EN AZ 2: tek haftalık 100 adet → hız 50 (100/2), wos 1,0. Eski beklenti
// (hız 100, wos 0,5) pencere boyuna bölüyordu; tek haftalık veri raf yerleşimi
// etkisi taşır ve büyük karar için fazla incedir — routing.velOf, buildVelocityIndex
// ve reorderPriority ile AYNI taban. 1,0 hf < 2 olduğu için risk yine yakalanır.
check(
  "findStockoutRisks hızlı satan + az stoğu yakalar (bölen tabanı 2)",
  (() => {
    const r = findStockoutRisks([fx("T", "Hızlı", null, 100, 0, 50)], "T", [
      "2026-01-12",
    ]);
    return r.length === 1 && approx(r[0].wos, 1.0, 0.01) && r[0].sales === 50;
  })(),
);
check(
  "findStockoutRisks en fazla 2 satır döner",
  (() => {
    const rows = Array.from({ length: 5 }, (_, i) =>
      fx("T", `SKU${i}`, null, 100, 0, 10 + i),
    );
    return findStockoutRisks(rows, "T", ["2026-01-12"]).length === 2;
  })(),
);
check(
  "globalRankings boş giriş boş",
  (() => {
    const r = globalRankings([], new Map(), "qty");
    return (
      r.top.length === 0 && r.risers.length === 0 && r.fallers.length === 0
    );
  })(),
);

// ═════════ KANAL EKRANI (lib/kanal.ts) ═════════
// Bu blok firma sekmelerinin tablosunu besleyen saf hesapları sınıyor. Üçü
// gerçek bir hatayı kilitliyor: (a) payda 0 iken yüzde ∞ olmamalı, (b) hız
// paydası PENCERE BOYU değil ürünün rafta olduğu hafta sayısıdır, (c) PSF
// zinciri firmadan firmaya değişen fiyat kaynağını doğru sırayla denemelidir.
check(
  "slug ↔ firma çift yönlü ve Türkçe karakter taşımıyor",
  (() => {
    for (const r of KANALLAR) {
      const sl = slugOf(r);
      if (!/^[a-z]+$/.test(sl)) return false; // URL'de ğ/ı/& olmamalı
      if (retailerFromSlug(sl) !== r) return false; // geri dönüş aynı firma
    }
    return (
      retailerFromSlug("armagan") === "Armağan" &&
      retailerFromSlug("yok") === null
    );
  })(),
);
check(
  "slug büyük/küçük harf duyarsız çözülür",
  retailerFromSlug("TOYZZ") === "Toyzz",
);
check(
  "kanalAdi DR'yi D&R gösterir, diğerlerini değiştirmez",
  kanalAdi("DR") === "D&R" && kanalAdi("Toyzz") === "Toyzz",
);

// PAYDA 0 → ORAN YOK. Eski bir hata kalıbı: 0'dan 428'e çıkışı "+Infinity%"
// yazmak. Oran tanımsızdır; ekran "—" göstermeli.
check(
  "degisimYuzde: geçen hafta 0 ise oran null (∞ değil)",
  degisimYuzde(428, 0) === null,
);
check(
  "degisimYuzde: 49 → 428 ≈ %773",
  Math.round(degisimYuzde(428, 49)!) === 773,
);
check(
  "degisimYuzde: düşüşte negatif",
  Math.round(degisimYuzde(47, 82)!) === -43,
);

// HIZ PAYDASI: ürün pencerenin tamamında rafta DEĞİLSE, olmadığı haftalar
// paydaya girmez. Girseydi yeni ürünün hızı yapay düşer, kapsamı şişerdi.
check(
  "hizHesapla: payda rafta olduğu hafta sayısı (pencere boyu değil)",
  (() => {
    const W = ["w1", "w2", "w3", "w4"];
    const seri = {
      w3: { qty: 30, value: null, stock: 0 },
      w4: { qty: 30, value: null, stock: 0 },
    };
    return hizHesapla(seri, W, 4) === 30; // 60/2 = 30; 60/4 = 15 OLMAMALI
  })(),
);
check(
  "hizHesapla: yalnız son N hafta sayılır",
  (() => {
    const W = ["w1", "w2", "w3", "w4", "w5"];
    const seri: any = {};
    for (const w of W) seri[w] = { qty: 100, value: null, stock: 0 };
    seri.w1 = { qty: 9999, value: null, stock: 0 }; // pencere dışı, etkilememeli
    return hizHesapla(seri, W, 4) === 100;
  })(),
);
check("hizHesapla: hiç kayıt yoksa 0", hizHesapla({}, ["w1", "w2"], 4) === 0);
check(
  "hizHesapla: Pokémon gerçek serisi (116/46/49/428) → 159,8",
  (() => {
    const W = ["a", "b", "c", "d"];
    const q = [116, 46, 49, 428];
    const seri: any = {};
    W.forEach((w, i) => {
      seri[w] = { qty: q[i], value: null, stock: 0 };
    });
    return hizHesapla(seri, W, 4) === 159.8;
  })(),
);

check("kapsamHesapla: stok ÷ hız", kapsamHesapla(7230, 159.8) === 45.2);
check(
  "kapsamHesapla: hız 0 iken null (sonsuz değil)",
  kapsamHesapla(500, 0) === null,
);

// PSF ZİNCİRİ — ölçülen gerçek durum: Toyzz/Armağan raporda, Huppaluppo yalnız
// ciroda, D&R'nin bir kısmı ancak barkodlu fiyat listesinde.
check(
  "psfSec: firmanın raporu her şeyin önünde",
  (() => {
    const r = psfSec(
      549.99,
      { w1: { qty: 10, value: 1000, stock: 0 } },
      ["w1"],
      77,
    );
    return r.psf === 549.99 && r.kaynak === "rapor";
  })(),
);
check(
  "psfSec: rapor yoksa birim fiyat cirodan (EN YENİ satışlı hafta)",
  (() => {
    const seri = {
      w1: { qty: 10, value: 1000, stock: 0 },
      w2: { qty: 4, value: 800, stock: 0 },
    };
    const r = psfSec(null, seri, ["w1", "w2"], 77);
    return r.psf === 200 && r.kaynak === "ciro"; // 800/4, eski haftadaki 100 değil
  })(),
);
check(
  "psfSec: ciro da yoksa barkodlu fiyat listesi",
  (() => {
    const r = psfSec(
      null,
      { w1: { qty: 0, value: null, stock: 5 } },
      ["w1"],
      77,
    );
    return r.psf === 77 && r.kaynak === "fiyat-listesi";
  })(),
);
check(
  "psfSec: hiçbiri yoksa null — 0 UYDURULMAZ",
  (() => {
    const r = psfSec(
      null,
      { w1: { qty: 0, value: null, stock: 5 } },
      ["w1"],
      null,
    );
    return r.psf === null && r.kaynak === null;
  })(),
);
check(
  "psfSec: kayan nokta artığı 2 haneye sabitlenir (2549.9900000000002)",
  psfSec(2549.9900000000002, {}, [], null).psf === 2549.99,
);

// SATIR KURULUMU — Pokémon'un gerçek rakamlarıyla uçtan uca.
check(
  "skuSatiri: Pokémon satırı gerçek veriyle birebir",
  (() => {
    const W = ["2026-08-17", "2026-08-24", "2026-08-31", "2026-09-07"];
    const q = [116, 46, 49, 428];
    const seri: any = {};
    W.forEach((w, i) => {
      seri[w] = {
        qty: q[i],
        value: q[i] * 549.99,
        stock: i === 3 ? 7230 : 611,
      };
    });
    const s = skuSatiri("POKEMON", null, seri, W, 549.99, null, 0.5 / 1.2, 4);
    return (
      s.qty === 428 &&
      s.prevQty === 49 &&
      s.psf === 549.99 &&
      Math.round(s.brut!) === 235396 &&
      Math.round(s.net!) === 98082 &&
      s.hiz === 159.8 &&
      s.kapsam === 45.2 &&
      s.satanHafta === 4
    );
  })(),
);
check(
  "skuSatiri: firmanın bildirdiği ciro varsa PSF×adet'e TERCİH edilir",
  (() => {
    // Gerçek durum: Huppaluppo cirosu dosyadan gelir, PSF yoktur. Ciro 1117,5 iken
    // türetilmiş PSF (124,17) × 9 = 1117,53 ≠ 1117,5 — bildirilen rakam kazanmalı.
    const seri = { w1: { qty: 9, value: 1117.5, stock: 654 } };
    const s = skuSatiri("HUPPA", "868", seri, ["w1"], null, null, 0.5 / 1.2, 4);
    return s.brut === 1117.5 && s.psfKaynak === "ciro";
  })(),
);
check(
  "skuSatiri: tek haftalık geçmişte geçen hafta 0, oran null",
  (() => {
    const s = skuSatiri(
      "X",
      null,
      { w1: { qty: 5, value: 100, stock: 2 } },
      ["w1"],
      20,
      null,
      0.5,
      4,
    );
    return s.prevQty === 0 && s.degisim === null;
  })(),
);
check(
  "skuSatiri: katalogdan çıkmış ürün son haftada 0 adet/0 stok gösterir",
  (() => {
    const W = ["w1", "w2"];
    const s = skuSatiri(
      "ESKI",
      null,
      { w1: { qty: 40, value: 400, stock: 10 } },
      W,
      10,
      null,
      0.5,
      4,
    );
    return (
      s.qty === 0 && s.stock === 0 && s.ilkHafta === "w1" && s.satanHafta === 1
    );
  })(),
);
check(
  "skuSatiri: PSF yoksa brüt de net de null (0 yazılmaz)",
  (() => {
    const s = skuSatiri(
      "X",
      null,
      { w1: { qty: 0, value: null, stock: 9 } },
      ["w1"],
      null,
      null,
      0.5,
      4,
    );
    return s.brut === null && s.net === null;
  })(),
);
check(
  "skuSatiri: net = brüt × çarpan, ikinci kez uygulanmaz",
  (() => {
    const s = skuSatiri(
      "X",
      null,
      { w1: { qty: 10, value: 1000, stock: 0 } },
      ["w1"],
      100,
      null,
      netFactor("Toyzz"),
      4,
    );
    return (
      s.brut === 1000 && Math.abs(s.net! - 1000 * netFactor("Toyzz")) < 0.01
    );
  })(),
);

// ═════════ "güncel" ETİKETİ (lib/format.ts) ═════════
// Tek kuralı var ve sınırı keskin: YALNIZ takvim haftasına eşit hafta "güncel"
// yazılır. 1 hafta geride olan kanal bayat sayılmaz (eşik 2 hafta) ama güncel de
// değildir; ona "güncel" demek veri yaşı dürüstlüğünü tam da düzeltilen yerden
// bozar. Bu blok o sınırı kilitliyor.
{
  const T = "2026-09-07";
  check(
    'fmtHafta: takvim haftası "güncel" yazar',
    fmtHafta("2026-09-07", T) === "güncel",
  );
  check(
    "fmtHafta: 1 hafta geride ASLA güncel değil, tarih basar",
    fmtHafta("2026-08-31", T) === fmtDate("2026-08-31") &&
      fmtHafta("2026-08-31", T) !== "güncel",
  );
  check(
    "fmtHafta: 5 hafta geride tarih basar",
    fmtHafta("2026-08-03", T) === fmtDate("2026-08-03"),
  );
  // Takvim haftası bilinmiyorsa bilinmeyeni güncel saymak yok.
  check(
    "fmtHafta: takvim haftası yoksa tarih basar",
    fmtHafta("2026-09-07", null) === fmtDate("2026-09-07") &&
      fmtHafta("2026-09-07", undefined) === fmtDate("2026-09-07"),
  );
  check("fmtHafta: hafta yoksa em-dash", fmtHafta(null, T) === "—");
  // Gelecek bir hafta (veri takvimden ileri) da güncel sayılmaz — eşitlik aranır.
  check(
    "fmtHafta: takvimden ileri hafta güncel sayılmaz",
    fmtHafta("2026-09-14", T) !== "güncel",
  );
}

// ═════════ KANAL ŞERİDİ (ana sayfa, lib/kanal.ts) ═════════
// Ana sayfada grafiğin üstündeki beş kartın hesabı. Buradaki testler tek tek
// gerçek bir yanlış okumayı kilitliyor — hepsi canlı veride gözlenmiş kalıplar.
{
  const S: OzetHafta[] = [
    // Toyzz: ardışık iki hafta, ikisinde de ciro var.
    {
      retailer: "Toyzz",
      week_start: "2026-08-31",
      sales_qty: 100,
      sales_value: 1000,
      stock_qty: 500,
    },
    {
      retailer: "Toyzz",
      week_start: "2026-09-07",
      sales_qty: 120,
      sales_value: 1500,
      stock_qty: 480,
    },
    // Nezih: 5 hafta geride ve iki raporu ARDIŞIK DEĞİL (20 Tem → 03 Ağu).
    {
      retailer: "Nezih",
      week_start: "2026-07-20",
      sales_qty: 50,
      sales_value: 400,
      stock_qty: 300,
    },
    {
      retailer: "Nezih",
      week_start: "2026-08-03",
      sales_qty: 40,
      sales_value: 500,
      stock_qty: 326,
    },
    // Armağan: geçen hafta 0 adet sattı → yüzde tanımsız olmalı.
    {
      retailer: "Armağan",
      week_start: "2026-08-31",
      sales_qty: 0,
      sales_value: 0,
      stock_qty: 90,
    },
    {
      retailer: "Armağan",
      week_start: "2026-09-07",
      sales_qty: 30,
      sales_value: 300,
      stock_qty: 60,
    },
    // Huppaluppo: tek hafta → kıyas hiç yok.
    {
      retailer: "Huppaluppo",
      week_start: "2026-09-07",
      sales_qty: 10,
      sales_value: 100,
      stock_qty: 20,
    },
  ];
  const HAFTA = "2026-09-07";
  const t = kanalOzeti(S, "Toyzz", HAFTA, HAFTA);
  check(
    "kanalOzeti: güncel kanal GÜNCEL sayılır",
    t.guncel === true && t.gecikmeHf === 0,
  );
  check("kanalOzeti: ardışık iki raporda araHafta 1", t.araHafta === 1);
  check(
    "kanalOzeti: TL WoW kanalın kendi iki haftasından",
    Math.round(t.netWow!) === 50,
  );
  check(
    "kanalOzeti: adet WoW kanalın kendi iki haftasından",
    Math.round(t.adetWow!) === 20,
  );
  check("kanalOzeti: ardışık iki hafta ardisik=true", t.ardisik === true);

  const n = kanalOzeti(S, "Nezih", HAFTA, HAFTA);
  // ASIL KURAL: 5 hafta geride kalan kanal GÜNCEL DEĞİL. Ekran bu bayrağa
  // bakarak yüzdeyi yeşil/kırmızı basmaz — yorum üretmeden rakamı gösterir.
  check(
    "kanalOzeti: 5 hafta geride kalan kanal güncel DEĞİL",
    n.guncel === false && n.gecikmeHf === 5 && n.dataWeek === "2026-08-03",
  );
  // İki rapor arası 2 hafta: ekranda "geçen hafta" demek yalan olurdu.
  check(
    "kanalOzeti: ardışık olmayan iki rapor ardisik=false",
    n.ardisik === false,
  );
  // Mesafe ekranda "2 hafta öncesine göre" diye yazılıyor; bayrak değil SAYI lazım.
  check("kanalOzeti: 20 Tem → 03 Ağu arası 2 hafta", n.araHafta === 2);
  check("kanalOzeti: 5 hafta geride kanal BAYAT", n.bayat === true);
  check(
    "kanalOzeti: bayat kanalın rakamı yine de hesaplanır (gizlenmez)",
    n.adet === 40 && n.net === 500 && Math.round(n.netWow!) === 25,
  );

  const a = kanalOzeti(S, "Armağan", HAFTA, HAFTA);
  check("kanalOzeti: payda 0 iken adet WoW null (∞ değil)", a.adetWow === null);
  check("kanalOzeti: payda 0 iken TL WoW null", a.netWow === null);

  // GÜNCEL ≠ BAYAT DEĞİL. 1 hafta geride olan kanal bayat sayılmaz (yüzdesi hâlâ
  // yorumlanabilir) ama GÜNCEL DE DEĞİLDİR ve tarihini göstermek zorundadır.
  // Bu ayrım tek bayrağa bindirildiğinde ekran 31 Ağustos verisine "GÜNCEL"
  // yazıyordu; denetimde yakalandı.
  {
    const birHafta: OzetHafta[] = [
      {
        retailer: "Toyzz",
        week_start: "2026-08-24",
        sales_qty: 10,
        sales_value: 100,
        stock_qty: 5,
      },
      {
        retailer: "Toyzz",
        week_start: "2026-08-31",
        sales_qty: 20,
        sales_value: 200,
        stock_qty: 4,
      },
    ];
    const g = kanalOzeti(birHafta, "Toyzz", HAFTA, HAFTA);
    check(
      "kanalOzeti: 1 hafta geride kanal GÜNCEL DEĞİL",
      g.gecikmeHf === 1 && g.guncel === false,
    );
    check("kanalOzeti: 1 hafta geride kanal BAYAT da değil", g.bayat === false);
  }

  const h = kanalOzeti(S, "Huppaluppo", HAFTA, HAFTA);
  check(
    "kanalOzeti: tek haftalık kanalda kıyas yok",
    h.prevWeek === null &&
      h.netWow === null &&
      h.adetWow === null &&
      h.araHafta === null,
  );

  const y = kanalOzeti(S, "DR", HAFTA, HAFTA);
  check(
    "kanalOzeti: hiç satırı olmayan kanal VERİ YOK (gecikme 99)",
    y.dataWeek === null &&
      y.gecikmeHf === 99 &&
      y.guncel === false &&
      y.bayat === true,
  );

  // GEÇMİŞ HAFTA SEÇİLDİĞİNDE: sınır 31 Ağustos. Toyzz'un 7 Eylül satırı
  // GÖRÜNMEMELİ, yoksa geçmişe bakan kullanıcıya gelecekteki rakam basılır.
  const gec = kanalOzeti(S, "Toyzz", "2026-08-31", "2026-08-31");
  check(
    "kanalOzeti: seçili haftadan SONRAKİ veri sızmaz",
    gec.dataWeek === "2026-08-31" && gec.adet === 100 && gec.guncel === true,
  );
  // Aynı sınırda Nezih o tarihe göre 4 hafta geride olmalı (5 değil).
  const gecN = kanalOzeti(S, "Nezih", "2026-08-31", "2026-08-31");
  check(
    "kanalOzeti: gecikme referans haftaya göre ölçülür",
    gecN.gecikmeHf === 4,
  );
}

// ═════════ İKİ HAFTA ÇAPASI AYNI OLMALI (denetim bulgusu) ═════════
// weekFromToday() dosya adından hafta çıkmazsa devreye giren SON ÇARE; yüklenen
// dosya onun söylediği haftaya YAZILIR ve yazma DELETE+INSERT'tür. Bu yüzden
// sonTamamlanmisHafta ile AYNI haftayı vermek zorunda: ayrışırsa tarihsiz bir
// dosya bir hafta öncesine yazılır ve o haftanın gerçek verisini siler.
// Eski hata: biri yerel getter'larla (getDay/getDate), diğeri UTC+3 ile
// çalışıyordu; TZ=Europe/Istanbul'da 00:00-03:00 arası iki farklı hafta.
{
  const wft = weekFromToday();
  check(
    "weekFromToday, sonTamamlanmisHafta ile aynı haftayı verir",
    wft.start === sonTamamlanmisHafta(new Date()),
    `${wft.start} ↔ ${sonTamamlanmisHafta(new Date())}`,
  );
  check(
    "weekFromToday Pazartesi döner",
    new Date(wft.start + "T00:00:00Z").getUTCDay() === 1,
  );
  check(
    "weekFromToday aralığı 6 gün",
    Date.parse(wft.end + "T00:00:00Z") -
      Date.parse(wft.start + "T00:00:00Z") ===
      6 * 86400000,
  );
}

// ═════════ KANAL ADI KATLAMASI — BÜYÜK HARF TUZAĞI (denetim bulgusu) ═════════
// toLocaleLowerCase("tr") ASCII "I" harfini "ı"ya çeviriyordu: fold("NEZIH")
// "nezıh" oluyor, sözlükte karşılığı bulunamıyor, kanal TANIMSIZA düşüyor ve
// netFactor 0,8333 dönüyor — o kanalın net cirosu gerçeğin ~1,75 katı.
// Büyük harfli ad raporlarda ve elle yazılan filtrelerde olağan.
{
  const kanonik = ["Toyzz", "DR", "Nezih", "Armağan", "Huppaluppo"];
  for (const k of kanonik) {
    check(
      `netFactor("${k.toUpperCase()}") kanonikle aynı`,
      Math.abs(netFactor(k.toUpperCase()) - netFactor(k)) < 1e-12,
      `${netFactor(k.toUpperCase())} ↔ ${netFactor(k)}`,
    );
  }
  // Boşluk ve & toleransı da bozulmamalı.
  check(
    'netFactor("D&R") = netFactor("DR")',
    Math.abs(netFactor("D&R") - netFactor("DR")) < 1e-12,
  );
  check(
    'netFactor(" toyzz ") = netFactor("Toyzz")',
    Math.abs(netFactor(" toyzz ") - netFactor("Toyzz")) < 1e-12,
  );
  // ASIL KİLİT: "NEZIH" (ASCII I) tanımsıza düşmemeli.
  check(
    'netFactor("NEZIH") tanımsıza düşmüyor',
    netFactor("NEZIH") < 0.6,
    `${netFactor("NEZIH")}`,
  );
}

// ═════════════════════════ SEED KAPISI ═════════════════════════
// KARAR: seed/ yoksa suite SESSİZCE küçülmez — bariz bir başlıkla uyarır, atlanan
// test sayısını yazar ve çıkış kodunu 1 yapar. (Eski davranış: 23 teste düşüp
// "TÜM TESTLER GEÇTİ" + exit 0 → CI'da sessiz yeşil.)
// SEED_TEST_SAYISI aşağıda ÖLÇÜLÜP doğrulanır; sabit kayarsa test düşer.
// ═════════ VERİ YAŞI VE KANIT KAPISI ═════════
// Bu blok para kararı üreten kuralları test ediyor: bir kalemin indirimle yok
// edilip edilmeyeceğini ve bir firmanın kararlarının askıya alınıp alınmayacağını.
// Eşikler ELLE YAZILMAZ, compute.ts'ten import edilir.
section("VERİ YAŞI — takvim çapası");
{
  // 2026-09-07 Pazartesi → son TAMAMLANMIŞ hafta 31 Ağustos.
  check(
    "Pazartesi → önceki hafta başı",
    sonTamamlanmisHafta(new Date("2026-09-07T12:00:00Z")) === "2026-08-31",
    sonTamamlanmisHafta(new Date("2026-09-07T12:00:00Z")),
  );
  // Pazar (6 Eylül) hâlâ 24 Ağustos haftasını "son tamamlanmış" sayar.
  check(
    "Pazar → bir önceki hafta",
    sonTamamlanmisHafta(new Date("2026-09-06T12:00:00Z")) === "2026-08-24",
    sonTamamlanmisHafta(new Date("2026-09-06T12:00:00Z")),
  );
  // SAAT DİLİMİ KAPISI: sunucu UTC, İstanbul UTC+3. Pazartesi 00:30 yerel =
  // Pazar 21:30 UTC. Ofset olmadan fonksiyon bir hafta geriyi döndürüp TÜM
  // firmaların gecikmesini 3 saat boyunca +1 gösteriyordu.
  check(
    `Pazartesi 00:30 yerel (UTC+${TR_OFSET_SAAT}) → yeni hafta`,
    sonTamamlanmisHafta(new Date("2026-09-06T21:30:00Z")) === "2026-08-31",
    sonTamamlanmisHafta(new Date("2026-09-06T21:30:00Z")),
  );
  check(
    "Pazar 23:00 yerel → eski hafta",
    sonTamamlanmisHafta(new Date("2026-09-06T20:00:00Z")) === "2026-08-24",
    sonTamamlanmisHafta(new Date("2026-09-06T20:00:00Z")),
  );

  check("gecikme: veri yok → 99", gecikmeHaftasi(null, "2026-08-31") === 99);
  check(
    "gecikme: Nezih 4 hafta",
    gecikmeHaftasi("2026-08-03", "2026-08-31") === 4,
  );
  check(
    "gecikme: güncel → 0",
    gecikmeHaftasi("2026-08-31", "2026-08-31") === 0,
  );
  // Huppaluppo kapanan haftayı aynı Pazartesi sabahı yüklüyor; devam eden
  // haftayı yüklerse fark negatif çıkar ve kademe mantığı tanımsız davranırdı.
  check(
    "gecikme: gelecek hafta → 0 (negatif yok)",
    gecikmeHaftasi("2026-09-07", "2026-08-31") === 0,
  );

  // ── HİSTEREZİS (kararGecikmesi) ──
  // Gerçek seriler (weekly_summary, 2026-09-07 ölçümü).
  const T = "2026-08-31";
  const nezih = [
    "2026-07-06",
    "2026-07-13",
    "2026-07-20",
    "2026-07-27",
    "2026-08-03",
  ];
  const toyzz = ["2026-08-03", "2026-08-10", "2026-08-17", "2026-08-24"];
  const huppa = ["2026-08-10", "2026-08-17", "2026-08-24", "2026-08-31"];
  check(
    "karar gecikmesi = düz gecikme (Nezih 4)",
    kararGecikmesi(nezih, T) === 4,
    String(kararGecikmesi(nezih, T)),
  );
  check(
    "karar gecikmesi = düz gecikme (Toyzz 1)",
    kararGecikmesi(toyzz, T) === 1,
    String(kararGecikmesi(toyzz, T)),
  );
  check(
    "karar gecikmesi = düz gecikme (Huppaluppo 0)",
    kararGecikmesi(huppa, T) === 0,
    String(kararGecikmesi(huppa, T)),
  );
  // Nezih yalnız 17 Ağustos'u yüklerse DÜZ gecikme 2'ye iner (tasfiye yeniden
  // açılırdı); çapa kuralı 10 Ağustos boşluğunu gördüğü için gecikme 4 kalır.
  const nezihBoslukla = [...nezih, "2026-08-17"];
  check(
    "histerezis: boşluklu yükleme askıyı açmaz",
    gecikmeHaftasi("2026-08-17", T) === 2 &&
      kararGecikmesi(nezihBoslukla, T) === 4,
    `duz=${gecikmeHaftasi("2026-08-17", T)} karar=${kararGecikmesi(nezihBoslukla, T)}`,
  );
  // Boşluklar dolunca askı kapanır.
  check(
    "histerezis: boşluk dolunca askı kapanır",
    kararGecikmesi(
      [...nezih, "2026-08-10", "2026-08-17", "2026-08-24", "2026-08-31"],
      T,
    ) === 0,
  );
  // Tek haftalık geçmişi olan YENİ firma cezalandırılmaz (ardışık çift yok →
  // düz gecikmeye düşer).
  check(
    "yeni firma (tek hafta) → düz gecikme",
    kararGecikmesi(["2026-08-31"], T) === 0,
  );
  check("hiç veri yok → 99", kararGecikmesi([], T) === 99);

  // ── TAKVİM ÇAPASININ ASIL İŞİ ──
  // Beş firma da donsa AĞ tabanlı gecikme 0 kalır (hepsinin son haftası ağın son
  // haftasıdır) ve sağlık skoru düşmek yerine YÜKSELİR. Takvim çapasında gecikme
  // her hafta büyür.
  const donmus = "2026-08-24";
  const agTabanli = 0; // max(week) − week = 0, tanım gereği
  check(
    "takvim çapası: ağ donduğunda gecikme büyür",
    gecikmeHaftasi(donmus, "2026-08-31") === 1 &&
      gecikmeHaftasi(donmus, "2026-09-28") === 5 &&
      agTabanli === 0,
  );
}

section("YAŞLANDIRMA (erime)");
{
  check("gecikme 0 → drenaj 0", yaslandir(100, 10, 0).drenaj === 0);
  check(
    "drenaj = hız × gecikme",
    yaslandir(100, 10, 4).drenaj === 40 &&
      yaslandir(100, 10, 4).stokYaslandirilmis === 60,
  );
  check(
    "drenaj stoğu geçemez",
    yaslandir(30, 10, 4).drenaj === 30 &&
      yaslandir(30, 10, 4).stokYaslandirilmis === 0,
  );
  check(
    `ufuk GECIKME_KAPANMA (${GECIKME_KAPANMA}) ile sınırlı`,
    yaslandir(1000, 10, 99).drenaj === 10 * GECIKME_KAPANMA,
  );
  check(
    "negatif/bozuk girdi güvenli",
    yaslandir(-5, -1, -3).drenaj === 0 &&
      yaslandir(-5, -1, -3).stokYaslandirilmis === 0,
  );
}

section("KADEME (askı merdiveni)");
{
  const k = (g: number) => kademeOf(g);
  check(
    "gecikme 0 → rozet yok, her şey açık",
    !k(0).rozet && k(0).likidasyonAcik && k(0).cekAcik,
  );
  check(
    "gecikme 1 → rozet YOK (normal kadans)",
    !k(1).rozet && k(1).likidasyonAcik,
  );
  check(
    `gecikme ${GECIKME_ROZET} → rozet var, karar açık`,
    k(GECIKME_ROZET).rozet &&
      k(GECIKME_ROZET).likidasyonAcik &&
      k(GECIKME_ROZET).cekAcik,
  );
  check(
    `gecikme ${GECIKME_TASFIYE} → tasfiye askıda, çek açık`,
    !k(GECIKME_TASFIYE).likidasyonAcik && k(GECIKME_TASFIYE).cekAcik,
  );
  check(
    `gecikme ${GECIKME_CEK} → çek de askıda`,
    !k(GECIKME_CEK).likidasyonAcik && !k(GECIKME_CEK).cekAcik,
  );
  check(
    `gecikme ${GECIKME_KAPANMA} → "hesap kapandı mı" sorusu`,
    k(GECIKME_KAPANMA).kapanmaSorusu,
  );
  check(
    "eşikler artan sıralı",
    GECIKME_ROZET < GECIKME_TASFIYE &&
      GECIKME_TASFIYE < GECIKME_CEK &&
      GECIKME_CEK < GECIKME_KAPANMA,
  );
  check(
    "durum metinleri Türkçe, makine kodu yok",
    [0, 1, 2, 3, 6, 8, 99].every(
      (g) => !/^[YT]\d/.test(k(g).durum) && k(g).durum.length > 3,
    ),
  );
  // SEVK/TEYİT bu tabloda HİÇ YOK: hiçbir kademede bastırılmadıkları için
  // kademe nesnesinde onlara ait bir bayrak da olmamalı.
  check(
    "kademe nesnesinde SEVK/TEYİT bayrağı yok",
    !("sevkAcik" in k(9)) && !("teyitAcik" in k(9)),
  );
}

section("KANIT KAPISI (likidasyon)");
{
  // v < 1 → tüm raf (bugünkü davranış korunur).
  const tam = likidasyonKapisi(500, 0, null);
  check(
    "hız 0 → TAM likidasyon",
    tam.kapi === "tam" && tam.pull === 500 && tam.geriBirakilan === 0,
  );
  check(
    `hız ${LIKID_MIN_VEL} altı → TAM`,
    likidasyonKapisi(100, 0.9, 111).kapi === "tam",
  );
  // v ≥ 1 ve emme ufku içinde → ERİT (indirim yok, sermaye serbest kalmaz).
  const erit = likidasyonKapisi(100, 10, 10);
  check(
    `hız ≥ ${LIKID_MIN_VEL}, kapsam ≤ ${LIKID_ABSORB} → ERİT`,
    erit.kapi === "erit" && erit.pull === 0 && erit.geriBirakilan === 100,
  );
  check(
    `kapsam tam ${LIKID_ABSORB} → ERİT (sınır dahil)`,
    likidasyonKapisi(260, 10, LIKID_ABSORB).kapi === "erit",
  );
  // v ≥ 1 ve emme ufkunun ötesi → KISMİ: hız×26 rafta kalır.
  const kismi = likidasyonKapisi(1000, 10, 100);
  check(
    "kapsam > ufuk → KISMİ",
    kismi.kapi === "kismi" &&
      kismi.geriBirakilan === 10 * LIKID_ABSORB &&
      kismi.pull === 1000 - 10 * LIKID_ABSORB,
  );
  check(
    "KISMİ: pull + geriBirakilan = stok",
    kismi.pull + kismi.geriBirakilan === 1000,
  );
  // REZERV KAPISI: rezerve edilecek adet (hız×26) tüm rafı yiyorsa pull 0
  // çıkar ve satır motorun `pull > 0` süzgecinden sessizce düşerdi.
  // BU DAL ULAŞILABİLİR — önceki not "tutarlı girdide ulaşılamaz" diyordu ve
  // üretimde ölçüm bunu çürüttü (239 kapılı satırın 1'i buradan geçiyor).
  // Sebep hız (r1) ile kapsamın (Math.round) BAĞIMSIZ yuvarlanması.
  const sifir = likidasyonKapisi(20, 30, 27);
  check(
    "rezerv rafı yiyorsa → ERİT (satır kaybolmaz)",
    sifir.kapi === "erit" && sifir.pull === 0,
    `${sifir.kapi}/${sifir.pull}`,
  );
  // Tutarlı girdide küsuratlı hız KİSMİ verir ve en az 1 adet çekilir.
  check(
    "küsuratlı hız: KİSMİ, pull ≥ 1",
    likidasyonKapisi(40, 1.5, 27).kapi === "kismi" &&
      likidasyonKapisi(40, 1.5, 27).pull === 1,
  );
  // ÜRETİMDE ÖLÇÜLEN GERÇEK SATIR (Toyzz "ASP-MYT-KART FENERBAHÇE SEZON
  // KARTLARI 25Lİ METAL KUTU 24/25"): stok 60, yayınlanan hız 2,3, yayınlanan
  // kapsam 27. Kapsam 27 > 26 olduğu için emme dalı ateşlenmiyor; rezerv
  // ceil(2,3×26) = 60 = rafın tamamı → pull 0 → ERİT. Bu, iki bağımsız
  // yuvarlamanın arasindaki sınır bandı ve rezerv kapısının asıl işi.
  const sinir = likidasyonKapisi(60, 2.3, 27);
  check(
    "sınır bandı: rezerv rafı kaplıyorsa ERİT (üretimde ölçüldü)",
    sinir.kapi === "erit" && sinir.pull === 0 && sinir.geriBirakilan === 60,
    `${sinir.kapi}/${sinir.pull}/${sinir.geriBirakilan}`,
  );
  // Ölçülen gerçek kalem: Huppaluppo "Topps Match Attax 24/25 - Paket",
  // 98 adet, 53/hf, kapsam 2 hf — motor buna "tüm rafı likide et" diyordu.
  const olculen = likidasyonKapisi(98, 53, 2);
  check(
    "ölçülen kalem (98 ad, 53/hf) likide edilmez",
    olculen.kapi === "erit" && olculen.pull === 0,
  );
  // Ölçülen gerçek kalem: Toyzz "ÇIKARTMA ALBÜMÜ GS ŞAMPİYON KADRO",
  // 662 adet, 25,8/hf, kapsam 26 hf → emme ufku sınırında, erit.
  check(
    "ölçülen kalem (662 ad, 25,8/hf, 26 hf) likide edilmez",
    likidasyonKapisi(662, 25.8, 26).kapi === "erit",
  );
  check("stok 0 → TAM ve pull 0", likidasyonKapisi(0, 0, null).pull === 0);
}

// ── TOYZZ BARKODU (sentetik) ──
// Toyzz 21-27 Eylül 2026'dan itibaren Kalem raporunda "Barkod" kolonu gönderiyor.
// Dosyalar bellekte kurulur: gerçek Eylül dosyası seed/toyzz'a KONMAZ (seed'e
// bağlı executive özet testleri o haftayı görünce düşer).
section("TOYZZ BARKODU (normalizer + Kalem Kodu geri işleme, sentetik)");
{
  const xlsxBuf = (aoa: unknown[][]): ArrayBuffer => {
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa), "Sayfa1");
    return XLSX.write(wb, { type: "array", bookType: "xlsx" }) as ArrayBuffer;
  };
  const FN = "21-27 Eylül-Asepto.xlsx";
  const H8 = [
    "Tedarikçi Adı",
    "Kalem Kodu",
    "Kalem Tanımı",
    "Barkod",
    "Tedarikçi Ürün Kodu",
    "PSF",
    "Toplam Stok Adedi",
    "Toplam Satış Adedi",
  ];
  const H7 = [
    "Tedarikçi Adı",
    "Kalem Kodu",
    "Kalem Tanımı",
    "Tedarikçi Ürün Kodu",
    "Psf",
    "Toplam Stok Adedi",
    "Toplam Satış Adedi",
  ];
  const T = "TOYPA";

  const r1 = normalizeFile(
    xlsxBuf([
      H8,
      [
        T,
        "T01001561",
        "ASP-MYT-KART GALATASARAY PRE-SEASON 26/27 (GS) 24D.",
        "8685185015616",
        "X1",
        159.99,
        100,
        5,
      ],
      [
        T,
        "T04001548",
        "ASP-KART POKEMON MYSTERY PACK 10LU (PKMN) 24D.",
        "8685185015487",
        "X2",
        549.99,
        50,
        0,
      ],
    ]),
    "Toyzz",
    FN,
  );
  check(
    "barkodlu Toyzz: barkod 13 haneli metin olarak okunur",
    r1.length === 2 &&
      r1.every(
        (x) => typeof x.barkod === "string" && /^\d{13}$/.test(x.barkod),
      ),
    JSON.stringify(r1.map((x) => x.barkod)),
  );
  check(
    "barkodlu Toyzz: sku_id = Kalem Kodu, barkod satırına bağlı",
    r1[0].sku_id === "T01001561" && r1[0].barkod === "8685185015616",
  );
  check(
    "barkodlu Toyzz: ciro PSF × adet korunur",
    Math.abs(Number(r1[0].sales_value) - 159.99 * 5) < 0.01 &&
      r1[1].sales_value === 0,
  );
  check(
    "barkodlu Toyzz: sağlık kontrolü barkodlu satırları sayar",
    checkRowHealth(r1).withBarkod === 2,
  );

  for (const psf of ["Psf", "PSF"]) {
    const h = H7.map((c) => (c === "Psf" ? psf : c));
    const r = normalizeFile(
      xlsxBuf([
        h,
        [T, "T1", "Kart A", "X", 10, 5, 1],
        [T, "T2", "Kart B", "Y", 20, 5, 0],
      ]),
      "Toyzz",
      FN,
    );
    check(
      `7 kolonlu eski Toyzz dosyası (${psf}) → barkod null (davranış değişmedi)`,
      r.length === 2 && r.every((x) => x.barkod === null),
    );
  }

  const r3 = normalizeFile(
    xlsxBuf([H8, [T, "T02020859", "Kart N", 8681842208599, "X", 10, 5, 1]]),
    "Toyzz",
    FN,
  );
  check(
    "sayı tipli barkod hücresi → '8681842208599' (13 hane, kayıpsız)",
    r3[0].barkod === "8681842208599",
    JSON.stringify(r3[0].barkod),
  );

  const kotu: unknown[] = [
    null,
    "",
    "   ",
    "abc",
    "12345",
    "8681842208599X",
    "000000",
    "0000000000000",
  ];
  const r4 = normalizeFile(
    xlsxBuf([
      H8,
      ...kotu.map((b, i) => [T, "K" + i, "Kart " + i, b, "X", 10, 5, 1]),
    ]),
    "Toyzz",
    FN,
  );
  check(
    "boş/geçersiz barkod → null, asla boş metin",
    r4.length === kotu.length && r4.slice(0, 6).every((x) => x.barkod === null),
    JSON.stringify(r4.map((x) => x.barkod)),
  );
  check(
    "tümü sıfır barkod yer tutucudur → null",
    r4[6].barkod === null && r4[7].barkod === null,
  );

  const r5 = normalizeFile(
    xlsxBuf([H8, [T, "K", "Kart", "8681842208599.0", "X", 10, 5, 1]]),
    "Toyzz",
    FN,
  );
  check("'…8599.0' metni → '…8599'", r5[0].barkod === "8681842208599");

  const destek =
    "ASP-TPS-KART DESTEK PAKETİ ŞAMPİYONLAR LİGİ 22/23 MATCH ATTAX 30LU (UEFA)";
  const r6 = normalizeFile(
    xlsxBuf([
      H8,
      [T, "T03006133", destek, "5053307061347", "X", 159.99, 1, 0],
      [T, "T03005788", destek, "5053307057883", "X", 119.99, 0, 0],
    ]),
    "Toyzz",
    FN,
  );
  check(
    "aynı ad, iki Kalem Kodu → iki satır, iki ayrı barkod",
    r6.length === 2 && new Set(r6.map((x) => x.barkod)).size === 2,
  );

  const r7 = normalizeFile(
    xlsxBuf([
      H8.map((c) => (c === "Barkod" ? "BARKOD" : c)),
      [T, "K", "Kart", "8681842208599", "X", 10, 5, 1],
    ]),
    "Toyzz",
    FN,
  );
  check(
    "'BARKOD' başlığı da okunur (PSF gibi harf duyarsız)",
    r7[0].barkod === "8681842208599",
  );

  const r8 = normalizeFile(
    xlsxBuf([
      H8,
      [T, "K", "Kart", "8681842208599", "X", 10, 5, 1],
      [null, null, null, null, null, null, 5, 1],
      [T, "Genel Toplam", "", "", "", null, 5, 1],
    ]),
    "Toyzz",
    FN,
  );
  check(
    "barkod kolonu varken de toplam satırı elenir",
    r8.length === 1,
    String(r8.length),
  );

  const r9 = normalizeFile(
    xlsxBuf([H8, [T, "K", "Kart", "8681842208599", "X", 12.5, 5, 2]]),
    "Toyzz",
    FN,
  );
  check(
    "8 kolonlu dosya Kalem dalına düşer (price=PSF, sku_id=Kalem Kodu, mağaza yok)",
    r9[0].price === 12.5 && r9[0].sku_id === "K" && r9[0].store === null,
  );

  // PSF kolonu kaybolursa: barkod var diye eski kapı açılmaz, ama fiyatı kendi
  // dosyasında taşıyan firma için ayrı uyarı çıkar (ciro başka kanal ölçeğinden dolar).
  const r10 = normalizeFile(
    xlsxBuf([
      H8.filter((c) => c !== "PSF"),
      [T, "K", "Kart", "8681842208599", "X", 5, 3],
    ]),
    "Toyzz",
    FN,
  );
  const w10 = checkRowHealth(r10).warnings;
  check(
    "PSF kaybolan barkodlu Toyzz dosyası sessiz geçmez (fiyat dosyada uyarısı)",
    w10.some((x) => /fiyatı kendi dosyasında taşır/.test(x)) &&
      !w10.some((x) => /barkod da yok/.test(x)),
    JSON.stringify(w10),
  );

  // Hafta arası anahtar tutarlılığı: çelişen alias + yalnız yeni haftada barkod = bölünme.
  const fx = (w: string, bc: string | null) =>
    ({
      retailer: "Toyzz",
      week_start: w,
      store: null,
      sku_name: "Kart X",
      barkod: bc,
      sales_qty: 10,
      sales_value: 0,
      stock_qty: 1,
    }) as any;
  const aliasBad = new Map([["Toyzz|Kart X", "8680000000999"]]);
  check(
    "çelişen alias + yalnız yeni hafta barkodlu → anahtar haftalar arasında bölünür",
    productKey("Toyzz", "Kart X", null, aliasBad) !==
      productKey("Toyzz", "Kart X", "8680000000001", aliasBad),
  );
  const bolunmus = comparePeriods(
    [fx("2026-09-14", null)],
    [fx("2026-09-21", "8680000000001")],
    aliasBad,
  );
  check(
    "bölünme comparePeriods'ta 'yeni' + 'kaybolan' olarak görünür",
    bolunmus.newSkus.length === 1 && bolunmus.lostSkus.length === 1,
  );
  const kapali = comparePeriods(
    [fx("2026-09-14", "8680000000001")],
    [fx("2026-09-21", "8680000000001")],
    aliasBad,
  );
  check(
    "geçmiş satıra barkod işlenince bölünme kapanır",
    kapali.newSkus.length === 0 && kapali.lostSkus.length === 0,
  );

  // toyzzBarkodIsle — eski barkodsuz haftayı yeniden yüklerken Kalem Kodu + ad ile geri işleme.
  const harita = new Map([
    ["T01|Kart A", "8680000000011"],
    ["T02|LABUBU 6LI", "8680000000022"],
  ]);
  const satir = (
    retailer: string,
    sku_id: string | null,
    sku_name: string,
    barkod: string | null,
  ) =>
    ({
      retailer,
      week_start: "2026-03-02",
      week_end: "2026-03-08",
      store: null,
      sku_name,
      sku_id,
      barkod,
      price: 10,
      sales_qty: 1,
      sales_value: 10,
      stock_qty: 5,
      source_file: "x",
    }) as any;
  const geri = [
    satir("Toyzz", "T01", "Kart A", null), // doldurulur
    satir("Toyzz", "T02", "SEVİMLİ CANAVAR 7Lİ", null), // eski ad → AD KORUMASI, doldurulmaz
    satir("Toyzz", "T01", "Kart A", "8689999999999"), // dosya barkodu asla ezilmez
    satir("DR", "T01", "Kart A", null), // yalnız Toyzz
    satir("Toyzz", null, "Kart A", null), // sku_id yoksa dokunmaz
  ];
  const n = toyzzBarkodIsle(geri, harita);
  check(
    "geri işleme: yalnız Toyzz + boş barkod + Kalem Kodu&ad eşleşen satır dolar (1 satır)",
    n === 1 && geri[0].barkod === "8680000000011",
    String(n),
  );
  check(
    "geri işleme: aynı Kalem Kodu'nun eski adı barkod almaz (kapalı kalem korunur)",
    geri[1].barkod === null,
  );
  check(
    "geri işleme: dosyanın kendi barkodu ezilmez",
    geri[2].barkod === "8689999999999",
  );
  check(
    "geri işleme: başka firmaya ve sku_id'siz satıra dokunulmaz",
    geri[3].barkod === null && geri[4].barkod === null,
  );
}

// ── NEZİH EYLÜL 2026 FORMATI (sentetik) ──
// "Stok / Satış / Kalan Stok": Stok = AÇILIŞ, Kalan Stok = KAPANIŞ. Dosya adı
// "21-27.09.2026 stok raporu.xlsx" (gün aralığı + tek sayısal ay + yıl).
section("NEZİH EYLÜL 2026 FORMATI (Kalan Stok + '21-27.09.2026' adı)");
{
  const xb = (aoa: unknown[][]): ArrayBuffer => {
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(
      wb,
      XLSX.utils.aoa_to_sheet(aoa),
      "raporStokGCEkBilgiBarkodluTutar",
    );
    return XLSX.write(wb, { type: "array", bookType: "xlsx" }) as ArrayBuffer;
  };
  const yeni = normalizeFile(
    xb([
      ["Barkod", "Ürün Adı", "Stok", "Satış", "Kalan Stok"],
      [8684824388401, "Mythos  Pulls Galatasaray", 670, 30, 640],
      [
        8684824388272,
        "Mythos  Galatasaray Pre-Season Kart 2025/26",
        757,
        10,
        747,
      ],
    ]),
    "Nezih",
    "21-27.09.2026 stok raporu.xlsx",
  );
  check(
    "Nezih yeni format: stok = Kalan Stok (kapanış), açılış değil",
    yeni[0].stock_qty === 640 && yeni[1].stock_qty === 747,
    JSON.stringify(yeni.map((r) => r.stock_qty)),
  );
  check(
    "Nezih yeni format: satış korunur, barkod sayı hücresinden 13 hane",
    yeni[0].sales_qty === 30 && yeni[0].barkod === "8684824388401",
  );
  // 2-8 Kasım 2026: ilk satır rapor adı + tarih, başlıklar ikinci satırda
  // (StkID / Barkod / Ürün Adı / Satış / Stok), sonda TOPLAMLAR, eksi stok var.
  const kasim = normalizeFile(
    xb([
      ["Stok Raporu", "2.11.2026-8.11.2026", null, null, null],
      ["StkID", "Barkod", "Ürün Adı", "Satış", "Stok"],
      [436010, 8684824388425, "Mythos  Pulls Fenerbahçe", 40, 634],
      [384053, 5053307060272, "Topps  UEFA Şampiyonlar Ligi Sticker 22/23 - Update Kutusu", 0, 1],
      [406099, 8684824388999, "Mythos Trabzonspor Moments (Tek Kart)", 0, -11],
      ["", "", "TOPLAMLAR", 40, 624],
    ]),
    "Nezih",
    "ASEPTO 02.08 11 2026 SATIŞ STOK.xlsx",
    { start: "2026-11-02", end: "2026-11-08" },
  );
  check(
    "Nezih Kasım 2026: başlık 2. satırda bulunur, TOPLAMLAR atlanır, Stok = kapanış",
    kasim.length === 3 &&
      kasim[0].barkod === "8684824388425" &&
      kasim[0].sales_qty === 40 &&
      kasim[0].stock_qty === 634 &&
      kasim[1].sales_qty === 0 &&
      kasim[0].week_start === "2026-11-02",
    JSON.stringify(kasim.map((r) => [r.barkod, r.sales_qty, r.stock_qty])),
  );
  check(
    "Nezih yeni format: hafta dosya adından 2026-09-21 → 2026-09-27",
    yeni[0].week_start === "2026-09-21" && yeni[0].week_end === "2026-09-27",
    yeni[0].week_start + "→" + yeni[0].week_end,
  );
  const eski = normalizeFile(
    xb([
      ["Barkod", "Ürün Adı", "Önceki", "Satış", "Stok"],
      [8684824388401, "Mythos Pulls Galatasaray", 700, 30, 670],
    ]),
    "Nezih",
    "raporStokGCEkBilgiBarkodluTutar.xlsx",
    { start: "2026-09-14", end: "2026-09-20" },
  );
  check(
    "Nezih eski format (Önceki/Satış/Stok): stok = Stok (davranış değişmedi)",
    eski[0].stock_qty === 670,
    String(eski[0].stock_qty),
  );

  const w1 = parseWeekFromFilename("21-27.09.2026 stok raporu.xlsx");
  check(
    "'21-27.09.2026' → 2026-09-21..27",
    w1?.start === "2026-09-21" && w1?.end === "2026-09-27",
    JSON.stringify(w1),
  );
  const w2 = parseWeekFromFilename("Nezih 30.03-05.04.xlsx");
  check(
    "eski iki-tarihli biçim önce eşleşir (30.03-05.04 → 03-30..04-05)",
    w2?.start?.endsWith("-03-30") === true &&
      w2?.end?.endsWith("-04-05") === true,
    JSON.stringify(w2),
  );
  check(
    "ay geçişi tek-ay biçiminde yazılamaz → null (sessiz yanlış hafta yok)",
    parseWeekFromFilename("28-04.10.2026 rapor.xlsx") === null,
  );
  check(
    "geçersiz ay → null",
    parseWeekFromFilename("21-27.13.2026.xlsx") === null,
  );
  check(
    "geçersiz iki-tarihli adın içinden tek-ay parçası yakalanmaz (31.04-06.05 → null)",
    parseWeekFromFilename("31.04-06.05.xlsx") === null,
  );
  for (const ad of [
    "rapor 2-3.1.xlsx",
    "v2-3.1.xlsx",
    "Stok 1-2.3 düzeltme.xlsx",
  ])
    check(
      `hafta olmayan kısa aralık (${ad}) → null (eski haftanın üzerine yazmaz)`,
      parseWeekFromFilename(ad) === null,
      JSON.stringify(parseWeekFromFilename(ad)),
    );
  const y2 = parseWeekFromFilename("21-27.09.25.xlsx");
  check(
    "2 haneli yıl 20xx okunur (21-27.09.25 → 2025-09-21)",
    y2?.start === "2025-09-21",
    JSON.stringify(y2),
  );
  check(
    "5 haneli bozuk yıl eşleşmez",
    parseWeekFromFilename("21-27.09.20261.xlsx") === null,
  );
}

// ── ÜRÜN ARAMA: barkod + çoklu barkod (virgülle) ──
section("ÜRÜN ARAMA SORGUSU (ad · barkod · çoklu barkod)");
{
  const p1 = sorguParcala("Galatasaray");
  check(
    "tek ad → yalnız ad araması (eski davranış)",
    p1.barkodlar.length === 0 && p1.adlar.join() === "Galatasaray",
  );
  const p2 = sorguParcala("8685185015616");
  check(
    "tam barkod → yalnız barkod (ada bakılmaz)",
    p2.barkodlar.join() === "8685185015616" && p2.adlar.length === 0,
  );
  const p3 = sorguParcala("8685185015616, 8685185015623 ;8685185015630");
  check(
    "virgül/noktalı virgülle çoklu barkod, yazılan sırayla",
    p3.barkodlar.join("|") === "8685185015616|8685185015623|8685185015630",
  );
  const p4 = sorguParcala("868 5185 015616,8685185015616");
  check(
    "barkod içindeki boşluk yok sayılır, tekrar eden barkod bir kez",
    p4.barkodlar.join("|") === "8685185015616",
  );
  const p5 = sorguParcala("2025");
  check(
    "4-7 hane (yıl olabilir) → hem barkod parçası hem ad",
    p5.barkodlar.join() === "2025" && p5.adlar.join() === "2025",
  );
  const p6 = sorguParcala("8685185015616, pre-season, 12");
  check(
    "karışık sorgu: barkod + ad; 2 karakterden kısa rakam ad sayılır",
    p6.barkodlar.join() === "8685185015616" &&
      p6.adlar.join("|") === "pre-season|12",
  );
  const p7 = sorguParcala(
    Array.from({ length: 130 }, (_, i) => String(8680000000000 + i)).join(","),
  );
  check(
    "en çok 100 barkod taranır, fazlası 'atlanan' olarak bildirilir (sessiz değil)",
    p7.barkodlar.length === 100 && p7.atlanan.length === 30,
  );
  const p8 = sorguParcala("8685185015616 8685185015623  8685185015630");
  check(
    "boşlukla ayrılmış liste (Excel sütunu yapıştırma) → ayrı barkodlar",
    p8.barkodlar.join("|") === "8685185015616|8685185015623|8685185015630",
    JSON.stringify(p8),
  );
  check(
    "başında 0 olan 14 haneli GTIN → 13 haneli EAN",
    sorguParcala("08685185015616").barkodlar.join() === "8685185015616",
  );
  check(
    "art arda okutulmuş bitişik iki barkod (26 hane) → 13'erli bölünür",
    sorguParcala("86851850156168685185015623").barkodlar.join("|") ===
      "8685185015616|8685185015623",
  );
  const p9 = sorguParcala("12345678901234567890");
  check(
    "13'ün katı olmayan uzun rakam dizisi → geçersiz, adla aranmaz",
    p9.gecersiz.length === 1 &&
      p9.adlar.length === 0 &&
      p9.barkodlar.length === 0,
  );
  check(
    "boş parça ve yalnız virgül yok sayılır",
    sorguParcala(" , ,, ").barkodlar.length === 0 &&
      sorguParcala(" , ,, ").adlar.length === 0,
  );
  check(
    "görünen ad: Toyzz dışı firmanın adı tercih edilir",
    gorunenAd([
      { retailer: "Toyzz", sku_name: "ASP-MYT-KART GS" },
      { retailer: "DR", sku_name: "Mythos Gs Pkt" },
    ]) === "Mythos Gs Pkt",
  );
  check(
    "görünen ad: yalnız Toyzz'da olan ürün Toyzz adını korur",
    gorunenAd([{ retailer: "Toyzz", sku_name: "ASP-MYT-KART X" }]) ===
      "ASP-MYT-KART X",
  );
  const adl = [
    { retailer: "Toyzz", sku_name: "ASP-X" },
    { retailer: "DR", sku_name: "Mythos Gs Pkt" },
    { retailer: "Huppaluppo", sku_name: "Mythos Cards GS" },
  ];
  check(
    "görünen ad girdi sırasından bağımsız (liste = başlık)",
    gorunenAd(adl) === gorunenAd([...adl].reverse()) &&
      gorunenAd(adl) === "Mythos Cards GS",
  );
  const pv = pivotProduct([
    { ...fx("DR", "Mythos Gs Pkt", "1", 10, 0, 100), week_start: "2026-09-21" },
    {
      ...fx("Toyzz", "ASP-MYT-KART GS", "1", 5, 0, 40),
      week_start: "2026-09-21",
    },
  ]);
  check(
    "karşılaştırma başlığı Toyzz kod-adı değil",
    pv.name === "Mythos Gs Pkt",
    pv.name,
  );
}

// ── GEÇEN YIL KARŞILIĞI: aile · takım · sezon (lib/urun-ailesi.ts) ──
// Sezonluk ürün her yıl yeni barkodla gelir; yıl kıyası bu üçlüyle kurulur.
// Adlar firmaların GERÇEK yazımları (Toyzz kod-adı, D&R kısaltması, Armağan ASCII).
section("GEÇEN YIL KARŞILIĞI (aile · takım · sezon)");
{
  const ps26 = [
    "ASP-MYT-KART GALATASARAY PRE-SEASON 26/27 (GS) 24D.",
    "Mythos Gs Pre-Season 26/27 Pkt",
    "Mythos Bjk Pre-Season 26/27 Pkt",
    "Mythos Ts Pre-Season 26/27 Pkt",
  ];
  check(
    "Pre-Season: dört yazım da aynı aile",
    ps26.every((a) => aile(a) === "Pre-Season"),
  );
  check(
    "takım kısaltmaları (GS/BJK/TS) ve Toyzz parantezi",
    takim(ps26[0]) === "Galatasaray" &&
      takim(ps26[1]) === "Galatasaray" &&
      takim(ps26[2]) === "Beşiktaş" &&
      takim(ps26[3]) === "Trabzonspor",
  );
  check(
    "Türkçe büyük harf katlanır: 'Beşiktaş' ve 'BEŞİKTAŞ' aynı takım",
    takim("Mythos Beşiktaş First 24/25") === "Beşiktaş" &&
      takim("ASP-MYT-KART BEŞİKTAŞ PRE-SEASON 25/26 5+1 (BJK) 24D.") ===
        "Beşiktaş",
  );
  check(
    "Toyzz yazım hatası 'TRANZONSPOR' da Trabzonspor",
    takim("ASP-MYT-KART TRANZONSPOR SEZON KARTLARI 22/23 (TS) 10D.") ===
      "Trabzonspor",
  );
  check(
    "sezon biçimleri: 25/26 · 2025/26 · 2025-2026 · 24-25",
    sezon("X 25/26") === "25/26" &&
      sezon("X 2025/26") === "25/26" &&
      sezon("X 2025-2026") === "25/26" &&
      sezon("X 24-25") === "24/25",
  );
  check(
    "ardışık olmayan sayı sezon sayılmaz (paket boyu '5/6', '10/20')",
    sezon("Kutu 5/6 Paket") === "" && sezon("Set 10/20") === "",
  );
  check(
    "bir önceki sezon (yüzyıl dönüşü dahil)",
    oncekiSezon("26/27") === "25/26" &&
      oncekiSezon("00/01") === "99/00" &&
      oncekiSezon("") === "",
  );
  check(
    "Champions Edition, Şampiyonluk Seti'ne düşmez",
    aile("Mythos GSChampionsEdition25/26Amblj") === "Champions Edition" &&
      aile("Mythos Galatasarayşampiyonluk MtlKt") === "Şampiyonluk Seti",
  );
  check(
    "Toyzz eski takım sezon kartı adı → Sezon Kartları",
    aile("ASP-MYT-KART FENERBAHÇE 24/25 10LU") === "Sezon Kartları",
  );
  check(
    "UEFA sticker ↔ Match Attax ayrımı",
    aile("Topps-UEFA 25 ŞampLigi Stic.Eco.Pkt") === "UEFA ŞL Sticker / Albüm" &&
      aile("ASP-TPS-KART MATCH ATTAX 24/25 12Lİ (UEFA) 24D.") ===
        "Match Attax / Topps Kart",
  );
  check("tanınmayan ürün 'Diğer'", aile("Mythos Card Stant") === "Diğer");
  check(
    "karşılık anahtarı: 26/27'nin geçen yılı = aynı firma/aile/takım + 25/26",
    karsilikAnahtari(
      "DR",
      "Mythos Gs Pre-Season 26/27 Pkt",
      oncekiSezon("26/27"),
    ) === karsilikAnahtari("DR", "Mythos Galatasaray Pre-Season 25/26"),
  );
  check(
    "geçen yılın haftası = 364 gün önce, yine Pazartesi",
    gecenYilHaftasi("2026-09-28") === "2025-09-29" &&
      gecenYilHaftasi("2026-01-05") === "2025-01-06",
  );

  // Toyzz 22-28 Eylül 2025 dosyası "Toplam Satis Adedi" (ş yerine s) başlığıyla
  // geldi; tam eşleşmede o haftanın satışı sessizce 0 okunuyordu.
  const hafta = { start: "2025-09-22", end: "2025-09-28" };
  const kalem = (satisBaslik: string) =>
    normalizeAsepto(
      [
        {
          "Kalem Kodu": "T03026004",
          "Kalem Tanımı": "ASP-MYT-KART X",
          PSF: 99.99,
          "Toplam Stok Adedi": 40,
          [satisBaslik]: 7,
        },
      ],
      "Toyzz",
      hafta,
      "22-28 eylül Asepto.xlsx",
    );
  // 2-8 Kasım 2026: Toyzz kolonları "Ürün Kodu / Ürün Tanımı" oldu (+ Tedarikçi
  // Adı / Tedarikçi Ürün Kodu), barkod kolonu kalktı, PSF metin ("179,99"),
  // satışsız üründe satış hücresi boş. Eski adla tam eşleşme arandığı için dosya
  // "bilinen Asepto formatı değil" diye reddediliyordu.
  const kasim = normalizeAsepto(
    [
      {
        "Ürün Kodu": "T00038827",
        "Ürün Tanımı": "ASP-MYT-KART GALATASARAY PRE-SEASON 25/26 5+1 (GS) 24D.",
        "Tedarikçi Adı": "ASEPTO KART TİCARET A.Ş.",
        "Tedarikçi Ürün Kodu": "38827",
        PSF: "99,99",
        "Toplam Stok Adedi": 1378,
        "Toplam Satış Adedi": 69,
      },
      {
        "Ürün Kodu": "T01007161",
        "Ürün Tanımı": "ASP-TPS-KART MATCH ATTAX 24/25 12Lİ (UEFA) 24D.",
        "Tedarikçi Adı": "ASEPTO KART TİCARET A.Ş.",
        "Tedarikçi Ürün Kodu": "07161",
        PSF: "179,99",
        "Toplam Stok Adedi": 164,
        "Toplam Satış Adedi": null,
      },
    ],
    "Toyzz",
    { start: "2026-11-02", end: "2026-11-08" },
    "2-8  Kasım-Asepto.xlsx",
  );
  check(
    "Toyzz Kasım 2026 formatı: Ürün Kodu/Tanımı okunur, PSF metni sayı, boş satış 0",
    kasim.length === 2 &&
      kasim[0].sku_id === "T00038827" &&
      kasim[0].sku_name.startsWith("ASP-MYT-KART GALATASARAY") &&
      kasim[0].price === 99.99 &&
      approx(kasim[0].sales_value!, 6899.31) &&
      kasim[0].barkod === null &&
      kasim[1].sales_qty === 0 &&
      kasim[1].sales_value === 0 &&
      kasim[1].price === 179.99 &&
      kasim[1].stock_qty === 164,
    JSON.stringify(kasim[0]),
  );
  check(
    "Toyzz Kalem: 'Toplam Satis Adedi' (s) de satış kolonu",
    kalem("Toplam Satis Adedi")[0].sales_qty === 7 &&
      kalem("Toplam Satış Adedi")[0].sales_qty === 7,
  );
  check(
    "Toyzz Kalem: stok kolonu etkilenmedi",
    kalem("Toplam Satis Adedi")[0].stock_qty === 40,
  );

  const ur = (
    store: string,
    q: number,
    s: number,
    v: number | null,
  ): UnifiedRow => ({
    retailer: "DR",
    week_start: "2025-09-01",
    week_end: "2025-09-07",
    store,
    sku_name: "Mythos Gs Pre-Season 25/26",
    sku_id: "2185",
    barkod: "8684824388272",
    price: null,
    sales_qty: q,
    sales_value: v,
    stock_qty: s,
    source_file: "f",
  });
  const toplu = urunDuzeyine([
    ur("Ada", 2, 10, 166),
    ur("Akmerkez", 3, 5, null),
    ur("Cevahir", 0, 7, 0),
  ]);
  check(
    "arşiv: mağaza kırılımı tek ürün satırına çöker (adet, stok, ciro toplanır; store null)",
    toplu.length === 1 &&
      toplu[0].sales_qty === 5 &&
      toplu[0].stock_qty === 22 &&
      toplu[0].sales_value === 166 &&
      toplu[0].store === null,
  );
}

// ── ASİSTAN KOTASI: oturum başına 10 dakikada 10 soru (kredi kontrolü) ──
section("ASİSTAN KOTASI (10 dk / 10 soru)");
{
  const simdi = Date.now();
  const dk = (n: number) => simdi - n * 60_000;
  check(
    "sınır 10 soru / 10 dakika",
    KOTA_LIMIT === 10 && KOTA_PENCERE_MS === 600_000,
  );
  const dokuz = kotaHesapla(Array.from({ length: 9 }, (_, i) => dk(9 - i)));
  check(
    "9 soru sonrası 1 hak kalır, kilit yok",
    dokuz.kalan === 1 && dokuz.sifirlanmaSn === 0,
  );
  const on = kotaHesapla(Array.from({ length: 10 }, (_, i) => dk(4 - i * 0.1)));
  check(
    "10. sorudan sonra hak 0; en eski soru 4 dk önceyse ~6 dk sonra açılır",
    on.kalan === 0 && on.sifirlanmaSn >= 355 && on.sifirlanmaSn <= 361,
    JSON.stringify(on),
  );
  check("hiç soru yokken tam hak", kotaHesapla([]).kalan === 10);
}

// ── DÜŞEN TALEP KAPISI — motorun SEVK adedi (compute.ts dusenTalepHizi) ──
// Ölçülen vaka: Toyzz GS Sezon Kartları 25/26 12'li, 8 hf ort. 244/hf, son 3 hf
// 73/hf, raf dolu → güncel hız dönmeli. Raf boşalınca düşen satış talep düşüşü
// SAYILMAMALI (sevki kısmak kaybı kesinleştirir).
section("DÜŞEN TALEP KAPISI (yönlendirme SEVK)");
{
  const h = (satis: number | null, stok: number | null) => ({ satis, stok });
  const gs = [
    h(400, 3000),
    h(380, 2600),
    h(349, 2200),
    h(301, 1500),
    h(126, 1100),
    h(89, 900),
    h(72, 700),
    h(58, 625),
  ];
  const v8 = gs.reduce((t, x) => t + (x.satis ?? 0), 0) / gs.length;
  const g = dusenTalepHizi(gs, v8);
  check(
    "raf doluyken sert düşüş → son 3 hf ortalaması",
    g != null && approx(g, (89 + 72 + 58) / TREND_SON),
    String(g),
  );
  const bosRaf = [...gs.slice(0, 7), h(58, 20)];
  check(
    "son hafta stok < satış (raf boşaldı) → kapı kapalı",
    dusenTalepHizi(bosRaf, v8) === null,
  );
  const eksik = [...gs.slice(0, 7), h(null, null)];
  check(
    "son haftada rapor satırı yok (Nezih stoksuzu yazmaz) → kapı kapalı",
    dusenTalepHizi(eksik, v8) === null,
  );
  check(
    "5'ten az rafta-hafta → kapı kapalı",
    dusenTalepHizi(gs.slice(-4), v8) === null,
  );
  const yatay = Array.from({ length: 8 }, () => h(100, 900));
  check(
    "satış yatay → kapı kapalı (eski davranış)",
    dusenTalepHizi(yatay, 100) === null,
  );
  const hafif = [
    ...Array.from({ length: 5 }, () => h(100, 900)),
    h(80, 900),
    h(80, 900),
    h(80, 900),
  ];
  const v8h = hafif.reduce((t, x) => t + (x.satis ?? 0), 0) / 8;
  check(
    `hafif düşüş (eşik %${Math.round(TREND_ESIK * 100)} üstü) → kapı kapalı`,
    dusenTalepHizi(hafif, v8h) === null,
  );
  check("hız 0 → kapı kapalı", dusenTalepHizi(gs, 0) === null);
}

// ── RAF VARLIĞI — yönlendirme motorunun asgari raf / ince raf hesabı (compute.ts) ──
// Ölçüm (2026-10-29): mağaza başı stok birkaç adetin altına inince satış çöküyor
// (D&R zincir + Armağan mağaza-içi kesit). Motor 29.10'da ince raflı 65 satan
// satırın 58'ine "çek" diyordu; bu testler eğrinin ve türevlerinin sözleşmesi.
section("RAF VARLIĞI (yönlendirme asgari raf)");
{
  // Eğri: 0'da 0, monoton artan, ~4,8 adette doyuyor, 1'i aşmıyor.
  const xs = [0, 0.5, 0.9, 1.5, 1.8, 2.5, 3, 3.6, 4.2, 4.8, 6, 20];
  const ys = xs.map(rafPayi);
  check("rafPayi(0) = 0", ys[0] === 0);
  check(
    "rafPayi monoton artan",
    ys.every((y, i) => i === 0 || y >= ys[i - 1]),
    ys.map((y) => y.toFixed(2)).join(" "),
  );
  check(
    "rafPayi doyumda 1, üstünde 1",
    rafPayi(4.8) === 1 && rafPayi(20) === 1,
  );
  check(
    "ölçülen dirsek: 3 adette ~0,63, 1,8 adette ~0,27",
    approx(rafPayi(3), 0.63) && approx(rafPayi(1.8), 0.27),
  );
  check("negatif/NaN stok → 0", rafPayi(-3) === 0 && rafPayi(NaN) === 0);

  // Taşıması gereken mağaza: talep / SATIS_MAGAZA_BASI, [MAGAZA_ASGARI, tavan] aralığında.
  check(
    "mağaza verisi olmayan kanal → null (Toyzz)",
    tasiyanMagaza("Toyzz", 500) === null,
  );
  check(
    "D&R hızlı ürün → tavan (190)",
    tasiyanMagaza("DR", 375) === MAGAZA_TASIYABILEN.DR,
  );
  check(
    "D&R yavaş ürün → talepten (10/hf → 29)",
    tasiyanMagaza("DR", 10) === Math.ceil(10 / SATIS_MAGAZA_BASI),
  );
  check(
    "çok yavaş ürün → taban (MAGAZA_ASGARI)",
    tasiyanMagaza("DR", 0.5) === MAGAZA_ASGARI,
  );
  check(
    "Armağan tavanı 100",
    tasiyanMagaza("Armağan", 1000) === MAGAZA_TASIYABILEN["Armağan"],
  );

  // İnce raf düzeltmesi: dolu rafta aynen, ince rafta en fazla SANSUR_TAVAN katı.
  check(
    "raf verisi yoksa talep = hız",
    sansurDuzeltilmisTalep(20, null) === 20,
  );
  check(
    "dolu raf (5 adet/mğz) → talep = hız",
    sansurDuzeltilmisTalep(20, 5) === 20,
  );
  check(
    `çok ince raf → tavan ×${SANSUR_TAVAN}`,
    sansurDuzeltilmisTalep(18.4, 1.15) === 18.4 * SANSUR_TAVAN,
  );
  check(
    "3 adet/mğz → hız / 0,63",
    approx(sansurDuzeltilmisTalep(63, 3), 100, 0.5),
    String(sansurDuzeltilmisTalep(63, 3)),
  );
  check("hız 0 → talep 0", sansurDuzeltilmisTalep(0, 0.5) === 0);

  // Haftalık satış: mağaza yoksa min(talep, stok); varsa talep × eğri, stokla sınırlı.
  check(
    "mağazasız: stok yeterse talep kadar",
    haftalikSatis(1000, 100, null) === 100,
  );
  check(
    "mağazasız: stok yetmezse stok kadar",
    haftalikSatis(40, 100, null) === 40,
  );
  check("mağazalı: dolu raf → talep", haftalikSatis(1900, 100, 190) === 100);
  check(
    "mağazalı: 1 adet/mğz → talebin ~%13'ü",
    approx(haftalikSatis(190, 100, 190), 100 * rafPayi(1)),
  );
  check("satış stoğu asla aşmaz", haftalikSatis(5, 1000, 2) <= 5);

  // Sevkin etkisi: ince rafa sevk satışı artırır; dolu rafa sevk 4 hf'de etkisiz.
  const ince =
    beklenenSatis(200, 37, 106, 220) - beklenenSatis(200, 37, 106, 0);
  check(
    "ince rafa sevk satışı artırır (Toz Pembe vakası)",
    ince > 30,
    ince.toFixed(1),
  );
  const dolu =
    beklenenSatis(4195, 821, 190, 4014, 4) -
    beklenenSatis(4195, 821, 190, 0, 4);
  check(
    "4 hf'ye yeten rafa sevk 4 hf ufkunda ~0 etki (ŞL Eco vakası)",
    dolu < 1,
    dolu.toFixed(1),
  );
  const dolu8 =
    beklenenSatis(4195, 821, 190, 4014, 8) -
    beklenenSatis(4195, 821, 190, 0, 8);
  check(
    "aynı sevk 8 hf ufkunda değer üretir (ETKI_UFKU = 8 gerekçesi)",
    dolu8 > 1000,
    dolu8.toFixed(0),
  );
  // Boş raf, talep 50, sevk TESLIM_HF (=1). haftasında gelir: ufuk 1 hafta → sevk henüz
  // rafta değil, satış 0; ufuk 2 hafta → yalnız 2. hafta satar (50).
  check(
    "sevk geliş haftasından önce satış üretmez",
    beklenenSatis(0, 50, null, 100, TESLIM_HF) === 0,
  );
  check(
    "sevk geldiği hafta satar",
    beklenenSatis(0, 50, null, 100, TESLIM_HF + 1) === 50,
  );

  // Son tarih: asgari rafa (ya da teslim+1 hf stoğa) kaç hafta var.
  check("eşiğin altındaysa 0 (hemen)", sorunHaftasi(200, 18, 424) === 0);
  check("eşiğe 2 hafta", sorunHaftasi(1000, 100, 800) === 2);
  check(
    "mağazasız: teslim+1 hf tampon",
    sorunHaftasi(1000, 100, 0) === (1000 - 100 * (TESLIM_HF + 1)) / 100,
  );
  check(
    "talep 0 → sonsuz (son tarih yok)",
    sorunHaftasi(100, 0, 0) === Infinity,
  );
}

// ── HIZ BÖLENİ: RAF ÖNCESİ 0/0 HAFTALAR SAYILMAZ (/stok ↔ /yonlendirme paritesi) ──
// 29.10'da ölçüldü: /stok 6 Toyzz lansman ürününde hızı tam 6/8 oranında düşük
// gösteriyordu (BJK Pre-Season 26/27 369,5 ↔ 492,7/hf); routing velOf'a 28.09'da
// giren kural buildVelocityIndex'e taşınmamıştı.
section("HIZ BÖLENİ (raf öncesi haftalar)");
{
  const W = [
    "2026-08-31",
    "2026-09-07",
    "2026-09-14",
    "2026-09-21",
    "2026-09-28",
    "2026-10-05",
    "2026-10-12",
    "2026-10-19",
  ];
  const satir = (sku: string, w: string, sales: number, stock: number) => ({
    retailer: "Toyzz",
    week_start: w,
    sku_name: sku,
    sales_qty: sales,
    stock_qty: stock,
  });
  const rows = [
    // Lansman: 2 hafta 0/0 listelendi, sonra 6 hafta rafta, haftada 100.
    ...W.map((w, i) => satir("LANSMAN", w, i < 2 ? 0 : 100, i < 2 ? 0 : 900)),
    // Sönen ürün: hep rafta, yalnız ilk hafta sattı → bölen 8 kalmalı.
    ...W.map((w, i) => satir("SONEN", w, i === 0 ? 80 : 0, 500)),
  ];
  const idx = buildVelocityIndex(rows, (r) => r.sku_name);
  check(
    "lansman ürünü: bölen rafta geçen 6 hafta (100/hf, 75 değil)",
    approx(velocityOf(idx, "Toyzz", "LANSMAN"), 100),
    String(velocityOf(idx, "Toyzz", "LANSMAN")),
  );
  check(
    "sönen ürün: rafta durduğu her hafta bölene girer (80/8 = 10)",
    approx(velocityOf(idx, "Toyzz", "SONEN"), 10),
    String(velocityOf(idx, "Toyzz", "SONEN")),
  );
  const stoksuz = buildVelocityIndex(
    rows.map(({ stock_qty, ...r }) => r),
    (r) => r.sku_name,
  );
  check(
    "stok kolonu gelmeyen eski çağıran: satışın başladığı hafta raf sayılır (yine 100)",
    approx(velocityOf(stoksuz, "Toyzz", "LANSMAN"), 100),
    String(velocityOf(stoksuz, "Toyzz", "LANSMAN")),
  );
}

// ── SİPARİŞ KONTROLÜ — gelen sipariş, motorun hedefleriyle (lib/siparis-kontrol.ts) ──
section("SİPARİŞ KONTROLÜ (yönlendirme)");
{
  // Excel'den kopyalanan başlıklı tablo (sekmeli), binlik noktalı adet, fiyat kolonu.
  const tablo =
    "Barkod\tÜrün Adı\tBirim Fiyat\tSipariş Miktarı\n" +
    "8685185015531\tMythos Manifest Toz Pembe Kartları\t264,56\t1.200\n" +
    "5053307076952-3\tTOPPS MATCH ATTAX 25/26 - BOOSTER TİN 3\t882,89\t14\n" +
    "\tTOPLAM\t\t1.214\n";
  const t = siparisAyristir(tablo);
  check(
    "başlıklı tablo: TOPLAM satırı atlanır, 2 satır okunur",
    t.length === 2,
    JSON.stringify(t.map((x) => x.adet)),
  );
  check("binlik noktalı adet 1.200 → 1200", t[0]?.adet === 1200);
  check("fiyat kolonu (264,56) adet sanılmaz", t[0]?.adet !== 264);
  check("tin barkodundaki -3 eki atılır", t[1]?.barkod === "5053307076952");
  // Başlıksız düz metin: barkod + ad + adet, ya da yalnız ad + adet.
  const duz = siparisAyristir(
    "8685185015531 Toz Pembe 218\nMythos Galatasaray 25/26 500PrçPuz. 27\nFENERBAHÇE TAKIM 2025/26 1000 PARÇA PUZZLE 151",
  );
  check("düz metin: 3 satır", duz.length === 3);
  check(
    "düz metin: barkod + adet",
    duz[0]?.barkod === "8685185015531" && duz[0]?.adet === 218,
  );
  check(
    "addaki sayılar (25/26, 500PrçPuz.) adet sanılmaz",
    duz[1]?.adet === 27,
  );
  check(
    "addaki 1000 kalır, adet son sayı (151)",
    duz[2]?.adet === 151 && !!duz[2]?.ad.includes("1000"),
  );
  check("adetsiz satır atlanır", siparisAyristir("Toz Pembe\n\n").length === 0);

  const m = (o: Partial<MotorSatiri>): MotorSatiri => ({
    retailer: "DR",
    sku_name: "Mythos Manifest Toz Pembe Kartları",
    barkod: "8685185015531",
    season: "TREND",
    stock: 202,
    velocity: 18.4,
    target: 8,
    action: "SEVK",
    talep: 36.8,
    rafEsik: 424,
    magaza: 106,
    ...o,
  });
  const toz = m({});
  check(
    "barkodla eşleşme",
    eslestir({ ham: "", barkod: "8685185015531", ad: "", adet: 1 }, [toz]) ===
      toz,
  );
  check(
    "adla eşleşme (kelime örtüşmesi)",
    eslestir(
      { ham: "", barkod: null, ad: "Manifest Toz Pembe Kartları", adet: 1 },
      [toz],
    ) === toz,
  );
  check(
    "alakasız ad eşleşmez",
    eslestir({ ham: "", barkod: null, ad: "Pokemon Mystery", adet: 1 }, [
      toz,
    ]) === null,
  );
  // 29.10 canlı denemede yakalanan iki hata:
  const bjk = m({
    sku_name: "Mythos BJKPlsFtblcKrtları25/26Paket",
    barkod: "8684824388418",
  });
  check(
    "bitişik takım kodu: FB Pulse adı BJK Pulse'a eşlenmez",
    eslestir(
      {
        ham: "",
        barkod: null,
        ad: "Mythos FBPlsFtblcKartları25/26Paket",
        adet: 1,
      },
      [bjk],
    ) === null,
  );
  check(
    "barkod verilmiş ama kanalda yok → adla başka ürüne düşmez",
    eslestir(
      {
        ham: "",
        barkod: "8684824388425",
        ad: "Mythos BJKPlsFtblcKrtları25/26Paket",
        adet: 1,
      },
      [bjk],
    ) === null,
  );
  // İnce raflı üründe ret eşiği iyimser talepten: Toz Pembe 1.664 adet, talep 37-92/hf.
  const tozUst = m({ talepUst: 92 });
  check(
    "ince raf + iyimser talep: 1.664 adet ÇOK FAZLA değil, FAZLA",
    siparisHukmu({ ham: "", barkod: null, ad: "x", adet: 1664 }, tozUst, 26)
      .hukum === "FAZLA",
  );
  check(
    "iyimser talepte bile ufku aşan sipariş yine ÇOK FAZLA (3.000)",
    siparisHukmu({ ham: "", barkod: null, ad: "x", adet: 3000 }, tozUst, 26)
      .hukum === "COK_FAZLA",
  );

  // Hedef T = max(424, ceil(8×36,8)=295) = 424 → ihtiyaç 222; ufuk 26 → K = 957 → tavan 755.
  const h = (adet: number, mo = toz) =>
    siparisHukmu({ ham: "", barkod: null, ad: "x", adet }, mo, 26);
  check("ihtiyaç kadar (220) → MANTIKLI", h(220).hukum === "MANTIKLI");
  check(
    // sonrası 802/36,8 = 22 hf > makul 16 hf; makul tavan = 16×36,8 − 202 = 387.
    "makulün üstü ama ufuk içinde (600) → FAZLA, öneri 387",
    h(600).hukum === "FAZLA" && h(600).oneri === 387,
  );
  check(
    "sonrası makul (16 hf) içinde ama motor hedefinin üstü (380) → MANTIKLI",
    h(380).hukum === "MANTIKLI",
  );
  check("ufku aşan (1.200) → ÇOK FAZLA", h(1200).hukum === "COK_FAZLA");
  check(
    "ihtiyacın yarısından az (50) → AZ",
    h(50).hukum === "AZ" && h(50).oneri === 222,
  );
  check(
    "sipariş sonrası mağaza başı stok hesaplanır",
    approx(h(220).sonraMagazaBasi ?? 0, (202 + 220) / 106),
  );
  check(
    "eski sezon (sevk değil) → ESKİ SEZON, öneri 0",
    h(100, m({ season: "ESKİ", action: "ERIT" })).hukum === "ESKI_SEZON",
  );
  check(
    "satmayan ürün → SATIŞ YOK",
    h(100, m({ talep: 0.4, velocity: 0.4 })).hukum === "SATIS_YOK",
  );
  check(
    "eşleşmeyen satır → BULUNAMADI",
    siparisHukmu({ ham: "", barkod: null, ad: "x", adet: 5 }, null, 26)
      .hukum === "BULUNAMADI",
  );
  // D&R DEPOSU (aynı hafta): 28.09'da Toz Pembe mağazada ~220, depoda 2.928 idi.
  // Depo stoğa eklenince 1.664'lük sipariş iyimser talepte bile ufku aşar.
  const depolu = m({ talepUst: 92, depo: 2928 });
  const hd = siparisHukmu(
    { ham: "", barkod: null, ad: "x", adet: 1664 },
    depolu,
    26,
  );
  check(
    "depo biliniyorsa stoğa eklenir: 1.664 Toz Pembe → ÇOK FAZLA",
    hd.hukum === "COK_FAZLA",
    hd.gerekce,
  );
  check(
    "gerekçe mağaza ve depoyu ayrı yazar",
    hd.gerekce.includes("mağaza + ") && hd.gerekce.includes("depo"),
  );

  // D&R Kategori dosyasının depo kolonları (lib/normalizers/dr-kategori.ts)
  const hafta = { start: "2026-10-19", end: "2026-10-25" };
  const ham = [
    {
      Urun: "Mythos Manifest Toz Pembe Kartları",
      "Urun Id": 1,
      Barkod: "8685185015531",
      "Satis Miktar": 8,
      "Stok Miktar": 202,
      "Web Depo Stok Miktar": 15,
      "Offline Depo Stok Miktar": 2928,
    },
    {
      Urun: "Mythos Manifest Hileli Kartları",
      "Urun Id": 2,
      Barkod: 8685185015524,
      "Satis Miktar": 90,
      "Stok Miktar": 556,
      "Web Depo Stok Miktar": -3,
      "Offline Depo Stok Miktar": 0,
    },
    {
      Urun: "Genel Toplam",
      "Urun Id": null,
      Barkod: null,
      "Satis Miktar": 98,
      "Stok Miktar": 758,
      "Web Depo Stok Miktar": 12,
      "Offline Depo Stok Miktar": 2928,
    },
  ];
  const dp = drKategoriDepo(ham, hafta, "Satin Alma - Kategori.xlsx");
  check(
    "depo: toplam satırı atlanır, 2 ürün",
    dp.length === 2,
    JSON.stringify(dp.map((d) => d.sku_name)),
  );
  check(
    "depo: offline/web ayrı okunur",
    dp[0]?.offline_depo === 2928 && dp[0]?.web_depo === 15,
  );
  check(
    "depo: sayı tipli barkod metne döner",
    dp[1]?.barkod === "8685185015524",
  );
  check("depo: negatif depo 0'a çekilir", dp[1]?.web_depo === 0);
  check(
    "depo kolonu olmayan dosya → boş liste",
    drKategoriDepo(
      [
        {
          Urun: "x",
          "Urun Id": 1,
          Barkod: "8685185015531",
          "Satis Miktar": 1,
          "Stok Miktar": 5,
        },
      ],
      hafta,
      "f",
    ).length === 0,
  );

  // GERÇEK D&R (SAP) SİPARİŞ DOSYASI YAPISI (22 Ekim): ilk satır görünmez karakterli,
  // "Malzeme" = D&R kodu, "Ad 1" = depo/tesis adı, EAN sayı (biçimli metinde 8.68482E+12).
  const sap: unknown[][] = [
    ["​", "", "", "", "", "", "", "", "", "", "", ""],
    [
      "Satıcı",
      "B.Türü",
      "Satınalma belgesi",
      "Üretim yeri",
      "Ad 1",
      "Depo yeri",
      "Teslimat tarihi",
      "Malzeme",
      "EAN/UPC kodu",
      "Malzeme kısa metni",
      "Miktar",
      "Koşul tutarı",
    ],
    [
      3202002376,
      "Z001",
      4506913874,
      9001,
      "Offline Depo",
      "D001",
      46316,
      2235835001,
      8685185015531,
      "Mythos Manifest Toz Pembe Kartları, N/A",
      1664,
      308.73,
    ],
    [
      3202002376,
      "Z001",
      4506913874,
      9001,
      "Offline Depo",
      "D001",
      46316,
      2205849001,
      8684824388418,
      "Mythos BJKPlsFtblcKrtları25/26Paket, N/A",
      1248,
      43.73,
    ],
  ];
  const sp = siparisAyristir(tabloMetni(sap));
  check(
    "SAP dosyası: görünmez karakterli satır atlanır, başlık bulunur, 2 satır",
    sp.length === 2,
    JSON.stringify(sp),
  );
  check(
    "SAP dosyası: barkod EAN kolonundan (satıcı/malzeme kodu değil)",
    sp[0]?.barkod === "8685185015531" && sp[1]?.barkod === "8684824388418",
  );
  check(
    "SAP dosyası: ad 'Malzeme kısa metni'nden ('Ad 1' ya da kod değil)",
    !!sp[0]?.ad.startsWith("Mythos Manifest Toz Pembe"),
  );
  check(
    "SAP dosyası: adet Miktar kolonundan",
    sp[0]?.adet === 1664 && sp[1]?.adet === 1248,
  );
  check(
    "tabloMetni: 13 haneli EAN tam sayı olarak korunur",
    tabloMetni([[8685185015531]]) === "8685185015531",
  );

  const k = siparisKontrol(
    "8685185015531\t218\nYok Böyle Ürün\t5",
    "DR",
    [toz, m({ retailer: "Toyzz" })],
    26,
  );
  check(
    "kontrol: kanal süzülür, özet sayar",
    k.ozet.satir === 2 &&
      k.ozet.sayim.MANTIKLI === 1 &&
      k.ozet.sayim.BULUNAMADI === 1,
    JSON.stringify(k.ozet.sayim),
  );
}

// ── D&R FATURA FİYATI + ASEPTO KDV (2026-10-29) ──
// D&R mağaza dosyasındaki "Satis Tutar" KDV hariç geliyordu ve okurken bir daha
// 1,2'ye bölünüyordu. Fiyatsız D&R haftaları artık faturadaki net fiyattan
// (PSF'ye çevrilerek) doldurulur; okuma anındaki net birebir fatura fiyatı olur.
section("D&R FATURA FİYATI + ASEPTO KDV");
{
  const hafta = { start: "2026-02-16", end: "2026-02-22" };
  const magaza = (ret: "DR" | "Toyzz") =>
    normalizeAsepto(
      [
        {
          Magaza: "D&R Kanyon",
          Urun: "BJK METAL KUTU",
          UrunId: 1,
          Barkod: "8684824388524",
          "Satis Miktar": 1,
          "Satis Tutar": 665.83,
          "Stok Miktar": 4,
        },
        { Magaza: "Genel Toplam", Urun: "x", "Satis Tutar": 665.83 },
      ],
      ret,
      hafta,
      "ASEPTO SATIŞ STOK 16 - 22 Şubat.xlsx",
    );
  check(
    "ASEPTO mağaza D&R: Satis Tutar KDV hariç → ×1,2 (665,83 → 799,00)",
    magaza("DR").length === 1 && magaza("DR")[0].sales_value === 799,
    String(magaza("DR")[0]?.sales_value),
  );
  check(
    "ASEPTO mağaza D&R: okuma anındaki net = fatura neti (799 × 0,53/1,2 = 352,89)",
    approx(799 * netFactor("DR"), 352.89, 0.01),
  );
  check(
    "ASEPTO mağaza Toyzz (kanıt yok): tutar ham kalır",
    magaza("Toyzz")[0].sales_value === 665.83,
  );

  check(
    "faturaBarkodu: teneke varyantı '-2' eki atılır, stok kodu barkod değildir",
    faturaBarkodu("5053307076952-2") === "5053307076952" &&
      faturaBarkodu("8684824388524") === "8684824388524" &&
      faturaBarkodu(8684824388524) === "8684824388524" &&
      faturaBarkodu("Worl3939105312023") === null &&
      faturaBarkodu("") === null,
  );

  const idx = faturaIndeksi([
    { barkod: "8684824388524", tarih: "2026-02-16", net_fiyat: 352.89, miktar: 800 },
    // aynı gün iki kalem → adet ağırlıklı
    { barkod: "8684824388524", tarih: "2026-07-01", net_fiyat: 441.23, miktar: 300 },
    { barkod: "8684824388524", tarih: "2026-07-01", net_fiyat: 400, miktar: 100 },
    // iade ve bedelsiz numune fiyat kanıtı değil
    { barkod: "8684824388524", tarih: "2026-08-01", net_fiyat: 10, miktar: 5, iade: true },
    { barkod: "8684824388524", tarih: "2026-08-02", net_fiyat: 0, miktar: 1 },
    { barkod: "5053307076952-1", tarih: "2026-03-01", net_fiyat: 882.89, miktar: 10 },
    { barkod: "5053307076952-3", tarih: "2026-03-01", net_fiyat: 882.89, miktar: 30 },
  ]);
  const a = faturaNeti(idx, "8684824388524", "2026-02-22");
  const b = faturaNeti(idx, "8684824388524", "2026-06-30");
  const c = faturaNeti(idx, "8684824388524", "2026-07-05");
  const d = faturaNeti(idx, "8684824388524", "2026-10-01");
  const e = faturaNeti(idx, "8684824388524", "2026-01-31");
  check(
    "faturaNeti: hafta sonuna kadar SON fatura; fiyat artışı sonraki haftalara yansır",
    a?.net === 352.89 && a.once && b?.net === 352.89 && approx(c!.net, 430.9225, 0.0001),
    JSON.stringify({ a, b, c }),
  );
  check(
    "faturaNeti: iade ve 0 TL kalem fiyatı değiştirmez",
    approx(d!.net, 430.9225, 0.0001) && d!.tarih === "2026-07-01",
  );
  check(
    "faturaNeti: haftadan önce fatura yoksa ilk sonraki (once=false)",
    e?.net === 352.89 && e.once === false && e.tarih === "2026-02-16",
  );
  check(
    "faturaNeti: teneke varyantları tek EAN'da birleşir; faturasız barkod null",
    faturaNeti(idx, "5053307076952", "2026-03-07")?.net === 882.89 &&
      faturaNeti(idx, "0000000000000", "2026-03-07") === null,
  );
  // FIFO: D&R satıştan öder, birimi geldiği partinin fiyatından; önce eski parti.
  // FB First metal kutu: Şubat 1.200 adet 352,89, Ağustos 20 adet 441,23.
  const fifo = faturaIndeksi([
    { barkod: "8684824388517", tarih: "2026-02-16", net_fiyat: 352.89, miktar: 1200 },
    { barkod: "8684824388517", tarih: "2026-08-28", net_fiyat: 441.23, miktar: 20 },
  ]);
  check(
    "FIFO: fiyat artışından sonra satılan birim hâlâ eski partiden (500 stok altı 100 satış → 352,89)",
    approx(faturaNeti(fifo, "8684824388517", "2026-09-06", 500, 100)!.net, 352.89, 1e-9),
  );
  check(
    "FIFO: eldeki 40 birimin değeri = en yeni 20 × 441,23 + 20 × 352,89",
    approx(faturaNeti(fifo, "8684824388517", "2026-09-06", 0, 40)!.net, (20 * 441.23 + 20 * 352.89) / 40, 1e-9),
  );
  check(
    "FIFO: varsayılan (ust 0, adet 1) = son faturanın fiyatı; artıştan önce eski fiyat",
    faturaNeti(fifo, "8684824388517", "2026-09-06")!.net === 441.23 &&
      faturaNeti(fifo, "8684824388517", "2026-08-01", 0, 10)!.net === 352.89,
  );
  check(
    "FIFO: faturalı birimlerin altına inilince kalan en eski fiyattan (liste öncesi parti)",
    approx(faturaNeti(fifo, "8684824388517", "2026-09-06", 1200, 100)!.net, 352.89, 1e-9),
  );
  // BJK Pulls: Ocak 1.080 adet 79,00 (raf 179), Mart'tan beri 43,73 (raf 99).
  const pulls = faturaIndeksi([
    { barkod: "8684824388418", tarih: "2026-01-16", net_fiyat: 79, miktar: 1080 },
    { barkod: "8684824388418", tarih: "2026-03-27", net_fiyat: 43.73, miktar: 380 },
  ]);
  check(
    "FIFO: fiyat indiriminde stok yeni partiyi aşıyorsa satılan birim eski (pahalı) partiden",
    faturaNeti(pulls, "8684824388418", "2026-04-05", 400, 50)!.net === 79 &&
      faturaNeti(pulls, "8684824388418", "2026-04-05", 100, 50)!.net === 43.73,
  );
  check(
    "netFaturadanPsf: fatura neti → PSF, netFactor ile geri net (D&R 352,89 → 799)",
    approx(netFaturadanPsf(352.89, "DR"), 799, 0.01) &&
      approx(netFaturadanPsf(352.89, "DR") * netFactor("DR"), 352.89, 1e-9),
  );
  check(
    "haftaSonu: Pazartesi + 6 gün (ay/yıl sınırı)",
    haftaSonu("2026-02-16") === "2026-02-22" && haftaSonu("2025-12-29") === "2026-01-04",
  );
}

// ── HAREKET TOKENLARI — CSS ile JS aynı ritimde kalmalı ──
// globals.css :root'taki --cx-* süreleri FLIP (WAAPI) ve imza eşiği gibi JS
// tarafındaki hareketlerle aynı olmak zorunda; biri tek başına değişirse panel
// ile kart kayması farklı ritimde oynar.
section("HAREKET TOKENLARI (globals.css ↔ src/lib/hareket.ts)");
{
  const css = readFileSync(
    join(process.cwd(), "src", "app", "globals.css"),
    "utf8",
  );
  const kok = css.match(/:root\s*\{([\s\S]*?)\}/)?.[1] ?? "";
  const ms = (ad: string) => {
    const m = kok.match(new RegExp(`--cx-${ad}:\\s*([\\d.]+)ms`));
    return m ? Number(m[1]) : NaN;
  };
  for (const ad of ["tik", "adim", "gecis", "sonum", "esik"] as const) {
    check(
      `--cx-${ad} = SURE.${ad} (${SURE[ad]} ms)`,
      ms(ad) === SURE[ad],
      `css ${ms(ad)}`,
    );
  }
  const soluk = Number(kok.match(/--cx-soluk:\s*([\d.]+)/)?.[1]);
  check(`--cx-soluk = SOLUK (${SOLUK})`, soluk === SOLUK, `css ${soluk}`);
  const egri = kok.match(/--cx-e:\s*([^;]+);/)?.[1]?.trim();
  check("--cx-e = EGRI", egri === EGRI, `css ${egri}`);
  check(
    "tavan: hiçbir süre 360 ms'yi aşmaz",
    Math.max(SURE.tik, SURE.adim, SURE.gecis, SURE.sonum) <= 360,
  );
}

const SEED_TEST_SAYISI = 126;
const FOLDERS: Record<string, Retailer> = {
  toyzz: "Toyzz",
  dr: "DR",
  nezih: "Nezih",
  armagan: "Armağan",
  huppaluppo: "Huppaluppo",
};
const seedRoot = join(process.cwd(), "seed");
const seedYok = !existsSync(seedRoot);
const seedOncesi = passed + failed;

if (seedYok) {
  skipped = SEED_TEST_SAYISI;
  console.log(`\n${"!".repeat(62)}`);
  console.log(`!!  SEED YOK — ${SEED_TEST_SAYISI} TEST ATLANDI`);
  console.log(
    "!!  Atlanan kapsam: 5 normalizer (Toyzz/DR/Nezih/Armağan/Huppaluppo)",
  );
  console.log(
    "!!  + gerçek veriyle compute entegrasyonu (özet, kart, insight, stok,",
  );
  console.log(
    "!!  sıralama, mağaza, kategori, executive özet, dönem karşılaştırma).",
  );
  console.log(
    `!!  Excel'leri ${Object.keys(FOLDERS)
      .map((f) => "seed/" + f)
      .join(", ")} altına koy.`,
  );
  console.log("!!  BU BİR BAŞARI DEĞİL: çıkış kodu 1.");
  console.log(`${"!".repeat(62)}`);
} else {
  // ───────────── 15. NORMALIZERS (gerçek Excel, 5 perakendeci) ─────────────
  section("15. Normalizer'lar (gerçek dosyalar, 5 perakendeci)");
  let allRows: UnifiedRow[] = [];
  let fileCount = 0,
    emptyCount = 0,
    diskFiles = 0;
  const eksikKlasor: string[] = [];
  const byRetailerFiles = new Map<string, number>();

  for (const [folder, retailer] of Object.entries(FOLDERS)) {
    const dir = join(seedRoot, folder);
    if (!existsSync(dir)) {
      eksikKlasor.push(folder);
      continue;
    }
    const files = readdirSync(dir).filter(
      (f) => /\.xlsx?$/i.test(f) && !f.startsWith("~$"),
    );
    diskFiles += files.length;
    for (const file of files) {
      try {
        const buf = readFileSync(join(dir, file));
        const ab = buf.buffer.slice(
          buf.byteOffset,
          buf.byteOffset + buf.byteLength,
        );
        const rows = normalizeFile(ab as ArrayBuffer, retailer, file);
        allRows = allRows.concat(rows);
        fileCount++;
        byRetailerFiles.set(retailer, (byRetailerFiles.get(retailer) ?? 0) + 1);
      } catch (e: any) {
        if (e.message.includes("boş")) emptyCount++;
        else {
          failed++;
          failures.push(`✗ normalize ${folder}/${file}: ${e.message}`);
        }
      }
    }
  }

  // BOŞ METİN BARKOD OLMAZ (denetim bulgusu). Dört normalizer geçersiz barkodu
  // null yapıyordu, asepto (Toyzz/D&R-Asepto) tek başına "" bırakıyordu. Fark
  // zararsız değil: prices.ts fiyat kanıtını `.not("barkod","is",null)` ile
  // süzüyor ve "" bu filtreden GEÇİYOR — bütün barkodsuz satırlar tek anahtar
  // altında toplanıp aynı medyan fiyatı alıyor, üstelik sku_prices'a kalıcı
  // yazılıyor. Kural artık beş normalizerde de aynı.
  {
    const bos = allRows.filter((r) => r.barkod === "");
    check(
      "hiçbir normalizer boş metin barkod üretmiyor",
      bos.length === 0,
      bos.length
        ? `${bos.length} satır, ör. ${bos[0].retailer} / ${String(bos[0].sku_name).slice(0, 40)}`
        : "",
    );
    const gecersiz = allRows.filter(
      (r) => r.barkod != null && !/^\d{6,14}$/.test(r.barkod),
    );
    check(
      "barkod varsa 6-14 hane rakam",
      gecersiz.length === 0,
      gecersiz.length
        ? `${gecersiz.length} satır, ör. "${gecersiz[0].barkod}"`
        : "",
    );
  }

  // 5 klasörün hepsi beslenmeli: eksik klasör = o normalizer SIFIR kapsamda demektir.
  check(
    "5 perakendeci klasörü de mevcut",
    eksikKlasor.length === 0,
    eksikKlasor.length ? "eksik: " + eksikKlasor.join(", ") : "",
  );
  check(
    "diskteki her dosya ya işlendi ya 'boş' sayıldı",
    fileCount + emptyCount === diskFiles,
    `işlenen ${fileCount} + boş ${emptyCount} ≠ disk ${diskFiles}`,
  );
  check("en az 60 dosya işlendi", fileCount >= 60, `${fileCount} dosya`);
  check("boş dosyalar yakalandı", emptyCount >= 1, `${emptyCount} boş`);
  check(
    "toplam satır > 380K",
    allRows.length > 380000,
    `${allRows.length} satır`,
  );
  // Beş normalizer'ın HEPSİ satır üretmeli (klasör var ama normalizer sessizce 0
  // döndürüyorsa yukarıdaki dosya sayacı bunu yakalamaz).
  const retailerSet = new Set(allRows.map((r) => r.retailer));
  check(
    "beş perakendecinin HEPSİ satır üretti",
    RETAILERS.every((r) => retailerSet.has(r)),
    `üreten: ${[...retailerSet].join(",")}`,
  );
  check(
    "beklenmeyen perakendeci etiketi yok",
    [...retailerSet].every((r) => (RETAILERS as string[]).includes(r)),
  );
  check(
    "tüm satırlarda geçerli week_start",
    allRows.every((r) => /^\d{4}-\d{2}-\d{2}$/.test(r.week_start)),
  );
  check(
    "week_end her zaman week_start + 6 gün (kanonik hafta)",
    allRows.every(
      (r) =>
        (new Date(r.week_end + "T00:00:00Z").getTime() -
          new Date(r.week_start + "T00:00:00Z").getTime()) /
          86400000 ===
        6,
    ),
  );
  check(
    "tüm haftalar Pazartesi'ye hizalı (firmalar aynı haftada birleşir)",
    allRows.every(
      (r) => new Date(r.week_start + "T00:00:00Z").getUTCDay() === 1,
    ),
  );
  check(
    "sales_qty makul aralıkta (iadeler dahil)",
    allRows.every((r) => r.sales_qty > -1000 && r.sales_qty < 1e6),
  );
  check(
    "stock_qty negatif değil (sanitize sonrası)",
    allRows.every((r) => r.stock_qty >= 0),
  );
  check(
    "stock_qty NaN değil",
    allRows.every(
      (r) => typeof r.stock_qty === "number" && !isNaN(r.stock_qty),
    ),
  );
  check(
    "sales_qty NaN değil",
    allRows.every((r) => !isNaN(r.sales_qty)),
  );
  check(
    "net haftalık satış pozitif (iadeler toplamı bozmuyor)",
    (() => {
      const byWeek = new Map<string, number>();
      for (const r of allRows)
        byWeek.set(
          `${r.retailer}|${r.week_start}`,
          (byWeek.get(`${r.retailer}|${r.week_start}`) ?? 0) + r.sales_qty,
        );
      return byWeek.size > 0 && [...byWeek.values()].every((v) => v > 0);
    })(),
  );
  // sanitizeRows sözleşmesi gerçek veride: junk SKU ve mojibake "?" kalmamalı.
  check(
    "placeholder SKU'lar (KULLANILMAYACAK) elendi",
    !allRows.some((r) => /KULLANILMAYACAK/i.test(r.sku_name ?? "")),
  );
  check(
    "SKU adlarında çift boşluk / NBSP kalmadı (normalizeSkuName gerçek veride)",
    !allRows.some((r) => /\s{2}|\u00A0/.test(r.sku_name ?? "")),
  );
  check(
    "SKU adlarında sondaki ', N/A' kalmadı",
    !allRows.some((r) => /,?\s*N\/A\s*$/i.test(r.sku_name ?? "")),
  );
  check(
    "SKU adları baş/son boşluksuz",
    allRows.every((r) => (r.sku_name ?? "") === (r.sku_name ?? "").trim()),
  );

  // Bilinen değer doğrulamaları (Python ETL ile birebir)
  const nezih1105 = allRows.filter(
    (r) => r.retailer === "Nezih" && r.week_start === "2026-05-11",
  );
  check(
    "Nezih 11.05 = 442 adet",
    approx(
      nezih1105.reduce((a, r) => a + r.sales_qty, 0),
      442,
      0.5,
    ),
    `${nezih1105.reduce((a, r) => a + r.sales_qty, 0)}`,
  );

  // DR Salı-başlangıçlı haftayı kanonik Pazartesi'ye (05-19 → 05-18) hizalar
  const dr1905 = allRows.filter(
    (r) => r.retailer === "DR" && r.week_start === "2026-05-18",
  );
  check(
    "DR 18.05 (kanonik, 19.05 Salı→Pzt) = 5598 adet",
    approx(
      dr1905.reduce((a, r) => a + r.sales_qty, 0),
      5598,
      0.5,
    ),
    `${dr1905.reduce((a, r) => a + r.sales_qty, 0)}`,
  );

  // ───────── 15b. ARMAĞAN — mağaza-bazlı + "Genel Toplam" çift-sayım kalkanı ─────────
  section("15b. Armağan normalizer (mağaza-bazlı, Genel Toplam elenmesi)");
  const arm = allRows.filter((r) => r.retailer === "Armağan");
  const armWeeks = [...new Set(arm.map((r) => r.week_start))].sort();
  check(
    "Armağan 4 dosya işlendi",
    byRetailerFiles.get("Armağan") === 4,
    `${byRetailerFiles.get("Armağan")}`,
  );
  check(
    "Armağan 4 ayrı hafta üretti (W-NN dalı her dosyayı ayrı haftaya yazdı)",
    armWeeks.length === 4,
    armWeeks.join(","),
  );
  check(
    "Armağan haftaları 7 gün arayla ardışık",
    armWeeks.every(
      (w, i) =>
        i === 0 ||
        (new Date(w).getTime() - new Date(armWeeks[i - 1]).getTime()) /
          86400000 ===
          7,
    ),
    armWeeks.join(","),
  );
  check(
    "Armağan satır sayısı makul (>25K, mağaza×ürün)",
    arm.length > 25000,
    `${arm.length}`,
  );
  check(
    "Armağan mağaza-bazlı: her satırda Lokasyon dolu",
    arm.length > 0 && arm.every((r) => !!r.store),
  );
  check(
    "Armağan ~105 mağaza",
    (() => {
      const n = new Set(arm.map((r) => r.store)).size;
      return n >= 100 && n <= 115;
    })(),
    `${new Set(arm.map((r) => r.store)).size} mağaza`,
  );
  check(
    "Armağan 'Genel Toplam' satırı ELENDİ (store'da toplam kalıntısı yok)",
    !arm.some((r) => /toplam/i.test(r.store ?? "")),
  );
  check(
    "Armağan barkodları 6-14 hane",
    arm.length > 0 &&
      arm.every((r) => r.barkod === null || /^\d{6,14}$/.test(r.barkod)),
  );
  check(
    "Armağan ciro = PSF × adet (dosyada ciro yok, türetiliyor)",
    (() => {
      const satan = arm.filter((r) => r.sales_qty > 0 && r.price != null);
      return (
        satan.length > 0 &&
        satan.every((r) =>
          approx(r.sales_value ?? 0, r.price! * r.sales_qty, 0.01),
        )
      );
    })(),
  );
  check(
    "Armağan satmayan satırda ciro 0 (null değil)",
    arm.filter((r) => r.sales_qty === 0).every((r) => r.sales_value === 0),
  );

  // ÇİFT-SAYIM TESTİ: dosyanın kendi "Genel Toplam" satırındaki adetle karşılaştır.
  // Genel Toplam elenmezse normalize toplam TAM 2× olur. Bu test sabit sayı
  // içermez — dosyanın kendi kontrol toplamına karşı doğrular.
  const armFile = "MYTHOS CARD W-19 2026 RAPOR.xlsx";
  const armPath = join(seedRoot, "armagan", armFile);
  if (existsSync(armPath)) {
    const b = readFileSync(armPath);
    const wb = XLSX.read(
      b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength),
      { type: "array" },
    );
    const aoa: any[][] = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], {
      header: 1,
      defval: null,
      raw: true,
    });
    const hdr = (aoa[0] ?? []).map((c) => String(c ?? "").trim());
    const qtyCol = hdr.indexOf("Satış Miktarı"),
      stockCol = hdr.indexOf("Geçmiş Stok Miktarı");
    const gt = aoa.find((row) =>
      /genel\s*toplam/i.test(String(row?.[0] ?? "")),
    );
    const armW19 = allRows.filter(
      (r) => r.retailer === "Armağan" && r.source_file === armFile,
    );
    const normQty = armW19.reduce((a, r) => a + r.sales_qty, 0);
    const normStock = armW19.reduce((a, r) => a + r.stock_qty, 0);
    check(
      "Armağan dosyasında 'Genel Toplam' kontrol satırı bulundu",
      !!gt && qtyCol >= 0 && stockCol >= 0,
      `qtyCol=${qtyCol} stockCol=${stockCol}`,
    );
    if (gt && qtyCol >= 0 && stockCol >= 0) {
      const gtQty = toNum(gt[qtyCol]),
        gtStock = toNum(gt[stockCol]);
      check(
        "Armağan adet = dosyanın Genel Toplam adedi (çift sayım YOK)",
        approx(normQty, gtQty, 0.5),
        `normalize ${normQty} vs Genel Toplam ${gtQty}`,
      );
      check(
        "Armağan adet 2× DEĞİL (Genel Toplam satırı toplama karışmadı)",
        !approx(normQty, gtQty * 2, 0.5),
        `${normQty} vs 2× ${gtQty * 2}`,
      );
      // Negatif stok 0'a çekildiği için normalize stok kontrol toplamından BÜYÜK
      // olabilir; ama asla 2× olamaz (o çift sayım demektir).
      check(
        "Armağan stok kontrol toplamından küçük değil (negatifler 0'a çekildi)",
        normStock >= gtStock,
        `normalize ${normStock} vs Genel Toplam ${gtStock}`,
      );
      check(
        "Armağan stok 2× DEĞİL",
        normStock < gtStock * 1.5,
        `${normStock} vs ${gtStock}`,
      );
    }
  } else {
    check("Armağan W-19 örnek dosyası mevcut", false, armFile + " yok");
  }

  // ───────── 15c. HUPPALUPPO — offsetli başlık + dosya içi tarih ─────────
  section("15c. Huppaluppo normalizer (offsetli başlık, dosya içi tarih)");
  const hup = allRows.filter((r) => r.retailer === "Huppaluppo");
  const hupWeeks = [...new Set(hup.map((r) => r.week_start))].sort();
  check(
    "Huppaluppo 3 dosya işlendi",
    byRetailerFiles.get("Huppaluppo") === 3,
    `${byRetailerFiles.get("Huppaluppo")}`,
  );
  check(
    "Huppaluppo 3 ayrı hafta (hafta dosya İÇİNDEKİ tarihten okundu)",
    hupWeeks.length === 3,
    hupWeeks.join(","),
  );
  check(
    "Huppaluppo haftaları 7 gün arayla ardışık",
    hupWeeks.every(
      (w, i) =>
        i === 0 ||
        (new Date(w).getTime() - new Date(hupWeeks[i - 1]).getTime()) /
          86400000 ===
          7,
    ),
    hupWeeks.join(","),
  );
  check(
    "Huppaluppo satır sayısı makul (dosya başına ~40-60 ürün)",
    (() => {
      const perWeek = hupWeeks.map(
        (w) => hup.filter((r) => r.week_start === w).length,
      );
      return perWeek.length === 3 && perWeek.every((n) => n >= 40 && n <= 60);
    })(),
    hupWeeks
      .map((w) => `${w}:${hup.filter((r) => r.week_start === w).length}`)
      .join(" "),
  );
  check(
    "Huppaluppo mağaza-bazlı DEĞİL (store null)",
    hup.length > 0 && hup.every((r) => r.store === null),
  );
  check(
    "Huppaluppo her satırda geçerli barkod (footer/toplam satırları elendi)",
    hup.length > 0 &&
      hup.every((r) => r.barkod != null && /^\d{6,14}$/.test(r.barkod)),
  );
  check(
    "Huppaluppo 'Toplam' satırı sızmadı",
    !hup.some((r) => /toplam/i.test(r.sku_name ?? "")),
  );
  check(
    "Huppaluppo ciro dosyadan geliyor (TL kolonu var)",
    (() => {
      const satan = hup.filter((r) => r.sales_qty > 0);
      return (
        satan.length > 0 &&
        satan.every((r) => r.sales_value != null && r.sales_value > 0)
      );
    })(),
  );
  check(
    "Huppaluppo satış negatif değil (Math.max ile 0'a çekiliyor)",
    hup.every((r) => r.sales_qty >= 0),
  );
  check(
    "Huppaluppo haftalık adet makul aralıkta (100-2000)",
    (() => {
      const perWeek = hupWeeks.map((w) =>
        hup
          .filter((r) => r.week_start === w)
          .reduce((a, r) => a + r.sales_qty, 0),
      );
      return perWeek.every((q) => q >= 100 && q <= 2000);
    })(),
    hupWeeks
      .map(
        (w) =>
          `${w}:${hup.filter((r) => r.week_start === w).reduce((a, r) => a + r.sales_qty, 0)}`,
      )
      .join(" "),
  );
  check(
    "Huppaluppo stok makul (10K-25K, ürün başına gerçekçi)",
    (() => {
      const perWeek = hupWeeks.map((w) =>
        hup
          .filter((r) => r.week_start === w)
          .reduce((a, r) => a + r.stock_qty, 0),
      );
      return perWeek.every((s) => s >= 10000 && s <= 25000);
    })(),
    hupWeeks
      .map(
        (w) =>
          `${w}:${hup.filter((r) => r.week_start === w).reduce((a, r) => a + r.stock_qty, 0)}`,
      )
      .join(" "),
  );

  // HAFTA OVERRIDE'I HUPPALUPPO'DA DA KAZANIR. Ölçülen hata: override 2026-01-05
  // verilirken dosya-içi aralık (11.05-17.05) kazanıp 2026-05-11 yazılıyordu;
  // diğer 4 firma seçimi uyguluyordu. Yükleme ekranı "seçim her dosyaya
  // uygulanır" derken bu firmada yalan söylüyordu. Override yokken dosya-içi
  // tarih yine esas (eski davranış korunur).
  {
    const hupDir = join(seedRoot, "huppaluppo");
    const hupFile = readdirSync(hupDir).find(
      (f) => /\.xlsx?$/i.test(f) && !f.startsWith("~$"),
    )!;
    const hb = readFileSync(join(hupDir, hupFile));
    const hab = hb.buffer.slice(
      hb.byteOffset,
      hb.byteOffset + hb.byteLength,
    ) as ArrayBuffer;
    const ov = canonicalWeek({ start: "2026-01-05", end: "2026-01-05" });
    const withOv = normalizeFile(hab, "Huppaluppo", hupFile, ov);
    const noOv = normalizeFile(hab, "Huppaluppo", hupFile);
    check(
      "Huppaluppo: elle seçilen hafta dosya-içi tarihi EZER",
      withOv[0]?.week_start === "2026-01-05",
      `${hupFile}: yazılan ${withOv[0]?.week_start}`,
    );
    check(
      "Huppaluppo: override yokken dosya-içi tarih esas (eski davranış)",
      noOv[0]?.week_start === "2026-05-11",
      `yazılan ${noOv[0]?.week_start}`,
    );
  }

  // ───────── 16. COMPUTE (gerçek veri) ─────────
  section("16. Compute katmanı (gerçek veri)");
  const facts: FactRow[] = allRows.map((r) => ({
    retailer: r.retailer,
    week_start: r.week_start,
    store: r.store,
    sku_name: r.sku_name,
    barkod: r.barkod,
    sales_qty: r.sales_qty,
    sales_value: r.sales_value,
    stock_qty: r.stock_qty,
  }));
  const retailersInData = [...new Set(facts.map((f) => f.retailer))];
  const weeksOf = (ret: string) =>
    [
      ...new Set(
        facts.filter((f) => f.retailer === ret).map((f) => f.week_start),
      ),
    ].sort();

  const summary = buildSummary(facts);
  check("summary boş değil", summary.length > 0, `${summary.length} satır`);
  check(
    "summary 5 perakendeci",
    new Set(summary.map((s) => s.retailer)).size === 5,
    `${new Set(summary.map((s) => s.retailer)).size}`,
  );
  check(
    "summary satır sayısı = benzersiz firma×hafta",
    summary.length ===
      new Set(facts.map((f) => `${f.retailer}|${f.week_start}`)).size,
    `${summary.length}`,
  );
  check(
    "summary hafta artan sıralı",
    summary.every(
      (s, i) => i === 0 || summary[i - 1].week_start <= s.week_start,
    ),
  );
  check(
    "summary adet toplamı = ham adet toplamı",
    approx(
      summary.reduce((a, s) => a + s.sales_qty, 0),
      facts.reduce((a, f) => a + f.sales_qty, 0),
      1,
    ),
  );
  check(
    "summary stok toplamı = ham stok toplamı",
    approx(
      summary.reduce((a, s) => a + s.stock_qty, 0),
      facts.reduce((a, f) => a + f.stock_qty, 0),
      1,
    ),
  );

  // Insights — boş listede otomatik geçmesin diye ÖNCE dolu olduğunu doğrula.
  const insights = generateInsights(summary, []);
  check(
    "insights üretildi (boş liste değil)",
    insights.length > 0,
    `${insights.length} insight`,
  );
  check(
    "insights severity geçerli",
    insights.length > 0 &&
      insights.every((i) =>
        ["critical", "warning", "positive", "info"].includes(i.severity),
      ),
  );
  check(
    "insights kritik önce sıralı",
    (() => {
      const ord = { critical: 0, warning: 1, positive: 2, info: 3 };
      return (
        insights.length > 0 &&
        insights.every(
          (ins, i) =>
            i === 0 || ord[insights[i - 1].severity] <= ord[ins.severity],
        )
      );
    })(),
  );
  check(
    "insights her birinde başlık+detay+firma",
    insights.length > 0 &&
      insights.every((i) => !!i.title && !!i.detail && !!i.retailer),
  );
  check(
    "insights firmaları veri içinden",
    insights.every((i) => retailersInData.includes(i.retailer)),
  );
  check(
    "insights her firma için tahmin satırı var (info)",
    (() => {
      const tahminliler = new Set(
        insights
          .filter((i) => i.severity === "info" && i.title.includes("tahmin"))
          .map((i) => i.retailer),
      );
      // ≥2 haftalık veri gönderen her firma için tahmin üretilir.
      const beklenen = RETAILERS.filter((r) => weeksOf(r).length >= 2);
      return beklenen.every((r) => tahminliler.has(r));
    })(),
  );

  // Stockout risk — DR son 4 hafta
  const drAllWeeks = weeksOf("DR");
  const drWeeks = drAllWeeks.slice(-4);
  const drRecent = facts.filter(
    (f) => f.retailer === "DR" && drWeeks.includes(f.week_start),
  );
  const risks = findStockoutRisks(drRecent, "DR", drWeeks);
  check(
    "stockout risk bulundu (boş liste değil)",
    risks.length > 0,
    `${risks.length} risk`,
  );
  check(
    "stockout risk hepsi wos < 2 hafta",
    risks.length > 0 && risks.every((r) => r.wos < 2),
  );
  check(
    "stockout risk hepsi anlamlı hızda (≥3 adet/hafta)",
    risks.length > 0 && risks.every((r) => r.sales >= 3),
  );
  check(
    "stockout risk en acil önce",
    risks.every((r, i) => i === 0 || risks[i - 1].wos <= r.wos),
  );
  check("stockout risk en fazla 2 satır", risks.length <= 2);

  // ── STOK FOTOĞRAFI TAZELİĞİ ──
  // Bir firma iki hafta üst üste AYNI stok fotoğrafını gönderirse (kolon
  // güncellenmemiş) o firmanın stok-delta sinyalleri yapısal olarak sıfırdır:
  // declining hiç tetiklenmez, kapsam/ölü stok eski stokla hesaplanır. Sessiz bir
  // veri sorunu olduğu için taranıp uyarı olarak yükseltiliyor.
  const bayatStokFirma: string[] = [];
  let tazelikTarandi = 0;
  for (const ret of RETAILERS) {
    const w = weeksOf(ret);
    if (w.length < 2) continue;
    tazelikTarandi++;
    const son = w[w.length - 1],
      onceki = w[w.length - 2];
    const stokOf = (wk: string) => {
      const m = new Map<string, number>();
      for (const f of facts.filter(
        (x) => x.retailer === ret && x.week_start === wk,
      )) {
        m.set(f.sku_name, (m.get(f.sku_name) ?? 0) + f.stock_qty);
      }
      return m;
    };
    const a = stokOf(son),
      b = stokOf(onceki);
    const ortak = [...a.keys()].filter((k) => b.has(k));
    if (ortak.length >= 20 && ortak.every((k) => a.get(k) === b.get(k))) {
      bayatStokFirma.push(
        `${ret} (${onceki}→${son}, ${ortak.length} SKU birebir aynı)`,
      );
    }
  }
  check(
    "stok tazelik taraması ≥2 haftası olan tüm firmaları kapsadı",
    tazelikTarandi === RETAILERS.filter((r) => weeksOf(r).length >= 2).length,
    `${tazelikTarandi} firma`,
  );
  if (bayatStokFirma.length) {
    warn(
      `Stok fotoğrafı iki hafta üst üste BİREBİR AYNI: ${bayatStokFirma.join("; ")}. Satış değişiyor ama stok kolonu güncellenmemiş → o firmanın stok-delta sinyalleri (declining alarmı, kapsam trendi) yapısal olarak sıfır. Kaynak dosya ya da yükleme kontrol edilmeli; kod tarafında düzeltilebilecek bir şey yok.`,
    );
  }

  // Sipariş önceliği (reorder) — gerçek veri
  const reorder = reorderPriority(drRecent, drWeeks, 10);
  check("reorder satır üretti", reorder.length > 0, `${reorder.length} satır`);
  check(
    "reorder hepsi ort. satış >= 10",
    reorder.length > 0 && reorder.every((r) => r.avg_sales >= 10),
  );
  check(
    "reorder kapsam artan (aciliyet sırası)",
    reorder.length > 0 &&
      reorder.every(
        (r, i) => i === 0 || (reorder[i - 1].cover ?? 0) <= (r.cover ?? 0),
      ),
  );
  check(
    "reorder weeks_used = pencere boyu (4)",
    reorder.every((r) => r.weeks_used === 4),
  );
  check(
    "reorder tükendi => stok 0",
    reorder
      .filter((r) => r.status === "tükendi")
      .every((r) => r.stock_qty <= 0),
  );
  check(
    "reorder ewma pozitif ve trend geçerli",
    reorder.length > 0 &&
      reorder.every(
        (r) => r.ewma > 0 && ["up", "down", "flat"].includes(r.trend),
      ),
  );
  // cover_ewma çıktıdaki YUVARLANMIŞ ewma'dan yeniden kurulamaz (ewma 1 ondalığa
  // yuvarlanıyor; stok büyüdükçe sapma oransal olarak büyür). Bu yüzden bağıl
  // tolerans: formül yanlış olsa (ör. ort. satışa bölünse) sapma %0,5'i çok aşar.
  check(
    "reorder cover_ewma ≈ stok / ewma (bağıl %0,5 tolerans)",
    reorder.length > 0 &&
      reorder.every((r) => {
        if (r.cover_ewma == null) return true;
        const beklenen = r.stock_qty / r.ewma;
        return (
          Math.abs(r.cover_ewma - beklenen) <= Math.max(0.15, beklenen * 0.005)
        );
      }),
  );
  check(
    "reorder ivmelenende cover_ewma kapsamdan kısa, yavaşlayanda uzun",
    reorder
      .filter((r) => r.cover != null && r.cover_ewma != null)
      .every((r) =>
        r.trend === "up"
          ? r.cover_ewma! <= r.cover!
          : r.trend === "down"
            ? r.cover_ewma! >= r.cover!
            : true,
      ),
  );
  // cover çıktıda 1 ondalığa yuvarlanıyor (ham 1,9583 → 2,0), bu yüzden eşik
  // karşılaştırmasında ±0,05 pay bırakılır.
  check(
    "reorder durum ile kapsam tutarlı (yuvarlama payıyla)",
    reorder.every((r) =>
      r.status === "tükendi"
        ? r.stock_qty <= 0
        : r.status === "acil"
          ? (r.cover ?? 0) < 1.05
          : r.status === "izle"
            ? (r.cover ?? 0) >= 0.95 && (r.cover ?? 0) <= 2.05
            : (r.cover ?? 0) >= 1.95,
    ),
  );
  // Yuvarlamadan ETKİLENMEYEN daha güçlü değişmez: liste kapsama göre artan
  // sıralı olduğu için durumlar da aciliyet sırasını bozmadan ilerlemeli.
  check(
    "reorder durum sırası kapsam sırasıyla uyumlu (aciliyet gerilemez)",
    (() => {
      const rank = { tükendi: 0, acil: 1, izle: 2, yeterli: 3 } as const;
      return reorder.every(
        (r, i) => i === 0 || rank[reorder[i - 1].status] <= rank[r.status],
      );
    })(),
    reorder
      .map((r) => r.status)
      .filter((s, i, a) => s !== a[i - 1])
      .join(">"),
  );

  // Ürün pivot — barkodu olan bir SKU
  const sampleBarkod = facts.find(
    (f) => f.barkod && f.retailer === "Nezih",
  )?.barkod;
  check("pivot için barkodlu Nezih satırı var", !!sampleBarkod);
  if (sampleBarkod) {
    const prodRows = facts.filter((f) => f.barkod === sampleBarkod);
    const pivot = pivotProduct(prodRows);
    check("pivot name var", !!pivot.name);
    check(
      "pivot hafta ve seri dolu",
      pivot.weeks.length > 0 && pivot.series.length > 0,
    );
    check(
      "pivot weeks artan sıralı",
      pivot.weeks.every((w, i) => i === 0 || pivot.weeks[i - 1] <= w),
    );
    check(
      "pivot series hafta sayısı eşleşir",
      pivot.series.length === pivot.weeks.length,
    );
    check(
      "pivot totals retailer eşleşir",
      pivot.totals.length === pivot.retailers.length &&
        pivot.retailers.length > 0,
    );
    check(
      "pivot toplam adet = ham toplam",
      approx(
        pivot.totals.reduce((a, t) => a + t.total_qty, 0),
        prodRows.reduce((a, r) => a + r.sales_qty, 0),
        1,
      ),
    );
    check(
      "pivot her firmanın last_week'i kendi son haftası",
      pivot.totals.every((t) => {
        const own = [
          ...new Set(
            prodRows
              .filter((r) => r.retailer === t.retailer)
              .map((r) => r.week_start),
          ),
        ].sort();
        return t.last_week === own[own.length - 1];
      }),
    );
  }

  // ───────── 17. KATEGORİ, MAĞAZA, SIRALAMA (gerçek veri) ─────────
  section("17. Kategori, mağaza, global sıralama (gerçek veri)");
  const drLatestWk = drAllWeeks[drAllWeeks.length - 1];
  const drLatestRows = facts.filter(
    (f) => f.retailer === "DR" && f.week_start === drLatestWk,
  );
  const byTeam = categoryBreakdown(drLatestRows, "team");
  const byBrand = categoryBreakdown(drLatestRows, "brand");
  const byType = categoryBreakdown(drLatestRows, "type");
  check("kategori team boş değil", byTeam.length > 0);
  check("kategori brand boş değil", byBrand.length > 0);
  check("kategori type boş değil", byType.length > 0);
  check(
    "kategori satış sıralı (azalan)",
    byTeam.every((c, i) => i === 0 || byTeam[i - 1].sales_qty >= c.sales_qty),
  );
  check(
    "kategori toplam = ham toplam (hiçbir satır kaybolmuyor)",
    (() => {
      const rawTotal = drLatestRows.reduce((a, r) => a + r.sales_qty, 0);
      return [byTeam, byBrand, byType].every((b) =>
        approx(
          b.reduce((a, c) => a + c.sales_qty, 0),
          rawTotal,
          1,
        ),
      );
    })(),
  );
  check(
    "kategori SKU sayıları toplamı ≥ benzersiz SKU",
    (() => {
      const uniq = new Set(drLatestRows.map((r) => r.sku_name)).size;
      return byBrand.reduce((a, c) => a + c.sku_count, 0) === uniq;
    })(),
  );

  // globalRankings — prevByKey ÜRETİM ile aynı anahtarla kurulmalı (productKey).
  // ESKİ TEST HATASI: anahtar `${retailer}|${sku_name}` idi; globalRankings ise
  // productKey (barkod / 'NAME:'+ad) ile arıyor → hiç eşleşmiyor, growth daima null,
  // risers/fallers DAİMA BOŞ kalıyordu ve iki assert boş listede otomatik geçiyordu.
  const latestByRetailer = new Map<string, string>();
  for (const ret of retailersInData) {
    const w = weeksOf(ret);
    if (w.length) latestByRetailer.set(ret, w[w.length - 1]);
  }
  const rankLatest = facts.filter(
    (f) => latestByRetailer.get(f.retailer) === f.week_start,
  );
  const prevByKey = new Map<string, { qty: number; val: number }>();
  for (const ret of retailersInData) {
    const w = weeksOf(ret);
    if (w.length < 2) continue;
    const prevWk = w[w.length - 2];
    for (const f of facts.filter(
      (x) => x.retailer === ret && x.week_start === prevWk,
    )) {
      const k = productKey(f.retailer, f.sku_name, f.barkod);
      const e = prevByKey.get(k) ?? { qty: 0, val: 0 };
      e.qty += f.sales_qty;
      e.val += f.sales_value ?? 0;
      prevByKey.set(k, e);
    }
  }
  check(
    "prevByKey üretimle aynı anahtarla kuruldu (dolu)",
    prevByKey.size > 0,
    `${prevByKey.size} anahtar`,
  );
  const rankings = globalRankings(rankLatest, prevByKey, "qty");
  check("rankings top dolu", rankings.top.length > 0, `${rankings.top.length}`);
  check(
    "rankings top adet azalan sıralı",
    rankings.top.every(
      (r, i) => i === 0 || rankings.top[i - 1].sales_qty >= r.sales_qty,
    ),
  );
  check("rankings top max 20", rankings.top.length <= 20);
  check(
    "rankings risers DOLU (prevByKey eşleşiyor)",
    rankings.risers.length > 0,
    `${rankings.risers.length} riser`,
  );
  check(
    "rankings fallers DOLU",
    rankings.fallers.length > 0,
    `${rankings.fallers.length} faller`,
  );
  check(
    "rankings risers büyüme azalan sıralı ve hepsi hesaplanmış",
    rankings.risers.length > 0 &&
      rankings.risers.every(
        (r, i) =>
          r.growth != null &&
          (i === 0 || (rankings.risers[i - 1].growth ?? 0) >= r.growth),
      ),
  );
  check(
    "rankings fallers büyüme artan sıralı (en sert düşüş önce)",
    rankings.fallers.length > 0 &&
      rankings.fallers.every(
        (r, i) =>
          r.growth != null &&
          (i === 0 || (rankings.fallers[i - 1].growth ?? 0) <= r.growth),
      ),
  );
  check(
    "rankings en iyi riser en kötü faller'dan büyük",
    (rankings.risers[0].growth ?? 0) > (rankings.fallers[0].growth ?? 0),
  );
  check(
    "rankings movers anlamlılık tabanını geçti (adet ≥ 5)",
    [...rankings.risers, ...rankings.fallers].every(
      (r) => r.sales_qty >= 5 && r.prev_qty >= 5,
    ),
  );
  check(
    "rankings her satırda en az bir firma",
    rankings.top.every((r) => r.retailers.length > 0),
  );

  // ───────── 18. EXECUTIVE ÖZET & DÖNEM KARŞILAŞTIRMA (gerçek veri) ─────────
  section("18. Executive özet & dönem karşılaştırma (gerçek veri)");
  const exec = execOverview(summary);
  check("exec latest_week var", exec.latest_week !== null);
  check("exec ağ satışı pozitif", exec.network.sales_qty > 0);
  check("exec perakendeci listesi dolu", exec.retailers.length > 0);
  check(
    "exec payların toplamı ~100",
    (() => {
      const sum = exec.retailers.reduce((a, r) => a + r.share, 0);
      return exec.retailers.length > 0 && approx(sum, 100, 0.5);
    })(),
  );
  check(
    "exec satış azalan sıralı",
    exec.retailers.every(
      (r, i) => i === 0 || exec.retailers[i - 1].sales_qty >= r.sales_qty,
    ),
  );
  check(
    "exec status geçerli",
    exec.retailers.every((r) =>
      ["up", "down", "flat", "nodata"].includes(r.status),
    ),
  );
  check(
    "exec ağ satışı = perakendeci toplamı",
    approx(
      exec.network.sales_qty,
      exec.retailers.reduce((a, r) => a + r.sales_qty, 0),
      1,
    ),
  );
  check(
    "exec status WoW ile tutarlı (±%2 bandı flat)",
    exec.retailers.every((r) =>
      r.wow == null
        ? r.status === "nodata"
        : r.wow > 2
          ? r.status === "up"
          : r.wow < -2
            ? r.status === "down"
            : r.status === "flat",
    ),
  );
  // Gerçek veride kapı GEÇİLİYOR (≥2 firma taban üstünde) → best/worst DOLU olmalı.
  // Eski test `if (!best) return true` ile kendini iptal ediyordu.
  check(
    "exec best/worst gerçek veride DOLU (kapı geçildi)",
    exec.best !== null && exec.worst !== null,
    `best=${JSON.stringify(exec.best)} worst=${JSON.stringify(exec.worst)}`,
  );
  check(
    "exec best WoW ≥ worst WoW",
    exec.best !== null &&
      exec.worst !== null &&
      exec.best.wow >= exec.worst.wow,
  );
  check(
    "exec best ve worst farklı firma",
    exec.best?.retailer !== exec.worst?.retailer,
  );
  check(
    "exec best/worst veri gönderen firmalardan",
    (() => {
      const dataRets = exec.retailers
        .filter((r) => r.has_data)
        .map((r) => r.retailer);
      return (
        exec.best != null &&
        exec.worst != null &&
        dataRets.includes(exec.best.retailer) &&
        dataRets.includes(exec.worst.retailer)
      );
    })(),
  );
  check(
    "exec best/worst ciro tabanını geçen firmalardan",
    (() => {
      if (!exec.best) return false;
      const floor = Math.max(25000, exec.network.sales_value * 0.05);
      const b = exec.retailers.find((r) => r.retailer === exec.best!.retailer)!;
      const w = exec.retailers.find(
        (r) => r.retailer === exec.worst!.retailer,
      )!;
      // Ciro dalı kullanıldıysa ikisi de taban üstünde olmalı.
      return (
        b.value_wow == null ||
        ((b.sales_value ?? 0) >= floor && (w.sales_value ?? 0) >= floor)
      );
    })(),
  );
  check(
    "exec ağ WoW'u yalnız iki haftası olan firmalardan",
    exec.network.wow_qty !== null,
  );

  // Dönem karşılaştırma — DR son iki hafta
  check(
    "karşılaştırma için en az 2 hafta var",
    drAllWeeks.length >= 2,
    `${drAllWeeks.length} hafta`,
  );
  if (drAllWeeks.length >= 2) {
    const wa = drAllWeeks[drAllWeeks.length - 2],
      wb = drAllWeeks[drAllWeeks.length - 1];
    const aRows = facts.filter(
      (f) => f.retailer === "DR" && f.week_start === wa,
    );
    const bRows = facts.filter(
      (f) => f.retailer === "DR" && f.week_start === wb,
    );
    const cmp = comparePeriods(aRows, bRows);
    check(
      "karşılaştırma gainers dolu",
      cmp.gainers.length > 0,
      `${cmp.gainers.length}`,
    );
    check(
      "karşılaştırma gainers delta azalan",
      cmp.gainers.length > 0 &&
        cmp.gainers.every(
          (c, i) => i === 0 || cmp.gainers[i - 1].delta >= c.delta,
        ),
    );
    check(
      "karşılaştırma losers delta artan",
      cmp.losers.length > 0 &&
        cmp.losers.every(
          (c, i) => i === 0 || cmp.losers[i - 1].delta <= c.delta,
        ),
    );
    check(
      "yeni SKU listesi dolu ve a=0 b>0",
      cmp.newSkus.length > 0 &&
        cmp.newSkus.every((c) => c.a_qty === 0 && c.b_qty > 0),
      `${cmp.newSkus.length} yeni`,
    );
    check(
      "kaybolan SKU listesi dolu ve a>0 b=0",
      cmp.lostSkus.length > 0 &&
        cmp.lostSkus.every((c) => c.a_qty > 0 && c.b_qty === 0),
      `${cmp.lostSkus.length} kaybolan`,
    );
    check("gainers max 20", cmp.gainers.length <= 20);
    check(
      "delta = b − a (her satırda)",
      [...cmp.gainers, ...cmp.losers].every(
        (c) => c.delta === c.b_qty - c.a_qty,
      ),
    );
  }

  // Seed'e bağlı test sayısını ÖLÇ ve sabitle karşılaştır (sabit kayarsa düşer).
  const olculen = passed + failed - seedOncesi;
  check(
    `seed'e bağlı test sayısı sabiti güncel (SEED_TEST_SAYISI=${SEED_TEST_SAYISI})`,
    olculen === SEED_TEST_SAYISI,
    `ölçülen ${olculen} — sabiti ${olculen} yap`,
  );
}

// ───────────────────────── SONUÇ ─────────────────────────
console.log(`\n${"═".repeat(50)}`);
console.log(`SONUÇ: ${passed} geçti, ${failed} başarısız, ${skipped} atlandı`);
if (warnings.length) {
  console.log(
    `\n⚠ Dikkat (${warnings.length}) — test düşürmedi ama not edildi:`,
  );
  warnings.forEach((w) => console.log("  ⚠ " + w));
}
if (failed > 0) {
  console.log("\nBaşarısız testler:");
  failures.forEach((f) => console.log("  " + f));
  process.exit(1);
} else if (seedYok) {
  console.log(
    `\n✗ SEED YOK — suite ${skipped} test ATLADI, bu yüzden GEÇMİŞ SAYILMAZ.`,
  );
  process.exit(1);
} else {
  console.log("✓ TÜM TESTLER GEÇTİ — 0 hata");
  process.exit(0);
}
