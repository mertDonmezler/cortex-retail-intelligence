// Geçici doğrulama: (1) Excel'in kendi toplam satırı vs normalizer toplamı,
// (2) fact_weekly ham toplam vs weekly_summary matview. Sonra silinir.
import { config } from "dotenv"; config({ path: ".env.local" });
import { readFileSync, readdirSync, existsSync } from "fs";
import { join } from "path";
import * as XLSX from "xlsx";
import { createClient } from "@supabase/supabase-js";
import { normalizeFile } from "../src/lib/normalizers";
import type { Retailer } from "../src/lib/normalizers/types";

const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
const FOLDERS: Record<string, Retailer> = { toyzz: "Toyzz", dr: "DR", nezih: "Nezih" };

function readRaw(path: string): Record<string, unknown>[] {
  const wb = XLSX.read(readFileSync(path), { type: "buffer" });
  return XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { defval: null, raw: true });
}
const num = (v: unknown) => { if (v == null || v === "") return 0; const n = typeof v === "number" ? v : parseFloat(String(v).replace(/\./g, "").replace(",", ".")); return isNaN(n) ? 0 : n; };
const numSimple = (v: unknown) => { if (v == null || v === "") return 0; const n = typeof v === "number" ? v : parseFloat(String(v)); return isNaN(n) ? 0 : n; };

// Excel'in kendi toplam satırını bul ve satış/stok değerini çıkar (format-aware).
function excelTotals(rows: Record<string, unknown>[]): { sales: number | null; stock: number | null; note: string } {
  if (!rows.length) return { sales: null, stock: null, note: "boş" };
  const cols = Object.keys(rows[0]);
  const has = (c: string) => cols.includes(c);
  const isTotal = (s: unknown) => /genel\s*toplam|toplamlar|^\s*toplam\s*$/i.test(String(s ?? ""));
  let labelCol = "", salesCol = "", stockCol = "";
  if (has("Magaza")) { labelCol = "Magaza"; salesCol = "Satis Miktar"; stockCol = "Stok Miktar"; }
  else if (has("Kalem Tanımı") || has("Kalem Kodu")) { labelCol = has("Kalem Tanımı") ? "Kalem Tanımı" : "Kalem Kodu"; salesCol = "Toplam Satış Adedi"; stockCol = "Toplam Stok Adedi"; }
  else if (has("Urun") && has("Satis Miktar")) { labelCol = "Urun"; salesCol = "Satis Miktar"; stockCol = "Stok Miktar"; }
  else { labelCol = cols.find((c) => /ürün|urun|adi/i.test(c)) || cols[1] || ""; salesCol = cols.find((c) => /satış|satis|çıkış|cikis/i.test(c)) || ""; stockCol = cols.find((c) => /stok/i.test(c)) || ""; }
  const totalRows = rows.filter((r) => isTotal(r[labelCol]));
  if (!totalRows.length || !salesCol) return { sales: null, stock: null, note: "toplam satırı yok" };
  // Türkçe sayı temizliği yerine ham sayı (Excel'de zaten sayı) — ama metinse basit parse
  const sumCol = (rs: any[], c: string) => rs.reduce((a, r) => a + numSimple(r[c]), 0);
  return { sales: Math.abs(sumCol(totalRows, salesCol)), stock: stockCol ? sumCol(totalRows, stockCol) : null, note: `${totalRows.length} toplam satırı` };
}

