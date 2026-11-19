// ── Fiyat enrichment: TEK KAYNAK ──────────────────────────────────────────────
// İŞ: barkodu olan, adedi olan, ama cirosu boş (NULL) ya da 0 gelen satırlara
// temsili birim fiyattan ciro yazmak. Bazı firmalar dosyada ciro göndermiyor —
// ölçüm (seed/, 2026-05 haftaları): D&R-Kategori 231/231 satır ve Nezih 129/129
// satır `sales_value = null` ile geliyor; Toyzz'un PSF'i var (barkodu 21-27 Eylül
// 2026'dan beri dosyada; öncesi Kalem Kodu'yla geri işlendi, bkz. lib/toyzz-barkod.ts),
// Huppaluppo ve Armağan gerçek TL taşıyor.
//
// NEDEN AYRI MODÜL (2026-08):
// Aynı mantık iki yerde çalışıyor: panel yüklemesi (src/app/api/upload/route.ts)
// ve toplu yükleme (scripts/seed.ts). Eskiden İKİ AYRI KOPYAYDI ve semantikleri
// farklıydı:
//   • upload: yalnız yüklenen (firma, hafta) dilimini işliyor, fiyatı önce o
//     haftanın kendi satırlarından alıyordu,
//   • seed:   TÜM geçmişten barkod başına TEK global medyan hesaplıyor, üstelik
//     yalnız `sales_value IS NULL` satırlarını dolduruyordu (0 olanları atlıyordu).
// Sonuç: aynı Excel `npm run seed` ile ve panelden yüklendiğinde FARKLI
// `sales_value` üretebiliyordu; "ciro neden değişti?" sorusu cevaplanamıyordu.
// Artık tek uygulama var; iki yol arasındaki gerçek fark yalnız PARAMETRE —
// seed 100+ dilim verir, panel 1-2 dilim.
//
// FİYAT SÖZLÜĞÜ SIRASI (dilim başına, ilk bulan kazanır):
//   0. "fatura"  → YALNIZ faturalı kanal (D&R, lib/fatura-fiyat.ts): haftanın son
//                  gününe kadar kesilmiş faturalardan FIFO birim fiyatı (o hafta
//                  satılan birimler, hafta sonu stoğunun altındaki partiler), PSF'ye
//                  çevrilmiş.
//                  Haftadan önce faturası olmayan barkod 1. kaynağa bakar; orada da
//                  yoksa ilk SONRAKİ faturayı alır (kanallar arası medyandan iyidir).
//                  Fatura fiyatı kanala ve tarihe özgü olduğu için sku_prices'a
//                  (kanallar arası, tarihsiz önbellek) YAZILMAZ.
//   1. "week"    → o (firma, hafta) diliminin kendi fiyatlı satırlarından medyan.
//                  En güncel kanıt; haftanın kendi fiyatı varsa geçmişe bakılmaz.
//   2. "cache"   → sku_prices önbelleği (bugün 165 satır, tek sorgu).
//   3. "history" → yalnız 1 ve 2'de bulunmayan barkodlar için HEDEFLİ geçmiş
//                  taraması (tipik olarak yeni ürün). Eski upload sürümü her
//                  yüklemede tüm geçmişi tarıyordu: 35.314 satır = 36 SIRALI
//                  sayfa ≈ 6,5 sn ve veri büyüdükçe doğrusal artıyordu; kapsam
//                  dilime indirilince iş yükü geçmişin boyutundan bağımsız oldu.
//
// DİLİM BAŞINA SÖZLÜK (çağrı başına DEĞİL): sözlük her dilim için ayrı kurulur.
// Bu bilinçli bir tercih — tek haftayı panelden yüklemek ile aynı haftayı 100
// dilimlik bir seed içinde yüklemek AYNI fiyatı üretsin. Sözlük çağrı düzeyinde
// olsaydı (eski upload davranışı) 3 haftalık tek bir yükleme üç haftanın
// birleşiminden medyan alır, tek tek yükleme almazdı.
//
// SIRA DETERMİNİZMİ: dilimler (week_start, retailer) ile sıralanır. Bir dilimde
// hesaplanan medyan sonraki dilimlerin önbelleğine yazılır (sıralı yüklemede
// sku_prices üzerinden olan şeyin aynısı); sıra sabit olmasa aynı seed iki kez
// çalıştığında farklı sonuç verebilirdi.
import type { SupabaseClient } from "@supabase/supabase-js";
import { fetchAllRows } from "./supabase";
import {
  FATURALI_KANAL,
  faturaIndeksiYukle,
  faturaNeti,
  haftaSonu,
  netFaturadanPsf,
  type FaturaIndeksi,
} from "./fatura-fiyat";

