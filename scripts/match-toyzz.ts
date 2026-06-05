/**
 * Toyzz (barkodsuz) → EAN akıllı eşleştirici.
 *
 * Toyzz ürünlerini, barkodu BİLİNEN ürünlere (diğer perakendecilerin canlı
 * verisi + opsiyonel SKU-EAN master dosyası) isim örtüşmesi + takım + sezon
 * sinyaliyle eşler ve product_alias'a status='suggested' olarak yazar.
 * ASLA otomatik onaylamaz — /eslesme sayfasında insan onayı/aday seçimi yapılır.
 * Zaten approved/rejected olan Toyzz SKU'larına DOKUNMAZ (insan kararına saygı).
 *
 * Kullanım:
 *   npm run match:toyzz            # yazar (suggested upsert)
 *   npm run match:toyzz -- --dry   # yalnız rapor, yazmaz
 *   npm run match:toyzz -- --master "C:/.../SKU-EAN.xlsx"  # master dosya yolu
 */
import * as fs from "fs";
import * as path from "path";
import * as XLSX from "xlsx";

// ── env ──
const env: Record<string, string> = {};
for (const line of fs.readFileSync(path.join(__dirname, "..", ".env.local"), "utf8").split(/\r?\n/)) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m) env[m[1]] = m[2];
}
const URL = env.NEXT_PUBLIC_SUPABASE_URL;
const SERVICE = env.SUPABASE_SERVICE_ROLE_KEY;
const ANON = env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

const argv = process.argv.slice(2);
const DRY = argv.includes("--dry");
const masterArg = (() => {
  const i = argv.indexOf("--master");
  return i >= 0 ? argv[i + 1] : undefined;
})();
const MASTER_PATHS = [masterArg, "C:/Users/dell/Desktop/SKU-EAN.xlsx", path.join(__dirname, "..", "data", "SKU-EAN.xlsx")].filter(Boolean) as string[];

// ── normalizasyon ──
const TEAM_MAP: [RegExp, string][] = [
  [/\bbjk\b|besiktas/, "besiktas"],
  [/\bfb\b|fenerbahce/, "fenerbahce"],
  [/\bgs\b|galatasaray/, "galatasaray"],
  [/\bts\b|trabzonspor|tranzonspor/, "trabzonspor"],
  [/\bgoz\b|goztepe/, "goztepe"],
];
const STOP = new Set(["asp", "myt", "tps", "mythos", "topps", "tek", "adet", "ve", "the", "pack", "paket", "d"]);
function fold(s: any): string {
  return String(s == null ? "" : s)
    .replace(/İ|I|ı/g, "i").replace(/Ş|ş/g, "s").replace(/Ğ|ğ/g, "g")
    .replace(/Ü|ü/g, "u").replace(/Ö|ö/g, "o").replace(/Ç|ç/g, "c")
    .toLowerCase().replace(/[^a-z0-9]+/g, " ").replace(/\s+/g, " ").trim();
}
function team(f: string): string | null {
  for (const [re, t] of TEAM_MAP) if (re.test(f)) return t;
  return null;
}
function season(f: string): string | null {
  let m = f.match(/\b20(\d{2})\s+(\d{2})\b/); if (m) return `${m[1]}/${m[2]}`;
  m = f.match(/(?:^|\D)(\d{2})\s+(\d{2})(?:\D|$)/); if (m && +m[1] >= 21 && +m[1] <= 28) return `${m[1]}/${m[2]}`;
  return null;
}
// anlamlı token kümesi (gürültü + paket-boyutu temizlenmiş)
function toks(name: string): Set<string> {
  const f = fold(name);
  const out = new Set<string>();
  const tm = team(f);
  if (tm) out.add(tm);
  for (let t of f.split(" ")) {
    if (!t || t.length < 2) continue;
    if (STOP.has(t)) continue;
    if (/^\d+$/.test(t)) continue;                       // saf sayı (12, 24…)
    if (/^\d+(d|a|li|lu|pr|prc|adet|x)$/.test(t)) continue; // 24d,12li,48prc…
    if (TEAM_MAP.some(([re]) => re.test(t)) && tm) continue; // takım kodu (zaten eklendi)
    out.add(t);
  }
  return out;
}
function jaccard(a: Set<string>, b: Set<string>): number {
  let inter = 0; for (const x of a) if (b.has(x)) inter++;
  const uni = a.size + b.size - inter; return uni ? inter / uni : 0;
}
function cleanBarcode(b: any): string | null {
  const d = String(b == null ? "" : b).replace(/\D/g, "");
  if (!d || /^0+$/.test(d) || d.length < 8 || d.length > 14) return null;
  return d;
}

async function rest(q: string, key = SERVICE): Promise<any[]> {
  const out: any[] = [];
  for (let from = 0; ; from += 1000) {
    const res = await fetch(`${URL}/rest/v1/${q}`, {
      headers: { apikey: key!, Authorization: `Bearer ${key}`, Range: `${from}-${from + 999}` },
    });
    const chunk = await res.json();
    if (!Array.isArray(chunk)) { console.error("REST hata:", chunk); break; }
    out.push(...chunk);
    if (chunk.length < 1000) break;
  }
  return out;
}

type AuthRow = { name: string; bc: string; src: string; tk: Set<string>; team: string | null; season: string | null };

