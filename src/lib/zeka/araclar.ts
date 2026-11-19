// CORTEX ANALİSTİ — ARAÇLAR (yalnız okuma).
//
// Analist (lib/zeka/ajan.ts) bir soruyu bu araçlarla araştırır. Her araç
// mevcut hesap katmanını kullanır: haftalık özet matview'leri, aile/sezon
// sınıflandırması (urun-ailesi), geçen yıl arşivi (arsiv), yönlendirme motoru
// ve nakit takvimi. Hiçbiri yazmaz; hiçbiri yeni bir iş kuralı getirmez —
// kuralların çıktısı analistin baktığı KANITLARDAN biridir, kararın kendisi değil.
//
// Çıktılar kompakt JSON: model her sayıyı buradan okur, uydurmaz. Büyük
// listeler `limit` ile kesilir; aşırı uzun çıktı en sonda budanır.
import { NextRequest } from "next/server";
import type Anthropic from "@anthropic-ai/sdk";
import { supabase, fetchAllRows } from "@/lib/supabase";
import { netFactor } from "@/lib/margins";
import {
  aile,
  takim,
  sezon,
  oncekiSezon,
  karsilikAnahtari,
  katla,
  AILE_ADLARI,
} from "@/lib/urun-ailesi";
import {
  haftaSatirlari,
  gecenYilHaftasi,
  haftaKaydir,
  ARSIV,
  type YilSatiri,
} from "@/lib/arsiv";
import { sonTamamlanmisHafta } from "@/lib/compute";
import { KANALLAR, kanalAdi } from "@/lib/kanal";
import { GET as routingGET } from "@/app/api/routing/route";
import { GET as cashflowGET } from "@/app/api/cashflow/route";
import { siparisKontrol, HUKUM_AD } from "@/lib/siparis-kontrol";

// Elle tutulan veri notları: kod ve veri tabanından çıkarılamayan, ama yanlış
// yorumu önleyen bilgiler. Yeni bir veri tuhaflığı keşfedilince BURAYA eklenir.
const VERI_NOTLARI = [
  "Stok hafta sonu fotoğrafıdır; haftalar arasında toplanmaz. Satış hafta toplamıdır.",
  "Firmalar raporlarını 1-2 hafta gecikmeyle ve farklı günlerde gönderir. Bir firmanın verisi olmayan hafta 'satış yok' değil 'rapor yok' demektir; kıyaslar yalnız iki dönemde de raporu olan firmalarla yapılmalı.",
  "Net kazanç = raf fiyatı × (1 − kanal marjı) / 1,20. Marjlar: Toyzz %50, D&R %47, Armağan %47, Huppaluppo %45, Nezih %43. Araçlardaki 'net' alanı budur.",
  "D&R'ın Nisan 2026'dan beri gelen raporlarında fiyat yok; bu haftaların D&R cirosu, o haftaya kadar kesilen son Turkuvaz faturasının net fiyatından hesaplanır (D&R'da net kazanç = faturadaki fiyat). Faturası olmayan eski ürünlerde diğer kanalların raf fiyatından tahmin edilir. Aralık 2025 – Mart 2026 D&R haftaları mağaza dosyasındaki gerçek satış tutarıdır. 29 Ekim 2026'da D&R'daki KDV çift düşümü düzeltildi ve fiyatsız haftalar faturadan (FIFO) fiyatlandı; bu tarihten önce alınmış D&R TL rakamları toplamda ~%12 düşüktü (Aralık 2025 – Mart 2026 haftalarında ~%17).",
  "D&R'ın 21 Eylül 2026 haftası Asepto formatıyla yüklendi ve stoğa depo da dahil (~11-12 bin şişik). O haftanın D&R stoğuyla kıyas yapma; 'Satin Alma - Kategori' formatlı haftalar yalnız mağaza stoğudur.",
  "Armağan'ın 14 ve 21 Eylül 2026 haftaları eksik. Armağan stoğunda depo lokasyonu (TOPKAPI MERKEZ DEPO) da var; eksi stoklar 0'a çekilir.",
  "Nezih stoğu biten ürünü raporlamaz; rapor biçimi haftadan haftaya değişebilir. 21 Eylül 2026 haftasında satmayan 38 ürünün stoğu bir önceki haftadan taşındı.",
  "Kucho 10 Süper Sıradan Kart (Toyzz): 5 Ekim 2026 haftasında stok 5.093'ten 19.223'e çıktı (~14 bin adet giriş), satış haftada ~10 adet. Sevk mi veri hatası mı henüz teyit edilmedi; bu ürünle ilgili TL hesaplarında bunu belirt.",
  "Toyzz çoğu hafta barkodsuz gönderir; barkod Kalem Kodu + ad eşleşmesiyle işlenir (~%93 kapsar).",
  "Sezonluk ürünler (Pre-Season, Sezon Kartları, First, Champions Edition, Match Attax vb.) her sezon yeni barkodla gelir. Yıl kıyası aile + takım + sezon karşılığıyla yapılır (26/27 ↔ 25/26).",
  "Geçen yıl verisi şimdilik yalnız Toyzz ve D&R için, 1 Eylül – 5 Ekim 2025 haftaları (arşiv). Aralık 2026'dan itibaren CORTEX'in kendi geçen yılı oluşur.",
  "Giriş (sevk) tahmini = bu haftanın stoğu − geçen haftanın stoğu + bu haftanın satışı. Eksi değer iade/sayım düzeltmesidir.",
  // Doğrulanmış ticari bağlam (2026-10, veriden ve fiyat listesinden):
  "Pre-Season lansmanı: 2025'te 25/26 Toyzz'a 1 Eylül 2025 haftasında ~90 bin adetle girdi ve satış aynı hafta başladı (o hafta 188 adet, ikinci hafta 1.739); D&R'da da 1 Eylül haftasında raftaydı. 2026'da 26/27 Toyzz'a 14 Eylül haftasında ~19 bin adetle girdi, ilk satış 21 Eylül haftası; D&R'da 14 Eylül haftası. Yani bu yıl lansman 2-3 hafta geç ve stok derinliği geçen yılın ~beşte biri. Takvim haftası kıyası ile lansman haftasına hizalı kıyas farklı sonuç verir; ikisini de söyle.",
  "Pre-Season raf fiyatı 25/26'da 99,99 TL, 26/27'de 159,99 TL (+%60). Adet başı net kazancın artması fiyattandır; TL kıyası adetten iyimser görünür.",
];

const num = (v: unknown) => Number(v) || 0;
const yuz = (a: number, b: number) =>
  b ? Math.round(((a - b) / b) * 1000) / 10 : null;
const r0 = (n: number) => Math.round(n);

type OzetSatiri = {
  retailer: string;
  week_start: string;
  sales_qty: number;
  sales_value: number | null;
  stock_qty: number;
  sku_count: number;
};

