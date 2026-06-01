// Toplu yükleme: seed/<retailer>/ klasörlerindeki tüm Excel'leri okuyup
// Supabase'e yükler. Geçmiş 30 haftayı tek tek upload etmek yerine bir komut.
//
// Kullanım:
//   1. seed/ altına perakendeci klasörleri koy: seed/toyzz, seed/dr, seed/nezih ...
//   2. .env.local dolu olmalı (SUPABASE_SERVICE_ROLE_KEY dahil)
//   3. npx tsx scripts/seed.ts   (veya: npm run seed)

import { createClient } from "@supabase/supabase-js";
import * as XLSX from "xlsx";
import { readFileSync, readdirSync, existsSync } from "fs";
import { join } from "path";
import { config } from "dotenv";
import { normalizeFile } from "../src/lib/normalizers";
import { fetchAllRows } from "../src/lib/supabase";
import type { Retailer, UnifiedRow } from "../src/lib/normalizers/types";

config({ path: ".env.local" });

const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY!;
if (!url || !key) {
  console.error("HATA: .env.local içinde NEXT_PUBLIC_SUPABASE_URL ve SUPABASE_SERVICE_ROLE_KEY gerekli.");
  process.exit(1);
}
const db = createClient(url, key, { auth: { persistSession: false } });

const FOLDERS: Record<string, Retailer> = {
  toyzz: "Toyzz", dr: "DR", nezih: "Nezih",
  huppaluppo: "Huppaluppo", armagan: "Armağan",
};

async function main() {
  const seedRoot = join(process.cwd(), "seed");
  if (!existsSync(seedRoot)) {
    console.error("seed/ klasörü yok. seed/toyzz, seed/dr ... şeklinde Excel'leri koy.");
    process.exit(1);
  }

  let allRows: UnifiedRow[] = [];
  for (const [folder, retailer] of Object.entries(FOLDERS)) {
    const dir = join(seedRoot, folder);
    if (!existsSync(dir)) continue;
    const files = readdirSync(dir).filter((f) => /\.xlsx?$/i.test(f) && !f.startsWith("~$"));
    for (const file of files) {
      try {
        const buf = readFileSync(join(dir, file));
        const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
        const rows = normalizeFile(ab as ArrayBuffer, retailer, file);
        allRows = allRows.concat(rows);
        console.log(`[OK]   ${folder}/${file} — ${rows.length} satır (${rows[0]?.week_start})`);
      } catch (e: any) {
        console.log(`[SKIP] ${folder}/${file} — ${e.message}`);
      }
    }
  }

  if (!allRows.length) {
    console.log("Yüklenecek veri yok.");
    return;
  }

  // Yalnızca yeniden yüklenen (perakendeci, hafta) dilimlerini temizle — tam tablo
  // silme YOK; böylece bir hata diğer haftaların mevcut verisini yok etmez.
  const slices = [...new Set(allRows.map((r) => `${r.retailer}|${r.week_start}`))]
    .map((s) => s.split("|") as [string, string]);
  console.log(`\nToplam ${allRows.length} satır, ${slices.length} (perakendeci, hafta) dilimi yazılıyor…`);
  for (const [retailer, week] of slices) {
    const { error } = await db.from("fact_weekly").delete().eq("retailer", retailer).eq("week_start", week);
    if (error) { console.error(`Silme hatası (${retailer} ${week}):`, error.message); process.exit(1); }
  }

  const CHUNK = 1000;
  for (let i = 0; i < allRows.length; i += CHUNK) {
    const slice = allRows.slice(i, i + CHUNK);
    const { error } = await db.from("fact_weekly").insert(slice);
    if (error) { console.error("Insert hatası:", error.message); process.exit(1); }
    process.stdout.write(`\r  ${Math.min(i + CHUNK, allRows.length)}/${allRows.length}`);
  }
  console.log("\n✓ fact_weekly dolduruldu.");

  // Import log — bu dosyalar için eski kayıtları sil, yenilerini yaz
  const byFile = new Map<string, { retailer: string; week: string; rows: number }>();
  for (const r of allRows) {
    const k = r.source_file;
    if (!byFile.has(k)) byFile.set(k, { retailer: r.retailer, week: r.week_start, rows: 0 });
    byFile.get(k)!.rows++;
  }
  const logRows = [...byFile.entries()].map(([filename, v]) => ({
    retailer: v.retailer, filename, week_start: v.week, rows: v.rows,
  }));
  for (const lr of logRows) {
    await db.from("import_log").delete().eq("retailer", lr.retailer).eq("filename", lr.filename);
  }
  const { error: logErr } = await db.from("import_log").insert(logRows);
  if (logErr) console.error("import_log yazılamadı:", logErr.message);
  else console.log(`✓ import_log dolduruldu (${logRows.length} dosya).`);

  // Fiyat enrichment
  console.log("Fiyat enrichment…");
  await enrich();

  // Özet matview'larını yenile (dashboard anlık okusun)
  const { error: rErr } = await db.rpc("refresh_summaries");
  if (rErr) console.error("refresh_summaries hatası:", rErr.message);
  else console.log("✓ Özet matview'ları yenilendi.");

  console.log("✓ Tamamlandı.");
}

