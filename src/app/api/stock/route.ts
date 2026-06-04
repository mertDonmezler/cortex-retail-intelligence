import { NextResponse } from "next/server";
import { supabase, fetchAllRows } from "@/lib/supabase";
import { coverageStatus } from "@/lib/compute";

export const runtime = "nodejs";
export const revalidate = 0;
export const maxDuration = 60;

// Birleşik stok durumu (tüm firmalar tek listede): product_coverage matview'inden
// firma×ürün coverage satırları + durum (az stok/kritik, fazla, sağlıklı).
// Filtreleme (firma seçimi, durum, arama) istemcide.
export async function GET() {
  try {
    const rows = await fetchAllRows<any>((from, to) =>
      supabase.from("product_coverage")
        .select("retailer, sku_name, barkod, avg_weekly, last_stock, coverage_weeks")
        .order("retailer").range(from, to)
    );
    const items = rows
      .map((r) => {
        const avg = Number(r.avg_weekly ?? 0);
        const stock = Number(r.last_stock ?? 0);
        const cov = r.coverage_weeks == null ? null : Number(r.coverage_weeks);
        return {
          retailer: r.retailer,
          sku_name: r.sku_name ?? "",
          barkod: r.barkod ?? null,
          avg_weekly: avg,
          last_stock: stock,
          coverage: cov,
          status: coverageStatus(cov, avg, stock),
        };
      })
      .filter((it) => it.status !== "yok"); // sinyal taşımayanları ele
    const firms = [...new Set(items.map((i) => i.retailer))].sort();
    const counts = {
      kritik: items.filter((i) => i.status === "kritik").length,
      fazla: items.filter((i) => i.status === "fazla").length,
      saglikli: items.filter((i) => i.status === "saglikli").length,
    };
    return NextResponse.json({ items, firms, counts });
  } catch (e: any) {
    console.error("stock hatası:", e);
    return NextResponse.json({ error: "Sunucu hatası" }, { status: 500 });
  }
}
