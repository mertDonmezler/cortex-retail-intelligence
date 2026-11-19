// Asepto kaynaklı raporlar (Toyzz + DR) — 3 format otomatik tanı.
// Python asepto_base.py portu.
//
// TOYZZ BARKODU (2026-09-28): Toyzz 21-27 Eylül dosyasıyla birlikte Kalem
// raporuna "Barkod" kolonu eklendi (219/219 geçerli EAN-13). Eski 7 kolonlu
// dosyalarda kolon yok → barkod null kalır, davranış aynen korunur. Eski bir
// haftayı yeniden yüklerken barkodu Kalem Kodu üzerinden geri işleyen adım
// normalizer'da DEĞİL, yazma yolunda (lib/toyzz-barkod.ts): normalizer'lar DB'ye
// dokunmayan saf fonksiyonlar olarak kalır.
import type { UnifiedRow, Retailer } from "./types";
import type { WeekRange } from "./week-parser";
import { toNum as num, toNumOrNull as numOrNull } from "./num";
import { katla } from "../urun-ailesi";

type Row = Record<string, unknown>;

// BAŞLIK KATLAMA: "Toplam Satis Adedi" (ş yerine s) ile "Toplam Satış Adedi"
// aynı kolondur. Toyzz'un 22-28 Eylül 2025 dosyası böyle geldi; tam eşleşme
// arandığı için o haftanın satışı SESSİZCE 0 okunuyordu (num(undefined) = 0,
// yalnız "TÜMÜNDE satış 0" sağlık uyarısı düşer). Bulunamazsa asıl ad döner —
// eski davranış aynen.
const baslikKatla = (k: string) => katla(k).replace(/[^A-Z0-9]/g, "");
function kolonBul(rows: Row[], ad: string): string {
  const hedef = baslikKatla(ad);
  return Object.keys(rows[0]).find((k) => baslikKatla(k) === hedef) ?? ad;
}
// Adaylardan dosyada OLAN ilk kolon (katlanmış eşleşme); hiçbiri yoksa null.
function ilkKolon(rows: Row[], adlar: string[]): string | null {
  for (const ad of adlar) {
    const hedef = baslikKatla(ad);
    const k = Object.keys(rows[0]).find((x) => baslikKatla(x) === hedef);
    if (k) return k;
  }
  return null;
}
// TOYZZ KALEM KOLONLARI İKİ KUŞAK: "Kalem Kodu / Kalem Tanımı" ve 2-8 Kasım
// 2026'dan beri "Ürün Kodu / Ürün Tanımı" (+ Tedarikçi Adı / Tedarikçi Ürün Kodu;
// barkod kolonu YOK, PSF metin "179,99", satışsız üründe satış hücresi boş).
// Değerler aynı: Ürün Kodu = eski Kalem Kodu (T00038827), barkod geri işleme
// (lib/toyzz-barkod.ts) bu kodla çalışır. Eski ad tam eşleşme arandığı için yeni
// dosya "bilinen Asepto formatı değil" diye reddediliyordu.
const KALEM_AD = ["Kalem Tanımı", "Ürün Tanımı"];
const KALEM_KOD = ["Kalem Kodu", "Ürün Kodu"];

function str(v: unknown): string {
  return String(v ?? "").trim();
}
// BOS METIN BARKOD URETME. Bu normalizer tek basina "" donuyordu; diger dort
// normalizer gecersiz barkodu null yapiyor. Fark zararsiz degil:
//   - prices.ts fiyat kanitini `.not("barkod","is",null)` ile suzuyor ve ""
//     bu filtreden GECIYOR; sonra butun bos-barkodlu satirlar TEK anahtar
//     altinda toplanip ayni medyan fiyati aliyor,
//   - o deger sku_prices'a `barkod = ""` anahtariyla KALICI yaziliyor ve
//     sonraki her yuklemede onbellek olarak geri geliyor.
// Kural digerleriyle ayni: 6-14 hane rakam degilse barkod YOKTUR.
// SAYI TIPLI HUCRE: Excel barkodu bazen sayi olarak saklar (Toyzz Eylul
// dosyasinda 4 hucre; gorunen metin "8.68184E+12"). Dispatcher raw:true okudugu
// icin deger tam sayi gelir ve String() 13 haneyi kayipsiz verir — yalniz guvenli
// tam sayi araligindaysa. raw:false'a gecilirse bu hucreler bilimsel gosterimle
// gelir ve sessizce null'a duser (index.ts'teki sheet_to_json'a bkz.).
// TUMU SIFIR ("000000") yer tutucudur, barkod degildir.
function cleanBarkod(v: unknown): string | null {
  if (typeof v === "number") {
    if (!Number.isSafeInteger(v) || v <= 0) return null;
    v = String(v);
  }
  const b = str(v).replace(/\.0$/, "");
  return /^\d{6,14}$/.test(b) && !/^0+$/.test(b) ? b : null;
}
function cleanSku(v: unknown): string {
  return str(v).replace(/,\s*N\/?A\s*$/i, "");
}

