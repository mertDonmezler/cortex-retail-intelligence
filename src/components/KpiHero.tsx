"use client";

import { WeeklySummary, fmtMoney } from "@/lib/format";
import { AnimatedNumber } from "./AnimatedNumber";

// Üst KPI şeridi — seçili hafta için ağ geneli özet.
export function KpiHero({ summary, week }: { summary: WeeklySummary[]; week: string }) {
  const wk = summary.filter((s) => s.week_start === week);
  const totalQty = wk.reduce((a, s) => a + Number(s.sales_qty), 0);
  const totalVal = wk.reduce((a, s) => a + Number(s.sales_value ?? 0), 0);
  const totalStock = wk.reduce((a, s) => a + Number(s.stock_qty), 0);
  const activeRetailers = wk.length;
  const totalSku = wk.reduce((a, s) => a + Number(s.sku_count), 0);
  const sellThrough = totalQty + totalStock > 0 ? (totalQty / (totalQty + totalStock)) * 100 : 0;

  const items = [
    { label: "TOPLAM SATIŞ", value: totalQty, suffix: "adet", color: "#1FF80B", glow: true },
    { label: "TOPLAM CİRO", value: totalVal, fmt: (n: number) => fmtMoney(n), color: "#d8e8d8" },
    { label: "TOPLAM STOK", value: totalStock, suffix: "adet", color: "#9b6bff" },
    { label: "AKTİF SKU", value: totalSku, suffix: "ürün", color: "#0bd1f8" },
    { label: "SELL-THROUGH", value: sellThrough, fmt: (n: number) => n.toFixed(1) + "%", color: "#f8b00b" },
    { label: "PERAKENDECİ", value: activeRetailers, suffix: "aktif", color: "#f80b8a" },
  ];

  return (
    <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
      {items.map((it, i) => (
        <div
          key={it.label}
          className={`card p-4 ${it.glow ? "neon-glow" : ""}`}
          style={{ animationDelay: `${i * 60}ms` }}
        >
          <div className="mono text-[10px] text-txt-dim tracking-wider">{it.label}</div>
          <div className="text-2xl font-bold mono mt-1" style={{ color: it.color }}>
            <AnimatedNumber value={it.value} format={it.fmt} />
          </div>
          {it.suffix && <div className="mono text-[10px] text-txt-dim">{it.suffix}</div>}
        </div>
      ))}
    </div>
  );
}
