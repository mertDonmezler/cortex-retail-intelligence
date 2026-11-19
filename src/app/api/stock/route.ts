import { NextRequest, NextResponse } from "next/server";
import { supabase, fetchAllRows } from "@/lib/supabase";
import {
  coverageStatus,
  groupDeadStock,
  computeCoverage,
  summarizeCoverage,
  buildVelocityIndex,
  velocityOf,
  isStale,
  lastSeenOf,
  VELOCITY_WEEKS,
  WINDOW_WEEKS,
  sonTamamlanmisHafta,
  gecikmeHaftasi,
  yaslandir,
  type CoverageItem,
  type CoverageRow,
  type SkuWeekRow,
  type VelocityIndex,
} from "@/lib/compute";
import { kapaliMi, kapaliKayit, KAPALI_TOPLAM } from "@/lib/kapali-urunler";
import { isWeek, isRetailer, badRequest, optionalWeek } from "@/lib/params";

export const runtime = "nodejs";
export const revalidate = 0;
export const maxDuration = 60;

// Tek "Stok" merkezi API'si.
//
// 1) Parametresiz (ağ geneli) — varsayılan davranış:
//    product_coverage matview'inden firma×ürün satırları; HIZ ve KAPSAM ise
//    sku_weekly'nin son penceresinden GÜNCEL olarak hesaplanır (aşağıya bak).
//    Aynı sorgudan ürün bazında firmalar arası birleştirilmiş "ölü stok"
//    görünümü (products) de üretilir. Filtreleme istemcide.
//
// 2) ?retailer=X (+ opsiyonel ?store=Y) — anlık coverage:
//    Belirli bir firma/mağaza için stok süresi. store verilmezse firma geneli
//    (sku_coverage + güncel hız); verilirse o mağazanın fact_weekly satırlarından
//    anlık hesap (computeCoverage). { summary, skus } döner.
//
// ── İKİ KÖK DÜZELTME (ölçülen) ──
// A) HIZ ÖMÜR BOYU DEĞİL GÜNCEL. Matview'lerin avg_weekly'si total_sales/toplam_hafta
//    yani ömür ortalamasıdır; lansmanda patlayıp normale dönen üründe gerçek talebin
//    katlarına çıkıyor. Ölçülen: 66 "kritik" satırın 37'si SAHTE (ör. Toyzz GS
//    Pre-Season ömür 886,9/hf ↔ güncel 76,6/hf; kapsam 2,6 hf sanılırken gerçekte
//    30,4 hf). Karşılaştırılabilir 442 satırın 111'i (%25) ≥2× sapıyordu.
//    Çözüm: hız sku_weekly'den kanal başına son VELOCITY_WEEKS hafta üzerinden.
//    Bu, /yonlendirme'nin kullandığı ölçütle AYNI → iki ekran aynı girdiyi paylaşır.
// B) BAYAT (stale) STOK GÖRÜNÜR. product_coverage.last_stock, ÜRÜNÜN kendi son
//    haftasındaki stoktur (firmanın güncel haftası değil) ve last_week matview'in
//    final select'inde DIŞA VERİLMEDİĞİ için (select=last_week → 42703) API bunu
//    göremiyordu. Sonuç: aylar önce raporlardan düşmüş ürünün stoğu toplanmaya devam
//    ediyordu. Ölçülen hayali stok: Toyzz +7.865, DR +56, Nezih +4 adet.
//    Çözüm: her firmanın güncel haftasındaki ürün kümesi sku_weekly'den çıkarılır,
//    bu kümede olmayan satır stale=true ile işaretlenir; sayımlardan/manşetten çıkar,
//    listede rozetle kalır. Doğrulama: 5 firmanın hepsinde weekly_summary son hafta
//    stoğuyla sapma 0'a indi (önce Toyzz +7.865).

