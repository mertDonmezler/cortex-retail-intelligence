import { NextResponse } from "next/server";
import { supabase, fetchAllRows } from "@/lib/supabase";
import {
  channelSummaries, consignmentKpis, aging, invoicesForChannel,
  reconcileChannels, salesCollectionSchedule, type WeeklyNet,
} from "@/lib/consignment";
import { netFactor } from "@/lib/margins";
import type { ConsignmentLine } from "@/lib/normalizers/types";

export const runtime = "nodejs";
export const revalidate = 0;

export async function GET() {
  try {
    const raw = await fetchAllRows<any>((from, to) =>
      supabase.from("consignment_lines").select("*").order("id").range(from, to)
    );

    const lines: ConsignmentLine[] = raw.map((r) => ({
      retailer: r.retailer,
      cari_adi: r.cari_adi ?? "",
      cari_kodu: r.cari_kodu ?? null,
      invoice_no: r.invoice_no ?? "",
      belge_no: r.belge_no ?? null,
      invoice_date: r.invoice_date ?? "",
      due_date: r.due_date ?? null,
      line_no: r.line_no != null ? Number(r.line_no) : null,
      stock_code: r.stock_code ?? null,
      product_name: r.product_name ?? "",
      ana_grup: r.ana_grup ?? null,
      alt_grup: r.alt_grup ?? null,
      qty: Number(r.qty ?? 0),
      unit_price_net: r.unit_price_net != null ? Number(r.unit_price_net) : null,
      net_amount: Number(r.net_amount ?? 0),
      vat: Number(r.vat ?? 0),
      total: Number(r.total ?? 0),
      source_file: r.source_file ?? "",
    }));

    if (!lines.length) {
      return NextResponse.json({ empty: true });
    }

    // Sunucu günü (date-only, UTC) — vade/yaşlandırma referansı.
    const today = new Date().toISOString().slice(0, 10);

    // Haftalık net sell-through (CORTEX) — sat-öde kanalları için, margins köprüsüyle
    // net kazanca çevrilmiş. Mutabakat (satılan=tahsil edilebilir) ve satışa dayalı
    // tahsilat takvimi bundan beslenir.
    const satodeChannels = new Set(lines.map((l) => l.retailer));
    const weeklyNet: WeeklyNet[] = [];
    try {
      const ws = await fetchAllRows<any>((from, to) =>
        supabase.from("weekly_summary").select("retailer, week_start, sales_value, has_value").order("week_start").range(from, to)
      );
      for (const s of ws) {
        if (!satodeChannels.has(s.retailer) || !s.has_value || s.sales_value == null) continue;
        weeklyNet.push({ retailer: s.retailer, week_start: s.week_start, net: Number(s.sales_value) * netFactor(s.retailer) });
      }
    } catch (e) {
      console.warn("haftalık sell-through alınamadı:", e);
    }

    const channels = channelSummaries(lines, today);
    const invoices: Record<string, ReturnType<typeof invoicesForChannel>> = {};
    for (const c of channels) invoices[c.retailer] = invoicesForChannel(lines, c.retailer);

    const reconcile = reconcileChannels(lines, weeklyNet);
    const salesSchedule = salesCollectionSchedule(weeklyNet, today);

    return NextResponse.json({
      today,
      kpis: consignmentKpis(lines, today),
      reconcile,
      salesSchedule,
      aging: aging(lines, today),
      invoices,
    });
  } catch (e: any) {
    console.error("consignment hatası:", e);
    return NextResponse.json({ error: "Sunucu hatası" }, { status: 500 });
  }
}
