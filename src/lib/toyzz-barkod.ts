// TOYZZ KALEM KODU → BARKOD.
//
// Toyzz 21-27 Eylül 2026'dan itibaren dosyasında barkod gönderiyor; öncesindeki
// 42 hafta barkodsuzdu ve o satırlara barkod Kalem Kodu (sku_id) üzerinden bir
// kez geri işlendi. Bu modül o işlemin KALICI yarısı: eski, barkodsuz bir Toyzz
// haftası panelden ya da `npm run seed` ile yeniden yüklenirse DELETE+INSERT o
// dilimi barkodsuz yazar ve ürün anahtarı (product_coverage: barkod → alias →
// isim) haftalar arasında yeniden ikiye bölünür — geçmiş haftalar eski anahtarla,
// yeni haftalar barkodla. Sonuç: aynı ürün iki kez, eski stok fotoğrafı "hayalet"
// olarak sayılır. Yazmadan önce bu adım boşlukları doldurur.
//
// EŞLEME KAYNAĞI veritabanının kendisi: barkodlu Toyzz satırları. Ayrı tablo ya
// da repoda statik liste yok (repo public; şirket verisi girmez).
//
// AD KORUMASI: anahtar Kalem Kodu + ürün adı. Aynı Kalem Kodu'nun eski adı
// (ör. T02030030 "SEVİMLİ CANAVAR ... 7Lİ" → "LABUBU ... 6LI") kapali-urunler.ts'te
// insan kararıyla kapatılmış bir kalem; kodla birleştirmek onu aktif ürüne
// karıştırırdı. Adı değişmiş satır barkod almaz, eski anahtarında kalır.
import type { SupabaseClient } from "@supabase/supabase-js";
import type { UnifiedRow } from "./normalizers/types";
import { fetchAllRows } from "./supabase";

export type BarkodHaritasi = Map<string, string>;

const anahtar = (skuId: string, ad: string) => `${skuId}|${ad}`;

// En yeni hafta kazanır (Toyzz bir kalemin barkodunu değiştirirse güncel olan).
export async function toyzzBarkodHaritasi(db: SupabaseClient): Promise<BarkodHaritasi> {
  const satirlar = await fetchAllRows<{ sku_id: string | null; sku_name: string; barkod: string }>(
    (from, to) =>
      db.from("fact_weekly")
        .select("sku_id, sku_name, barkod")
        .eq("retailer", "Toyzz")
        .not("barkod", "is", null)
        .order("week_start", { ascending: false })
        .order("id")
        .range(from, to),
    { label: "Toyzz barkod haritası" }
  );
  const m: BarkodHaritasi = new Map();
  for (const r of satirlar) {
    if (!r.sku_id || !r.barkod) continue;
    const k = anahtar(r.sku_id, r.sku_name);
    if (!m.has(k)) m.set(k, r.barkod);
  }
  return m;
}

// Yalnız Toyzz, yalnız barkodu boş satır, yalnız Kalem Kodu + ad eşleşirse.
// Dosyanın kendi barkodu asla ezilmez. Satırları yerinde günceller; kaç satıra
// barkod işlendiğini döner.
export function toyzzBarkodIsle(rows: UnifiedRow[], harita: BarkodHaritasi): number {
  let n = 0;
  for (const r of rows) {
    if (r.retailer !== "Toyzz" || r.barkod || !r.sku_id) continue;
    const b = harita.get(anahtar(r.sku_id, r.sku_name));
    if (b) { r.barkod = b; n++; }
  }
  return n;
}
