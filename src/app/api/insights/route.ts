import { NextResponse } from "next/server";
import { supabase, fetchAllRows } from "@/lib/supabase";
import { generateInsights, findStockoutRisks, VELOCITY_WEEKS } from "@/lib/compute";
import { RETAILERS } from "@/lib/normalizers/types";
import { netRows } from "@/lib/margins";
import { toFacts, toSummary, SKU_COLS } from "@/lib/rows";

export const runtime = "nodejs";
export const revalidate = 0;
export const maxDuration = 60;

export async function GET() {
  try {
    const { data: summary, error: eSummary } = await supabase
      .from("weekly_summary").select("*").order("week_start", { ascending: true });
    // OKUMA HATASI "VERI YOK" DEMEK DEGIL. error alani okunmadiginda bir ag/izin
    // hatasi bos diziye donusuyor ve ekran "veri yok" / "siparis gerekmiyor" diye
    // okunuyordu. Hata artik 500 olarak yukari cikar.
    if (eSummary) throw eSummary;
    if (!summary?.length) return NextResponse.json({ insights: [] });

    const summaryRows = toSummary(summary);

    // Her firmanın kendi son VELOCITY_WEEKS haftası (firmalar farklı hafta
    // setlerinde olabilir). Pencere compute.ts'ten geliyor: /stok, /yonlendirme
    // ve /stock-alerts ile aynı olmalı, yoksa aynı ürünün "kaç hafta yeter"i
    // ekrandan ekrana değişir (ölçüldü: 4 hafta ↔ 8 hafta, 19 üründe zıt etiket).
    const recentByRetailer = new Map<string, string[]>();
    for (const retailer of RETAILERS) {
      const weeks = [...new Set(summaryRows.filter((s) => s.retailer === retailer).map((s) => s.week_start))].sort();
      if (weeks.length < 2) continue;
      recentByRetailer.set(retailer, weeks.slice(-VELOCITY_WEEKS));
    }

    // N+1 KALDIRILDI: eskiden bu sorgu `for (const retailer of RETAILERS)` döngüsünün
    // İÇİNDE idi — 5 firma = 5 sıralı fetchAllRows (her biri en az 1 sayfa), ölçülen
    // 1,7-2,0 sn. Artık tek `.in("retailer", ...)` sorgusu + count'lu paralel sayfalama.
    // Ölçüm: firmaların son-4-hafta birleşimi sku_weekly'de ~3.771 satır = 4 sayfa,
    // yani 6-10 sıralı round-trip yerine 1 count + 1 paralel dalga.
    const retailers = [...recentByRetailer.keys()];
    const allWeeks = [...new Set([...recentByRetailer.values()].flat())].sort();
    const allRisks: any[] = [];

    if (retailers.length) {
      // Filtre TEK yerde: count sorgusu ile sayfa sorgusu aynı kümeye bakmak
      // ZORUNDA. Ayrışırlarsa sayfa sayısı yanlış hesaplanır → satır kaybı/tekrarı,
      // hem de sessizce. Bu yüzden ikisi de aynı fonksiyondan geçiyor.
      const filt = (q: any) => q.in("retailer", retailers).in("week_start", allWeeks);
      try {
        const rows = await fetchAllRows<any>(
          // Sıra benzersiz anahtarı kapsıyor (retailer, week_start, sku_name).
          (from, to) =>
            filt(supabase.from("sku_weekly").select(SKU_COLS))
              .order("retailer").order("week_start").order("sku_name").range(from, to),
          {
            count: () => filt(supabase.from("sku_weekly").select("retailer", { count: "exact", head: true })),
            label: "insights sku_weekly",
          }
        );
        // Firma bazında böl: her firma YALNIZ kendi son-4-hafta penceresini görsün
        // (hafta setleri farklıysa başka firmanın haftası ortalamayı kaydırmasın).
        const byRetailer = new Map<string, any[]>();
        for (const r of rows) {
          const arr = byRetailer.get(r.retailer);
          if (arr) arr.push(r);
          else byRetailer.set(r.retailer, [r]);
        }
        for (const [retailer, recent] of recentByRetailer) {
          try {
            const own = (byRetailer.get(retailer) ?? []).filter((r) => recent.includes(r.week_start));
            allRisks.push(...findStockoutRisks(toFacts(own), retailer, recent));
          } catch (e) {
            // Tek perakendecinin hesap hatası tüm paneli düşürmesin
            console.warn(`insights ${retailer} atlandı:`, e);
          }
        }
      } catch (e) {
        // Stok riski çekilemediyse ciro sinyalleri yine üretilsin (panel ayakta kalsın).
        console.warn("insights stok riski atlandı:", e);
      }
    }

    // Ciro sinyalleri net kazanç üzerinden (çalışma marjı + KDV)
    const insights = generateInsights(netRows(summaryRows), allRisks);
    return NextResponse.json({ insights });
  } catch (e: any) {
    console.error("insights hatası:", e);
    return NextResponse.json({ error: "Sunucu hatası" }, { status: 500 });
  }
}
