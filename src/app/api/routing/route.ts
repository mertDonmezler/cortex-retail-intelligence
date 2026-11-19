import { NextRequest, NextResponse } from "next/server";
import { supabase, fetchAllRows } from "@/lib/supabase";
import { netFactor } from "@/lib/margins";
import {
  faturaIndeksiYukle,
  faturaNeti,
  netFaturadanPsf,
} from "@/lib/fatura-fiyat";
import { kapaliMi, kapaliKayit, KAPALI_TOPLAM } from "@/lib/kapali-urunler";
import {
  sonTamamlanmisHafta,
  gecikmeHaftasi,
  kararGecikmesi,
  yaslandir,
  kademeOf,
  likidasyonKapisi,
  ERIT_SEVK_HEDEF,
  GECIKME_KAPANMA,
  LIKID_ABSORB,
  dusenTalepHizi,
  TREND_SON,
  tasiyanMagaza,
  sansurDuzeltilmisTalep,
  rafPayi,
  haftalikSatis,
  beklenenSatis,
  sorunHaftasi,
  RAF_ASGARI,
  TUT_UFKU,
  TESLIM_HF,
  MAGAZA_TASIYABILEN,
  SANSUR_TAVAN_UST,
  RAF_TAVAN_HF,
  AG_TALEP_ESIK,
  type Kademe,
  type LikidKapi,
} from "@/lib/compute";

export const runtime = "nodejs";
export const revalidate = 0;
export const maxDuration = 60;

/* UZMAN STOK YÖNLENDİRME MOTORU (saf PSF).
   Kaynaklar: MEIO/Guaranteed-Service (pull düğümü düşük emniyet), newsvendor/safety-stock
   (kapsam talep değişkenliğine bağlı), ABC-XYZ segmentasyonu, Bain 3-kova, McKinsey/HBS
   markdown & SKU-rasyonalizasyon, konsinye ekonomisi (sermaye risiki tedarikçide=biz).
   Düz "13 hf" YOK → SEGMENT×SEZON kapsam hedefi + disposition (transfer/depo/likidasyon). */
const DEAD = 1,
  ABSORB = 26,
  FLOOR = 25000,
  NEW_WEEKS = 6;
// "BU HAFTA YAPILACAKLAR" listesinin uzunluğu. Uzun liste ekipte okunmuyordu:
// 29.10'da 592 satırın 552'si çekti ve 7 sevk bu yığının içinde kayboluyordu.
const BU_HAFTA_N = 10;
// ETKİ UFKU 8 hafta: 4 haftada stoğu yeten hızlı ürünün (D&R ŞL Eco, 5 hf stok)
// sevkinin değeri 0 görünüyordu; oysa 5. haftada raf boşalıyor.
const ETKI_UFKU = 8;
// Bu tutarın (NET TL, 8 hf) altındaki iş listeye girmez; sipariş önerisinde kalır.
const BU_HAFTA_MIN = 2000;
const fmtAdet = (n: number) => Math.round(n).toLocaleString("tr-TR");
// GÜNCEL HIZ PENCERESİ. product_coverage.avg_weekly = total_sales/toplam_hafta yani
// ÖMÜR BOYU ortalamadır; lansmanda patlayıp sonra normale dönen üründe bu değer
// gerçek talebin katlarına çıkıyordu (ör. Toyzz GS Pre-Season: ömür 887/hf vs güncel
// 77/hf → kapsam 2,6 hf sanılıp "sevk et" denirken gerçekte 30 haftalık stok vardı).
// Bu yüzden hız/kapsam artık sku_weekly'den SON VEL_W hafta üzerinden hesaplanır.
const VEL_W = 8;
// İki ISO haftası arası kaç hafta (bayat kalemin "kaç haftadır yok" metni için).
const weeksSince = (from: string, to?: string): number =>
  !to
    ? 0
    : Math.max(
        0,
        Math.round((Date.parse(to) - Date.parse(from)) / (7 * 864e5)),
      );
// Çekilecek hafta penceresi: hız (8) + ABC değeri (8) + yeni-ürün kapısı (>=6 hafta)
// için 12 hafta yeter; tüm geçmişi çekmek 17K satır/18 sayfa ve ~7 sn demekti.
const WIN_W = 12;
// ABC×XYZ kapsam hedefi (hafta). MEIO: erratik/pull → biriktirme, hızlı ikmal. C kuyruk → ince.
const COVER: Record<string, Record<string, number>> = {
  A: { X: 8, Y: 10, Z: 6 },
  B: { X: 8, Y: 8, Z: 6 },
  C: { X: 4, Y: 4, Z: 2 },
  D: { X: 0, Y: 0, Z: 0 },
};
const MODE_MULT: Record<string, number> = {
  koruma: 1.3,
  denge: 1.0,
  agresif: 0.7,
};
// SENARYO DAMGASI. MODE_MULT doğrudan targetUnits'i çarptığı için bu uçtan çıkan
// HER karar sayısı bir senaryonun çıktısıdır: ölçtüm, aynı veriyle
//   denge   → çek 576 kalem / ₺33,7 mn · sevk-kritik 13 kalem / haftalık ₺167.820 net
//   koruma  → hedef %30 yukarı → çek 564 kalem, sevk-kritik adedi 20.078 → 27.628
//   agresif → hedef %30 aşağı, çek büyür
// Ana sayfa mode=denge sabitliyor; ekranda "575 kalem" okuyup /yonlendirme'de
// Korumacı'ya basan kişi başka bir sayı görüyor ve hangisinin geçerli olduğunu
// ayırt edecek işaret yoktu. Etiket bu yüzden yanıtın içinde taşınıyor (istemcide
// ikinci bir eşleme tablosu tutulmasın).
const MODE_LABEL: Record<string, string> = {
  koruma: "Korumacı senaryo",
  denge: "Dengeli senaryo",
  agresif: "Agresif senaryo",
};

// ── MODÜL-İÇİ MEMO (yalnız süreç belleği, 300 s) ──
// Bu uç soğukta 2,8-4,2 s sürüyor (5 sorgu; ~24 bin sku_weekly + 718
// product_coverage satırı, tamamı JS'te işleniyor). Ana sayfa her açılışta
// çağıracağı için aynı yanıt aynı süreçte tekrar hesaplanmasın: ölçüm, ikinci
// isteği 2,8 s'den ~0,01 s'ye indiriyor.
// TTL 300 s çünkü veri haftada bir yükleniyor — bu pencerede içeriğin değişmesi
// pratikte imkânsız; yükleme sonrası kontrol için `?fresh=1` bypass'ı var.
// ÖNBELLEK YALNIZ SÜREÇ-İÇİ: `revalidate = 0` ve rotanın dinamik davranışı aynen
// korunuyor (Next/HTTP katmanında hiçbir şey önbelleğe alınmıyor), yani başka bir
// lambda örneği ya da yeniden başlatma taze hesaplar. Anahtar MOD başına ayrı;
// `slim` anahtarın parçası DEĞİL, çünkü slim yanıt tam yanıttan türetiliyor
// (ikisi aynı önbelleği paylaşır).
const MEMO_TTL = 300_000;
const memo = new Map<string, { at: number; payload: any }>();

function season(name: string): "ESKİ" | "25/26" | "TREND" | "DİĞER" {
  const n = (name || "").toLowerCase();
  if (/25\s*[\/\-]?\s*26|2025\s*[\/\-]?\s*2?6/.test(n)) return "25/26";
  if (
    /22\s*[\/\-]\s*23|23\s*[\/\-]\s*24|24\s*[\/\-]\s*25|euro\s*2024|20(22|23|24)\b/.test(
      n,
    )
  )
    return "ESKİ";
  if (
    /manifest|labubu|sevimli canavar|kpop|holomen|holomonster|rafadan|nice to know|\btork\b|minions|animal/.test(
      n,
    )
  )
    return "TREND";
  return "DİĞER";
}
const num = (x: any) => (x == null ? 0 : Number(x) || 0);
const r1 = (n: number) => Math.round(n * 10) / 10;
const clean = (b: any) => {
  const d = String(b == null ? "" : b).replace(/\D/g, "");
  return d && !/^0+$/.test(d) && d.length >= 8 && d.length <= 14 ? d : null;
};

// ── VERİ SÜRÜMÜ (ucuz sorgu, GET ve build ortak kullanır) ──
// Bu blok build'in İÇİNDE değil DIŞINDA duruyor, çünkü önbellek anahtarı ona
// bağlı: eski anahtar yalnız `mode` idi, yani yeni bir hafta yüklendikten sonra
// 300 sn boyunca eski gecikmeler (ve "ASKIDA" satırları) servis ediliyordu.
// Anahtarı build'in içinden almak imkânsız (önbellek build'den ÖNCE aranıyor),
// bu yüzden en ucuz sorgu — 5 firma × ~40 hafta = ~121 satır — dışarı alındı.
//
// PARMAK İZİ: firma bazlı son haftalar + satır sayısı + Σ adet. Yalnız son
// haftalara bakmak yetmiyor: aynı haftanın DÜZELTİLMİŞ yeniden yüklemesi max
// haftayı değiştirmez ama sayıları değiştirir. Σ adet o düzeltmeyi de yakalar.
export interface VeriSurumu {
  window: string[];
  haftalarOf: Record<string, string[]>;
  lastWeekOf: Record<string, string>;
  takvimHaftasi: string;
  agHaftasi: string | null;
  asOf: string;
  dataVersion: string;
}
async function veriSurumu(asOfDate: Date): Promise<VeriSurumu> {
  const { data, error } = await supabase
    .from("weekly_summary")
    .select("retailer, week_start, sales_qty")
    .order("week_start", { ascending: false });
  if (error) throw error;
  const rows = data ?? [];
  const window = [
    ...new Set(rows.map((w: any) => w.week_start as string)),
  ].slice(0, WIN_W);
  const haftalarOf: Record<string, string[]> = {};
  for (const w of rows as any[]) {
    (haftalarOf[w.retailer] ||= []).push(w.week_start as string);
  }
  const lastWeekOf: Record<string, string> = {};
  for (const ret in haftalarOf) {
    haftalarOf[ret].sort();
    lastWeekOf[ret] = haftalarOf[ret][haftalarOf[ret].length - 1];
  }
  const toplamAdet = rows.reduce(
    (a: number, r: any) => a + (Number(r.sales_qty) || 0),
    0,
  );
  return {
    window,
    haftalarOf,
    lastWeekOf,
    takvimHaftasi: sonTamamlanmisHafta(asOfDate),
    agHaftasi: window[0] ?? null,
    asOf: new Date(asOfDate.getTime() + 3 * 3600000).toISOString().slice(0, 10),
    dataVersion:
      Object.entries(lastWeekOf)
        .sort()
        .map(([k, v]) => k + ":" + v)
        .join(",") +
      "|" +
      rows.length +
      "|" +
      toplamAdet,
  };
}

