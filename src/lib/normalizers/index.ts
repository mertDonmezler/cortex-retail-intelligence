// Dispatcher: dosyayı SheetJS ile parse et, perakendeciye göre normalize et.
import * as XLSX from "xlsx";
import type { UnifiedRow, Retailer } from "./types";
import {
  parseWeekFromFilename,
  weekFromToday,
  canonicalWeek,
} from "./week-parser";
import type { WeekRange } from "./week-parser";
import { normalizeAsepto } from "./asepto";
import { normalizeNezih } from "./nezih";
import { normalizeHuppaluppo } from "./huppaluppo";
import { normalizeArmagan } from "./armagan";
import {
  normalizeDrKategori,
  isDrKategori,
  drKategoriDepo,
  type DepoSatiri,
} from "./dr-kategori";

type Row = Record<string, unknown>;

export function normalizeFile(
  buf: ArrayBuffer,
  retailer: Retailer,
  filename: string,
  // Hafta override'ı (yükleme UI'ından): tarihsiz/geç dosyalarda (Nezih, D&R-Kategori)
  // dosya adı çözümü güvenilmez — kullanıcının seçtiği hafta her zaman kazanır.
  weekOverride?: WeekRange,
): UnifiedRow[] {
  const wb = XLSX.read(buf, { type: "array" });
  const sheet = wb.Sheets[wb.SheetNames[0]];
  // Hafta başlangıcını ISO Pazartesi'ye hizala → perakendecilerin etiket farkları
  // (DR Salı, Armağan W-NN, Toyzz Pazartesi) aynı haftada birleşsin.
  const week = canonicalWeek(
    weekOverride ?? parseWeekFromFilename(filename) ?? weekFromToday(),
  );

  // Huppaluppo: "Stok Raporu" formatı — başlık offsetli, hafta dosya içindeki
  // tarih aralığından okunur, Satış Tutarı (TL) mevcut.
  let rows: UnifiedRow[];
  if (retailer === "Huppaluppo") {
    // KULLANICI SEÇİMİ HER ZAMAN KAZANIR — Huppaluppo dahil. Eskiden override
    // buraya yalnız "fallback" olarak geçiyor ve dosya içindeki tarih aralığı onu
    // eziyordu: seçilen 2026-01-05 iken 2026-05-11 yazıldı (ölçüldü, diğer 4
    // firma seçimi uyguladı). Yükleme ekranı "seçim her dosyaya uygulanır" derken
    // bu firmada yalan söylüyordu; mislabeled Huppaluppo haftası bu yüzden UI'dan
    // düzeltilememiş, veri elle taşınmıştı.
    rows = normalizeHuppaluppo(sheet, week, filename, {
      titleWins: !weekOverride,
    });
  } else {
    const raw = XLSX.utils.sheet_to_json<Row>(sheet, {
      defval: null,
      raw: true,
    });
    if (retailer === "Nezih") rows = normalizeNezih(raw, week, filename);
    // Armağan: mağaza-bazlı (Lokasyon/Barkod/Satış Fiyatı/Satış Miktarı/Geçmiş Stok).
    else if (retailer === "Armağan")
      rows = normalizeArmagan(raw, week, filename);
    // DR: yeni "Satin Alma - Kategori" formatı (Urun Id/Satis Miktar/Stok Miktar)
    // kolon parmak izinden otomatik tanınır; eski dosyalar Asepto'ya düşer.
    else if (
      retailer === "DR" &&
      raw.length > 0 &&
      isDrKategori(Object.keys(raw[0] ?? {}))
    )
      rows = normalizeDrKategori(raw, week, filename);
    // Toyzz, DR → Asepto formatları (3 varyant auto-detect)
    else rows = normalizeAsepto(raw, retailer, week, filename);
  }
  return sanitizeRows(rows);
}