(async () => {
  console.log("════════ 1) KAYNAK SADAKATİ: Excel toplam satırı vs normalizer ════════");
  const seedRoot = join(process.cwd(), "seed");
  let mismatches = 0, checked = 0, noTotal = 0;
  for (const [folder, retailer] of Object.entries(FOLDERS)) {
    const dir = join(seedRoot, folder);
    if (!existsSync(dir)) continue;
    for (const file of readdirSync(dir).filter((f) => /\.xlsx?$/i.test(f) && !f.startsWith("~$"))) {
      const path = join(dir, file);
      let normSales = 0, normStock = 0, week = "?";
      try {
        const buf = readFileSync(path); const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
        const rows = normalizeFile(ab as ArrayBuffer, retailer, file);
        normSales = rows.reduce((a, r) => a + r.sales_qty, 0);
        normStock = rows.reduce((a, r) => a + r.stock_qty, 0);
        week = rows[0]?.week_start ?? "?";
      } catch (e: any) { console.log(`  [SKIP] ${folder}/${file}: ${e.message}`); continue; }
      const t = excelTotals(readRaw(path));
      if (t.sales == null) { noTotal++; continue; }
      checked++;
      const sd = Math.abs(t.sales - normSales);
      const std = t.stock == null ? 0 : Math.abs((t.stock ?? 0) - normStock);
      const okSales = sd <= Math.max(1, t.sales * 0.005); // %0.5 tolerans
      const okStock = t.stock == null || std <= Math.max(1, (t.stock || 0) * 0.005);
      if (!okSales || !okStock) {
        mismatches++;
        console.log(`  ✗ ${retailer} ${week} (${file})`);
        console.log(`      SATIŞ: excel-toplam=${t.sales}  normalizer=${normSales}  fark=${sd}`);
        if (!okStock) console.log(`      STOK : excel-toplam=${t.stock}  normalizer=${normStock}  fark=${std}`);
      }
    }
  }
  console.log(`  → ${checked} dosya toplam satırıyla kontrol edildi, ${mismatches} uyuşmazlık, ${noTotal} dosyada toplam satırı yok.`);

  console.log("\n════════ 2) AGREGASYON: fact_weekly ham toplam vs weekly_summary matview ════════");
  // fact_weekly ham toplam (retailer,week) — sayfalı çek
  const factAgg = new Map<string, { qty: number; val: number; stock: number }>();
  for (let from = 0; ; from += 1000) {
    const { data, error } = await db.from("fact_weekly").select("retailer, week_start, sales_qty, sales_value, stock_qty").order("id").range(from, from + 999);
    if (error) { console.log("  fact_weekly çekme hatası:", error.message); break; }
    if (!data || !data.length) break;
    for (const r of data) {
      const k = `${r.retailer}|${r.week_start}`;
      const e = factAgg.get(k) ?? { qty: 0, val: 0, stock: 0 };
      e.qty += Number(r.sales_qty); e.val += Number(r.sales_value ?? 0); e.stock += Number(r.stock_qty);
      factAgg.set(k, e);
    }
    if (data.length < 1000) break;
  }
  const { data: mv } = await db.from("weekly_summary").select("retailer, week_start, sales_qty, sales_value, stock_qty");
  let aggMism = 0;
  for (const m of mv ?? []) {
    const k = `${m.retailer}|${m.week_start}`;
    const f = factAgg.get(k);
    if (!f) { console.log(`  ✗ matview'da var, fact'te yok: ${k}`); aggMism++; continue; }
    const dq = Math.abs(f.qty - Number(m.sales_qty)), dst = Math.abs(f.stock - Number(m.stock_qty));
    const dv = Math.abs(f.val - Number(m.sales_value ?? 0));
    if (dq > 0.5 || dst > 0.5 || dv > 1) { aggMism++; console.log(`  ✗ ${k}: fact(qty=${f.qty},stok=${f.stock},tl=${Math.round(f.val)}) vs matview(qty=${m.sales_qty},stok=${m.stock_qty},tl=${Math.round(Number(m.sales_value??0))})`); }
  }
  console.log(`  → ${(mv ?? []).length} matview satırı kontrol edildi, ${aggMism} uyuşmazlık.`);
  // matview'da olmayan fact slice?
  const mvKeys = new Set((mv ?? []).map((m) => `${m.retailer}|${m.week_start}`));
  for (const k of factAgg.keys()) if (!mvKeys.has(k)) console.log(`  ⚠ fact'te var, matview'da yok: ${k} (matview bayat olabilir)`);

  console.log("\n════════ 3) TÜM HAFTALIK ÖZET (göz kontrolü) ════════");
  const sorted = [...factAgg.entries()].map(([k, v]) => ({ k, ...v })).sort((a, b) => a.k.localeCompare(b.k));
  for (const ret of ["Toyzz", "DR", "Nezih"]) {
    console.log(`\n  ${ret}:`);
    for (const s of sorted.filter((x) => x.k.startsWith(ret + "|"))) {
      console.log(`    ${s.k.split("|")[1]}  satış=${String(Math.round(s.qty)).padStart(7)}  stok=${String(Math.round(s.stock)).padStart(8)}  ciro=${String(Math.round(s.val)).padStart(9)}`);
    }
  }
})().catch((e) => { console.error("HATA:", e.message); process.exit(1); });
