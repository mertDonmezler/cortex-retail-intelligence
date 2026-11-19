import { NextRequest, NextResponse } from "next/server";
import { supabase, fetchAllRows } from "@/lib/supabase";
import { netFactor } from "@/lib/margins";
import { isRetailer, badRequest } from "@/lib/params";
import { hizHesapla, kapsamHesapla, type HaftaKayit } from "@/lib/kanal";
import { sonTamamlanmisHafta, gecikmeHaftasi, GECIKME_ROZET } from "@/lib/compute";

export const runtime = "nodejs";
export const revalidate = 0;
export const maxDuration = 30;

// ── KANAL DETAYI: bir ürünün DİĞER firmalardaki durumu ──
//
// Kanal tablosunda satıra tıklanınca açılan panelin tek veri ihtiyacı budur.
// Ürünün kendi haftalık serisi ve motorun kararı İSTEMCİDE ZATEN VAR
// (/api/kanal + /api/routing yanıtlarından); onları burada tekrar döndürmek
// aynı veriyi ikinci kez taşımak olurdu.
//
// EŞLEŞME KURALI /api/product ile BİREBİR AYNI olmak zorunda: barkod, artı
// barkodsuz kalemler için ONAYLI product_alias. Kural iki yerde ayrışırsa aynı
// ürün iki ekranda farklı firmalarda görünür. Toyzz raporu 21-27 Eylül 2026'ya
// kadar barkod taşımıyordu; o tarihten beri taşıyor ve eski haftalara Kalem
// Kodu'yla geri işlendi. Barkodu olmayan kalan Toyzz kalemlerinde eşleşme ancak
// /eslesme'de onaylanmış alias varsa kurulur — kurulamıyorsa panel bunu açıkça
// söyler, sessizce "başka firmada yok" demez.

