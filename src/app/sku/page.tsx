"use client";

import { useEffect, useMemo, useState } from "react";
import { RETAILERS, fmtInt, fmtMoney, fmtDate } from "@/lib/format";
import { downloadCsv } from "@/lib/csv";

export default function SkuPage() {
  const [retailer, setRetailer] = useState(RETAILERS[0]);
  const [week, setWeek] = useState<string>("");
  const [weeks, setWeeks] = useState<string[]>([]);
  const [skus, setSkus] = useState<any[]>([]);
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState("");

  useEffect(() => {
    setLoading(true);
    setErr("");
    const q = week ? `&week=${week}` : "";
    fetch(`/api/sku-detail?retailer=${encodeURIComponent(retailer)}${q}`)
      .then(async (r) => {
        const d = await r.json().catch(() => ({}));
        if (!r.ok || d?.error) throw new Error(d?.error || ("Sunucu hatası " + r.status));
        return d;
      })
      .then((d) => {
        setSkus(d?.skus ?? []);
        setWeeks(d?.weeks ?? []);
        if (d?.week && !week) setWeek(d.week);
      })
      .catch((e) => {
        // hata: state'leri güvenli boş default'a çek ki render çökmesin
        setErr(e.message);
        setSkus([]);
      })
      .finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [retailer, week]);

  // perakendeci değişince haftayı sıfırla
  useEffect(() => { setWeek(""); }, [retailer]);

  const filtered = useMemo(
    () => (skus ?? []).filter((s) => (s?.sku_name ?? "").toLowerCase().includes(search.toLowerCase())),
    [skus, search]
  );

  return (
    <div className="space-y-6">
      <div className="flex items-end justify-between flex-wrap gap-4">
        <h1 className="text-3xl font-bold tracking-tight">
          SKU <span className="neon-text">Detay</span>
        </h1>
        <button onClick={() => downloadCsv(`cortex-sku-${retailer}-${week}`, filtered, [
          { key: "sku_name", label: "Ürün" }, { key: "sales_qty", label: "Satış" },
          { key: "sales_value", label: "TL" }, { key: "stock_qty", label: "Stok" }, { key: "avg_price", label: "Ort.Fiyat" },
        ])} disabled={!filtered.length}
          className="mono text-xs px-4 py-2 rounded-lg border border-line text-txt-dim hover:border-neon hover:text-neon transition-colors disabled:opacity-40">
          ⬇ CSV indir
        </button>
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
          <label className="mono text-xs text-txt-dim block mb-1">Hafta</label>
          <select value={week} onChange={(e) => setWeek(e.target.value)}
            className="card mono text-sm px-3 py-2 bg-ink-2 outline-none focus:border-neon">
            {weeks.map((w) => <option key={w} value={w} className="bg-ink-2">{fmtDate(w)}</option>)}
          </select>
        </div>
        <div className="flex-1 min-w-48">
          <label className="mono text-xs text-txt-dim block mb-1">Ürün ara</label>
          <input value={search} onChange={(e) => setSearch(e.target.value)}
            placeholder="🔍 ürün adı…"
            className="card mono text-sm px-3 py-2 bg-ink-2 outline-none focus:border-neon w-full" />
        </div>
      </div>

      {err && (
        <div className="card p-4 border-red-500/40 text-red-400 mono text-sm">
          Veri alınamadı: {err}
        </div>
      )}

      <div className="card p-6">
        {loading ? (
          <div className="mono text-txt-dim animate-pulse py-6 text-center">Yükleniyor…</div>
        ) : err ? (
          <div className="mono text-txt-dim py-6 text-center">Sunucu hatası nedeniyle veri gösterilemiyor.</div>
        ) : filtered.length === 0 ? (
          <div className="mono text-txt-dim py-6 text-center">Kayıt bulunamadı.</div>
        ) : (
          <>
            <table>
              <thead>
                <tr><th>Ürün</th><th>Satış</th><th>TL</th><th>Stok</th><th>Ort. Fiyat</th></tr>
              </thead>
              <tbody>
                {filtered.map((s, i) => (
                  <tr key={i}>
                    <td>{s?.sku_name ?? "—"}</td>
                    <td className="mono">{fmtInt(s?.sales_qty ?? 0)}</td>
                    <td className="mono">{(s?.sales_value ?? 0) > 0 ? fmtMoney(s.sales_value) : "—"}</td>
                    <td className="mono">{fmtInt(s?.stock_qty ?? 0)}</td>
                    <td className="mono">{s?.avg_price ? fmtMoney(s.avg_price) : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="mono text-xs text-txt-dim mt-3">{filtered.length} SKU</div>
          </>
        )}
      </div>
    </div>
  );
}
