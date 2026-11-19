// GEÇEN YIL ARŞİVİ — fact_weekly_arsiv'e yazma ve "geçen yıl bu hafta" okuma.
//
// Arşiv AYRI tablo (supabase/arsiv.sql): canlı hesapların bir kısmı
// fact_weekly'nin tüm geçmişine bakıyor (kapsam ortalamaları, eksik hafta
// sağlığı, aylık özet). Geçen yılın haftaları oraya girerse bugünkü
// sınıflandırmalar sessizce değişirdi. Arşivi yalnız yıl kıyası okur.
//
// Satırlar ÜRÜN düzeyinde tutulur (mağaza kırılımı toplanır): D&R 30 Mart
// 2026'dan beri mağaza göndermediği için mağaza bazlı yıl kıyası zaten mümkün
// değil, 2025 D&R dosyaları ise mağaza bazında 16-40 bin satır/hafta.
import type { SupabaseClient } from "@supabase/supabase-js";
import type { UnifiedRow } from "./normalizers/types";
import { fetchAllRows } from "./supabase";

export const ARSIV = "fact_weekly_arsiv";

/** Arşive yazılabilecek en yeni hafta: bugünden en az bu kadar gün önce. Canlı
 *  haftanın yanlışlıkla arşive gitmesini engeller. */
export const ARSIV_MIN_GUN = 26 * 7;

/** 52 hafta geri: aynı ISO haftası, aynı gün (Pazartesi → Pazartesi). */
export function gecenYilHaftasi(week: string): string {
  const d = new Date(week + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() - 364);
  return d.toISOString().slice(0, 10);
}

export function haftaKaydir(week: string, gun: number): string {
  const d = new Date(week + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + gun);
  return d.toISOString().slice(0, 10);
}

/** Mağaza kırılımını çökert: ürün × hafta tek satır. */
export function urunDuzeyine(rows: UnifiedRow[]): UnifiedRow[] {
  const m = new Map<string, UnifiedRow>();
  for (const r of rows) {
    const k = `${r.week_start}|${r.sku_name}|${r.barkod ?? ""}|${r.sku_id ?? ""}`;
    const o = m.get(k);
    if (!o) { m.set(k, { ...r, store: null }); continue; }
    o.sales_qty += r.sales_qty;
    o.stock_qty += r.stock_qty;
    o.sales_value = o.sales_value == null && r.sales_value == null ? null : (o.sales_value ?? 0) + (r.sales_value ?? 0);
    o.price ??= r.price;
  }
  return [...m.values()];
}

export type YilSatiri = {
  retailer: string; week_start: string; sku_name: string; barkod: string | null;
  sales_qty: number; sales_value: number | null; stock_qty: number;
};

const ARSIV_COLS = "retailer, week_start, sku_name, barkod, sales_qty, sales_value, stock_qty";

/**
 * Verilen haftaların satırları — önce arşiv, arşivde olmayan (firma, hafta)
 * dilimleri için canlı sku_weekly. Aralık 2026'dan itibaren geçen yılın aynı
 * haftası canlı veride de bulunacak; o zaman arşive gerek kalmadan çalışır.
 * Arşiv tablosu yoksa (SQL henüz çalıştırılmadı) sessizce canlıya düşer.
 */
export async function haftaSatirlari(db: SupabaseClient, weeks: string[]): Promise<YilSatiri[]> {
  if (!weeks.length) return [];
  let arsiv: YilSatiri[] = [];
  try {
    arsiv = await fetchAllRows<YilSatiri>(
      (from, to) => db.from(ARSIV).select(ARSIV_COLS).in("week_start", weeks)
        .order("retailer").order("week_start").order("id").range(from, to),
      { label: "arşiv" }
    );
  } catch (e: any) {
    console.warn("arşiv okunamadı (tablo yok olabilir):", e?.message ?? e);
  }
  const arsivde = new Set(arsiv.map((r) => `${r.retailer}|${r.week_start}`));
  const canli = await fetchAllRows<YilSatiri>(
    (from, to) => db.from("sku_weekly").select(ARSIV_COLS).in("week_start", weeks)
      .order("retailer").order("week_start").order("sku_name").range(from, to),
    { label: "yıl kıyası sku_weekly" }
  );
  const sayi = (r: YilSatiri): YilSatiri => ({
    ...r, sales_qty: Number(r.sales_qty) || 0, stock_qty: Number(r.stock_qty) || 0,
    sales_value: r.sales_value == null ? null : Number(r.sales_value),
  });
  return [...arsiv, ...canli.filter((r) => !arsivde.has(`${r.retailer}|${r.week_start}`))].map(sayi);
}
