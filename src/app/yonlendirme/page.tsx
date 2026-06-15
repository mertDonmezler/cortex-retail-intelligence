"use client";

import { useEffect, useMemo, useState } from "react";
import { fmtInt, fmtMoney, colorOf } from "@/lib/format";
import { fetchJson } from "@/lib/fetchJson";
import { SortableTh, SearchBox, MultiChips, RangeMin, useSort, CsvBtn } from "@/components/Controls";

type Target = { retailer: string; qty: number; vel: number } | null;
type Route = {
  action: "TRANSFER" | "DEPO" | "SEVK" | "İZLE";
  retailer: string; sku_name: string; barkod: string; season: string;
  stock: number; velocity: number; coverage: number | null; psf: number;
  qty: number; target: Target; toDepot: number; value: number; reason: string; noPrice?: boolean;
  [k: string]: unknown;
};

const ACT: Record<string, { label: string; c: string }> = {
  TRANSFER: { label: "ÇEK → VER", c: "#0bd1f8" },
  DEPO: { label: "ÇEK → DEPO", c: "#f8b00b" },
  SEVK: { label: "SEVK ET", c: "#1FF80B" },
  "İZLE": { label: "İZLE", c: "#7d927d" },
};
const SEASON_C: Record<string, string> = { "ESKİ": "#ff5555", "25/26": "#1FF80B", "TREND": "#0bd1f8", "DİĞER": "#7d927d" };

