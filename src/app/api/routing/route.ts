import { NextRequest, NextResponse } from "next/server";
import { supabase, fetchAllRows } from "@/lib/supabase";

export const runtime = "nodejs";
export const revalidate = 0;
export const maxDuration = 60;

// DİNAMİK STOK YÖNLENDİRME MOTORU (saf PSF, marj/KDV yok).
// Her firma×ürün için canlı karar: ÇEK→VER (transfer) / ÇEK→DEPO (iade/depo) / SEVK / İZLE.
// Kaynak: product_coverage matview (firma×ürün: hız, stok, kapsam, psf, hafta sayısı).
// product_key (barkod) ile firmalar arası eşleşip "nereye verilir" hesaplanır.
const DEAD = 1;        // <1 ad/hf = satmıyor
const OVER = 26;       // >26 hf kapsam = aşırı stok
const LOW = 8;         // <8 hf = az stok (sevk)
const NEW_WEEKS = 6;   // <6 hf veri = yeni ürün (iade etme, izle)
const ABSORB = 26;     // hedef kanal en fazla 26 hf'lik emer
const FLOOR = 25000;   // transfer alt sınırı (PSF) — altı lojistiğe değmez → depo

function season(name: string): "ESKİ" | "25/26" | "TREND" | "DİĞER" {
  const n = (name || "").toLowerCase();
  if (/25\s*[\/\-]?\s*26|2025\s*[\/\-]?\s*2?6/.test(n)) return "25/26";
  if (/22\s*[\/\-]\s*23|23\s*[\/\-]\s*24|24\s*[\/\-]\s*25|euro\s*2024|20(22|23|24)\b/.test(n)) return "ESKİ";
  if (/manifest|labubu|sevimli canavar|kpop|holomen|holomonster|rafadan|nice to know|\btork\b|minions|animal/.test(n)) return "TREND";
  return "DİĞER";
}
const num = (x: any) => (x == null ? 0 : Number(x) || 0);

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

    const routes: any[] = [];
    for (const r of rows) {
      const stock = num(r.last_stock), v = num(r.avg_weekly), psf = num(r.psf), wk = num(r.weeks);
      const cov = r.coverage_weeks == null ? null : Number(r.coverage_weeks);
      const sea = season(r.sku_name);
      const sellers = (byKey.get(r.product_key) || [])
        .filter((o) => o.retailer !== r.retailer && num(o.avg_weekly) >= DEAD)
        .sort((a, b) => num(b.avg_weekly) - num(a.avg_weekly));
      const base = {
        retailer: r.retailer, sku_name: r.sku_name, barkod: r.barkod || "", season: sea,
        stock, velocity: Math.round(v * 10) / 10, coverage: cov == null ? null : Math.round(cov), psf: Math.round(psf),
      };
      const capOf = (o: any) => Math.max(0, Math.floor(num(o.avg_weekly) * ABSORB - num(o.last_stock)));

      if (stock <= 0) {
        if (v >= DEAD) routes.push({ ...base, action: "SEVK", qty: Math.ceil(v * keep), target: null, toDepot: 0, value: 0, reason: "Tükendi — satıyor, sevk et" });
        continue;
      }

      if (v < DEAD) {
        // Burada ölü
        if (wk < NEW_WEEKS && sea !== "ESKİ") { routes.push({ ...base, action: "İZLE", qty: 0, target: null, toDepot: 0, value: 0, reason: `Yeni ürün (${wk} hf veri) — karar için bekle` }); continue; }
        const cand = sellers.map((o) => ({ o, cap: capOf(o) })).find((x) => x.cap > 0);
        if (cand && Math.min(stock, cand.cap) * psf >= FLOOR) {
          const give = Math.min(stock, cand.cap);
          routes.push({ ...base, action: "TRANSFER", qty: stock, target: { retailer: cand.o.retailer, qty: give, vel: Math.round(num(cand.o.avg_weekly) * 10) / 10 }, toDepot: stock - give, value: Math.round(stock * psf), reason: `Burada ölü (${base.velocity}/hf) · ${cand.o.retailer} satıyor (${Math.round(num(cand.o.avg_weekly) * 10) / 10}/hf)` });
        } else {
          routes.push({ ...base, action: "DEPO", qty: stock, target: null, toDepot: stock, value: Math.round(stock * psf), reason: sellers.length ? "Burada ölü; diğer kanallar da dolu/yetersiz" : (sea === "ESKİ" ? "Hiç satmıyor + eski sezon" : "Hiçbir kanalda satmıyor") });
        }
        continue;
      }

      // Satıyor
      if (cov != null && cov > OVER) {
        const pull = Math.max(0, stock - Math.ceil(v * keep));
        if (pull <= 0) continue;
        const needy = sellers.filter((o) => o.coverage_weeks != null && Number(o.coverage_weeks) < keep)
          .map((o) => ({ o, cap: capOf(o) })).find((x) => x.cap > 0);
        if (needy && Math.min(pull, needy.cap) * psf >= FLOOR) {
          const give = Math.min(pull, needy.cap);
          routes.push({ ...base, action: "TRANSFER", qty: pull, target: { retailer: needy.o.retailer, qty: give, vel: Math.round(num(needy.o.avg_weekly) * 10) / 10 }, toDepot: pull - give, value: Math.round(pull * psf), reason: `Aşırı stok (${base.coverage} hf) · ${needy.o.retailer} stoğu az → fazlayı kaydır` });
        } else {
          routes.push({ ...base, action: "DEPO", qty: pull, target: null, toDepot: pull, value: Math.round(pull * psf), reason: `Aşırı stok (${base.coverage} hf) — ${keep} hf bırak, fazlasını çek${sea === "ESKİ" ? " · eski sezon" : ""}` });
        }
        continue;
      }
      if (cov != null && cov < LOW) {
        routes.push({ ...base, action: "SEVK", qty: Math.max(0, Math.ceil(v * keep - stock)), target: null, toDepot: 0, value: 0, reason: `Az stok (${base.coverage} hf) — sevk et` });
      }
      // aksi halde TUT → listelenmez
    }

    const sumv = (a: any[]) => a.reduce((s, r) => s + (r.value || 0), 0);
    const g = (act: string) => routes.filter((r) => r.action === act);
    const summary = {
      transfer: { n: g("TRANSFER").length, psf: sumv(g("TRANSFER")) },
      depo: { n: g("DEPO").length, psf: sumv(g("DEPO")) },
      sevk: { n: g("SEVK").length },
      izle: { n: g("İZLE").length },
      cekToplam: sumv(g("TRANSFER")) + sumv(g("DEPO")),
    };
    const ord: Record<string, number> = { TRANSFER: 0, DEPO: 1, SEVK: 2, "İZLE": 3 };
    routes.sort((a, b) => (ord[a.action] - ord[b.action]) || (b.value - a.value) || (b.qty - a.qty));
    return NextResponse.json({ keep, summary, routes });
  } catch (e: any) {
    console.error("routing hatası:", e);
    return NextResponse.json({ error: "Sunucu hatası" }, { status: 500 });
  }
}