async function build(mode: string, veri: VeriSurumu) {
  const mult = MODE_MULT[mode] ?? 1.0;
  // Pencere: ağdaki en yeni WIN_W hafta. (Firmalar farklı haftalarda olduğu için
  // global hafta listesi alınır; her firma kendi son haftalarını bu kümede bulur.)
  const window = veri.window;
  const { takvimHaftasi, lastWeekOf, haftalarOf } = veri;
  // İKİ AYRI GECİKME — bilinçli:
  //   gecikmeOf      → erime hesabı. "Son rapordan bu yana kaç hafta satış oldu."
  //   kararGecikmeOf → kademe (rozet/askı). Boşluk-duyarlı çapa; histerezisi
  //                    kalıcı tablo olmadan sağlayan tek şey (bkz. compute.ts).
  // Bugün ikisi de aynı: Huppaluppo 0 · Toyzz/D&R/Armağan 1 · Nezih 4.
  const gecikmeOf = (ret: string) =>
    gecikmeHaftasi(lastWeekOf[ret], takvimHaftasi);
  const kararGecikmeOf = (ret: string) =>
    kararGecikmesi(haftalarOf[ret] ?? [], takvimHaftasi);
  const kademeCache = new Map<string, Kademe>();
  const kademeFor = (ret: string) => {
    let k = kademeCache.get(ret);
    if (!k) {
      k = kademeOf(kararGecikmeOf(ret));
      kademeCache.set(ret, k);
    }
    return k;
  };

  // SAYFALAMA: fetchAllRows KARARLI sıra ister (supabase.ts:44). Eşitlik içeren tek
  // kolonla sıralamak sayfaları çakıştırıp satır çiftler/kaybettirir — ölçülen: 60
  // satır iki kez, 60 satır hiç (satır sayısı aynı kaldığı için görünmüyordu).
  // Bu yüzden her sorgu kendi BENZERSİZ anahtarının tamamıyla sıralanır:
  //   sku_weekly       → (retailer, week_start, sku_name)  [matview grup anahtarı]
  //   product_coverage → (retailer, product_key)           [idx_pcov_key]
  //   product_alias    → (retailer, sku_name)
  const [pc, sw, al] = await Promise.all([
    fetchAllRows<any>((f, t) =>
      supabase
        .from("product_coverage")
        .select(
          "retailer, product_key, barkod, sku_name, weeks, avg_weekly, last_stock, coverage_weeks, psf",
        )
        .order("retailer")
        .order("product_key")
        .range(f, t),
    ),
    fetchAllRows<any>((f, t) =>
      supabase
        .from("sku_weekly")
        .select(
          "retailer, week_start, sku_name, barkod, sales_qty, sales_value, stock_qty",
        )
        .in("week_start", window)
        .order("retailer")
        .order("week_start")
        .order("sku_name")
        .range(f, t),
    ),
    fetchAllRows<any>((f, t) =>
      supabase
        .from("product_alias")
        .select("retailer, sku_name, barkod")
        .eq("status", "approved")
        .order("retailer")
        .order("sku_name")
        .range(f, t),
    ),
  ]);
  const aliasMap = new Map(
    al.map((a) => [a.retailer + "|" + a.sku_name, a.barkod]),
  );
  const pkOf = (retailer: string, sku_name: string, barkod: any) => {
    const b = clean(barkod) || aliasMap.get(retailer + "|" + sku_name);
    return b || "NAME:" + sku_name;
  };

  // ── D&R DEPO (kanal_depo; supabase/kanal-depo.sql) ──
  // YALNIZ D&R'ın SON RAPOR HAFTASININ deposu kullanılır. 22 Ekim'de eski bir
  // depo kopyası güncel sanılınca sipariş kontrolü ters çıkmıştı: depo haftası
  // mağaza haftasıyla aynı değilse depo YOK sayılır (bilinmiyor). Tablo yoksa
  // (SQL çalıştırılmamış) sorgu hata döner ve depo yine yok sayılır.
  const depoOf = new Map<string, { offline: number; web: number }>();
  let depoHaftasi: string | null = null;
  if (lastWeekOf["DR"]) {
    const { data: dRows, error: dErr } = await supabase
      .from("kanal_depo")
      .select("sku_name, barkod, offline_depo, web_depo")
      .eq("retailer", "DR")
      .eq("week_start", lastWeekOf["DR"]);
    if (!dErr && dRows && dRows.length) {
      depoHaftasi = lastWeekOf["DR"];
      for (const d of dRows as any[]) {
        const k = pkOf("DR", d.sku_name, d.barkod);
        const e = depoOf.get(k) ?? { offline: 0, web: 0 };
        e.offline += num(d.offline_depo);
        e.web += num(d.web_depo);
        depoOf.set(k, e);
      }
    }
  }

  // ── D&R FATURA FİYATI (fatura_fiyat; supabase/fatura-fiyat.sql) ──
  // Motorun TL'si (etki, çek değeri, BU HAFTA sırası) D&R'da kanalda duran malın
  // FATURA DEĞERİNDEN gelir: eldeki stok en yeni partiler sayılır (FIFO), birim
  // fiyat o partilerin adet ağırlıklı neti (lib/fatura-fiyat.ts). Rafı boşalmış
  // üründe bu son faturanın fiyatıdır — sevk edilecek yeni mal da o fiyattan.
  // Matview psf'i tüm geçmişin medyanı; fiyat yıl içinde değiştiği için (Turkuvaz
  // faturalarında 31/107 barkod, ör. metal kutu 352,89 → 441,23) eskide kalıyordu.
  // Tablo yoksa ya da barkodun faturası yoksa matview psf'i aynen kullanılır.
  const faturaDR = await faturaIndeksiYukle(supabase, "DR");
  const faturaPsfOf = (
    retailer: string,
    pk: string,
    eldeki: number,
  ): number | null => {
    if (retailer !== "DR" || !faturaDR || pk.startsWith("NAME:")) return null;
    const f = faturaNeti(faturaDR, pk, "9999-12-31", 0, eldeki);
    return f ? netFaturadanPsf(f.net, retailer) : null;
  };

  // kanal haftaları
  const chW = new Map<string, Set<string>>();
  for (const r of sw) {
    let s = chW.get(r.retailer);
    if (!s) {
      s = new Set();
      chW.set(r.retailer, s);
    }
    s.add(r.week_start);
  }
  const weeksOf: Record<string, string[]> = {};
  for (const [c, s] of chW) weeksOf[c] = [...s].sort();
  // Her firmanın GÜNCEL haftası (bayat kapısı ve "kaç haftadır yok" metni için).
  // series döngüsünden ÖNCE kurulur: isim indeksi o döngüde dolduruluyor.
  const curW: Record<string, string> = {};
  for (const c in weeksOf) {
    const ws = weeksOf[c];
    if (ws.length) curW[c] = ws[ws.length - 1];
  }

  // seriler: (retailer|pk) → haftalık adet; + ağ değeri/adedi (ABC için)
  // first: ürünün pencerede ilk GÖRÜLDÜĞÜ hafta. raf: ilk RAFTA olduğu hafta
  // (stok > 0 ya da satış ≠ 0). İkisi ayrı, çünkü firmalar ürünü rafa gelmeden
  // haftalarca 0 stok / 0 satışla listeler (ölçülen: Toyzz Pre-Season 26/27 ve
  // Manifest 7'li 08-10'dan beri 0/0, stok 09-14'te geldi). Hız ve oynaklık
  // "rafta geçen" haftalar üzerinden hesaplanır.
  // stokByW: hafta sonu stoğu — düşen talep kapısı satış düşüşünün raf
  // boşalmasından mı yoksa talepten mi geldiğini buna bakarak ayırır.
  const series = new Map<
    string,
    {
      byW: Map<string, number>;
      stokByW: Map<string, number>;
      first: string;
      raf: string | null;
    }
  >();
  // GÜNCEL HAFTADA GÖRÜLEN İSİMLER: `${retailer}|${sku_name}`. Bayat kontrolünün
  // İKİNCİ kanıtı (bkz. isStaleK).
  const curNames = new Set<string>();
  const netVal = new Map<string, number>(); // pk → son-8hf ağ satış DEĞERİ (₺)
  const netQty = new Map<string, number>(); // pk → son-8hf ağ satış ADEDİ (yedek ölçüt)
  for (const r of sw) {
    const pk = pkOf(r.retailer, r.sku_name, r.barkod),
      k = r.retailer + "|" + pk;
    let e = series.get(k);
    if (!e) {
      e = {
        byW: new Map(),
        stokByW: new Map(),
        first: r.week_start,
        raf: null,
      };
      series.set(k, e);
    }
    e.byW.set(r.week_start, (e.byW.get(r.week_start) || 0) + num(r.sales_qty));
    e.stokByW.set(
      r.week_start,
      (e.stokByW.get(r.week_start) || 0) + num(r.stock_qty),
    );
    if (r.week_start < e.first) e.first = r.week_start;
    if (
      (num(r.stock_qty) > 0 || num(r.sales_qty) !== 0) &&
      (e.raf == null || r.week_start < e.raf)
    )
      e.raf = r.week_start;
    if (curW[r.retailer] === r.week_start)
      curNames.add(r.retailer + "|" + r.sku_name);
    const last8 = (weeksOf[r.retailer] || []).slice(-VEL_W);
    if (last8.includes(r.week_start)) {
      netVal.set(pk, (netVal.get(pk) || 0) + num(r.sales_value));
      netQty.set(pk, (netQty.get(pk) || 0) + num(r.sales_qty));
    }
  }

  // GÜNCEL HIZ: kanalın son VEL_W haftasındaki adet ÷ ürünün o pencerede
  // SATIŞA AÇIK OLDUĞU hafta sayısı.
  //
  // BÖLEN NEDEN PENCERE BOYU DEĞİL: bölen sabit 8 alındığında, henüz 8 haftası
  // olmayan yeni ürünün hızı yapay olarak düşüyordu. Ölçülen: "DR Mythos
  // GSChampionsEdition25/26Amblj" yalnız 3 haftadır listede (07-20/07-27/08-03)
  // ve 503 adet satmış → gerçek hız ~168/hf, ama 503/8 = 62,9/hf hesaplanıyordu
  // (2,7× düşük). Sonuç zincirleme: kapsam 3,8 hf yerine 10 hf sanılıyor, sevk
  // önerisi 266 adet çıkıyor — gerçek ihtiyaç ~1.100 adet. Yani hızlı satan yeni
  // ürün tam da patladığı anda az sevk ediliyordu.
  //
  // Ölmüş ürünü de doğru cezalandırır: ürün pencerenin başında görülüp sonra
  // satmayı bırakmışsa `first` erken olduğu için bölen büyük kalır ve hız düşer.
  // (Bu yüzden bölen "satış olan hafta sayısı" DEĞİL — öyle olsa satmayı
  // bırakmış ürünün hızı yapay olarak yüksek kalırdı.)
  function velOf(k: string, retailer: string): number {
    const e = series.get(k);
    if (!e) return 0;
    const last = (weeksOf[retailer] || []).slice(-VEL_W);
    if (!last.length) return 0;
    let s = 0;
    for (const w of last) s += e.byW.get(w) || 0;
    // Ürün pencereye ilk göründüğü haftadan itibaren kaç hafta rafta?
    // BÖLEN EN AZ 2: tek haftalık veri büyük bir sipariş için fazla incedir —
    // ilk hafta satışı raf yerleşimi/lansman etkisi taşır ve gerçek talebi
    // olduğundan yüksek gösterebilir. Ölçülen tek örnek: "DR Mythos Manifest
    // Toz Pembe" ilk haftasında 197 adet satmış, 637 stok var; bölen 1 olsa
    // motor 939 adet sevk isteyecekti, bölen 2 ile 151 adet istiyor ve ikinci
    // hafta gerçek hızı gösterdiğinde kendini düzeltiyor. 2+ haftalık ürünlerde
    // bu taban hiçbir şeyi değiştirmez.
    //
    // RAF ÖNCESİ HAFTALAR SAYILMAZ (2026-09-28). Bölen `first`ten sayılınca
    // rafa gelmeden 0/0 listelenen haftalar da "satışa açık" sayılıyordu.
    // Ölçülen: Toyzz MANİFEST HİLELİ 7Lİ 08-10..09-07 0/0, 09-14 stok 3.597,
    // 09-21 satış 102 → hız 102/7 = 14,6, kapsam 240 hf ve ağın en büyük transferi
    // (2,73 M TL). Rafta geçen 2 hafta ile hız 51, kapsam ~68 hf.
    const bas = e.raf ?? e.first;
    const openWeeks = last.filter((w) => w >= bas).length;
    return s / Math.max(2, openWeeks);
  }

  // ── DÜŞEN TALEP KAPISI (2026-10-16, yalnız SEVK adedini besler) ──
  // velOf son 8 haftanın ORTALAMASIDIR; sönen üründe güncel talebin katlarını
  // gösterir ve motor rafı dolu ürüne sevk ister. Ölçülen (2026-10-16, denge):
  // 20 SEVK önerisinin 10'u böyleydi — 7.017 adet, ~623 bin TL net mal; hepsi
  // 26/27 çıkınca sönen 25/26 ürünler. En büyüğü Toyzz GS Sezon Kartları 25/26
  // 12'li: 8 hf ort. 244/hf, son 3 hf 73/hf; motor 625 adeti "2,6 hf" sanıp
  // 1.818 adet sevk istiyordu, güncel hızla stok ~9 hf. Konsinyede fazla sevk
  // bizim bağlı sermayemizdir. Kapı başka hiçbir aksiyonu değiştirmedi.
  //
  // Kapı dar tutuldu (kural ve testleri: compute.ts dusenTalepHizi): son 3
  // rafta-hafta 8 hf ortalamasının %70'inin altında VE her biri satışından
  // fazla stokla kapanmış olmalı (düşüş raf boşalmasından gelmesin). Haftası
  // eksik (Nezih stoksuz ürünü raporlamaz) ya da 5'ten az rafta-haftası olan
  // ürün kapıdan geçmez; eski davranış sürer. Yayınlanan `velocity`/`coverage`
  // DEĞİŞMEZ (/api/stock paritesi); güncel hız ayrı alanda (`trendHiz`) durur.
  function trendHizi(k: string, retailer: string, v8: number): number | null {
    const e = series.get(k);
    if (!e) return null;
    const bas = e.raf ?? e.first;
    const acik = (weeksOf[retailer] || [])
      .slice(-VEL_W)
      .filter((w) => w >= bas)
      .map((w) => ({
        satis: e.byW.get(w) ?? null,
        stok: e.stokByW.get(w) ?? null,
      }));
    return dusenTalepHizi(acik, v8);
  }

  // ── İNCE RAF PENCERESİ (compute.ts RAF VARLIĞI) ──
  // Son 4 rafta-haftanın HAFTA BAŞI stoğu (önceki raporlanan haftanın kapanışı),
  // taşıyan mağaza başına. Satış o haftanın başındaki rafla yapılır; kapanış
  // stoğu kullanılsaydı iyi satan hafta ince raf gibi görünürdü. Raf öncesi
  // haftalar (lansman öncesi 0 stok) sayılmaz, yoksa her yeni ürün "ince raf" olurdu.
  //
  // TABAN TAM DAĞITIM (MAGAZA_TASIYABILEN), ürünün bugünkü mağaza sayısı DEĞİL.
  // Bugünkü satıştan türetilen mağaza sayısıyla ölçülünce döngü kapanıyordu: ince
  // raf satışı düşürür → düşük satış az mağaza demek → az mağazaya göre raf ince
  // görünmez (ölçülen: D&R Toz Pembe 202 stok, lansmanda 197-210/hf satarken
  // 18/hf → 53 mağaza → "ince değil"). Geri test de bu tabanla yapıldı (11 vaka).
  // DÜZELTME YALNIZ GENİŞ DAĞITIM GÖRMÜŞ ÜRÜNDE: pencerede en az bir hafta mağaza
  // başı ≥3 adetle (tam dağıtım tabanında) rafta olmuş olmalı. Doğası gereği niş
  // ürün (tin, 1000 parçalık puzzle) hiç geniş dağıtılmadığı için şişirilmez.
  //
  // SİVRİ HAFTA DIŞARIDA, ORTALAMA DEĞİL MEDYAN. D&R'ın "ASEPTO Wnn" formatlı
  // haftasında stok depo dahil geliyor (2026-09-21: Toz Pembe 3.167, komşu
  // haftalar ~210). Ortalamaya giren tek sivri hafta, ince rafı dolu gösterip
  // düzeltmeyi kapatıyordu; aynı hafta niş ürüne sahte "geniş dağıtım" kanıtı da
  // olabilirdi. Komşularının 2,5 katını aşan stok kanıt sayılmaz.
  function sivriMi(
    e: { stokByW: Map<string, number> },
    W: string[],
    i: number,
  ): boolean {
    const s = e.stokByW.get(W[i]);
    if (s == null || s <= 0) return false;
    const a = i > 0 ? e.stokByW.get(W[i - 1]) : undefined;
    const b = i < W.length - 1 ? e.stokByW.get(W[i + 1]) : undefined;
    const komsu = Math.max(a ?? 0, b ?? 0);
    return komsu > 0 && s > 2.5 * komsu;
  }
  function rafOrtalamasi(
    k: string,
    retailer: string,
    n: number,
  ): number | null {
    const e = series.get(k);
    if (!e) return null;
    const W = weeksOf[retailer] || [];
    const bas = e.raf ?? e.first;
    let genis = false;
    for (let i = 1; i < W.length; i++) {
      if (W[i - 1] < bas || sivriMi(e, W, i - 1)) continue;
      if ((e.stokByW.get(W[i - 1]) ?? 0) / n >= 3) {
        genis = true;
        break;
      }
    }
    if (!genis) return null;
    const xs: number[] = [];
    for (let i = W.length - 1; i >= 1 && xs.length < 4; i--) {
      if (W[i - 1] < bas) break;
      const onceki = e.stokByW.get(W[i - 1]);
      if (onceki == null || sivriMi(e, W, i - 1)) continue;
      xs.push(onceki / n);
    }
    if (!xs.length) return null;
    xs.sort((a, b) => a - b);
    const m = Math.floor(xs.length / 2);
    return xs.length % 2 ? xs[m] : (xs[m - 1] + xs[m]) / 2;
  }

  // ── BAYAT (stale) STOK ──
  // Ürün, firmanın GÜNCEL haftalık raporunda yoksa eldeki stok TEYİDE MUHTAÇTIR:
  // çıkışı yapılıp listeden düşmüş de olabilir. /api/stock bu kalemleri manşet
  // toplamlarından çıkarıyor, ama routing hiç ayırt etmiyordu ve iki yanlış
  // üretiyordu (ölçüldü): (1) 4 kalem / 7.868 adet / ₺911.614 brüt için DEPO
  // kararı — "serbest kalacak sermaye" manşetinin %2,33'ü teyit edilmemiş stok;
  // (2) 5-6 aydır görünmeyen 4 kaleme "Yeni ürün (1 hf veri) — bekle" etiketi.
  // Teyit edilmemiş stok üzerinde HİÇBİR karar üretilmemeli: ne çek, ne likide et,
  // ne "yeni ürün" say. Bu yüzden kapı, stok kontrolünden hemen sonra geliyor.
  //
  // KONTROL İKİ ANAHTARLA YAPILIR (anahtar VE isim). Eskiden yalnız ürün
  // anahtarına bakılıyordu ve bu YANLIŞ POZİTİF üretiyordu: sku_weekly
  // (retailer, week_start, sku_name) ile gruplu ve barkodu (array_agg(barkod))[1]
  // ile TEK keyfi değere indiriyor; aynı isim altında iki barkod taşıyan ürün
  // haftaya göre farklı anahtarla görünüyor. compute.ts:816-822 bu farkı ölçmüş
  // (yalnız anahtar 14 satır/8.259 adet ↔ isimle birlikte 10 satır/7.925 adet;
  // fark 334 adet TAMAMI yanlış pozitif) ve /api/stock o günden beri iki anahtarla
  // bakıyor; bu uç ise bakmıyordu.
  // BU UÇTA ÖLÇÜLEN: tek yanlış pozitif → DR "Topps-UEFA Şamp.Ligi 22/23
  // Multipaket". Ürünün iki barkodu var (5053307057876 ve 9771723866051);
  // 2026-08-17 haftası ilkiyle raporda, ama ikinci anahtarlı product_coverage
  // satırı (3 adet) bayat sanılıyordu. İsim kontrolüyle TEYİT 9 → 8 kaleme,
  // 7.928 → 7.925 adede iniyor ve /api/stock'un bayat kümesiyle BİREBİR tutuyor
  // (8 kalem / 7.925 adet / ₺923.906). Canlı stoğu manşetten düşürmek, bayatı
  // kaçırmaktan daha kötü olduğu için muhafazakâr taraf budur.
  function isStaleK(k: string, sku_name: string, retailer: string): boolean {
    const cw = curW[retailer];
    if (!cw) return false;
    if (curNames.has(retailer + "|" + sku_name)) return false; // isim güncel haftada var
    const e = series.get(k);
    if (!e) return true; // 12 haftalık pencerede hiç görünmüyor
    return !e.byW.has(cw); // pencerede var ama güncel haftada yok
  }
  // Pencere içindeki son görülme (yoksa null → aşağıda hedefli sorguyla tamamlanır)
  function lastSeenInWindow(k: string): string | null {
    const e = series.get(k);
    if (!e || !e.byW.size) return null;
    let mx: string | null = null;
    for (const w of e.byW.keys()) if (!mx || w > mx) mx = w;
    return mx;
  }

  // Pareto sınıflandırıcı: kümülatif %80 → A, %95 → B, gerisi C.
  const pareto = (m: Map<string, number>) => {
    const ranked = [...m.entries()]
      .filter(([, v]) => v > 0)
      .sort((a, b) => b[1] - a[1]);
    const tot = ranked.reduce((s, [, v]) => s + v, 0);
    const out = new Map<string, string>();
    let cum = 0;
    if (tot <= 0) return out;
    for (const [pk, v] of ranked) {
      cum += v;
      const p = cum / tot;
      out.set(pk, p <= 0.8 ? "A" : p <= 0.95 ? "B" : "C");
    }
    return out;
  };
  // ABC ana ölçüt DEĞER'dir. Ama ciro verisi olmayan ürünlerde (sales_value NULL/0 —
  // D&R ve Nezih'te yaygın) değer sıfır görünüyor ve ürün "D" sınıfına düşüp
  // hedef kapsamı 0 oluyordu → motor pekâlâ satan üründe "tüm stoğu çek" diyordu
  // (ölçülen: 24 satır / 6.599 adet ters karar; ör. DR Manifest Toz Pembe 3,2 haftalık
  // stokla DEPO'ya gönderiliyordu). Bu yüzden değer yoksa ADET Pareto'suna düşülür;
  // yalnız gerçekten hiç satmayan ürün D kalır.
  const abcVal = pareto(netVal);
  const abcQty = pareto(netQty);
  // XYZ (kanal×pk, CV); + weeksPresent + intermittency
  function stats(k: string, retailer: string) {
    const e = series.get(k);
    const W = weeksOf[retailer] || [];
    if (!e) return { cv: Infinity, wkP: 0, xyz: "Z" };
    // Oynaklık da rafa gelişten itibaren: öncesindeki 0'lar CV'yi şişirip ürünü Z'ye itiyordu.
    const span = W.filter((w) => w >= (e.raf ?? e.first));
    const vals = span.map((w) => e.byW.get(w) || 0);
    const n = vals.length,
      mean = vals.reduce((a, b) => a + b, 0) / Math.max(1, n);
    const sd =
      n > 1
        ? Math.sqrt(vals.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1))
        : 0;
    const cv = mean > 0 ? sd / mean : Infinity;
    const xyz = !isFinite(cv) || cv > 1 ? "Z" : cv < 0.5 ? "X" : "Y";
    return { cv, wkP: n, xyz };
  }

  // ── KAPANMIŞ ÜRÜNLER (src/lib/kapali-urunler.ts) ──
  // Satıştan çekilip tasfiye edilmiş 8 kalem (7.925 adet / ₺923.906 raf değeri).
  // Bu küme bugünkü TEYİT kovasının BİREBİR aynısıydı: sorunun cevabı zaten
  // verilmişti, motor dosyayı okumadığı için aynı soruyu her hafta yeniden
  // üretiyordu. Süzgeç burada, KARAR DÖNGÜSÜNDEN ÖNCE: satır `recs`e hiç
  // girmediği için ne TEYİT ne ÇEK ne de transfer hedefi olabiliyor.
  //
  // GERİ DÖNÜŞ KAPISI: kalem firmanın GÜNCEL haftasında yeniden görünürse kapalı
  // kaydı yok sayılır. Aksi halde tek satırlık bir insan kararı ürünü sonsuza
  // kadar görünmez kılardı — ve o hata sessiz olurdu (ne satış ne stok).
  const kapaliGeriDonen: string[] = [];
  const pcAktif = pc.filter((r: any) => {
    if (!kapaliMi(r.retailer, r.sku_name, r.barkod)) return true;
    if (curNames.has(r.retailer + "|" + r.sku_name)) {
      kapaliGeriDonen.push(r.retailer + " · " + r.sku_name);
      return true;
    }
    return false;
  });
  const kapaliAtlanan = pc.length - pcAktif.length;

  // ── Karar ──
  const byKey = new Map<string, any[]>();
  for (const r of pcAktif) {
    const a = byKey.get(r.product_key) || [];
    a.push(r);
    byKey.set(r.product_key, a);
  }
  type R = {
    r: any;
    stock: number;
    v: number;
    cov: number | null;
    psf: number;
    // psf bu kanala kesilen son faturadan (D&R) — öz-denetimin fiyat şüphesine girmez.
    fiyatFatura: boolean;
    sea: string;
    abc: string;
    xyz: string;
    wkP: number;
    intent: string;
    pull: number;
    ship: number;
    cap: number;
    target: number;
    noPrice: boolean;
    // Kanıt kapısı çıktısı (yalnız eski sezon satırlarında dolu)
    kapi: LikidKapi | null;
    geriBirakilan: number;
    // Veri yaşı
    gecikmeHf: number;
    drenaj: number;
    stokYaslandirilmis: number;
    // Düşen talep kapısı ateşlendiyse güncel (son 3 hf) hız; aksi null
    vTrend: number | null;
    // RAF VARLIĞI: d = ince raf düzeltmeli talep, magaza = taşıması gereken mağaza
    // (mağaza verisi olmayan kanalda null), P = asgari raf (adet), T = hedef stok.
    d: number;
    magaza: number | null;
    P: number;
    T: number;
    // İyimser talep (SANSUR_TAVAN_UST); yalnız sipariş kontrolünün ret eşiği için.
    dUst: number;
    // Eski sezon ama diğer kanallar satıyor (tasfiye yerine çek-ver): diğer kanalların talebi.
    agTalep?: number;
  };
  const recs: R[] = [];
  for (const r of pcAktif) {
    const pk = r.product_key,
      k = r.retailer + "|" + pk;
    // stok matview'den (anlık değer), HIZ ve KAPSAM güncel pencereden hesaplanır
    const stock = num(r.last_stock);
    // Eldeki mal = mağaza + (biliniyorsa, son haftanın) D&R deposu.
    const dp = r.retailer === "DR" ? depoOf.get(pk) : undefined;
    const fPsf = faturaPsfOf(
      r.retailer,
      pk,
      stock + (dp ? dp.offline + dp.web : 0),
    );
    const psf = fPsf ?? num(r.psf);
    const lifeW = num(r.weeks); // ürünün ömür boyu hafta sayısı (yeni-ürün kapısı)
    const v = velOf(k, r.retailer);
    const cov = v > 0 ? stock / v : null;
    // YAYINLANAN DEĞERLER. Kapılar bunlarla kıyaslanır, ham oranla DEĞİL — bu
    // kod tabanının yazılı kuralı ("ölçüt görünen sayıdır", bkz. sevkKritik notu).
    // Aksi halde ekranda "1,0/hf · 26 hf" yazan satır arkada 0,96 ile "hiç
    // satmıyor → tüm rafı likide et" muamelesi görürdü.
    const vPub = r1(v);
    const covPub = cov == null ? null : Math.round(cov);
    const sea = season(r.sku_name);
    const st = stats(k, r.retailer);
    const abc = abcVal.get(pk) ?? abcQty.get(pk) ?? "D"; // değer yoksa adet; hiç satış yoksa D
    const target0 = sea === "ESKİ" ? 0 : ((COVER[abc] || COVER.C)[st.xyz] ?? 6);
    let target = Math.round(target0 * mult);
    let targetUnits = Math.ceil(target * v);
    let intent = "tut",
      pull = 0,
      ship = 0;
    let kapi: LikidKapi | null = null,
      geriBirakilan = 0;
    // GÜNCEL HIZ HER SATIR İÇİN. Eskiden düşen talep kapısı yalnız sevk dalında
    // soruluyordu; çek kararı da artık talebe bağlı olduğu için hepsinde gerekli.
    // Yayınlanan velocity/coverage değişmez (/api/stock paritesi).
    const vTrend: number | null = v > 0 ? trendHizi(k, r.retailer, v) : null;
    const vS = vTrend ?? v;
    // ── RAF VARLIĞI (compute.ts) ──
    // Talep, ince raf haftalarında ölçülen eğriyle geri açılır (tavan ×2); kaç
    // mağazanın taşıması gerektiği talepten türetilir; asgari raf = mağaza × senaryo.
    const n0 = tasiyanMagaza(r.retailer, vS);
    const rafX = n0
      ? rafOrtalamasi(k, r.retailer, MAGAZA_TASIYABILEN[r.retailer])
      : null;
    const d = sansurDuzeltilmisTalep(vS, rafX);
    const dUst = sansurDuzeltilmisTalep(vS, rafX, SANSUR_TAVAN_UST);
    const magaza = n0 ? tasiyanMagaza(r.retailer, d) : null;
    // Asgari raf en fazla RAF_TAVAN_HF haftalık talep (yavaş üründe "10 mağaza × 4"
    // talebin onlarca haftası ediyordu; compute.ts RAF_TAVAN_HF).
    const P = magaza
      ? Math.min((RAF_ASGARI[mode] ?? 4) * magaza, Math.ceil(d * RAF_TAVAN_HF))
      : 0;
    // HEDEF STOK = max(asgari raf, segment kapsamı × talep). Mağaza verisi olmayan
    // kanalda P = 0 ve d = güncel hız → eski kural birebir (ceil(target × vS)).
    let T = Math.max(P, Math.ceil(target * d));
    // ÇEKME SINIRI. Eskiden hedefin üstündeki her adet çekiliyordu: 26 haftalık
    // stoğu olan satan ürün de, mağaza başı 1 adeti kalan ürün de. Konsinyede malı
    // depoya çekmek nakit yaratmaz, ince rafı daha da inceltir. Artık yalnız
    // TUT_UFKU (senaryoyla çarpılır) haftanın ÜSTÜ çekilir; aradaki stok satarak erir.
    const K = Math.max(T, Math.ceil(TUT_UFKU * mult * d));
    if (stock <= 0) intent = v >= DEAD ? "sevk" : "skip";
    // Teyit edilmemiş stok → karar YOK (bkz. BAYAT STOK açıklaması). Sıra bilinçli:
    // "eski sezon" ve "ölü" kapılarından ÖNCE, çünkü var olmayan stok likide de
    // edilemez, depoya da çekilemez.
    else if (isStaleK(k, r.sku_name, r.retailer)) {
      intent = "bayat";
      pull = 0;
    }
    // ── KANIT KAPISI ──
    // Eskiden bu satır tek başına şuydu: `intent = "obsolet"; pull = stock;`
    // Yani likidasyon YALNIZ SKU adındaki sezon regex'inden doğuyor, hız ve
    // kapsam hiç sorulmuyor, rafın TAMAMI tam PSF ile indirime yazılıyordu.
    // Ölçüldü (2026-09-07): 239 likidasyon kaleminin 61'i hâlâ satıyor —
    // 20.580 adet / ₺2.721.695 brüt, üzerinde haftalık ₺28.655 net akış.
    // Kapının veri yaşıyla İLGİSİ YOK: en taze firma (Huppaluppo, gecikme 0) da
    // yanlış likidasyon üretiyordu, yani yaş kapısı bu paranın %99'unu göremez.
    else if (sea === "ESKİ") {
      const kap = likidasyonKapisi(stock, vPub, covPub);
      kapi = kap.kapi;
      if (kap.kapi === "erit") {
        geriBirakilan = kap.geriBirakilan;
        // ERİT + kapsam ≤ 2 hf → SEVK. Bu dal olmadan kapı yeni bir sessiz
        // hata üretiyordu: eski sezon satırında hedef 0 olduğu için `cov <
        // target*0.7` kapısı HİÇ ateşlenemez; "satarak erit" denen kalem raf
        // boşalınca sessizce ölürdü. Ölçülen üç kalemden en uç örnek:
        // Huppaluppo "Topps Match Attax 24/25 - Paket" 53 adet/hf, elde 98 adet
        // (2 hf) — motor bu kaleme hem "likide et" hem "sevk yok" diyordu.
        // Hedef bilinçli olarak kısa (4 hf): eski sezonda talebin sönme riski
        // gerçek, 8-10 haftalık normal hedef bu malda fazla iddialı olurdu.
        if (covPub != null && covPub <= 2) {
          intent = "sevk";
          target = Math.max(1, Math.round(ERIT_SEVK_HEDEF * mult));
          targetUnits = Math.ceil(target * v);
          ship = Math.max(0, targetUnits - stock);
        } else {
          intent = "erit";
          pull = 0;
        }
      } else {
        intent = "obsolet";
        pull = kap.pull; // "tam" → stok; "kismi" → stok − hız×26
        geriBirakilan = kap.geriBirakilan;
      }
    } else if (v < DEAD) {
      // ölü görünüyor
      // "Yeni ürün mü?" kararı ÖMÜR BOYU hafta sayısıyla verilir (product_coverage.weeks),
      // pencere içindeki hafta sayısıyla DEĞİL: 12 haftalık pencere kullanıldığından,
      // aylar önce raporlardan düşmüş eski bir ürün de pencerede 0 hafta görünür ve
      // yanlışlıkla "yeni ürün → dokunma" sayılırdı (ör. Toyzz Sevimli Canavar,
      // son görülme 9 Şubat, 7.037 adet). Ömür geçmişi kısa olan gerçekten yenidir.
      if (lifeW < NEW_WEEKS)
        intent = "izle"; // gerçekten yeni → dokunma
      else {
        intent = "olu";
        pull = stock;
      } // yeterli geçmiş + satmıyor → ölü, çek
    } else if (stock > K) {
      intent = "fazla";
      pull = stock - K;
    } // satıyor + ufkun da üstünde stok → fazlası çekilir
    // Hedefin üstünde ama ufuk içinde: çekme yok, yeni sevk yok — satarak erisin.
    // ERİT eylemi eski sezonda da aynı anlamı taşıyor (mal rafta kalır).
    else if (stock > T) {
      intent = "erit";
      pull = 0;
    }
    // İKMAL EŞİĞİ. Eskiden 0.4 idi: "fazla" kapısı kapsam > hedef, sevk kapısı ise
    // kapsam < hedef×0.4 olduğu için arada %40-100 genişliğinde KARARSIZ BİR BANT
    // kalıyordu — hedefin yarısı kadar stoğu olan hızlı ürün için motor hiç karar
    // üretmiyordu (ölçülen: 31 satır, hedefe 9.955 adet eksik; ör. DR GS Champions
    // Edition 3,8 hf / hedef 8 hf iken sessiz). 0.7 ile bant %30'a iner; çok küçük
    // sapmalarda gereksiz sevk üretmemek için bir tampon bilinçli olarak korunur.
    // Hedefin %70'inin altı → sevk (hedef = asgari raf ya da kapsam, hangisi büyükse).
    // DÜŞEN TALEP KAPISI (bkz. dusenTalepHizi): T güncel hızla kuruldu; 8 hf
    // ortalamasıyla sevk gerekirken güncel hızla gerekmiyorsa İZLE ("dusus").
    // TETİK: mağaza verisi olan kanalda asgari rafın kendisi (eğrinin en dik yeri
    // 2,8-3,6 adet bandı; %70 tamponu orada satışın ~%40'ını kaçırıyordu), kapsamda
    // eski %70 tamponu. Asgari raf tetiğinde en az 1 haftalık talep / 6 adet:
    // eşiğin hemen altındaki ürüne 3 adetlik sevk yazılmasın.
    else if (
      stock < Math.max(P, Math.ceil(target * d) * 0.7) &&
      (stock < Math.ceil(target * d) * 0.7 ||
        T - stock >= Math.max(Math.ceil(d), 6))
    ) {
      intent = "sevk";
      ship = Math.max(0, T - stock);
    } else if (
      vTrend != null &&
      stock < Math.max(P, Math.ceil(target * v)) * 0.7
    )
      intent = "dusus";
    // TRANSFER KAPASİTESİ = hedefe kadar eksik. Eskiden hedefin 26 haftalık
    // emişine kadar dolduruluyordu; kaynak artık 26 haftasını tuttuğu için
    // hedefe 26 hafta yüklemek, malı bir fazlalıktan ötekine taşımak olurdu.
    const cap =
      v >= DEAD && sea !== "ESKİ" && stock < T ? Math.max(0, T - stock) : 0;
    if (stock <= 0 && v >= DEAD) {
      // ESKİ SEZON TÜKENMİŞSE ASGARİ RAF YOK: tasfiye yolundaki malın rafını
      // mağaza başı 4 adete tamamlamak sermaye bağlar; kısa hedef (ERIT_SEVK_HEDEF)
      // yeter. Güncel üründe asgari raf ile 4 haftalık talebin büyüğü.
      T =
        sea === "ESKİ"
          ? Math.ceil(Math.max(1, Math.round(ERIT_SEVK_HEDEF * mult)) * d)
          : Math.max(T, Math.ceil(d * 4));
      ship = T;
    }
    // wkP: İZLE gerekçesinde gösterilen "kaç haftalık veri" → ömür boyu hafta sayısı
    // (kapıyla aynı ölçüt olsun; pencere içi sayı yanıltıcıydı)
    // ERİME: rapor tarihinden bugüne muhtemelen satılmış adet. Kapılar (fazla /
    // sevk / bayat) YUKARIDA raporlanan stokla çalıştı ve öyle kalıyor — burada
    // hesaplanan değer yalnız (a) ÇEK adedini kırpar, (b) ekranda ikincil sayı
    // olarak basılır. Sebep parite: `/api/stock` ile aynı satırın stok, hız,
    // kapsam ve durum etiketi birebir aynı kalmalı (583/584 satır bugün eşit).
    const gecikmeHf = gecikmeOf(r.retailer);
    const yas = yaslandir(stock, vPub, gecikmeHf);
    recs.push({
      r,
      stock,
      v,
      cov,
      psf,
      fiyatFatura: fPsf != null,
      sea,
      abc,
      xyz: st.xyz,
      wkP: lifeW,
      intent,
      pull,
      ship,
      cap,
      target,
      noPrice: psf <= 0 && stock > 0,
      kapi,
      geriBirakilan,
      gecikmeHf,
      drenaj: yas.drenaj,
      stokYaslandirilmis: yas.stokYaslandirilmis,
      vTrend,
      d,
      magaza,
      P,
      T,
      dUst,
    });
  }
  const recByKey = new Map(
    recs.map((x) => [x.r.retailer + "|" + x.r.product_key, x]),
  );

  // ── AĞ TALEBİ: ürün başına tüm kanalların talebi (satan satırlar) ──
  const agTalepOf = new Map<string, number>();
  for (const x of recs) {
    if (x.v >= DEAD && x.intent !== "bayat")
      agTalepOf.set(
        x.r.product_key,
        (agTalepOf.get(x.r.product_key) ?? 0) + x.d,
      );
  }
  const digerTalep = (x: R) =>
    Math.max(
      0,
      (agTalepOf.get(x.r.product_key) ?? 0) - (x.v >= DEAD ? x.d : 0),
    );
  // ── ESKİ SEZON AMA BAŞKA KANALDA SATIYOR → TASFİYE YOK ──
  // Kanıt kapısı yalnız ürünün KENDİ kanalındaki hızına bakıyordu. 29.10 denetimi:
  // 7 likidasyon kalemi başka kanalda haftada ≥20 satıyordu (Toyzz ŞL albümü 33
  // adet "indirimle tasfiye" iken D&R haftada 98 satıyor; Armağan EURO 2024
  // sticker 678 adet, Toyzz 31/hf). Tam fiyatla satılabilecek malı indirimle
  // eritmek para kaybettirir: bu satırlar ÇEK'e (depo/transfer) döner, satan
  // kanala verilir. Likidasyon kapısı sayaçları (intent "obsolet") onları saymaz.
  // EMİŞ ŞARTI: diğer kanallar çekilenin en az yarısını TUT_UFKU haftada
  // emebilmeli; yoksa (ör. 3.004 adet, diğerleri haftada ~6) tasfiye kalır ve
  // gerekçe yalnız "şu kadarı başka kanala verilebilir" der.
  for (const x of recs) {
    if (x.intent !== "obsolet") continue;
    const dt = digerTalep(x);
    if (dt < AG_TALEP_ESIK) continue;
    x.agTalep = dt;
    if (dt * TUT_UFKU >= 0.5 * x.pull) x.intent = "fazla";
  }
  // ── ETKİ (ETKI_UFKU hf, NET TL) ──
  // Bir aksiyonun sıralamadaki yeri, 4 haftada kazandırdığı ya da kaybettirdiği
  // NET satıştır (raf eğrisiyle simülasyon, compute.ts beklenenSatis). Fiyatı
  // olmayan satırda birim 0 → etki 0 (listede kalır, sıralamada geride).
  const birimNet = (x: R) => (x.noPrice ? 0 : x.psf * netFactor(x.r.retailer));
  const sevkEtkisi = (x: R, adet: number) =>
    (beklenenSatis(x.stock, x.d, x.magaza, adet, ETKI_UFKU) -
      beklenenSatis(x.stock, x.d, x.magaza, 0, ETKI_UFKU)) *
    birimNet(x);
  const cekKaybi = (x: R, adet: number) =>
    (beklenenSatis(x.stock, x.d, x.magaza, 0, ETKI_UFKU, 0) -
      beklenenSatis(
        Math.max(0, x.stock - adet),
        x.d,
        x.magaza,
        0,
        ETKI_UFKU,
        0,
      )) *
    birimNet(x);
  const kayipHfOf = (x: R) =>
    (x.d - haftalikSatis(x.stock, x.d, x.magaza)) * birimNet(x);
  const tarihEkle = (iso: string, gun: number) =>
    new Date(Date.parse(iso + "T12:00:00Z") + gun * 864e5)
      .toISOString()
      .slice(0, 10);
  // SON TARİH: stok asgari rafın (mağaza verisi yoksa teslim+1 haftalık stoğun)
  // altına inmeden TESLIM_HF hafta önce. Hesap raporlanan haftanın bitişinden
  // yapılır; geçmişe düşerse bugün ("hemen").
  const sonTarihOf = (x: R): string | null => {
    const hf = sorunHaftasi(x.stock, x.d, x.P);
    const dw = lastWeekOf[x.r.retailer];
    if (!isFinite(hf) || !dw) return null;
    const t = tarihEkle(dw, 6 + Math.floor((hf - TESLIM_HF) * 7));
    return t < veri.asOf ? veri.asOf : t;
  };
  const rafIncemi = (x: R) =>
    x.magaza != null && x.stock / x.magaza < (RAF_ASGARI[mode] ?? 4);
  // Transferle gelecek adet (hedef satırın sevkinden düşülür; aynı ihtiyaç iki kez karşılanmasın).
  const transferIn = new Map<string, number>();

  // BAYAT KALEMLERİN SON GÖRÜLME HAFTASI. Pencere 12 hafta olduğu için ondan
  // önce düşmüş kalemin tarihi pencerede yok (ölçüm: Sevimli Canavar 7'li,
  // 2026-02-09 = ~25 hafta önce). "Bayat" demek karar üretmiyor; firmaya
  // "şu tarihten beri raporunuzda yok" diyebilmek için tarih şart. Yalnız bayat
  // kalemler için, isim listesiyle tek hedefli sorgu (pencere filtresi YOK).
  const staleSeen = new Map<string, string>();
  {
    const bayat = recs.filter((x) => x.intent === "bayat");
    for (const x of bayat) {
      const w = lastSeenInWindow(x.r.retailer + "|" + x.r.product_key);
      if (w) staleSeen.set(x.r.retailer + "|" + x.r.product_key, w);
    }
    const eksik = bayat.filter(
      (x) => !staleSeen.has(x.r.retailer + "|" + x.r.product_key),
    );
    const names = [...new Set(eksik.map((x) => x.r.sku_name).filter(Boolean))];
    if (names.length) {
      const hist = await fetchAllRows<any>((f, t) =>
        supabase
          .from("sku_weekly")
          .select("retailer, sku_name, week_start")
          .in("sku_name", names)
          .order("retailer")
          .order("sku_name")
          .order("week_start")
          .range(f, t),
      );
      const byName = new Map<string, string>();
      for (const h of hist) {
        const kk = h.retailer + "|" + h.sku_name;
        const cur = byName.get(kk);
        if (!cur || h.week_start > cur) byName.set(kk, h.week_start);
      }
      for (const x of eksik) {
        const w = byName.get(x.r.retailer + "|" + x.r.sku_name);
        if (w) staleSeen.set(x.r.retailer + "|" + x.r.product_key, w);
      }
    }
  }

  // paylaşımlı kapasite defteri (R5)
  const ledger = new Map<string, number>();
  for (const x of recs)
    if (x.cap > 0) ledger.set(x.r.retailer + "|" + x.r.product_key, x.cap);

  const base = (x: R) => ({
    retailer: x.r.retailer,
    sku_name: x.r.sku_name,
    barkod: x.r.barkod || "",
    season: x.sea,
    abc: x.abc,
    xyz: x.xyz,
    stock: x.stock,
    velocity: r1(x.v),
    coverage: x.cov == null ? null : Math.round(x.cov),
    target: x.target,
    psf: Math.round(x.psf),
    noPrice: x.noPrice,
    ...(x.fiyatFatura ? { fiyatKaynagi: "fatura" } : {}),
    // VERİ YAŞI HER SATIRDA. Eskiden 612 önerinin 612'si tarihsizdi: ekranda
    // "233 adet çek" yazıyordu ve o sayının 4 hafta önceki bir rapordan mı
    // geldiği hiçbir yerde görünmüyordu. `stock` alanı RAPORLANAN değer olarak
    // kalır; tahmin ayrı alanda durur ve hiçbir kapıyı beslemez.
    dataWeek: lastWeekOf[x.r.retailer] ?? null,
    gecikmeHf: x.gecikmeHf,
    drenaj: x.drenaj,
    stokYaslandirilmis: x.stokYaslandirilmis,
    kapi: x.kapi,
    // RAF VARLIĞI — ekranda "mağaza başı N adet" ve sıralama için.
    talep: r1(x.d),
    // Raf inceyse talep belirsiz: iyimser uç (×5 tavan). Eşitse alan yazılmaz.
    ...(x.dUst > x.d + 0.05 ? { talepUst: r1(x.dUst) } : {}),
    magaza: x.magaza,
    rafEsik: x.P,
    rafMagazaBasi: x.magaza ? r1(x.stock / x.magaza) : null,
    rafPayi: x.magaza
      ? Math.round(rafPayi(x.stock / x.magaza) * 100) / 100
      : null,
  });

  const routes: any[] = [];

  // ── DÜŞÜŞ MUHASEBESİ ──
  // "Serbest kalacak sermaye" manşeti bu değişiklikle düşüyor ve düşüşün
  // tahsilat/iyileşme sanılması bu ekranın en pahalı yanlış okuması olurdu.
  // Bu yüzden düşüş üç bileşene ATIF SIRASIYLA dağıtılır (kanıt kapısı → askı →
  // kırpma), her biri KALAN üzerinde ölçülür ve bileşenler satır satır
  // YUVARLANMIŞ farklardan toplanır. Böylece
  //     baz − kanit − aski − kirpma === frozenFreed
  // eşitliği kuruş sapmasız tutar. (Şartnamenin elle yazılmış bileşenleri
  // ₺5.746 fazla açıklıyordu; çakışma Nezih'in hem askıya hem kırpmaya yazılan
  // satırlarındaydı — bu yüzden sayılar artık çalışma anında türetiliyor.)
  const dusus = { baz: 0, kanit: 0, aski: 0, kirpma: 0, sonuc: 0 };
  const bosAgg = () => ({ n: 0, qty: 0, psf: 0 });
  const kirpmaAgg = bosAgg(),
    askiAgg = bosAgg();
  const askiByRet: Record<string, { n: number; qty: number; psf: number }> = {};
  const kirpmaByRet: Record<string, { n: number; qty: number; psf: number }> =
    {};
  const ekle = (
    a: { n: number; qty: number; psf: number },
    qty: number,
    psf: number,
  ) => {
    a.n++;
    a.qty += qty;
    a.psf += psf;
  };

  // BAZ ve KANIT: kapı olmasa motorun çekeceği adet üzerinden.
  // Eski davranış: eski sezon satırında pull = stock (rafın tamamı).
  const eskiPull = (x: R) =>
    // Güncel ürünün "satarak erit" satırı (kapi null) eski motorda da kanıt kapısına
    // girmezdi; baza yazılırsa kanıt kapısı kendi işi olmayan bir düşüşü üstlenir.
    x.intent === "obsolet" ||
    (x.intent === "erit" && x.kapi === "erit") ||
    (x.intent === "sevk" && x.kapi === "erit")
      ? x.stock
      : x.intent === "olu" || x.intent === "fazla"
        ? x.pull
        : 0;
  for (const x of recs) {
    const v0 = x.noPrice ? 0 : Math.round(eskiPull(x) * x.psf);
    const v1 = x.noPrice ? 0 : Math.round(x.pull * x.psf);
    dusus.baz += v0;
    dusus.kanit += Math.max(0, v0 - v1);
  }

  // kaynaklar: yüksek değer önce kapasiteyi kapsın
  const sources = recs
    .filter(
      (x) =>
        (x.intent === "olu" ||
          x.intent === "fazla" ||
          x.intent === "obsolet") &&
        x.pull > 0,
    )
    .sort((a, b) => b.pull * b.psf - a.pull * a.psf);
  for (const x of sources) {
    const pk = x.r.product_key,
      psf = x.psf,
      pull = x.pull;
    const valueHam = x.noPrice ? 0 : Math.round(pull * psf);
    const kad = kademeFor(x.r.retailer);

    // ── KADEME ASKISI ──
    // Geri alınamaz fiil (LİKİDASYON) 3 haftadan eski veriyle üretilmez; 6
    // haftadan eskisinde DEPO/TRANSFER de üretilmez. SEVK ve TEYİT hiçbir
    // kademede bastırılmaz (aşağıdaki ikinci döngü onlara dokunmuyor).
    // SATIR LİSTEDEN SİLİNMEZ: kimliği, raporlanan stoğu ve gerekçesi kalır,
    // yalnız qty/value sıfırlanır ve `askidaFiil` neyin beklediğini taşır.
    // Sessizlik "sorun yok" diye okunmasın.
    const likAskida = x.intent === "obsolet" && !kad.likidasyonAcik;
    if (likAskida || !kad.cekAcik) {
      const fiil = x.intent === "obsolet" ? "LIKIDASYON" : "DEPO";
      ekle(askiAgg, pull, valueHam);
      askiByRet[x.r.retailer] ||= bosAgg();
      ekle(askiByRet[x.r.retailer], pull, valueHam);
      dusus.aski += valueHam;
      routes.push({
        ...base(x),
        action: "ASKIDA",
        askidaFiil: fiil,
        qty: 0,
        qtyHam: pull,
        dest: null,
        toDepot: 0,
        value: 0,
        valueHam,
        reason: kad.kapanmaSorusu
          ? `${x.r.retailer} raporu ${x.gecikmeHf} haftadır gelmiyor — önce "hesap kapandı mı" sorusu yanıtlanmalı; ${pull} adet için karar üretilmiyor`
          : `${x.r.retailer} verisi ${x.gecikmeHf} hafta eski — ${fiil === "LIKIDASYON" ? "geri alınamaz tasfiye kararı" : "çekme kararı"} askıda; ${pull} adet rapor bekliyor`,
      });
      continue;
    }

    // ── YAŞLANDIRMA KIRPMASI ──
    // Rapor tarihinden bugüne muhtemelen satılmış adet (drenaj) çekilecek
    // adetten düşülür. Ölçülen hata yönü her firmada aynı: "fazla çek + eksik
    // sevk". Kırpma yalnız ÇEK tarafına uygulanır; SEVK adedi değişmez.
    const qty = Math.max(0, pull - x.drenaj);
    const value = x.noPrice ? 0 : Math.round(qty * psf);
    if (qty < pull) {
      ekle(kirpmaAgg, pull - qty, valueHam - value);
      kirpmaByRet[x.r.retailer] ||= bosAgg();
      ekle(kirpmaByRet[x.r.retailer], pull - qty, valueHam - value);
    }
    dusus.kirpma += Math.max(0, valueHam - value);

    // Kırpma sonrası çekilecek bir şey kalmadı → karar YOK. `dest`/`toDepot`
    // temizlenir (ekranda karar üretmeyen satır "→ Toyzz 35" gösteremez) ve
    // kapasite defterine hiç dokunulmaz (başka bir kaynak kullanabilsin).
    if (qty <= 0) {
      routes.push({
        ...base(x),
        action: "İZLE",
        qty: 0,
        qtyHam: pull,
        dest: null,
        toDepot: 0,
        value: 0,
        valueHam,
        reason: `Raporlanan ${pull} adet fazlalık, ${x.gecikmeHf} haftalık tahmini satışla (${x.drenaj} adet) hedefe indi — karar yok`,
      });
      continue;
    }

    if (x.intent === "obsolet") {
      routes.push({
        ...base(x),
        action: "LIKIDASYON",
        qty,
        qtyHam: pull,
        dest: null,
        toDepot: qty,
        value,
        valueHam,
        geriBirakilan: x.geriBirakilan,
        reason:
          (x.kapi === "kismi"
            ? `Eski sezon ama hâlâ satıyor (${r1(x.v)}/hf) — ${x.geriBirakilan} adet rafta bırakıldı, fazlası markdown`
            : `Eski sezon ve satmıyor (${r1(x.v)}/hf) — pack&hold maliyetli; markdown/likidasyon (erken-büyük indirim)`) +
          // Diğer kanallar az da olsa satıyorsa: emebilecekleri kadarı indirimden önce oraya.
          (x.agTalep != null
            ? `; diğer kanallar haftada ~${r1(x.agTalep)} satıyor — ${Math.min(qty, Math.round(x.agTalep * TUT_UFKU))} adedi indirimden önce oraya verilebilir`
            : ""),
      });
      continue;
    }
    // ölü/fazla → transfer (yalnız A/B + ihtiyaçlı hedef + değerli) yoksa depo
    // TAHSİS KIRPILMIŞ ADET ÜZERİNDEN: eskiden ham `pull` ile tahsis ediliyordu
    // ve kırpma sonrası `qty ≠ dest.qty + toDepot` çıkıyordu (ekranda "→ Firma
    // 900 + depo 300" ama çek 198). Kırpılmış adetle tahsis bu tutarsızlığı
    // kaynağında kapatır ve defterdeki kapasite boşa harcanmaz.
    let give = 0,
      tgt: any = null;
    if (x.abc === "A" || x.abc === "B") {
      // hedef adayının hızı da GÜNCEL pencereden (ömür ortalaması hedefi şişiriyordu)
      const cands = (byKey.get(pk) || [])
        .filter(
          (o) =>
            o.retailer !== x.r.retailer &&
            velOf(o.retailer + "|" + pk, o.retailer) >= DEAD,
        )
        .map((o) => ({ o, rem: ledger.get(o.retailer + "|" + pk) || 0 }))
        .filter((c) => c.rem > 0)
        .sort((a, b) => b.rem - a.rem);
      if (cands.length) {
        const bst = cands[0],
          g = Math.min(qty, bst.rem);
        if (g > 0 && g * psf >= FLOOR) {
          give = g;
          ledger.set(bst.o.retailer + "|" + pk, bst.rem - g);
          tgt = {
            retailer: bst.o.retailer,
            qty: g,
            vel: r1(velOf(bst.o.retailer + "|" + pk, bst.o.retailer)),
          };
        }
      }
    }
    const toDepot = qty - give;
    // ETKİ: hedefte kazanılan − kaynakta kaybedilen (kaynak ufuk + asgari raf
    // üstünde kaldığı için kaynak kaybı çoğunlukla ~0).
    const hedefRec = tgt ? recByKey.get(tgt.retailer + "|" + pk) : undefined;
    if (tgt)
      transferIn.set(
        tgt.retailer + "|" + pk,
        (transferIn.get(tgt.retailer + "|" + pk) || 0) + give,
      );
    const etkiT = Math.round(
      (hedefRec ? sevkEtkisi(hedefRec, give) : 0) - cekKaybi(x, qty),
    );
    const action = give > 0 ? "TRANSFER" : "DEPO";
    // GEREKÇE DİLİ: firma 6+ hafta sessizse "burada ölü (0,0/hf)" demek ÜRÜNÜ
    // suçlar, oysa eksik olan rapordur. O satırlar zaten askıya alınıyor; yine
    // de gecikmeli firmada gerekçeye veri tarihi ekleniyor.
    // Çekilen mal başka kanalda satıyorsa gerekçe bunu söyler: depo bir ara
    // duraktır, mal oradan satan kanala sevk edilir (29.10 denetimi: 26 "burada
    // ölü" satırı başka kanalda haftada ≥20 satıyordu, gerekçe bunu göstermiyordu).
    const dt = digerTalep(x);
    const agNotu =
      dt >= AG_TALEP_ESIK
        ? `; diğer kanallar haftada ~${r1(dt)} satıyor — çekilen mal oraya sevk edilsin`
        : "";
    const reason =
      x.agTalep != null
        ? `Eski sezon; burada ${x.v >= DEAD ? `yavaş satıyor (${base(x).velocity}/hf, ${base(x).coverage} hf stok)` : `satmıyor (${base(x).velocity}/hf)`} ama diğer kanallar haftada ~${r1(x.agTalep)} satıyor — indirimle tasfiye etme, ${x.v >= DEAD ? "fazlasını " : ""}çek ve satan kanala ver`
        : x.intent === "olu"
          ? `${x.abc}-sınıf · ${x.xyz} · burada ölü (${base(x).velocity}/hf) → çek${agNotu}`
          : `${x.abc}-${x.xyz} · aşırı stok (${base(x).coverage} hf > ${Math.round(TUT_UFKU * mult)} hf ufuk) → ufkun üstünü çek${x.magaza ? `; ${x.magaza} mağazaya mağaza başı ${r1((x.stock - qty) / x.magaza)} adet kalır` : ""}${agNotu}`;
    const ek =
      x.drenaj > 0
        ? `; raporlanan ${pull} adet, ${x.gecikmeHf} hf tahmini satışla ${qty}`
        : "";
    routes.push({
      ...base(x),
      action,
      qty,
      qtyHam: pull,
      dest: tgt,
      toDepot,
      value,
      valueHam,
      etki8: etkiT,
      ...(hedefRec ? { sonTarih: sonTarihOf(hedefRec) } : {}),
      reason: (tgt ? `${reason}; ${tgt.retailer} alabilir` : reason) + ek,
    });
  }
  for (const x of recs) {
    // SEVK — HİÇBİR KADEMEDE BASTIRILMAZ.
    // `qty` RAPORLANAN stokla hesaplanmış adettir ve öyle kalır: sipariş
    // raporlanan sayı üzerinden verilir. `sevkUst`, raf gerçekten erimişse
    // gereken üst sınırı ikincil bilgi olarak taşır — tahmin olduğu ekranda
    // açıkça yazılır. Bastırma yönü ölçümle yanlış: bayat veri sevki yanlış
    // değil EKSİK yapar, bastırmak geri gelmeyen tek kaybı kesinleştirir.
    if (x.intent === "sevk") {
      const eritSevk = x.kapi === "erit";
      // Başka kanalın fazlası transferle bu ihtiyaca ayrıldıysa sevk o kadar azalır.
      const gelen = transferIn.get(x.r.retailer + "|" + x.r.product_key) || 0;
      x.ship = Math.max(0, x.ship - gelen);
      if (x.ship <= 0) {
        x.intent = "tut";
        continue;
      }
      const trend =
        x.vTrend != null
          ? `; satış düşüyor (8 hf ort. ${r1(x.v)}/hf → son ${TREND_SON} hf ${r1(x.vTrend)}/hf), adet güncel hızla`
          : "";
      const ince = rafIncemi(x);
      const kacan = x.magaza
        ? Math.round((1 - rafPayi(x.stock / x.magaza)) * 100)
        : 0;
      // D&R DEPOSU: aynı haftanın deposu biliniyorsa ihtiyacın depodan karşılanan
      // kısmı "dağıt" (D&R kendi deposundan mağazalara), kalanı bizden sevk. Depo
      // ihtiyacın tamamını karşılıyorsa satır DAĞIT olur. Bilinmiyorsa çekince notu.
      const depo =
        x.r.retailer === "DR" ? depoOf.get(x.r.product_key) : undefined;
      const dagit = depo ? Math.min(Math.floor(depo.offline), x.ship) : 0;
      const bizden = x.ship - dagit;
      const depoNotu =
        x.r.retailer !== "DR"
          ? ""
          : depoHaftasi == null
            ? "; D&R deposunda varsa önce mağazalara dağıtılsın"
            : dagit > 0
              ? `; D&R deposunda ${Math.round(depo!.offline)} adet var — ${dagit} adedini mağazalara dağıtsın${bizden > 0 ? `, ${bizden} adet bizden` : ", bizden sevk gerekmez"}`
              : "; D&R'ın mağazalara dağıtacağı depoda bu üründen yok";
      routes.push({
        ...base(x),
        action: bizden > 0 ? "SEVK" : "DAĞIT",
        qty: bizden > 0 ? bizden : dagit,
        ...(dagit > 0 ? { dagit } : {}),
        ...(depo ? { depoStok: Math.round(depo.offline + depo.web) } : {}),
        dest: null,
        toDepot: 0,
        value: 0,
        sevkUst: x.ship + x.drenaj,
        // Transferle gelen varsa sevkin etkisi onun ÜSTÜNE eklediği değerdir;
        // transfer satırı kendi etkisini taşıyor, ikisi toplanınca çift sayılmasın.
        // Depodan dağıtım da raftaki stoğu artırdığı için etki ihtiyacın TAMAMI üzerinden.
        etki8: Math.round(sevkEtkisi(x, x.ship + gelen) - sevkEtkisi(x, gelen)),
        kayipHf: Math.round(kayipHfOf(x)),
        sonTarih: sonTarihOf(x),
        ...(gelen > 0 ? { transferGelen: gelen } : {}),
        ...(x.vTrend != null ? { trendHiz: r1(x.vTrend) } : {}),
        reason:
          (eritSevk
            ? `Eski sezon ama hâlâ satıyor (${r1(x.v)}/hf) ve raf ${base(x).coverage} hf kaldı — indirim değil sevk (hedef ${x.target} hf)`
            : x.stock <= 0
              ? "Tükendi — satıyor, sevk et"
              : ince
                ? `Raf ince: ~${x.magaza} mağazaya mağaza başı ${r1(x.stock / x.magaza!)} adet (asgari ${RAF_ASGARI[mode] ?? 4}) — kaçan satış ~%${kacan}, sevk et${trend}`
                : `Hedef altı (${base(x).coverage} hf < ${x.target} hf) — sevk et${trend}`) +
          (gelen > 0 ? `; ${gelen} adet transferle geliyor` : "") +
          depoNotu,
      });
      // Depo ihtiyacın tamamını karşılıyorsa iş sevk değil dağıtım: gerekçenin fiili de.
      if (bizden <= 0) {
        const son = routes[routes.length - 1];
        son.reason = String(son.reason).replace(/sevk et/g, "dağıtım iste");
      }
    }
    // DÜŞEN TALEP: 8 hf ortalamasıyla sevk gerekiyordu, güncel hızla gerekmiyor.
    // Satır listede kalır ki "motor neden sevk demiyor" sorusu cevapsız kalmasın.
    else if (x.intent === "dusus" && x.vTrend != null) {
      routes.push({
        ...base(x),
        action: "İZLE",
        qty: 0,
        dest: null,
        toDepot: 0,
        value: 0,
        trendHiz: r1(x.vTrend),
        reason: `Satış düşüyor (8 hf ort. ${r1(x.v)}/hf → son ${TREND_SON} hf ${r1(x.vTrend)}/hf, raf doluyken) — ${x.vTrend > 0 ? `güncel hızla ${Math.round(x.stock / x.vTrend)} hf stok var` : "son haftalarda satış yok"}, sevk yok`,
      });
    }
    // ERİT — likidasyondan çıkarılan kalem. `value: 0` ÇÜNKÜ ERİT SERMAYE
    // SERBEST BIRAKMAZ: mal rafta kalıyor, hiçbir şey hareket etmiyor.
    // frozenFreed'e girmesi "serbest kalacak sermaye" manşetini şişirirdi.
    // Raf değeri ve haftalık akış ayrı alanlarda (eritRaf / eritNet) durur.
    else if (x.intent === "erit") {
      routes.push({
        ...base(x),
        action: "ERIT",
        qty: 0,
        dest: null,
        toDepot: 0,
        value: 0,
        eritRaf: Math.round(x.stock * x.psf),
        eritNet: Math.round(x.v * x.psf * netFactor(x.r.retailer)),
        // GEREKÇE, ATEŞLENEN DALI SÖYLER — SABİT METİN DEĞİL.
        // Eskiden burada "kapsam N hf ≤ 26 hf" sabit yazıyordu ve ERİT iki ayrı
        // daldan doğduğu için tek satırda kendisiyle çelişiyordu: üretimde
        // ölçülen kalem (Toyzz FB Sezon Kartları 25'li, 60 adet, 2,3/hf)
        // ekranda "kapsam 27 hf ≤ 26 hf" yazıyordu. Sebep şu: hız r1 ile,
        // kapsam Math.round ile BAĞIMSIZ yuvarlanıyor; kapsam 27 görünürken
        // 26 haftalık rezerv (ceil(2,3×26)=60) rafın tamamını kapladığı için
        // karar "rezerv dalından" gelmişti, emme dalından değil.
        // eritTur: "eski" = kanıt kapısından (eski sezon ama satıyor), "fazla" =
        // güncel ürün hedefin üstünde ama ufuk içinde (çekme yok, sevk yok).
        eritTur: x.kapi === "erit" ? "eski" : "fazla",
        reason:
          x.kapi !== "erit"
            ? `Hedefin üstünde (${base(x).coverage} hf > ${x.target} hf) ama ${Math.round(TUT_UFKU * mult)} hf içinde satarak eriyor — çekme, yeni sevk yapma`
            : x.cov != null && Math.round(x.cov) <= LIKID_ABSORB
              ? `Eski sezon ama hâlâ satıyor (${r1(x.v)}/hf, kapsam ${base(x).coverage} hf ≤ ${LIKID_ABSORB} hf) — indirim yok, satarak erit`
              : `Eski sezon ama hâlâ satıyor (${r1(x.v)}/hf); ${LIKID_ABSORB} haftalık rezerv (${Math.ceil(r1(x.v) * LIKID_ABSORB)} adet) rafın tamamını kaplıyor — çekilecek fazla yok, satarak erit`,
      });
    } else if (x.intent === "izle")
      routes.push({
        ...base(x),
        action: "İZLE",
        qty: 0,
        dest: null,
        toDepot: 0,
        value: 0,
        reason: `Yeni ürün (${x.wkP} hf veri) — karar için bekle`,
      });
    // BAYAT: qty = teyit edilecek adet, value = brüt PSF karşılığı (büyüklüğü
    // görmek için). frozenFreed'e GİRMEZ — teyit edilmemiş stok "serbest kalacak
    // sermaye" sayılamaz.
    else if (x.intent === "bayat") {
      const seen = staleSeen.get(x.r.retailer + "|" + x.r.product_key) ?? null;
      routes.push({
        ...base(x),
        action: "TEYİT",
        qty: x.stock,
        dest: null,
        toDepot: 0,
        value: Math.round(x.stock * x.psf),
        stale: true,
        last_seen: seen,
        reason: seen
          ? `${x.r.retailer} raporunda ${seen} haftasından beri YOK (${weeksSince(seen, curW[x.r.retailer])} hf) — ${x.stock} adet stok teyit edilmeli`
          : `${x.r.retailer} güncel raporunda yok — ${x.stock} adet stok teyit edilmeli`,
      });
    }
  }

  const sumv = (a: any[]) => a.reduce((s, r) => s + (r.value || 0), 0);
  const g = (act: string) => routes.filter((r) => r.action === act);
  // 3-kova (Bain) + segment dağılımı + donmuş sermaye
  const segCount: Record<string, number> = {};
  for (const x of recs) {
    const key = x.sea === "ESKİ" ? "ESKİ" : `${x.abc}${x.xyz}`;
    segCount[key] = (segCount[key] || 0) + 1;
  }

  // ═══ ÖZET GENİŞLETMESİ (ana sayfa yönetici özeti için) ═══
  // Hepsi zaten hesaplanmış `recs`/`routes`'tan TÜRETİLİR — tek satır bile
  // yeniden hesaplanmıyor, yeni sorgu yok.
  //
  // PARA BİRİMİ KURALI: AKIŞ = NET, DURAN STOK = BRÜT PSF. Aşağıdaki `rafPsf`,
  // `cek.psf`, `sevk.psf`, `teyit.psf` ve `frozenFreed` BRÜT'tür ve net'e
  // ÇEVRİLMEZ (satılmamış malın net'i tanımsız: COGS hiçbir uçta yok, /api/stock
  // da stock_value'yu bilinçli olarak brüt tutuyor). Net'e çevrilen TEK türev
  // `sevkKritik.haftalikNet` — o bir akış, manşetteki net ciroyla aynı birimde.

  // CANLI KÜME: kapsam oranının payına da paydasına da girecek satırlar.
  //  • `bayat` satırlar ÇIKARILIR: stok teyit edilmemiş, yani "raf kaç haftalık"
  //    sorusunun cevabını şişiriyor. Ölçtüm: bayat dahil ağ kapsamı 19,2 hf,
  //    hariç 18,5 hf; Toyzz 16,9 → 14,9 (iki büyük bayat kalem onun).
  //  • stoğu 0 VE hızı 0 olan satır da çıkarılır: ne payı ne paydayı besliyor,
  //    yalnız `n` sayısını şişirir (ölçüldü: 122 satır).
  const canli = recs.filter(
    (x) => x.intent !== "bayat" && !(x.stock <= 0 && x.v <= 0),
  );
  const kapsamOf = (rows: R[]) => {
    let stok = 0,
      hiz = 0;
    for (const x of rows) {
      stok += x.stock;
      hiz += x.v;
    }
    return {
      n: rows.length,
      stok: Math.round(stok),
      hiz: r1(hiz),
      hafta: hiz > 0 ? r1(stok / hiz) : null,
    };
  };
  // Hızı 0 olan ama stoğu olan kalemler: stokları PAYA girer, paydaya HİÇ
  // katkı vermez, yani kapsam oranını yukarı çekerler. Bu itiraf olmadan
  // ağ kapsamı sayısı savunulamaz, o yüzden ayrı alan olarak veriliyor.
  const sifirHiz = canli.filter((x) => x.v <= 0);
  const kapsam = {
    ...kapsamOf(canli),
    sifirHizN: sifirHiz.length,
    sifirHizStok: sifirHiz.reduce((s, x) => s + x.stock, 0),
    // MOTOR EŞİĞİ — "HEDEF" DEĞİL. COVER matrisinin merkez değeri (A/B × X,Y = 8 hf).
    // Her satırın gerçek hedefi ABC × XYZ × sezon × mod ile 0-13 hf arasında
    // değişiyor; 8 yalnızca ekranda kıyas çizgisi olarak kullanılabilir bir
    // referanstır ve hiçbir satır için "ulaşılması gereken değer" anlamı taşımaz.
    esik: 8,
    byRetailer: [...new Set(canli.map((x) => x.r.retailer as string))]
      .map((ret) => ({
        retailer: ret,
        ...kapsamOf(canli.filter((x) => x.r.retailer === ret)),
      }))
      .sort((a, b) => (b.hafta ?? 0) - (a.hafta ?? 0)),
  };
  // Raf değeri (BRÜT PSF). Canlı ↔ bayat ayrı: ikisinin toplamı bir yerde
  // gösterilirse teyit edilmemiş stok gerçek sermaye gibi okunur.
  // YUVARLAMA SATIR BAŞINA: satır `value`'ları da Math.round(qty × psf) ile
  // üretiliyor. Toplamı sonda yuvarlarsam rafPsf.bayat = 923.904, teyit.psf =
  // 923.906 çıkıyordu — aynı kalemler için ekranda 2 TL sapan iki sayı. Ölçüldü
  // ve bilinçli olarak satır-başı yuvarlamada birleştirildi.
  const rafOf = (rows: R[]) =>
    rows.reduce((s, x) => s + Math.round(x.stock * x.psf), 0);
  const rafPsf = {
    canli: rafOf(canli),
    bayat: rafOf(recs.filter((x) => x.intent === "bayat")),
  };

  // SEVK. Satır `value`'su 0 (sevk sermaye serbest bırakmaz), büyüklük ihtiyaç
  // adedi × birim PSF ile ölçülür — BRÜT.
  const sevkRecs = recs.filter((x) => x.intent === "sevk");
  // SEVK-KRİTİK: kapsam ≤ 2 hafta VEYA stok ≤ 0.
  // İKİ KÜME TEK TL'DE TOPLANMAZ. `stock <= 0` kalemlerde ciro BUGÜN AKMIYOR —
  // o gerçekleşmiş kayıp, risk değil; ≤2 haftalık kalemler ise hâlâ satıyor ve
  // sevk edilirse korunabilir. Ölçtüm: haftalikNet ₺168.280'in ₺3.071'i (2 kalem)
  // tükenmiş kalemlerden geliyor, yani gerçek risk ₺165.209. Eşik karşılaştırması
  // yapan taraf `haftalikNet − tukendiNet` kullanmalı.
  // Eşik, satırın YAYINLANAN `coverage` alanıyla (Math.round(cov)) kıyaslanır,
  // ham oranla değil. Ölçüldü: ham oranla 8 kalem / ₺82.669, yayınlanan değerle
  // 13 kalem / ₺168.280 — fark, kapsamı 2,1-2,5 hf olan üç büyük kalem (DR Topps
  // Eco 2,47 hf / 11.315 adet dahil). Ekranda "kapsam 2 hf" yazan satırın
  // sevkKritik toplamına girmemesi, bu projede tam olarak kaçınılan sessiz
  // tutarsızlık türü; bu yüzden ölçüt görünen sayıdır.
  const kritikMi = (x: R) =>
    x.stock <= 0 || (x.cov != null && Math.round(x.cov) <= 2);
  const sevkKritikRecs = sevkRecs.filter(kritikMi);
  const tukendiRecs = sevkKritikRecs.filter((x) => x.stock <= 0);
  // haftalikNet = Σ(hız × birim PSF × O FİRMANIN net çarpanı). SATIR SATIR ve
  // her firmanın KENDİ marjıyla: çarpanlar 0,4167 (Toyzz %50) ile 0,4750
  // (Nezih %43) arasında. Harmanlanmış tek çarpan (0,45) ile aynı küme ₺176.379
  // veriyor — %4,8 sapma, ve sapma firma dağılımı değiştikçe sessizce büyüyor.
  // Düşen talep kapısından geçen satırda akış güncel hızla (8 hf ortalaması kaybı şişirir).
  const haftalikNetOf = (rows: R[]) =>
    Math.round(
      rows.reduce(
        (s, x) => s + (x.vTrend ?? x.v) * x.psf * netFactor(x.r.retailer),
        0,
      ),
    );

  // ÇEK = TRANSFER + DEPO + LİKİDASYON (üçü de "malı raftan al" fiili, ama
  // satır bazında farklı kararlar — likidasyon geri alınamaz; kırılım
  // summary.transfer/depo/likidasyon'da zaten ayrı duruyor).
  const cekR = [...g("TRANSFER"), ...g("DEPO"), ...g("LIKIDASYON")];
  const cekByRet = [...new Set(cekR.map((r) => r.retailer as string))]
    .map((ret) => {
      const a = cekR.filter((r) => r.retailer === ret);
      return {
        retailer: ret,
        n: a.length,
        qty: a.reduce((s, r) => s + r.qty, 0),
        psf: sumv(a),
      };
    })
    .sort((a, b) => b.psf - a.psf);

  // TEYİT yaşı: en eski bayat kalemin firmanın güncel haftasına olan uzaklığı.
  // Hüküm merdiveni bunu WIN_W (12 hafta) ile kıyaslıyor — ötesi "kesin yokluk".
  const teyitR = g("TEYİT");
  const enEskiHf = teyitR.reduce(
    (m, r) =>
      Math.max(m, r.last_seen ? weeksSince(r.last_seen, curW[r.retailer]) : 0),
    0,
  );

  // ── VERİ DURUMU (firma bazında) ──
  // İSTENECEK HAFTALAR: askı kaydının metni "rapor istenecek" diye edilgen
  // kalmasın; hangi haftaların eksik olduğu weekly_summary serisinden türetilir.
  // Takvim haftasından geriye doğru, firmanın son raporundan sonraki boşluklar.
  const eksikHaftalarOf = (ret: string): string[] => {
    const set = new Set(haftalarOf[ret] ?? []);
    const out: string[] = [];
    const t = Date.parse(takvimHaftasi);
    for (let i = 0; i <= GECIKME_KAPANMA + 6; i++) {
      const w = new Date(t - i * 7 * 864e5).toISOString().slice(0, 10);
      if (set.has(w)) break;
      out.push(w);
    }
    return out.reverse();
  };
  const eritR = g("ERIT");
  const askiR = g("ASKIDA");
  const sevkR = g("SEVK");
  const veriByRetailer = [...new Set(Object.keys(lastWeekOf))]
    .map((ret) => {
      const kad = kademeFor(ret);
      return {
        retailer: ret,
        dataWeek: lastWeekOf[ret] ?? null,
        gecikmeHf: gecikmeOf(ret),
        kararGecikmeHf: kararGecikmeOf(ret),
        durum: kad.durum,
        karar: kad.karar,
        rozet: kad.rozet,
        likidasyonAcik: kad.likidasyonAcik,
        cekAcik: kad.cekAcik,
        // Askı kaydı kütle taşır: "sessizlik" değil, kaç kalem / kaç adet / kaç TL
        // değerlendirilemiyor. Ayrıca hangi haftaların istenmesi gerektiği burada
        // türetilir (elle yazılmaz) — veriyi alma döngüsünü kapatan tek şey bu.
        askida: askiByRet[ret] ?? { n: 0, qty: 0, psf: 0 },
        kirpma: kirpmaByRet[ret] ?? { n: 0, qty: 0, psf: 0 },
        eksikHaftalar: eksikHaftalarOf(ret),
      };
    })
    .sort((a, b) => b.gecikmeHf - a.gecikmeHf);

  const summary = {
    transfer: { n: g("TRANSFER").length, psf: sumv(g("TRANSFER")) },
    depo: { n: g("DEPO").length, psf: sumv(g("DEPO")) },
    likidasyon: { n: g("LIKIDASYON").length, psf: sumv(g("LIKIDASYON")) },
    // n ALANI DEĞİŞMEDİ (mevcut tüketiciler kırılmasın); qty/psf eklendi — BRÜT.
    sevk: {
      n: g("SEVK").length,
      qty: sevkRecs.reduce((s, x) => s + x.ship, 0),
      psf: sevkRecs.reduce((s, x) => s + Math.round(x.ship * x.psf), 0),
    },
    sevkKritik: {
      n: sevkKritikRecs.length,
      qty: sevkKritikRecs.reduce((s, x) => s + x.ship, 0),
      haftalikNet: haftalikNetOf(sevkKritikRecs), // NET AKIŞ (tek net türev)
      tukendiN: tukendiRecs.length,
      tukendiNet: haftalikNetOf(tukendiRecs), // bu kısım ZATEN akmıyor
    },
    izle: { n: g("İZLE").length },
    teyit: {
      n: teyitR.length,
      psf: sumv(teyitR),
      qty: teyitR.reduce((s, r) => s + r.qty, 0),
      enEskiHf,
    },
    cek: {
      n: cekR.length,
      qty: cekR.reduce((s, r) => s + r.qty, 0),
      psf: sumv(cekR),
      byRetailer: cekByRet,
    },
    kapsam,
    rafPsf,
    frozenFreed: sumv(g("TRANSFER")) + sumv(g("DEPO")) + sumv(g("LIKIDASYON")), // serbest kalacak donmuş sermaye
    noPrice: routes.filter(
      (r) =>
        r.noPrice &&
        (r.action === "TRANSFER" ||
          r.action === "DEPO" ||
          r.action === "LIKIDASYON"),
    ).length,
    mode,
    modeLabel: MODE_LABEL[mode] ?? MODE_LABEL.denge,
    segCount,

    // ── ERİT: likidasyondan çıkarılan kalemler ──
    // `rafPsf` BRÜT (duran stok), `haftalikNet` NET (akış) — ikisi asla
    // toplanmaz, farklı birimler.
    erit: {
      n: eritR.length,
      stok: eritR.reduce((a, r) => a + (r.stock || 0), 0),
      rafPsf: eritR.reduce((a, r) => a + (r.eritRaf || 0), 0),
      haftalikNet: eritR.reduce((a, r) => a + (r.eritNet || 0), 0),
    },
    // ── KANIT KAPISI KIRILIMI ──
    likidasyonKapisi: {
      tam: (() => {
        const a = recs.filter(
          (x) => x.intent === "obsolet" && x.kapi === "tam",
        );
        return {
          n: a.length,
          qty: a.reduce((s, x) => s + x.pull, 0),
          psf: a.reduce(
            (s, x) => s + (x.noPrice ? 0 : Math.round(x.pull * x.psf)),
            0,
          ),
        };
      })(),
      kismi: (() => {
        const a = recs.filter(
          (x) => x.intent === "obsolet" && x.kapi === "kismi",
        );
        return {
          n: a.length,
          geriBirakilanQty: a.reduce((s, x) => s + x.geriBirakilan, 0),
          geriBirakilanPsf: a.reduce(
            (s, x) => s + (x.noPrice ? 0 : Math.round(x.geriBirakilan * x.psf)),
            0,
          ),
        };
      })(),
      erit: {
        n:
          eritR.filter((r) => r.kapi === "erit").length +
          sevkR.filter((r) => r.kapi === "erit").length,
        eritN: eritR.filter((r) => r.kapi === "erit").length,
        sevkeDonenN: sevkR.filter((r) => r.kapi === "erit").length,
        qty: recs
          .filter((x) => x.kapi === "erit")
          .reduce((s, x) => s + x.stock, 0),
        rafPsf: recs
          .filter((x) => x.kapi === "erit")
          .reduce(
            (s, x) => s + (x.noPrice ? 0 : Math.round(x.stock * x.psf)),
            0,
          ),
        haftalikNet: Math.round(
          recs
            .filter((x) => x.kapi === "erit")
            .reduce((s, x) => s + x.v * x.psf * netFactor(x.r.retailer), 0),
        ),
      },
    },
    // ── VERİ DURUMU ──
    veri: {
      asOf: veri.asOf,
      takvimHaftasi,
      agHaftasi: veri.agHaftasi,
      dataVersion: veri.dataVersion,
      byRetailer: veriByRetailer,
      askida: askiAgg,
      kirpma: kirpmaAgg,
      sevkUst: {
        qty: sevkR.reduce((a, r) => a + (r.sevkUst ?? r.qty ?? 0), 0),
        psf: sevkRecs.reduce(
          (s, x) => s + Math.round((x.ship + x.drenaj) * x.psf),
          0,
        ),
      },
      // Kapalı (tasfiye edilmiş) kalemler: karar üretmiyorlar ama manşetlerden
      // düştükleri için tek satırlık bir kayıt olmadan "8 kalem nereye gitti"
      // sorusu cevapsız kalırdı.
      kapali: {
        n: KAPALI_TOPLAM.n,
        stok: KAPALI_TOPLAM.stok,
        atlanan: kapaliAtlanan,
        geriDonen: kapaliGeriDonen,
      },
    },
    // ── MANŞET DÜŞÜŞÜNÜN GEREKÇESİ ──
    // `dogrulandi` alanı eşitliğin tuttuğunu ekranın kendisine de söyler:
    // baz − kanit − aski − kirpma === frozenFreed.
    dusus: (() => {
      const sonuc =
        sumv(g("TRANSFER")) + sumv(g("DEPO")) + sumv(g("LIKIDASYON"));
      return {
        ...dusus,
        sonuc,
        dogrulandi:
          dusus.baz - dusus.kanit - dusus.aski - dusus.kirpma === sonuc,
      };
    })(),
  };
  // ═══ ÖZ-DENETİM (2026-10-29) ═══
  // Her karar satırı, kararın dayandığı verinin şüpheli olup olmadığına dair
  // ucuz kontrollerden geçer; şüphe satırı SİLMEZ, `uyari` olarak işaretler.
  // Kaynak: 29.10 elle yapılan denetim (scratchpad/yonlendirme/denetim_*.py).
  //   • fiyat: aynı barkodun diğer kanallardaki fiyat ortasından ±%25-33 sapma →
  //     satırın TL'si (etki, değer) güvenilmez. D&R'ın KDV hariç saklanan fiyatları
  //     ve eskimiş fiyatlar böyle yakalanır (faturayla ±%5 içinde olan D&R ürünü
  //     yalnız 100'de 28'di).
  //   • sevk: adet 16 haftalık talebi aşıyor (asgari raf tavanından sonra olmamalı).
  //   • ağ kıt: ürünün TÜM kanallarda toplam stoğu 8 haftalık talepten az iken çekme
  //     — çekilen mal depoda beklememeli, hemen satan kanala gitmeli.
  //   • kısa geçmiş: ürün 3 haftadan az rafta; hız tek-iki haftalık veriye dayanıyor.
  //   • sivri stok: son haftanın stoğu bir önceki haftanın 2,5 katından fazla
  //     (depo karışmış ya da yükleme hatası olabilir; 21 Eyl ASEPTO vakası).
  const fiyatlarOf = new Map<string, number[]>();
  const agStokOf = new Map<string, number>();
  for (const x of recs) {
    if (x.psf > 0) {
      const a = fiyatlarOf.get(x.r.product_key) ?? [];
      a.push(x.psf);
      fiyatlarOf.set(x.r.product_key, a);
    }
    if (x.intent !== "bayat")
      agStokOf.set(
        x.r.product_key,
        (agStokOf.get(x.r.product_key) ?? 0) + x.stock,
      );
  }
  const ortanca = (a: number[]) => {
    const b = [...a].sort((p, q) => p - q),
      m = Math.floor(b.length / 2);
    return b.length % 2 ? b[m] : (b[m - 1] + b[m]) / 2;
  };
  const uyariSay: Record<string, number> = {};
  let uyariliSatir = 0;
  for (const r of routes) {
    const x =
      recByKey.get(
        r.retailer +
          "|" +
          (r.barkod
            ? pkOf(r.retailer, r.sku_name, r.barkod)
            : "NAME:" + r.sku_name),
      ) ??
      recs.find(
        (y) => y.r.retailer === r.retailer && y.r.sku_name === r.sku_name,
      );
    if (!x) continue;
    const u: string[] = [];
    const fl = fiyatlarOf.get(x.r.product_key) ?? [];
    // Faturadan gelen fiyat kanıtın kendisi; şüpheli sayılmaz (diğer kanalın
    // fiyatı farklıysa sorun o tarafta).
    if (x.psf > 0 && fl.length >= 2 && !x.fiyatFatura) {
      const o = ortanca(fl);
      if (o > 0 && (x.psf / o > 1.33 || x.psf / o < 0.75))
        u.push(
          `fiyat şüpheli: bu kanalda ${Math.round(x.psf)} TL, kanalların ortası ${Math.round(o)} TL — TL etkisi güvenilmez`,
        );
    }
    if (
      (r.action === "SEVK" || r.action === "DAĞIT") &&
      x.d > 0 &&
      r.qty / x.d > 16
    )
      u.push(`sevk ${Math.round(r.qty / x.d)} haftalık talep — çok uzun`);
    if (r.action === "DEPO" || r.action === "TRANSFER") {
      const tv = agTalepOf.get(x.r.product_key) ?? 0,
        ts = agStokOf.get(x.r.product_key) ?? 0;
      if (tv > 0 && ts / tv < 8)
        u.push(
          `ağın tamamında ${r1(ts / tv)} haftalık stok — çekilen mal depoda beklemesin, satan kanala gitsin`,
        );
    }
    if (x.wkP > 0 && x.wkP < 3 && x.v >= DEAD)
      u.push(`kısa geçmiş: ${x.wkP} haftalık veri`);
    {
      const e = series.get(x.r.retailer + "|" + x.r.product_key);
      const W = weeksOf[x.r.retailer] || [];
      if (e && W.length >= 2) {
        const son = e.stokByW.get(W[W.length - 1]),
          once = e.stokByW.get(W[W.length - 2]);
        if (
          son != null &&
          once != null &&
          once > 0 &&
          son > 2.5 * once &&
          son - once > 200
        )
          u.push(
            `son haftanın stoğu sivri (${Math.round(once)} → ${Math.round(son)}) — depo/yükleme hatası olabilir`,
          );
      }
    }
    if (u.length) {
      r.uyari = u;
      uyariliSatir++;
      for (const m of u) {
        // Tür adı SABİT: mesaj satıra özgü sayılar taşıyor, ondan kesilen ad her
        // satırda farklı olurdu.
        const tur = m.startsWith("fiyat")
          ? "fiyat şüpheli"
          : m.startsWith("sevk")
            ? "uzun sevk"
            : m.startsWith("ağın")
              ? "ağ kıt"
              : m.startsWith("kısa")
                ? "kısa geçmiş"
                : m.startsWith("son haftanın")
                  ? "sivri stok"
                  : "diğer";
        uyariSay[tur] = (uyariSay[tur] ?? 0) + 1;
      }
    }
  }

  // ═══ BU HAFTA YAPILACAKLAR (2026-10-29) ═══
  // Ekran "ne yapmalıyız"ı bağırmıyordu: 592 satırın 552'si çekti, 7 sevk yığının
  // içindeydi ve sıralama raf değerineydi. Liste artık aciliyet + 8 haftalık NET
  // etkiye göre sıralı, en fazla BU_HAFTA_N madde; her madde tek fiil + adet + son tarih.
  // Etkisi 0 olan (fiyatsız) satırlar listeye girmez, tabloda kalır.
  // Ekranda ve mailde okunan metin: ondalık virgülle (tr-TR), "492.7" değil "492,7".
  const sayiTr = (n: number) =>
    n.toLocaleString("tr-TR", { maximumFractionDigits: 1 });
  const gerekceOf = (r: any): string => {
    if (r.rafMagazaBasi != null && r.rafPayi != null && r.rafPayi < 0.94) {
      return `mağaza başına ${sayiTr(r.rafMagazaBasi)} adet kaldı · kaçan satış ~%${Math.round((1 - r.rafPayi) * 100)}`;
    }
    if (r.stock <= 0) return "tükendi, satıyor";
    return `${r.coverage ?? "?"} haftalık stok · haftada ${sayiTr(r.trendHiz ?? r.velocity)} satıyor`;
  };
  // ACİLİYET KOVASI: son tarih bu hafta (≤7 gün) → 0, gelecek hafta (≤14) → 1;
  // daha ileridekiler listeye girmez (sipariş önerisinde durur). Kova içinde etki.
  const kovaOf = (r: any) => {
    if (!r.sonTarih) return 9;
    const gun = (Date.parse(r.sonTarih) - Date.parse(veri.asOf)) / 864e5;
    return gun <= 7 ? 0 : gun <= 14 ? 1 : 9;
  };
  // AYNI İHTİYAÇ TEK MADDE: bir kanalın ihtiyacı kısmen başka kanalın fazlasıyla
  // (AKTAR) kısmen depodan (GÖNDER) karşılanıyorsa ekipte iki ayrı iş gibi
  // okunuyordu (29.10: D&R Hileli 240 aktar + 204 gönder). Hedef (kanal, barkod)
  // başına birleştirilir; etki toplanabilir çünkü sevk etkisi transferin üstüne
  // eklenen değer olarak hesaplandı.
  const isler = new Map<string, any>();
  for (const r of routes) {
    const sevkMi = r.action === "SEVK" || r.action === "DAĞIT";
    if (!(sevkMi || (r.action === "TRANSFER" && r.dest))) continue;
    const hedef = sevkMi ? r.retailer : r.dest.retailer;
    const key = hedef + "|" + (r.barkod || r.sku_name);
    const is = isler.get(key) ?? {
      hedef,
      sevk: null as any,
      aktar: [] as any[],
    };
    if (sevkMi) is.sevk = r;
    else is.aktar.push(r);
    isler.set(key, is);
  }
  const buHafta = [...isler.values()]
    .map((is) => {
      const ana = is.sevk ?? is.aktar[0];
      const aktarAdet = is.aktar.reduce(
        (t: number, r: any) => t + r.dest.qty,
        0,
      );
      const etki8 =
        (is.sevk?.etki8 ?? 0) +
        is.aktar.reduce((t: number, r: any) => t + (r.etki8 ?? 0), 0);
      // Son tarih ve hedefteki raf durumu: sevk satırı varsa o (hedefin kendi
      // satırı), yoksa transfer satırının taşıdığı hedef son tarihi.
      const sonTarih = is.sevk?.sonTarih ?? ana.sonTarih ?? null;
      return {
        is,
        ana,
        aktarAdet,
        etki8,
        sonTarih,
        kova: kovaOf({ sonTarih }),
      };
    })
    .filter((x) => x.etki8 >= BU_HAFTA_MIN && x.kova <= 1)
    .sort((a, b) => a.kova - b.kova || b.etki8 - a.etki8)
    .slice(0, BU_HAFTA_N)
    .map((x, i) => {
      const s = x.is.sevk;
      const kaynaklar = x.is.aktar.map(
        (r: any) => `${r.retailer} fazlasından ${fmtAdet(r.dest.qty)} adet`,
      );
      // D&R deposundan dağıtılacak pay (SEVK'te kısmi, DAĞIT'ta tamamı).
      const dagit = s?.dagit ?? 0;
      if (dagit > 0 && s?.action === "SEVK")
        kaynaklar.push(`D&R deposundan ${fmtAdet(dagit)} adet daha`);
      return {
        sira: i + 1,
        fiil: s ? (s.action === "DAĞIT" ? "DAĞIT" : "GÖNDER") : "AKTAR",
        retailer: x.is.hedef,
        kaynak: x.is.aktar.length
          ? x.is.aktar.map((r: any) => r.retailer).join(", ")
          : null,
        sku_name: s?.sku_name ?? x.ana.sku_name,
        barkod: x.ana.barkod,
        qty: (s?.qty ?? 0) + x.aktarAdet,
        aktarAdet: x.aktarAdet,
        dagit,
        etki8: x.etki8,
        kayipHf: s?.kayipHf ?? null,
        sonTarih: x.sonTarih,
        buHaftaMi: x.kova === 0,
        rafMagazaBasi: s?.rafMagazaBasi ?? null,
        uyari: [
          ...(s?.uyari ?? []),
          ...x.is.aktar.flatMap((r: any) => r.uyari ?? []),
        ],
        rafPayi: s?.rafPayi ?? null,
        coverage: s?.coverage ?? null,
        // Çekince yalnız D&R deposu BİLİNMİYORSA (aynı haftanın depo verisi yok).
        depoNotu: !!s && x.is.hedef === "DR" && depoHaftasi == null,
        gerekce: [
          s ? gerekceOf(s) : `${x.is.hedef}'da ihtiyaç`,
          ...kaynaklar,
        ].join(" · "),
      };
    });
  // Kanal başına sipariş önerisi: alıcıya gidecek liste (etkiye göre sıralı).
  const siparisOnerisi = [...new Set(sevkR.map((r) => r.retailer as string))]
    .map((ret) => {
      const a = sevkR
        .filter((r) => r.retailer === ret)
        .sort((x, y) => (y.etki8 ?? 0) - (x.etki8 ?? 0));
      return {
        retailer: ret,
        n: a.length,
        qty: a.reduce((t, r) => t + r.qty, 0),
        etki8: a.reduce((t, r) => t + (r.etki8 ?? 0), 0),
        satirlar: a.map((r) => ({
          sku_name: r.sku_name,
          barkod: r.barkod,
          qty: r.qty,
          etki8: r.etki8 ?? 0,
          sonTarih: r.sonTarih ?? null,
        })),
      };
    })
    .sort((a, b) => b.etki8 - a.etki8);
  // Sipariş gelirse AZALTILACAKLAR: satan ama ufuk kadar ya da fazla stoğu olan
  // ürünler (sipariş kontrolünde ilk bakılacak liste). Raf değeri büyükten küçüğe.
  const ufukHf = Math.round(TUT_UFKU * mult);
  const sevkYapma = [...new Set(routes.map((r) => r.retailer as string))]
    .map((ret) => ({
      retailer: ret,
      satirlar: routes
        .filter(
          (r) =>
            r.retailer === ret &&
            r.velocity >= DEAD &&
            r.coverage != null &&
            r.coverage >= ufukHf &&
            (r.action === "ERIT" ||
              r.action === "DEPO" ||
              r.action === "TRANSFER"),
        )
        .sort((a, b) => b.stock * b.psf - a.stock * a.psf)
        .slice(0, 8)
        .map((r) => ({
          sku_name: r.sku_name,
          barkod: r.barkod,
          stock: r.stock,
          coverage: r.coverage,
        })),
    }))
    .filter((x) => x.satirlar.length);
  // İnce raf: mağaza verisi olan kanalda satan ve rafı asgarinin altındaki kalemler.
  const inceR = recs.filter(
    (x) => x.v >= DEAD && x.stock > 0 && rafIncemi(x) && x.intent !== "bayat",
  );
  Object.assign(summary, {
    buHafta,
    // Hangi haftanın D&R deposu kullanıldı (null = bilinmiyor; SQL ya da veri yok).
    // Adı `depo` DEĞİL: summary.depo = DEPO aksiyonunun {n, psf}'i (yukarıda);
    // 29.10'da aynı adla eklenince /yonlendirme'deki ÇEK → DEPO kartı boş kaldı.
    kanalDepo: { haftasi: depoHaftasi, kalem: depoOf.size },
    denetim: {
      satir: routes.length,
      uyarili: uyariliSatir,
      turler: uyariSay,
      // Fiyatı faturadan gelen kalem (D&R; tablo yoksa 0).
      faturaFiyatli: recs.filter((x) => x.fiyatFatura).length,
    },
    siparisOnerisi,
    sevkYapma,
    raf: {
      asgari: RAF_ASGARI[mode] ?? 4,
      ufukHf,
      inceN: inceR.length,
      inceKayipHf: Math.round(inceR.reduce((t, x) => t + kayipHfOf(x), 0)),
      etkiUfku: ETKI_UFKU,
      buHaftaEtki8: buHafta.reduce((t, b) => t + (b.etki8 ?? 0), 0),
    },
  });

  // ASKIDA en üstte: "önce rapor" işi, para kararlarının önüne geçer.
  const ord: Record<string, number> = {
    ASKIDA: 0,
    LIKIDASYON: 1,
    TRANSFER: 2,
    DEPO: 3,
    ERIT: 4,
    SEVK: 5,
    TEYİT: 6,
    İZLE: 7,
  };
  routes.sort(
    (a, b) =>
      (ord[a.action] ?? 9) - (ord[b.action] ?? 9) ||
      b.value - a.value ||
      b.qty - a.qty,
  );
  // ── TÜM ÜRÜNLER (sipariş kontrolü için) ──
  // `routes` yalnız aksiyon üreten satırları taşır; aksiyonsuz ("tut") ürün orada
  // yok. Sipariş kontrolü o ürünü bulamayınca adla en yakına düşüyordu (29.10:
  // D&R FB Pulse siparişi BJK Pulse'a eşlendi). Kanalın bütün ürünleri burada,
  // kontrolün okuduğu alanlarla. Yalnız tam yanıtta (slim'de yok).
  const aksiyonOf = new Map(
    routes.map((r) => [r.retailer + "|" + r.sku_name, r.action as string]),
  );
  const urunler = recs
    .filter((x) => x.intent !== "bayat")
    .map((x) => ({
      retailer: x.r.retailer,
      sku_name: x.r.sku_name,
      barkod: x.r.barkod || "",
      season: x.sea,
      stock: x.stock,
      velocity: r1(x.v),
      target: x.target,
      action: aksiyonOf.get(x.r.retailer + "|" + x.r.sku_name) ?? "TUT",
      talep: r1(x.d),
      ...(x.dUst > x.d + 0.05 ? { talepUst: r1(x.dUst) } : {}),
      rafEsik: x.P,
      magaza: x.magaza,
      ...(x.r.retailer === "DR" && depoOf.has(x.r.product_key)
        ? {
            depo: Math.round(
              depoOf.get(x.r.product_key)!.offline +
                depoOf.get(x.r.product_key)!.web,
            ),
          }
        : {}),
    }));
  return { mode, summary, routes, urunler };
}

