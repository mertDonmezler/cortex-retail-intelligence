// Nezih — agrega, barkodlu, TL yok. Python nezih.py portu.
// Esnek kolon eşleştirme + "Çıkış" (negatif=satış) semantiği.
import type { UnifiedRow } from "./types";
import type { WeekRange } from "./week-parser";
import { toNum as num } from "./num";

type Row = Record<string, unknown>;

const TR_FOLD: Record<string, string> = {
  ı: "i", İ: "i", ş: "s", Ş: "s", ğ: "g", Ğ: "g",
  ü: "u", Ü: "u", ö: "o", Ö: "o", ç: "c", Ç: "c",
};
function fold(s: string): string {
  return s.split("").map((c) => TR_FOLD[c] ?? c).join("")
    .toLowerCase().replace(/[\s_/\-.]+/g, "");
}
function matchCol(cols: string[], candidates: string[]): string | null {
  const folded = new Map(cols.map((c) => [fold(c), c]));
  for (const cand of candidates) {
    const hit = folded.get(fold(cand));
    if (hit) return hit;
  }
  return null;
}

// BAŞLIK SATIRI ÜSTTE DEĞİLSE (2-8 Kasım 2026): dosyanın ilk satırı rapor adı +
// tarih ("Stok Raporu" | "2.11.2026-8.11.2026"), gerçek başlıklar (StkID / Barkod /
// Ürün Adı / Satış / Stok) ikinci satırda. Dağıtıcı ilk satırı başlık sandığı için
// kolonlar "__EMPTY" adıyla geliyor ve dosya "eksik kolon" diye reddediliyordu.
// Barkod ve stok başlığını değer olarak taşıyan satır (ilk 10) aranır; kolonlar
// ondan yeniden adlandırılır, üstündeki satırlar atılır. Başlık zaten üstteyse
// satırlar aynen döner (eski davranış).
function basligiBul(rows: Row[]): Row[] {
  const cols = Object.keys(rows[0]);
  if (matchCol(cols, ["barkod", "ean"]) && matchCol(cols, ["kalanstok", "stok", "mevcutstok"])) return rows;
  for (let i = 0; i < Math.min(10, rows.length); i++) {
    const ad = new Map<string, string>();
    for (const k of Object.keys(rows[i])) {
      const v = String(rows[i][k] ?? "").trim();
      if (v) ad.set(k, v);
    }
    const degerler = [...ad.values()];
    if (!matchCol(degerler, ["barkod", "ean"]) || !matchCol(degerler, ["kalanstok", "stok", "mevcutstok"])) continue;
    return rows.slice(i + 1).map((r) => {
      const o: Row = {};
      for (const [k, yeni] of ad) o[yeni] = r[k];
      return o;
    });
  }
  return rows;
}

export function normalizeNezih(rows: Row[], week: WeekRange, sourceFile: string): UnifiedRow[] {
  if (rows.length === 0) {
    throw new Error("Nezih dosyası boş — yeniden iste.");
  }
  rows = basligiBul(rows);
  if (rows.length === 0) {
    throw new Error("Nezih dosyası boş — yeniden iste.");
  }
  const cols = Object.keys(rows[0]);
  const colBarkod = matchCol(cols, ["barkod", "ean"]);
  const colName = matchCol(cols, ["urunadi", "adi", "urun"]);
  const colSales = matchCol(cols, ["satis", "satisadet", "satisadedi", "satismiktar", "satismiktari", "cikis", "cikisadet", "cikisadedi", "cikismiktar", "cikismiktari"]);
  // STOK = HAFTA SONU (KAPANIŞ) STOKU. Eylül 2026 formatı "Stok / Satış / Kalan
  // Stok" gönderiyor ve orada "Stok" haftanın AÇILIŞ stokudur (ölçülen: 32/32
  // satırda Kalan Stok = Stok − Satış; açılış 17 üründe önceki haftanın
  // kapanışından +513 fazla, yani hafta içi girişi de taşıyor). Eski format
  // "Önceki / Satış / Stok" idi ve orada "Stok" zaten kapanıştı. Aday sırası bu
  // yüzden önemli: "Kalan Stok" varsa o kazanır, yoksa eski davranış aynen sürer.
  const colStock = matchCol(cols, ["kalanstok", "stok", "mevcutstok"]);

  const missing: string[] = [];
  if (!colBarkod) missing.push("Barkod");
  if (!colName) missing.push("Ürün Adı");
  if (!colSales) missing.push("Satış/Çıkış");
  if (!colStock) missing.push("Stok");
  if (missing.length) {
    throw new Error(`Nezih eksik kolon: ${missing.join(", ")}. Bulunan: ${cols.join(", ")}`);
  }

  // "Çıkış" kolonu negatif=satış mantığında — işareti tersine çevir
  const isCikis = fold(colSales!).includes("cikis");

  const out: UnifiedRow[] = [];
  for (const r of rows) {
    const barkod = String(r[colBarkod!] ?? "").replace(/\.0$/, "").trim();
    if (!/^\d{6,14}$/.test(barkod)) continue; // TOPLAMLAR vs.
    const nameVal = String(r[colName!] ?? "").trim();
    if (/toplam/i.test(nameVal)) continue;

    // NEGATIF SATIS KORUNUR — index.ts'teki ortak kuralla ayni ("gercek iade/
    // duzeltme satiridir"). Eski hal ikisini de 0'a kirpiyordu, yani Nezih'te
    // iade satirlari sessizce kayboluyor ve /api/health'in neg_sales sayaci bu
    // kanalda yapisal olarak hep 0 cikiyordu.
    // "Cikis" kolonu negatif=satis mantiginda geldigi icin yalniz ISARET cevrilir.
    let salesQty = num(r[colSales!]);
    if (isCikis) salesQty = -salesQty;

    out.push({
      retailer: "Nezih",
      week_start: week.start,
      week_end: week.end,
      store: null,
      sku_name: nameVal,
      sku_id: null,
      barkod,
      price: null,
      sales_qty: salesQty,
      sales_value: null, // enrichment ile dolacak
      stock_qty: num(r[colStock!]),
      source_file: sourceFile,
    });
  }
  return out;
}
