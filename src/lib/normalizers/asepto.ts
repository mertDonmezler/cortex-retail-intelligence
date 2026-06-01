// Asepto kaynaklı raporlar (Toyzz + DR) — 3 format otomatik tanı.
// Python asepto_base.py portu.
import type { UnifiedRow, Retailer } from "./types";
import type { WeekRange } from "./week-parser";
import { toNum as num, toNumOrNull as numOrNull } from "./num";

type Row = Record<string, unknown>;

function str(v: unknown): string {
  return String(v ?? "").trim();
}
function cleanBarkod(v: unknown): string {
  return str(v).replace(/\.0$/, "");
}
function cleanSku(v: unknown): string {
  return str(v).replace(/,\s*N\/?A\s*$/i, "");
}

export function normalizeAsepto(
  rows: Row[],
  retailer: Retailer,
  week: WeekRange,
  sourceFile: string
): UnifiedRow[] {
  if (rows.length === 0) {
    throw new Error("Dosya boş (sadece başlık, 0 satır) — yeniden iste.");
  }
  const cols = new Set(Object.keys(rows[0]));

  // Format A: mağaza-bazlı
  if (cols.has("Magaza")) return storeLevel(rows, retailer, week, sourceFile);
  // Format B: agrega Psf'li
  if (cols.has("Kalem Tanımı") || cols.has("Kalem Kodu"))
    return aggregatePsf(rows, retailer, week, sourceFile);
  // Format C: agrega barkodlu (DR-yeni)
  if (cols.has("Urun") && cols.has("Barkod") && cols.has("Satis Miktar"))
    return aggregateBarkod(rows, retailer, week, sourceFile);

  throw new Error(`Bilinen Asepto formatı değil. Kolonlar: ${[...cols].join(", ")}`);
}

function base(retailer: Retailer, week: WeekRange, source: string) {
  return {
    retailer,
    week_start: week.start,
    week_end: week.end,
    source_file: source,
  };
}

function storeLevel(rows: Row[], retailer: Retailer, week: WeekRange, source: string): UnifiedRow[] {
  const out: UnifiedRow[] = [];
  for (const r of rows) {
    const magaza = str(r["Magaza"]);
    if (magaza.toLowerCase() === "genel toplam") continue;
    if (!r["Urun"]) continue;
    out.push({
      ...base(retailer, week, source),
      store: magaza,
      sku_name: cleanSku(r["Urun"]),
      sku_id: r["UrunId"] != null ? str(r["UrunId"]) : null,
      barkod: cleanBarkod(r["Barkod"]),
      price: null,
      sales_qty: num(r["Satis Miktar"]),
      sales_value: num(r["Satis Tutar"]),
      stock_qty: num(r["Stok Miktar"]),
    });
  }
  return out;
}

function aggregatePsf(rows: Row[], retailer: Retailer, week: WeekRange, source: string): UnifiedRow[] {
  const out: UnifiedRow[] = [];
  // Psf (fiyat) kolonu — bazı dosyalar "PSF", bazıları "Psf" → büyük/küçük harf duyarsız bul.
  const psfCol = Object.keys(rows[0]).find((k) => /^\s*psf\s*$/i.test(k)) ?? null;
  for (const r of rows) {
    // Özet/grand-total satırını at: ürün adı VE kodu boşsa (bazı dosyalarda toplam
    // satırının etiketi boştur → çift sayıma yol açıyordu) ya da "toplam"/"genel" etiketliyse.
    const ad = str(r["Kalem Tanımı"]);
    const kod = str(r["Kalem Kodu"]);
    if ((!ad && !kod) || /toplam|genel/i.test(ad) || /toplam|genel/i.test(kod)) continue;
    const qty = num(r["Toplam Satış Adedi"]);
    const price = psfCol ? numOrNull(r[psfCol]) : null;
    let salesValue: number | null = null;
    if (price != null) {
      const v = price * qty;
      salesValue = v > 0 ? v : null;
    }
    out.push({
      ...base(retailer, week, source),
      store: null,
      sku_name: str(r["Kalem Tanımı"]),
      sku_id: str(r["Kalem Kodu"]),
      barkod: null,
      price,
      sales_qty: qty,
      sales_value: salesValue,
      stock_qty: num(r["Toplam Stok Adedi"]),
    });
  }
  return out;
}

function aggregateBarkod(rows: Row[], retailer: Retailer, week: WeekRange, source: string): UnifiedRow[] {
  const out: UnifiedRow[] = [];
  for (const r of rows) {
    const barkod = cleanBarkod(r["Barkod"]);
    if (!/^\d{6,14}$/.test(barkod)) continue; // Toplamlar satırını at
    out.push({
      ...base(retailer, week, source),
      store: null,
      sku_name: cleanSku(r["Urun"]),
      sku_id: r["Urun Id"] != null ? str(r["Urun Id"]) : null,
      barkod,
      price: null,
      sales_qty: num(r["Satis Miktar"]),
      sales_value: null, // fiyat enrichment ile dolacak
      stock_qty: num(r["Stok Miktar"]),
    });
  }
  return out;
}