// ── slim=1 ──
// Ana sayfanın BANT 3'ü kova başına en fazla 5 satır basıyor; tam yanıt 604 satır
// ve 301 KB (ölçüldü). Bu yüzden slim yanıt kova başına 6 satır (bir satır elenirse
// diye 1 yedek) ve satır başına yalnız o bandın okuduğu alanları taşır.
// ÖLÇÜLEN BOYUT: 11.875 bayt (5 kova × ≤6 satır = 24 satır + tam summary).
// Önceki not 6.095 bayt diyordu; o ölçüm ASKIDA ve ERİT kovaları eklenmeden
// öncesine aitti. Bir sonraki kova eklenirken bütçe bu güncel sayıdan hesaplanmalı.
// `summary` HER ZAMAN TAM döner — hüküm merdiveni onu kullanıyor.
const SLIM_N = 6;
const SLIM_FIELDS = [
  "retailer",
  "sku_name",
  "barkod",
  "action",
  "qty",
  "value",
  "coverage",
  "velocity",
  "target",
  "reason",
  "dest",
  "noPrice",
  "stale",
  "last_seen",
  // Veri yaşı ve kapı alanları: ana sayfa BANT 0/BANT 3 bunları okuyor.
  "dataWeek",
  "gecikmeHf",
  "qtyHam",
  "sevkUst",
  "askidaFiil",
  "kapi",
  "trendHiz",
  // Raf varlığı ve etki: ana sayfa SEVK grubunu etkiye göre sıralıyor.
  "etki8",
  "kayipHf",
  "sonTarih",
  "rafMagazaBasi",
] as const;
const CEK_ACT = new Set(["TRANSFER", "DEPO", "LIKIDASYON"]);
// BİLGİ TAŞIMAYAN BOŞ ALAN SERİLEŞMEZ — /api/stock'un kalıbı ("Bayrak yalnız true
// iken serileşir"). Ölçüldü: `dest:null` (16 satır), `noPrice:false` (18),
// `coverage:null` + `velocity:0` (6 bayat satır) toplam 690 bayt, yani slim
// yanıtın %10'u; bu kırpma olmadan 6.798 bayt (6,64 KB), kırpmayla 6.095 bayt (5,95 KB).
// `qty`, `value` ve `target` LİSTEDE DEĞİL: SEVK satırında `value: 0` ("sevk
// sermaye serbest bırakmaz") gerçek bir bilgidir, atlanırsa istemci NaN basar.
// `dataWeek` ve `gecikmeHf` LİSTEDE DEĞİL: `gecikmeHf: 0` gerçek bir bilgi
// ("bu firma güncel"), atlanırsa istemci yokluğu 99 sanabilir.
const SLIM_OMIT_EMPTY = new Set([
  "barkod",
  "coverage",
  "velocity",
  "dest",
  "noPrice",
  "stale",
  "last_seen",
  "qtyHam",
  "sevkUst",
  "askidaFiil",
  "kapi",
  "kayipHf",
  "sonTarih",
  "rafMagazaBasi",
]);
function slimOf(full: any) {
  const rs: any[] = full.routes ?? [];
  const pick = (r: any) => {
    const o: any = {};
    for (const f of SLIM_FIELDS) {
      const v = r[f];
      if (v === undefined) continue;
      if (
        SLIM_OMIT_EMPTY.has(f) &&
        (v === null || v === false || v === 0 || v === "")
      )
        continue;
      o[f] = v;
    }
    return o;
  };
  // TEYİT: raf değeri (brüt) büyüklüğüne göre.
  const teyit = rs
    .filter((r) => r.action === "TEYİT")
    .sort((a, b) => b.value - a.value);
  // SEVK: önce KRİTİK olanlar (kapsam ≤2 hf ya da tükenmiş), sonra haftalık kayıp
  // büyüklüğü (hız × PSF) — adet veya raf değeri değil. Ölçtüm: bu sıralamanın ilk
  // üçü ile adet sıralamasının ilk üçü AYNI üç kalem (DR 11.315 · Toyzz 3.861 ·
  // DR 3.124), yani istemci hangi ölçütle yeniden sıralarsa sıralasın aynı satırlar.
  const kr = (r: any) =>
    r.stock <= 0 || (r.coverage != null && r.coverage <= 2) ? 1 : 0;
  // 2026-10-29: önce 8 haftalık NET etki (raf eğrisiyle); eşitlikte eski ölçüt.
  const sevk = rs
    .filter((r) => r.action === "SEVK")
    .sort(
      (a, b) =>
        (b.etki8 ?? 0) - (a.etki8 ?? 0) ||
        kr(b) - kr(a) ||
        b.velocity * b.psf - a.velocity * a.psf,
    );
  // ÇEK: üç aksiyon tek listede, raf değerine göre (global sıra aksiyon önceliğine
  // göre olduğu için burada yeniden sıralanmalı).
  const cek = rs
    .filter((r) => CEK_ACT.has(r.action))
    .sort((a, b) => b.value - a.value);
  // ASKIDA ve ERİT KENDİ KOVALARINDA. İkisinin de `value`'su 0 olduğu için
  // değere göre sıralanan bir listenin dibinde kalıyorlardı — yani ana sayfaya
  // hiç ulaşmazlar ve "likidasyon 239 → 198" düşüşü ekranda gerekçesiz görünürdü.
  const askida = rs
    .filter((r) => r.action === "ASKIDA")
    .sort((a, b) => (b.valueHam || 0) - (a.valueHam || 0));
  const erit = rs
    .filter((r) => r.action === "ERIT")
    .sort((a, b) => (b.eritNet || 0) - (a.eritNet || 0));
  return {
    mode: full.mode,
    slim: true,
    summary: full.summary,
    routes: [
      ...askida.slice(0, SLIM_N),
      ...teyit.slice(0, SLIM_N),
      ...sevk.slice(0, SLIM_N),
      ...cek.slice(0, SLIM_N),
      ...erit.slice(0, SLIM_N),
    ].map(pick),
  };
}

