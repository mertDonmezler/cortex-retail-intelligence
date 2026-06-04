"use client";

import { useEffect, useMemo, useState } from "react";
import { fmtInt, RETAILER_COLORS } from "@/lib/format";
import { downloadCsv } from "@/lib/csv";
import { fetchJson } from "@/lib/fetchJson";

const STATUS: Record<string, { label: string; cls: string }> = {
  kritik: { label: "Az stok", cls: "text-red-300 bg-red-500/15 border-red-500/40" },
  fazla: { label: "Fazla stok", cls: "text-yellow-300 bg-yellow-500/10 border-yellow-500/30" },
  saglikli: { label: "Sağlıklı", cls: "text-neon bg-neon/10 border-neon/30" },
};
const COLORS = RETAILER_COLORS;

type StatusTab = "kritik" | "fazla" | "saglikli" | "all";

export default function StokPage() {
  const [data, setData] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [firms, setFirms] = useState<string[]>([]); // seçili firmalar (varsayılan: hepsi)
  const [status, setStatus] = useState<StatusTab>("kritik"); // varsayılan: az stok uyarıları
  const [search, setSearch] = useState("");

  useEffect(() => {
    setLoading(true);
    setErr(null);
    fetchJson("/api/stock")
      .then((d) => { setData(d); setFirms(d.firms ?? []); })
      .catch((e) => { setErr(e.message); setData(null); })
      .finally(() => setLoading(false));
  }, []);

  const allFirms: string[] = data?.firms ?? [];

  // Seçili firmalar üzerinden durum sayıları
  const counts = useMemo(() => {
    const sel = (data?.items ?? []).filter((i: any) => firms.includes(i.retailer));
    return {
      kritik: sel.filter((i: any) => i.status === "kritik").length,
      fazla: sel.filter((i: any) => i.status === "fazla").length,
      saglikli: sel.filter((i: any) => i.status === "saglikli").length,
    };
  }, [data, firms]);

  const items = useMemo(() => {
    let arr = (data?.items ?? []).filter((i: any) => firms.includes(i.retailer));
    if (status !== "all") arr = arr.filter((i: any) => i.status === status);
    if (search.trim()) {
      const q = search.toLowerCase();
      arr = arr.filter((i: any) => String(i.sku_name).toLowerCase().includes(q) || String(i.barkod ?? "").includes(q));
    }
    const ord: Record<string, number> = { kritik: 0, fazla: 1, saglikli: 2 };
    return [...arr].sort((a: any, b: any) => {
      if (a.status !== b.status) return ord[a.status] - ord[b.status];
      // kritik: en düşük kapsam önce; fazla: en yüksek önce
      return a.status === "kritik"
        ? (a.coverage ?? 0) - (b.coverage ?? 0)
        : (b.coverage ?? 1e9) - (a.coverage ?? 1e9);
    });
  }, [data, firms, status, search]);

  function toggleFirm(f: string) {
    setFirms((p) => (p.includes(f) ? p.filter((x) => x !== f) : [...p, f]));
  }

  function exportCsv() {
    if (!items.length) return;
    downloadCsv("cortex-stok-durumu", items.map((r: any) => ({
      firma: r.retailer, urun: r.sku_name, barkod: r.barkod ?? "",
      haftalik_ort: Math.round(r.avg_weekly * 10) / 10, stok: r.last_stock,
      kac_hafta: r.coverage == null ? "" : Math.round(r.coverage * 10) / 10,
      durum: STATUS[r.status]?.label ?? r.status,
    })), [
      { key: "firma", label: "Firma" }, { key: "urun", label: "Ürün" }, { key: "barkod", label: "Barkod" },
      { key: "haftalik_ort", label: "Haftalık Ort. Satış" }, { key: "stok", label: "Stok" },
      { key: "kac_hafta", label: "Kaç Hafta Yeter" }, { key: "durum", label: "Durum" },
    ]);
  }

  const statusTabs: { id: StatusTab; label: string }[] = [
    { id: "kritik", label: `🔴 Az stok (${counts.kritik})` },
    { id: "fazla", label: `🟡 Fazla stok (${counts.fazla})` },
    { id: "saglikli", label: `🟢 Sağlıklı (${counts.saglikli})` },
    { id: "all", label: "Tümü" },
  ];

  return (
    <div className="space-y-6">
      <div className="flex items-end justify-between flex-wrap gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Stok <span className="neon-text">Durumu</span></h1>
          <p className="text-txt-dim mono text-sm mt-1">
            Tüm firmalar tek ekranda · stok süresi (kaç hafta yeter) + az stok uyarıları
          </p>
        </div>
        <button onClick={exportCsv} disabled={!items.length}
          className="mono text-xs px-4 py-2 rounded-lg border border-line text-txt-dim hover:border-neon hover:text-neon transition-colors disabled:opacity-40">
          ⬇ CSV indir
        </button>
      </div>

      {/* Firma seçimi (çoklu) */}
      <div className="card p-4 space-y-3">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="mono text-xs text-txt-dim mr-1">Firmalar:</span>
          {allFirms.map((f) => {
            const on = firms.includes(f);
            return (
              <button key={f} onClick={() => toggleFirm(f)}
                className="mono text-xs px-3 py-1.5 rounded-full border transition-colors"
                style={on
                  ? { color: COLORS[f] ?? "#1FF80B", borderColor: (COLORS[f] ?? "#1FF80B") + "80", background: (COLORS[f] ?? "#1FF80B") + "1a" }
                  : { color: "#7d927d", borderColor: "#1f2a1f" }}>
                {on ? "✓ " : ""}{f}
              </button>
            );
          })}
          <button onClick={() => setFirms(allFirms)} className="mono text-[11px] text-txt-dim hover:text-neon ml-1">tümü</button>
          <button onClick={() => setFirms([])} className="mono text-[11px] text-txt-dim hover:text-neon">hiçbiri</button>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <div className="flex gap-1 flex-wrap">
            {statusTabs.map((t) => (
              <button key={t.id} onClick={() => setStatus(t.id)}
                className={`mono text-xs px-3 py-1.5 rounded ${status === t.id ? "bg-neon/15 text-neon" : "text-txt-dim hover:text-txt"}`}>
                {t.label}
              </button>
            ))}
          </div>
          <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="🔍 ürün / barkod…"
            className="card mono text-sm px-3 py-1.5 bg-ink-2 outline-none focus:border-neon flex-1 min-w-48" />
        </div>
      </div>

      {err && <div className="card p-4 border-red-500/40 text-red-400 mono text-sm">Veri alınamadı: {err}</div>}

      {loading ? (
        <div className="card p-10 text-center mono text-txt-dim animate-pulse">Yükleniyor…</div>
      ) : err || !data ? null : (
        <div className="card p-6 overflow-x-auto">
          <div className="flex items-center justify-between mb-3">
            <h2 className="font-bold">{status === "kritik" ? "Az stok (sipariş gerekebilir)" : status === "fazla" ? "Fazla stok (kampanya)" : status === "saglikli" ? "Sağlıklı" : "Tüm stok durumu"}</h2>
            <span className="mono text-xs text-txt-dim">{items.length} kalem</span>
          </div>
          {items.length ? (
            <table>
              <thead>
                <tr>
                  <th>#</th><th>Firma</th><th>Ürün</th>
                  <th className="text-right">Haftalık Ort.</th>
                  <th className="text-right">Stok</th>
                  <th className="text-right">Kaç Hafta Yeter</th>
                  <th>Durum</th>
                </tr>
              </thead>
              <tbody>
                {items.map((r: any, i: number) => {
                  const st = STATUS[r.status] ?? STATUS.saglikli;
                  return (
                    <tr key={i}>
                      <td className="mono text-txt-dim">{i + 1}</td>
                      <td>
                        <span className="mono text-[10px] px-1.5 py-0.5 rounded" style={{ color: COLORS[r.retailer] ?? "#7d927d", border: `1px solid ${COLORS[r.retailer] ?? "#7d927d"}40` }}>{r.retailer}</span>
                      </td>
                      <td className="max-w-[340px] truncate" title={(r.barkod ? r.barkod + " · " : "") + r.sku_name}>{r.sku_name}</td>
                      <td className="mono text-right">{Math.round(r.avg_weekly * 10) / 10}</td>
                      <td className="mono text-right">{fmtInt(r.last_stock)}</td>
                      <td className="mono text-right">{r.coverage == null ? "—" : `${Math.round(r.coverage * 10) / 10} hf`}</td>
                      <td><span className={`mono text-[10px] px-2 py-0.5 rounded border ${st.cls}`}>{st.label}</span></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          ) : (
            <div className="mono text-sm text-txt-dim py-4">Bu filtrede kalem yok.</div>
          )}
        </div>
      )}
    </div>
  );
}