// Ağ görünümünde ürün anahtarı, product_coverage'ın SQL'iyle BİREBİR aynı kurulmalı;
// yoksa sku_weekly ile join kaybolur. SQL:
//   coalesce(nullif(f.barkod,''), pa.barkod, 'NAME:' || f.sku_name)
// (routing'in clean() varyantı barkodu 8-14 haneye zorlar; ölçümde iki yöntem de
// 718/718 anahtarı eşleştirdi, yine de burada SQL kuralı esas alınır.)
function makePkOf(aliases: Map<string, string>) {
  return (row: SkuWeekRow): string => {
    const b = row.barkod == null || row.barkod === "" ? null : row.barkod;
    return (
      b ??
      aliases.get(row.retailer + "|" + row.sku_name) ??
      "NAME:" + row.sku_name
    );
  };
}

const r1 = (n: number) => Math.round(n * 10) / 10; // yanıt boyutu: 1 ondalık yeter

// Global hafta penceresi: ağdaki en yeni WINDOW_WEEKS hafta. Firmalar farklı
// haftalarda veri gönderdiği için global liste alınır; her firma kendi son
// VELOCITY_WEEKS haftasını bu kümede bulur (global 8 hafta bazı firmaya yalnız
// 6 hafta düşürüyordu — ölçüldü).
// `retailer` ALANI DA ÇEKİLİR: firma bazlı son hafta (veri yaşı) buradan okunur.
// Gecikme /api/routing ile AYNI kaynaktan ve AYNI saf fonksiyonla hesaplanmalı,
// yoksa iki ekranda iki farklı "4 hafta geride" doğar — bu projenin kapatmaya
// çalıştığı hata sınıfının aynısı. `data_freshness.last_import` OKUNMAZ:
// Nezih'te last_import 2026-06-24 ↔ last_week 2026-08-03, yani alan güvenilmez.
async function haftaSerisi(retailer?: string | null): Promise<{
  weeks: string[];
  lastWeekOf: Record<string, string>;
}> {
  let q = supabase
    .from("weekly_summary")
    .select("retailer, week_start")
    .order("week_start", { ascending: false });
  if (retailer) q = q.eq("retailer", retailer);
  const { data, error } = await q;
  if (error) throw error;
  const rows = (data ?? []) as any[];
  const lastWeekOf: Record<string, string> = {};
  for (const w of rows) {
    const cur = lastWeekOf[w.retailer];
    if (!cur || w.week_start > cur) lastWeekOf[w.retailer] = w.week_start;
  }
  return {
    weeks: [...new Set(rows.map((w) => w.week_start as string))].slice(
      0,
      WINDOW_WEEKS,
    ),
    lastWeekOf,
  };
}

// sku_weekly sayfalaması: PostgREST tek sayfada EN FAZLA 1000 satır döndürür
// (ölçüldü: range 0-4999 → 1000) ve fazlasını sessizce kırpar. fetchAllRows kararlı
// sıra ister; sku_weekly'nin BENZERSİZ anahtarı (retailer, week_start, sku_name) —
// üçüyle birlikte sıralanmazsa sayfalar çakışıp satır çiftler/kaybettirir.
async function fetchSkuWeekly(
  weeks: string[],
  retailer?: string | null,
): Promise<SkuWeekRow[]> {
  if (!weeks.length) return [];
  return fetchAllRows<SkuWeekRow>((from, to) => {
    // stock_qty: hızın böleni ürünün RAFA GELDİĞİ haftadan sayılır (compute.ts
    // buildVelocityIndex, routing velOf ile aynı kural).
    let q = supabase
      .from("sku_weekly")
      .select("retailer, week_start, sku_name, barkod, sales_qty, stock_qty")
      .in("week_start", weeks);
    if (retailer) q = q.eq("retailer", retailer);
    return q
      .order("retailer")
      .order("week_start")
      .order("sku_name")
      .range(from, to);
  });
}

