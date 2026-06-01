"use client";

import { useEffect, useState } from "react";
import { motion } from "framer-motion";
import { fmtInt, fmtMoney, fmtPct, fmtDate } from "@/lib/format";
import { downloadCsv } from "@/lib/csv";

const COLORS: Record<string, string> = {
  Nezih: "#1FF80B", Huppaluppo: "#0bd1f8", Armağan: "#f8b00b", Toyzz: "#f80b8a", DR: "#9b6bff",
};

type Tab = "top" | "risers" | "fallers" | "categories";

export default function RankingsPage() {
  const [data, setData] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [weeks, setWeeks] = useState<string[]>([]);
  const [week, setWeek] = useState<string>(""); // "" = en güncel hafta
  const [tab, setTab] = useState<Tab>("top");
  const [catDim, setCatDim] = useState<"brand" | "team" | "type">("team");
  const [metric, setMetric] = useState<"value" | "qty">("value"); // büyüme bazı — varsayılan ciro

  useEffect(() => {
    setLoading(true);
    const params = new URLSearchParams();
    if (week) params.set("week", week);
    params.set("metric", metric);
    fetch(`/api/rankings?${params.toString()}`)
      .then(async (r) => {
        const d = await r.json().catch(() => ({}));
        if (!r.ok || d?.error) throw new Error(d?.error || ("Sunucu hatası " + r.status));
        return d;
      })
      .then((d) => { setData(d); setWeeks(d?.weeks ?? []); setErr(null); })
      .catch((e) => { setErr(e.message); setData(null); }) // hatada veriyi sıfırla; render güvenli default'lara düşer
      .finally(() => setLoading(false));
  }, [week, metric]);

  const tabs: { id: Tab; label: string }[] = [
    { id: "top", label: "🏆 En Çok Satan" },
    { id: "risers", label: "📈 Yükselenler" },
    { id: "fallers", label: "📉 Düşenler" },
    { id: "categories", label: "🗂 Kategoriler" },
  ];

  function exportCurrent() {
    if (!data) return;
    if (tab === "categories") {
      downloadCsv(`cortex-kategori-${catDim}`, data?.categories?.[catDim] ?? [], [
        { key: "key", label: catDim === "team" ? "Takım" : catDim === "brand" ? "Marka" : "Tip" },
        { key: "sales_qty", label: "Satış" }, { key: "sales_value", label: "TL" }, { key: "sku_count", label: "SKU" },
      ]);
    } else {
      downloadCsv(`cortex-${tab}`, data?.[tab] ?? [], [
        { key: "sku_name", label: "Ürün" }, { key: "retailer", label: "Perakendeci" },
        { key: "sales_qty", label: "Satış" }, { key: "prev_qty", label: "Önceki" },
        { key: "growth", label: "Büyüme %" }, { key: "sales_value", label: "TL" },
      ]);
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex items-end justify-between flex-wrap gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Global <span className="neon-text">Sıralamalar</span></h1>
          <p className="text-txt-dim mono text-sm mt-1">
            Tüm perakendeciler · cross-retailer{data?.week ? ` · hafta ${fmtDate(data.week)}` : ""}
          </p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <div className="flex gap-1 mono text-xs">
            <button onClick={() => setMetric("value")}
              className={`px-3 py-1.5 rounded ${metric === "value" ? "bg-neon/15 text-neon" : "text-txt-dim"}`}>Büyüme: Ciro</button>
            <button onClick={() => setMetric("qty")}
              className={`px-3 py-1.5 rounded ${metric === "qty" ? "bg-neon/15 text-neon" : "text-txt-dim"}`}>Adet</button>
          </div>
          <select
            value={week || data?.week || ""}
            onChange={(e) => setWeek(e.target.value)}
            className="card mono text-sm px-4 py-2 bg-ink-2 outline-none focus:border-neon"
          >
            {weeks.map((w) => (
              <option key={w} value={w} className="bg-ink-2">{fmtDate(w)}</option>
            ))}
          </select>
          <button onClick={exportCurrent}
            className="mono text-xs px-4 py-2 rounded-lg border border-line text-txt-dim hover:border-neon hover:text-neon transition-colors">
            ⬇ CSV indir
          </button>
        </div>
      </div>

      <div className="flex gap-1 flex-wrap">
        {tabs.map((t) => (
          <button key={t.id} onClick={() => setTab(t.id)}
            className={`mono text-sm px-4 py-2 rounded-lg transition-colors ${tab === t.id ? "bg-neon/15 text-neon" : "text-txt-dim hover:text-txt"}`}>
            {t.label}
          </button>
        ))}
      </div>

      {err && (
        <div className="card p-4 border-red-500/40 text-red-400 mono text-sm">Veri alınamadı: {err}</div>
      )}

      {loading ? (
        <div className="card p-10 text-center mono text-txt-dim animate-pulse">Yükleniyor…</div>
      ) : err ? null : !data ? null : tab === "categories" ? (
        <div className="card p-6">
          <div className="flex gap-1 mb-4">
            {(["team", "brand", "type"] as const).map((d) => (
              <button key={d} onClick={() => setCatDim(d)}
                className={`mono text-xs px-3 py-1.5 rounded ${catDim === d ? "bg-neon/15 text-neon" : "text-txt-dim"}`}>
                {d === "team" ? "Takım" : d === "brand" ? "Marka" : "Ürün Tipi"}
              </button>
            ))}
          </div>
          <CategoryBars items={data?.categories?.[catDim] ?? []} />
        </div>
      ) : (
        <div className="card p-6 overflow-x-auto">
          <table>
            <thead>
              <tr>
                <th>#</th><th>Ürün</th><th>Perakendeci</th><th>Satış</th>
                {tab !== "top" && <><th>Önceki</th><th>Büyüme</th></>}
                <th>TL</th>
              </tr>
            </thead>
            <tbody>
              {(data?.[tab] ?? []).map((r: any, i: number) => (
                <motion.tr key={i} initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: i * 0.02 }}>
                  <td className="mono text-txt-dim">{i + 1}</td>
                  <td className="max-w-xs truncate" title={r.sku_name}>{r.sku_name}</td>
                  <td><span className="mono text-xs px-2 py-0.5 rounded" style={{ color: COLORS[r.retailer], border: `1px solid ${COLORS[r.retailer]}40` }}>{r.retailer}</span></td>
                  <td className="mono">{fmtInt(r.sales_qty)}</td>
                  {tab !== "top" && <>
                    <td className="mono text-txt-dim">{fmtInt(r.prev_qty)}</td>
                    <td className={`mono ${(r.growth ?? 0) >= 0 ? "text-neon" : "text-red-400"}`}>{fmtPct(r.growth)}</td>
                  </>}
                  <td className="mono">{r.sales_value > 0 ? fmtMoney(r.sales_value) : "—"}</td>
                </motion.tr>
              ))}
            </tbody>
          </table>
          {(data?.[tab] ?? []).length === 0 && (
            <div className="mono text-sm text-txt-dim text-center py-6">
              {tab === "top" ? "Veri yok" : "Karşılaştırma için en az 2 hafta gerekli"}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function CategoryBars({ items }: { items: { key: string; sales_qty: number; sales_value: number; sku_count: number }[] }) {
  if (!items?.length) return <div className="mono text-sm text-txt-dim">Veri yok</div>;
  const max = Math.max(...items.map((i) => i.sales_qty), 1);
  return (
    <div className="space-y-2">
      {items.map((it, i) => (
        <motion.div key={it.key} initial={{ opacity: 0, x: -8 }} animate={{ opacity: 1, x: 0 }} transition={{ delay: i * 0.03 }}>
          <div className="flex justify-between text-sm mb-1">
            <span className="font-medium">{it.key}</span>
            <span className="mono text-txt-dim">{fmtInt(it.sales_qty)} adet · {it.sku_count} SKU{it.sales_value > 0 ? ` · ${fmtMoney(it.sales_value)}` : ""}</span>
          </div>
          <div className="h-2.5 rounded-full bg-ink-3 overflow-hidden">
            <motion.div className="h-full rounded-full bg-neon"
              initial={{ width: 0 }} animate={{ width: `${(it.sales_qty / max) * 100}%` }}
              transition={{ delay: i * 0.03 + 0.1, duration: 0.5 }} />
          </div>
        </motion.div>
      ))}
    </div>
  );
}