async function enrich() {
  // Sayfalı tam çekim — 356K satırlık seed'de PostgREST 1000-satır kırpması
  // yanlış medyan fiyat üretmesin.
  const priced = await fetchAllRows<{ barkod: string | null; sales_value: number; sales_qty: number }>(
    (from, to) => db.from("fact_weekly")
      .select("barkod, sales_value, sales_qty")
      .not("barkod", "is", null).gt("sales_value", 0).gt("sales_qty", 0)
      .order("id").range(from, to)
  );
  if (!priced.length) return;

  const byBarkod = new Map<string, number[]>();
  for (const r of priced) {
    const u = Number(r.sales_value) / Number(r.sales_qty);
    if (!isFinite(u) || u <= 0) continue;
    const arr = byBarkod.get(r.barkod as string) ?? [];
    arr.push(u);
    byBarkod.set(r.barkod as string, arr);
  }
  const median = (a: number[]) => { const s=[...a].sort((x,y)=>x-y); const m=Math.floor(s.length/2); return s.length%2?s[m]:(s[m-1]+s[m])/2; };
  const priceMap = new Map<string, number>();
  for (const [bk, arr] of byBarkod) priceMap.set(bk, median(arr));

  const priceRows = [...priceMap.entries()].map(([barkod, median_price]) => ({
    barkod, median_price, samples: byBarkod.get(barkod)!.length,
  }));
  for (let i = 0; i < priceRows.length; i += 1000) {
    const { error } = await db.from("sku_prices").upsert(priceRows.slice(i, i + 1000), { onConflict: "barkod" });
    if (error) console.error("sku_prices upsert hatası:", error.message);
  }

  const missing = await fetchAllRows<{ id: number; barkod: string | null; sales_qty: number }>(
    (from, to) => db.from("fact_weekly")
      .select("id, barkod, sales_qty").is("sales_value", null).not("barkod", "is", null)
      .order("id").range(from, to)
  );
  const updates = missing
    .map((r) => ({ id: r.id, p: priceMap.get(r.barkod as string), qty: Number(r.sales_qty) }))
    .filter((u) => u.p != null);
  for (let i = 0; i < updates.length; i += 200) {
    const res = await Promise.all(updates.slice(i, i + 200).map((u) =>
      db.from("fact_weekly").update({ sales_value: u.p! * u.qty, price: u.p }).eq("id", u.id)
    ));
    const errs = res.filter((x: any) => x?.error).length;
    if (errs) console.error(`  ${errs} fiyat güncelleme hatası (blok ${i}).`);
  }
  console.log(`  ${updates.length} satır TL ile dolduruldu.`);
}

main().catch((e) => { console.error(e); process.exit(1); });