// BAYAT SATIRLARIN SON GÖRÜLME HAFTASI. Hız indeksi yalnız son WINDOW_WEEKS haftayı
// kapsıyor; ondan ÖNCE listeden düşmüş üründe indeksten tarih çıkmıyor (ölçüldü:
// 8 bayat satırın 8'i de null — ASP-MYT-KART SEVİMLİ CANAVAR 7'Lİ 25 hafta önce
// görülmüş). Sadece "bayat" demek karar üretmiyor; kullanıcı firmaya "bu ürün şu
// tarihten beri raporunuzda yok, stok teyit edin" diyebilmek için tarihi görmeli.
// Bu yüzden YALNIZ eksik kalan satırlar için, isim listesiyle hedefli tek sorgu
// (pencere filtresi YOK). Bayat satır olmadığında hiç sorgu atılmaz.
async function fillLastSeen(
  pairs: { retailer: string; sku_name: string }[],
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const names = [...new Set(pairs.map((p) => p.sku_name))].filter(Boolean);
  if (!names.length) return out;
  const rows = await fetchAllRows<{
    retailer: string;
    sku_name: string;
    week_start: string;
  }>((from, to) =>
    supabase
      .from("sku_weekly")
      .select("retailer, sku_name, week_start")
      .in("sku_name", names)
      .order("retailer")
      .order("sku_name")
      .order("week_start")
      .range(from, to),
  );
  for (const r of rows) {
    const k = r.retailer + "|" + r.sku_name;
    const cur = out.get(k);
    if (!cur || r.week_start > cur) out.set(k, r.week_start);
  }
  return out;
}

