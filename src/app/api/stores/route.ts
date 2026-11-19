import { NextRequest, NextResponse } from "next/server";
import { supabase, fetchAllRows } from "@/lib/supabase";
import { netFactor } from "@/lib/margins";
import { STORE_COLS } from "@/lib/rows";
import { sonTamamlanmisHafta, gecikmeHaftasi, GECIKME_ROZET } from "@/lib/compute";
import { isRetailer, isWeek, badRequest } from "@/lib/params";

export const runtime = "nodejs";
export const revalidate = 0;
export const maxDuration = 60;

// Ağın en güncel haftası (mağaza kırılımı olsun olmasın). Bir firmanın mağaza
// verisi bu haftanın gerisinde kaldıysa o firma mağaza göndermeyi BIRAKMIŞ demektir
// ve bu ekrandaki sayıları eksik yapar — sessiz kalınamaz, bkz. staleness.
async function networkWeek(): Promise<string | null> {
  const { data } = await supabase.from("weekly_summary")
    .select("week_start").order("week_start", { ascending: false }).limit(1);
  return data?.[0]?.week_start ?? null;
}

// ÇAPA: TAKVİM, AĞ DEĞİL. Eski kural firmanın mağaza haftasını ağın en yeni
// haftasıyla kıyaslıyordu. Bu, /api/health ve /api/routing'de düzeltilen kusurun
// aynısı: bütün firmalar göndermeyi bıraksa hepsinin haftası ağın haftası olur,
// kimse bayat görünmez. Son tamamlanmış takvim haftası çapa alınırsa sessizlik
// büyüdükçe gecikme büyür. Eşik GECIKME_ROZET (2) — /api/health ile aynı ve eski
// STALE_WEEKS ile aynı gerekçe: Armağan/Huppaluppo düzenli bir hafta geriden
// gelir, 1 haftalık gecikme normal kadanstır; 2 hafta "kırılım kesildi"yi
// (D&R: 18+ hafta) normal gecikmeden ayırır.
const isStaleWeek = (own: string, takvimHaftasi: string) =>
  gecikmeHaftasi(own, takvimHaftasi) >= GECIKME_ROZET;

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const retailer = searchParams.get("retailer");
  const week = searchParams.get("week");
  if (retailer && !isRetailer(retailer)) return badRequest("Bilinmeyen perakendeci");
  if (week && !isWeek(week)) return badRequest("week geçerli tarih olmalı (YYYY-MM-DD)");
  const takvimHaftasi = sonTamamlanmisHafta(new Date());
  // retailer verilmezse: keşif modu — mağaza-bazlı veri sağlayan perakendeciler
  // ve her birinin EN GÜNCEL store haftası. Sayfa bununla default'unu seçer
  // (hardcode yerine; bir perakendeci store göndermeyi bıraksa/başlasa kendini onarır).
  if (!retailer) {
    try {
      const [{ data }, netWk] = await Promise.all([
        supabase.from("weekly_summary")
          .select("retailer, week_start").gt("store_count", 0)
          .order("week_start", { ascending: false }),
        networkWeek(),
      ]);
      const latest = new Map<string, string>();
      for (const r of data ?? []) if (!latest.has(r.retailer)) latest.set(r.retailer, r.week_start);
      // BAYAT MAĞAZA VERİSİ. Ölçülen: D&R son mağaza kırılımını 2026-03-30'da
      // göndermiş, sonrasında yalnız toplam gönderiyor → D&R satışının %48,7'si
      // bu ekranda görünmüyor ama ekran bunu söylemiyordu. Bayrak firma adına
      // GÖMÜLMEZ, tarih karşılaştırmasından türer: yarın Nezih de kesse aynı
      // uyarı kendiliğinden çıkar.
      const retailers = [...latest.entries()]
        .map(([retailer, week]) => ({
          retailer, week,
          stale: isStaleWeek(week, takvimHaftasi),
          weeksBehind: gecikmeHaftasi(week, takvimHaftasi),
        }))
        .sort((a, b) => (a.week < b.week ? 1 : -1)); // en taze hafta önce
      return NextResponse.json({
        discovery: true, retailers, networkWeek: netWk, takvimHaftasi,
        // Varsayılan, mağaza verisi GÜNCEL olan firmalardan seçilir; yoksa en tazesi.
        default: (retailers.find((r) => !r.stale) ?? retailers[0])?.retailer ?? null,
      });
    } catch (e: any) {
      console.error("stores keşif hatası:", e);
      return NextResponse.json({ discovery: true, retailers: [], default: null });
    }
  }
  try {
    const [{ data: weeks }, netWk] = await Promise.all([
      supabase.from("weekly_summary")
        .select("week_start, store_count").eq("retailer", retailer)
        .gt("store_count", 0).order("week_start", { ascending: false }),
      networkWeek(),
    ]);
    if (!weeks?.length) {
      return NextResponse.json({ stores: [], weeks: [], week: null, storeLevel: false, networkWeek: netWk });
    }
    const wk = week && weeks.some((w) => w.week_start === week) ? week : weeks[0].week_start;
    const rows = await fetchAllRows<any>((from, to) =>
      supabase.from("store_weekly")
        .select(STORE_COLS)
        // KARARLI SIRA — bu haliyle DOĞRU, değiştirme. store_weekly ürün bazlı
        // değil MAĞAZA bazlı toplanmış bir matview (group by retailer, week_start,
        // store; ürün çeşidi `sku_count` olarak sayılıyor), yani benzersiz anahtarı
        // (retailer, week_start, store). retailer ve week_start eq ile sabitlendiği
        // için `store` tek başına satırı belirler → sayfalama kararlı.
        // (Denetimde "sku_name de eklenmeli" diye değiştirilmiş ve uç nokta 500
        // vermişti: bu matview'de sku_name kolonu YOK. Sıra kuralı tablonun GERÇEK
        // anahtarına bakılarak uygulanır, benzer tablolardan çıkarımla değil.)
        .eq("retailer", retailer).eq("week_start", wk)
        .order("store").range(from, to)
    );
    const nf = netFactor(retailer); // ciro net kazanca
    const stores = rows
      .map((r) => ({
        store: r.store, sales_qty: Number(r.sales_qty), sales_value: Number(r.sales_value) * nf,
        stock_qty: Number(r.stock_qty), sku_count: Number(r.sku_count),
      }))
      .sort((a, b) => b.sales_qty - a.sales_qty);
    const latestStoreWeek = weeks[0].week_start;
    return NextResponse.json({
      stores, week: wk, storeLevel: true, weeks: weeks.map((w) => w.week_start),
      // Sayfa uyarıyı bu üç alandan kurar (metin API'de gömülü değil).
      networkWeek: netWk, takvimHaftasi, latestStoreWeek,
      stale: isStaleWeek(latestStoreWeek, takvimHaftasi),
      weeksBehind: gecikmeHaftasi(latestStoreWeek, takvimHaftasi),
    });
  } catch (e: any) {
    console.error("stores rotası hatası:", e);
    return NextResponse.json({ error: "Sunucu hatası" }, { status: 500 });
  }
}
