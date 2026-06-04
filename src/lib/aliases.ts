// Onaylanmış ürün takma-adları (Toyzz vb. barkodsuz → kanonik barkod).
// Yalnız status='approved' olanlar; ürün kimliği resolver'ında kullanılır.
import { supabase } from "./supabase";
import type { AliasMap } from "./compute";

export async function getApprovedAliases(): Promise<AliasMap> {
  const m: AliasMap = new Map();
  try {
    const { data } = await supabase
      .from("product_alias")
      .select("retailer, sku_name, barkod")
      .eq("status", "approved");
    for (const a of data ?? []) if (a.barkod) m.set(`${a.retailer}|${a.sku_name}`, a.barkod);
  } catch (e) {
    console.warn("alias okunamadı:", e);
  }
  return m;
}