// Bir analiz koşusu boyunca paylaşılan önbellek: aynı haftayı ya da özeti
// araçlar arasında tekrar tekrar okumamak için.
export class Baglam {
  private ozetP: Promise<OzetSatiri[]> | null = null;
  private haftaP = new Map<string, Promise<YilSatiri[]>>();

  ozet(): Promise<OzetSatiri[]> {
    this.ozetP ??= fetchAllRows<OzetSatiri>(
      (from, to) =>
        supabase
          .from("weekly_summary")
          .select(
            "retailer, week_start, sales_qty, sales_value, stock_qty, sku_count",
          )
          .order("week_start")
          .order("retailer")
          .range(from, to),
      { label: "zeka özet" },
    ).then((rows) =>
      rows.map((r) => ({
        ...r,
        sales_qty: num(r.sales_qty),
        stock_qty: num(r.stock_qty),
        sku_count: num(r.sku_count),
        sales_value: r.sales_value == null ? null : num(r.sales_value),
      })),
    );
    return this.ozetP;
  }

  /** Bir haftanın ürün satırları (canlı + gerekirse arşiv). */
  hafta(week: string): Promise<YilSatiri[]> {
    let p = this.haftaP.get(week);
    if (!p) {
      p = haftaSatirlari(supabase, [week]);
      this.haftaP.set(week, p);
    }
    return p;
  }

  async haftalar(): Promise<string[]> {
    return [...new Set((await this.ozet()).map((r) => r.week_start))].sort();
  }

  /** Verilen hafta yoksa en yeni hafta. */
  async haftaSec(
    istenen?: string | null,
  ): Promise<{ hafta: string; uyari?: string }> {
    const hs = await this.haftalar();
    const son = hs[hs.length - 1];
    if (!istenen) return { hafta: son };
    if (hs.includes(istenen)) return { hafta: istenen };
    return {
      hafta: son,
      uyari: `${istenen} haftası için veri yok; en yeni hafta (${son}) kullanıldı. Mevcut son haftalar: ${hs.slice(-8).join(", ")}`,
    };
  }
}

const netOf = (r: { retailer: string; sales_value: number | null }) =>
  (r.sales_value ?? 0) * netFactor(r.retailer);
// Aile adı noktalama/boşluk/harf farkından bağımsız: "pre season", "Pre-Season", "PRESEASON" aynı.
const sade = (s: string) => katla(s).replace(/[^A-Z0-9]/g, "");
function aileBul(istenen: unknown): string {
  const q = sade(String(istenen ?? ""));
  const ad =
    AILE_ADLARI.find((a) => sade(a) === q) ??
    (q.length >= 3 ? AILE_ADLARI.find((a) => sade(a).includes(q)) : undefined);
  if (!ad)
    throw new Error(
      `Bilinmeyen aile "${String(istenen ?? "")}". Geçerli aileler: ${AILE_ADLARI.join(", ")}`,
    );
  return ad;
}
const urunAnahtari = (r: { barkod: string | null; sku_name: string }) =>
  r.barkod || "AD:" + r.sku_name;
const kanalKodu = (girdi: unknown): string | null => {
  if (!girdi || typeof girdi !== "string") return null;
  const f = katla(girdi).replace(/[^A-Z]/g, "");
  return (
    KANALLAR.find(
      (k) =>
        katla(k).replace(/[^A-Z]/g, "") === f ||
        katla(kanalAdi(k)).replace(/[^A-Z]/g, "") === f,
    ) ?? null
  );
};

// ── Araç uygulamaları ────────────────────────────────────────────────────────

async function veriDurumu(b: Baglam) {
  const oz = await b.ozet();
  const takvim = sonTamamlanmisHafta(new Date());
  const son12 = Array.from({ length: 12 }, (_, i) =>
    haftaKaydir(takvim, -7 * (11 - i)),
  );
  const firmalar = KANALLAR.map((k) => {
    const hs = oz
      .filter((r) => r.retailer === k)
      .map((r) => r.week_start)
      .sort();
    const set = new Set(hs);
    return {
      firma: kanalAdi(k),
      ilkHafta: hs[0] ?? null,
      sonHafta: hs[hs.length - 1] ?? null,
      haftaSayisi: hs.length,
      son12HaftadaEksik: son12.filter(
        (h) => !set.has(h) && (!hs[0] || h >= hs[0]),
      ),
    };
  });
  let arsiv: Record<string, string[]> = {};
  try {
    const rows = await fetchAllRows<{ retailer: string; week_start: string }>(
      (from, to) =>
        supabase
          .from(ARSIV)
          .select("retailer, week_start")
          .order("retailer")
          .order("week_start")
          .order("id")
          .range(from, to),
      { label: "zeka arşiv" },
    );
    for (const r of rows)
      (arsiv[r.retailer] ??= []).includes(r.week_start) ||
        arsiv[r.retailer].push(r.week_start);
  } catch {
    arsiv = {};
  }
  return {
    bugun: new Date().toISOString().slice(0, 10),
    sonTamamlanmisTakvimHaftasi: takvim,
    firmalar,
    gecenYilArsivi: arsiv,
    notlar: VERI_NOTLARI,
  };
}

async function haftaOzeti(b: Baglam, girdi: { hafta?: string }) {
  const { hafta, uyari } = await b.haftaSec(girdi.hafta);
  const once = haftaKaydir(hafta, -7);
  const oz = await b.ozet();
  const satir = (k: string, h: string) =>
    oz.find((r) => r.retailer === k && r.week_start === h);
  const firmalar = KANALLAR.map((k) => {
    const s = satir(k, hafta),
      o = satir(k, once);
    const t = (x?: OzetSatiri) =>
      x
        ? {
            adet: x.sales_qty,
            net: r0(netOf(x)),
            stok: x.stock_qty,
            urunSayisi: x.sku_count,
          }
        : null;
    return {
      firma: kanalAdi(k),
      bu: t(s),
      onceki: t(o),
      adetDegisimYuzde: s && o ? yuz(s.sales_qty, o.sales_qty) : null,
      netDegisimYuzde: s && o ? yuz(netOf(s), netOf(o)) : null,
    };
  });
  const kohort = KANALLAR.filter((k) => satir(k, hafta) && satir(k, once));
  const top = (h: string, ks: string[]) =>
    ks.reduce(
      (t, k) => {
        const s = satir(k, h)!;
        return { adet: t.adet + s.sales_qty, net: t.net + netOf(s) };
      },
      { adet: 0, net: 0 },
    );
  const tum = KANALLAR.filter((k) => satir(k, hafta));
  const kb = top(hafta, kohort),
    ko = top(once, kohort),
    ta = top(hafta, tum);
  return {
    hafta,
    oncekiHafta: once,
    uyari,
    ag: { raporlayanFirma: tum.map(kanalAdi), adet: ta.adet, net: r0(ta.net) },
    haftalikDegisim: {
      kohort: kohort.map(kanalAdi),
      adetYuzde: yuz(kb.adet, ko.adet),
      netYuzde: yuz(kb.net, ko.net),
      not: "Yalnız iki haftada da raporu olan firmalar.",
    },
    firmalar,
  };
}

