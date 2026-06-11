import { NextRequest, NextResponse } from "next/server";
import { supabase, fetchAllRows } from "@/lib/supabase";
import {
  coverageStatus, groupDeadStock, computeCoverage, summarizeCoverage,
  type CoverageItem, type CoverageRow,
} from "@/lib/compute";

export const runtime = "nodejs";
export const revalidate = 0;
export const maxDuration = 60;

// Tek "Stok" merkezi API'si.
//
// 1) Parametresiz (ağ geneli) — varsayılan davranış:
//    product_coverage matview'inden firma×ürün coverage satırları + durum
//    (az stok/kritik, fazla, sağlıklı). Aynı sorgudan ürün bazında firmalar
//    arası birleştirilmiş "ölü stok" görünümü (products) de üretilir.
//    Filtreleme (firma seçimi, durum, arama, ölü stok eşiği) istemcide.
//
// 2) ?retailer=X (+ opsiyonel ?store=Y) — anlık coverage:
//    Belirli bir firma/mağaza için stok süresi (coverage). store verilmezse
//    firma geneli (sku_coverage matview); verilirse o mağazanın fact_weekly
//    satırlarından anlık hesap (computeCoverage). { summary, skus } döner.
export async function GET(req: NextRequest) {
  const sp = new URL(req.url).searchParams;
  const retailer = sp.get("retailer");
  const store = sp.get("store") || null;

  // ── 2) Firma / mağaza özelinde anlık coverage ──
  if (retailer) {
    try {
      let rows: CoverageRow[];
      if (store) {
        // Mağaza bazlı: tek mağazanın tüm haftalık satırları → anlık coverage
        const facts = await fetchAllRows<{ sku_name: string; week_start: string; sales_qty: number; stock_qty: number }>(
          (from, to) =>
            supabase.from("fact_weekly")
              .select("sku_name, week_start, sales_qty, stock_qty")
              .eq("retailer", retailer).eq("store", store).order("id").range(from, to)
        );
        rows = computeCoverage(facts);
      } else {
        // Firma geneli: önceden hesaplanmış matview
        const { data, error } = await supabase
          .from("sku_coverage")
          .select("sku_name, avg_weekly, last_stock, coverage_weeks")
          .eq("retailer", retailer);
        if (error) throw error;
        rows = (data ?? []).map((r) => ({
          sku_name: r.sku_name,
          avg_weekly: Number(r.avg_weekly),
          last_stock: Number(r.last_stock),
          coverage: r.coverage_weeks == null ? null : Number(r.coverage_weeks),
        }));
      }
      const { skus, summary } = summarizeCoverage(rows);
      return NextResponse.json({ scope: store ? "magaza" : "firma", retailer, store, summary, skus });
    } catch (e: any) {
      console.error("stock (coverage) hatası:", e);
      return NextResponse.json({ error: "Sunucu hatası" }, { status: 500 });
    }
  }

  // ── 1) Ağ geneli birleşik stok durumu + ölü stok ──
  try {
    const rows = await fetchAllRows<any>((from, to) =>
      supabase.from("product_coverage")
        .select("retailer, product_key, barkod, sku_name, avg_weekly, last_stock, coverage_weeks, psf")
        .order("product_key").order("retailer").range(from, to)
    );

    // Birleşik stok durumu listesi (durum taşımayanlar elenir)
    const items = rows
      .map((r) => {
        const avg = Number(r.avg_weekly ?? 0);
        const stock = Number(r.last_stock ?? 0);
        const cov = r.coverage_weeks == null ? null : Number(r.coverage_weeks);
        const psf = Number(r.psf ?? 0);
        return {
          retailer: r.retailer,
          sku_name: r.sku_name ?? "",
          barkod: r.barkod ?? null,
          avg_weekly: avg,
          last_stock: stock,
          coverage: cov,
          psf,
          stock_value: Math.round(stock * psf), // PSF bazlı bağlı stok değeri
          status: coverageStatus(cov, avg, stock),
        };
      })
      .filter((it) => it.status !== "yok");
    const firms = [...new Set(items.map((i) => i.retailer))].sort();
    const counts = {
      kritik: items.filter((i) => i.status === "kritik").length,
      fazla: items.filter((i) => i.status === "fazla").length,
      saglikli: items.filter((i) => i.status === "saglikli").length,
    };

    // Ölü stok: ürün bazında firmalar arası birleştirilmiş görünüm
    const deadItems: CoverageItem[] = rows.map((r) => ({
      retailer: r.retailer,
      product_key: r.product_key,
      barkod: r.barkod ?? null,
      sku_name: r.sku_name ?? "",
      avg_weekly: Number(r.avg_weekly ?? 0),
      last_stock: Number(r.last_stock ?? 0),
      coverage_weeks: r.coverage_weeks == null ? null : Number(r.coverage_weeks),
    }));
    const products = groupDeadStock(deadItems);

    return NextResponse.json({ items, firms, counts, products });
  } catch (e: any) {
    console.error("stock hatası:", e);
    return NextResponse.json({ error: "Sunucu hatası" }, { status: 500 });
  }
}