export type PriceSlice = { retailer: string; week_start: string };

// Fiyatın hangi kaynaktan geldiği — teşhis/raporlama için (ör. "history" payı
// büyükse dosyalarda ciro kolonu kaybolmuş olabilir).
export type PriceSource = "fatura" | "week" | "cache" | "history";

export type EnrichOptions = {
  // false → hiçbir şey YAZILMAZ (kuru çalıştırma / ölçüm). Plan yine döner.
  apply?: boolean;
  // İlerleme/teşhis satırları. seed console.log verir, upload sessiz kalır.
  log?: (msg: string) => void;
  // Kanal → fatura indeksi. Verilmezse faturalı kanallar için fatura_fiyat
  // tablosundan okunur (tablo yoksa faturasız eski yol). Toplu düzeltme betiği
  // ve testler indeksi doğrudan verir.
  fatura?: Record<string, FaturaIndeksi | null>;
};

export type PlannedUpdate = { id: number; sales_value: number; price: number };

export type EnrichResult = {
  slices: number;
  gaps: number; // ciro boşluğu olan satır sayısı
  filled: number; // fiyatı bulunup doldurulan satır
  unpriced: number; // fiyatı hiçbir kaynakta bulunamayan satır
  failed: number; // DB update hatası (apply=true iken)
  // Dosyadan hiç fiyat gelmediği için türetilmiş satırlara düşülen barkod sayısı
  // (son çare). Artıyorsa o ürünlerin cirosu kendi kendine referans veriyor.
  derivedFallback: number;
  // Faturadan doldurulan satır (yalnız faturalı kanal).
  faturaIle: number;
  priceMap: Map<string, number>; // barkod → birim fiyat (son hesaplanan)
  sourceOf: Map<string, PriceSource>; // barkod → fiyat kaynağı
  updates: PlannedUpdate[]; // apply=false iken de dolu (kuru çalıştırma)
};

