import { NextRequest, NextResponse } from "next/server";
import { supabase, fetchAllRows } from "@/lib/supabase";
import { globalRankings, categoryBreakdown, productKey, type FactRow } from "@/lib/compute";
import { getApprovedAliases } from "@/lib/aliases";
import { netFactor } from "@/lib/margins";
import { toNetFacts, SKU_COLS } from "@/lib/rows";
import { isWeek, isRetailer, badRequest, optionalWeek } from "@/lib/params";
import { RETAILERS } from "@/lib/normalizers/types";
import { sonTamamlanmisHafta, gecikmeHaftasi } from "@/lib/compute";

export const runtime = "nodejs";
export const revalidate = 0;
export const maxDuration = 60;

export async function GET(req: NextRequest) {
  const sp = new URL(req.url).searchParams;
  const week = optionalWeek(sp.get("week"));
  if (week === null) return badRequest("week geçerli tarih olmalı (YYYY-MM-DD)");
  const metric = sp.get("metric") === "qty" ? "qty" : "value"; // büyüme bazı — varsayılan ciro
  try {
    // Hafta seçici için tüm haftalar (yeni → eski)
    const { data: wkRows } = await supabase.from("weekly_summary").select("week_start, retailer");
    const allWeeks = [...new Set((wkRows ?? []).map((w) => w.week_start))].sort().reverse();
    // Firma → en son raporladığı hafta. Eksik firmanın kaç hafta geride olduğunu
    // söyleyebilmek için gerekli; "yok" demekle "eski" demek aynı şey değil.
    const sonHafta = new Map<string, string>();
    for (const w of wkRows ?? []) {
      const c = sonHafta.get(w.retailer);
      if (!c || w.week_start > c) sonHafta.set(w.retailer, w.week_start);
    }

    // Gösterilecek hafta = seçili hafta; yoksa en güncel hafta.
    const focus = week || allWeeks[0] || null;
    // Geçen hafta = seçili haftanın tam 7 gün öncesi (kanonik Pazartesi).
    let prevWeek: string | null = null;
    if (focus) {
      const pd = new Date(focus + "T00:00:00Z");
      pd.setUTCDate(pd.getUTCDate() - 7);
      prevWeek = pd.toISOString().slice(0, 10);
    }

    const aliases = await getApprovedAliases(); // onaylı Toyzz vb. → barkod
    let latestRows: FactRow[] = [];
    const prevByKey = new Map<string, { qty: number; val: number }>();
    if (focus) {
      // HIZ: tüm firmaların o haftasını TEK sorguda çek (sku_weekly'de yalnız
      // veri olan firma-hafta kombinasyonu var → STRICT davranış kendiliğinden).
      const lr = await fetchAllRows((from, to) =>
        supabase.from("sku_weekly").select(SKU_COLS)
          .eq("week_start", focus).order("retailer").order("sku_name").range(from, to)
      );
      latestRows = toNetFacts(lr); // ciro → net kazanç
      if (prevWeek) {
        const pr = await fetchAllRows((from, to) =>
          supabase.from("sku_weekly").select("retailer, sku_name, barkod, sales_qty, sales_value")
            .eq("week_start", prevWeek).order("retailer").order("sku_name").range(from, to)
        );
        for (const r of pr) {
          const k = productKey(r.retailer, r.sku_name, r.barkod, aliases);
          const e = prevByKey.get(k) ?? { qty: 0, val: 0 };
          e.qty += Number(r.sales_qty); e.val += Number(r.sales_value ?? 0) * netFactor(r.retailer);
          prevByKey.set(k, e);
        }
      }
    }
    // KAPSAM KÜNYESİ. Bu sıralama TEK BİR HAFTANIN kesitidir ve o hafta herkes
    // rapor göndermemiş olabilir. Raporlamayan firma tabloda hiç görünmediği için
    // ekran "bu firmanın satan ürünü yok" gibi okunuyordu; oysa doğrusu "bu
    // firmanın o haftası elimizde yok". İkisi farklı ve karar değiştiriyor.
    const varOlan = [...new Set(latestRows.map((r) => r.retailer))];
    const takvimHaftasi = sonTamamlanmisHafta(new Date());
    const eksik = RETAILERS
      .filter((r) => !varOlan.includes(r))
      .map((r) => ({ retailer: r, gecikmeHf: gecikmeHaftasi(sonHafta.get(r) ?? null, focus ?? takvimHaftasi), sonVeri: sonHafta.get(r) ?? null }));
    const kapsam = { firmalar: varOlan.sort(), eksik, toplam: RETAILERS.length };

    const rankings = globalRankings(latestRows, prevByKey, metric, aliases);
    const categories = {
      brand: categoryBreakdown(latestRows, "brand"),
      team: categoryBreakdown(latestRows, "team"),
      type: categoryBreakdown(latestRows, "type"),
    };
    return NextResponse.json({ ...rankings, categories, weeks: allWeeks, week: focus, metric, kapsam });
  } catch (e: any) {
    console.error("rankings hatası:", e);
    return NextResponse.json({ error: "Sunucu hatası" }, { status: 500 });
  }
}