// D&R depo satırları (lib/normalizers/dr-kategori.ts drKategoriDepo). Yalnız
// D&R-Kategori formatında dolu; diğer her dosyada boş liste. Hafta ve ürün adı
// normalizeFile ile AYNI kuralla (canonicalWeek + sanitizeRows'un ad onarımı),
// yoksa depo satırı fact_weekly'deki ürüne eşlenmezdi.
export function drDepoSatirlari(
  buf: ArrayBuffer,
  retailer: Retailer,
  filename: string,
  weekOverride?: WeekRange,
): DepoSatiri[] {
  if (retailer !== "DR") return [];
  const wb = XLSX.read(buf, { type: "array" });
  const raw = XLSX.utils.sheet_to_json<Row>(wb.Sheets[wb.SheetNames[0]], {
    defval: null,
    raw: true,
  });
  if (!raw.length || !isDrKategori(Object.keys(raw[0] ?? {}))) return [];
  const week = canonicalWeek(
    weekOverride ?? parseWeekFromFilename(filename) ?? weekFromToday(),
  );
  return drKategoriDepo(raw, week, filename)
    .filter((d) => !/KULLANILMAYACAK/i.test(d.sku_name))
    .map((d) => ({
      ...d,
      sku_name: normalizeSkuName(
        d.sku_name.includes("?") ? repairName(d.sku_name) : d.sku_name,
      ),
    }));
}

// Ortak veri-sağlığı sanitizasyonu (TÜM perakendeciler) — gelecek yüklemeleri
// temiz tutar (geçmiş temizliği bir kez SQL ile yapıldı). Üç kural:
//  • placeholder/junk SKU (***KULLANILMAYACAK***) at,
//  • mojibake "?" onar (" ? "→" - ", harf?harf→harf'harf — kaynak kodlama kaybı),
//  • negatif stok → 0 (haftalık stok anlık değeri negatif olamaz).
// Negatif SATIŞ korunur: gerçek iade/düzeltme satırıdır.
// export: davranışı doğrudan test edilebilsin. Eskiden yalnız sanitizeRows
// üzerinden dolaylı sınanabiliyordu; iki kuralın (ayraç "?" ve kesme işareti "?")
// birbirine karışmadığı ancak doğrudan çağrıyla gösterilebilir.
export function repairName(s: string): string {
  return s
    .replace(/(\S)\s\?\s(\S)/g, "$1 - $2")
    .replace(/([A-Za-zÇĞİÖŞÜçğıöşü0-9])\?([A-Za-zÇĞİÖŞÜçğıöşü])/g, "$1'$2");
}

// Ürün adı normalizasyonu — AYNI ürünün farklı yazımla iki ayrı kalem sayılmasını
// engeller. Bu bir kozmetik düzeltme değil, VERİ BÜTÜNLÜĞÜ düzeltmesidir:
// isim-anahtarlı matview'ler (sku_weekly, sku_coverage) adı anahtar kullandığı için
// "X" ile "X, N/A" iki ayrı ürün gibi toplanıyor ve stok ÇİFT SAYILIYORDU
// (DR'de 450 satır = 266 gerçek ürün, +70.818 adet hayali stok).
//  • sondaki ", N/A" / " N/A" atılır — D&R'nin kategori alanı boş geldiğinde eklediği ek
//  • çoklu boşluk tek boşluğa iner (Nezih "Mythos  Pulls" gibi çift boşluk kullanıyor)
//  • baş/son boşluk kırpılır
// NOT: product_alias eşleşmeleri de sku_name'e dayanır; onaylı 174 alias'ın hiçbiri
// bu kurallardan etkilenmiyor (kontrol edildi), yani eşleştirmeler bozulmaz.
export function normalizeSkuName(s: string): string {
  return s
    .replace(/,?\s*N\/A\s*$/i, "")
    .replace(/\s+/g, " ")
    .trim();
}
// ── Yükleme öncesi sağlık kontrolü ────────────────────────────────────────────
// NEDEN: iki olay GERÇEKTEN yaşandı.
//   (a) Huppaluppo'dan satış kolonu tamamen boş bir dosya geldi ve SESSİZCE
//       yüklendi; hafta 0 satışla göründü, elle geri alındı.
//   (b) Toyzz kolon düzenini değiştirdi (7 → 6 kolon, "Tedarikçi Adı" kalktı).
// Kritik kolon kaybı normalizer'larda zaten HATA fırlatıyor ve mesaj dosyanın
// kolon listesini taşıyor (Nezih/D&R-Kategori/Huppaluppo/Asepto). Sessiz kalan
// durum, formatın tanınıp METRİK kolonunun boşalması: `toNum(undefined) = 0`
// olduğu için satış/stok sıfıra düşer, dosya "başarıyla" yüklenir. Bu kontrol
// tam o boşluğu kapatır — sonucu ÖLÇEREK: tüm satışlar 0, tüm stoklar 0,
// hiç satır çıkmaması, ya da ciro üretilemez olması.
//
// BLOKLAMIYOR, UYARIYOR: gerçekten satışsız bir hafta olabilir (seed/ toyzz
// dosyalarında satır bazında 98-124 kalem 0 satışla geliyor; bütün bir dosyanın
// 0 olması ise 26 dosyanın hiçbirinde görülmedi). Yüklemeyi kesmek, haftalık
// verinin hiç girmemesi demek olurdu; o yüzden uyarı + kayıt.
export type RowHealth = {
  rows: number;
  salesQty: number;
  stockQty: number;
  pricedRows: number; // dosyadan pozitif ciro ile gelen satır
  withBarkod: number; // barkodu olan satır (enrichment ancak buna tutunur)
  warnings: string[];
};

