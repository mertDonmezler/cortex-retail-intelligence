import { NextRequest, NextResponse } from "next/server";
import { supabase, fetchAllRows } from "@/lib/supabase";

export const runtime = "nodejs";
export const revalidate = 0;
export const maxDuration = 60;

// DİNAMİK STOK YÖNLENDİRME MOTORU (saf PSF, marj/KDV yok).
// Karar: ÇEK→VER (transfer) / ÇEK→DEPO (iade/depo) / SEVK / İZLE.
// Kaynak: product_coverage (firma×ürün: hız, stok, kapsam, psf[MEDYAN], hafta).
// DENETİM DÜZELTMELERİ: (R5) hedef kapasitesi PAYLAŞIMLI defterle dağıtılır —
// bir hedef toplam kapasitesinden fazla mal almaz; (R9) psf=0 ürünler işaretlenir.
const DEAD = 1;      // <1 ad/hf = satmıyor
const OVER = 26;     // >26 hf = aşırı stok
const LOW = 8;       // <8 hf = az stok
const NEW_WEEKS = 6; // <6 hf veri = yeni ürün (iade etme)
const ABSORB = 26;   // hedef en fazla 26 hf'lik emer
const FLOOR = 25000; // transfer alt sınırı (PSF) — altı → depo

function season(name: string): "ESKİ" | "25/26" | "TREND" | "DİĞER" {
  const n = (name || "").toLowerCase();
  if (/25\s*[\/\-]?\s*26|2025\s*[\/\-]?\s*2?6/.test(n)) return "25/26";
  if (/22\s*[\/\-]\s*23|23\s*[\/\-]\s*24|24\s*[\/\-]\s*25|euro\s*2024|20(22|23|24)\b/.test(n)) return "ESKİ";
  if (/manifest|labubu|sevimli canavar|kpop|holomen|holomonster|rafadan|nice to know|\btork\b|minions|animal/.test(n)) return "TREND";
  return "DİĞER";
}
const num = (x: any) => (x == null ? 0 : Number(x) || 0);
const r1 = (n: number) => Math.round(n * 10) / 10;