async function enCokSatanlar(
  b: Baglam,
  girdi: { hafta?: string; olcut?: string; kanal?: string; limit?: number },
) {
  const { hafta, uyari } = await b.haftaSec(girdi.hafta);
  const once = haftaKaydir(hafta, -7);
  const kanal = kanalKodu(girdi.kanal);
  const limit = Math.min(Math.max(num(girdi.limit) || 15, 1), 40);
  const olcut = ["adet", "net", "artis", "dusus", "stok"].includes(
    String(girdi.olcut),
  )
    ? String(girdi.olcut)
    : "adet";
  const [bu, on] = await Promise.all([b.hafta(hafta), b.hafta(once)]);
  const kanallarOnce = new Set(on.map((r) => r.retailer));
  const m = new Map<
    string,
    {
      ad: string;
      barkod: string | null;
      adet: number;
      net: number;
      stok: number;
      oncekiAdet: number;
      kanal: Record<string, number>;
    }
  >();
  for (const r of bu) {
    if (kanal && r.retailer !== kanal) continue;
    const k = urunAnahtari(r);
    const a = m.get(k) ?? {
      ad: r.sku_name,
      barkod: r.barkod,
      adet: 0,
      net: 0,
      stok: 0,
      oncekiAdet: 0,
      kanal: {},
    };
    a.adet += r.sales_qty;
    a.net += netOf(r);
    a.stok += r.stock_qty;
    a.kanal[kanalAdi(r.retailer)] =
      (a.kanal[kanalAdi(r.retailer)] ?? 0) + r.sales_qty;
    if (r.retailer !== "Toyzz") a.ad = r.sku_name; // Toyzz kod-adı yerine okunur ad
    m.set(k, a);
  }
  for (const r of on) {
    if (kanal && r.retailer !== kanal) continue;
    const a = m.get(urunAnahtari(r));
    if (a) a.oncekiAdet += r.sales_qty;
  }
  const sirala: Record<string, (x: any) => number> = {
    adet: (x) => -x.adet,
    net: (x) => -x.net,
    stok: (x) => -x.stok,
    artis: (x) => -(x.adet - x.oncekiAdet),
    dusus: (x) => x.adet - x.oncekiAdet,
  };
  const liste = [...m.values()]
    .sort((x, y) => sirala[olcut](x) - sirala[olcut](y))
    .slice(0, limit)
    .map((x) => ({
      ad: x.ad,
      barkod: x.barkod,
      aile: aile(x.ad),
      adet: x.adet,
      oncekiHaftaAdet: x.oncekiAdet,
      net: r0(x.net),
      stok: x.stok,
      kanalAdet: x.kanal,
    }));
  return {
    hafta,
    oncekiHafta: once,
    olcut,
    kanal: kanal ? kanalAdi(kanal) : "tümü",
    uyari,
    not: `Önceki hafta raporu olan firmalar: ${[...kanallarOnce].map(kanalAdi).join(", ") || "yok"}. Artış/düşüş yalnız bu firmalarda anlamlı.`,
    urunler: liste,
  };
}

async function urunAra(b: Baglam, girdi: { sorgu?: string }) {
  const q = String(girdi.sorgu ?? "").trim();
  if (!q) throw new Error("sorgu boş");
  const hs = await b.haftalar();
  const son = hs.slice(-6);
  const rows = (await Promise.all(son.map((h) => b.hafta(h)))).flat();
  const barkodMu = /^\d{8,14}$/.test(q);
  const parcalar = katla(q).split(/\s+/).filter(Boolean);
  const m = new Map<
    string,
    {
      barkod: string | null;
      adlar: Record<string, string>;
      sonHafta: Record<string, string>;
    }
  >();
  for (const r of rows) {
    const eslesir = barkodMu
      ? r.barkod === q
      : parcalar.every((p) => katla(r.sku_name).includes(p));
    if (!eslesir) continue;
    const k = urunAnahtari(r);
    const a = m.get(k) ?? { barkod: r.barkod, adlar: {}, sonHafta: {} };
    a.adlar[kanalAdi(r.retailer)] = r.sku_name;
    if (!a.sonHafta[r.retailer] || r.week_start > a.sonHafta[r.retailer])
      a.sonHafta[r.retailer] = r.week_start;
    m.set(k, a);
  }
  const sonuc = [...m.values()].slice(0, 25).map((a) => {
    const ad =
      Object.values(a.adlar).find((x) => !x.startsWith("ASP-")) ??
      Object.values(a.adlar)[0];
    const sonSatirlar = rows.filter(
      (r) =>
        urunAnahtari(r) === (a.barkod || "AD:" + ad) &&
        a.sonHafta[r.retailer] === r.week_start,
    );
    return {
      barkod: a.barkod,
      ad,
      kanaldakiAdlar: a.adlar,
      aile: aile(ad),
      takim: takim(ad) || null,
      sezon: sezon(ad) || null,
      sonHaftaSatis: sonSatirlar.reduce((t, r) => t + r.sales_qty, 0),
      sonStok: sonSatirlar.reduce((t, r) => t + r.stock_qty, 0),
    };
  });
  return {
    sorgu: q,
    bakilanHaftalar: son,
    bulunan: m.size,
    urunler: sonuc,
    not: m.size > 25 ? "İlk 25 gösterildi; aramayı daralt." : undefined,
  };
}

async function urunSerisi(
  b: Baglam,
  girdi: { barkod?: string; hafta_sayisi?: number },
) {
  const barkod = String(girdi.barkod ?? "").trim();
  if (!barkod) throw new Error("barkod gerekli (önce urun_ara ile bul)");
  const n = Math.min(Math.max(num(girdi.hafta_sayisi) || 12, 2), 30);
  const hs = (await b.haftalar()).slice(-n);
  const rows = await fetchAllRows<YilSatiri>(
    (from, to) =>
      supabase
        .from("sku_weekly")
        .select(
          "retailer, week_start, sku_name, barkod, sales_qty, sales_value, stock_qty",
        )
        .eq("barkod", barkod)
        .in("week_start", hs)
        .order("retailer")
        .order("week_start")
        .range(from, to),
    { label: "zeka ürün serisi" },
  );
  const oz = await b.ozet();
  const kanallar = [...new Set(rows.map((r) => r.retailer))].map((k) => {
    const raporlu = new Set(
      oz.filter((o) => o.retailer === k).map((o) => o.week_start),
    );
    const satan = rows.filter((r) => r.retailer === k && num(r.sales_qty) > 0);
    const adet = satan.reduce((t, r) => t + num(r.sales_qty), 0);
    const net = satan.reduce(
      (t, r) =>
        t +
        netOf({
          retailer: r.retailer,
          sales_value: r.sales_value == null ? null : num(r.sales_value),
        }),
      0,
    );
    return {
      firma: kanalAdi(k),
      ad: rows.find((r) => r.retailer === k)!.sku_name,
      birimNet: adet ? r0(net / adet) : null,
      seri: hs
        .filter((h) => raporlu.has(h))
        .map((h) => {
          const x = rows.filter((r) => r.retailer === k && r.week_start === h);
          return {
            hafta: h,
            adet: x.reduce((t, r) => t + num(r.sales_qty), 0),
            stok: x.reduce((t, r) => t + num(r.stock_qty), 0),
            net: r0(
              x.reduce(
                (t, r) =>
                  t +
                  netOf({
                    retailer: r.retailer,
                    sales_value:
                      r.sales_value == null ? null : num(r.sales_value),
                  }),
                0,
              ),
            ),
          };
        }),
    };
  });
  const ad = rows[0]?.sku_name ?? "";
  return {
    barkod,
    ad,
    aile: aile(ad),
    takim: takim(ad) || null,
    sezon: sezon(ad) || null,
    haftalar: hs,
    kanallar,
    not: rows.length
      ? "Raporu olmayan haftalar seride yok. Ürün o hafta listede değilse adet/stok 0 yazılır."
      : "Bu barkodla son haftalarda satır yok.",
  };
}