export default function YonlendirmePage() {
  const [keep, setKeep] = useState(13);
  const [data, setData] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  const [action, setAction] = useState<string>("TRANSFER");
  const [firms, setFirms] = useState<string[]>([]);
  const [q, setQ] = useState("");
  const [minVal, setMinVal] = useState(0);

  useEffect(() => {
    setLoading(true);
    fetchJson(`/api/routing?keep=${keep}`)
      .then((d) => { setData(d); setErr(null); })
      .catch((e) => { setErr(e.message); setData(null); })
      .finally(() => setLoading(false));
  }, [keep]);

  const routes: Route[] = data?.routes ?? [];
  const sm = data?.summary;
  const firmOpts = useMemo(() => [...new Set(routes.map((r) => r.retailer))].sort((a, b) => a.localeCompare(b, "tr")), [routes]);

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return routes.filter((r) => {
      if (action !== "all" && r.action !== action) return false;
      if (firms.length && !firms.includes(r.retailer)) return false;
      if (minVal > 0 && (r.value || 0) < minVal) return false;
      if (needle) {
        const hay = `${r.sku_name} ${r.barkod} ${r.target?.retailer ?? ""}`.toLowerCase();
        if (!hay.includes(needle)) return false;
      }
      return true;
    });
  }, [routes, action, firms, minVal, q]);

  const { sorted, sortKey, dir, toggle } = useSort<Route>(filtered, "value", "desc");
  const shownVal = useMemo(() => sorted.reduce((s, r) => s + (r.value || 0), 0), [sorted]);

  const csvRows = useMemo(() => sorted.map((r) => ({
    aksiyon: ACT[r.action]?.label ?? r.action, firma: r.retailer, urun: r.sku_name, barkod: r.barkod, sezon: r.season,
    stok: r.stock, hiz_hf: r.velocity, kapsam_hf: r.coverage ?? "", cek_adet: r.qty,
    hedef: r.target ? `${r.target.retailer} (${r.target.qty} ad)` : (r.action === "DEPO" ? "DEPO" : ""),
    depoya: r.toDepot, psf_deger: r.value, sebep: r.reason,
  })), [sorted]);
  const csvCols = [
    { key: "aksiyon" as const, label: "Aksiyon" }, { key: "firma" as const, label: "Firma" }, { key: "urun" as const, label: "Ürün" },
    { key: "barkod" as const, label: "Barkod" }, { key: "sezon" as const, label: "Sezon" }, { key: "stok" as const, label: "Stok" },
    { key: "hiz_hf" as const, label: "Hız/hf" }, { key: "kapsam_hf" as const, label: "Kapsam(hf)" }, { key: "cek_adet" as const, label: "Çek/Sevk Adet" },
    { key: "hedef" as const, label: "Hedef" }, { key: "depoya" as const, label: "Depoya" }, { key: "psf_deger" as const, label: "PSF Değeri" }, { key: "sebep" as const, label: "Sebep" },
  ];

  const cards = [
    { id: "TRANSFER", label: "ÇEK → VER (transfer)", val: sm ? `${fmtMoney(sm.transfer.psf)}` : "", sub: sm ? `${sm.transfer.n} kalem` : "", c: "#0bd1f8" },
    { id: "DEPO", label: "ÇEK → DEPO / İADE", val: sm ? `${fmtMoney(sm.depo.psf)}` : "", sub: sm ? `${sm.depo.n} kalem` : "", c: "#f8b00b" },
    { id: "SEVK", label: "SEVK ET (az stok)", val: sm ? `${sm.sevk.n}` : "", sub: "ürün", c: "#1FF80B" },
    { id: "İZLE", label: "İZLE (yeni ürün)", val: sm ? `${sm.izle.n}` : "", sub: "ürün", c: "#7d927d" },
  ];

  return (
    <div className="space-y-6">
      <div className="flex items-end justify-between flex-wrap gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Stok <span className="neon-text">Yönlendirme</span></h1>
          <p className="text-txt-dim mono text-sm mt-1">
            Dinamik karar · çek→ver (firmalar arası transfer) · çek→depo (iade) · sevk · saf PSF
          </p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <span className="mono text-xs text-txt-dim">Kanalda bırak:</span>
          {[8, 13, 26].map((k) => (
            <button key={k} onClick={() => setKeep(k)}
              className={`mono text-xs px-3 py-1.5 rounded ${keep === k ? "bg-neon/15 text-neon" : "text-txt-dim hover:text-txt border border-line"}`}>{k} hf</button>
          ))}
        </div>
      </div>

      {err && <div className="card p-4 border-red-500/40 text-red-400 mono text-sm">Veri alınamadı: {err}</div>}

      {/* Aksiyon özet kartları (tıkla → filtrele) */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        {cards.map((c) => {
          const on = action === c.id;
          return (
            <button key={c.id} onClick={() => setAction(c.id)}
              className="card p-4 text-left transition-colors hover:border-neon/50"
              style={on ? { borderColor: c.c + "80", background: c.c + "12" } : undefined}>
              <div className="mono text-[10px] tracking-wider text-txt-dim">{c.label}</div>
              <div className="text-xl font-bold mono mt-1" style={{ color: c.c }}>{c.val}<span className="text-xs text-txt-dim ml-1">{c.sub}</span></div>
            </button>
          );
        })}
      </div>

      {sm && (
        <div className="card p-3 mono text-xs text-txt-dim flex flex-wrap gap-x-6 gap-y-1">
          <span>Toplam çekilecek (transfer + depo): <span className="font-bold" style={{ color: "#f8b00b" }}>{fmtMoney(sm.cekToplam)} PSF</span></span>
          <span>Kanalda {keep} haftalık stok bırakılır · satmıyor &lt;1/hf · aşırı stok &gt;26 hf · yeni ürün (&lt;6 hf) iade edilmez · hedef kapasitesi paylaşımlı (çift-tahsis yok) · PSF medyan{sm.noPrice ? ` · ${sm.noPrice} kalem fiyatsız (değerleme dışı)` : ""}</span>
        </div>
      )}

      {/* Filtre */}
      <div className="card p-4 space-y-3">
        <div className="flex items-center gap-3 flex-wrap">
          <div className="flex gap-1 flex-wrap">
            {["TRANSFER", "DEPO", "SEVK", "İZLE", "all"].map((a) => (
              <button key={a} onClick={() => setAction(a)}
                className={`mono text-xs px-3 py-1.5 rounded ${action === a ? "bg-neon/15 text-neon" : "text-txt-dim hover:text-txt"}`}>
                {a === "all" ? "Tümü" : ACT[a].label}
              </button>
            ))}
          </div>
          <SearchBox value={q} onChange={setQ} placeholder="Ürün / barkod / hedef…" className="flex-1 min-w-[200px]" />
          <RangeMin label="Min PSF değer" value={minVal} onChange={setMinVal} suffix="₺" step={5000} min={0} />
        </div>
        {firmOpts.length > 1 && (
          <MultiChips label="Firma:" options={firmOpts} selected={firms}
            onToggle={(f) => setFirms((p) => (p.includes(f) ? p.filter((x) => x !== f) : [...p, f]))}
            onAll={() => setFirms([...firmOpts])} onNone={() => setFirms([])} colorOf={colorOf} />
        )}
      </div>

      {/* Tablo */}
      <div className="card p-6 overflow-x-auto">
        <div className="flex items-center justify-between gap-3 flex-wrap mb-3">
          <h2 className="font-bold">{action === "all" ? "Tüm yönlendirmeler" : ACT[action]?.label}</h2>
          <div className="flex items-center gap-3">
            <span className="mono text-xs text-txt-dim">{sorted.length} kalem{shownVal > 0 ? ` · ${fmtMoney(shownVal)} PSF` : ""}</span>
            <CsvBtn filename={`cortex-yonlendirme-${action}`} rows={csvRows} cols={csvCols} />
          </div>
        </div>
        {loading ? <div className="mono text-txt-dim animate-pulse py-6 text-center">Hesaplanıyor…</div>
          : sorted.length === 0 ? <div className="mono text-sm text-txt-dim py-6 text-center">Bu seçimde yönlendirme yok.</div>
          : (
          <table className="w-full">
            <thead>
              <tr>
                <th className="text-left">Aksiyon</th>
                <th className="text-left">Firma</th>
                <th className="text-left">Ürün</th>
                <th>Sezon</th>
                <SortableTh label="Stok" sortKey="stock" align="right" active={sortKey === "stock"} dir={dir} onClick={toggle} />
                <SortableTh label="Hız/hf" sortKey="velocity" align="right" active={sortKey === "velocity"} dir={dir} onClick={toggle} />
                <SortableTh label="Kapsam" sortKey="coverage" align="right" active={sortKey === "coverage"} dir={dir} onClick={toggle} />
                <SortableTh label="Çek/Sevk" sortKey="qty" align="right" active={sortKey === "qty"} dir={dir} onClick={toggle} />
                <th className="text-left">Nereye</th>
                <SortableTh label="PSF Değeri" sortKey="value" align="right" active={sortKey === "value"} dir={dir} onClick={toggle} />
              </tr>
            </thead>
            <tbody>
              {sorted.slice(0, 600).map((r, i) => {
                const a = ACT[r.action] ?? ACT["İZLE"];
                return (
                  <tr key={i} className="border-b border-line/40" title={r.reason}>
                    <td><span className="mono text-[10px] px-2 py-0.5 rounded whitespace-nowrap" style={{ color: a.c, background: a.c + "1a" }}>{a.label}</span></td>
                    <td><span className="mono text-[10px]" style={{ color: colorOf(r.retailer) }}>{r.retailer}</span></td>
                    <td className="max-w-[320px] truncate" title={(r.barkod ? r.barkod + " · " : "") + r.sku_name + " — " + r.reason}>{r.sku_name}</td>
                    <td className="text-center"><span className="mono text-[9px] px-1.5 py-0.5 rounded" style={{ color: SEASON_C[r.season] ?? "#7d927d" }}>{r.season}</span></td>
                    <td className="mono text-right">{fmtInt(r.stock)}</td>
                    <td className="mono text-right">{r.velocity}</td>
                    <td className="mono text-right">{r.coverage == null ? "∞" : r.coverage + " hf"}</td>
                    <td className="mono text-right font-bold">{r.qty ? fmtInt(r.qty) : "—"}</td>
                    <td className="mono text-[11px]">
                      {r.action === "TRANSFER" && r.target ? (
                        <span><span style={{ color: colorOf(r.target.retailer) }}>→ {r.target.retailer}</span> {fmtInt(r.target.qty)} ad{r.toDepot > 0 ? <span className="text-txt-dim"> + depo {fmtInt(r.toDepot)}</span> : ""}</span>
                      ) : r.action === "DEPO" ? <span style={{ color: "#f8b00b" }}>→ Depo / iade</span>
                        : r.action === "SEVK" ? <span style={{ color: "#1FF80B" }}>depodan sevk</span>
                        : <span className="text-txt-dim">bekle</span>}
                    </td>
                    <td className="mono text-right" style={{ color: r.value ? "#f8b00b" : "#7d927d" }}>{r.value ? fmtMoney(r.value) : (r.noPrice ? <span className="text-[10px] text-txt-dim" title="Sistemde fiyat yok — değerleme dışı, adetle karar ver">fiyat yok</span> : "—")}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
        {sorted.length > 600 && <div className="mono text-[11px] text-txt-dim mt-3">İlk 600 gösteriliyor ({sorted.length} toplam). Tümü için CSV indir.</div>}
      </div>
    </div>
  );
}