export function normalizeAsepto(
  rows: Row[],
  retailer: Retailer,
  week: WeekRange,
  sourceFile: string,
): UnifiedRow[] {
  if (rows.length === 0) {
    throw new Error("Dosya boş (sadece başlık, 0 satır) — yeniden iste.");
  }
  const cols = new Set(Object.keys(rows[0]));

  // Format A: mağaza-bazlı
  if (cols.has("Magaza")) return storeLevel(rows, retailer, week, sourceFile);
  // Format B: agrega Psf'li (Kalem ya da Ürün kolonlu — bkz. KALEM_AD/KALEM_KOD)
  if (ilkKolon(rows, KALEM_AD) || ilkKolon(rows, KALEM_KOD))
    return aggregatePsf(rows, retailer, week, sourceFile);
  // Format C: agrega barkodlu (DR-yeni)
  if (cols.has("Urun") && cols.has("Barkod") && cols.has("Satis Miktar"))
    return aggregateBarkod(rows, retailer, week, sourceFile);

  throw new Error(
    `Bilinen Asepto formatı değil. Kolonlar: ${[...cols].join(", ")}`,
  );
}

function base(retailer: Retailer, week: WeekRange, source: string) {
  return {
    retailer,
    week_start: week.start,
    week_end: week.end,
    source_file: source,
  };
}

// D&R MAĞAZA DOSYASINDA "Satis Tutar" KDV HARİÇ (2026-10-29 fatura denetimi).
// CORTEX ciroyu KDV dahil PSF × adet olarak saklar ve okurken /1,2 yapar
// (margins.ts netFactor); bu kolon ham yazıldığında KDV iki kez düşülüyordu.
// Kanıt: Beşiktaş metal kutu birim 665,83 = 799 / 1,2; Şubat 2026 mağaza satışı
// ×1,2 ile faturadan hesaplanan net %0,0 farkla tuttu (12.919 adet). Toyzz bu
// formatta hiç gelmedi (mağazalı Toyzz satırı 0) — kanıt yalnız D&R için var.
const SATIS_TUTAR_KDV: Partial<Record<Retailer, number>> = { DR: 1.2 };

function storeLevel(
  rows: Row[],
  retailer: Retailer,
  week: WeekRange,
  source: string,
): UnifiedRow[] {
  const out: UnifiedRow[] = [];
  const kdv = SATIS_TUTAR_KDV[retailer] ?? 1;
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
      // Kuruşa yuvarla: 665,83 × 1,2 = 798,996 → 799,00 (dosyadaki tutar kuruşluk).
      // KDV çarpanı yoksa değer ham kalır (eski davranış).
      sales_value:
        kdv === 1
          ? num(r["Satis Tutar"])
          : Math.round(num(r["Satis Tutar"]) * kdv * 100) / 100,
      stock_qty: num(r["Stok Miktar"]),
    });
  }
  return out;
}

function aggregatePsf(
  rows: Row[],
  retailer: Retailer,
  week: WeekRange,
  source: string,
): UnifiedRow[] {
  const out: UnifiedRow[] = [];
  // Psf (fiyat) kolonu — bazı dosyalar "PSF", bazıları "Psf" → büyük/küçük harf duyarsız bul.
  const psfCol =
    Object.keys(rows[0]).find((k) => /^\s*psf\s*$/i.test(k)) ?? null;
  // Barkod kolonu — Toyzz Eylül 2026'dan itibaren gönderiyor; aynı harf duyarsız arama.
  const barkodCol =
    Object.keys(rows[0]).find((k) => /^\s*barkod\s*$/i.test(k)) ?? null;
  const satisCol = kolonBul(rows, "Toplam Satış Adedi");
  const stokCol = kolonBul(rows, "Toplam Stok Adedi");
  const adCol = ilkKolon(rows, KALEM_AD) ?? KALEM_AD[0];
  const kodCol = ilkKolon(rows, KALEM_KOD) ?? KALEM_KOD[0];
  for (const r of rows) {
    // Özet/grand-total satırını at: ürün adı VE kodu boşsa (bazı dosyalarda toplam
    // satırının etiketi boştur → çift sayıma yol açıyordu) ya da "toplam"/"genel" etiketliyse.
    const ad = str(r[adCol]);
    const kod = str(r[kodCol]);
    if ((!ad && !kod) || /toplam|genel/i.test(ad) || /toplam|genel/i.test(kod))
      continue;
    const qty = num(r[satisCol]);
    const price = psfCol ? numOrNull(r[psfCol]) : null;
    // qty=0 → ciro 0 (satış yok); fiyat yoksa enrichment doldursun (null). Armağan ile aynı kural.
    const salesValue = qty > 0 ? (price != null ? price * qty : null) : 0;
    out.push({
      ...base(retailer, week, source),
      store: null,
      sku_name: ad,
      sku_id: kod,
      barkod: barkodCol ? cleanBarkod(r[barkodCol]) : null,
      price,
      sales_qty: qty,
      sales_value: salesValue,
      stock_qty: num(r[stokCol]),
    });
  }
  return out;
}

function aggregateBarkod(
  rows: Row[],
  retailer: Retailer,
  week: WeekRange,
  source: string,
): UnifiedRow[] {
  const out: UnifiedRow[] = [];
  for (const r of rows) {
    // cleanBarkod artik gecersizde null donuyor (bkz. tanimi) — kural tek yerde.
    const barkod = cleanBarkod(r["Barkod"]);
    if (!barkod) continue; // Toplamlar satırını at
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