async function aileSerisi(
  b: Baglam,
  girdi: { aile?: string; hafta_sayisi?: number; kanal?: string },
) {
  const ad = aileBul(girdi.aile);
  const kanal = kanalKodu(girdi.kanal);
  const n = Math.min(Math.max(num(girdi.hafta_sayisi) || 8, 2), 16);
  const hs = (await b.haftalar()).slice(-n);
  const oz = await b.ozet();
  const rows = (await Promise.all(hs.map((h) => b.hafta(h))))
    .flat()
    .filter((r) => aile(r.sku_name) === ad && (!kanal || r.retailer === kanal));
  const firmalar = (kanal ? [kanal] : KANALLAR)
    .map((k) => {
      const raporlu = new Set(
        oz.filter((o) => o.retailer === k).map((o) => o.week_start),
      );
      const x = rows.filter((r) => r.retailer === k);
      if (!x.length) return null;
      return {
        firma: kanalAdi(k),
        seri: hs
          .filter((h) => raporlu.has(h))
          .map((h) => {
            const y = x.filter((r) => r.week_start === h);
            return {
              hafta: h,
              adet: y.reduce((t, r) => t + r.sales_qty, 0),
              stok: y.reduce((t, r) => t + r.stock_qty, 0),
              net: r0(y.reduce((t, r) => t + netOf(r), 0)),
            };
          }),
      };
    })
    .filter(Boolean);
  const son = hs[hs.length - 1];
  const sonRows = rows.filter((r) => r.week_start === son);
  const sezonlar: Record<string, { adet: number; stok: number }> = {};
  for (const r of sonRows) {
    const s = sezon(r.sku_name) || "sezonsuz";
    (sezonlar[s] ??= { adet: 0, stok: 0 }).adet += r.sales_qty;
    sezonlar[s].stok += r.stock_qty;
  }
  const urun = new Map<string, { ad: string; adet: number; stok: number }>();
  for (const r of sonRows) {
    const k = urunAnahtari(r);
    const a = urun.get(k) ?? { ad: r.sku_name, adet: 0, stok: 0 };
    a.adet += r.sales_qty;
    a.stok += r.stock_qty;
    urun.set(k, a);
  }
  return {
    aile: ad,
    kanal: kanal ? kanalAdi(kanal) : "tümü",
    haftalar: hs,
    firmalar,
    sonHaftaSezonKirilimi: sezonlar,
    sonHaftaEnCokSatan: [...urun.values()]
      .sort((x, y) => y.adet - x.adet)
      .slice(0, 8),
  };
}

async function gecenYil(
  b: Baglam,
  girdi: { hafta?: string; barkod?: string; aile?: string },
) {
  const { hafta, uyari } = await b.haftaSec(girdi.hafta);
  const gh = gecenYilHaftasi(hafta);
  const [bu, gy] = await Promise.all([
    b.hafta(hafta),
    haftaSatirlari(supabase, [gh]),
  ]);
  const kohort = KANALLAR.filter(
    (k) => bu.some((r) => r.retailer === k) && gy.some((r) => r.retailer === k),
  );
  const temel = {
    hafta,
    gecenYilHaftasi: gh,
    uyari,
    kohort: kohort.map(kanalAdi),
  };
  if (!kohort.length)
    return {
      ...temel,
      sonuc: "Bu hafta için geçen yıl verisi yok.",
      not: "Geçen yıl verisi arşivde yalnız Toyzz ve D&R, 1 Eyl – 5 Eki 2025 haftaları için var.",
    };
  const top = (rows: YilSatiri[]) => ({
    adet: rows.reduce((t, r) => t + r.sales_qty, 0),
    stok: rows.reduce((t, r) => t + r.stock_qty, 0),
    net: r0(rows.reduce((t, r) => t + netOf(r), 0)),
  });

  if (girdi.barkod) {
    const barkod = String(girdi.barkod).trim();
    return {
      ...temel,
      barkod,
      firmalar: kohort
        .map((k) => {
          const b0 = bu.filter((r) => r.retailer === k && r.barkod === barkod);
          if (!b0.length) return null;
          const ad = b0[0].sku_name;
          let g0 = gy.filter((r) => r.retailer === k && r.barkod === barkod);
          let karsilik = g0.length ? "aynı barkod" : null;
          const s = sezon(ad);
          if (!g0.length && s) {
            const ana = karsilikAnahtari(k, ad, oncekiSezon(s));
            g0 = gy.filter(
              (r) =>
                r.retailer === k &&
                karsilikAnahtari(r.retailer, r.sku_name) === ana,
            );
            if (g0.length)
              karsilik = `önceki sezon (${[...new Set(g0.map((r) => r.sku_name))].join(" / ")})`;
          }
          return {
            firma: kanalAdi(k),
            ad,
            karsilik,
            buYil: top(b0),
            gecenYil: g0.length ? top(g0) : null,
          };
        })
        .filter(Boolean),
    };
  }

  if (girdi.aile) {
    const ad = aileBul(girdi.aile);
    return {
      ...temel,
      aile: ad,
      firmalar: kohort.map((k) => {
        const b0 = bu.filter(
          (r) => r.retailer === k && aile(r.sku_name) === ad,
        );
        const g0 = gy.filter(
          (r) => r.retailer === k && aile(r.sku_name) === ad,
        );
        const sezonlar = b0
          .filter(
            (r) => (r.sales_qty > 0 || r.stock_qty > 0) && sezon(r.sku_name),
          )
          .map((r) => sezon(r.sku_name))
          .sort();
        const s = sezonlar[sezonlar.length - 1];
        const yeni = s
          ? {
              buSezon: s,
              gecenSezon: oncekiSezon(s),
              buYil: top(b0.filter((r) => sezon(r.sku_name) === s)),
              gecenYil: top(
                g0.filter((r) => sezon(r.sku_name) === oncekiSezon(s)),
              ),
            }
          : null;
        return {
          firma: kanalAdi(k),
          buYil: top(b0),
          gecenYil: top(g0),
          yeniSezon: yeni,
        };
      }),
    };
  }

  const aileFark = new Map<string, { bu: number; gy: number }>();
  for (const r of bu)
    if (kohort.includes(r.retailer as any)) {
      const a = aileFark.get(aile(r.sku_name)) ?? { bu: 0, gy: 0 };
      a.bu += r.sales_qty;
      aileFark.set(aile(r.sku_name), a);
    }
  for (const r of gy)
    if (kohort.includes(r.retailer as any)) {
      const a = aileFark.get(aile(r.sku_name)) ?? { bu: 0, gy: 0 };
      a.gy += r.sales_qty;
      aileFark.set(aile(r.sku_name), a);
    }
  return {
    ...temel,
    firmalar: kohort.map((k) => ({
      firma: kanalAdi(k),
      buYil: top(bu.filter((r) => r.retailer === k)),
      gecenYil: top(gy.filter((r) => r.retailer === k)),
    })),
    aileler: [...aileFark.entries()]
      .map(([a, v]) => ({
        aile: a,
        buYilAdet: v.bu,
        gecenYilAdet: v.gy,
        fark: v.bu - v.gy,
      }))
      .sort((x, y) => Math.abs(y.fark) - Math.abs(x.fark))
      .slice(0, 12),
  };
}

