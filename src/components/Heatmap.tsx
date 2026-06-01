"use client";

import { WeeklySummary, RETAILERS, fmtDate, fmtInt } from "@/lib/format";

// Perakendeci × hafta satış yoğunluğu ısı haritası.
export function Heatmap({ summary }: { summary: WeeklySummary[] }) {
  const weeks = [...new Set(summary.map((s) => s.week_start))].sort();
  if (weeks.length < 2) return null;

  // Her perakendeci için kendi maksimumuna göre normalize (satır-bazlı yoğunluk)
  const lookup = new Map<string, number>();
  for (const s of summary) lookup.set(`${s.retailer}|${s.week_start}`, Number(s.sales_qty));

  const rowMax = new Map<string, number>();
  for (const r of RETAILERS) {
    const vals = weeks.map((w) => lookup.get(`${r}|${w}`) ?? 0);
    rowMax.set(r, Math.max(...vals, 1));
  }

  function cellColor(retailer: string, week: string): string {
    const v = lookup.get(`${retailer}|${week}`);
    if (v === undefined) return "transparent";
    const intensity = v / (rowMax.get(retailer) ?? 1);
    return `rgba(31, 248, 11, ${(0.06 + intensity * 0.85).toFixed(3)})`;
  }

  return (
    <div className="card p-6 overflow-x-auto">
      <h2 className="font-bold mb-4">Satış Yoğunluğu — Perakendeci × Hafta</h2>
      <div className="min-w-fit">
        <div className="flex gap-1 mb-1">
          <div className="w-20 shrink-0" />
          {weeks.map((w) => (
            <div key={w} className="w-7 shrink-0 mono text-[8px] text-txt-dim text-center -rotate-45 origin-center h-8">
              {new Date(w).toLocaleDateString("tr-TR", { day: "2-digit", month: "2-digit" })}
            </div>
          ))}
        </div>
        {RETAILERS.map((r) => (
          <div key={r} className="flex gap-1 mb-1 items-center">
            <div className="w-20 shrink-0 mono text-xs text-txt-dim text-right pr-2">{r}</div>
            {weeks.map((w) => {
              const v = lookup.get(`${r}|${w}`);
              return (
                <div
                  key={w}
                  className="w-7 h-7 shrink-0 rounded-sm border border-line/50 transition-transform hover:scale-125 hover:z-10 cursor-default"
                  style={{ background: cellColor(r, w) }}
                  title={v !== undefined ? `${r} · ${fmtDate(w)}\n${fmtInt(v)} adet` : `${r} · ${fmtDate(w)}\nveri yok`}
                />
              );
            })}
          </div>
        ))}
      </div>
      <div className="flex items-center gap-2 mt-4 mono text-[10px] text-txt-dim">
        <span>az</span>
        {[0.1, 0.3, 0.5, 0.7, 0.9].map((o) => (
          <div key={o} className="w-4 h-4 rounded-sm" style={{ background: `rgba(31,248,11,${o})` }} />
        ))}
        <span>çok</span>
        <span className="ml-2">· her satır kendi maksimumuna göre</span>
      </div>
    </div>
  );
}
