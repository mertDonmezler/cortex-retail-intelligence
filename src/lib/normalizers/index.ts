// Dispatcher: dosyayı SheetJS ile parse et, perakendeciye göre normalize et.
import * as XLSX from "xlsx";
import type { UnifiedRow, Retailer } from "./types";
import { parseWeekFromFilename, weekFromToday, canonicalWeek } from "./week-parser";
import type { WeekRange } from "./week-parser";
import { normalizeAsepto } from "./asepto";
import { normalizeNezih } from "./nezih";
import { normalizeHuppaluppo } from "./huppaluppo";
import { normalizeArmagan } from "./armagan";
import { normalizeDrKategori, isDrKategori } from "./dr-kategori";

type Row = Record<string, unknown>;

export function normalizeFile(
  buf: ArrayBuffer,
  retailer: Retailer,
  filename: string,
  // Hafta override'ı (yükleme UI'ından): tarihsiz/geç dosyalarda (Nezih, D&R-Kategori)
  // dosya adı çözümü güvenilmez — kullanıcının seçtiği hafta her zaman kazanır.
  weekOverride?: WeekRange
): UnifiedRow[] {
  const wb = XLSX.read(buf, { type: "array" });
  const sheet = wb.Sheets[wb.SheetNames[0]];
  // Hafta başlangıcını ISO Pazartesi'ye hizala → perakendecilerin etiket farkları
  // (DR Salı, Armağan W-NN, Toyzz Pazartesi) aynı haftada birleşsin.
  const week = canonicalWeek(weekOverride ?? parseWeekFromFilename(filename) ?? weekFromToday());

  // Huppaluppo: "Stok Raporu" formatı — başlık offsetli, hafta dosya içindeki
  // tarih aralığından okunur, Satış Tutarı (TL) mevcut.
  let rows: UnifiedRow[];
  if (retailer === "Huppaluppo") {
    rows = normalizeHuppaluppo(sheet, week, filename);
  } else {
    const raw = XLSX.utils.sheet_to_json<Row>(sheet, { defval: null, raw: true });
    if (retailer === "Nezih") rows = normalizeNezih(raw, week, filename);
    // Armağan: mağaza-bazlı (Lokasyon/Barkod/Satış Fiyatı/Satış Miktarı/Geçmiş Stok).
    else if (retailer === "Armağan") rows = normalizeArmagan(raw, week, filename);
    // DR: yeni "Satin Alma - Kategori" formatı (Urun Id/Satis Miktar/Stok Miktar)
    // kolon parmak izinden otomatik tanınır; eski dosyalar Asepto'ya düşer.
    else if (retailer === "DR" && raw.length > 0 && isDrKategori(Object.keys(raw[0] ?? {})))
      rows = normalizeDrKategori(raw, week, filename);
    // Toyzz, DR → Asepto formatları (3 varyant auto-detect)
    else rows = normalizeAsepto(raw, retailer, week, filename);
  }
  return sanitizeRows(rows);
}

// Ortak veri-sağlığı sanitizasyonu (TÜM perakendeciler) — gelecek yüklemeleri
// temiz tutar (geçmiş temizliği bir kez SQL ile yapıldı). Üç kural:
//  • placeholder/junk SKU (***KULLANILMAYACAK***) at,
//  • mojibake "?" onar (" ? "→" - ", harf?harf→harf'harf — kaynak kodlama kaybı),
//  • negatif stok → 0 (haftalık stok anlık değeri negatif olamaz).
// Negatif SATIŞ korunur: gerçek iade/düzeltme satırıdır.
function repairName(s: string): string {
  return s
    .replace(/(\S)\s\?\s(\S)/g, "$1 - $2")
    .replace(/([A-Za-zÇĞİÖŞÜçğıöşü0-9])\?([A-Za-zÇĞİÖŞÜçğıöşü])/g, "$1'$2");
}
export function sanitizeRows(rows: UnifiedRow[]): UnifiedRow[] {
  const out: UnifiedRow[] = [];
  for (const r of rows) {
    if (r.sku_name && /KULLANILMAYACAK/i.test(r.sku_name)) continue;
    out.push({
      ...r,
      sku_name: r.sku_name && r.sku_name.includes("?") ? repairName(r.sku_name) : r.sku_name,
      stock_qty: typeof r.stock_qty === "number" && r.stock_qty < 0 ? 0 : r.stock_qty,
    });
  }
  return out;
}
