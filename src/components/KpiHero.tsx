"use client";

import { WeeklySummary, RETAILERS, fmtMoney, fmtDate } from "@/lib/format";
import { AnimatedNumber } from "./AnimatedNumber";
import { Info } from "./Info";

// Üst KPI şeridi — seçili hafta için ağ geneli özet + WoW deltaları TEK yerde
// (eski ayrı "Ağ KPI" şeridi aynı sayıları ikinci kez basıyordu → birleştirildi).
//
// DELTA MATEMATİĞİ (kritik): karşılaştırma yalnız İKİ HAFTADA DA veri göndermiş
// firmalar (ortak kohort) üzerinden yapılır. Kısmi haftada 3 firmayı 5 firmalık
// geçen haftayla kıyaslamak "+%66 büyüdük" gibi elma-armut sonuçlar üretiyordu;
// kohort bunu keser. Önceki hafta = takvimsel −7 gün (boşluklu seride en yakın
// dolu hafta DEĞİL — "geçen haftaya göre" ifadesinin dürüst hali).
export function KpiHero({
  summary, week, visible,
}: {
  summary: WeeklySummary[];
  week: string;
  visible: string[];
}) {
  const vis = new Set(visible);
  const wk = summary.filter((s) => s.week_start === week && vis.has(s.retailer));

  const prevIso = (() => {
    const d = new Date(week + "T00:00:00Z");
    d.setUTCDate(d.getUTCDate() - 7);
    return d.toISOString().slice(0, 10);
  })();
  const pw = summary.filter((s) => s.week_start === prevIso && vis.has(s.retailer));
  const pwByRet = new Map(pw.map((s) => [s.retailer, s]));

  // Görünen toplamlar (seçili haftanın TAMAMI — kohorta daraltılmaz).
  const totalQty = wk.reduce((a, s) => a + Number(s.sales_qty), 0);
  const totalVal = wk.reduce((a, s) => a + Number(s.sales_value ?? 0), 0);
  const totalStock = wk.reduce((a, s) => a + Number(s.stock_qty), 0);
  const totalSku = wk.reduce((a, s) => a + Number(s.sku_count), 0);
  const sellThrough = totalQty + totalStock > 0 ? (totalQty / (totalQty + totalStock)) * 100 : 0;

  // Ortak kohort (iki haftada da olanlar) — deltalar YALNIZ bunun üzerinden.
  const common = wk.filter((s) => pwByRet.has(s.retailer));
  const agg = (rows: WeeklySummary[]) => ({
    qty: rows.reduce((a, s) => a + Number(s.sales_qty), 0),
    val: rows.reduce((a, s) => a + Number(s.sales_value ?? 0), 0),
    stock: rows.reduce((a, s) => a + Number(s.stock_qty), 0),
  });
  const c = agg(common);
  const p = agg(pw.filter((s) => common.some((x) => x.retailer === s.retailer)));
  const stC = c.qty + c.stock > 0 ? (c.qty / (c.qty + c.stock)) * 100 : 0;
  const stP = p.qty + p.stock > 0 ? (p.qty / (p.qty + p.stock)) * 100 : 0;
  const pct = (cur: number, prev: number) => (prev > 0 ? ((cur - prev) / prev) * 100 : null);
  const cohortOk = common.length >= 1;

  // Hafta tamlığı: kaç firma veri gönderdi (görünürlük filtresinden bağımsız —
  // "hafta kısmi mi" sorusu ağın gerçeğidir, kullanıcının filtre seçimi değil).
  const weekFirms = new Set(summary.filter((s) => s.week_start === week).map((s) => s.retailer)).size;
  const partial = weekFirms < RETAILERS.length;

  type It = {
    label: string; value: number; suffix?: string; color: string; glow?: boolean;
    fmt?: (n: number) => string; info: string; d?: number | null; pts?: boolean;
  };
  const items: It[] = [
    { label: "TOPLAM SATIŞ", value: totalQty, suffix: "adet", color: "#1FF80B", glow: true,
      d: cohortOk ? pct(c.qty, p.qty) : null,
      info: "Seçili haftada görünür firmaların toplam satış adedi. Delta: yalnız iki haftada da veri olan firmalar (aynı-firma kohortu)." },
    { label: "TOPLAM CİRO", value: totalVal, fmt: (n) => fmtMoney(n), color: "#d8e8d8",
      d: cohortOk ? pct(c.val, p.val) : null,
      info: "NET kazanç: PSF × (1 − kanal marjı) ÷ 1,20 (KDV). Delta aynı-firma kohortuyla hesaplanır." },
    { label: "TOPLAM STOK", value: totalStock, suffix: "adet", color: "#9b6bff",
      d: cohortOk ? pct(c.stock, p.stock) : null,
      info: "Hafta sonu kanal stoğu (raf/satılabilir). Delta aynı-firma kohortuyla." },
    { label: "AKTİF SKU", value: totalSku, suffix: "ürün", color: "#0bd1f8",
      info: "Bu hafta satış veya stok bildiren ürün sayısı (firma başına ayrı sayılır)." },
    { label: "SELL-THROUGH", value: sellThrough, fmt: (n) => n.toFixed(1) + "%", color: "#f8b00b",
      d: cohortOk ? stC - stP : null, pts: true,
      info: "Satış ÷ (satış + stok): raftaki malın bu hafta eriyen payı. Delta puan farkı, aynı-firma kohortuyla." },
    { label: "FİRMA", value: weekFirms, suffix: `/ ${RETAILERS.length} gönderdi`, color: partial ? "#f8b00b" : "#f80b8a",
      info: partial
        ? "KISMİ HAFTA: bazı firmalar bu haftanın verisini henüz göndermedi — toplamlar eksik, tabloda temkinli ol."
        : "Hafta tam: 5 firmanın verisi de yüklü." },
  ];

  return (
    <div>
      <div className="flex items-center justify-between flex-wrap gap-2 mb-2">
        <span className="mono text-[10px] text-txt-dim tracking-wider">
          {partial && (
            <span className="mono text-[10px] px-2 py-0.5 rounded mr-2"
              style={{ color: "#f8b00b", border: "1px solid #f8b00b40", background: "#f8b00b14" }}>
              ⚠ KISMİ HAFTA · {weekFirms}/{RETAILERS.length} firma
            </span>
          )}
          Δ = {fmtDate(prevIso)} haftasına göre{cohortOk ? ` · aynı ${common.length} firma` : " · karşılaştırılabilir firma yok"}
        </span>
      </div>
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
        {items.map((it, i) => {
          const up = it.d != null && it.d >= 0;
          const dc = it.d == null ? "#7d927d" : up ? "#1FF80B" : "#ff5555";
          return (
            <div key={it.label} className={`card p-4 ${it.glow ? "neon-glow" : ""}`}
              style={{ animationDelay: `${i * 60}ms` }}>
              <div className="mono text-[10px] text-txt-dim tracking-wider">{it.label}<Info text={it.info} /></div>
              <div className="text-2xl font-bold mono mt-1" style={{ color: it.color }}>
                <AnimatedNumber value={it.value} format={it.fmt} />
              </div>
              <div className="flex items-center justify-between gap-1 min-h-[16px]">
                {it.suffix ? <span className="mono text-[10px] text-txt-dim">{it.suffix}</span> : <span />}
                {it.d != null && (
                  <span className="mono text-[10px] px-1 rounded shrink-0" style={{ color: dc }}
                    title={`${fmtDate(prevIso)} haftasına göre, aynı-firma kohortu`}>
                    {up ? "▲" : "▼"} {it.pts ? `${up ? "+" : ""}${it.d.toFixed(1)} pt` : `${up ? "+" : ""}${it.d.toFixed(1)}%`}
                  </span>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
