import { NextRequest, NextResponse } from "next/server";
import { supabase, fetchAllRows } from "@/lib/supabase";

export const runtime = "nodejs";
export const revalidate = 0;
export const maxDuration = 60;

/* UZMAN STOK YÖNLENDİRME MOTORU (saf PSF).
   Kaynaklar: MEIO/Guaranteed-Service (pull düğümü düşük emniyet), newsvendor/safety-stock
   (kapsam talep değişkenliğine bağlı), ABC-XYZ segmentasyonu, Bain 3-kova, McKinsey/HBS
   markdown & SKU-rasyonalizasyon, konsinye ekonomisi (sermaye risiki tedarikçide=biz).
   Düz "13 hf" YOK → SEGMENT×SEZON kapsam hedefi + disposition (transfer/depo/likidasyon). */
const DEAD = 1, ABSORB = 26, FLOOR = 25000, NEW_WEEKS = 6;
// ABC×XYZ kapsam hedefi (hafta). MEIO: erratik/pull → biriktirme, hızlı ikmal. C kuyruk → ince.
const COVER: Record<string, Record<string, number>> = {
  A: { X: 8, Y: 10, Z: 6 }, B: { X: 8, Y: 8, Z: 6 }, C: { X: 4, Y: 4, Z: 2 }, D: { X: 0, Y: 0, Z: 0 },
};
const MODE_MULT: Record<string, number> = { koruma: 1.3, denge: 1.0, agresif: 0.7 };

function season(name: string): "ESKİ" | "25/26" | "TREND" | "DİĞER" {
  const n = (name || "").toLowerCase();
  if (/25\s*[\/\-]?\s*26|2025\s*[\/\-]?\s*2?6/.test(n)) return "25/26";
  if (/22\s*[\/\-]\s*23|23\s*[\/\-]\s*24|24\s*[\/\-]\s*25|euro\s*2024|20(22|23|24)\b/.test(n)) return "ESKİ";
  if (/manifest|labubu|sevimli canavar|kpop|holomen|holomonster|rafadan|nice to know|\btork\b|minions|animal/.test(n)) return "TREND";
  return "DİĞER";
}
const num = (x: any) => (x == null ? 0 : Number(x) || 0);
const r1 = (n: number) => Math.round(n * 10) / 10;
const clean = (b: any) => { const d = String(b == null ? "" : b).replace(/\D/g, ""); return (d && !/^0+$/.test(d) && d.length >= 8 && d.length <= 14) ? d : null; };

