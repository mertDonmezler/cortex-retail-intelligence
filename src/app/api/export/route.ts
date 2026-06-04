import { NextRequest, NextResponse } from "next/server";
import { supabase, fetchAllRows } from "@/lib/supabase";
import * as XLSX from "xlsx";
import {
  execOverview, globalRankings, categoryBreakdown, type FactRow,
} from "@/lib/compute";
import { RETAILERS } from "@/lib/normalizers/types";
import { getApprovedAliases } from "@/lib/aliases";
import { toNetFacts, toNetSummary, FACT_COLS } from "@/lib/rows";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

// Çok-sayfalı Excel raporu üretir: Özet, Haftalık, Sıralamalar, Kategoriler.
export async function GET(req: NextRequest) {
  const week = new URL(req.url).searchParams.get("week") || undefined;
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
      ["Ciro (TL)", Math.round(exec.network.sales_value)],
      ["Stok (adet)", Math.round(exec.network.stock_qty)],
      ["WoW Satış (adet) %", exec.network.wow_qty != null ? exec.network.wow_qty.toFixed(1) : "-"],
      ["WoW Ciro (TL) %", exec.network.wow_value != null ? exec.network.wow_value.toFixed(1) : "-"],
      [],
      ["PERAKENDECİ", "Satış (adet)", "Ciro (TL)", "Adet WoW %", "TL WoW %", "Pay %"],
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
      ["Perakendeci", "Hafta", "Satış", "Ciro", "Stok", "SKU", "Mağaza"],
      ...summary.map((s) => [
        s.retailer, s.week_start, Math.round(s.sales_qty),
        s.sales_value != null ? Math.round(s.sales_value) : "", Math.round(s.stock_qty),
        s.sku_count, s.store_count,
      ]),
    ];
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(weeklyRows), "Haftalık");

    // 3) Sıralamalar (global top) — STRICT: yalnızca seçili/güncel hafta (as-of yok)
    const focus = week ?? exec.latest_week ?? undefined;
    const latestRows: FactRow[] = [];
    const prevByKey = new Map<string, { qty: number; val: number }>();
    if (focus) for (const retailer of RETAILERS) {
      const lr = await fetchAllRows((from, to) =>
        supabase.from("fact_weekly")
          .select(FACT_COLS)
          .eq("retailer", retailer).eq("week_start", focus).order("id").range(from, to)
      );
      if (!lr.length) continue;
      latestRows.push(...toNetFacts(lr));
    }
    const aliases = await getApprovedAliases();
    const { top } = globalRankings(latestRows, prevByKey, "value", aliases);
    const topRows = [
      ["#", "Ürün", "Firmalar", "Satış", "Ciro"],
      ...top.map((r, i) => [i + 1, r.sku_name, (r.retailers ?? []).join(", "), Math.round(r.sales_qty), Math.round(r.sales_value)]),
    ];
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(topRows), "En Çok Satan");

    // 4) Kategoriler
    for (const [dim, label] of [["team", "Takım"], ["brand", "Marka"], ["type", "Tip"]] as const) {
      const cats = categoryBreakdown(latestRows, dim);
      const catRows = [[label, "Satış", "Ciro", "SKU"], ...cats.map((c) => [c.key, Math.round(c.sales_qty), Math.round(c.sales_value), c.sku_count])];
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
