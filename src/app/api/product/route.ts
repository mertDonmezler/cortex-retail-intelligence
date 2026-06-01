import { NextRequest, NextResponse } from "next/server";
import { supabase, fetchAllRows } from "@/lib/supabase";
import { pivotProduct, type FactRow } from "@/lib/compute";

export const runtime = "nodejs";
export const revalidate = 0;

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const q = searchParams.get("q");
  const barkod = searchParams.get("barkod");
  try {
    if (barkod) {
      const rows = await fetchAllRows((from, to) =>
        supabase
          .from("fact_weekly")
          .select("retailer, week_start, store, sku_name, barkod, sales_qty, sales_value, stock_qty")
          .eq("barkod", barkod).order("id").range(from, to)
      );
      const facts: FactRow[] = rows.map((r) => ({
        retailer: r.retailer, week_start: r.week_start, store: r.store ?? null,
        sku_name: r.sku_name, barkod: r.barkod ?? null,
        sales_qty: Number(r.sales_qty),
        sales_value: r.sales_value != null ? Number(r.sales_value) : null,
        stock_qty: Number(r.stock_qty),
      }));
      const pivot = pivotProduct(facts);
      return NextResponse.json({ barkod, ...pivot });
    }
    if (q && q.length >= 2) {
      const { data: rows } = await supabase
        .from("fact_weekly").select("barkod, sku_name, retailer")
        .ilike("sku_name", `%${q}%`).not("barkod", "is", null).limit(500);
      const seen = new Map<string, { barkod: string; names: Set<string>; retailers: Set<string> }>();
      for (const r of rows ?? []) {
        if (!r.barkod) continue;
        let e = seen.get(r.barkod);
        if (!e) { e = { barkod: r.barkod, names: new Set(), retailers: new Set() }; seen.set(r.barkod, e); }
        e.names.add(r.sku_name); e.retailers.add(r.retailer);
      }
      const results = [...seen.values()].slice(0, 30).map((e) => ({
        barkod: e.barkod, name: [...e.names][0], retailers: [...e.retailers],
      }));
      return NextResponse.json({ results });
    }
    return NextResponse.json({ results: [] });
  } catch (e: any) {
    console.error("product route hatası:", e);
    return NextResponse.json({ error: "Sunucu hatası" }, { status: 500 });
  }
}