// Medyan: ortalama yerine medyan, çünkü tek bir kampanya/iade satırı (ör. 1 TL'ye
// düşmüş birim fiyat) ortalamayı savurur, medyanı savurmaz.
export function median(a: number[]): number {
  const s = [...a].sort((x, y) => x - y);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

// Birim fiyat = ciro / adet. Geçersiz (0, negatif, sonsuz) sonuç sözlüğe girmez.
export function unitPrice(
  salesValue: unknown,
  salesQty: unknown,
): number | null {
  const u = Number(salesValue) / Number(salesQty);
  return isFinite(u) && u > 0 ? u : null;
}

// ── Türetilmiş ciro nasıl ayırt edilir? ──────────────────────────────────────
// Medyan yalnız DOSYADAN gelen paraya dayanmalı. Enrichment bir satıra ciro
// yazarken `price` kolonunu da yazıyor; dosyasında fiyat kolonu OLMAYAN firmalarda
// (D&R, Nezih, Huppaluppo — normalizer'ları `price: null` üretir) bu yüzden
// "price dolu" = "bu ciro türetilmiştir" demek.
// İstisna, dosyasında fiyat kolonu OLAN firmalar:
//   • Armağan → "Satış Fiyatı" (PSF), ciro = PSF × adet (normalizers/armagan.ts)
//   • Toyzz   → "Psf"/"PSF"     (normalizers/asepto.ts, aggregatePsf)
// Toyzz 2026-09-28'den beri barkodlu: PSF'i barkod medyanına DOSYA KANITI olarak
// girer ve aynı barkodlu, fiyatsız başka firma satırlarını (D&R-Kategori, Nezih)
// doldurabilir. Bu bilinçli bir karar (kullanıcı, 2026-09-28): ölçek farkı ölçüldü
// (aynı barkodda Toyzz/D&R medyan 1,60, n=110) ve yine de 0 TL'den iyi sayıldı.
// Geri almak için 3. kaynakta (geçmiş taraması) dilim Toyzz değilse Toyzz
// satırlarını kanıttan çıkarmak yeter.
//
// KIRILGANLIK NOTU: bu bir çıkarım, veri değil. Kalıcı çözüm fact_weekly'ye
// fiyat kaynağı kolonu eklemektir (price_source: file | derived) — şema
// değişikliği olduğu için burada yapılmadı, raporlandı.
const PRICE_IN_FILE = new Set(["Armağan", "Toyzz"]);
const fromFile = (r: { retailer?: string | null; price?: number | null }) =>
  r.price == null || (r.retailer != null && PRICE_IN_FILE.has(r.retailer));

type GapRow = { id: number; barkod: string; sales_qty: number };
type PricedRow = {
  barkod: string;
  sales_value: number;
  sales_qty: number;
  // Türetilmiş/dosya ayrımı için — sözlüğe hangi kanıtın gireceğini belirler.
  price: number | null;
  retailer?: string | null;
};

// Barkod başına birim fiyatları topla; dosya kanıtını ayrı tut.
type Evidence = { file: number[]; all: number[] };
function collect(rows: PricedRow[]): Map<string, Evidence> {
  const by = new Map<string, Evidence>();
  for (const r of rows) {
    const u = unitPrice(r.sales_value, r.sales_qty);
    if (u == null) continue;
    let e = by.get(r.barkod);
    if (!e) {
      e = { file: [], all: [] };
      by.set(r.barkod, e);
    }
    e.all.push(u);
    if (fromFile(r)) e.file.push(u);
  }
  return by;
}

// Kanıttan medyan: DOSYA kanıtı varsa yalnız onu kullan. Yoksa SON ÇARE olarak
// türetilmiş satırlara düş — ölçüm (2026-08): 160 barkodun 5'inde dosyadan hiç
// fiyat gelmemiş; onları fiyatsız bırakmak ciroyu 0'a düşürürdü, ki bu kaymadan
// daha kötü bir sonuç. `derived` bayrağı çağırana bunu bildirir.
function medianOf(
  e: Evidence,
): { price: number; samples: number; derived: boolean } | null {
  if (e.file.length)
    return { price: median(e.file), samples: e.file.length, derived: false };
  if (e.all.length)
    return { price: median(e.all), samples: e.all.length, derived: true };
  return null;
}

// Dilimleri (week_start, retailer) sırasına koy + tekrarları at.
function normalizeSlices(slices: PriceSlice[]): PriceSlice[] {
  const seen = new Set<string>();
  const out: PriceSlice[] = [];
  for (const s of slices) {
    const k = `${s.retailer}|${s.week_start}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push({ retailer: s.retailer, week_start: s.week_start });
  }
  return out.sort((a, b) =>
    a.week_start === b.week_start
      ? a.retailer.localeCompare(b.retailer)
      : a.week_start.localeCompare(b.week_start),
  );
}

export async function enrichPrices(
  db: SupabaseClient,
  slices: PriceSlice[],
  opts: EnrichOptions = {},
): Promise<EnrichResult> {
  const apply = opts.apply !== false;
  const log = opts.log ?? (() => {});
  const work = normalizeSlices(slices);

  const result: EnrichResult = {
    slices: work.length,
    gaps: 0,
    filled: 0,
    unpriced: 0,
    failed: 0,
    derivedFallback: 0,
    faturaIle: 0,
    priceMap: new Map(),
    sourceOf: new Map(),
    updates: [],
  };
  if (!work.length) return result;

  // Fiyat önbelleği: sku_prices tablosu + bu çağrıda hesaplanan medyanlar.
  // Tablo çağrı başına BİR kez ve yalnız gerçekten gerekirse okunur (dilim başına
  // değil: 100 dilimlik seed'de aynı 165 satırı 100 kez çekmenin anlamı yok).
  // Bu çağrıda hesaplanan medyanlar da buraya yazılır; böylece sonraki dilimler,
  // haftalar tek tek yüklenirken sku_prices'tan okuyacakları değerin aynısını
  // görür — seed ile panel aynı sonucu üretsin.
  const cache = new Map<string, number>();
  // sku_prices'a yazılacak satırlar: YALNIZ medyanı bu çağrıda hesaplanan
  // barkodlar (kaynak 1 ve 3). Önbellekten okunan değer yeniden yazılmaz —
  // eskiden tüm tablo her yüklemede baştan yazılıyordu.
  const computed = new Map<
    string,
    { price: number; samples: number; lastSeen: string }
  >();
  let cacheLoaded = false;
  const ensureCache = async () => {
    if (cacheLoaded) return;
    cacheLoaded = true;
    const rows = await fetchAllRows<{ barkod: string; median_price: number }>(
      (from, to) =>
        db
          .from("sku_prices")
          .select("barkod, median_price")
          .order("barkod")
          .range(from, to),
      { label: "sku_prices sözlüğü" },
    );
    let n = 0;
    for (const c of rows) {
      const p = Number(c.median_price);
      if (!isFinite(p) || p <= 0) continue;
      // Bu çağrıda hesaplanan değer tablodakinden yenidir — üzerine yazılmaz.
      if (computed.has(c.barkod)) continue;
      cache.set(c.barkod, p);
      n++;
    }
    log(`sku_prices önbelleği: ${n} barkod`);
  };

  const noteComputed = (
    bk: string,
    price: number,
    samples: number,
    week: string,
    src: PriceSource,
  ) => {
    // last_seen = barkodun bu çağrıda görüldüğü EN YENİ hafta.
    const prev = computed.get(bk)?.lastSeen;
    computed.set(bk, {
      price,
      samples,
      lastSeen: prev && prev > week ? prev : week,
    });
    result.priceMap.set(bk, price);
    result.sourceOf.set(bk, src);
    cache.set(bk, price);
  };

  // Fatura indeksi kanal başına bir kez (verildiyse o kullanılır).
  const faturaCache = new Map<string, FaturaIndeksi | null>(
    Object.entries(opts.fatura ?? {}),
  );
  const faturaOf = async (ret: string): Promise<FaturaIndeksi | null> => {
    if (!FATURALI_KANAL.has(ret)) return null;
    if (!faturaCache.has(ret))
      faturaCache.set(ret, await faturaIndeksiYukle(db, ret));
    return faturaCache.get(ret) ?? null;
  };

  const allUpdates: PlannedUpdate[] = [];

  for (const s of work) {
    // İki sorgu paralel: boşluk satırları (yazılacaklar) + fiyatlı satırlar (sözlük).
    const [gapRows, pricedRows] = await Promise.all([
      // Ciro BOŞLUKLARI: barkodu olan, adedi olan, cirosu NULL ya da 0 satırlar.
      // `IS NULL` tek başına yetmiyordu: ölçümde 29 satır / 675 adet
      // `sales_value = 0` ile gelip ciroya hiç girmiyordu. sales_qty = 0 satırları
      // dışarıda — fiyat × 0 = 0, bilgi taşımayan bir yazma olur.
      fetchAllRows<GapRow>(
        (from, to) =>
          db
            .from("fact_weekly")
            .select("id, barkod, sales_qty")
            .eq("retailer", s.retailer)
            .eq("week_start", s.week_start)
            .not("barkod", "is", null)
            .gt("sales_qty", 0)
            .or("sales_value.is.null,sales_value.eq.0")
            .order("id")
            .range(from, to),
        { label: `enrich boşluk ${s.retailer} ${s.week_start}` },
      ),
      // `price` ve `retailer` da çekilir: türetilmiş ciroyu sözlükten dışlamak
      // için gerekiyor (bkz. fromFile).
      fetchAllRows<PricedRow>(
        (from, to) =>
          db
            .from("fact_weekly")
            .select("barkod, sales_value, sales_qty, price, retailer")
            .eq("retailer", s.retailer)
            .eq("week_start", s.week_start)
            .not("barkod", "is", null)
            .gt("sales_value", 0)
            .gt("sales_qty", 0)
            .order("id")
            .range(from, to),
        { label: `enrich fiyat ${s.retailer} ${s.week_start}` },
      ),
    ]);
    result.gaps += gapRows.length;
    if (!gapRows.length) continue; // bu dilimde doldurulacak boşluk yok

    // 1. kaynak: haftanın kendi satırlarındaki DOSYA fiyatı. Burada türetilmiş
    // satıra düşülmez — haftanın kendi türetilmiş cirosu, o haftanın "kanıtı"
    // değil, bir önceki hesabın kopyasıdır. Böyle bir barkod 2./3. kaynağa gider;
    // orada geçmişin dosya kanıtı, o da yoksa son çare türetilmiş medyan var.
    const fresh = collect(pricedRows);
    // Dilim sözlüğü: bu dilimin boşluklarını YALNIZ bu harita doldurur.
    const price = new Map<string, number>();
    const need = new Set<string>();
    // 0. kaynak: fatura (yalnız faturalı kanal). Haftadan önce faturası olmayan
    // barkodun ilk sonraki faturası `faturaSonra`da bekler (dosya kanıtından sonra).
    const fidx = await faturaOf(s.retailer);
    const sonGun = haftaSonu(s.week_start);
    const faturaSonra = new Map<string, number>();
    const faturali = new Set<string>();
    // FIFO için barkodun bu dilimdeki toplam stoğu ve satışı (mağaza kırılımlı
    // haftada tüm mağazaların toplamı). Yalnız faturalı kanalda sorulur.
    const rafOf = new Map<string, { stok: number; satis: number }>();
    if (fidx) {
      const rr = await fetchAllRows<{
        barkod: string;
        sales_qty: number;
        stock_qty: number;
      }>(
        (from, to) =>
          db
            .from("fact_weekly")
            .select("barkod, sales_qty, stock_qty")
            .eq("retailer", s.retailer)
            .eq("week_start", s.week_start)
            .not("barkod", "is", null)
            // (sku_name, id): yalnız `id` D&R'ın en yeni haftasında birincil
            // anahtar taramasına düşüp soğukta saniyeler sürüyor (api/kanal notu).
            .order("sku_name")
            .order("id")
            .range(from, to),
        { label: `enrich raf ${s.retailer} ${s.week_start}` },
      );
      for (const r of rr) {
        const e = rafOf.get(r.barkod) ?? { stok: 0, satis: 0 };
        e.stok += Math.max(0, Number(r.stock_qty) || 0);
        e.satis += Math.max(0, Number(r.sales_qty) || 0);
        rafOf.set(r.barkod, e);
      }
    }
    for (const g of gapRows) {
      if (price.has(g.barkod) || need.has(g.barkod)) continue;
      const raf = rafOf.get(g.barkod);
      const f = fidx
        ? faturaNeti(fidx, g.barkod, sonGun, raf?.stok ?? 0, raf?.satis ?? 1)
        : null;
      if (f?.once) {
        const p = netFaturadanPsf(f.net, s.retailer);
        price.set(g.barkod, p);
        faturali.add(g.barkod);
        result.priceMap.set(g.barkod, p);
        result.sourceOf.set(g.barkod, "fatura");
        continue;
      }
      if (f) faturaSonra.set(g.barkod, netFaturadanPsf(f.net, s.retailer));
      const own = fresh.get(g.barkod);
      if (own && own.file.length) {
        const p = median(own.file);
        price.set(g.barkod, p);
        noteComputed(g.barkod, p, own.file.length, s.week_start, "week");
      } else {
        need.add(g.barkod);
      }
    }

    // Dosya kanıtı olmayan, faturası haftadan sonra kesilmiş barkod: ilk fatura.
    for (const [bk, p] of faturaSonra) {
      if (!need.has(bk)) continue;
      price.set(bk, p);
      faturali.add(bk);
      result.priceMap.set(bk, p);
      result.sourceOf.set(bk, "fatura");
      need.delete(bk);
    }

    // 2. kaynak: sku_prices önbelleği (+ bu çağrıda hesaplanmış medyanlar).
    if (need.size) {
      await ensureCache();
      for (const bk of [...need]) {
        const p = cache.get(bk);
        if (p != null) {
          price.set(bk, p);
          result.priceMap.set(bk, p);
          if (!result.sourceOf.has(bk)) result.sourceOf.set(bk, "cache");
          need.delete(bk);
        }
      }
    }

    // 3. kaynak: hedefli geçmiş taraması. Bu küme normalde boş/çok küçük olduğu
    // için eski tam-tablo taramasının maliyetine dönmüyoruz. `in()` listesi URL'e
    // gittiği için parçalanır (200 barkod ≈ 3KB).
    // KRİTİK: geçmişte önceki enrichment'ların YAZDIĞI ciro satırları bu medyana
    // GİRMEZ (bkz. fromFile). Girdiğinde ölçülen etki: 35.314 fiyat kaynağı
    // satırının 2.061'i (%5,8) türetilmiş ve 155 barkodun 8'inde medyanı %2'den
    // fazla, birinde %17,8 kaydırıyor — ör. 8684824388777: dosya kanıtı 799,00 TL
    // derken 30 türetilmiş satır medyanı 665,83 TL'ye çekiyor. Türetilmiş satır
    // sayısı her yüklemede arttığı için bu, zamanla dosya kanıtını bastıran bir
    // kayma; kaynağı burada kesiliyor.
    if (need.size) {
      const bks = [...need];
      const IN_CHUNK = 200;
      for (let i = 0; i < bks.length; i += IN_CHUNK) {
        const part = bks.slice(i, i + IN_CHUNK);
        const hist = await fetchAllRows<PricedRow>(
          (from, to) =>
            db
              .from("fact_weekly")
              .select("barkod, sales_value, sales_qty, price, retailer")
              .in("barkod", part)
              .gt("sales_value", 0)
              .gt("sales_qty", 0)
              .order("id")
              .range(from, to),
          { label: `enrich geçmiş medyan (${part.length} barkod)` },
        );
        for (const [bk, ev] of collect(hist)) {
          const m = medianOf(ev);
          if (!m) continue;
          price.set(bk, m.price);
          noteComputed(bk, m.price, m.samples, s.week_start, "history");
          if (m.derived) result.derivedFallback++;
          need.delete(bk);
        }
      }
    }

    for (const g of gapRows) {
      const p = price.get(g.barkod);
      if (p == null) {
        result.unpriced++;
        continue;
      }
      if (faturali.has(g.barkod)) result.faturaIle++;
      allUpdates.push({
        id: g.id,
        sales_value: p * Number(g.sales_qty),
        price: p,
      });
    }
    if (need.size) {
      log(
        `${s.retailer} ${s.week_start}: ${need.size} barkodun fiyatı hiçbir kaynakta yok (ciro boş kalıyor)`,
      );
    }
  }

  result.updates = allUpdates;
  result.filled = allUpdates.length;

  if (!apply) {
    log(
      `KURU ÇALIŞTIRMA: ${result.gaps} boşluk, ${result.filled} satır doldurulabilir, ${result.unpriced} fiyatsız — hiçbir şey yazılmadı.`,
    );
    return result;
  }

  // sku_prices tazele — sonraki yüklemeler 2. kaynaktan bedavaya faydalanır.
  // Yalnız bu çağrıda medyanı HESAPLANAN barkodlar yazılır (önbellekten okunan
  // değer geri yazılmaz); tablo bu yüzden her yüklemede baştan yazılmıyor.
  const priceRows = [...computed.entries()].map(([barkod, v]) => ({
    barkod,
    median_price: v.price,
    samples: v.samples,
    last_seen: v.lastSeen,
    updated_at: new Date().toISOString(),
  }));
  for (let i = 0; i < priceRows.length; i += 1000) {
    const { error } = await db
      .from("sku_prices")
      .upsert(priceRows.slice(i, i + 1000), { onConflict: "barkod" });
    if (error) console.error("sku_prices upsert hatası:", error.message);
  }

  // Boşlukları doldur. Satır bazında update: fact_weekly'de toplu yazma yolu
  // upsert olurdu, ama kısmi kolonlu upsert bir id bulunamazsa INSERT'e döner ve
  // store/sku_id/source_file'ı boş bırakır — sistemin TEK yazma yolunda bu riski
  // almıyoruz. Kapsam dilimlere indiği için satır sayısı sınırlı.
  for (let i = 0; i < allUpdates.length; i += 200) {
    const res = await Promise.all(
      allUpdates
        .slice(i, i + 200)
        .map((u) =>
          db
            .from("fact_weekly")
            .update({ sales_value: u.sales_value, price: u.price })
            .eq("id", u.id),
        ),
    );
    result.failed += res.filter((r) => r.error).length;
  }
  // Eski sürüm update hatalarını sessizce yutuyordu — eksik ciro fark edilmiyordu.
  if (result.failed) {
    console.error(
      `enrichPrices: ${result.failed}/${allUpdates.length} ciro güncellemesi başarısız.`,
    );
  }
  log(
    `${result.filled} satır TL ile dolduruldu (${result.faturaIle} faturadan; ${result.unpriced} satır fiyatsız kaldı).`,
  );
  if (result.derivedFallback) {
    log(
      `${result.derivedFallback} barkodda dosyadan hiç fiyat gelmemiş; medyan türetilmiş satırlardan alındı (son çare).`,
    );
  }
  return result;
}

// ── İDEMPOTENCE: aynı hafta iki kez yüklenirse ciro KAYAR MI? ────────────────
// Soru tekrar geleceği için cevap ve ÖLÇÜM burada duruyor (2026-08, fact_weekly
// 449.690 satır, sku_prices 160 barkod).
//
// KISA CEVAP: Aynı haftayı üst üste yüklemek KAYMA YARATMIYOR (ölçüldü, aşağıda).
// Ama kaymanın gerçek yolu farklıydı ve VARDI: türetilmiş cironun bir sonraki
// haftanın medyanına girmesi. O yol kapatıldı (bkz. fromFile).
//
// 1) YAZMA SIRASI DÖNGÜYÜ KESER. Yükleme önce (firma, hafta) dilimini
//    DELETE + INSERT eder, enrichment ONDAN SONRA çalışır. İkinci yüklemede o
//    haftanın türetilmiş ciroları çoktan normalizer haline (NULL) dönmüştür;
//    dilimin kendi türetilmiş değeri kendi medyanına giremez.
//
// 2) TÜRETİLMİŞ SATIRLAR ARTIK SÖZLÜĞE GİRMİYOR. Girdiğinde ölçülen etki:
//    fiyat kaynağı olabilecek 35.314 satırın 2.061'i (%5,8) türetilmiş; 155
//    barkodun 8'inde medyanı %2'den fazla, en fazla %17,8 kaydırıyordu
//    (8684824388777: dosya kanıtı 799,00 TL, türetilmiş satırlarla 665,83 TL —
//    30 türetilmiş satır 22 gerçek satırı bastırıyor). Türetilmiş satır sayısı
//    her yüklemede arttığı için bu tek seferlik bir sapma değil, birikmeli bir
//    kaymaydı.
//
// 3) ÖLÇÜM (sahte "yeniden yükleme" client'ı ile, DB'ye yazmadan; hedef dilim
//    DELETE+INSERT sonrası hali gibi gösterildi ve 1. turun sku_prices'a
//    yazacağı medyanlar 2. tura verildi):
//      • D&R 2026-08-03  (263 satır, 102 ciro boşluğu): 1. tur 85 satır doldurdu,
//        2. tur 85 satır — 85/85 AYNI, maks |Δ| = 0,00 TL.
//      • Nezih 2026-08-03 (70 satır, 36 boşluk): 35/35 AYNI, maks |Δ| = 0,00 TL.
//      • Aynı test sku_prices BOŞ gösterilerek de yapıldı (tüm barkodlar geçmiş
//        taramasına düşüyor): yine 85/85 ve 35/35 aynı. Yani hem önbellek hem
//        geçmiş yolu sabit noktada.
//
// SINIRI DA YAZALIM:
//  • sku_prices'ta ESKİ (bu düzeltmeden önce yazılmış) medyanlar duruyor ve
//    önbellek 3. kaynaktan önce sorulduğu için onlar kazanmaya devam eder.
//    Ölçüm: D&R 2026-08-03'ün 85 satırının 25'inde önbellek değeri ile dosya
//    kanıtı medyanı ayrışıyor (maks %23,6). Bunları hizalamanın yolu sku_prices'ı
//    bir kez baştan hesaplamaktır (veri işi, kod işi değil).
//  • Önbelleğin geçmiş taramasından ÖNCE gelmesi performans tercihidir, ölçüldü:
//    aynı dilim önbelleksiz 12,6 sn, önbellekli 1,3 sn. Yükleme yolu
//    maxDuration = 60 ile çalıştığı için sıra korunuyor.
//  • Türetilmiş/dosya ayrımı `price` kolonundan ÇIKARILIYOR (bkz. PRICE_IN_FILE).
//    Sağlam çözüm fact_weekly'ye açık bir fiyat kaynağı kolonu eklemek
//    (price_source: file | derived); ŞEMA değişikliği olduğu için yapılmadı.