export async function GET(req: NextRequest) {
  const mode = (new URL(req.url).searchParams.get("mode") || "denge").toLowerCase();
  const mult = MODE_MULT[mode] ?? 1.0;
  try {
    const [pc, sw, al] = await Promise.all([
      fetchAllRows<any>((f, t) => supabase.from("product_coverage").select("retailer, product_key, barkod, sku_name, weeks, avg_weekly, last_stock, coverage_weeks, psf").order("product_key").range(f, t)),
      fetchAllRows<any>((f, t) => supabase.from("sku_weekly").select("retailer, week_start, sku_name, barkod, sales_qty, sales_value").order("sku_name").range(f, t)),
      fetchAllRows<any>((f, t) => supabase.from("product_alias").select("retailer, sku_name, barkod").eq("status", "approved").order("sku_name").range(f, t)),
    ]);
    const aliasMap = new Map(al.map((a) => [a.retailer + "|" + a.sku_name, a.barkod]));
    const pkOf = (retailer: string, sku_name: string, barkod: any) => { const b = clean(barkod) || aliasMap.get(retailer + "|" + sku_name); return b || "NAME:" + sku_name; };

    // kanal haftaları
    const chW = new Map<string, Set<string>>();
    for (const r of sw) { let s = chW.get(r.retailer); if (!s) { s = new Set(); chW.set(r.retailer, s); } s.add(r.week_start); }
    const weeksOf: Record<string, string[]> = {}; for (const [c, s] of chW) weeksOf[c] = [...s].sort();

    // seriler: (retailer|pk) → haftalık adet; + ağ değeri (ABC için)
    const series = new Map<string, { byW: Map<string, number>; first: string }>();
    const netVal = new Map<string, number>(); // pk → son-8hf ağ satış değeri
    for (const r of sw) {
      const pk = pkOf(r.retailer, r.sku_name, r.barkod), k = r.retailer + "|" + pk;
      let e = series.get(k); if (!e) { e = { byW: new Map(), first: r.week_start }; series.set(k, e); }
      e.byW.set(r.week_start, (e.byW.get(r.week_start) || 0) + num(r.sales_qty));
      if (r.week_start < e.first) e.first = r.week_start;
      const last8 = (weeksOf[r.retailer] || []).slice(-8);
      if (last8.includes(r.week_start)) netVal.set(pk, (netVal.get(pk) || 0) + num(r.sales_value));
    }
    // ABC (ağ, son-8hf değer): kümülatif %80 / %95
    const ranked = [...netVal.entries()].filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]);
    const totVal = ranked.reduce((s, [, v]) => s + v, 0);
    const abcOf = new Map<string, string>(); let cum = 0;
    for (const [pk, v] of ranked) { cum += v; const p = cum / totVal; abcOf.set(pk, p <= 0.8 ? "A" : p <= 0.95 ? "B" : "C"); }
    // XYZ (kanal×pk, CV); + weeksPresent + intermittency
    function stats(k: string, retailer: string) {
      const e = series.get(k); const W = weeksOf[retailer] || [];
      if (!e) return { cv: Infinity, wkP: 0, xyz: "Z" };
      const span = W.filter((w) => w >= e.first); const vals = span.map((w) => e.byW.get(w) || 0);
      const n = vals.length, mean = vals.reduce((a, b) => a + b, 0) / Math.max(1, n);
      const sd = n > 1 ? Math.sqrt(vals.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1)) : 0;
      const cv = mean > 0 ? sd / mean : Infinity;
      const xyz = !isFinite(cv) || cv > 1 ? "Z" : cv < 0.5 ? "X" : "Y";
      return { cv, wkP: n, xyz };
    }

    // ── Karar ──
    const byKey = new Map<string, any[]>();
    for (const r of pc) { const a = byKey.get(r.product_key) || []; a.push(r); byKey.set(r.product_key, a); }
    type R = { r: any; stock: number; v: number; cov: number | null; psf: number; sea: string; abc: string; xyz: string; wkP: number; intent: string; pull: number; ship: number; cap: number; target: number; noPrice: boolean };
    const recs: R[] = [];
    for (const r of pc) {
      const stock = num(r.last_stock), v = num(r.avg_weekly), psf = num(r.psf);
      const cov = r.coverage_weeks == null ? null : Number(r.coverage_weeks);
      const sea = season(r.sku_name);
      const pk = r.product_key, k = r.retailer + "|" + pk;
      const st = stats(k, r.retailer);
      const abc = (netVal.get(pk) || 0) > 0 ? (abcOf.get(pk) || "C") : "D"; // ağda son-8hf 0 satış = D
      const target0 = sea === "ESKİ" ? 0 : (COVER[abc] || COVER.C)[st.xyz] ?? 6;
      const target = Math.round(target0 * mult);
      const targetUnits = Math.ceil(target * v);
      let intent = "tut", pull = 0, ship = 0;
      if (stock <= 0) intent = v >= DEAD ? "sevk" : "skip";
      else if (sea === "ESKİ") { intent = "obsolet"; pull = stock; }       // sezon biten → likide (geçmişten bağımsız)
      else if (v < DEAD) {                                                  // ölü görünüyor
        if (st.wkP < NEW_WEEKS) intent = "izle";                           // ama geçmiş kısa → yeni olabilir, dokunma
        else { intent = "olu"; pull = stock; }                             // yeterli geçmiş + satmıyor → ölü, çek
      }
      else if (stock > targetUnits) { intent = "fazla"; pull = stock - targetUnits; }  // satıyor + aşırı stok → kısa geçmişte bile gözlemlenebilir
      else if (cov != null && cov < target * 0.4) { intent = "sevk"; ship = Math.max(0, targetUnits - stock); }
      const cap = (v >= DEAD && cov != null && cov < target) ? Math.max(0, Math.floor(v * ABSORB - stock)) : 0;
      if (stock <= 0 && v >= DEAD) ship = Math.ceil(v * Math.max(4, target));
      recs.push({ r, stock, v, cov, psf, sea, abc, xyz: st.xyz, wkP: st.wkP, intent, pull, ship, cap, target, noPrice: psf <= 0 && stock > 0 });
    }

    // paylaşımlı kapasite defteri (R5)
    const ledger = new Map<string, number>();
    for (const x of recs) if (x.cap > 0) ledger.set(x.r.retailer + "|" + x.r.product_key, x.cap);

    const base = (x: R) => ({
      retailer: x.r.retailer, sku_name: x.r.sku_name, barkod: x.r.barkod || "", season: x.sea,
      abc: x.abc, xyz: x.xyz, stock: x.stock, velocity: r1(x.v), coverage: x.cov == null ? null : Math.round(x.cov),
      target: x.target, psf: Math.round(x.psf), noPrice: x.noPrice,
    });

    const routes: any[] = [];
    // kaynaklar: yüksek değer önce kapasiteyi kapsın
    const sources = recs.filter((x) => (x.intent === "olu" || x.intent === "fazla" || x.intent === "obsolet") && x.pull > 0)
      .sort((a, b) => (b.pull * b.psf) - (a.pull * a.psf));
    for (const x of sources) {
      const pk = x.r.product_key, psf = x.psf, pull = x.pull;
      const value = x.noPrice ? 0 : Math.round(pull * psf);
      if (x.intent === "obsolet") { routes.push({ ...base(x), action: "LIKIDASYON", qty: pull, dest: null, toDepot: pull, value, reason: `Eski sezon (obsolet) — pack&hold maliyetli; markdown/likidasyon (erken-büyük indirim)` }); continue; }
      // ölü/fazla → transfer (yalnız A/B + ihtiyaçlı hedef + değerli) yoksa depo
      let give = 0, tgt: any = null;
      if (x.abc === "A" || x.abc === "B") {
        const cands = (byKey.get(pk) || []).filter((o) => o.retailer !== x.r.retailer && num(o.avg_weekly) >= DEAD)
          .map((o) => ({ o, rem: ledger.get(o.retailer + "|" + pk) || 0 })).filter((c) => c.rem > 0).sort((a, b) => b.rem - a.rem);
        if (cands.length) { const bst = cands[0], g = Math.min(pull, bst.rem); if (g > 0 && g * psf >= FLOOR) { give = g; ledger.set(bst.o.retailer + "|" + pk, bst.rem - g); tgt = { retailer: bst.o.retailer, qty: g, vel: r1(num(bst.o.avg_weekly)) }; } }
      }
      const toDepot = pull - give;
      const action = give > 0 ? "TRANSFER" : "DEPO";
      const reason = x.intent === "olu"
        ? `${x.abc}-sınıf · ${x.xyz} · burada ölü (${base(x).velocity}/hf) → çek`
        : `${x.abc}-${x.xyz} · aşırı stok (${base(x).coverage} hf > hedef ${x.target} hf) → fazlasını çek`;
      routes.push({ ...base(x), action, qty: pull, dest: tgt, toDepot, value, reason: tgt ? `${reason}; ${tgt.retailer} alabilir` : reason });
    }
    for (const x of recs) {
      if (x.intent === "sevk") routes.push({ ...base(x), action: "SEVK", qty: x.ship, dest: null, toDepot: 0, value: 0, reason: x.stock <= 0 ? "Tükendi — satıyor, sevk et" : `Hedef altı (${base(x).coverage} hf < ${x.target} hf) — sevk et` });
      else if (x.intent === "izle") routes.push({ ...base(x), action: "İZLE", qty: 0, dest: null, toDepot: 0, value: 0, reason: `Yeni ürün (${x.wkP} hf veri) — karar için bekle` });
    }

    const sumv = (a: any[]) => a.reduce((s, r) => s + (r.value || 0), 0);
    const g = (act: string) => routes.filter((r) => r.action === act);
    // 3-kova (Bain) + segment dağılımı + donmuş sermaye
    const segCount: Record<string, number> = {};
    for (const x of recs) { const key = x.sea === "ESKİ" ? "ESKİ" : `${x.abc}${x.xyz}`; segCount[key] = (segCount[key] || 0) + 1; }
    const summary = {
      transfer: { n: g("TRANSFER").length, psf: sumv(g("TRANSFER")) },
      depo: { n: g("DEPO").length, psf: sumv(g("DEPO")) },
      likidasyon: { n: g("LIKIDASYON").length, psf: sumv(g("LIKIDASYON")) },
      sevk: { n: g("SEVK").length },
      izle: { n: g("İZLE").length },
      frozenFreed: sumv(g("TRANSFER")) + sumv(g("DEPO")) + sumv(g("LIKIDASYON")), // serbest kalacak donmuş sermaye
      noPrice: routes.filter((r) => r.noPrice && (r.action === "TRANSFER" || r.action === "DEPO" || r.action === "LIKIDASYON")).length,
      mode, segCount,
    };
    const ord: Record<string, number> = { LIKIDASYON: 0, TRANSFER: 1, DEPO: 2, SEVK: 3, "İZLE": 4 };
    routes.sort((a, b) => (ord[a.action] - ord[b.action]) || (b.value - a.value) || (b.qty - a.qty));
    return NextResponse.json({ mode, summary, routes });
  } catch (e: any) {
    console.error("routing hatası:", e);
    return NextResponse.json({ error: "Sunucu hatası" }, { status: 500 });
  }
}
