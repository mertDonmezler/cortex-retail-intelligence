"use client";

import { useEffect, useState } from "react";
import { RETAILERS, fmtInt, fmtMoney, fmtDate } from "@/lib/format";

export default function StockAlertsPage() {
  const [retailer, setRetailer] = useState(RETAILERS[0]);
  const [critical, setCritical] = useState(10);
  const [drop, setDrop] = useState(30);
  const [data, setData] = useState<any>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    setLoading(true);
    setErr(null);
    fetch(`/api/stock-alerts?retailer=${encodeURIComponent(retailer)}&critical=${critical}&drop=${drop}`)
      .then(async (r) => {
        const d = await r.json().catch(() => ({}));
        if (!r.ok || d?.error) throw new Error(d?.error || ("Sunucu hatası " + r.status));
        return d;
      })
      .then((d) => setData(d))
      .catch((e) => {
        setErr(e.message);
        // Render'ın çökmemesi için state'i güvenli boş default'a çek
        setData(null);
      })
      .finally(() => setLoading(false));
  }, [retailer, critical, drop]);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">
          Stok <span className="neon-text">Alarm</span>
        </h1>
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
          <label className="mono text-xs text-txt-dim block mb-1">Kritik eşik (≤)</label>
          <input type="number" value={critical} onChange={(e) => setCritical(+e.target.value)}
            className="card mono text-sm px-3 py-2 bg-ink-2 outline-none focus:border-neon w-24" />
        </div>
        <div>
          <label className="mono text-xs text-txt-dim block mb-1">Hızlı düşüş (%)</label>
          <input type="number" value={drop} onChange={(e) => setDrop(+e.target.value)}
            className="card mono text-sm px-3 py-2 bg-ink-2 outline-none focus:border-neon w-24" />
        </div>
        {data?.latest && (
          <div className="mono text-xs text-txt-dim ml-auto">
            son hafta: <span className="text-txt">{fmtDate(data.latest)}</span>
          </div>
        )}
      </div>

      {err && <div className="card p-4 border-red-500/40 text-red-400 mono text-sm">Veri alınamadı: {err}</div>}

      {loading ? (
        <div className="mono text-txt-dim animate-pulse py-10 text-center">Yükleniyor…</div>
      ) : err ? null : !data ? null : (
        <>
          <div className="card p-6">
            <h2 className="font-bold mb-3">☠ Kritik Stok (≤ {critical})</h2>
            {(data?.critical ?? []).length ? (
              <table>
                <thead><tr><th>Ürün</th><th>Stok</th><th>Bu Hafta Satış</th></tr></thead>
                <tbody>
                  {(data?.critical ?? []).map((r: any, i: number) => (
                    <tr key={i}>
                      <td>{r?.sku_name}</td>
                      <td className="mono">{fmtInt(r?.stock_qty)}</td>
                      <td className="mono">{fmtInt(r?.sales_qty)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : <div className="mono text-sm text-neon">✓ Kritik stok yok</div>}
          </div>

          <div className="card p-6">
            <h2 className="font-bold mb-3">🔻 Hızlı Düşüş (≥ %{drop})</h2>
            {!data?.hasPrev ? (
              <div className="mono text-sm text-txt-dim">
                Geçen hafta verisi yok — düşüş analizi için en az 2 hafta gerekli.
              </div>
            ) : (data?.declining ?? []).length ? (
              <table>
                <thead><tr><th>Ürün</th><th>Önceki</th><th>Şimdi</th><th>Düşüş</th><th>Satış</th></tr></thead>
                <tbody>
                  {(data?.declining ?? []).map((r: any, i: number) => (
                    <tr key={i}>
                      <td>{r?.sku_name}</td>
                      <td className="mono">{fmtInt(r?.prev)}</td>
                      <td className="mono">{fmtInt(r?.now)}</td>
                      <td className="mono text-red-400">{r?.pct}%</td>
                      <td className="mono">{fmtInt(r?.sales_qty)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : <div className="mono text-sm text-neon">✓ Eşik üstü düşüş yok</div>}
          </div>
        </>
      )}
    </div>
  );
}