const SON_N_HAFTA = 8;

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const retailer = searchParams.get("retailer");
  const sku = searchParams.get("sku");
  if (!retailer || !sku) return badRequest("retailer ve sku gerekli");
  if (!isRetailer(retailer)) return badRequest("Bilinmeyen perakendeci");

  try {
    // 1) Ürünün barkodu — önce kendi satırından, yoksa onaylı alias'tan.
    const { data: kendi } = await supabase.from("sku_weekly")
      .select("barkod").eq("retailer", retailer).eq("sku_name", sku)
      .not("barkod", "is", null).limit(1);
    let barkod: string | null = kendi?.[0]?.barkod ?? null;
    let barkodKaynak: "kendi" | "alias" | null = barkod ? "kendi" : null;
    if (!barkod) {
      const { data: al } = await supabase.from("product_alias")
        .select("barkod").eq("retailer", retailer).eq("sku_name", sku)
        .eq("status", "approved").limit(1);
      if (al?.[0]?.barkod) { barkod = String(al[0].barkod); barkodKaynak = "alias"; }
    }
    if (!barkod) {
      return NextResponse.json({
        retailer, sku, barkod: null, barkodKaynak: null, firmalar: [],
        not: "Bu kalemin barkodu yok ve /eslesme sayfasında onaylanmış bir eşleşmesi de yok — diğer firmalarda karşılığı ARANAMADI (yok demek değil).",
      });
    }

    // 2) Bu barkodun tüm firmalardaki haftalık satırları (+ alias'la bağlı
    //    barkodsuz kalemler; /api/product ile aynı iki adımlı okuma).
    let rows = await fetchAllRows<{
      retailer: string; week_start: string; sku_name: string;
      sales_qty: number; sales_value: number | null; stock_qty: number;
    }>((from, to) =>
      supabase.from("sku_weekly")
        .select("retailer, week_start, sku_name, sales_qty, sales_value, stock_qty")
        .eq("barkod", barkod)
        .order("retailer").order("week_start").order("sku_name").range(from, to)
    );
    const { data: al2 } = await supabase.from("product_alias")
      .select("retailer, sku_name").eq("barkod", barkod).eq("status", "approved");
    const ciftler = new Set((al2 ?? []).map((a) => `${a.retailer}|${a.sku_name}`));
    if (ciftler.size) {
      const ek = await fetchAllRows<any>((from, to) =>
        supabase.from("sku_weekly")
          .select("retailer, week_start, sku_name, sales_qty, sales_value, stock_qty")
          .in("retailer", [...new Set((al2 ?? []).map((a) => a.retailer))])
          .in("sku_name", [...new Set((al2 ?? []).map((a) => a.sku_name))])
          .is("barkod", null)
          .order("retailer").order("week_start").order("sku_name").range(from, to)
      );
      rows = rows.concat(ek.filter((r) => ciftler.has(`${r.retailer}|${r.sku_name}`)));
    }

    // 3) Firma başına: KENDİ son haftası + son 8 haftalık seri.
    //    Her firmanın kadansı farklı (Nezih 5 hafta geride), o yüzden ortak bir
    //    "son hafta" kullanılmaz — herkesin kendi son raporu esas alınır.
    const gruplar = new Map<string, { ad: string; seri: Record<string, HaftaKayit> }>();
    for (const r of rows) {
      let g = gruplar.get(r.retailer);
      if (!g) { g = { ad: r.sku_name, seri: {} }; gruplar.set(r.retailer, g); }
      const k = g.seri[r.week_start] ?? { qty: 0, value: null, stock: 0 };
      // Aynı firmada aynı hafta birden çok ad eşleşebilir (alias) → toplanır.
      // CİRO: "bilinmiyor" (null) ile "sıfır" AYRI. Eski ifade
      // `(k.value ?? 0) + X || null` idi; `+` operatörü `||`'dan önce bağlandığı
      // için TOPLAMI 0 ÇIKAN her hafta null'a düşüyordu — oysa satmayan haftada
      // dosyadan gerçekten 0 TL gelebiliyor (Huppaluppo, Armağan).
      const ciroVar = k.value != null || r.sales_value != null;
      g.seri[r.week_start] = {
        qty: k.qty + (Number(r.sales_qty) || 0),
        value: ciroVar ? (k.value ?? 0) + Number(r.sales_value ?? 0) : null,
        stock: k.stock + (Number(r.stock_qty) || 0),
      };
    }

    // FİRMANIN HAFTA SERİSİ — hız için ŞART.
    //
    // hizHesapla'nın paydası "ürünün rafta olduğu hafta sayısı"dır ve bunu
    // verilen hafta listesinden okur. Buraya ürünün KENDİ görülme haftaları
    // verilirse payda daima min(4, görülme sayısı) olur, pencere geriye kayar ve
    // aynı ürün için /api/kanal başka, bu panel başka bir hız gösterir (kapsam da
    // stok÷hız olduğu için ikiye ayrılır). Doğru payda FİRMANIN raporladığı
    // haftalardır: ürünün görünmediği hafta "satmadı" demektir, "yok" değil.
    const { data: fw } = await supabase.from("weekly_summary").select("retailer, week_start");
    const firmaHaftalari = new Map<string, string[]>();
    for (const r of fw ?? []) {
      const a = firmaHaftalari.get(r.retailer) ?? [];
      a.push(r.week_start); firmaHaftalari.set(r.retailer, a);
    }
    for (const a of firmaHaftalari.values()) a.sort();

    // BAYAT FİRMA KAPISI. Veri yaşı GECIKME_ROZET'i (2 hafta) geçen firma
    // KARŞILAŞTIRMAYA GİRMEZ: rakamları bugünkülerle yan yana konunca aynı ana
    // aitmiş gibi okunuyor ve üstüne "transfer fırsatı" gibi yorumlar üretiliyordu.
    // Satır gizlenir, firma ayrı bir notta adı ve son veri haftasıyla söylenir —
    // "veri yok" ile "bu firmada yok" karıştırılmasın.
    //
    // İKİ AYRI GECİKME, KARIŞTIRILMAZ:
    //   urunGecikmeHf — ürünün O FİRMADA son göründüğü haftanın yaşı. Kapı bunu
    //     kullanır: rakam eskiyse kıyasa girmemeli, sebebi ne olursa olsun.
    //   firmaGecikmeHf — FİRMANIN son raporunun yaşı. Ekrandaki cümle bunu
    //     kullanır: raporu bugün gelmiş bir firmayı "5 hafta geride" diye
    //     suçlamak yanlıştı; doğrusu "raporu güncel, bu ürünü listelemiyor".
    const takvimHaftasi = sonTamamlanmisHafta(new Date());
    const firmalar = [...gruplar.entries()].map(([ret, g]) => {
      const haftalar = Object.keys(g.seri).sort();
      const son = haftalar[haftalar.length - 1];
      const onceki = haftalar[haftalar.length - 2];
      const cur = g.seri[son];
      const hiz = hizHesapla(g.seri, firmaHaftalari.get(ret) ?? haftalar, 4);
      const brut = cur.value;
      const gecikmeHf = gecikmeHaftasi(son, takvimHaftasi);
      const fSon = (firmaHaftalari.get(ret) ?? []).slice(-1)[0] ?? null;
      return {
        retailer: ret,
        kendisi: ret === retailer,
        gecikmeHf,
        firmaGecikmeHf: gecikmeHaftasi(fSon, takvimHaftasi),
        firmaDataWeek: fSon,
        bayat: gecikmeHf >= GECIKME_ROZET,
        sku_name: g.ad,
        dataWeek: son,
        qty: cur.qty,
        prevQty: onceki ? g.seri[onceki].qty : 0,
        stock: cur.stock,
        hiz,
        kapsam: kapsamHesapla(cur.stock, hiz),
        brut: brut == null ? null : Math.round(brut),
        net: brut == null ? null : Math.round(brut * netFactor(ret)),
        seri: haftalar.slice(-SON_N_HAFTA).map((w) => ({ w, qty: g.seri[w].qty, stock: g.seri[w].stock })),
      };
    }).sort((a, b) => (a.kendisi ? -1 : b.kendisi ? 1 : 0) || b.qty - a.qty);

    // Bayat firmalar ayrılır: karşılaştırma tablosuna girmez, ayrı not olur.
    // İSTİSNA: ekranın kendi firması bayat olsa da gösterilir — kullanıcı zaten
    // o firmanın sayfasında ve veri yaşını sayfa başlığında görüyor.
    const kiyas = firmalar.filter((f) => f.kendisi || !f.bayat);
    const disarida = firmalar.filter((f) => !f.kendisi && f.bayat)
      .map((f) => ({
        retailer: f.retailer, dataWeek: f.dataWeek, gecikmeHf: f.gecikmeHf,
        firmaGecikmeHf: f.firmaGecikmeHf, firmaDataWeek: f.firmaDataWeek,
        qty: f.qty, stock: f.stock,
      }));
    return NextResponse.json({
      retailer, sku, barkod, barkodKaynak,
      takvimHaftasi, firmalar: kiyas, disarida, not: null,
    });
  } catch (e: any) {
    console.error("kanal-detay:", e?.message ?? e);
    return NextResponse.json({ error: "Sunucu hatası" }, { status: 500 });
  }
}
