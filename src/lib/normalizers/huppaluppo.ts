// Huppaluppo "Stok Raporu" formatı.
// - Üstte rapor başlığı + tarih aralığı satırı var; gerçek sütun başlığı
//   (Barkod / Ürün Adı / Satış / Stok / Satış Tutarı) alttaki satırda.
// - Hafta, dosya İÇİNDEKİ tarih aralığından okunur (dosya adı "Hafta 1" olabilir).
// - Satış Tutarı (TL) dosyada mevcut → enrichment'a gerek yok.
import * as XLSX from "xlsx";
import type { UnifiedRow } from "./types";
import { canonicalWeek, isValidYmd, type WeekRange } from "./week-parser";
import { toNum as num, toNumOrNull } from "./num";

const pad = (n: string) => n.padStart(2, "0");

// Başlık bölgesindeki "11.05.2026-17.05.2026" gibi aralıktan haftayı çıkar.
// Huppaluppo'nun TEK tarihleme yolu bu: dosya adı "Hafta 1" bile olabilir, hafta
// yalnız dosya İÇİNDEKİ bu aralıktan okunur. Bu yüzden iki savunma eklendi:
//
// 1) TERS ARALIK. Gerçek olay: bir dosyada aralık "20.07.2026-16.07.2026" biçiminde
//    ters yazılıydı. canonicalWeek yalnız `start`ı kullanıp bitişi +6 gün olarak
//    yeniden kurduğu için ters aralıkta hafta BÜYÜK tarihten türüyordu: 16.07
//    (Perşembe) yerine 20.07 (Pazartesi) baz alınıp veri 2026-07-13 haftası yerine
//    2026-07-20 haftasına, yani BİR HAFTA İLERİYE yazılıyordu. İki tarih artık
//    sıralanıyor; küçük olan başlangıç sayılıyor.
// 2) GEÇERSİZ TAKVİM TARİHİ. Regex "32.13.2026-40.14.2026" gibi uydurma tarihleri de
//    eşliyordu; canonicalWeek geçersiz tarihte girdiyi OLDUĞU GİBİ döndürdüğü için
//    week_start "2026-13-32" olabiliyordu. Bu değer `\d{4}-\d{2}-\d{2}` kalıbına
//    UYDUĞU için şekil kontrollerinden geçer, ama Postgres `date` insert'ini düşürür
//    (dosya sessizce kaybolur). week-parser'daki isValidYmd ile aynı takvim kontrolü
//    burada da uygulanıyor; geçersizse aralık yokmuş gibi fallback'e düşülür.
export function weekFromTitle(aoa: any[][], fallback: WeekRange): WeekRange {
  for (const row of aoa.slice(0, 5)) {
    for (const cell of row ?? []) {
      const m = String(cell ?? "").match(/(\d{1,2})\.(\d{1,2})\.(\d{4})\s*-\s*(\d{1,2})\.(\d{1,2})\.(\d{4})/);
      if (!m) continue;
      const a = { y: +m[3], mo: +m[2], d: +m[1] };
      const b = { y: +m[6], mo: +m[5], d: +m[4] };
      if (!isValidYmd(a.y, a.mo, a.d) || !isValidYmd(b.y, b.mo, b.d)) continue;
      const s1 = `${a.y}-${pad(m[2])}-${pad(m[1])}`;
      const s2 = `${b.y}-${pad(m[5])}-${pad(m[4])}`;
      const [start, end] = s1 <= s2 ? [s1, s2] : [s2, s1];
      return canonicalWeek({ start, end });
    }
  }
  return fallback;
}

export function normalizeHuppaluppo(
  sheet: XLSX.WorkSheet, fallbackWeek: WeekRange, source: string,
  // titleWins=false → kullanıcı haftayı ELLE seçti: dosya içi aralık yalnız uyarı
  // için okunur, karar `fallbackWeek`tir. Varsayılan (true) eski davranış:
  // otomatik yüklemede dosya kendi tarihini bilir.
  opts: { titleWins?: boolean } = {}
): UnifiedRow[] {
  const aoa: any[][] = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: null, raw: true });
  const titleWeek = weekFromTitle(aoa, fallbackWeek);
  const week = opts.titleWins === false ? fallbackWeek : titleWeek;
  if (opts.titleWins === false && titleWeek.start !== fallbackWeek.start) {
    console.warn(
      `Huppaluppo (${source}): dosya içi aralık ${titleWeek.start} haftasını söylüyor, ` +
      `kullanıcının seçtiği ${fallbackWeek.start} yazıldı.`
    );
  }

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
    // "Stok Tutarı"/"Satış Tutarı" da /tutar/ içerir → ad kolonu ASLA onlara
    // kaymasın diye name araması yukarıdaki dar kalıpla sınırlı tutulur.
    stokkod: find(/^stokkod$|^stok\s*kod|^stkid$/i), // satıcının iç ürün kodu
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
      // Satıcının iç kodu (Stokkod/StkID) — diğer normalizer'larla tutarlı olsun
      // diye artık atılmıyor; kimlik izi kalır (isim bozuksa geriye dönük iz).
      sku_id: ci.stokkod >= 0 && row[ci.stokkod] != null
        ? String(row[ci.stokkod]).replace(/\.0$/, "").trim() || null
        : null,
      barkod,
      price: null,
      sales_qty: Math.max(num(row[ci.satis]), 0),
      sales_value: ci.tutar >= 0 ? toNumOrNull(row[ci.tutar]) : null,
      stock_qty: num(row[ci.stok]),
      source_file: source,
    });
  }
  return dedupeNames(out, source);
}

