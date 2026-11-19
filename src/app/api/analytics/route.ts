import { NextRequest, NextResponse } from "next/server";
import { supabase, fetchAllRows } from "@/lib/supabase";
import { sellThrough, weeksOfStock } from "@/lib/analytics";
import { netFactor } from "@/lib/margins";
import { VELOCITY_WEEKS } from "@/lib/compute";
import { isWeek, isRetailer, badRequest, optionalWeek } from "@/lib/params";

export const runtime = "nodejs";
export const revalidate = 0;
export const maxDuration = 60;

// Bir perakendeci için SKU-level intelligence:
//   - stockout riski (kaç hafta yeter)
//   - sell-through (devir verimliliği)
//   - momentum (son haftalardaki yön)
export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const retailer = searchParams.get("retailer");
  if (!retailer)
    return NextResponse.json({ error: "retailer gerekli" }, { status: 400 });
  // Bilinmeyen ad boş ekran yerine 400: "Yok" gibi bir yazım hatası sessizce boş liste üretiyordu.
  if (!isRetailer(retailer)) return badRequest("Bilinmeyen perakendeci");

  try {
    // Hız penceresi kadar hafta al (momentum + stockout için). Eskiden sabit 6'ydı
    // ve hız son 4 haftadan hesaplanıyordu; diğer ekranlar 8 kullandığı için aynı
    // ürünün "kaç hafta yeter"i ekrandan ekrana değişiyordu.
    const { data: weeks, error: eWeeks } = await supabase
      .from("weekly_summary")
      .select("week_start")
      .eq("retailer", retailer)
      .order("week_start", { ascending: false })
      .limit(VELOCITY_WEEKS);
    // OKUMA HATASI "VERI YOK" DEMEK DEGIL. error alani okunmadiginda bir ag/izin
    // hatasi bos diziye donusuyor ve ekran "veri yok" / "siparis gerekmiyor" diye
    // okunuyordu. Hata artik 500 olarak yukari cikar.
    if (eWeeks) throw eWeeks;
    if (!weeks?.length) return NextResponse.json({ skus: [], latest: null });

    const weekList = weeks.map((w) => w.week_start).reverse();
    const latest = weekList[weekList.length - 1];

    const rows = await fetchAllRows((from, to) =>
      supabase
        .from("sku_weekly")
        .select(
          "sku_name, barkod, week_start, sales_qty, stock_qty, sales_value",
        )
        .eq("retailer", retailer)
        .in("week_start", weekList)
        // KARARLI SIRA ŞART: sku_weekly'nin benzersiz anahtarı (retailer, week_start,
        // sku_name). retailer eq ile sabit ama week_start TEK BAŞINA satırı
        // belirlemiyor (bir haftada yüzlerce ürün var) → eşitler arasında sıra
        // garantili değil ve fetchAllRows sayfaları çakışırsa satır çiftlenir/kaybolur,
        // HATA VERMEZ. Ölçüm: bu sorgu 3 firmada 1000'i aşıyor (Toyzz 2.558,
        // DR 2.500, Armağan 1.442) — yani sayfalama fiilen devrede. Bugün hasar
        // ÖLÇÜLMEDİ (planlayıcı tesadüfen indeks sırasını kullanıyor: mükerrer 0),
        // ama bu bir garanti değil; matview yenilenmesi veya plan değişimi eşitleri
        // yeniden sıralayabilir. sku_name eklemek garantiyi koda yazar.
        .order("week_start")
        .order("sku_name")
        .range(from, to),
    );

    // SKU bazında, hafta bazında topla
    type Agg = {
      sales: Map<string, number>;
      stock: Map<string, number>;
      value: number;
      barkod: string | null;
    };
    const skuMap = new Map<string, Agg>();
    for (const r of rows) {
      let e = skuMap.get(r.sku_name);
      if (!e) {
        e = { sales: new Map(), stock: new Map(), value: 0, barkod: r.barkod };
        skuMap.set(r.sku_name, e);
      }
      e.sales.set(
        r.week_start,
        (e.sales.get(r.week_start) ?? 0) + Number(r.sales_qty),
      );
      e.stock.set(
        r.week_start,
        (e.stock.get(r.week_start) ?? 0) + Number(r.stock_qty),
      );
      if (r.week_start === latest) e.value += Number(r.sales_value ?? 0);
    }

    const skus = [...skuMap.entries()].map(([sku_name, a]) => {
      const salesSeries = weekList.map((w) => a.sales.get(w) ?? 0);
      const latestStock = a.stock.get(latest) ?? 0;
      const latestSales = a.sales.get(latest) ?? 0;
      // Ort. satış hızı — pencere compute.ts'ten (VELOCITY_WEEKS). Eskiden 4'tü;
      // /stok, /yonlendirme, /stock-alerts ve /insights 8 hafta kullandığı için
      // aynı ürünün hızı ekrandan ekrana değişiyordu (ölçüldü: 2,4×'e kadar).
      // BÖLEN: ürünün RAFTA OLDUĞU hafta sayısı (en az 2) — compute.ts'teki
      // buildVelocityIndex ve routing'teki velOf ile aynı kural. Ürünün henüz var
      // olmadığı haftaları 0 sayıp bölmek yeni ürünün hızını yapay olarak düşürüyor
      // (ölçülen en sert örnek 2,7×) ve stok bitişini geç haber veriyordu.
      // RAFA GELİŞ: satırın VAR olması değil, stok > 0 ya da satış ≠ 0. Firmalar ürünü
      // rafa gelmeden 0/0 listeliyor; o haftalar bölene girince lansman ürününün
      // hızı düşük çıkıyordu (routing velOf 2026-09-28, burası 2026-10-29).
      const firstIdx = weekList.findIndex(
        (w) => (a.sales.get(w) ?? 0) !== 0 || (a.stock.get(w) ?? 0) > 0,
      );
      const openWeeks =
        firstIdx < 0 ? weekList.length : weekList.length - firstIdx;
      const recent = salesSeries.slice(-VELOCITY_WEEKS);
      const denom = Math.max(2, Math.min(openWeeks, recent.length));
      const avgSales = recent.length
        ? recent.reduce((x, y) => x + y, 0) / denom
        : 0;
      const wos = weeksOfStock(latestStock, avgSales);
      const st = sellThrough(latestSales, latestStock);
      const slope =
        salesSeries.length >= 2
          ? salesSeries[salesSeries.length - 1] -
            salesSeries[salesSeries.length - 2]
          : 0;
      return {
        sku_name,
        barkod: a.barkod,
        sales_qty: latestSales,
        stock_qty: latestStock,
        sales_value: a.value ? a.value * netFactor(retailer) : null,
        sell_through: st,
        weeks_of_stock: wos,
        spark: salesSeries,
        trend: slope,
      };
    });

    return NextResponse.json({ latest, weeks: weekList, skus });
  } catch (e: any) {
    console.error("analytics hatası:", e);
    return NextResponse.json({ error: "Sunucu hatası" }, { status: 500 });
  }
}