export async function GET(req: NextRequest) {
  const sp = new URL(req.url).searchParams;
  // BİLİNMEYEN MOD SESSİZCE GEÇMESİN. Bugün MODE_MULT[bilinmeyen] ?? 1.0 denge
  // ile aynı sayıyı veriyor, ama çarpanlar ayrıştığı gün yazım hatası sessiz bir
  // sapmaya dönüşürdü. Ayrıca önbellek anahtarı sabitlenmiş olur.
  const modeRaw = (sp.get("mode") || "denge").toLowerCase();
  const mode = modeRaw in MODE_MULT ? modeRaw : "denge";
  const slim = sp.get("slim") === "1";
  const fresh = sp.get("fresh") === "1";
  // `?asOf=YYYY-MM-DD` YALNIZ ÜRETİM DIŞINDA: kademe/askı davranışının takvim
  // ilerlediğinde ne yaptığı betikle ölçülebilsin (aksi halde "beş firma da
  // dursa skor düşüyor mu" sorusu canlı uçta test edilemez). Üretimde yok
  // sayılır — sunucu tarihi tek kaynak.
  const asOfParam =
    process.env.NODE_ENV !== "production" ? sp.get("asOf") : null;
  const asOfDate =
    asOfParam && /^\d{4}-\d{2}-\d{2}$/.test(asOfParam)
      ? new Date(asOfParam + "T12:00:00Z")
      : new Date();
  try {
    // ÖNBELLEK ANAHTARI VERİ SÜRÜMÜNÜ TAŞIR. Eskiden yalnız `mode` idi: yeni bir
    // hafta yüklendikten sonra 300 sn boyunca eski gecikmeler ve "ASKIDA"
    // satırları servis ediliyordu. Sürüm ucuz sorgudan (5 firma × ~40 hafta)
    // build'den ÖNCE okunuyor, çünkü önbellek build'den önce aranıyor.
    const veri = await veriSurumu(asOfDate);
    const key = mode + "|" + veri.takvimHaftasi + "|" + veri.dataVersion;
    const hit = memo.get(key);
    let full =
      !fresh && hit && Date.now() - hit.at < MEMO_TTL ? hit.payload : null;
    if (!full) {
      full = await build(mode, veri);
      memo.set(key, { at: Date.now(), payload: full });
      // Anahtar veri sürümü taşıdığı için eski sürümler birikir; süresi geçmiş
      // girdiler temizlenmezse süreç belleğinde kalıcı olarak durur.
      for (const [k, v] of memo)
        if (Date.now() - v.at > MEMO_TTL) memo.delete(k);
    }
    return NextResponse.json(slim ? slimOf(full) : full);
  } catch (e: any) {
    console.error("routing hatası:", e);
    return NextResponse.json({ error: "Sunucu hatası" }, { status: 500 });
  }
}
