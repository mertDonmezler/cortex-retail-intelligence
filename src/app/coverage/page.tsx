"use client";

import { useEffect, useState } from "react";
import { motion } from "framer-motion";
import { RETAILERS, fmtInt } from "@/lib/format";
import { downloadCsv } from "@/lib/csv";
import { fetchJson } from "@/lib/fetchJson";

type Status = "kritik" | "fazla" | "saglikli";
interface Sku {
  sku_name: string; avg_weekly: number; last_stock: number;
  coverage: number | null; status: Status;
}

const STATUS_META: Record<Status, { label: string; color: string; cls: string }> = {
  kritik: { label: "Az stok (<8 hf)", color: "#ff5555", cls: "text-red-400" },
  fazla: { label: "Fazla / kampanya (>30 hf)", color: "#f8b00b", cls: "text-[#f8b00b]" },
  saglikli: { label: "Sağlıklı (8–30 hf)", color: "#1FF80B", cls: "text-neon" },
};

const fmtCov = (c: number | null) => (c == null ? "satmıyor" : c.toFixed(1) + " hf");
const fmtAvg = (n: number) => (Math.round(n * 10) / 10).toLocaleString("tr-TR");

export default function CoveragePage() {
  const [retailer, setRetailer] = useState<string>(RETAILERS[3]); // Toyzz varsayılan
  const [store, setStore] = useState<string>(""); // "" = firma geneli
  const [stores, setStores] = useState<string[]>([]);
  const [data, setData] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [filter, setFilter] = useState<"all" | Status>("all");

  // Mağaza listesi (store-level perakendeciler için)
  useEffect(() => {
    setStore("");
    fetch(`/api/stores?retailer=${encodeURIComponent(retailer)}`)
      .then((r) => r.json()).then((d) => {
        setStores(d?.storeLevel && Array.isArray(d?.stores) ? d.stores.map((s: any) => s.store) : []);
      }).catch(() => setStores([]));
  }, [retailer]);

  // Coverage verisi
  useEffect(() => {
    setLoading(true);
    const url = `/api/coverage?retailer=${encodeURIComponent(retailer)}${store ? `&store=${encodeURIComponent(store)}` : ""}`;
    fetchJson(url)
      .then((d) => { setData(d); setErr(null); })
      .catch((e) => { setErr(e.message); setData(null); })
      .finally(() => setLoading(false));
  }, [retailer, store]);

  const skus: Sku[] = data?.skus ?? [];
  const shown = filter === "all" ? skus : skus.filter((s) => s.status === filter);

  function exportCsv() {
    downloadCsv(
      `cortex-coverage-${retailer}${store ? "-" + store : ""}`,
      shown.map((s) => ({
        sku: s.sku_name, ort_haftalik_satis: Math.round(s.avg_weekly * 10) / 10,
        stok: s.last_stock, coverage_hafta: s.coverage == null ? "" : Math.round(s.coverage * 10) / 10,
        durum: STATUS_META[s.status].label,
      })),
      [
        { key: "sku", label: "Ürün" }, { key: "ort_haftalik_satis", label: "Haftalık Ort. Satış" },
        { key: "stok", label: "Stok" }, { key: "coverage_hafta", label: "Coverage (hafta)" },
        { key: "durum", label: "Durum" },
      ]
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-end justify-between flex-wrap gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Stok <span className="neon-text">Süresi</span> (Coverage)</h1>
          <p className="text-txt-dim mono text-sm mt-1">
            Stok ÷ ortalama haftalık satış · &lt;8 hafta sipariş, &gt;30 hafta kampanya
            {store ? ` · mağaza: ${store}` : " · firma geneli"}
          </p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <select value={retailer} onChange={(e) => setRetailer(e.target.value)}
            className="card mono text-sm px-4 py-2 bg-ink-2 outline-none focus:border-neon">
            {RETAILERS.map((r) => <option key={r} value={r} className="bg-ink-2">{r}</option>)}
          </select>
          {stores.length > 0 && (
            <select value={store} onChange={(e) => setStore(e.target.value)}
              className="card mono text-sm px-4 py-2 bg-ink-2 outline-none focus:border-neon max-w-[220px]">
              <option value="" className="bg-ink-2">Tüm firma (geneli)</option>
              {stores.map((s) => <option key={s} value={s} className="bg-ink-2">{s}</option>)}
            </select>
          )}
          <button onClick={exportCsv}
            className="mono text-xs px-4 py-2 rounded-lg border border-line text-txt-dim hover:border-neon hover:text-neon transition-colors">
            ⬇ CSV
          </button>
        </div>
      </div>

      {err && <div className="card p-4 border-red-500/40 text-red-400 mono text-sm">Veri alınamadı: {err}</div>}

      {/* Özet kartları (tıkla → filtrele) */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <SummaryCard label="TÜM SKU" value={data?.summary?.toplam ?? 0} active={filter === "all"} onClick={() => setFilter("all")} color="#7d927d" />
        <SummaryCard label="AZ STOK · SİPARİŞ" value={data?.summary?.kritik ?? 0} active={filter === "kritik"} onClick={() => setFilter("kritik")} color="#ff5555" />
        <SummaryCard label="SAĞLIKLI" value={data?.summary?.saglikli ?? 0} active={filter === "saglikli"} onClick={() => setFilter("saglikli")} color="#1FF80B" />
        <SummaryCard label="FAZLA · KAMPANYA" value={data?.summary?.fazla ?? 0} active={filter === "fazla"} onClick={() => setFilter("fazla")} color="#f8b00b" />
      </div>

      <div className="card p-6 overflow-x-auto">
        {loading && !data ? (
          <div className="text-center mono text-txt-dim animate-pulse py-6">Yükleniyor…</div>
        ) : shown.length === 0 ? (
          <div className="text-center mono text-sm text-txt-dim py-6">
            {skus.length === 0 ? "Bu seçim için veri yok." : "Bu filtrede SKU yok."}
          </div>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Ürün</th><th>Haftalık Ort. Satış</th><th>Stok</th><th>Coverage</th><th>Durum</th>
              </tr>
            </thead>
            <tbody>
              {shown.slice(0, 500).map((s, i) => {
                const m = STATUS_META[s.status];
                return (
                  <motion.tr key={s.sku_name + i} initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: Math.min(i * 0.01, 0.3) }}>
                    <td className="max-w-md truncate" title={s.sku_name}>{s.sku_name}</td>
                    <td className="mono">{fmtAvg(s.avg_weekly)}</td>
                    <td className="mono">{fmtInt(s.last_stock)}</td>
                    <td className="mono font-bold" style={{ color: m.color }}>{fmtCov(s.coverage)}</td>
                    <td>
                      <span className="mono text-xs px-2 py-0.5 rounded whitespace-nowrap"
                        style={{ color: m.color, border: `1px solid ${m.color}40` }}>{m.label}</span>
                    </td>
                  </motion.tr>
                );
              })}
            </tbody>
          </table>
        )}
        {shown.length > 500 && (
          <div className="mono text-[11px] text-txt-dim mt-3">İlk 500 gösteriliyor ({shown.length} toplam). Tümü için CSV indir.</div>
        )}
      </div>
    </div>
  );
}

function SummaryCard({ label, value, active, onClick, color }: {
  label: string; value: number; active: boolean; onClick: () => void; color: string;
}) {
  return (
    <button onClick={onClick}
      className={`card p-4 text-left transition-colors ${active ? "border-neon" : "hover:border-line"}`}
      style={active ? { borderColor: color } : undefined}>
      <div className="mono text-[10px] text-txt-dim tracking-wider">{label}</div>
      <div className="text-2xl font-bold mono mt-1" style={{ color }}>{value.toLocaleString("tr-TR")}</div>
    </button>
  );
}