(async () => {
  // 1) Otorite: diğer perakendecilerin (barkodlu) adları
  const sw = await rest("sku_weekly?select=retailer,sku_name,barkod");
  const authority: AuthRow[] = [];
  const seenAuth = new Set<string>();
  for (const r of sw) {
    if (r.retailer === "Toyzz") continue;
    const bc = cleanBarcode(r.barkod);
    if (!bc) continue;
    const k = `${bc}|${r.sku_name}`;
    if (seenAuth.has(k)) continue; seenAuth.add(k);
    const f = fold(r.sku_name);
    authority.push({ name: r.sku_name, bc, src: r.retailer, tk: toks(r.sku_name), team: team(f), season: season(f) });
  }
  // 2) Master dosya (varsa) — Product → barkod
  let masterUsed = "yok";
  for (const p of MASTER_PATHS) {
    if (!fs.existsSync(p)) continue;
    const wb = XLSX.readFile(p);
    const rows = XLSX.utils.sheet_to_json<any>(wb.Sheets[wb.SheetNames[0]], { defval: null });
    let added = 0;
    for (const r of rows) {
      const bc = cleanBarcode(r.Barcode); if (!bc || !r.Product) continue;
      const k = `${bc}|${r.Product}`; if (seenAuth.has(k)) continue; seenAuth.add(k);
      const f = fold(r.Product);
      authority.push({ name: r.Product, bc, src: "master", tk: toks(r.Product), team: team(f), season: season(f) });
      added++;
    }
    masterUsed = `${p} (+${added})`;
    break;
  }
  console.log(`Otorite: ${authority.length} ad→EAN (DB diğer firmalar + master: ${masterUsed})`);

  // 3) Mevcut Toyzz alias kararları (approved/rejected → dokunma)
  const existing = await rest("product_alias?select=sku_name,status&retailer=eq.Toyzz");
  const locked = new Set(existing.filter((a) => a.status === "approved" || a.status === "rejected").map((a) => a.sku_name));

  // 4) Toyzz benzersiz adlar
  const toyzz = [...new Set(sw.filter((r) => r.retailer === "Toyzz").map((r) => r.sku_name))].sort();

  function scoreFor(name: string) {
    const tk = toks(name), tTeam = team(fold(name)), tSeason = season(fold(name));
    const scored = authority.map((a) => {
      const jac = jaccard(tk, a.tk);
      let s = 0.6 * jac;
      if (tTeam && a.team) s += tTeam === a.team ? 0.3 : -0.4;
      if (tSeason && a.season) s += tSeason === a.season ? 0.2 : -0.12;
      return { barkod: a.bc, name: a.name, score: Math.max(0, Math.min(1, s)), src: a.src };
    });
    // barkod başına en iyi skoru tut, sırala
    const best = new Map<string, any>();
    for (const c of scored) { const e = best.get(c.barkod); if (!e || c.score > e.score) best.set(c.barkod, c); }
    return [...best.values()].filter((c) => c.score > 0.1).sort((a, b) => b.score - a.score).slice(0, 6);
  }

  const rows: any[] = [];
  let skipped = 0, nocand = 0;
  for (const name of toyzz) {
    if (locked.has(name)) { skipped++; continue; }
    const cands = scoreFor(name);
    if (!cands.length) { nocand++; continue; }
    const top = cands[0];
    rows.push({
      retailer: "Toyzz", sku_name: name, barkod: top.barkod, match_name: top.name,
      confidence: Math.round(top.score * 100) / 100, status: "suggested", source: "auto",
      candidates: cands.map((c) => ({ barkod: c.barkod, name: c.name, score: Math.round(c.score * 100) / 100, src: c.src })),
    });
  }

  const band = (lo: number, hi: number) => rows.filter((r) => r.confidence >= lo && r.confidence < hi).length;
  console.log(`\nToyzz benzersiz: ${toyzz.length} | kilitli(onaylı/red): ${skipped} | aday-yok: ${nocand} | ÖNERİ: ${rows.length}`);
  console.log(`Güven bandı: ≥0.8: ${band(0.8, 1.01)} | 0.5–0.8: ${band(0.5, 0.8)} | 0.3–0.5: ${band(0.3, 0.5)} | <0.3: ${band(0, 0.3)}`);
  console.log("\nÖrnek öneriler (ilk 12):");
  for (const r of rows.slice(0, 12)) {
    console.log(`  [%${Math.round(r.confidence * 100)}] ${r.sku_name.slice(0, 52)}`);
    console.log(`        → ${r.match_name.slice(0, 52)} [${r.barkod}] (${r.candidates.length} aday)`);
  }

  if (DRY) { console.log("\n--dry: yazılmadı."); return; }

  // 5) Upsert (suggested) — on_conflict retailer,sku_name
  let ok = 0;
  for (let i = 0; i < rows.length; i += 200) {
    const slice = rows.slice(i, i + 200);
    const res = await fetch(`${URL}/rest/v1/product_alias?on_conflict=retailer,sku_name`, {
      method: "POST",
      headers: {
        apikey: SERVICE!, Authorization: `Bearer ${SERVICE}`, "Content-Type": "application/json",
        Prefer: "resolution=merge-duplicates,return=minimal",
      },
      body: JSON.stringify(slice.map((r) => ({ ...r, updated_at: new Date().toISOString() }))),
    });
    if (!res.ok) { console.error("upsert hata:", res.status, await res.text()); break; }
    ok += slice.length;
  }
  console.log(`\n✓ ${ok} öneri yazıldı (status=suggested). /eslesme'de onayla.`);
})().catch((e) => { console.error(e); process.exit(1); });