async function stokKapsami(
  _b: Baglam,
  girdi: { kanal?: string; durum?: string; limit?: number },
) {
  const kanal = kanalKodu(girdi.kanal);
  const durum = girdi.durum === "fazla" ? "fazla" : "az";
  const limit = Math.min(Math.max(num(girdi.limit) || 15, 1), 40);
  const rows = await fetchAllRows<any>(
    (from, to) => {
      let q = supabase
        .from("product_coverage")
        .select(
          "retailer, product_key, barkod, sku_name, weeks, avg_weekly, last_stock, coverage_weeks, psf",
        );
      if (kanal) q = q.eq("retailer", kanal);
      return q.order("retailer").order("product_key").range(from, to);
    },
    { label: "zeka kapsam" },
  );
  const x = rows.map((r) => ({
    firma: kanalAdi(r.retailer),
    ad: r.sku_name,
    barkod: r.barkod,
    haftalikOrtSatis: Math.round(num(r.avg_weekly) * 10) / 10,
    stok: num(r.last_stock),
    kapsamHafta:
      r.coverage_weeks == null
        ? null
        : Math.round(num(r.coverage_weeks) * 10) / 10,
    rafFiyati: num(r.psf),
    stokDegeriPsf: r0(num(r.last_stock) * num(r.psf)),
    veriHaftasi: num(r.weeks),
  }));
  const liste =
    durum === "az"
      ? x
          .filter(
            (r) =>
              r.haftalikOrtSatis >= 3 &&
              r.kapsamHafta != null &&
              r.kapsamHafta <= 6,
          )
          .sort((a, b) => (a.kapsamHafta ?? 0) - (b.kapsamHafta ?? 0))
      : x
          .filter(
            (r) =>
              (r.kapsamHafta != null && r.kapsamHafta >= 26) ||
              (r.haftalikOrtSatis < 0.5 && r.stok >= 100),
          )
          .sort((a, b) => b.stokDegeriPsf - a.stokDegeriPsf);
  return {
    durum,
    kanal: kanal ? kanalAdi(kanal) : "tümü",
    toplam: liste.length,
    urunler: liste.slice(0, limit),
    not: "Haftalık ortalama ürünün TÜM geçmişi üzerinden; güncel hız farklı olabilir (urun_serisi ile bak). Stok her firmanın son raporundaki değer.",
  };
}

async function yonlendirmeOnerileri(
  _b: Baglam,
  girdi: { aksiyon?: string; kanal?: string; limit?: number },
) {
  const res = await routingGET(
    new NextRequest("http://cortex.local/api/routing?mode=denge"),
  );
  const d: any = await res.json();
  if (!d?.routes) throw new Error("yönlendirme motoru yanıt vermedi");
  const kanal = kanalKodu(girdi.kanal);
  const aksiyon = String(girdi.aksiyon ?? "").toUpperCase();
  const limit = Math.min(Math.max(num(girdi.limit) || 15, 1), 40);
  const sayim: Record<string, { kalem: number; deger: number }> = {};
  for (const r of d.routes) {
    const s = (sayim[r.action] ??= { kalem: 0, deger: 0 });
    s.kalem++;
    s.deger += num(r.value);
  }
  const secili = d.routes.filter(
    (r: any) =>
      (!kanal || r.retailer === kanal) &&
      (!aksiyon || aksiyon === "HEPSI" || r.action === aksiyon),
  );
  secili.sort((a: any, b: any) =>
    aksiyon === "SEVK"
      ? num(a.coverage) - num(b.coverage)
      : num(b.value) - num(a.value),
  );
  return {
    aciklama:
      "Kural tabanlı yönlendirme motorunun önerileri (mod: denge). SEVK = Mythos'un kendi deposundan o kanala YENİ mal gönderimi (diğer kanalların stoğundan gelmez; ağdaki perakende stokla kıyaslanmaz); TRANSFER = bir kanalın fazlasını, başka kanalda ihtiyaç varsa oraya aktarma; DEPO = ölü stoğu ya da 26 haftayı aşan fazlayı kanaldan geri çekme; ERIT = hedefin üstünde ama 26 hafta içinde satarak eriyor (çekme yok, yeni sevk yok); LIKIDASYON = satmayan eski sezon; ASKIDA = veri bayat, karar bekliyor. RAF VARLIĞI: D&R (~190 mağaza) ve Armağan (~100) için ölçüldü ki ürünü taşıyan mağaza başına stok ~4 adetin altına inince satış hızla düşer (2-3 adette ~%60, 1 adette ~%10); motor bu kanallarda asgari raf = taşıması gereken mağaza × 4 tutar, ince raflı haftalarda talebi en fazla 2 katına kadar düzeltir (talep alanı). rafMagazaBasi = taşıyan mağaza başı stok; etki8 = aksiyonun 8 haftada kazandırdığı (+) ya da kaybettirdiği (−) NET satış (TL); sonTarih = en geç bu tarihte yapılmalı. Toyzz, Nezih, Huppaluppo'nun mağaza sayısı bilinmediği için orada hafta kapsamı kullanılır. Motorun hızı (haftalikHiz) son 8 haftanın ortalamasıdır; raf doluyken son 3 haftada satış belirgin düştüyse güncel hızla (guncelHiz) hesaplar. D&R DEPOSU: D&R'ın aynı haftaki depo raporu varsa motor ihtiyacın depoda olan kısmını DAĞIT (D&R kendi deposundan mağazalara dağıtsın; satırda dagit/depoStok) yazar, kalanını SEVK; depo raporu yoksa D&R sevkinde 'depoda mal varsa önce dağıtılsın' çekincesi geçerlidir. Bunlar kanıttır, kesin karar değil.",
    buHafta: (d.summary?.buHafta ?? []).map((b: any) => ({
      sira: b.sira,
      fiil: b.fiil,
      firma: kanalAdi(b.retailer),
      kaynak: b.kaynak ? kanalAdi(b.kaynak) : null,
      ad: b.sku_name,
      adet: b.qty,
      etki8Net: b.etki8,
      sonTarih: b.sonTarih,
      gerekce: b.gerekce,
    })),
    aksiyonSayilari: Object.fromEntries(
      Object.entries(sayim).map(([k, v]) => [
        k,
        { kalem: v.kalem, psfDegeri: r0(v.deger) },
      ]),
    ),
    oneriler: secili.slice(0, limit).map((r: any) => ({
      firma: kanalAdi(r.retailer),
      ad: r.sku_name,
      barkod: r.barkod,
      aksiyon: r.action,
      adet: r.qty,
      hedef: r.dest?.retailer ? kanalAdi(r.dest.retailer) : null,
      hedefeAdet: r.dest?.qty ?? null,
      depoyaAdet: r.toDepot ?? null,
      stok: r.stock,
      haftalikHiz: r.velocity,
      ...(r.trendHiz != null ? { guncelHiz: r.trendHiz } : {}),
      kapsamHafta: r.coverage,
      psfDegeri: r0(num(r.value)),
      sezon: r.season,
      segment: `${r.abc}${r.xyz}`,
      ...(r.rafMagazaBasi != null
        ? { rafMagazaBasi: r.rafMagazaBasi, magaza: r.magaza, talep: r.talep }
        : {}),
      ...(r.etki8 != null ? { etki8Net: r.etki8 } : {}),
      ...(r.sonTarih ? { sonTarih: r.sonTarih } : {}),
      // Öz-denetim: kararın dayandığı veri şüpheli (ör. fiyat) — TL'yi kesin sunma.
      ...(r.uyari?.length ? { veriUyarisi: r.uyari } : {}),
      neden: r.reason,
    })),
  };
}

