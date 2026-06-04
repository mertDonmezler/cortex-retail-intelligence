"use client";

import { Fragment, useEffect, useState } from "react";
import { motion } from "framer-motion";
import { RETAILERS, fmtInt, fmtMoney, fmtDate } from "@/lib/format";
import { downloadCsv } from "@/lib/csv";
import { fetchJson } from "@/lib/fetchJson";

// Mağaza-bazlı veri sağlayan perakendeciler (DR eski format, Toyzz mağaza-bazlıysa)
export default function StoresPage() {
  const [retailer, setRetailer] = useState("DR");
  const [week, setWeek] = useState<string>("");
  const [weeks, setWeeks] = useState<string[]>([]);
  const [stores, setStores] = useState<any[]>([]);
  const [storeLevel, setStoreLevel] = useState(true);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string>("");
  const [search, setSearch] = useState("");
  const [openStore, setOpenStore] = useState<string | null>(null);
  const [detail, setDetail] = useState<Record<string, any[]>>({});
  const [detLoading, setDetLoading] = useState<string | null>(null);

  async function openStoreDetail(store: string) {
    if (openStore === store) { setOpenStore(null); return; }
    setOpenStore(store);
    if (detail[store] || !week) return;
    setDetLoading(store);
    try {
      const r = await fetch(`/api/store-detail?retailer=${encodeURIComponent(retailer)}&week=${encodeURIComponent(week)}&store=${encodeURIComponent(store)}`);
      const d = await r.json().catch(() => ({}));
      setDetail((p) => ({ ...p, [store]: d.skus ?? [] }));
    } catch { setDetail((p) => ({ ...p, [store]: [] })); }
    finally { setDetLoading(null); }
  }

  useEffect(() => {
    setLoading(true);
    setErr("");
    setOpenStore(null);
    setDetail({});
    const q = week ? `&week=${week}` : "";
    fetchJson(`/api/stores?retailer=${encodeURIComponent(retailer)}${q}`)
      .then((d) => {
        setStores(d.stores ?? []);
        setWeeks(d.weeks ?? []);
        setStoreLevel(d.storeLevel ?? true);
        if (d.week && !week) setWeek(d.week);
      })
      .catch((e) => {
        // Hata durumunda state'leri güvenli boş default'a çek; storeLevel'i true tut
        // ki render "mağaza-bazlı veri yok" yerine gerçek hatayı göstersin.
        setErr(e.message);
        setStores([]);
        setWeeks([]);
        setStoreLevel(true);
      })
      .finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [retailer, week]);

  useEffect(() => { setWeek(""); }, [retailer]);

  const rows = stores ?? [];
  const filtered = rows.filter((s) => String(s?.store ?? "").toLowerCase().includes(search.toLowerCase()));
  const totalQty = rows.reduce((a, s) => a + (s?.sales_qty ?? 0), 0);
  const totalVal = rows.reduce((a, s) => a + (s?.sales_value ?? 0), 0);
  const maxQty = Math.max(...rows.map((s) => s?.sales_qty ?? 0), 1);

  return (
    <div className="space-y-6">
      <div className="flex items-end justify-between flex-wrap gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Mağaza <span className="neon-text">Zekası</span></h1>
          <p className="text-txt-dim mono text-sm mt-1">Şube bazlı satış & stok performansı</p>
        </div>
        <button onClick={() => downloadCsv(`cortex-magaza-${retailer}-${week}`, stores, [
          { key: "store", label: "Mağaza" }, { key: "sales_qty", label: "Satış" },
          { key: "sales_value", label: "TL" }, { key: "stock_qty", label: "Stok" }, { key: "sku_count", label: "SKU" },
        ])}
          disabled={!stores.length}
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
        {weeks.length > 0 && (
          <div>
            <label className="mono text-xs text-txt-dim block mb-1">Hafta</label>
            <select value={week} onChange={(e) => setWeek(e.target.value)}
              className="card mono text-sm px-3 py-2 bg-ink-2 outline-none focus:border-neon">
              {weeks.map((w) => <option key={w} value={w} className="bg-ink-2">{fmtDate(w)}</option>)}
            </select>
          </div>
        )}
        <div className="flex-1 min-w-48">
          <label className="mono text-xs text-txt-dim block mb-1">Mağaza ara</label>
          <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="🔍 şube adı…"
            className="card mono text-sm px-3 py-2 bg-ink-2 outline-none focus:border-neon w-full" />
        </div>
      </div>

      {loading ? (
        <div className="card p-10 text-center mono text-txt-dim animate-pulse">Yükleniyor…</div>
      ) : err ? (
        <div className="card p-4 border-red-500/40 text-red-400 mono text-sm">Veri alınamadı: {err}</div>
      ) : !storeLevel ? (
        <div className="card p-10 text-center">
          <div className="font-semibold">{retailer} mağaza-bazlı veri göndermiyor</div>
          <p className="text-txt-dim text-sm mt-2 mono">
            Bu perakendeci agrega (mağaza kırılımı olmayan) veri sağlıyor.
            Mağaza zekası için DR'nin mağaza-bazlı haftalarını kullan.
          </p>
        </div>
      ) : rows.length === 0 ? (
        <div className="card p-10 text-center">
          <div className="font-semibold">Mağaza verisi bulunamadı</div>
          <p className="text-txt-dim text-sm mt-2 mono">
            Seçilen perakendeci ve hafta için mağaza kaydı yok.
          </p>
        </div>
      ) : (
        <>
          <div className="grid grid-cols-3 gap-3">
            <div className="card p-4"><div className="mono text-[10px] text-txt-dim">MAĞAZA</div><div className="text-2xl font-bold mono neon-text">{rows.length}</div></div>
            <div className="card p-4"><div className="mono text-[10px] text-txt-dim">TOPLAM SATIŞ</div><div className="text-2xl font-bold mono">{fmtInt(totalQty)}</div></div>
            <div className="card p-4"><div className="mono text-[10px] text-txt-dim">TOPLAM TL</div><div className="text-2xl font-bold mono">{totalVal > 0 ? fmtMoney(totalVal) : "—"}</div></div>
          </div>

          <div className="card p-6 overflow-x-auto">
            <table>
              <thead><tr><th>#</th><th>Mağaza</th><th>Satış</th><th>Pay</th><th>TL</th><th>Stok</th><th>SKU</th></tr></thead>
              <tbody>
                {filtered.map((s, i) => {
                  const store = s?.store ?? "—";
                  const isOpen = openStore === store;
                  const skus = detail[store];
                  return (
                    <Fragment key={store + i}>
                      <tr onClick={() => openStoreDetail(store)} className="cursor-pointer hover:bg-neon/5">
                        <td className="mono text-txt-dim">{i + 1}</td>
                        <td className="font-medium">{isOpen ? "▼ " : "▶ "}{store}</td>
                        <td className="mono">{fmtInt(s?.sales_qty ?? 0)}</td>
                        <td className="w-32">
                          <div className="h-1.5 rounded-full bg-ink-3 overflow-hidden">
                            <div className="h-full bg-neon rounded-full" style={{ width: `${((s?.sales_qty ?? 0) / maxQty) * 100}%` }} />
                          </div>
                        </td>
                        <td className="mono">{(s?.sales_value ?? 0) > 0 ? fmtMoney(s.sales_value) : "—"}</td>
                        <td className="mono">{fmtInt(s?.stock_qty ?? 0)}</td>
                        <td className="mono text-txt-dim">{s?.sku_count ?? 0}</td>
                      </tr>
                      {isOpen && (
                        <tr>
                          <td colSpan={7} className="bg-ink-2/40">
                            {detLoading === store ? (
                              <div className="mono text-xs text-txt-dim p-3 animate-pulse">Yükleniyor…</div>
                            ) : !skus || skus.length === 0 ? (
                              <div className="mono text-xs text-txt-dim p-3">Bu mağaza için satış kaydı yok.</div>
                            ) : (
                              <div className="p-3">
                                <div className="mono text-[10px] text-txt-dim mb-2">{store} — satılan ürünler ({skus.length})</div>
                                <table>
                                  <thead><tr><th>Ürün</th><th className="text-right">Satış</th><th className="text-right">Stok</th><th className="text-right">Ciro (net)</th></tr></thead>
                                  <tbody>
                                    {skus.slice(0, 50).map((k: any, j: number) => (
                                      <tr key={j}>
                                        <td className="max-w-[360px] truncate" title={k.sku_name}>{k.sku_name}</td>
                                        <td className="mono text-right">{fmtInt(k.sales_qty)}</td>
                                        <td className="mono text-right text-txt-dim">{fmtInt(k.stock_qty)}</td>
                                        <td className="mono text-right text-txt-dim">{k.sales_value > 0 ? fmtMoney(k.sales_value) : "—"}</td>
                                      </tr>
                                    ))}
                                  </tbody>
                                </table>
                                {skus.length > 50 && <div className="mono text-[10px] text-txt-dim mt-2">… ilk 50 gösteriliyor</div>}
                              </div>
                            )}
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
            <div className="mono text-xs text-txt-dim mt-3">{filtered.length} / {rows.length} mağaza</div>
          </div>
        </>
      )}
    </div>
  );
}
