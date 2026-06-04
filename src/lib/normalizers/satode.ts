// Sat-Öde (konsinye) fatura dosyası → ConsignmentLine[].
// Format: tek Excel'de TÜM carilerin toptan fatura kalemleri (veri "Sheet2"de;
// "Sheet1" cari bazlı aylık özet pivotudur, kullanılmaz).
// Kolonlar: Fatura no | Belge no | Tarih | Vade | Cari kodu | Cari adı |
//   Satır sayısı | Stok kodu | Stok ismi | Ana grup | Alt grup | Miktar |
//   Net Br.fiy | Net tutar | Toplam vergi | Toplam | ...
// DİKKAT: tutarlar faturanın HAM değeridir; marj/net-kazanç UYGULANMAZ
// (bu CORTEX sell-through'undan farklı bir veri kümesi — bizim toptan faturamız).
import * as XLSX from "xlsx";
import type { ConsignmentLine, Retailer } from "./types";
import { toNum, toNumOrNull } from "./num";

type Row = Record<string, unknown>;

function str(v: unknown): string {
  return String(v ?? "").trim();
}
function pad(n: number): string {
  return String(n).padStart(2, "0");
}

// Cari ünvanı → CORTEX kanalı. Kullanıcı eşlemesi: turkuaz=DR, toypa=Toyzz.
export function mapCariToRetailer(cari: string): Retailer | null {
  const s = cari.toLocaleUpperCase("tr-TR");
  if (/TURKU[VA]?A?Z/.test(s)) return "DR";          // TURKUVAZ / TURKUAZ
  if (/TOYPA|TOYZZ/.test(s)) return "Toyzz";
  if (/ARMA[ĞG]AN/.test(s)) return "Armağan";
  if (/HUP+AL+UP+A?|HUPPALUP/.test(s)) return "Huppaluppo"; // HUPALUPA / HUPPALUPPO
  if (/NEZ[İI]H/.test(s)) return "Nezih";
  return null;
}

// Excel tarih hücresi → ISO. raw:true ile tarihler SERİ NUMARA gelir; SSF ile
// timezone'dan bağımsız (y,m,d) çıkarılır. Date veya metin de tolere edilir.
function toISODate(v: unknown): string | null {
  if (v == null || v === "") return null;
  if (typeof v === "number" && isFinite(v)) {
    const d = (XLSX as any).SSF?.parse_date_code(v);
    if (!d || !d.y) return null;
    return `${d.y}-${pad(d.m)}-${pad(d.d)}`;
  }
  if (v instanceof Date) {
    // SheetJS Date'i: UTC bileşenleri Excel tarihini verir (cellDates yolu).
    return `${v.getUTCFullYear()}-${pad(v.getUTCMonth() + 1)}-${pad(v.getUTCDate())}`;
  }
  const s = str(v);
  let m = s.match(/^(\d{1,2})[.\/-](\d{1,2})[.\/-](\d{4})$/); // dd.mm.yyyy
  if (m) return `${m[3]}-${pad(+m[2])}-${pad(+m[1])}`;
  m = s.match(/^(\d{4})-(\d{2})-(\d{2})/); // yyyy-mm-dd
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  return null;
}

// Kolon adları muhasebe ihracatında uzun/değişken olabildiği için esnek bul.
function pick(r: Row, ...needles: string[]): unknown {
  const keys = Object.keys(r);
  for (const n of needles) {
    const hit = keys.find((k) => k.toLocaleLowerCase("tr-TR") === n.toLocaleLowerCase("tr-TR"));
    if (hit != null) return r[hit];
  }
  // tam eşleşme yoksa "içeren" ile dene (ör. uzun stok ismi kolonu)
  for (const n of needles) {
    const hit = keys.find((k) => k.toLocaleLowerCase("tr-TR").includes(n.toLocaleLowerCase("tr-TR")));
    if (hit != null) return r[hit];
  }
  return null;
}

export function normalizeSatodeRows(rows: Row[], sourceFile: string): ConsignmentLine[] {
  const out: ConsignmentLine[] = [];
  let skippedCari = 0;
  for (const r of rows) {
    const cari = str(pick(r, "Cari adı"));
    if (!cari) continue;
    const retailer = mapCariToRetailer(cari);
    if (!retailer) { skippedCari++; continue; }

    const invoice_no = str(pick(r, "Fatura no"));
    const product_name = str(pick(r, "Stok/hizmet/masraf/ demirbaş/ithalat ismi", "Stok ismi", "ithalat ismi"));
    const qty = toNum(pick(r, "Miktar"));
    // Ürün ve fatura bilgisi yoksa (toplam/boş satır) atla.
    if (!invoice_no && !product_name) continue;

    const net_amount = toNum(pick(r, "Net tutar"));
    const vat = toNum(pick(r, "Toplam vergi"));
    const totalRaw = toNumOrNull(pick(r, "Toplam"));
    const total = totalRaw != null && totalRaw !== 0 ? totalRaw : net_amount + vat;

    out.push({
      retailer,
      cari_adi: cari,
      cari_kodu: str(pick(r, "Cari kodu")) || null,
      invoice_no,
      belge_no: str(pick(r, "Belge no")) || null,
      invoice_date: toISODate(pick(r, "Tarih")) ?? "",
      due_date: toISODate(pick(r, "Vade")),
      line_no: toNumOrNull(pick(r, "Satır sayısı")),
      stock_code: str(pick(r, "Stok/hizmet/masraf/ demirbaş/ithalat kodu", "Stok kodu", "ithalat kodu")) || null,
      product_name,
      ana_grup: str(pick(r, "Ana grup")) || null,
      alt_grup: str(pick(r, "Alt grup")) || null,
      qty,
      unit_price_net: toNumOrNull(pick(r, "Net Br.fiy", "Net Br.Fiyat")),
      net_amount,
      vat,
      total,
      source_file: sourceFile,
    });
  }

  if (out.length === 0) {
    throw new Error(
      `Sat-Öde: tanınan cari bulunamadı (Toyzz/DR/Armağan/Huppaluppo). ${skippedCari} eşleşmeyen satır.`
    );
  }
  return out;
}

// Workbook → ConsignmentLine[]. Veri sayfasını ("Fatura no" başlıklı) otomatik bulur.
export function parseSatodeWorkbook(data: ArrayBuffer, sourceFile: string): ConsignmentLine[] {
  const wb = XLSX.read(data, { type: "array" });
  let sheet = wb.Sheets[wb.SheetNames[0]];
  for (const name of wb.SheetNames) {
    const ws = wb.Sheets[name];
    const head = (XLSX.utils.sheet_to_json(ws, { header: 1, range: 0 })[0] ?? []) as unknown[];
    if (head.some((h) => str(h) === "Fatura no")) { sheet = ws; break; }
  }
  const rows = XLSX.utils.sheet_to_json<Row>(sheet, { defval: null, raw: true });
  return normalizeSatodeRows(rows, sourceFile);
}
