import { NextRequest, NextResponse } from "next/server";
import { supabase, fetchAllRows } from "@/lib/supabase";
import { pivotProduct } from "@/lib/compute";
import { toNetFacts, SKU_COLS } from "@/lib/rows";

export const runtime = "nodejs";
export const revalidate = 0;

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const q = searchParams.get("q");
  const barkod = searchParams.get("barkod");
  try {
    if (barkod) {
      const SEL = SKU_COLS;
      let rows = await fetchAllRows((from, to) =>
        supabase.from("sku_weekly").select(SEL).eq("barkod", barkod).order("sku_name").range(from, to)
      );
      // Onaylı alias'la bu barkoda bağlı barkodsuz kalemler (ör. Toyzz) de dahil
      const { data: al } = await supabase.from("product_alias")
        .select("retailer, sku_name").eq("barkod", barkod).eq("status", "approved");
      for (const a of al ?? []) {
        const extra = await fetchAllRows((from, to) =>
          supabase.from("sku_weekly").select(SEL)
            .eq("retailer", a.retailer).eq("sku_name", a.sku_name).is("barkod", null).order("sku_name").range(from, to)
        );
        rows = rows.concat(extra);
      }
      const pivot = pivotProduct(toNetFacts(rows));
      return NextResponse.json({ barkod, ...pivot });
    }
    if (q && q.length >= 2) {
      const { data: rows } = await supabase
        .from("sku_weekly").select("barkod, sku_name, retailer")
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