// SİPARİŞ KONTROLÜ — /yonlendirme'deki aracın aynısı (lib/siparis-kontrol.ts).
// Analist "bu sipariş mantıklı mı"yı kendi tahminiyle değil motorun hedefleriyle
// cevaplasın; ekran ile sohbet aynı hükmü versin.
async function siparisKontrolArac(
  _b: Baglam,
  girdi: { kanal?: string; metin?: string },
) {
  const kanal = kanalKodu(girdi.kanal);
  if (!kanal)
    throw new Error("kanal gerekli (Toyzz, D&R, Nezih, Armağan, Huppaluppo)");
  const metin = String(girdi.metin ?? "").slice(0, 20000);
  if (!metin.trim()) throw new Error("sipariş metni boş");
  const res = await routingGET(
    new NextRequest("http://cortex.local/api/routing?mode=denge"),
  );
  const d: any = await res.json();
  if (!d?.urunler) throw new Error("yönlendirme motoru yanıt vermedi");
  const k = siparisKontrol(
    metin,
    kanal,
    d.urunler,
    d.summary?.raf?.ufukHf ?? 26,
  );
  return {
    aciklama:
      "Sipariş, yönlendirme motorunun hedefleriyle (mod: denge) satır satır değerlendirildi. Mantıklı = sipariş sonrası stok makul (≤16 hf); Fazla = 16 hf üstü ama 26 hf ufkunda; Çok fazla = iyimser talepte bile 26 hf'yi aşıyor; Az = hedefe yetmiyor. Raf inceyse talep aralık olarak verilir. D&R deposu görünmüyor: D&R'da hesap mağaza stoğuyla. Kanıttır, kesin karar değil.",
    kanal: kanalAdi(kanal),
    ozet: k.ozet,
    satirlar: k.sonuclar.map((x) => ({
      siparisSatiri: x.satir.ad || x.satir.barkod,
      urun: x.motor?.sku_name ?? null,
      barkod: x.motor?.barkod ?? x.satir.barkod,
      siparis: x.satir.adet,
      oneri: x.oneri,
      hukum: HUKUM_AD[x.hukum],
      gerekce: x.gerekce,
    })),
  };
}

