"use client";

import { useEffect, useState } from "react";
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend,
} from "recharts";
import { fmtInt, fmtMoney, fmtDate, RETAILER_COLORS } from "@/lib/format";
import { fetchJson } from "@/lib/fetchJson";

const COLORS = RETAILER_COLORS;

export default function ProductPage() {
  const [q, setQ] = useState("");
  const [results, setResults] = useState<any[]>([]);
  const [selected, setSelected] = useState<any>(null);
  const [searching, setSearching] = useState(false);
  const [err, setErr] = useState("");

  // Debounced arama
  useEffect(() => {
    if (q.length < 2) { setResults([]); setErr(""); return; }
    setSearching(true);
    setErr("");
    const t = setTimeout(() => {
      fetchJson(`/api/product?q=${encodeURIComponent(q)}`)
        .then((d) => setResults(d.results ?? []))
        .catch((e) => { setErr(e.message); setResults([]); })
        .finally(() => setSearching(false));
    }, 300);
    return () => clearTimeout(t);
  }, [q]);

  function selectProduct(barkod: string) {
    setErr("");
    fetchJson(`/api/product?barkod=${encodeURIComponent(barkod)}`)
      .then((d) => setSelected(d))
      .catch((e) => { setErr(e.message); setSelected(null); });
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">
          Ürün <span className="neon-text">Karşılaştırma</span>
        </h1>
        <p className="text-txt-dim mono text-sm mt-1">
          Bir ürünün tüm perakendecilerdeki performansı — barkod bazlı cross-retailer
        </p>
      </div>

      <div className="card p-4">
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="🔍 ürün ara (örn. Galatasaray, Beşiktaş, booster…)"
          className="card mono text-sm px-4 py-3 bg-ink-2 outline-none focus:border-neon w-full"
        />
        {searching && <div className="mono text-xs text-txt-dim mt-2 animate-pulse">aranıyor…</div>}
        {err && (
          <div className="card p-4 mt-3 border-red-500/40 text-red-400 mono text-sm">
            Veri alınamadı: {err}
          </div>
        )}
        {!err && !searching && q.length >= 2 && results.length === 0 && (
          <div className="mono text-xs text-txt-dim mt-2">Sonuç bulunamadı.</div>
        )}
        {results.length > 0 && (
          <div className="mt-3 space-y-1 max-h-64 overflow-y-auto">
            {results.map((r) => (
              <button
                key={r.barkod}
                onClick={() => selectProduct(r.barkod)}
                className="w-full text-left px-3 py-2 rounded-lg hover:bg-neon/5 transition-colors flex items-center justify-between gap-3"
              >
                <span className="text-sm truncate">{r.name}</span>
                <span className="flex gap-1 shrink-0">
                  {(r.retailers ?? []).map((ret: string) => (
                    <span key={ret} className="mono text-[10px] px-1.5 py-0.5 rounded"
                      style={{ color: COLORS[ret], border: `1px solid ${COLORS[ret]}40` }}>
                      {ret}
                    </span>
                  ))}
                </span>
              </button>
            ))}
          </div>
        )}
      </div>

      {selected && (
        <>
          <div className="card p-5">
            <div className="mono text-xs text-txt-dim">BARKOD {selected.barkod}</div>
            <h2 className="text-xl font-bold mt-1">{selected.name}</h2>
          </div>

          {/* Perakendeci toplamları */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            {(selected?.totals ?? []).map((t: any) => (
              <div key={t.retailer} className="card p-4 border-l-2"
                style={{ borderLeftColor: COLORS[t.retailer] }}>
                <div className="font-semibold" style={{ color: COLORS[t.retailer] }}>{t.retailer}</div>
                <div className="mono text-2xl font-bold mt-1">{fmtInt(t.total_qty)}</div>
                <div className="mono text-xs text-txt-dim">toplam adet</div>
                <div className="mono text-xs text-txt mt-2">{t.total_val > 0 ? fmtMoney(t.total_val) : "—"}</div>
                <div className="mono text-xs text-txt-dim">stok: {fmtInt(t.last_stock)}</div>
              </div>
            ))}
          </div>

          {/* Cross-retailer zaman serisi */}
          <div className="card p-6">
            <h3 className="font-bold mb-4">Haftalık Satış — Perakendeci Karşılaştırması</h3>
            <ResponsiveContainer width="100%" height={340}>
              <LineChart data={selected?.series ?? []} margin={{ top: 8, right: 16, bottom: 8, left: 8 }}>
                <CartesianGrid stroke="#1f2a1f" strokeDasharray="3 3" />
                <XAxis dataKey="week" stroke="#7d927d" fontSize={11}
                  tickFormatter={(w) => fmtDate(w)} tickMargin={8} />
                <YAxis stroke="#7d927d" fontSize={11} width={48} />
                <Tooltip
                  contentStyle={{ background: "#0f150f", border: "1px solid #1f2a1f", borderRadius: 10, fontSize: 12 }}
                  labelFormatter={(w) => fmtDate(w as string)}
                />
                <Legend wrapperStyle={{ fontSize: 12 }} />
                {(selected?.retailers ?? []).map((ret: string) => (
                  <Line key={ret} type="monotone" dataKey={ret} stroke={COLORS[ret]}
                    strokeWidth={2} dot={{ r: 2 }} connectNulls />
                ))}
              </LineChart>
            </ResponsiveContainer>
          </div>
        </>
      )}
    </div>
  );
}