export async function GET(req: NextRequest) {
  const sp = new URL(req.url).searchParams;
  const retailer = sp.get("retailer");
  const store = sp.get("store") || null;
  if (retailer && !isRetailer(retailer))
    return badRequest("Bilinmeyen perakendeci");

  // ── 2) Firma / mağaza özelinde anlık coverage ──
  if (retailer) {
    try {
      let rows: CoverageRow[];
      let idx: VelocityIndex | null = null;
      if (store) {
        // Mağaza bazlı: tek mağazanın tüm haftalık satırları → anlık coverage.
        // Hız yine son VELOCITY_WEEKS hafta üzerinden (ömür ortalaması değil).
        const facts = await fetchAllRows<{
          sku_name: string;
          week_start: string;
          sales_qty: number;
          stock_qty: number;
        }>((from, to) =>
          supabase
            .from("fact_weekly")
            .select("sku_name, week_start, sales_qty, stock_qty")
            .eq("retailer", retailer)
            .eq("store", store)
            .order("id")
            .range(from, to),
        );
        rows = computeCoverage(facts, VELOCITY_WEEKS);
      } else {
        // Firma geneli: stok/PSF matview'den, HIZ güncel pencereden.
        // Bu görünümün anahtarı doğrudan sku_name — sku_coverage ile aynı anahtar,
        // dolayısıyla ağ görünümündeki barkod/alias eşleme belirsizliği burada YOK.
        const { weeks } = await haftaSerisi(retailer);
        const [cov, sw] = await Promise.all([
          // avg_weekly/coverage_weeks ÇEKİLMEZ: ömür ortalaması olduğu için kullanılmıyor,
          // hız aşağıda sku_weekly penceresinden hesaplanıyor. Yalnız stok gerekli.
          supabase
            .from("sku_coverage")
            .select("sku_name, last_stock")
            .eq("retailer", retailer),
          fetchSkuWeekly(weeks, retailer),
        ]);
        if (cov.error) throw cov.error;
        idx = buildVelocityIndex(sw, (r) => r.sku_name);
        rows = (cov.data ?? []).map((r) => {
          const stock = Number(r.last_stock);
          const v = velocityOf(idx!, retailer, r.sku_name);
          return {
            sku_name: r.sku_name,
            avg_weekly: v,
            last_stock: stock,
            coverage: v > 0 ? stock / v : null,
            stale: isStale(idx!, retailer, r.sku_name, r.sku_name),
            last_seen: lastSeenOf(idx!, retailer, r.sku_name, r.sku_name),
          };
        });
      }
      // Pencere dışında kalan bayat satırların tarihini tamamla (bkz. fillLastSeen).
      const eksik = rows.filter((r) => r.stale && !r.last_seen);
      if (eksik.length) {
        const seen = await fillLastSeen(
          eksik.map((r) => ({ retailer, sku_name: r.sku_name })),
        );
        for (const r of eksik)
          r.last_seen = seen.get(retailer + "|" + r.sku_name) ?? null;
      }
      const { skus, summary } = summarizeCoverage(rows);
      // VERİ YAŞI BU DALDA BİLGİ OLARAK BASILIR, KIRPMA YOK.
      // Sebep ölçüm: firma dalı `sku_coverage`'ı sku_name anahtarıyla ve FİRMANIN
      // KENDİ 12 haftasıyla okuyor; ağ dalı `product_coverage` + global pencere.
      // Nezih'in 69 ürününün 26'sında iki görünümün hızı farklı — bu dalda erime
      // yayınlanırsa "aynı ürünün /stok ve /yonlendirme tahmini stoğu eşittir"
      // cümlesi 26 üründe YANLIŞ olurdu. Tahmin yalnız ağ dalında üretilir.
      const { lastWeekOf: lw } = await haftaSerisi();
      const takvimHaftasi = sonTamamlanmisHafta(new Date());
      return NextResponse.json({
        scope: store ? "magaza" : "firma",
        retailer,
        store,
        summary,
        velocity_weeks: VELOCITY_WEEKS,
        window_weeks: WINDOW_WEEKS,
        veri: {
          takvimHaftasi,
          dataWeek: lw[retailer] ?? null,
          gecikmeHf: gecikmeHaftasi(lw[retailer], takvimHaftasi),
          yaslandirma: false,
        },
        skus: skus.map((s) => ({
          sku_name: s.sku_name,
          avg_weekly: r1(s.avg_weekly),
          last_stock: s.last_stock,
          coverage: s.coverage == null ? null : r1(s.coverage),
          status: s.status,
          ...(s.stale ? { stale: true, last_seen: s.last_seen ?? null } : {}),
        })),
      });
    } catch (e: any) {
      console.error("stock (coverage) hatası:", e);
      return NextResponse.json({ error: "Sunucu hatası" }, { status: 500 });
    }
  }

  // ── 1) Ağ geneli birleşik stok durumu + ölü stok ──
  try {
    const { weeks, lastWeekOf } = await haftaSerisi();
    const takvimHaftasi = sonTamamlanmisHafta(new Date());
    const gecikmeOf = (ret: string) =>
      gecikmeHaftasi(lastWeekOf[ret], takvimHaftasi);
    const [rows, sw, aliasRows] = await Promise.all([
      fetchAllRows<any>((from, to) =>
        supabase
          .from("product_coverage")
          .select("retailer, product_key, barkod, sku_name, last_stock, psf")
          .order("product_key")
          .order("retailer")
          .range(from, to),
      ),
      fetchSkuWeekly(weeks),
      // product_key'i SQL ile aynı kurmak için onaylı alias'lar şart.
      fetchAllRows<any>((from, to) =>
        supabase
          .from("product_alias")
          .select("retailer, sku_name, barkod")
          .eq("status", "approved")
          .order("retailer")
          .order("sku_name")
          .range(from, to),
      ),
    ]);

    const aliases = new Map<string, string>(
      aliasRows.map((a) => [a.retailer + "|" + a.sku_name, a.barkod]),
    );
    const idx = buildVelocityIndex(sw, makePkOf(aliases));

    // Her satır için: stok/PSF matview'den, HIZ + KAPSAM güncel pencereden, BAYAT bayrağı.
    //
    // KAPANMIŞ ÜRÜNLER SÜZÜLMEZ, İŞARETLENİR. /api/routing'de satır hiç doğmuyor
    // (karar üretmesin), burada ise listede KALIR: tasfiye tarihini ve nedenini
    // gösterebilmek için satırın kendisi gerekli — "tarihi silmiyoruz" kuralı.
    // Sayımların (counts/live/stale) ve ölü stok görünümünün DIŞINDA tutulur.
    //
    // ERİME (drenaj / stokYaslandirilmis) YALNIZ BU DALDA ve yalnız EKRAN İÇİN:
    // `status`, `counts`, `coverage` ve sıralama RAPORLANAN stokla hesaplanmaya
    // devam eder. Ölçülen bedel: erime uygulanırsa durum etiketi değişecek kalem
    // 3 (39 adet) — toplamın binde 0,2'si; karşılığı /api/routing ile parite.
    const enriched = rows.map((r) => {
      const stock = Number(r.last_stock ?? 0);
      const psf = Number(r.psf ?? 0);
      const sku_name = r.sku_name ?? "";
      const v = velocityOf(idx, r.retailer, r.product_key);
      const cov = v > 0 ? stock / v : null;
      // KAPALI + GERİ DÖNÜŞ KAPISI — /api/routing İLE BİREBİR AYNI KURAL.
      // Kapalı kayıt, kalem firmanın GÜNCEL haftasında yeniden görünürse yok
      // sayılır. `isStale` tam olarak "firmanın güncel raporunda yok" demek,
      // yani `!isStale` = "raporda yeniden var" = kapanma kararı geçersiz.
      // BU KAPI ÖNCE YALNIZ routing'de VARDI: iki uç ayrışıyordu ve bir kalem
      // geri döndüğünde /yonlendirme onun için karar üretirken /stok onu
      // sayımların dışında tutacaktı. Bugün geriDonen boş olduğu için sessizdi;
      // eşleşme Toyzz'de AD BAZLI olduğu için tetiklenmesi gerçekçi.
      const bayatMi = isStale(idx, r.retailer, r.product_key, sku_name);
      const kapaliKayitli = kapaliMi(r.retailer, sku_name, r.barkod);
      const kapali = kapaliKayitli && bayatMi;
      const kayit = kapali ? kapaliKayit(r.retailer, sku_name, r.barkod) : null;
      const gecikmeHf = gecikmeOf(r.retailer);
      const yas = yaslandir(stock, r1(v), gecikmeHf);
      return {
        retailer: r.retailer as string,
        product_key: r.product_key as string,
        barkod: (r.barkod ?? null) as string | null,
        sku_name,
        avg_weekly: v,
        last_stock: stock,
        coverage: cov,
        psf,
        status: coverageStatus(cov, v, stock),
        stale: bayatMi,
        last_seen: lastSeenOf(idx, r.retailer, r.product_key, sku_name),
        kapali,
        // Kapalı sayılan ama raporda yeniden görünen kalem: kayıt gözden
        // geçirilmeli. Sessiz kalması, tek satırlık bir insan kararının ürünü
        // sonsuza kadar görünmez kılması riskini geri getirirdi.
        kapaliGeriDondu: kapaliKayitli && !bayatMi,
        kapaliNeden: kayit?.neden ?? null,
        kapaliTarih: kayit?.tarih ?? null,
        dataWeek: lastWeekOf[r.retailer] ?? null,
        gecikmeHf,
        drenaj: yas.drenaj,
        stokYaslandirilmis: yas.stokYaslandirilmis,
      };
    });

    // Pencere dışında kalan bayat satırların tarihini tamamla (bkz. fillLastSeen).
    const eksik = enriched.filter((it) => it.stale && !it.last_seen);
    if (eksik.length) {
      const seen = await fillLastSeen(
        eksik.map((it) => ({ retailer: it.retailer, sku_name: it.sku_name })),
      );
      for (const it of eksik)
        it.last_seen = seen.get(it.retailer + "|" + it.sku_name) ?? null;
    }

    // Birleşik stok durumu listesi (durum taşımayanlar elenir).
    const items = enriched
      .filter((it) => it.status !== "yok")
      .map((it) => ({
        retailer: it.retailer,
        sku_name: it.sku_name,
        barkod: it.barkod,
        avg_weekly: r1(it.avg_weekly),
        last_stock: it.last_stock,
        coverage: it.coverage == null ? null : r1(it.coverage),
        // Birim `psf` alanı KALDIRILDI: UI yalnız toplam stock_value'yu gösteriyordu,
        // birim fiyat hiçbir yerde okunmuyordu (ölçülen: 575 satırda ~5 KB boşa).
        // stock_value BİLİNÇLİ olarak BRÜT PSF bazlıdır (iade pazarlığı tabanı) —
        // net kazanç dönüşümü (PSF×(1−marj)/1,20) buraya UYGULANMAZ.
        stock_value: Math.round(it.last_stock * it.psf),
        status: it.status,
        // Bayrak yalnız true iken serileşir (yanıt boyutu).
        ...(it.stale ? { stale: true, last_seen: it.last_seen } : {}),
        ...(it.kapali
          ? {
              kapali: true,
              kapaliNeden: it.kapaliNeden,
              kapaliTarih: it.kapaliTarih,
            }
          : {}),
        // Veri yaşı her satırda; `stokYaslandirilmis` yalnız gerçekten eridiyse.
        dataWeek: it.dataWeek,
        gecikmeHf: it.gecikmeHf,
        ...(it.drenaj > 0
          ? { drenaj: it.drenaj, stokYaslandirilmis: it.stokYaslandirilmis }
          : {}),
      }));

    const firms = [...new Set(items.map((i) => i.retailer))].sort();
    // SAYIMLAR yalnız CANLI satırlardan: bayat stok gerçek değil, "az/fazla stok"
    // kararına dayanak olamaz. KAPANMIŞ kalemler de canlı değildir — tasfiye
    // edilmiş mal "fazla stok" sayılamaz.
    const live = items.filter((i) => !i.stale && !i.kapali);
    const counts = {
      kritik: live.filter((i) => i.status === "kritik").length,
      fazla: live.filter((i) => i.status === "fazla").length,
      saglikli: live.filter((i) => i.status === "saglikli").length,
    };
    const staleItems = items.filter((i) => i.stale && !i.kapali);
    const kapaliItems = items.filter((i) => i.kapali);
    const stale = {
      n: staleItems.length,
      stock: staleItems.reduce((a, i) => a + i.last_stock, 0),
      value: staleItems.reduce((a, i) => a + i.stock_value, 0),
    };

    // Ölü stok: ürün bazında firmalar arası birleştirilmiş görünüm (güncel hızla).
    const deadItems: CoverageItem[] = enriched
      .filter((it) => !it.kapali)
      .map((it) => ({
        retailer: it.retailer,
        product_key: it.product_key,
        barkod: it.barkod,
        sku_name: it.sku_name,
        avg_weekly: it.avg_weekly,
        last_stock: it.last_stock,
        coverage_weeks: it.coverage,
        stale: it.stale,
      }));
    // Stoksuz ürün ölü stok görünümünde ASLA gösterilmez (UI stock<=0'ı eler) ve
    // sayaç paydasına da girmez → yanıttan çıkarılır.
    const products = groupDeadStock(deadItems)
      .filter((p) => p.total_stock > 0)
      // max_firm_coverage yanıttan ÇIKARILIR: UI hiç okumuyor (yalnız birim testinde
      // doğrulanıyor) — 290 üründe boşa giden alan.
      .map(({ max_firm_coverage, ...p }) => ({
        ...p,
        total_velocity: r1(p.total_velocity),
        coverage: p.coverage == null ? null : r1(p.coverage),
        firms: p.firms.map((f) => ({
          ...f,
          velocity: r1(f.velocity),
          coverage: f.coverage == null ? null : r1(f.coverage),
        })),
      }));

    return NextResponse.json({
      items,
      firms,
      counts,
      stale,
      products,
      // KAPANMIŞ KÜME AYRI: manşetten düşen 8 kalemin nereye gittiği ekranda
      // görünmezse "stok azaldı" diye okunur.
      kapali: {
        n: kapaliItems.length,
        stock: kapaliItems.reduce((a, i) => a + i.last_stock, 0),
        value: kapaliItems.reduce((a, i) => a + i.stock_value, 0),
        tanimli: KAPALI_TOPLAM.n,
        // /api/routing'in summary.veri.kapali.geriDonen alanıyla aynı anlam.
        geriDonen: enriched
          .filter((it) => it.kapaliGeriDondu)
          .map((it) => it.retailer + " · " + it.sku_name),
      },
      velocity_weeks: VELOCITY_WEEKS,
      window_weeks: WINDOW_WEEKS,
      // /api/routing ile AYNI alan adları ve AYNI saf fonksiyonlar.
      veri: {
        takvimHaftasi,
        yaslandirma: true,
        byRetailer: Object.keys(lastWeekOf)
          .map((ret) => ({
            retailer: ret,
            dataWeek: lastWeekOf[ret],
            gecikmeHf: gecikmeOf(ret),
          }))
          .sort((a, b) => b.gecikmeHf - a.gecikmeHf),
      },
    });
  } catch (e: any) {
    console.error("stock hatası:", e);
    return NextResponse.json({ error: "Sunucu hatası" }, { status: 500 });
  }
}
