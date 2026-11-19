import { NextRequest, NextResponse } from "next/server";
import { supabase, fetchAllRows } from "@/lib/supabase";
import { haftaSatirlari, gecenYilHaftasi, haftaKaydir, type YilSatiri } from "@/lib/arsiv";
import { sezon, oncekiSezon, karsilikAnahtari } from "@/lib/urun-ailesi";

export const runtime = "nodejs";
export const revalidate = 0;
export const maxDuration = 30;

// ÜRÜN · GEÇEN YIL AYNI HAFTA: ?week=YYYY-MM-DD&barkod=…
//
// Seçili ürünün son 5 haftası, geçen yılın aynı ISO haftalarıyla (364 gün
// önce, aynı Pazartesi). Karşılık: aynı barkod; sezonluk ürün yeni barkodla
// geldiyse aynı firma + aile + takım + bir önceki sezon (Pre-Season 26/27 ↔
// 25/26). Ürün sayfası yalnız Pre-Season ürünlerinde çağırır (kullanıcı kararı).
const ISO = /^\d{4}-\d{2}-\d{2}$/;
const topla = (rows: YilSatiri[], alan: "sales_qty" | "stock_qty") => rows.reduce((t, r) => t + r[alan], 0);

export async function GET(req: NextRequest) {
  try {
    const week = req.nextUrl.searchParams.get("week") ?? "";
    const barkod = (req.nextUrl.searchParams.get("barkod") ?? "").trim();
    if (!ISO.test(week) || !barkod) return NextResponse.json({ error: "week=YYYY-MM-DD ve barkod gerekli" }, { status: 400 });

    const haftalar = [-28, -21, -14, -7, 0].map((g) => haftaKaydir(week, g));
    const gyHaftalar = haftalar.map(gecenYilHaftasi);
    const [bu, gy, rapor] = await Promise.all([
      fetchAllRows<YilSatiri>(
        (from, to) => supabase.from("sku_weekly").select("retailer, week_start, sku_name, barkod, sales_qty, sales_value, stock_qty")
          .eq("barkod", barkod).in("week_start", haftalar).order("retailer").order("week_start").order("sku_name").range(from, to),
        { label: "gecen-yil ürün" }
      ),
      haftaSatirlari(supabase, gyHaftalar),
      fetchAllRows<{ retailer: string; week_start: string }>(
        (from, to) => supabase.from("weekly_summary").select("retailer, week_start").in("week_start", haftalar)
          .order("retailer").order("week_start").range(from, to),
        { label: "gecen-yil rapor haftaları" }
      ),
    ]);
    // "—" ile "0"ı ayırmak için: o hafta firmanın raporu var mı?
    const buRapor = new Set(rapor.map((r) => `${r.retailer}|${r.week_start}`));
    const gyRapor = new Set(gy.map((r) => `${r.retailer}|${r.week_start}`));
    const B = bu.map((r) => ({ ...r, sales_qty: Number(r.sales_qty) || 0, stock_qty: Number(r.stock_qty) || 0 }));

    const kanallar = [...new Set(B.map((r) => r.retailer))].sort().map((k) => {
      const b = B.filter((r) => r.retailer === k);
      const ad = [...b].sort((x, y) => (x.week_start < y.week_start ? 1 : -1))[0].sku_name;
      let g = gy.filter((r) => r.retailer === k && r.barkod === barkod);
      let karsilik: { tur: "ayni" | "sezon"; adlar: string[] } | null = g.length ? { tur: "ayni", adlar: [...new Set(g.map((r) => r.sku_name))] } : null;
      const s = sezon(ad);
      if (!g.length && s) {
        const anahtar = karsilikAnahtari(k, ad, oncekiSezon(s));
        g = gy.filter((r) => r.retailer === k && karsilikAnahtari(r.retailer, r.sku_name) === anahtar);
        if (g.length) karsilik = { tur: "sezon", adlar: [...new Set(g.map((r) => r.sku_name))] };
      }
      const seri = haftalar.map((h, i) => {
        const bh = b.filter((r) => r.week_start === h), gh = g.filter((r) => r.week_start === gyHaftalar[i]);
        return {
          bu: buRapor.has(`${k}|${h}`) ? { adet: topla(bh, "sales_qty"), stok: topla(bh, "stock_qty") } : null,
          gy: karsilik && gyRapor.has(`${k}|${gyHaftalar[i]}`) ? { adet: topla(gh, "sales_qty"), stok: topla(gh, "stock_qty") } : null,
        };
      });
      return { retailer: k, ad, karsilik, seri };
    });

    return NextResponse.json({
      week, gyHafta: gecenYilHaftasi(week),
      haftalar: haftalar.map((h, i) => ({ bu: h, gy: gyHaftalar[i] })),
      kanallar,
    });
  } catch (e: any) {
    console.error("gecen-yil hatası:", e?.message ?? e);
    return NextResponse.json({ error: "Sunucu hatası" }, { status: 500 });
  }
}
