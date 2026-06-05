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

export function normalizeNezih(rows: Row[], week: WeekRange, sourceFile: string): UnifiedRow[] {
  if (rows.length === 0) {
    throw new Error("Nezih dosyası boş — yeniden iste.");
  }
  const cols = Object.keys(rows[0]);
  const colBarkod = matchCol(cols, ["barkod", "ean"]);
  const colName = matchCol(cols, ["urunadi", "adi", "urun"]);
  const colSales = matchCol(cols, ["satis", "satisadet", "satisadedi", "satismiktar", "satismiktari", "cikis", "cikisadet", "cikisadedi", "cikismiktar", "cikismiktari"]);
  const colStock = matchCol(cols, ["stok", "mevcutstok"]);

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

    let salesQty = num(r[colSales!]);
    salesQty = isCikis ? Math.max(-salesQty, 0) : Math.max(salesQty, 0);

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
