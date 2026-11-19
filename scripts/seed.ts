// Toplu yükleme: seed/<retailer>/ klasörlerindeki tüm Excel'leri okuyup
// Supabase'e yükler. Geçmiş 30 haftayı tek tek upload etmek yerine bir komut.
//
// Kullanım:
//   1. seed/ altına perakendeci klasörleri koy: seed/toyzz, seed/dr, seed/nezih ...
//   2. .env.local dolu olmalı (SUPABASE_SERVICE_ROLE_KEY dahil)
//   3. npx tsx scripts/seed.ts   (veya: npm run seed)

import { createClient } from "@supabase/supabase-js";
import { readFileSync, readdirSync, existsSync } from "fs";
import { join } from "path";
import { config } from "dotenv";
import { normalizeFile, checkRowHealth } from "../src/lib/normalizers";
// Fiyat enrichment'i panel yüklemesiyle PAYLAŞILAN modülden gelir. Eskiden
// seed'in kendi kopyası vardı ve tüm geçmişten tek global medyan hesaplıyordu;
// aynı Excel iki yoldan yüklendiğinde farklı sales_value üretiyordu.
import { enrichPrices, type PriceSlice } from "../src/lib/prices";
import { toyzzBarkodHaritasi, toyzzBarkodIsle } from "../src/lib/toyzz-barkod";
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

  // Toyzz Kalem Kodu → barkod eşlemesi, HİÇBİR dilim silinmeden ÖNCE okunur:
  // seed Toyzz haftalarını DELETE+INSERT ile yeniden yazar; eşleme sonradan
  // okunsaydı silinen satırların barkodu kaybolurdu (bkz. lib/toyzz-barkod.ts).
  const toyzzHarita = await toyzzBarkodHaritasi(db);
  console.log(`Toyzz barkod eşlemesi: ${toyzzHarita.size} kalem`);

  let allRows: UnifiedRow[] = [];
  // (perakendeci|hafta) -> o dilimi yazan ilk dosya adi. TUM KLASORLER icin tek
  // kume: ayni dilime ikinci dosya gelirse atlanir (gerekcesi asagida).
  const yazilanDilimler = new Map<string, string>();
  for (const [folder, retailer] of Object.entries(FOLDERS)) {
    const dir = join(seedRoot, folder);
    if (!existsSync(dir)) continue;
    const files = readdirSync(dir).filter((f) => /\.xlsx?$/i.test(f) && !f.startsWith("~$"));
    for (const file of files) {
      try {
        const buf = readFileSync(join(dir, file));
        const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
        const rows = normalizeFile(ab as ArrayBuffer, retailer, file);
        if (retailer === "Toyzz") toyzzBarkodIsle(rows, toyzzHarita);
        // Panel yüklemesiyle AYNI sağlık kontrolü: tümü 0 satış / tümü 0 stok /
        // ciro üretilemez dosyalar sessizce geçmesin. Bloklamıyor — uyarıyor.
        for (const w of checkRowHealth(rows).warnings) {
          console.warn(`[UYARI] ${folder}/${file} — ${w}`);
        }
        // AYNI DILIM IKI KEZ YAZILMAZ — /api/upload ile ayni koruma.
        // Uc, ayni istekte ayni (perakendeci, hafta) dilimine yazan ikinci
        // dosyayi acikca reddediyor; seed'de bu kontrol yoktu ve iki dosya ayni
        // haftaya cozulurse (tarihsiz dosyalar weekFromToday yedegine duser)
        // silme BIR KEZ, yazma IKI KEZ oluyor: o haftanin satisi ve stogu iki
        // katina cikiyor, konsol [OK] diyor, saglik kontrolu goremiyor.
        const dilim = `${retailer}|${rows[0]?.week_start ?? ""}`;
        const onceki = yazilanDilimler.get(dilim);
        if (onceki) {
          console.log(`[ATLA] ${folder}/${file} — ${rows[0]?.week_start} haftasi bu kosuda zaten "${onceki}" dosyasindan yazildi; ciftlemeyi onlemek icin atlandi.`);
          continue;
        }
        yazilanDilimler.set(dilim, file);
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
  // ANAHTAR FIRMA + DOSYA ADI. Yalniz source_file kullanilinca iki farkli firma
  // klasorunde ayni adli dosya (or. "Hafta 1.xlsx") tek satira karisiyordu.
  const byFile = new Map<string, { retailer: string; week: string; rows: number; filename: string }>();
  for (const r of allRows) {
    const k = `${r.retailer}|${r.source_file}`;
    if (!byFile.has(k)) byFile.set(k, { retailer: r.retailer, week: r.week_start, rows: 0, filename: r.source_file });
    byFile.get(k)!.rows++;
  }
  const logRows = [...byFile.values()].map((v) => ({
    retailer: v.retailer, filename: v.filename, week_start: v.week, rows: v.rows,
  }));
  for (const lr of logRows) {
    await db.from("import_log").delete().eq("retailer", lr.retailer).eq("filename", lr.filename);
  }
  const { error: logErr } = await db.from("import_log").insert(logRows);
  if (logErr) console.error("import_log yazılamadı:", logErr.message);
  else console.log(`✓ import_log dolduruldu (${logRows.length} dosya).`);

  // Fiyat enrichment — panel yüklemesiyle AYNI modül, AYNI semantik.
  // Fark yalnız parametre: seed burada tüm dilimleri birden verir, panel 1-2 tane.
  // Sözlük dilim başına kurulduğu için sonuç, aynı haftaları tek tek yüklemekle
  // aynı çıkar (bkz. src/lib/prices.ts başındaki not).
  console.log("Fiyat enrichment…");
  const priceSlices: PriceSlice[] = slices.map(([retailer, week_start]) => ({ retailer, week_start }));
  const rep = await enrichPrices(db, priceSlices, { log: (m) => console.log(`  ${m}`) });
  console.log(
    `✓ Fiyat enrichment: ${rep.gaps} ciro boşluğu, ${rep.filled} satır dolduruldu, ` +
    `${rep.unpriced} satır fiyatsız kaldı, ${rep.failed} yazma hatası.`
  );

  // Özet matview'larını yenile (dashboard anlık okusun)
  const { error: rErr } = await db.rpc("refresh_summaries");
  if (rErr) console.error("refresh_summaries hatası:", rErr.message);
  else console.log("✓ Özet matview'ları yenilendi.");

  console.log("✓ Tamamlandı.");
}

main().catch((e) => { console.error(e); process.exit(1); });
