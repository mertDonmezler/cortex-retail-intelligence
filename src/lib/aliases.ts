// Onaylanmış ürün takma-adları (Toyzz vb. barkodsuz → kanonik barkod).
// Yalnız status='approved' olanlar; ürün kimliği resolver'ında kullanılır.
import { supabase, fetchAllRows } from "./supabase";
import type { AliasMap } from "./compute";

// SAYFALAMA ŞART: düz select PostgREST'in ~1000 satır limitinde SESSİZCE kırpılır.
// Tablo bugün 174 satır, ama 1000'i geçtiği gün fazlası hiç gelmeyeceği için
// firmalar-arası ürün birleştirme sessizce bozulur — rankings/compare/export/
// product hepsi bu map'e bağlı, hata da vermez, sadece aynı ürün iki ayrı ürün
// gibi görünür. Bu yüzden fetchAllRows ile tam çekiyoruz.
// Sıra product_alias'ın benzersiz anahtarı (retailer, sku_name) üzerinden —
// tek kolonla sıralamak sayfa sınırında satır çakışmasına açık olurdu.
export async function getApprovedAliases(): Promise<AliasMap> {
  const m: AliasMap = new Map();
  try {
    const rows = await fetchAllRows<{ retailer: string; sku_name: string; barkod: string | null }>(
      (from, to) =>
        supabase
          .from("product_alias")
          .select("retailer, sku_name, barkod")
          .eq("status", "approved")
          .order("retailer")
          .order("sku_name")
          .range(from, to),
      { label: "product_alias (onaylı)" }
    );
    for (const a of rows) if (a.barkod) m.set(`${a.retailer}|${a.sku_name}`, a.barkod);
  } catch (e) {
    console.warn("alias okunamadı:", e);
  }
  return m;
}
