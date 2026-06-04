// Dispatcher: dosyayı SheetJS ile parse et, perakendeciye göre normalize et.
import * as XLSX from "xlsx";
import type { UnifiedRow, Retailer } from "./types";
import { parseWeekFromFilename, weekFromToday, canonicalWeek } from "./week-parser";
import { normalizeAsepto } from "./asepto";
import { normalizeNezih } from "./nezih";
import { normalizeHuppaluppo } from "./huppaluppo";
import { normalizeArmagan } from "./armagan";

type Row = Record<string, unknown>;

export function normalizeFile(
  buf: ArrayBuffer,
  retailer: Retailer,
  filename: string
): UnifiedRow[] {
  const wb = XLSX.read(buf, { type: "array" });
  const sheet = wb.Sheets[wb.SheetNames[0]];
  // Hafta başlangıcını ISO Pazartesi'ye hizala → perakendecilerin etiket farkları
  // (DR Salı, Armağan W-NN, Toyzz Pazartesi) aynı haftada birleşsin.
  const week = canonicalWeek(parseWeekFromFilename(filename) ?? weekFromToday());

  // Huppaluppo: "Stok Raporu" formatı — başlık offsetli, hafta dosya içindeki
  // tarih aralığından okunur, Satış Tutarı (TL) mevcut.
  if (retailer === "Huppaluppo") return normalizeHuppaluppo(sheet, week, filename);

  const rows = XLSX.utils.sheet_to_json<Row>(sheet, { defval: null, raw: true });
  if (retailer === "Nezih") return normalizeNezih(rows, week, filename);
  // Armağan: mağaza-bazlı (Lokasyon/Barkod/Satış Fiyatı/Satış Miktarı/Geçmiş Stok).
  if (retailer === "Armağan") return normalizeArmagan(rows, week, filename);
  // Toyzz, DR → Asepto formatları (3 varyant auto-detect)
  return normalizeAsepto(rows, retailer, week, filename);
}
