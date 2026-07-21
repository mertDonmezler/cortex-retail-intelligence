import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/supabase";
import { netFactor } from "@/lib/margins";
import { RETAILERS } from "@/lib/normalizers/types";

export const runtime = "nodejs";
export const revalidate = 0;

// Haftalık durum mailini hazır metin olarak üretir (dashboard "Haftalık Mail"
// butonu). Kurallar, elle yazılan haftalık maillerle aynı:
//  • tablo NET kazanç (netFactor) ve adet, ciroya göre azalan;
//  • WoW karşılaştırması yalnız İKİ HAFTADA DA verisi olan firmalar üzerinden
//    (elmayla elma — eksik firma toplam büyümeyi çarpıtmasın);
//  • seçili haftada veri göndermeyen firmalar açıkça listelenir.
const AY = ["", "Ocak", "Şubat", "Mart", "Nisan", "Mayıs", "Haziran",
  "Temmuz", "Ağustos", "Eylül", "Ekim", "Kasım", "Aralık"];

function trRange(startIso: string, endIso: string): string {
  const s = new Date(startIso + "T00:00:00Z");
  const e = new Date(endIso + "T00:00:00Z");
  const sm = AY[s.getUTCMonth() + 1], em = AY[e.getUTCMonth() + 1];
  return sm === em
    ? `${s.getUTCDate()}-${e.getUTCDate()} ${em}`
    : `${s.getUTCDate()} ${sm}-${e.getUTCDate()} ${em}`;
}

const TL = (n: number) => Math.round(n).toLocaleString("tr-TR");
const pct = (cur: number, prev: number) => (prev > 0 ? ((cur - prev) / prev) * 100 : 0);

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const week = searchParams.get("week");
  if (!week || !/^\d{4}-\d{2}-\d{2}$/.test(week)) {
    return NextResponse.json({ error: "week gerekli (YYYY-MM-DD)" }, { status: 400 });
  }
  try {
    const prevWeek = new Date(week + "T00:00:00Z");
    prevWeek.setUTCDate(prevWeek.getUTCDate() - 7);
    const prevIso = prevWeek.toISOString().slice(0, 10);
    const endIso = (() => { const d = new Date(week + "T00:00:00Z"); d.setUTCDate(d.getUTCDate() + 6); return d.toISOString().slice(0, 10); })();

    const { data, error } = await supabase.from("weekly_summary")
      .select("retailer, week_start, sales_qty, sales_value")
      .in("week_start", [week, prevIso]);
    if (error) throw error;

    type Agg = { net: number; qty: number };
    const cur = new Map<string, Agg>(), prev = new Map<string, Agg>();
    for (const r of data ?? []) {
      const net = Number(r.sales_value ?? 0) * netFactor(r.retailer);
      const agg = { net, qty: Number(r.sales_qty) };
      if (r.week_start === week) cur.set(r.retailer, agg);
      else prev.set(r.retailer, agg);
    }
    if (cur.size === 0) {
      return NextResponse.json({ error: "Bu hafta için veri yok" }, { status: 404 });
    }

    const rows = [...cur.entries()].sort((a, b) => b[1].net - a[1].net);
    const missing = RETAILERS.filter((r) => !cur.has(r));
    const totNet = rows.reduce((a, [, v]) => a + v.net, 0);
    const totQty = rows.reduce((a, [, v]) => a + v.qty, 0);

    // WoW — yalnız iki haftada da olan firmalar (elmayla elma).
    const both = rows.filter(([r]) => prev.has(r));
    const curB = both.reduce((a, [, v]) => a + v.net, 0);
    const prevB = both.reduce((a, [r]) => a + prev.get(r)!.net, 0);
    const wow = both.length >= 2 && prevB > 0 ? pct(curB, prevB) : null;
    const movers = both
      .map(([r, v]) => ({ r, d: pct(v.net, prev.get(r)!.net) }))
      .filter((m) => isFinite(m.d))
      .sort((a, b) => b.d - a.d);

    const range = trRange(week, endIso);
    const tamKadro = missing.length === 0;
    const isim = (r: string) => (r === "DR" ? "D&R" : r);
    // "A, B ve C" — Türkçe doğal listeleme (tek öğede olduğu gibi).
    const listTr = (a: string[]) =>
      a.length <= 1 ? (a[0] ?? "") : `${a.slice(0, -1).join(", ")} ve ${a[a.length - 1]}`;

    // ── Metin ────────────────────────────────────────────────────────────────
    const L: string[] = [];
    L.push(`Konu: Haftalık Satış & Stok Durumu — ${range}`);
    L.push("");
    L.push("Merhaba,");
    L.push("");
    L.push(`${range} haftasının tablosu aşağıda (rakamlar NET kazanç).` +
      (tamKadro ? " Hafta 5 firmayla tam." :
        ` ${listTr(missing.map(isim))} bu haftanın verisini henüz göndermedi; geldiğinde güncellenir.`));
    L.push("");
    L.push(`${range}:`);
    for (const [r, v] of rows) {
      L.push(`  ${isim(r).padEnd(11)}${TL(v.net).padStart(12)} ₺${String(TL(v.qty)).padStart(10)} adet`);
    }
    L.push(`  ${"─".repeat(40)}`);
    L.push(`  ${"TOPLAM".padEnd(11)}${TL(totNet).padStart(12)} ₺${String(TL(totQty)).padStart(10)} adet` +
      (tamKadro ? "" : `   (${missing.map(isim).join("+")} hariç)`));
    L.push("");
    if (wow != null) {
      const yön = wow >= 0 ? "büyüdü" : "daraldı";
      L.push(`Geçen haftaya göre (aynı ${both.length} firma) ağ yaklaşık %${Math.abs(wow).toFixed(0)} ${yön}.` +
        (movers.length >= 2
          ? ` En güçlü: ${isim(movers[0].r)} (${movers[0].d >= 0 ? "+" : ""}%${movers[0].d.toFixed(0)}); ` +
            `en zayıf: ${isim(movers[movers.length - 1].r)} (%${movers[movers.length - 1].d.toFixed(0)}).`
          : ""));
      L.push("");
    }
    L.push("Tüm rakamlar CORTEX'te canlı; detay ve SKU kırılımı panelde.");
    L.push("");
    L.push("Saygılarımla,");
    L.push("Mert Dönmezler");
    L.push("Mythos Cards");

    return NextResponse.json({
      week, range, missing, text: L.join("\n"),
      totals: { net: totNet, qty: totQty, retailers: rows.length },
    });
  } catch (e: any) {
    console.error("weekly-report hatası:", e);
    return NextResponse.json({ error: "Sunucu hatası" }, { status: 500 });
  }
}