// PARA NEREDE — yönlendirme motorunun çıktısını TL'ye çevirir (net kazanç).
// Üç kova: kayıp satış riski (SEVK), bağlı sermaye (DEPO/LIKIDASYON), kanal
// transferi (TRANSFER). Motorun kuralı değişmez; yalnız her satırın para
// karşılığı ve hesabın kendisi yazılır ki analist sıralayıp doğrulayabilsin.
async function paraFirsatlari(
  _b: Baglam | null,
  girdi: { kanal?: string; barkod?: string; limit?: number },
) {
  const res = await routingGET(
    new NextRequest("http://cortex.local/api/routing?mode=denge"),
  );
  const d: any = await res.json();
  if (!d?.routes) throw new Error("yönlendirme motoru yanıt vermedi");
  const kanal = kanalKodu(girdi.kanal);
  const barkod = typeof girdi.barkod === "string" ? girdi.barkod.trim() : "";
  const limit = Math.min(Math.max(num(girdi.limit) || 8, 1), 25);
  const rs = d.routes.filter(
    (r: any) =>
      (!kanal || r.retailer === kanal) && (!barkod || r.barkod === barkod),
  );
  const birimNet = (r: any) => num(r.psf) * netFactor(r.retailer);

  // KAYIP = motorun etki8'i (raf eğrisiyle 8 hf simülasyon; ekrandaki sayıyla aynı).
  // Eskiden burada ayrı bir "hız × 4 − stok" hesabı vardı ve ince rafı görmüyordu:
  // stoğu 4 haftaya yeten ama mağaza başı 2 adeti kalan ürüne 0 TL kayıp yazıyordu.
  const kayip = rs
    .filter((r: any) => r.action === "SEVK")
    .map((r: any) => {
      const v = num(r.trendHiz ?? r.velocity),
        stok = num(r.stock),
        bn = birimNet(r);
      return {
        firma: kanalAdi(r.retailer),
        ad: r.sku_name,
        barkod: r.barkod,
        oneriSevkAdet: r.qty,
        haftalikHiz: v,
        ...(r.trendHiz != null ? { sekizHaftaOrtalamasi: r.velocity } : {}),
        stok,
        kapsamHafta: r.coverage,
        ...(r.rafMagazaBasi != null
          ? {
              rafMagazaBasi: r.rafMagazaBasi,
              magaza: r.magaza,
              duzeltilmisTalep: r.talep,
            }
          : {}),
        birimNet: r0(bn),
        sekizHaftadaKacacakNet: r0(num(r.etki8)),
        sonTarih: r.sonTarih ?? null,
        hesap: `sevk edilmezse 8 haftada kaçacak net satış (raf eğrisiyle simülasyon, talep ${num(r.talep ?? v)}/hf, birim ${r0(bn)} TL)`,
      };
    })
    .sort(
      (a: any, b: any) => b.sekizHaftadaKacacakNet - a.sekizHaftadaKacacakNet,
    );

  const bagli = rs
    .filter((r: any) => r.action === "DEPO" || r.action === "LIKIDASYON")
    .map((r: any) => ({
      firma: kanalAdi(r.retailer),
      ad: r.sku_name,
      barkod: r.barkod,
      aksiyon: r.action,
      cekilecekAdet: r.qty,
      stok: r.stock,
      haftalikHiz: r.velocity,
      psfDegeri: r0(num(r.value)),
      netKarsiligi: r0(num(r.value) * netFactor(r.retailer)),
      sezon: r.season,
      neden: r.reason,
    }))
    .sort((a: any, b: any) => b.netKarsiligi - a.netKarsiligi);

  // TRANSFER satırında dest = {retailer, qty, vel}: çekilenin bir kısmı hedefe,
  // kalanı (toDepot) depoya gider; `value` çekilen toplamın PSF değeridir.
  const transfer = rs
    .filter((r: any) => r.action === "TRANSFER" && r.dest?.retailer)
    .map((r: any) => ({
      kaynak: kanalAdi(r.retailer),
      hedef: kanalAdi(r.dest.retailer),
      ad: r.sku_name,
      barkod: r.barkod,
      hedefeAdet: num(r.dest.qty),
      depoyaAdet: num(r.toDepot),
      hedefteHaftalikHiz: r.dest.vel,
      hedefteNetDeger: r0(
        num(r.dest.qty) * num(r.psf) * netFactor(r.dest.retailer),
      ),
      neden: r.reason,
    }))
    .sort((a: any, b: any) => b.hedefteNetDeger - a.hedefteNetDeger);

  const top = (xs: any[], k: string) =>
    r0(xs.reduce((t, x) => t + num(x[k]), 0));
  return {
    aciklama:
      "Motorun önerilerinin TL karşılığı (net kazanç = raf fiyatı × (1 − marj) / 1,20). Hızlar motorun son 8 hafta ortalaması; satış hızla değişiyorsa urun_serisi ile güncel haftaya bak ve TL'yi yeniden hesapla. Bağlı sermaye konsinyede bizimdir; 'netKarsiligi' o mal satılırsa bize kalacak tutardır.",
    toplam: {
      kayipSatisRiski8hf: {
        kalem: kayip.length,
        net: top(kayip, "sekizHaftadaKacacakNet"),
      },
      bagliSermaye: {
        kalem: bagli.length,
        psf: top(bagli, "psfDegeri"),
        net: top(bagli, "netKarsiligi"),
      },
      transfer: {
        kalem: transfer.length,
        hedefteNet: top(transfer, "hedefteNetDeger"),
      },
    },
    kayipSatisRiski: kayip.slice(0, limit),
    bagliSermaye: bagli.slice(0, limit),
    transfer: transfer.slice(0, limit),
  };
}

async function nakitDurumu() {
  const res = await cashflowGET();
  const d: any = await res.json();
  if (!d?.receivable) throw new Error("nakit takvimi yanıt vermedi");
  return {
    tarih: d.asOf,
    sahadakiNetAlacak: r0(d.receivable.total),
    kanallar: d.receivable.byChannel.map((c: any) => ({
      firma: kanalAdi(c.retailer),
      alacak: r0(c.amount),
      vadeGun: c.vadeDays,
    })),
    aylikTahsilat: d.months
      .slice(0, 8)
      .map((m: any) => ({ ay: m.label, tutar: r0(m.total) })),
    not: "Model: haftanın net kazancı hafta bitişi + kanal vadesi günü tahsil edilir varsayılır.",
  };
}

// ── Tanımlar ────────────────────────────────────────────────────────────────

const obj = (properties: Record<string, unknown>, required: string[] = []) => ({
  type: "object" as const,
  properties,
  required,
  additionalProperties: false,
});
const HAFTA = {
  type: "string",
  description:
    "Haftanın Pazartesi'si, YYYY-MM-DD. Boş bırakılırsa en yeni hafta.",
};
const KANAL = {
  type: "string",
  description: "Firma: Toyzz, D&R, Nezih, Armağan, Huppaluppo. Boş = hepsi.",
};

