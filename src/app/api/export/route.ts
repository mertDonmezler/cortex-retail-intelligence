import { NextRequest, NextResponse } from "next/server";
import { supabase, fetchAllRows } from "@/lib/supabase";
import * as XLSX from "xlsx";
import {
  execOverview, globalRankings, categoryBreakdown, type FactRow,
} from "@/lib/compute";
import { getApprovedAliases } from "@/lib/aliases";
import { toNetFacts, toNetSummary, SKU_COLS } from "@/lib/rows";
import { isWeek, isRetailer, badRequest, optionalWeek } from "@/lib/params";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

// Çok-sayfalı Excel raporu üretir: Özet, Haftalık, Sıralamalar, Kategoriler.
export async function GET(req: NextRequest) {
  const week = optionalWeek(new URL(req.url).searchParams.get("week"));
  if (week === null) return badRequest("week geçerli tarih olmalı (YYYY-MM-DD)");
  try {
    const { data: summaryRaw } = await supabase
      .from("weekly_summary").select("*").order("week_start", { ascending: true });
    // Ciro net kazanca çevrilir (çalışma marjı + KDV); adet/stok ham kalır.
    const summary = toNetSummary(summaryRaw ?? []);

    const exec = execOverview(summary, week);
    const wb = XLSX.utils.book_new();

    // 1) Yönetici Özeti
    const execRows: any[][] = [
      ["CORTEX — Yönetici Özeti"],
      ["Hafta", exec.latest_week ?? "-"],
      [],
      ["AĞ TOPLAMI"],
      ["Satış (adet)", Math.round(exec.network.sales_qty)],
      ["Net kazanç (TL)", Math.round(exec.network.sales_value)],
      ["Stok (adet)", Math.round(exec.network.stock_qty)],
      ["WoW Satış (adet) %", exec.network.wow_qty != null ? exec.network.wow_qty.toFixed(1) : "-"],
      ["WoW Net kazanç (TL) %", exec.network.wow_value != null ? exec.network.wow_value.toFixed(1) : "-"],
      // DOSYA DISARIYA CIKIYOR. Ekranlarin hepsi "NET CIRO"/"net karsilik" diye
      // isaretliyordu, yalniz indirilen Excel ciplak "Ciro" diyordu; raf cirosu
      // 1.000.000 TL olan bir kanal dosyada 434.000 gorunuyor ve muhasebe/ortak
      // bunu satis cirosu saniyor. Basliklar duzeltildi, ustune tek satir not.
      ["Not", "Tutarlar NET KAZANÇTIR: kanal marjı ve KDV düşülmüş. Brüt PSF cirosu değildir."],
      [],
      ["PERAKENDECİ", "Satış (adet)", "Net kazanç (TL)", "Adet WoW %", "TL WoW %", "Adet payı %"],
      ...exec.retailers.map((r) =>
        r.has_data
          ? [r.retailer, Math.round(r.sales_qty), r.sales_value != null ? Math.round(r.sales_value) : "-",
             r.wow != null ? r.wow.toFixed(1) : "-", r.value_wow != null ? r.value_wow.toFixed(1) : "-", r.share.toFixed(1)]
          : [r.retailer, "veri yok", "", "", "", ""]
      ),
    ];
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(execRows), "Yönetici Özeti");

    // 2) Haftalık (tüm summary)
    const weeklyRows = [
      ["Perakendeci", "Hafta", "Satış", "Net kazanç", "Stok", "SKU", "Mağaza"],
      ...summary.map((s) => [
        s.retailer, s.week_start, Math.round(s.sales_qty),
        s.sales_value != null ? Math.round(s.sales_value) : "", Math.round(s.stock_qty),
        s.sku_count, s.store_count,
      ]),
    ];
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(weeklyRows), "Haftalık");

    // 3) Sıralamalar (global top) — STRICT: yalnızca seçili/güncel hafta (as-of yok)
    const focus = week ?? exec.latest_week ?? undefined;
    let latestRows: FactRow[] = [];
    const prevByKey = new Map<string, { qty: number; val: number }>();
    if (focus) {
      // HIZ: tüm firmaların haftasını TEK sku_weekly sorgusunda çek (rankings kalıbı).
      // Eskiden perakendeci başına ayrı fact_weekly sorgusu (N+1) + eski mağaza-bazlı
      // haftalarda on binlerce satır sayfalanıyordu.
      const lr = await fetchAllRows((from, to) =>
        supabase.from("sku_weekly").select(SKU_COLS)
          .eq("week_start", focus).order("retailer").order("sku_name").range(from, to)
      );
      latestRows = toNetFacts(lr);
    }
    const aliases = await getApprovedAliases();
    const { top } = globalRankings(latestRows, prevByKey, "value", aliases);
    const topRows = [
      ["#", "Ürün", "Firmalar", "Satış", "Net kazanç"],
      ...top.map((r, i) => [i + 1, r.sku_name, (r.retailers ?? []).join(", "), Math.round(r.sales_qty), Math.round(r.sales_value)]),
    ];
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(topRows), "En Çok Satan");

    // 4) Kategoriler
    for (const [dim, label] of [["team", "Takım"], ["brand", "Marka"], ["type", "Tip"]] as const) {
      const cats = categoryBreakdown(latestRows, dim);
      const catRows = [[label, "Satış", "Net kazanç", "SKU"], ...cats.map((c) => [c.key, Math.round(c.sales_qty), Math.round(c.sales_value), c.sku_count])];
      XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(catRows), `Kategori-${label}`);
    }

    const buf = XLSX.write(wb, { type: "buffer", bookType: "xlsx" });
    const tag = week ?? new Date().toISOString().slice(0, 10);
    return new NextResponse(buf, {
      headers: {
        "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "Content-Disposition": `attachment; filename="cortex-rapor-${tag}.xlsx"`,
      },
    });
  } catch (e: any) {
    console.error("export hatası:", e);
    return NextResponse.json({ error: "Sunucu hatası" }, { status: 500 });
  }
}
