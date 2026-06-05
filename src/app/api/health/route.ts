import { NextResponse } from "next/server";
import { supabase } from "@/lib/supabase";

export const runtime = "nodejs";
export const revalidate = 0;
export const maxDuration = 30;

// VERİ SAĞLIĞI BEKÇİSİ — denetim bulgularını kalıcı, otomatik izlemeye çevirir.
// Ham satır çekmez; PostgREST head+count ile ucuz sayım yapar (+ küçük örnekler).
type Severity = "high" | "med" | "low" | "info";
interface Issue { id: string; severity: Severity; label: string; count: number; hint: string; examples?: string[] }

async function count(q: any): Promise<number> {
  try { const { count } = await q; return count ?? 0; } catch { return 0; }
}
const f = () => supabase.from("fact_weekly").select("*", { count: "exact", head: true });

// ISO Pazartesi haftaları arasını 7'şer gün adımla (eksik hafta tespiti).
function weeksBetween(min: string, max: string): string[] {
  const out: string[] = [];
  const d = new Date(min + "T00:00:00Z"); const end = new Date(max + "T00:00:00Z");
  let guard = 0;
  while (d <= end && guard++ < 400) { out.push(d.toISOString().slice(0, 10)); d.setUTCDate(d.getUTCDate() + 7); }
  return out;
}

export async function GET() {
  try {
    const [nullVal, negStock, negSales, placeholder, mojibake, toyzzPending] = await Promise.all([
      count(f().is("sales_value", null).gt("sales_qty", 0)),
      count(f().lt("stock_qty", 0)),
      count(f().lt("sales_qty", 0)),
      count(f().ilike("sku_name", "%KULLANILMAYACAK%")),
      count(f().ilike("sku_name", "%?%")),
      count(supabase.from("product_alias").select("*", { count: "exact", head: true }).eq("retailer", "Toyzz").eq("status", "suggested")),
    ]);

    // Örnekler (yalnız sorun varsa, küçük)
    let nullValEx: string[] = [];
    if (nullVal > 0) {
      const { data } = await supabase.from("fact_weekly")
        .select("retailer,sku_name,week_start,sales_qty").is("sales_value", null).gt("sales_qty", 0)
        .order("sales_qty", { ascending: false }).limit(3);
      nullValEx = (data ?? []).map((r: any) => `${r.retailer} · ${String(r.sku_name).slice(0, 40)} · ${r.week_start} (${r.sales_qty} adet)`);
    }

    // Tazelik + eksik hafta (weekly_summary küçük: ~firma×hafta)
    const { data: ws } = await supabase.from("weekly_summary").select("retailer,week_start");
    const byRet = new Map<string, string[]>();
    let networkLatest = "";
    for (const r of ws ?? []) {
      (byRet.get(r.retailer) ?? byRet.set(r.retailer, []).get(r.retailer)!).push(r.week_start);
      if (r.week_start > networkLatest) networkLatest = r.week_start;
    }
    const stale: string[] = []; let gapTotal = 0; const gapEx: string[] = [];
    for (const [ret, weeks] of byRet) {
      const sorted = [...new Set(weeks)].sort();
      const latest = sorted[sorted.length - 1];
      if (networkLatest && latest < networkLatest) {
        const lag = Math.round((Date.parse(networkLatest) - Date.parse(latest)) / 6048e5);
        stale.push(`${ret} · ${lag} hafta geride (son: ${latest})`);
      }
      const expected = weeksBetween(sorted[0], latest);
      const have = new Set(sorted);
      const miss = expected.filter((w) => !have.has(w));
      if (miss.length) { gapTotal += miss.length; gapEx.push(`${ret}: ${miss.length} eksik (${miss.slice(0, 2).join(", ")}${miss.length > 2 ? "…" : ""})`); }
    }

    const issues: Issue[] = [];
    if (nullVal > 0) issues.push({ id: "null_value", severity: "high", label: "Satış var ama ciro NULL (sessiz ciro kaybı)", count: nullVal, hint: "Kaynak PSF/fiyat eşlemesi eksik — bu kalemler ciroda görünmez.", examples: nullValEx });
    if (stale.length) issues.push({ id: "stale", severity: "high", label: "Bayat perakendeci (güncel haftası eksik)", count: stale.length, hint: "Bu firma(lar) son haftayı göndermemiş olabilir.", examples: stale });
    if (gapTotal > 0) issues.push({ id: "gaps", severity: "med", label: "Eksik hafta (veri serisinde boşluk)", count: gapTotal, hint: "Aradaki bazı haftaların verisi hiç yüklenmemiş.", examples: gapEx });
    if (negStock > 0) issues.push({ id: "neg_stock", severity: "med", label: "Negatif stok", count: negStock, hint: "Fiziksel olarak anlamsız; kaynak/ETL düzeltmesi veya 0'a sabitleme." });
    if (negSales > 0) issues.push({ id: "neg_sales", severity: "info", label: "Negatif satış (iade/düzeltme)", count: negSales, hint: "Gerçek iade/düzeltme satırları — veri doğru, bilgi amaçlı." });
    if (placeholder > 0) issues.push({ id: "placeholder", severity: "low", label: "Placeholder SKU (***KULLANILMAYACAK***)", count: placeholder, hint: "Kaynak listeden gelen ölü kayıt; raporlardan elenmeli." });
    if (mojibake > 0) issues.push({ id: "mojibake", severity: "low", label: "Şüpheli karakterli ad (mojibake / ?)", count: mojibake, hint: "Türkçe karakter kodlama bozukluğu; aynı ürün farklı yazımlara bölünebilir." });
    if (toyzzPending > 0) issues.push({ id: "toyzz_ean", severity: "info", label: "Toyzz EAN önerisi onay bekliyor", count: toyzzPending, hint: "/eslesme sayfasında aday seçip onayla → firmalar-arası birleşir." });

    // Skor: high −20, med −8, low −2 (info nötr).
    let score = 100;
    for (const i of issues) score -= i.severity === "high" ? 20 : i.severity === "med" ? 8 : i.severity === "low" ? 2 : 0;
    score = Math.max(0, Math.min(100, score));

    return NextResponse.json({
      score,
      latestWeek: networkLatest || null,
      retailers: { total: byRet.size, stale: stale.length },
      issues,
    });
  } catch (e: any) {
    console.error("health hatası:", e);
    return NextResponse.json({ error: "Sunucu hatası" }, { status: 500 });
  }
}