// Fiyatı kendi dosyasında taşıyan firmalar (prices.ts PRICE_IN_FILE ile aynı küme).
const FIYAT_DOSYADA = new Set(["Toyzz", "Armağan"]);

export function checkRowHealth(rows: UnifiedRow[]): RowHealth {
  let salesQty = 0,
    stockQty = 0,
    pricedRows = 0,
    withBarkod = 0;
  for (const r of rows) {
    salesQty += Number(r.sales_qty) || 0;
    stockQty += Number(r.stock_qty) || 0;
    if (r.sales_value != null && Number(r.sales_value) > 0) pricedRows++;
    if (r.barkod) withBarkod++;
  }
  const warnings: string[] = [];
  if (rows.length === 0) {
    warnings.push(
      "Dosyadan hiç veri satırı çıkmadı — sayfa boş ya da kolon düzeni değişmiş olabilir.",
    );
  } else {
    // Toplam 0 yerine "her satır 0" demek gerekmiyor: negatif satış (iade)
    // toplamı sıfıra indirebilir, o yüzden mutlak toplam da kontrol edilir.
    if (!rows.some((r) => Number(r.sales_qty) !== 0)) {
      warnings.push(
        `${rows.length} satırın TÜMÜNDE satış adedi 0 — satış kolonu boş gelmiş ya da ` +
          `yeniden adlandırılmış olabilir (gerçekten satışsız bir hafta da olabilir).`,
      );
    }
    if (!rows.some((r) => Number(r.stock_qty) !== 0)) {
      warnings.push(
        `${rows.length} satırın TÜMÜNDE stok 0 — stok kolonu boş gelmiş ya da yeniden ` +
          `adlandırılmış olabilir.`,
      );
    }
    // Satış var ama ne ciro ne barkod: fiyat enrichment'i barkoda tutunur, o da
    // yoksa bu haftanın cirosu kalıcı olarak 0 kalır.
    if (salesQty > 0 && pricedRows === 0 && withBarkod === 0) {
      warnings.push(
        "Satış var ama dosyada ciro yok ve barkod da yok — bu haftanın cirosu 0 kalır " +
          "(fiyat/ciro kolonu kaybolmuş olabilir).",
      );
    } else if (
      salesQty > 0 &&
      pricedRows === 0 &&
      FIYAT_DOSYADA.has(String(rows[0]?.retailer))
    ) {
      // Fiyatı KENDİ dosyasında taşıyan firma (Toyzz PSF, Armağan Satış Fiyatı)
      // barkodlu geldiğinde yukarıdaki kapı açılmaz: ciro başka kanalların
      // fiyatından doldurulur ve o firmanın ölçeğine uymaz (Toyzz/D&R ≈ 1,6).
      warnings.push(
        "Satış var ama dosyada fiyat/ciro yok — bu firma fiyatı kendi dosyasında taşır " +
          "(PSF kolonu kaybolmuş olabilir); ciro başka kanalların fiyatıyla doldurulur.",
      );
    }
  }
  return {
    rows: rows.length,
    salesQty,
    stockQty,
    pricedRows,
    withBarkod,
    warnings,
  };
}

export function sanitizeRows(rows: UnifiedRow[]): UnifiedRow[] {
  const out: UnifiedRow[] = [];
  for (const r of rows) {
    if (r.sku_name && /KULLANILMAYACAK/i.test(r.sku_name)) continue;
    const onarilan =
      r.sku_name && r.sku_name.includes("?")
        ? repairName(r.sku_name)
        : r.sku_name;
    out.push({
      ...r,
      sku_name: onarilan ? normalizeSkuName(onarilan) : onarilan,
      stock_qty:
        typeof r.stock_qty === "number" && r.stock_qty < 0 ? 0 : r.stock_qty,
    });
  }
  return out;
}
