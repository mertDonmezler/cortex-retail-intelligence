"use client";

import { useState } from "react";
import { WeeklySummary, fmtInt, fmtMoney, fmtPct } from "@/lib/format";
import { Sparkline } from "./Sparkline";
import { CHANNEL_TERMS } from "@/lib/margins";

interface Props {
  retailer: string;
  week: string;
  summary: WeeklySummary[];
  wowMetric?: "value" | "qty"; // WoW/ortalama hangi metrikte — varsayılan ciro (TL)
}

export function RetailerCard({ retailer, week, summary, wowMetric = "value" }: Props) {
  const [top, setTop] = useState<{ sku_name: string; sales_qty: number }[] | null>(null);
  const [open, setOpen] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const terms = CHANNEL_TERMS[retailer];

  const rWeeks = summary
    .filter((s) => s.retailer === retailer)
    .sort((a, b) => a.week_start.localeCompare(b.week_start));
  const cur = rWeeks.find((s) => s.week_start === week);

  if (!cur) {
    return (
      <div className="card p-5 opacity-50">
        <div className="font-bold">{retailer}</div>
        <div className="mono text-xs text-txt-dim mt-4">bu hafta veri yok</div>
      </div>
    );
  }

  // WoW & ortalama: TL (ciro) bazlı — adet artıp ciro düşebilir; karar TL'ye bakmalı.
  const idx = rWeeks.findIndex((s) => s.week_start === week);
  const prev = idx > 0 ? rWeeks[idx - 1] : null;
  const hist = rWeeks.filter((s) => s.week_start < week);

  const useVal = wowMetric !== "qty"; // varsayılan ciro (TL)
  const mLbl = useVal ? "TL" : "Adet";
  const curQty = Number(cur.sales_qty);
  const curVal = cur.has_value ? Number(cur.sales_value) : null;
  // Seçilen metriğe (ciro/adet) göre cur/prev/geçmiş — WoW & ortalama bunun üzerinden
  const curM = useVal ? curVal : curQty;
  const prevM = useVal
    ? (prev && prev.has_value ? Number(prev.sales_value) : null)
    : (prev ? Number(prev.sales_qty) : null);
  const wow = curM != null && prevM != null && prevM > 0 ? ((curM - prevM) / prevM) * 100 : null;
  const histM = useVal
    ? hist.filter((s) => s.has_value).map((s) => Number(s.sales_value))
    : hist.map((s) => Number(s.sales_qty));
  const avgM = histM.length ? histM.reduce((a, b) => a + b, 0) / histM.length : null;
  const avgPct = curM != null && avgM && avgM > 0 ? ((curM - avgM) / avgM) * 100 : null;

  // Sparkline: seçilen metriğin son 10 hafta trendi
  // TL modunda has_value=false (ciro yok) haftaları 0 çizmesin → WoW/ort ile aynı taban.
  const sparkData = rWeeks
    .filter((s) => s.week_start <= week && (useVal ? s.has_value : true))
    .slice(-10)
    .map((s) => (useVal ? Number(s.sales_value ?? 0) : Number(s.sales_qty)));

  async function loadTop() {
    if (top) { setOpen(!open); return; }
    setOpen(true);
    setErr(null);
    try {
      const r = await fetch(`/api/sku?retailer=${encodeURIComponent(retailer)}&week=${week}`);
      const d = await r.json().catch(() => ({}));
      if (!r.ok || d?.error) throw new Error(d?.error || ("Sunucu hatası " + r.status));
      setTop(d?.top ?? []);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
      // hatada güvenli boş liste; "veri yok" ile karışmaması için err ayrıca gösterilir
      setTop([]);
    }
  }

  const wowColor = wow == null ? "text-txt-dim" : wow >= 0 ? "text-neon" : "text-red-400";
  const avgColor = avgPct == null ? "text-txt-dim" : avgPct >= 0 ? "text-neon" : "text-red-400";

  return (
    <div className="card p-5 flex flex-col">
      <div className="flex items-start justify-between">
        <div className="font-bold text-lg">{retailer}</div>
        <Sparkline data={sparkData} color={wow != null && wow < 0 ? "#ff5555" : "#1FF80B"} />
      </div>

      <div className="mt-3">
        <div className="text-3xl font-bold mono neon-text">
          {curVal != null ? fmtMoney(curVal) : "₺—"}
        </div>
        <div className="mono text-xs text-txt-dim">net ciro (TL)</div>
      </div>

      <div className="mono text-sm mt-2 text-txt">
        {fmtInt(curQty)} <span className="text-txt-dim text-xs">adet</span>
      </div>

      {terms && (
        <div className="mono text-[10px] text-txt-dim mt-2 opacity-70">
          marj %{terms.margin} · {terms.payment === "Satıştan Ödeme" ? "satıştan ödeme" : "faturadan"}{terms.vadeDays != null ? ` · ${terms.vadeDays}g vade` : ""}
        </div>
      )}

      <div className="mt-3 space-y-1 text-xs mono">
        <div className="flex justify-between">
          <span className="text-txt-dim">WoW ({mLbl})</span>
          <span className={wowColor}>{fmtPct(wow)}</span>
        </div>
        <div className="flex justify-between">
          <span className="text-txt-dim">vs Ort ({histM.length}hf · {mLbl})</span>
          <span className={avgColor}>{fmtPct(avgPct)}</span>
        </div>
      </div>

      <button
        onClick={loadTop}
        className="mt-4 mono text-xs text-txt-dim hover:text-neon transition-colors text-left"
      >
        {open ? "▼" : "▶"} en çok satanlar
      </button>

      {open && (
        <div className="mt-2 space-y-1">
          {err ? (
            <div className="card p-2 border-red-500/40 text-red-400 mono text-xs">
              Veri alınamadı: {err}
            </div>
          ) : top === null ? (
            <div className="mono text-xs text-txt-dim animate-pulse">…</div>
          ) : top.length === 0 ? (
            <div className="mono text-xs text-txt-dim">—</div>
          ) : (
            (top ?? []).map((t, i) => (
              <div key={i} className="flex justify-between gap-2 text-xs">
                <span className="text-txt truncate" title={t.sku_name}>
                  {t.sku_name}
                </span>
                <span className="mono neon-text shrink-0">{fmtInt(t.sales_qty)}</span>
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
}
