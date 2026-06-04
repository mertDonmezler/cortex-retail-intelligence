"use client";

import { Fragment, useEffect, useMemo, useState } from "react";
import { motion } from "framer-motion";
import { RETAILERS, fmtInt, RETAILER_COLORS } from "@/lib/format";
import { downloadCsv } from "@/lib/csv";
import { fetchJson } from "@/lib/fetchJson";

const col = (r: string) => RETAILER_COLORS[r] ?? "#7d927d";
const fmtCov = (c: number | null, neverSold: boolean) =>
  neverSold ? "∞ satmıyor" : c == null ? "—" : c.toFixed(0) + " hf";
const fmtVel = (n: number) => (Math.round(n * 10) / 10).toLocaleString("tr-TR");
const covColor = (c: number | null, neverSold: boolean) =>
  neverSold ? "#ff5555" : c == null ? "#7d927d" : c > 120 ? "#ff5555" : c > 60 ? "#f8b00b" : "#1FF80B";

interface Firm { retailer: string; sku_name: string; stock: number; velocity: number; coverage: number | null; }
interface Product {
  product_key: string; barkod: string | null; name: string;
  total_stock: number; total_velocity: number; coverage: number | null;
  never_sold: boolean; max_firm_coverage: number | null; firms: Firm[];
}
type SortKey = "name" | "barkod" | "stock" | "velocity" | "coverage" | "firms";

function SortTh({ label, active, dir, align, onClick }: {
  label: string; active: boolean; dir: "asc" | "desc"; align?: string; onClick: () => void;
}) {
  return (
    <th className={`cursor-pointer select-none hover:text-neon transition-colors ${align ?? ""}`} onClick={onClick}>
      {label}
      <span className={`ml-1 ${active ? "text-neon" : "opacity-30"}`}>{active ? (dir === "asc" ? "▲" : "▼") : "↕"}</span>
    </th>
  );
}

