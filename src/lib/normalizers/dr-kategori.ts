// D&R yeni format — "Satin Alma - Kategori HaftalikSatisStokRapor.xlsx".
// Kolonlar: Urun / Urun Id / Barkod / Satis Miktar / Stok Miktar /
// Web Depo Stok Miktar / Offline Depo Stok Miktar. Asepto DEĞİL: mağaza
// kırılımı yok, tarih yok (hafta dosya adından ya da yükleme override'ından
// gelir), fiyat yok (ciro'yu barkod-medyan enrichment doldurur).
// Stok = "Stok Miktar" (mağaza rafı); web/offline depo kolonları BİLEREK hariç —
// bizim stok metriğimiz satılabilir kanal stoğu.
import type { UnifiedRow } from "./types";
import type { WeekRange } from "./week-parser";
import { toNum as num } from "./num";

type Row = Record<string, unknown>;

const TR_FOLD: Record<string, string> = {
  ı: "i", İ: "i", I: "i", ş: "s", Ş: "s", ğ: "g", Ğ: "g",
  ü: "u", Ü: "u", ö: "o", Ö: "o", ç: "c", Ç: "c",
};
function fold(s: string): string {
  return s.split("").map((c) => TR_FOLD[c] ?? c).join("")
    .toLowerCase().replace(/[\s_/\-.]+/g, "");
}

// Format parmak izi: "Urun Id" + "Satis Miktar" + "Stok Miktar" birlikte VE
// "Magaza"/"Satis Tutar" YOK. Negatif koşullar şart: D&R'nin ESKİ mağaza-bazlı
// formatı (Magaza/Urun/UrunId/Barkod/Satis Miktar/Satis Tutar/Stok Miktar) aynı
// üçlüyü içerir — o dosyalar Asepto'da kalmalı (mağaza kırılımı + gerçek TL ciro
// taşırlar; buraya düşerse ikisi de kaybolur — test paketinin yakaladığı hata).
export function isDrKategori(cols: string[]): boolean {
  const f = cols.map(fold);
  return (
    f.includes("urunid") && f.includes("satismiktar") && f.includes("stokmiktar") &&
    !f.includes("magaza") && !f.includes("satistutar")
  );
}

export function normalizeDrKategori(rows: Row[], week: WeekRange, sourceFile: string): UnifiedRow[] {
  if (rows.length === 0) {
    throw new Error("D&R dosyası boş — yeniden iste.");
  }
  const cols = Object.keys(rows[0]);
  const find = (...cands: string[]) => cols.find((c) => cands.includes(fold(c))) ?? null;
  const colName = find("urun", "urunadi");
  const colId = find("urunid");
  const colBarkod = find("barkod");
  const colSales = find("satismiktar", "satismiktari");
  const colStock = find("stokmiktar", "stokmiktari"); // tam eşleşme → "Web Depo Stok Miktar" yakalanmaz

  const missing: string[] = [];
  if (!colName) missing.push("Urun");
  if (!colSales) missing.push("Satis Miktar");
  if (!colStock) missing.push("Stok Miktar");
  if (missing.length) {
    throw new Error(`D&R-Kategori eksik kolon: ${missing.join(", ")}. Bulunan: ${cols.join(", ")}`);
  }

  const out: UnifiedRow[] = [];
  for (const r of rows) {
    const name = String(r[colName!] ?? "").trim();
    if (!name || /genel toplam|^toplam/i.test(name)) continue;
    const barkod = String(r[colBarkod ?? ""] ?? "").replace(/\D/g, "");
    out.push({
      retailer: "DR",
      week_start: week.start,
      week_end: week.end,
      store: null,
      sku_name: name,
      sku_id: colId && r[colId] != null ? String(r[colId]).trim() : null,
      barkod: barkod.length >= 6 ? barkod : null,
      price: null,
      sales_qty: num(r[colSales!]),
      sales_value: null, // enrichment ile dolacak
      stock_qty: num(r[colStock!]),
      source_file: sourceFile,
    });
  }
  return out;
}
