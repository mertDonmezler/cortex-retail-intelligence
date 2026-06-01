"use client";

import { useEffect, useState } from "react";
import { motion } from "framer-motion";
import { RETAILERS, fmtInt, fmtPct, fmtDate } from "@/lib/format";
import { downloadCsv } from "@/lib/csv";

type View = "gainers" | "losers" | "newSkus" | "lostSkus";

export default function ComparePage() {
  const [retailer, setRetailer] = useState("DR");
  const [weeks, setWeeks] = useState<string[]>([]);
  const [weekA, setWeekA] = useState("");
  const [weekB, setWeekB] = useState("");
  const [data, setData] = useState<any>(null);
  const [loading, setLoading] = useState(false);
  const [view, setView] = useState<View>("gainers");
  const [err, setErr] = useState("");

  // Hafta listesini yükle
  useEffect(() => {
    setErr("");
    fetch(`/api/compare?retailer=${encodeURIComponent(retailer)}`)
      .then(async (r) => {
        const d = await r.json().catch(() => ({}));
        if (!r.ok || d?.error) throw new Error(d?.error || ("Sunucu hatası " + r.status));
        return d;
      })
      .then((d) => {
        const w = d.weeks ?? [];
        setWeeks(w);
        if (w.length >= 2) { setWeekB(w[0]); setWeekA(w[1]); }
        else { setWeekA(""); setWeekB(""); setData(null); }
      })
      .catch((e) => {
        // Hata: hafta listesini güvenli boş default'a çek ki render çökmesin
        setErr(e.message);
        setWeeks([]); setWeekA(""); setWeekB(""); setData(null);
      });
  }, [retailer]);

  // Karşılaştır
  useEffect(() => {
    if (!weekA || !weekB || weekA === weekB) { setData(null); return; }
    setLoading(true);
    setErr("");
    setData(null); // Perakendeci/hafta değişince eski veri ekranda kalmasın
    fetch(`/api/compare?retailer=${encodeURIComponent(retailer)}&a=${weekA}&b=${weekB}`)
      .then(async (r) => {
        const d = await r.json().catch(() => ({}));
        if (!r.ok || d?.error) throw new Error(d?.error || ("Sunucu hatası " + r.status));
        return d;
      })
      .then((d) => setData(d))
      .catch((e) => {
        // Hata: karşılaştırma verisini güvenli boş default'a çek
        setErr(e.message);
        setData(null);
      })
      .finally(() => setLoading(false));
  }, [retailer, weekA, weekB]);

  const views: { id: View; label: string }[] = [
    { id: "gainers", label: "📈 Artanlar" },
    { id: "losers", label: "📉 Azalanlar" },
    { id: "newSkus", label: "✨ Yeni Çıkanlar" },
    { id: "lostSkus", label: "⊘ Kaybolanlar" },
  ];
  const rows = (data?.[view] as any[]) ?? [];

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">Dönem <span className="neon-text">Karşılaştırma</span></h1>
        <p className="text-txt-dim mono text-sm mt-1">İki haftayı SKU bazında yan yana karşılaştır</p>
      </div>

      <div className="card p-4 flex flex-wrap items-end gap-4">
        <div>
          <label className="mono text-xs text-txt-dim block mb-1">Perakendeci</label>
          <select value={retailer} onChange={(e) => setRetailer(e.target.value)}
            className="card mono text-sm px-3 py-2 bg-ink-2 outline-none focus:border-neon">
            {RETAILERS.map((r) => <option key={r} className="bg-ink-2">{r}</option>)}
          </select>
        </div>
        <div>
          <label className="mono text-xs text-txt-dim block mb-1">Baz hafta (A)</label>
          <select value={weekA} onChange={(e) => setWeekA(e.target.value)}
            className="card mono text-sm px-3 py-2 bg-ink-2 outline-none focus:border-neon">
            {weeks.map((w) => <option key={w} value={w} className="bg-ink-2">{fmtDate(w)}</option>)}
          </select>
        </div>
        <div className="mono text-txt-dim pb-2">→</div>
        <div>
          <label className="mono text-xs text-txt-dim block mb-1">Karşılaştırılan (B)</label>
          <select value={weekB} onChange={(e) => setWeekB(e.target.value)}
            className="card mono text-sm px-3 py-2 bg-ink-2 outline-none focus:border-neon">
            {weeks.map((w) => <option key={w} value={w} className="bg-ink-2">{fmtDate(w)}</option>)}
          </select>
        </div>
        {rows.length > 0 && (
          <button onClick={() => downloadCsv(`cortex-karsilastirma-${view}`, rows, [
            { key: "sku_name", label: "Ürün" }, { key: "retailer", label: "Perakendeci" },
            { key: "a_qty", label: "A" }, { key: "b_qty", label: "B" },
            { key: "delta", label: "Fark" }, { key: "delta_pct", label: "Fark %" },
          ])}
            className="mono text-xs px-4 py-2 rounded-lg border border-line text-txt-dim hover:border-neon hover:text-neon transition-colors ml-auto">
            ⬇ CSV
          </button>
        )}
      </div>

      {err && <div className="card p-4 border-red-500/40 text-red-400 mono text-sm">Veri alınamadı: {err}</div>}

      {err ? null : weeks.length < 2 ? (
        <div className="card p-10 text-center mono text-txt-dim">{retailer} için karşılaştırma yapacak en az 2 hafta yok.</div>
      ) : weekA === weekB ? (
        <div className="card p-10 text-center mono text-txt-dim">Farklı iki hafta seç.</div>
      ) : (
        <>
          <div className="flex gap-1 flex-wrap">
            {views.map((v) => (
              <button key={v.id} onClick={() => setView(v.id)}
                className={`mono text-sm px-4 py-2 rounded-lg transition-colors ${view === v.id ? "bg-neon/15 text-neon" : "text-txt-dim hover:text-txt"}`}>
                {v.label} {data?.[v.id] ? `(${data[v.id].length})` : ""}
              </button>
            ))}
          </div>

          {loading ? (
            <div className="card p-10 text-center mono text-txt-dim animate-pulse">Yükleniyor…</div>
          ) : (
            <div className="card p-6 overflow-x-auto">
              <table>
                <thead>
                  <tr><th>Ürün</th><th>Perakendeci</th><th>{fmtDate(weekA)}</th><th>{fmtDate(weekB)}</th><th>Fark</th><th>%</th></tr>
                </thead>
                <tbody>
                  {rows.map((r: any, i: number) => (
                    <motion.tr key={i} initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: i * 0.02 }}>
                      <td className="max-w-xs truncate" title={r?.sku_name}>{r?.sku_name ?? "—"}</td>
                      <td className="mono text-xs text-txt-dim">{r?.retailer ?? "—"}</td>
                      <td className="mono">{fmtInt(r?.a_qty ?? 0)}</td>
                      <td className="mono">{fmtInt(r?.b_qty ?? 0)}</td>
                      <td className={`mono ${(r?.delta ?? 0) >= 0 ? "text-neon" : "text-red-400"}`}>{(r?.delta ?? 0) >= 0 ? "+" : ""}{fmtInt(r?.delta ?? 0)}</td>
                      <td className={`mono ${(r?.delta_pct ?? 0) >= 0 ? "text-neon" : "text-red-400"}`}>{r?.delta_pct != null ? fmtPct(r.delta_pct) : "yeni"}</td>
                    </motion.tr>
                  ))}
                </tbody>
              </table>
              {rows.length === 0 && <div className="mono text-sm text-txt-dim text-center py-6">Bu kategoride değişim yok</div>}
            </div>
          )}
        </>
      )}
    </div>
  );
}
