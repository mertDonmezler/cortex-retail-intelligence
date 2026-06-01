// Huppaluppo "Stok Raporu" formatı.
// - Üstte rapor başlığı + tarih aralığı satırı var; gerçek sütun başlığı
//   (Barkod / Ürün Adı / Satış / Stok / Satış Tutarı) alttaki satırda.
// - Hafta, dosya İÇİNDEKİ tarih aralığından okunur (dosya adı "Hafta 1" olabilir).
// - Satış Tutarı (TL) dosyada mevcut → enrichment'a gerek yok.
import * as XLSX from "xlsx";
import type { UnifiedRow } from "./types";
import { canonicalWeek, type WeekRange } from "./week-parser";
import { toNum as num, toNumOrNull } from "./num";

const pad = (n: string) => n.padStart(2, "0");

// Başlık bölgesindeki "11.05.2026-17.05.2026" gibi aralıktan haftayı çıkar.
function weekFromTitle(aoa: any[][], fallback: WeekRange): WeekRange {
  for (const row of aoa.slice(0, 5)) {
    for (const cell of row) {
      const m = String(cell ?? "").match(/(\d{1,2})\.(\d{1,2})\.(\d{4})\s*-\s*(\d{1,2})\.(\d{1,2})\.(\d{4})/);
      if (m) {
        return canonicalWeek({
          start: `${m[3]}-${pad(m[2])}-${pad(m[1])}`,
          end: `${m[6]}-${pad(m[5])}-${pad(m[4])}`,
        });
      }
    }
  }
  return fallback;
}

export function normalizeHuppaluppo(sheet: XLSX.WorkSheet, fallbackWeek: WeekRange, source: string): UnifiedRow[] {
  const aoa: any[][] = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: null, raw: true });
  const week = weekFromTitle(aoa, fallbackWeek);

  // Gerçek başlık satırı: "Barkod" + "Satış" içeren satır.
  const hdrIdx = aoa.findIndex(
    (row) => row.some((c) => String(c ?? "").trim().toLowerCase() === "barkod") &&
             row.some((c) => /sat[ıi]ş/i.test(String(c ?? "")))
  );
  if (hdrIdx === -1) throw new Error("Huppaluppo başlık satırı (Barkod/Satış) bulunamadı.");

  const hdr = aoa[hdrIdx].map((c) => String(c ?? "").trim());
  const find = (re: RegExp) => hdr.findIndex((h) => re.test(h));
  const ci = {
    barkod: find(/^barkod$/i),
    name: find(/ürün\s*ad|urun\s*ad|^adı?$/i),
    satis: find(/^satış$|^satis$/i),
    stok: find(/^stok$/i),
    tutar: find(/satış\s*tutar|satis\s*tutar/i), // TL gelir
  };
  if (ci.barkod < 0 || ci.satis < 0 || ci.stok < 0) {
    throw new Error("Huppaluppo kolonları eksik. Başlık: " + hdr.filter(Boolean).join(", "));
  }

  const out: UnifiedRow[] = [];
  for (let i = hdrIdx + 1; i < aoa.length; i++) {
    const row = aoa[i];
    const barkod = String(row[ci.barkod] ?? "").replace(/\.0$/, "").trim();
    if (!/^\d{6,14}$/.test(barkod)) continue; // "Satır Toplamı"/footer satırlarını at
    const nameVal = ci.name >= 0 ? String(row[ci.name] ?? "").trim() : "";
    if (/toplam/i.test(nameVal)) continue;
    out.push({
      retailer: "Huppaluppo",
      week_start: week.start,
      week_end: week.end,
      store: null,
      sku_name: nameVal,
      sku_id: null,
      barkod,
      price: null,
      sales_qty: Math.max(num(row[ci.satis]), 0),
      sales_value: ci.tutar >= 0 ? toNumOrNull(row[ci.tutar]) : null,
      stock_qty: num(row[ci.stok]),
      source_file: source,
    });
  }
  return out;
}
