"use client";

import { useEffect, useMemo, useState } from "react";
import { RETAILERS, fmtInt, fmtMoney, fmtDate } from "@/lib/format";
import { downloadCsv } from "@/lib/csv";
import { fetchJson } from "@/lib/fetchJson";

const STATUS: Record<string, { label: string; cls: string }> = {
  "tükendi": { label: "Tükendi", cls: "text-red-300 bg-red-500/15 border-red-500/40" },
  "acil": { label: "Acil", cls: "text-orange-300 bg-orange-500/15 border-orange-500/40" },
  "izle": { label: "İzle", cls: "text-yellow-300 bg-yellow-500/10 border-yellow-500/30" },
  "yeterli": { label: "Yeterli", cls: "text-txt-dim bg-white/5 border-line" },
};

export default function StockPage() {
  const [retailer, setRetailer] = useState(RETAILERS[0]);
  const [minSales, setMinSales] = useState(10);
  const [sort, setSort] = useState<"aciliyet" | "stok" | "satis">("aciliyet");
  const [data, setData] = useState<any>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    setLoading(true);
    setErr(null);
    fetchJson(`/api/stock-alerts?retailer=${encodeURIComponent(retailer)}&minSales=${minSales}`)
      .then(setData)
      .catch((e) => { setErr(e.message); setData(null); })
      .finally(() => setLoading(false));
  }, [retailer, minSales]);

  const items = useMemo(() => {
    const arr = [...(data?.items ?? [])];
    if (sort === "stok") arr.sort((a, b) => a.stock_qty - b.stock_qty || b.avg_sales - a.avg_sales);
    else if (sort === "satis") arr.sort((a, b) => b.avg_sales - a.avg_sales);
    // "aciliyet" → API zaten kapsam (stok/ort. satış) artan sıralı gönderiyor
    return arr;
  }, [data, sort]);

  const counts = data?.counts ?? { tukendi: 0, acil: 0, izle: 0 };
  const weeksUsed = data?.weeksUsed ?? 4;

  function exportCsv() {
    if (!items.length) return;
    downloadCsv(
      `siparis-onceligi-${retailer}-${data?.latest ?? ""}`,
      items.map((r: any) => ({
        urun: r.sku_name, barkod: r.barkod ?? "", ort: r.avg_sales, son: r.last_sales, stok: r.stock_qty,
        kapsam: r.cover ?? "", ciro: Math.round(r.sales_value), durum: STATUS[r.status]?.label ?? r.status,
      })),
      [
        { key: "urun", label: "Ürün" }, { key: "barkod", label: "Barkod" },
        { key: "ort", label: `Haftalık Ort (${weeksUsed}hf)` }, { key: "son", label: "Son Hafta" },
        { key: "stok", label: "Stok" }, { key: "kapsam", label: "Kaç Hafta Yeter" },
        { key: "ciro", label: "Ciro (TL)" }, { key: "durum", label: "Durum" },
      ]
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">
          Sipariş <span className="neon-text">Önceliği</span>
        </h1>
        <p className="text-txt-dim text-sm mt-1">
          Son <span className="text-txt mono">{weeksUsed}</span> haftanın <span className="text-txt">haftalık ortalama</span> satışı
          {" "}<span className="text-txt mono">≥ {minSales}</span> olan ürünler, mevcut stoğun kaç hafta yeteceğine göre — en acil üstte.
          Düşük-stok listesi değil; <span className="text-txt">satıp tükenen</span> ürünler.
        </p>
      </div>

      {/* Kontroller */}
      <div className="card p-4 flex flex-wrap items-end gap-4">
        <div>
          <label className="mono text-xs text-txt-dim block mb-1">Perakendeci</label>
          <select value={retailer} onChange={(e) => setRetailer(e.target.value)}
            className="card mono text-sm px-3 py-2 bg-ink-2 outline-none focus:border-neon">
            {RETAILERS.map((r) => <option key={r} className="bg-ink-2">{r}</option>)}
          </select>
        </div>
        <div>
          <label className="mono text-xs text-txt-dim block mb-1">Min. haftalık ort. satış (≥)</label>
          <input type="number" min={1} value={minSales} onChange={(e) => setMinSales(Math.max(1, +e.target.value))}
            className="card mono text-sm px-3 py-2 bg-ink-2 outline-none focus:border-neon w-24" />
        </div>
        <div>
          <label className="mono text-xs text-txt-dim block mb-1">Sırala</label>
          <div className="flex gap-1 mono text-xs">
            {([["aciliyet", "Aciliyet"], ["stok", "En az stok"], ["satis", "En çok satan"]] as const).map(([k, l]) => (
              <button key={k} onClick={() => setSort(k)}
                className={`px-3 py-2 rounded ${sort === k ? "bg-neon/15 text-neon" : "text-txt-dim hover:text-txt"}`}>{l}</button>
            ))}
          </div>
        </div>
        {data?.latest && (
          <div className="mono text-xs text-txt-dim ml-auto flex items-center gap-3">
            <span>son hafta: <span className="text-txt">{fmtDate(data.latest)}</span></span>
            <button onClick={exportCsv} disabled={!items.length}
              className="px-3 py-2 rounded border border-line hover:border-neon hover:text-neon disabled:opacity-40">CSV indir</button>
          </div>
        )}
      </div>

      {/* Özet rozetleri */}
      {data && (
        <div className="grid grid-cols-3 gap-3">
          <Chip n={counts.tukendi} label="Tükendi (satıyor, stok 0)" cls="border-red-500/40 text-red-300" />
          <Chip n={counts.acil} label="Acil (< 1 hafta yeter)" cls="border-orange-500/40 text-orange-300" />
          <Chip n={counts.izle} label="İzle (1–2 hafta)" cls="border-yellow-500/30 text-yellow-300" />
        </div>
      )}

      {err && <div className="card p-4 border-red-500/40 text-red-400 mono text-sm">Veri alınamadı: {err}</div>}

      {loading ? (
        <div className="mono text-txt-dim animate-pulse py-10 text-center">Yükleniyor…</div>
      ) : err || !data ? null : (
        <div className="card p-6">
          <div className="flex items-center justify-between mb-3">
            <h2 className="font-bold">Sipariş listesi</h2>
            <span className="mono text-xs text-txt-dim">{items.length} ürün</span>
          </div>
          {items.length ? (
            <div className="overflow-x-auto">
              <table>
                <thead>
                  <tr>
                    <th>#</th><th>Ürün</th>
                    <th className="text-right">Haftalık Ort.</th>
                    <th className="text-right">Son Hafta</th>
                    <th className="text-right">Stok</th>
                    <th className="text-right">Kaç Hafta Yeter</th>
                    <th className="text-right">Ciro (TL)</th>
                    <th>Durum</th>
                  </tr>
                </thead>
                <tbody>
                  {items.map((r: any, i: number) => {
                    const st = STATUS[r.status] ?? STATUS["yeterli"];
                    return (
                      <tr key={i}>
                        <td className="mono text-txt-dim">{i + 1}</td>
                        <td className="max-w-[340px] truncate" title={r.sku_name}>{r.sku_name}</td>
                        <td className="mono text-right">{fmtInt(r.avg_sales)}</td>
                        <td className="mono text-right text-txt-dim">{fmtInt(r.last_sales)}</td>
                        <td className="mono text-right">{fmtInt(r.stock_qty)}</td>
                        <td className="mono text-right">{r.cover == null ? "—" : `${r.cover} hf`}</td>
                        <td className="mono text-right text-txt-dim">{fmtMoney(r.sales_value)}</td>
                        <td>
                          <span className={`mono text-[10px] px-2 py-0.5 rounded border ${st.cls}`}>{st.label}</span>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="mono text-sm text-txt-dim">
              Bu eşikte (≥ {minSales}) ürün yok. Eşiği düşürmeyi dene.
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function Chip({ n, label, cls }: { n: number; label: string; cls: string }) {
  return (
    <div className={`card p-4 border ${cls}`}>
      <div className="text-2xl font-bold mono">{n}</div>
      <div className="text-xs text-txt-dim mt-1">{label}</div>
    </div>
  );
}