// ── SAĞLIK KONTROLÜ: barkod ↔ ürün adı 1:1 mi? ──
//
// Neden gerekli: `sku_weekly` ve `sku_coverage` görünümleri (retailer, week_start,
// sku_name) ile GROUP BY yapar. Ad tekil değilse FARKLI ürünler tek satıra çöker;
// satış/stok toplamları var olmayan tek bir ürüne yazılır. (Barkod anahtarlı
// `product_coverage` doğru kalır — bu yüzden hata uzun süre görünmez.)
//
// Gerçek durum (seed/huppaluppo, 2026-05 dosyaları): kolon seçimi DOĞRU —
// "Ürün Adı" hücresinin kendisi 4 kalemde ürün adı değil, pazarlama cümlesi
// ("Mythos Cards Sezon Kartları, 2025-26 sezonu için koleksiyoncularla buluşuyor!"):
// 8684824388715 / 722 / 746 / 777. Bu barkodlar aslında sırasıyla Galatasaray /
// Fenerbahçe / Trabzonspor / Beşiktaş sezon kartlarıdır (diğer kanallar aynı
// barkodları doğru adlandırıyor), ama BU DOSYADAN bu ayrım okunamaz.
//
// Tercih: ad UYDURMAK yok. Ayırt edici ad yoksa, dosyanın kendi barkoduyla
// teklileştiriyoruz. Barkod seçildi (Stokkod/StkID değil) çünkü barkod kanallar
// arası ürün anahtarıdır (`productKey`/`product_coverage` onu kullanır) ve isme
// eklendiğinde kalem /sku sayfasındaki ad aramasıyla da bulunabilir hale gelir;
// Stokkod ise Huppaluppo'ya özel bir iç koddur, başka kanalda karşılığı yoktur.
//
// Uyarı fırlatmak yerine log: dosyayı reddetmek haftalık yüklemeyi tümden
// bloklardı — bu, çöken satırdan daha kötü bir sonuç. Bu yüzden düzelt + bağır.
// BILINEN COKLU ADLAR — DOSYADAN BAGIMSIZ.
//
// Tekillestirme eskiden yalnizca "o dosyada" belirsiz olan adlara uygulaniyordu.
// Ayni ad bir hafta 3 barkodla gelince "Ad · barkod", baska hafta tek barkodla
// gelince yalin "Ad" olarak yaziliyordu — sku_weekly/sku_coverage sku_name ile
// grupladigi icin AYNI URUN IKI AYRI URUN oluyor: trend kopuyor, kapsam ve hiz
// ikiye bolunuyor, kanal tablosunda iki satir cikiyor.
// Asagidaki kume gozlemlenmis carpismalari tasir; dosya icerigi ne olursa olsun
// bu adlar HER ZAMAN barkodla teklilestirilir. Yeni bir carpisma cikarsa
// dosya-ici tespit onu yine yakalar (uyarisiyla birlikte) ve buraya eklenir.
const HER_ZAMAN_BELIRSIZ = new Set<string>([
  "Mythos Cards Sezon Kartları, 2025-26 sezonu için koleksiyoncularla buluşuyor!",
]);

function dedupeNames(rows: UnifiedRow[], source: string): UnifiedRow[] {
  const byName = new Map<string, Set<string>>();
  for (const r of rows) {
    const bk = r.barkod ?? "";
    if (!byName.has(r.sku_name)) byName.set(r.sku_name, new Set());
    byName.get(r.sku_name)!.add(bk);
  }
  const ambiguous = new Map<string, string[]>();
  for (const [name, bks] of byName) {
    if (bks.size > 1 || HER_ZAMAN_BELIRSIZ.has(name)) ambiguous.set(name, [...bks].sort());
  }
  if (ambiguous.size === 0) return rows;

  for (const [name, bks] of ambiguous) {
    console.warn(
      `Huppaluppo SAĞLIK UYARISI (${source}): "${name}" adı ${bks.length} ayrı barkoda düşüyor ` +
      `(${bks.join(", ")}). Kaynak dosyada bu kalemlerin "Ürün Adı" hücresi ayırt edici değil. ` +
      `İsim-anahtarlı görünümlerde (sku_weekly/sku_coverage) çökmemesi için ad barkodla ` +
      `teklileştirildi; kalıcı çözüm barkod → kanonik ad eşlemesidir (product_alias).`
    );
  }
  return rows.map((r) =>
    ambiguous.has(r.sku_name)
      ? { ...r, sku_name: r.sku_name ? `${r.sku_name} · ${r.barkod}` : String(r.barkod) }
      : r
  );
}
