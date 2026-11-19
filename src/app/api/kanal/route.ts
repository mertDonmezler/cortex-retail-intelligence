import { NextRequest, NextResponse } from "next/server";
import { supabase, fetchAllRows } from "@/lib/supabase";
import { netFactor } from "@/lib/margins";
import { isRetailer, badRequest } from "@/lib/params";
import { skuSatiri, type HaftaKayit, type KanalSku } from "@/lib/kanal";
import { sonTamamlanmisHafta, gecikmeHaftasi } from "@/lib/compute";
import { kapaliMi } from "@/lib/kapali-urunler";

export const runtime = "nodejs";
export const revalidate = 0;
export const maxDuration = 60;

// ── KANAL: bir firmanın TÜM ürünleri, tüm hafta geçmişiyle ──
//
// Kaynak `sku_weekly` matview'i: mağaza boyutu ÇÖKERTİLMİŞ firma×ürün×hafta.
// Bu seçim şart: Armağan mağaza bazlı raporluyor (119.035 ham satır) ama
// matview 2.173 satıra iniyor; ham tablodan okunsa sayfa hem yavaşlar hem de
// aynı ürün mağaza sayısı kadar tekrarlanır.
//
// PSF firmadan firmaya farklı yerden geliyor (ölçüldü, son hafta):
//   Toyzz 231/231 ve Armağan 147/147 raporda · Huppaluppo 0/49 (ciro var,
//   birim fiyat cirodan türetilir) · D&R 80/273 · Nezih 35/70 (kalanı barkodlu
//   fiyat listesinden). Zincir lib/kanal.ts:psfSec içinde.
//
// ÖNBELLEK YOK: yükleme sonrası ekranın eski veri göstermemesi için. Sorgu
// zaten tek matview taraması (en büyük firma 8.110 satır).

