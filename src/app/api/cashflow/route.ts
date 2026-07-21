import { NextResponse } from "next/server";
import { supabase } from "@/lib/supabase";
import { netFactor, CHANNEL_TERMS } from "@/lib/margins";

export const runtime = "nodejs";
export const revalidate = 0;

// Nakit takvimi — konsinye/satıştan-ödeme modelinde paranın NE ZAMAN kasaya
// gireceğini tahmin eder. Model: her haftanın net kazancı (PSF×(1−marj)÷1,2)
// satış haftasının BİTİŞİ + kanal vadesi (Huppa 30g · DR 90g · Armağan 95g ·
// Toyzz/Nezih 150g) günü tahsil edilir varsayılır.
// Varsayımlar (bilinçli sadeleştirme):
//  • geçmiş vade tarihleri tahsil edilmiş sayılır (takvimde gösterilmez);
//  • Nezih "faturadan" çalışır — satış haftası yaklaşıklaması kullanılır;
//  • iade/kesinti öngörülmez (mutabakat Sat-Öde tablosunda ayrıca izlenir).
const AY = ["", "Ocak", "Şubat", "Mart", "Nisan", "Mayıs", "Haziran",
  "Temmuz", "Ağustos", "Eylül", "Ekim", "Kasım", "Aralık"];

export async function GET() {
  try {
    const { data, error } = await supabase.from("weekly_summary")
      .select("retailer, week_start, week_end, sales_value");
    if (error) throw error;

    const today = new Date();
    today.setUTCHours(0, 0, 0, 0);
    const monthKey = (d: Date) => `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;

    type ChanAgg = Record<string, number>;
    const recvByChan: ChanAgg = {};
    let recvTotal = 0;
    const months = new Map<string, { total: number; byChannel: ChanAgg }>();

    for (const r of data ?? []) {
      const net = Number(r.sales_value ?? 0) * netFactor(r.retailer);
      if (net <= 0) continue;
      const vade = CHANNEL_TERMS[r.retailer]?.vadeDays ?? 60;
      const pay = new Date((r.week_end ?? r.week_start) + "T00:00:00Z");
      pay.setUTCDate(pay.getUTCDate() + vade);
      if (pay < today) continue; // geçmiş vade → tahsil edilmiş varsay
      recvTotal += net;
      recvByChan[r.retailer] = (recvByChan[r.retailer] ?? 0) + net;
      const mk = monthKey(pay);
      const m = months.get(mk) ?? { total: 0, byChannel: {} };
      m.total += net;
      m.byChannel[r.retailer] = (m.byChannel[r.retailer] ?? 0) + net;
      months.set(mk, m);
    }

    const monthRows = [...months.entries()]
      .sort((a, b) => (a[0] < b[0] ? -1 : 1))
      .slice(0, 8) // önümüzdeki ~2 çeyrek yeter — kuyruk tahmini zayıflar
      .map(([mk, v]) => {
        const [y, mo] = mk.split("-").map(Number);
        return {
          month: mk,
          label: `${AY[mo]} ${y}`,
          total: Math.round(v.total),
          byChannel: Object.fromEntries(Object.entries(v.byChannel).map(([k, n]) => [k, Math.round(n)])),
        };
      });

    return NextResponse.json({
      asOf: today.toISOString().slice(0, 10),
      receivable: {
        total: Math.round(recvTotal),
        byChannel: Object.entries(recvByChan)
          .map(([retailer, amount]) => ({ retailer, amount: Math.round(amount), vadeDays: CHANNEL_TERMS[retailer]?.vadeDays ?? null }))
          .sort((a, b) => b.amount - a.amount),
      },
      months: monthRows,
    });
  } catch (e: any) {
    console.error("cashflow hatası:", e);
    return NextResponse.json({ error: "Sunucu hatası" }, { status: 500 });
  }
}
