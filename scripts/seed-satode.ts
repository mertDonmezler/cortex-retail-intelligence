// Sat-Öde (konsinye) fatura dosyalarını seed/satode/ altından okuyup
// Supabase consignment_lines tablosuna yükler.
// Kullanım: seed/satode/ altına Excel'i koy → npx tsx scripts/seed-satode.ts
import { createClient } from "@supabase/supabase-js";
import { readFileSync, readdirSync, existsSync } from "fs";
import { join } from "path";
import { config } from "dotenv";
import { parseSatodeWorkbook } from "../src/lib/normalizers/satode";
import type { ConsignmentLine } from "../src/lib/normalizers/types";

config({ path: ".env.local" });

const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY!;
if (!url || !key) {
  console.error("HATA: .env.local içinde NEXT_PUBLIC_SUPABASE_URL ve SUPABASE_SERVICE_ROLE_KEY gerekli.");
  process.exit(1);
}
const db = createClient(url, key, { auth: { persistSession: false } });

async function main() {
  const dir = join(process.cwd(), "seed", "satode");
  if (!existsSync(dir)) { console.error("seed/satode/ klasörü yok."); process.exit(1); }
  const files = readdirSync(dir).filter((f) => /\.xlsx?$/i.test(f) && !f.startsWith("~$"));
  if (!files.length) { console.error("seed/satode/ içinde Excel yok."); process.exit(1); }

  let all: ConsignmentLine[] = [];
  for (const file of files) {
    try {
      const buf = readFileSync(join(dir, file));
      const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
      const rows = parseSatodeWorkbook(ab, file);
      all = all.concat(rows);
      console.log(`[OK]   ${file} — ${rows.length} kalem`);
    } catch (e: any) {
      console.log(`[SKIP] ${file} — ${e.message}`);
    }
  }
  if (!all.length) { console.log("Yüklenecek kalem yok."); return; }

  // Yüklenen dosyalara ait eski kayıtları sil (re-run güvenli), sonra ekle.
  const srcFiles = [...new Set(all.map((r) => r.source_file))];
  for (const sf of srcFiles) {
    const { error } = await db.from("consignment_lines").delete().eq("source_file", sf);
    if (error) { console.error(`Silme hatası (${sf}):`, error.message); process.exit(1); }
  }

  const CHUNK = 500;
  for (let i = 0; i < all.length; i += CHUNK) {
    const { error } = await db.from("consignment_lines").insert(all.slice(i, i + CHUNK));
    if (error) { console.error("Insert hatası:", error.message); process.exit(1); }
    process.stdout.write(`\r  ${Math.min(i + CHUNK, all.length)}/${all.length}`);
  }
  console.log(`\n✓ consignment_lines dolduruldu (${all.length} kalem, ${srcFiles.length} dosya).`);

  // Özet kontrol
  const byRet = new Map<string, { n: number; total: number }>();
  for (const r of all) {
    const e = byRet.get(r.retailer) ?? { n: 0, total: 0 };
    e.n++; e.total += r.total; byRet.set(r.retailer, e);
  }
  for (const [ret, e] of byRet)
    console.log(`  ${ret.padEnd(11)} ${e.n} kalem  KDV'li ${Math.round(e.total).toLocaleString("tr-TR")} ₺`);
}

main().catch((e) => { console.error(e); process.exit(1); });