export default function OluStokPage() {
  const [products, setProducts] = useState<Product[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  const [q, setQ] = useState("");
  const [retailer, setRetailer] = useState(""); // "" = ağ geneli (tüm firmalar birleşik)
  const [minWeeks, setMinWeeks] = useState(60);
  const [includeNeverSold, setIncludeNeverSold] = useState(true);
  const [open, setOpen] = useState<string | null>(null);
  const [sortKey, setSortKey] = useState<SortKey>("coverage");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");

  useEffect(() => {
    fetchJson("/api/dead-stock")
      .then((d) => { setProducts(d.products ?? []); setErr(null); })
      .catch((e) => { setErr(e.message); })
      .finally(() => setLoading(false));
  }, []);

  // Seçili firmaya / ağa göre her ürün için gösterilecek değerler + filtre.
  const shown = useMemo(() => {
    const term = q.trim().toLocaleLowerCase("tr-TR");
    const rows = products.map((p) => {
      let stock: number, velocity: number, coverage: number | null, neverSold: boolean, firmName: string;
      if (retailer) {
        const f = p.firms.find((x) => x.retailer === retailer);
        if (!f) return null;
        stock = f.stock; velocity = f.velocity; coverage = f.coverage;
        neverSold = f.coverage == null && f.stock > 0; firmName = f.sku_name;
      } else {
        stock = p.total_stock; velocity = p.total_velocity; coverage = p.coverage;
        neverSold = p.never_sold; firmName = p.name;
      }
      return { p, stock, velocity, coverage, neverSold, firmName };
    }).filter(Boolean) as { p: Product; stock: number; velocity: number; coverage: number | null; neverSold: boolean; firmName: string }[];

    return rows.filter((r) => {
      if (r.stock <= 0) return false;
      const passCov = r.neverSold ? includeNeverSold : (r.coverage != null && r.coverage >= minWeeks);
      if (!passCov) return false;
      if (term) {
        const hay = (r.p.name + " " + r.firmName + " " + (r.p.barkod ?? "")).toLocaleLowerCase("tr-TR");
        if (!hay.includes(term)) return false;
      }
      return true;
    }).sort((a, b) => {
      const dir = sortDir === "asc" ? 1 : -1;
      const cov = (x: typeof a) => (x.neverSold ? Infinity : x.coverage ?? -1);
      switch (sortKey) {
        case "name": return dir * a.p.name.localeCompare(b.p.name, "tr");
        case "barkod": return dir * (a.p.barkod ?? "").localeCompare(b.p.barkod ?? "");
        case "stock": return dir * (a.stock - b.stock);
        case "velocity": return dir * (a.velocity - b.velocity);
        case "firms": return dir * (a.p.firms.length - b.p.firms.length);
        case "coverage":
        default: {
          const av = cov(a), bv = cov(b);
          if (av === Infinity && bv === Infinity) return b.stock - a.stock; // ∞'lar stoğa göre
          if (av === Infinity) return dir;   // ∞ en büyük coverage
          if (bv === Infinity) return -dir;
          return dir * (av - bv);
        }
      }
    });
  }, [products, q, retailer, minWeeks, includeNeverSold, sortKey, sortDir]);

  const totalUnits = shown.reduce((a, r) => a + r.stock, 0);

  function exportCsv() {
    downloadCsv(
      `cortex-olu-stok${retailer ? "-" + retailer : ""}`,
      shown.map((r) => ({
        urun: r.p.name, barkod: r.p.barkod ?? "", kapsam: retailer || "ağ geneli",
        stok: Math.round(r.stock), hiz: Math.round(r.velocity * 10) / 10,
        coverage_hf: r.neverSold ? "∞" : r.coverage == null ? "" : Math.round(r.coverage),
        firma_sayisi: r.p.firms.length,
      })),
      [
        { key: "urun", label: "Ürün" }, { key: "barkod", label: "Barkod" }, { key: "kapsam", label: "Kapsam" },
        { key: "stok", label: "Stok" }, { key: "hiz", label: "Haftalık Hız" },
        { key: "coverage_hf", label: "Coverage (hf)" }, { key: "firma_sayisi", label: "Firma Sayısı" },
      ]
    );
  }

  function setSort(k: SortKey) {
    if (sortKey === k) setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    else { setSortKey(k); setSortDir(k === "name" || k === "barkod" ? "asc" : "desc"); }
  }

  return (
    <div className="space-y-6">
      <div className="flex items-end justify-between flex-wrap gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Ölü <span className="neon-text">Stok</span></h1>
          <p className="text-txt-dim mono text-sm mt-1">
            Stok ÷ haftalık satış hızı &gt; {minWeeks} hafta · {retailer || "tüm firmalar birleşik"} · hiç satmayan = ∞
          </p>
        </div>
        <button onClick={exportCsv}
          className="mono text-xs px-4 py-2 rounded-lg border border-line text-txt-dim hover:border-neon hover:text-neon transition-colors">
          ⬇ CSV
        </button>
      </div>

      {err && <div className="card p-4 border-red-500/40 text-red-400 mono text-sm">Veri alınamadı: {err}</div>}

      {/* Özet */}
      <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
        <div className="card p-5">
          <div className="mono text-[10px] text-txt-dim tracking-wider">ÖLÜ STOK ÜRÜNÜ</div>
          <div className="text-3xl font-bold mono mt-1 neon-text">{fmtInt(shown.length)}</div>
        </div>
        <div className="card p-5">
          <div className="mono text-[10px] text-txt-dim tracking-wider">TAKILI STOK</div>
          <div className="text-3xl font-bold mono mt-1" style={{ color: "#ff5555" }}>{fmtInt(totalUnits)} <span className="text-sm text-txt-dim">adet</span></div>
        </div>
        <div className="card p-5">
          <div className="mono text-[10px] text-txt-dim tracking-wider">EŞİK</div>
          <div className="text-xl font-bold mono mt-1">&gt; {minWeeks} hafta {includeNeverSold && <span className="text-txt-dim text-xs">+ hiç satmayan</span>}</div>
        </div>
      </div>

      {/* Filtreler */}
      <div className="card p-4 flex flex-wrap items-center gap-3">
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Ürün adı / barkod ara…"
          className="mono text-sm px-3 py-2 rounded-lg bg-ink-2 border border-line outline-none focus:border-neon flex-1 min-w-[200px]" />
        <select value={retailer} onChange={(e) => setRetailer(e.target.value)}
          className="mono text-sm px-3 py-2 rounded-lg bg-ink-2 border border-line outline-none focus:border-neon">
          <option value="" className="bg-ink-2">Tüm firmalar (ağ)</option>
          {RETAILERS.map((r) => <option key={r} value={r} className="bg-ink-2">{r}</option>)}
        </select>
        <label className="mono text-xs text-txt-dim flex items-center gap-2">
          min hafta
          <input type="number" min={0} step={10} value={minWeeks}
            onChange={(e) => setMinWeeks(Math.max(0, Number(e.target.value) || 0))}
            className="w-20 mono text-sm px-2 py-2 rounded-lg bg-ink-2 border border-line outline-none focus:border-neon" />
        </label>
        <label className="mono text-xs text-txt-dim flex items-center gap-2 cursor-pointer select-none">
          <input type="checkbox" checked={includeNeverSold} onChange={(e) => setIncludeNeverSold(e.target.checked)} className="accent-neon" />
          hiç satmayanları dahil et
        </label>
      </div>

      <div className="card p-6 overflow-x-auto">
        {loading ? (
          <div className="text-center mono text-txt-dim animate-pulse py-6">Yükleniyor…</div>
        ) : shown.length === 0 ? (
          <div className="text-center mono text-sm text-txt-dim py-6">Bu filtrede ölü stok yok.</div>
        ) : (
          <table>
            <thead>
              <tr>
                <SortTh label="Ürün" active={sortKey === "name"} dir={sortDir} onClick={() => setSort("name")} />
                <SortTh label="Barkod" active={sortKey === "barkod"} dir={sortDir} onClick={() => setSort("barkod")} />
                <SortTh label="Stok" align="text-right" active={sortKey === "stock"} dir={sortDir} onClick={() => setSort("stock")} />
                <SortTh label="Haftalık hız" align="text-right" active={sortKey === "velocity"} dir={sortDir} onClick={() => setSort("velocity")} />
                <SortTh label="Coverage" align="text-right" active={sortKey === "coverage"} dir={sortDir} onClick={() => setSort("coverage")} />
                <SortTh label="Firma" align="text-center" active={sortKey === "firms"} dir={sortDir} onClick={() => setSort("firms")} />
                <th></th>
              </tr>
            </thead>
            <tbody>
              {shown.slice(0, 600).map((r, i) => {
                const isOpen = open === r.p.product_key;
                const cc = covColor(r.coverage, r.neverSold);
                return (
                  <Fragment key={r.p.product_key}>
                    <motion.tr initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: Math.min(i * 0.008, 0.25) }}
                      className="cursor-pointer" onClick={() => setOpen(isOpen ? null : r.p.product_key)}>
                      <td className="max-w-sm truncate" title={r.p.name}>{r.p.name}</td>
                      <td className="mono text-[11px] text-txt-dim">{r.p.barkod ?? "—"}</td>
                      <td className="text-right mono font-bold">{fmtInt(r.stock)}</td>
                      <td className="text-right mono">{fmtVel(r.velocity)}</td>
                      <td className="text-right mono font-bold" style={{ color: cc }}>{fmtCov(r.coverage, r.neverSold)}</td>
                      <td className="text-center">
                        <div className="flex justify-center gap-1">
                          {r.p.firms.map((f) => <span key={f.retailer} className="inline-block w-2 h-2 rounded-full" title={f.retailer} style={{ background: col(f.retailer) }} />)}
                        </div>
                      </td>
                      <td className="text-right mono text-txt-dim">{isOpen ? "▾" : "▸"}</td>
                    </motion.tr>
                    {isOpen && (
                      <tr key={r.p.product_key + "-d"}>
                        <td colSpan={7} className="!p-0">
                          <div className="bg-ink-2/50 px-4 py-3">
                            <div className="mono text-[11px] text-txt-dim mb-2">{r.p.firms.length} firmada · firma içi stok / hız / coverage</div>
                            <div className="space-y-1">
                              {r.p.firms.map((f) => {
                                const fns = f.coverage == null && f.stock > 0;
                                return (
                                  <div key={f.retailer} className="flex items-center gap-3 text-[12px] mono py-1 border-b border-line/40">
                                    <span className="w-24 shrink-0 font-semibold flex items-center gap-2" style={{ color: col(f.retailer) }}>
                                      <span className="inline-block w-2 h-2 rounded-full" style={{ background: col(f.retailer) }} />{f.retailer}
                                    </span>
                                    <span className="flex-1 truncate text-txt-dim" title={f.sku_name}>{f.sku_name}</span>
                                    <span className="w-24 shrink-0 text-right">{fmtInt(f.stock)} adet</span>
                                    <span className="w-24 shrink-0 text-right text-txt-dim">{fmtVel(f.velocity)}/hf</span>
                                    <span className="w-20 shrink-0 text-right font-bold" style={{ color: covColor(f.coverage, fns) }}>{fmtCov(f.coverage, fns)}</span>
                                  </div>
                                );
                              })}
                            </div>
                          </div>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        )}
        {shown.length > 600 && <div className="mono text-[11px] text-txt-dim mt-3">İlk 600 gösteriliyor ({shown.length} toplam). Tümü için CSV indir.</div>}
      </div>
    </div>
  );
}