export const ARACLAR: Anthropic.Tool[] = [
  {
    name: "veri_durumu",
    description:
      "Hangi firmanın hangi haftaya kadar raporu var, eksik haftalar, geçen yıl arşivinin kapsamı ve bilinen veri tuhaflıkları. Her analize bununla başla.",
    input_schema: obj({}),
  },
  {
    name: "hafta_ozeti",
    description:
      "Bir haftanın firma bazında satış adedi, net kazanç ve stoğu; bir önceki haftayla kıyas (yalnız iki haftada da raporu olan firmalarla).",
    input_schema: obj({ hafta: HAFTA }),
  },
  {
    name: "en_cok_satanlar",
    description:
      "Bir haftada ürün sıralaması (tüm kanallar barkodla birleşik). Ölçüt: adet, net, stok, artis (geçen haftaya göre en çok artan), dusus (en çok düşen).",
    input_schema: obj({
      hafta: HAFTA,
      olcut: {
        type: "string",
        enum: ["adet", "net", "stok", "artis", "dusus"],
      },
      kanal: KANAL,
      limit: { type: "integer", description: "En fazla 40, varsayılan 15" },
    }),
  },
  {
    name: "urun_ara",
    description:
      "Ürünü adla ya da barkodla bul (son 6 hafta). Barkod, kanaldaki adları, aile, takım, sezon ve son hafta satış/stok döner.",
    input_schema: obj(
      {
        sorgu: {
          type: "string",
          description:
            "Ad parçası (ör. 'pre-season gs') ya da 8-14 haneli barkod",
        },
      },
      ["sorgu"],
    ),
  },
  {
    name: "urun_serisi",
    description:
      "Bir ürünün (barkod) firma bazında haftalık satış, stok ve net kazanç serisi.",
    input_schema: obj(
      {
        barkod: { type: "string" },
        hafta_sayisi: { type: "integer", description: "2-30, varsayılan 12" },
      },
      ["barkod"],
    ),
  },
  {
    name: "aile_serisi",
    description:
      "Bir ürün ailesinin (Pre-Season, First, Sezon Kartları, Manifest, Pokemon, UEFA ŞL Sticker / Albüm, Match Attax / Topps Kart ...) firma bazında haftalık seri; son haftanın sezon kırılımı ve en çok satanları.",
    input_schema: obj(
      {
        aile: { type: "string" },
        hafta_sayisi: { type: "integer", description: "2-16, varsayılan 8" },
        kanal: KANAL,
      },
      ["aile"],
    ),
  },
  {
    name: "gecen_yil",
    description:
      "Bir haftayı geçen yılın aynı ISO haftasıyla kıyasla. barkod verilirse ürün (aynı barkod ya da önceki sezon karşılığı), aile verilirse aile (+ yeni sezon ↔ geçen yılın önceki sezonu), ikisi de yoksa firma toplamları ve en çok değişen aileler.",
    input_schema: obj({
      hafta: HAFTA,
      barkod: { type: "string" },
      aile: { type: "string" },
    }),
  },
  {
    name: "stok_kapsami",
    description:
      "Kaç haftalık stok kaldığına göre ürünler: 'az' (6 haftadan az, hızlı satan) ya da 'fazla' (26+ hafta ya da satmayıp stoklu; PSF stok değerine göre).",
    input_schema: obj({
      durum: { type: "string", enum: ["az", "fazla"] },
      kanal: KANAL,
      limit: { type: "integer" },
    }),
  },
  {
    name: "yonlendirme_onerileri",
    description:
      "Kural tabanlı yönlendirme motorunun sevk/transfer/depo/likidasyon önerileri ve gerekçeleri. Kanıt olarak kullan; körü körüne aktarma.",
    input_schema: obj({
      aksiyon: {
        type: "string",
        enum: [
          "SEVK",
          "DAĞIT",
          "TRANSFER",
          "DEPO",
          "ERIT",
          "LIKIDASYON",
          "ASKIDA",
          "HEPSI",
        ],
      },
      kanal: KANAL,
      limit: { type: "integer" },
    }),
  },
  {
    name: "siparis_kontrol",
    description:
      "Kanaldan gelen siparişi (her satırda barkod ve/veya ürün adı + adet; Excel'den yapıştırılmış tablo da olur) yönlendirme motorunun hedefleriyle satır satır değerlendirir: Mantıklı / Az / Fazla / Çok fazla / Eski sezon / Satış yok / Bulunamadı, motorun önerdiği adet ve gerekçe (stok, mağaza başı stok, talep, sipariş sonrası kaç hafta). 'Bu sipariş mantıklı mı', 'D&R şunu istedi' sorularında kullan; kullanıcının yapıştırdığı metni değiştirmeden ver.",
    input_schema: obj(
      {
        kanal: {
          ...KANAL,
          description:
            "Siparişi veren firma: Toyzz, D&R, Nezih, Armağan, Huppaluppo.",
        },
        metin: {
          type: "string",
          description: "Sipariş satırları, kullanıcının yapıştırdığı haliyle",
        },
      },
      ["kanal", "metin"],
    ),
  },
  {
    name: "nakit_durumu",
    description:
      "Sahada bekleyen net alacak (firma ve vade bazında) ve aylık tahsilat projeksiyonu.",
    input_schema: obj({}),
  },
  {
    name: "para_firsatlari",
    description:
      "Para nerede: ağdaki fırsatları TL'ye çevirir — kayıp satış riski (rafı bitecek ya da mağaza başı stoğu incelmiş ürünler, 8 haftada kaçacak net kazanç), bağlı sermaye (çekilmesi/eritilmesi önerilen fazla stok, PSF ve net karşılığı) ve kanal transferleri. 'Ne yapalım', 'para nerede', 'öncelik ne' sorularında buradan başla, sonra ürün serileriyle doğrula. barkod verilirse yalnız o ürünün satırları.",
    input_schema: obj({
      kanal: KANAL,
      barkod: { type: "string", description: "Yalnız bu ürün (isteğe bağlı)" },
      limit: {
        type: "integer",
        description: "Her kovada en fazla kaç satır (1-25, varsayılan 8)",
      },
    }),
  },
];

const UYGULAMA: Record<string, (b: Baglam, girdi: any) => Promise<unknown>> = {
  veri_durumu: (b) => veriDurumu(b),
  hafta_ozeti: haftaOzeti,
  en_cok_satanlar: enCokSatanlar,
  urun_ara: urunAra,
  urun_serisi: urunSerisi,
  aile_serisi: aileSerisi,
  gecen_yil: gecenYil,
  stok_kapsami: stokKapsami,
  yonlendirme_onerileri: yonlendirmeOnerileri,
  siparis_kontrol: siparisKontrolArac,
  nakit_durumu: () => nakitDurumu(),
  para_firsatlari: paraFirsatlari,
};

// ── Panel için ücretsiz özetler (model çağrısı yok) ─────────────────────────

/** Asistan panelinin "Masada para" kartı: motorun önerilerinin TL karşılığı.
 *  Ürün → kanal → ağ: dar kapsamda hiç satır yoksa bir üstüne düşer. */
export async function paraOzeti(girdi: { kanal?: string; barkod?: string }) {
  const kanal = kanalKodu(girdi.kanal) ?? undefined;
  const denemeler: {
    kapsam: "urun" | "kanal" | "ag";
    kanal?: string;
    barkod?: string;
  }[] = [
    ...(girdi.barkod
      ? [{ kapsam: "urun" as const, kanal, barkod: girdi.barkod }]
      : []),
    ...(kanal ? [{ kapsam: "kanal" as const, kanal }] : []),
    { kapsam: "ag" },
  ];
  const bos = (x: any) =>
    !x.toplam.kayipSatisRiski8hf.kalem &&
    !x.toplam.bagliSermaye.kalem &&
    !x.toplam.transfer.kalem;
  for (let i = 0; i < denemeler.length; i++) {
    const { kapsam, ...filtre } = denemeler[i];
    const x: any = await paraFirsatlari(null, { ...filtre, limit: 3 });
    if (!bos(x) || i === denemeler.length - 1)
      return { kapsam, ...(i > 0 ? { dar: denemeler[0].kapsam } : {}), ...x };
  }
}

/** Verinin imzası: her firmanın son raporlu haftası + o haftanın satış/stok
 *  toplamı. Yeni rapor yüklenince ya da bir hafta düzeltilince değişir. */
export async function veriImzasi(b: Baglam): Promise<string> {
  const oz = await b.ozet();
  return KANALLAR.map((k) => {
    const son = oz
      .filter((r) => r.retailer === k)
      .sort((x, y) => x.week_start.localeCompare(y.week_start))
      .pop();
    return son
      ? `${k}:${son.week_start}:${son.sales_qty}:${son.stock_qty}`
      : `${k}:-`;
  }).join(",");
}

const AZAMI_KARAKTER = 16000;

export async function aracCalistir(
  b: Baglam,
  ad: string,
  girdi: unknown,
): Promise<string> {
  const f = UYGULAMA[ad];
  if (!f) throw new Error(`Bilinmeyen araç: ${ad}`);
  const sonuc = await f(b, girdi && typeof girdi === "object" ? girdi : {});
  const metin = JSON.stringify(sonuc);
  return metin.length > AZAMI_KARAKTER
    ? metin.slice(0, AZAMI_KARAKTER) +
        "…(çıktı kısaltıldı; limit düşür ya da filtrele)"
    : metin;
}
