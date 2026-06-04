// Armağan — mağaza-bazlı haftalık rapor (CORTEX'e özgü format).
// Kolonlar: Lokasyon | Ürün Kodu | Ürün Açıklaması | Barkod | Marka |
//           Satış Fiyatı (₺, PSF) | Satış Miktarı | Geçmiş Stok Miktarı
// Ciro dosyada yok → ciro = Satış Fiyatı (PSF, KDV dahil) × Satış Miktarı.
// DİKKAT: son satır "Genel Toplam" — atılmazsa adet/stok iki katına çıkar.
import type { UnifiedRow } from "./types";
import type { WeekRange } from "./week-parser";
import { toNum, toNumOrNull } from "./num";

type Row = Record<string, unknown>;

function str(v: unknown): string {
  return String(v ?? "").trim();
}

export function normalizeArmagan(rows: Row[], week: WeekRange, sourceFile: string): UnifiedRow[] {
  if (rows.length === 0) throw new Error("Armağan dosyası boş — yeniden iste.");

  const out: UnifiedRow[] = [];
  for (const r of rows) {
    const loc = str(r["Lokasyon"]);
    // "Genel Toplam" / toplam satırını ya da lokasyonsuz satırı at (çift sayım önleme).
    if (!loc || /genel\s*toplam|toplam/i.test(loc)) continue;

    const ad = str(r["Ürün Açıklaması"]);
    const barkodRaw = str(r["Barkod"]).replace(/\.0$/, "");
    if (!ad && !barkodRaw) continue; // ürün bilgisi yoksa atla

    const price = toNumOrNull(r["Satış Fiyatı"]); // "₺15.00" → 15 (PSF, KDV dahil)
    const qty = toNum(r["Satış Miktarı"]);         // boş → 0
    const salesValue = qty > 0 ? (price != null ? price * qty : null) : 0;

    out.push({
      retailer: "Armağan",
      week_start: week.start,
      week_end: week.end,
      store: loc,
      sku_name: ad,
      sku_id: r["Ürün Kodu"] != null ? str(r["Ürün Kodu"]) : null,
      barkod: /^\d{6,14}$/.test(barkodRaw) ? barkodRaw : null,
      price,
      sales_qty: qty,
      sales_value: salesValue,
      stock_qty: toNum(r["Geçmiş Stok Miktarı"]),
      source_file: sourceFile,
    });
  }

  if (out.length === 0) {
    throw new Error("Armağan: veri satırı bulunamadı (kolon adları değişmiş olabilir).");
  }
  return out;
}