export async function GET(req: NextRequest) {
  const keep = Math.max(4, Math.min(52, Number(new URL(req.url).searchParams.get("keep")) || 13));
  try {
    const rows = await fetchAllRows<any>((from, to) =>
      supabase.from("product_coverage")
        .select("retailer, product_key, barkod, sku_name, weeks, avg_weekly, last_stock, coverage_weeks, psf")
        .order("product_key").range(from, to)
    );
    const byKey = new Map<string, any[]>();
    for (const r of rows) { const a = byKey.get(r.product_key) || []; a.push(r); byKey.set(r.product_key, a); }

    // ── 1. Geçiş: metrik + niyet sınıflandırma ──
    type Rec = { r: any; stock: number; v: number; cov: number | null; psf: number; wk: number; sea: string; intent: string; pull: number; cap: number; ship: number; noPrice: boolean };
    const recs: Rec[] = [];
    for (const r of rows) {
      const stock = num(r.last_stock), v = num(r.avg_weekly), psf = num(r.psf), wk = num(r.weeks);
      const cov = r.coverage_weeks == null ? null : Number(r.coverage_weeks);
      const sea = season(r.sku_name);
      let intent = "tut", pull = 0, ship = 0;
      if (stock <= 0) intent = v >= DEAD ? "sevk" : "skip";
      else if (v < DEAD) { if (wk < NEW_WEEKS && sea !== "ESKİ") intent = "izle"; else { intent = "dead"; pull = stock; } }
      else if (cov != null && cov > OVER) { pull = Math.max(0, stock - Math.ceil(v * keep)); intent = pull > 0 ? "overstock" : "tut"; }
      else if (cov != null && cov < LOW) { intent = "sevk"; ship = Math.max(0, Math.ceil(v * keep - stock)); }
      const cap = (v >= DEAD && cov != null && cov < keep) ? Math.max(0, Math.floor(v * ABSORB - stock)) : 0;
      if (stock <= 0) ship = v >= DEAD ? Math.ceil(v * keep) : 0;
      recs.push({ r, stock, v, cov, psf, wk, sea, intent, pull, cap, ship, noPrice: psf <= 0 && stock > 0 });
    }

    // Paylaşımlı kapasite defteri: hedef (retailer|pk) → kalan kapasite
    const ledger = new Map<string, number>();
    for (const x of recs) if (x.cap > 0) ledger.set(x.r.retailer + "|" + x.r.product_key, x.cap);

    const base = (x: Rec) => ({
      retailer: x.r.retailer, sku_name: x.r.sku_name, barkod: x.r.barkod || "", season: x.sea,
      stock: x.stock, velocity: r1(x.v), coverage: x.cov == null ? null : Math.round(x.cov), psf: Math.round(x.psf), noPrice: x.noPrice,
    });

    // ── 2. Geçiş: kaynakları (ölü/aşırı) hedeflere dağıt (yüksek değer önce kapasiteyi kapar) ──
    const routes: any[] = [];
    const sources = recs.filter((x) => (x.intent === "dead" || x.intent === "overstock") && x.pull > 0)
      .sort((a, b) => (b.pull * b.psf) - (a.pull * a.psf));
    for (const x of sources) {
      const pk = x.r.product_key, psf = x.psf, pull = x.pull;
      const cands = (byKey.get(pk) || [])
        .filter((o) => o.retailer !== x.r.retailer && num(o.avg_weekly) >= DEAD)
        .map((o) => ({ o, rem: ledger.get(o.retailer + "|" + pk) || 0 }))
        .filter((c) => c.rem > 0)
        .sort((a, b) => b.rem - a.rem);
      let give = 0, target: any = null;
      if (cands.length) {
        const best = cands[0], g = Math.min(pull, best.rem);
        if (g > 0 && (g * psf >= FLOOR || psf <= 0)) {
          give = g; ledger.set(best.o.retailer + "|" + pk, best.rem - g);
          target = { retailer: best.o.retailer, qty: g, vel: r1(num(best.o.avg_weekly)) };
        }
      }
      const toDepot = pull - give;
      const action = give > 0 ? "TRANSFER" : "DEPO";
      const why = x.intent === "dead"
        ? (x.sea === "ESKİ" ? "Hiç satmıyor + eski sezon" : (byKey.get(pk)!.length > 1 ? "Burada ölü; başka kanal da dolu/yetersiz" : "Hiçbir kanalda satmıyor"))
        : `Aşırı stok (${base(x).coverage} hf) — ${keep} hf bırak, fazlasını çek${x.sea === "ESKİ" ? " · eski sezon" : ""}`;
      routes.push({ ...base(x), action, qty: pull, target, toDepot, value: x.noPrice ? 0 : Math.round(pull * psf), reason: target ? `${x.intent === "dead" ? "Burada ölü" : "Aşırı stok"} · ${target.retailer} alabilir (${target.vel}/hf, kapasite kadar)` : why });
    }
    // SEVK + İZLE
    for (const x of recs) {
      if (x.intent === "sevk") routes.push({ ...base(x), action: "SEVK", qty: x.ship, target: null, toDepot: 0, value: 0, reason: x.stock <= 0 ? "Tükendi — satıyor, sevk et" : `Az stok (${base(x).coverage} hf) — sevk et` });
      else if (x.intent === "izle") routes.push({ ...base(x), action: "İZLE", qty: 0, target: null, toDepot: 0, value: 0, reason: `Yeni ürün (${x.wk} hf veri) — karar için bekle` });
    }

    const sumv = (a: any[]) => a.reduce((s, r) => s + (r.value || 0), 0);
    const g = (act: string) => routes.filter((r) => r.action === act);
    const noPriceRows = routes.filter((r) => r.noPrice && (r.action === "TRANSFER" || r.action === "DEPO"));
    const summary = {
      transfer: { n: g("TRANSFER").length, psf: sumv(g("TRANSFER")) },
      depo: { n: g("DEPO").length, psf: sumv(g("DEPO")) },
      sevk: { n: g("SEVK").length },
      izle: { n: g("İZLE").length },
      cekToplam: sumv(g("TRANSFER")) + sumv(g("DEPO")),
      noPrice: noPriceRows.length,
    };
    const ord: Record<string, number> = { TRANSFER: 0, DEPO: 1, SEVK: 2, "İZLE": 3 };
    routes.sort((a, b) => (ord[a.action] - ord[b.action]) || (b.value - a.value) || (b.qty - a.qty));
    return NextResponse.json({ keep, summary, routes });
  } catch (e: any) {
    console.error("routing hatası:", e);
    return NextResponse.json({ error: "Sunucu hatası" }, { status: 500 });
  }
}