const HIZ_PENCERE = 4;

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const retailer = searchParams.get("retailer");
  if (!retailer) return badRequest("retailer gerekli");
  if (!isRetailer(retailer)) return badRequest("Bilinmeyen perakendeci");

  try {
    // 1) Firmanın TÜM hafta geçmişi (SKU bazında).
    const rows = await fetchAllRows<{
      week_start: string;
      sku_name: string;
      barkod: string | null;
      sales_qty: number;
      sales_value: number | null;
      stock_qty: number;
    }>((from, to) =>
      supabase
        .from("sku_weekly")
        .select(
          "week_start, sku_name, barkod, sales_qty, sales_value, stock_qty",
        )
        .eq("retailer", retailer)
        .order("week_start", { ascending: true })
        .order("sku_name", { ascending: true })
        .range(from, to),
    );
    if (!rows.length) {
      return NextResponse.json({
        retailer,
        haftalar: [],
        skus: [],
        veri: null,
        toplam: null,
      });
    }

    const haftalar = [...new Set(rows.map((r) => r.week_start))].sort();
    const sonHafta = haftalar[haftalar.length - 1];

    // 2) Son haftanın PSF'si — ham tablodan (matview fiyat taşımıyor).
    //    SIRA `id` İLE: fact_weekly mağaza kırılımlı, Armağan'ın son haftası
    //    ~147 SKU × ~55 mağaza ≈ 8.064 satır = 9 sayfa. `sku_name` benzersiz
    //    olmadığı için sayfa sınırında bazı satırlar iki kez gelir, bazıları hiç
    //    gelmez ve hata SESSİZDİR (bkz. lib/supabase.ts). `id` birincil anahtar.
    //    SIRA (sku_name, id) — yalnız `id` DEĞİL (2026-10-29): D&R tablonun
    //    ~%75'i (ASEPTO mağaza satırları); `ORDER BY id` planlayıcıyı birincil
    //    anahtar taramasına itiyor ve soğuk önbellekte D&R'ın son haftası 3,5–8,4
    //    sn sürüp statement timeout'a düştü (canlıda iki kez 500). (sku_name, id)
    //    yine benzersiz, (retailer, week_start) indeksinden gelir: ölçüm 0,1–0,7 sn.
    //    SKU içinde sıra hâlâ `id` olduğundan "ilk dolu fiyat" aynı satırdır.
    const fiyatRows = await fetchAllRows<{
      sku_name: string;
      price: number | null;
    }>((from, to) =>
      supabase
        .from("fact_weekly")
        .select("sku_name, price")
        .eq("retailer", retailer)
        .eq("week_start", sonHafta)
        .order("sku_name", { ascending: true })
        .order("id", { ascending: true })
        .range(from, to),
    );
    const raporPsf = new Map<string, number>();
    for (const r of fiyatRows) {
      const p = r.price == null ? 0 : Number(r.price);
      if (p > 0 && !raporPsf.has(r.sku_name)) raporPsf.set(r.sku_name, p);
    }

    // 3) Barkodlu dış fiyat listesi (son çare). Yalnız bu firmanın barkodları.
    const barkodlar = [
      ...new Set(rows.map((r) => r.barkod).filter((b): b is string => !!b)),
    ];
    const listePsf = new Map<string, number>();
    if (barkodlar.length) {
      // IN listesi uzun olabilir → 200'lük parçalar hâlinde.
      for (let i = 0; i < barkodlar.length; i += 200) {
        const { data } = await supabase
          .from("sku_prices")
          .select("barkod, median_price")
          .in("barkod", barkodlar.slice(i, i + 200));
        for (const p of data ?? []) {
          const v = p.median_price == null ? 0 : Number(p.median_price);
          if (v > 0) listePsf.set(String(p.barkod), v);
        }
      }
    }

    // 4) SKU × hafta serisi.
    const seriler = new Map<
      string,
      { barkod: string | null; seri: Record<string, HaftaKayit> }
    >();
    for (const r of rows) {
      let e = seriler.get(r.sku_name);
      if (!e) {
        e = { barkod: r.barkod ?? null, seri: {} };
        seriler.set(r.sku_name, e);
      }
      if (!e.barkod && r.barkod) e.barkod = r.barkod;
      e.seri[r.week_start] = {
        qty: Number(r.sales_qty) || 0,
        value: r.sales_value == null ? null : Number(r.sales_value),
        stock: Number(r.stock_qty) || 0,
      };
    }

    const nf = netFactor(retailer);
    const skus: (KanalSku & { kapali?: true })[] = [];
    for (const [sku_name, e] of seriler) {
      const s = skuSatiri(
        sku_name,
        e.barkod,
        e.seri,
        haftalar,
        raporPsf.get(sku_name),
        e.barkod ? listePsf.get(e.barkod) : undefined,
        nf,
        HIZ_PENCERE,
      );
      // Tasfiye edilmiş kalemler işaretlenir (satır silinmez — geçmişi görünür
      // kalsın; /stok ve /yonlendirme ile aynı kural).
      const row: KanalSku & { kapali?: true } = s;
      if (kapaliMi(retailer, sku_name, e.barkod)) row.kapali = true;
      skus.push(row);
    }
    // Varsayılan sıra: bu haftanın brüt cirosu büyükten küçüğe, sonra adet.
    skus.sort(
      (a, b) =>
        (b.brut ?? 0) - (a.brut ?? 0) ||
        b.qty - a.qty ||
        a.sku_name.localeCompare(b.sku_name, "tr"),
    );

    // 5) Veri yaşı — ekrandaki "N hafta eski" bandı için.
    const takvimHaftasi = sonTamamlanmisHafta(new Date());
    const gecikmeHf = gecikmeHaftasi(sonHafta, takvimHaftasi);

    const say = (f: (s: KanalSku) => boolean) => skus.filter(f).length;
    // "kalem" TÜM GEÇMİŞİ kapsar: katalogdan çıkmış ürünler de tabloda kalır,
    // yoksa geçmiş haftalar kolonları boş görünür. `buHafta` firmanın son
    // raporundaki kalem sayısıdır — ikisi farklıysa aradaki fark artık
    // raporlanmayan üründür.
    const toplam = {
      kalem: skus.length,
      buHafta: say((s) => s.seri[sonHafta] != null),
      satan: say((s) => s.qty > 0),
      stoklu: say((s) => s.stock > 0),
      olu: say((s) => s.qty === 0 && s.stock === 0),
      psfYok: say((s) => s.psf == null),
      qty: skus.reduce((a, s) => a + s.qty, 0),
      prevQty: skus.reduce((a, s) => a + s.prevQty, 0),
      stock: skus.reduce((a, s) => a + s.stock, 0),
      brut: Math.round(skus.reduce((a, s) => a + (s.brut ?? 0), 0)),
      net: Math.round(skus.reduce((a, s) => a + (s.net ?? 0), 0)),
      stokBrut: Math.round(
        skus.reduce((a, s) => a + (s.psf != null ? s.psf * s.stock : 0), 0),
      ),
    };

    return NextResponse.json({
      retailer,
      haftalar,
      veri: {
        dataWeek: sonHafta,
        prevWeek: haftalar[haftalar.length - 2] ?? null,
        takvimHaftasi,
        gecikmeHf,
        hizPencere: HIZ_PENCERE,
        netCarpan: Math.round(nf * 10000) / 10000,
      },
      toplam,
      skus,
    });
  } catch (e: any) {
    console.error("kanal:", e?.message ?? e);
    return NextResponse.json({ error: "Sunucu hatası" }, { status: 500 });
  }
}
