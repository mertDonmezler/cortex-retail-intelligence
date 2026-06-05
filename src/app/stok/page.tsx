"use client";

import { Fragment, useEffect, useMemo, useState } from "react";
import { motion } from "framer-motion";
import { fmtInt, RETAILERS, RETAILER_COLORS, colorOf } from "@/lib/format";
import { downloadCsv } from "@/lib/csv";
import { fetchJson } from "@/lib/fetchJson";
import { parseProductMeta } from "@/lib/compute";
import { SortableTh, MultiChips, RangeMin, type SortDir } from "@/components/Controls";

const STATUS: Record<string, { label: string; cls: string }> = {
  kritik: { label: "Az stok", cls: "text-red-300 bg-red-500/15 border-red-500/40" },
  fazla: { label: "Fazla stok", cls: "text-yellow-300 bg-yellow-500/10 border-yellow-500/30" },
  saglikli: { label: "Sağlıklı", cls: "text-neon bg-neon/10 border-neon/30" },
};
const COLORS = RETAILER_COLORS;
const col = colorOf;

type StatusTab = "kritik" | "fazla" | "saglikli" | "all";
type View = "durum" | "sure" | "olu";
// Durum tablosunda sıralanabilir sayısal kolonlar (alan adları item üzerinde birebir).
type DurumSortKey = "avg_weekly" | "last_stock" | "coverage";

// Üç görünüm tek "Stok" merkezinde:
//  • durum → ağ geneli birleşik stok durumu (firma + az/fazla/sağlıklı filtresi)
//  • sure  → seçili firma/mağaza için stok süresi (coverage)
//  • olu   → ürün bazında firmalar arası ölü stok (genişleyebilir satır)
export default function StokPage() {
  const [view, setView] = useState<View>("durum");

  // Ağ geneli veri (durum + ölü stok) tek istekten gelir.
  const [data, setData] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    setLoading(true);
    setErr(null);
    fetchJson("/api/stock")
      .then((d) => { setData(d); setFirms(d.firms ?? []); })
      .catch((e) => { setErr(e.message); setData(null); })
      .finally(() => setLoading(false));
  }, []);

  // ───────── Durum görünümü state'i ─────────
  const [firms, setFirms] = useState<string[]>([]); // seçili firmalar (varsayılan: hepsi)
  const [status, setStatus] = useState<StatusTab>("kritik"); // varsayılan: az stok uyarıları
  const [search, setSearch] = useState("");
  // Ürün kimliği filtreleri (sku_name'den parseProductMeta ile çıkarılır) — hepsi boş = kısıt yok
  const [brands, setBrands] = useState<string[]>([]);
  const [teams, setTeams] = useState<string[]>([]);
  const [types, setTypes] = useState<string[]>([]);
  // Coverage (kaç hafta yeter) min/max — 0 = alt sınır yok, "" = üst sınır yok
  const [covMin, setCovMin] = useState(0);
  const [covMax, setCovMax] = useState<number | "">("");
  // Kolon sıralaması — null iken doğal (durum önceliği) sıra korunur
  const [sortKey, setSortKey] = useState<DurumSortKey | null>(null);
  const [sortDir, setSortDir] = useState<SortDir>("desc");

  const allFirms: string[] = data?.firms ?? [];

  // Her satıra ürün kimliğini (brand/team/type) bir kez ekle — chip seçenekleri ve filtre buradan.
  const enriched = useMemo(
    () =>
      (data?.items ?? []).map((i: any) => {
        const m = parseProductMeta(String(i.sku_name ?? ""));
        return { ...i, _brand: m.brand, _team: m.team, _type: m.type };
      }),
    [data]
  );

  // Chip seçenekleri yalnızca seçili firmalardaki ürünlerden türesin (boş seçenek gösterme).
  const metaOptions = useMemo(() => {
    const b = new Set<string>(), t = new Set<string>(), ty = new Set<string>();
    for (const i of enriched) {
      if (!firms.includes(i.retailer)) continue;
      b.add(i._brand); t.add(i._team); ty.add(i._type);
    }
    const srt = (s: Set<string>) => [...s].sort((x, y) => x.localeCompare(y, "tr"));
    return { brands: srt(b), teams: srt(t), types: srt(ty) };
  }, [enriched, firms]);

  // Firma seçimi değişince artık görünmeyen meta seçimlerini ayıkla (gizli ama aktif kalmasın).
  useEffect(() => {
    setBrands((p) => p.filter((x) => metaOptions.brands.includes(x)));
    setTeams((p) => p.filter((x) => metaOptions.teams.includes(x)));
    setTypes((p) => p.filter((x) => metaOptions.types.includes(x)));
  }, [metaOptions]);

  const counts = useMemo(() => {
    const sel = enriched.filter((i: any) => firms.includes(i.retailer));
    return {
      kritik: sel.filter((i: any) => i.status === "kritik").length,
      fazla: sel.filter((i: any) => i.status === "fazla").length,
      saglikli: sel.filter((i: any) => i.status === "saglikli").length,
    };
  }, [enriched, firms]);

  const items = useMemo(() => {
    let arr = enriched.filter((i: any) => firms.includes(i.retailer));
    if (status !== "all") arr = arr.filter((i: any) => i.status === status);
    if (brands.length) arr = arr.filter((i: any) => brands.includes(i._brand));
    if (teams.length) arr = arr.filter((i: any) => teams.includes(i._team));
    if (types.length) arr = arr.filter((i: any) => types.includes(i._type));
    // Coverage aralığı: null (satmıyor) coverage'ı yalnızca alt sınır 0 iken tut.
    if (covMin > 0 || covMax !== "") {
      arr = arr.filter((i: any) => {
        if (i.coverage == null) return covMin <= 0 && covMax === "";
        if (i.coverage < covMin) return false;
        if (covMax !== "" && i.coverage > covMax) return false;
        return true;
      });
    }
    if (search.trim()) {
      const q = search.toLowerCase();
      arr = arr.filter((i: any) => String(i.sku_name).toLowerCase().includes(q) || String(i.barkod ?? "").includes(q));
    }
    // Kolon sıralaması seçiliyse onu uygula; değilse doğal durum-önceliği sırası.
    if (sortKey) {
      const f = sortDir === "asc" ? 1 : -1;
      return [...arr].sort((a: any, b: any) => {
        const av = a[sortKey], bv = b[sortKey];
        // null coverage daima sona (yönden bağımsız).
        if (av == null && bv == null) return 0;
        if (av == null) return 1;
        if (bv == null) return -1;
        return f * (av - bv);
      });
    }
    const ord: Record<string, number> = { kritik: 0, fazla: 1, saglikli: 2 };
    return [...arr].sort((a: any, b: any) => {
      if (a.status !== b.status) return ord[a.status] - ord[b.status];
      return a.status === "kritik"
        ? (a.coverage ?? 0) - (b.coverage ?? 0)
        : (b.coverage ?? 1e9) - (a.coverage ?? 1e9);
    });
  }, [enriched, firms, status, brands, teams, types, covMin, covMax, search, sortKey, sortDir]);

  function toggleFirm(f: string) {
    setFirms((p) => (p.includes(f) ? p.filter((x) => x !== f) : [...p, f]));
  }
  function toggleIn(setter: React.Dispatch<React.SetStateAction<string[]>>, v: string) {
    setter((p) => (p.includes(v) ? p.filter((x) => x !== v) : [...p, v]));
  }
  function toggleDurumSort(k: string) {
    const key = k as DurumSortKey;
    if (sortKey === key) {
      // 3. tıkta sıralamayı sıfırla → doğal durum önceliği geri gelir.
      if (sortDir === "asc") { setSortKey(null); return; }
      setSortDir("asc");
    } else {
      setSortKey(key);
      setSortDir("desc"); // sayısal kolonlar: önce büyükten küçüğe
    }
  }

  // İçerik filtresi aktif mi? (firma + durum dışındaki "ekstra" filtreler) — temizle butonu için.
  const durumFiltered =
    brands.length > 0 || teams.length > 0 || types.length > 0 ||
    covMin > 0 || covMax !== "" || search.trim() !== "";
  function clearDurumFilters() {
    setBrands([]); setTeams([]); setTypes([]); setCovMin(0); setCovMax(""); setSearch("");
  }
  // "X / Y" sayacı için: firma+durum kapsamındaki ekstra-filtresiz toplam.
  const scopeTotal = useMemo(() => {
    let arr = enriched.filter((i: any) => firms.includes(i.retailer));
    if (status !== "all") arr = arr.filter((i: any) => i.status === status);
    return arr.length;
  }, [enriched, firms, status]);

  function exportDurumCsv() {
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

  const viewTabs: { id: View; label: string }[] = [
    { id: "durum", label: "Stok durumu" },
    { id: "sure", label: "Stok süresi (mağaza)" },
    { id: "olu", label: "Ölü stok" },
  ];

  return (
    <div className="space-y-6">
      <div className="flex items-end justify-between flex-wrap gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Stok <span className="neon-text">Merkezi</span></h1>
          <p className="text-txt-dim mono text-sm mt-1">
            Tek ekran · stok durumu (az/fazla) · mağaza bazında stok süresi · firmalar arası ölü stok
          </p>
        </div>
        {view === "durum" && (
          <button onClick={exportDurumCsv} disabled={!items.length}
            className="mono text-xs px-4 py-2 rounded-lg border border-line text-txt-dim hover:border-neon hover:text-neon transition-colors disabled:opacity-40">
            ⬇ CSV indir
          </button>
        )}
      </div>

      {/* Görünüm sekmeleri */}
      <div className="flex gap-1 flex-wrap border-b border-line">
        {viewTabs.map((t) => (
          <button key={t.id} onClick={() => setView(t.id)}
            className={`mono text-sm px-4 py-2 -mb-px border-b-2 transition-colors ${view === t.id ? "border-neon text-neon" : "border-transparent text-txt-dim hover:text-txt"}`}>
            {t.label}
          </button>
        ))}
      </div>

      {err && <div className="card p-4 border-red-500/40 text-red-400 mono text-sm">Veri alınamadı: {err}</div>}

      {/* ═════════ 1) STOK DURUMU ═════════ */}
      {view === "durum" && (
        <>
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

            {/* Ürün kimliği (marka / takım / tip) — sku adından çıkarılır */}
            <div className="border-t border-line/60 pt-3 space-y-2">
              {metaOptions.brands.length > 1 && (
                <MultiChips label="Marka:" options={metaOptions.brands} selected={brands}
                  onToggle={(v) => toggleIn(setBrands, v)} onNone={brands.length ? () => setBrands([]) : undefined} />
              )}
              {metaOptions.teams.length > 1 && (
                <MultiChips label="Takım:" options={metaOptions.teams} selected={teams}
                  onToggle={(v) => toggleIn(setTeams, v)} onNone={teams.length ? () => setTeams([]) : undefined} />
              )}
              {metaOptions.types.length > 1 && (
                <MultiChips label="Tip:" options={metaOptions.types} selected={types}
                  onToggle={(v) => toggleIn(setTypes, v)} onNone={types.length ? () => setTypes([]) : undefined} />
              )}
              <div className="flex items-center gap-4 flex-wrap pt-1">
                <span className="mono text-xs text-txt-dim">Kaç hafta yeter:</span>
                <RangeMin label="min" value={covMin} onChange={setCovMin} suffix="hf" step={1} />
                <label className="mono text-xs text-txt-dim flex items-center gap-2">
                  maks
                  <input type="number" min={0} step={1} value={covMax}
                    onChange={(e) => { const v = e.target.value; setCovMax(v === "" ? "" : Math.max(0, Number(v) || 0)); }}
                    placeholder="∞"
                    className="w-20 mono text-sm px-2 py-2 rounded-lg bg-ink-2 border border-line outline-none focus:border-neon text-txt" />
                  <span className="text-txt-dim">hf</span>
                </label>
                {durumFiltered && (
                  <button onClick={clearDurumFilters}
                    className="mono text-[11px] text-txt-dim hover:text-neon transition-colors">
                    ✕ filtreyi temizle
                  </button>
                )}
              </div>
            </div>
          </div>

          {loading ? (
            <div className="card p-10 text-center mono text-txt-dim animate-pulse">Yükleniyor…</div>
          ) : err || !data ? null : (
            <div className="card p-6 overflow-x-auto">
              <div className="flex items-center justify-between mb-3">
                <h2 className="font-bold">{status === "kritik" ? "Az stok (sipariş gerekebilir)" : status === "fazla" ? "Fazla stok (kampanya)" : status === "saglikli" ? "Sağlıklı" : "Tüm stok durumu"}</h2>
                <span className="mono text-xs text-txt-dim">
                  {durumFiltered ? `${items.length} / ${scopeTotal}` : `${items.length}`} kalem
                </span>
              </div>
              {items.length ? (
                <table>
                  <thead>
                    <tr>
                      <th>#</th><th>Firma</th><th>Ürün</th>
                      <SortableTh label="Haftalık Ort." sortKey="avg_weekly" align="right"
                        active={sortKey === "avg_weekly"} dir={sortDir} onClick={toggleDurumSort} />
                      <SortableTh label="Stok" sortKey="last_stock" align="right"
                        active={sortKey === "last_stock"} dir={sortDir} onClick={toggleDurumSort} />
                      <SortableTh label="Kaç Hafta Yeter" sortKey="coverage" align="right"
                        active={sortKey === "coverage"} dir={sortDir} onClick={toggleDurumSort} />
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
                <div className="mono text-sm text-txt-dim py-4">
                  {scopeTotal > 0 && durumFiltered ? (
                    <>Bu filtrede kalem yok. <button onClick={clearDurumFilters} className="text-neon hover:underline">Filtreyi temizle</button> ({scopeTotal} kalem var).</>
                  ) : (
                    "Bu seçimde kalem yok."
                  )}
                </div>
              )}
            </div>
          )}
        </>
      )}

      {/* ═════════ 2) STOK SÜRESİ (COVERAGE) ═════════ */}
      {view === "sure" && <CoverageView />}

      {/* ═════════ 3) ÖLÜ STOK ═════════ */}
      {view === "olu" && <DeadStockView products={data?.products ?? []} loading={loading} />}
    </div>
  );
}

// ═══════════════════════ STOK SÜRESİ (COVERAGE) GÖRÜNÜMÜ ═══════════════════════
// Kapsam: Firma geneli / Mağaza. Firma seçilince mağaza listesi /api/stores'tan
// gelir; mağaza seçilince o mağazanın anlık coverage'ı /api/stock?retailer&store
// üzerinden çekilir.
type CovStatus = "kritik" | "fazla" | "saglikli";
interface Sku { sku_name: string; avg_weekly: number; last_stock: number; coverage: number | null; status: CovStatus; }

const COV_META: Record<CovStatus, { label: string; color: string }> = {
  kritik: { label: "Az stok (<8 hf)", color: "#ff5555" },
  fazla: { label: "Fazla / kampanya (>30 hf)", color: "#f8b00b" },
  saglikli: { label: "Sağlıklı (8–30 hf)", color: "#1FF80B" },
};
const fmtCov = (c: number | null) => (c == null ? "satmıyor" : c.toFixed(1) + " hf");
const fmtAvg = (n: number) => (Math.round(n * 10) / 10).toLocaleString("tr-TR");

function CoverageView() {
  const [retailer, setRetailer] = useState<string>(RETAILERS[3] ?? RETAILERS[0]); // Toyzz varsayılan
  const [store, setStore] = useState<string>(""); // "" = firma geneli
  const [stores, setStores] = useState<string[]>([]);
  const [data, setData] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [filter, setFilter] = useState<"all" | CovStatus>("all");

  // Mağaza listesi (store-level perakendeciler için)
  useEffect(() => {
    setStore("");
    fetch(`/api/stores?retailer=${encodeURIComponent(retailer)}`)
      .then((r) => r.json()).then((d) => {
        setStores(d?.storeLevel && Array.isArray(d?.stores) ? d.stores.map((s: any) => s.store) : []);
      }).catch(() => setStores([]));
  }, [retailer]);

  // Coverage verisi (firma geneli veya mağaza özelinde)
  useEffect(() => {
    setLoading(true);
    const url = `/api/stock?retailer=${encodeURIComponent(retailer)}${store ? `&store=${encodeURIComponent(store)}` : ""}`;
    fetchJson(url)
      .then((d) => { setData(d); setErr(null); })
      .catch((e) => { setErr(e.message); setData(null); })
      .finally(() => setLoading(false));
  }, [retailer, store]);

  const skus: Sku[] = data?.skus ?? [];
  const shown = filter === "all" ? skus : skus.filter((s) => s.status === filter);

  function exportCsv() {
    downloadCsv(
      `cortex-stok-suresi-${retailer}${store ? "-" + store : ""}`,
      shown.map((s) => ({
        sku: s.sku_name, ort_haftalik_satis: Math.round(s.avg_weekly * 10) / 10,
        stok: s.last_stock, coverage_hafta: s.coverage == null ? "" : Math.round(s.coverage * 10) / 10,
        durum: COV_META[s.status].label,
      })),
      [
        { key: "sku", label: "Ürün" }, { key: "ort_haftalik_satis", label: "Haftalık Ort. Satış" },
        { key: "stok", label: "Stok" }, { key: "coverage_hafta", label: "Coverage (hafta)" },
        { key: "durum", label: "Durum" },
      ]
    );
  }

  return (
    <div className="space-y-5">
      <div className="card p-4 flex items-center justify-between flex-wrap gap-3">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="mono text-xs text-txt-dim mr-1">Kapsam:</span>
          <span className={`mono text-[11px] px-2 py-1 rounded ${store ? "text-txt-dim" : "bg-neon/15 text-neon"}`}>Firma geneli</span>
          <span className="mono text-[11px] text-txt-dim">→</span>
          <span className={`mono text-[11px] px-2 py-1 rounded ${store ? "bg-neon/15 text-neon" : "text-txt-dim"}`}>Mağaza{store ? `: ${store}` : ""}</span>
          <select value={retailer} onChange={(e) => setRetailer(e.target.value)}
            className="card mono text-sm px-4 py-2 bg-ink-2 outline-none focus:border-neon ml-2">
            {RETAILERS.map((r) => <option key={r} value={r} className="bg-ink-2">{r}</option>)}
          </select>
          {stores.length > 0 ? (
            <select value={store} onChange={(e) => setStore(e.target.value)}
              className="card mono text-sm px-4 py-2 bg-ink-2 outline-none focus:border-neon max-w-[220px]">
              <option value="" className="bg-ink-2">Tüm firma (geneli)</option>
              {stores.map((s) => <option key={s} value={s} className="bg-ink-2">{s}</option>)}
            </select>
          ) : (
            <span className="mono text-[11px] text-txt-dim">mağaza kırılımı yok (firma geneli)</span>
          )}
        </div>
        <button onClick={exportCsv} disabled={shown.length === 0}
          className="mono text-xs px-4 py-2 rounded-lg border border-line text-txt-dim hover:border-neon hover:text-neon transition-colors disabled:opacity-40 disabled:hover:border-line disabled:hover:text-txt-dim disabled:cursor-not-allowed">
          ⬇ CSV
        </button>
      </div>

      <p className="text-txt-dim mono text-xs">
        Stok ÷ ortalama haftalık satış · &lt;8 hafta sipariş, &gt;30 hafta kampanya
        {store ? ` · mağaza: ${store}` : " · firma geneli"}
      </p>

      {err && <div className="card p-4 border-red-500/40 text-red-400 mono text-sm">Veri alınamadı: {err}</div>}

      {/* Özet kartları (tıkla → filtrele) — yeni kapsam yüklenirken eski sayılar soluk */}
      <div className={`grid grid-cols-2 md:grid-cols-4 gap-3 transition-opacity ${loading ? "opacity-50" : "opacity-100"}`}>
        <SummaryCard label="TÜM SKU" value={data?.summary?.toplam ?? 0} active={filter === "all"} onClick={() => setFilter("all")} color="#7d927d" />
        <SummaryCard label="AZ STOK · SİPARİŞ" value={data?.summary?.kritik ?? 0} active={filter === "kritik"} onClick={() => setFilter("kritik")} color="#ff5555" />
        <SummaryCard label="SAĞLIKLI" value={data?.summary?.saglikli ?? 0} active={filter === "saglikli"} onClick={() => setFilter("saglikli")} color="#1FF80B" />
        <SummaryCard label="FAZLA · KAMPANYA" value={data?.summary?.fazla ?? 0} active={filter === "fazla"} onClick={() => setFilter("fazla")} color="#f8b00b" />
      </div>

      <div className="card p-6 overflow-x-auto">
        <div className="flex items-center justify-between mb-3">
          <h2 className="font-bold">{filter === "all" ? "Tüm SKU" : COV_META[filter].label}</h2>
          <span className="mono text-xs text-txt-dim">
            {filter === "all" ? `${fmtInt(shown.length)}` : `${fmtInt(shown.length)} / ${fmtInt(skus.length)}`} SKU
          </span>
        </div>
        {loading && !data ? (
          <div className="text-center mono text-txt-dim animate-pulse py-6">Yükleniyor…</div>
        ) : shown.length === 0 ? (
          <div className="text-center mono text-sm text-txt-dim py-6">
            {skus.length === 0 ? "Bu seçim için veri yok." : (
              <>Bu filtrede SKU yok. <button onClick={() => setFilter("all")} className="text-neon hover:underline">Tümünü göster</button> ({fmtInt(skus.length)} SKU var).</>
            )}
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
                const m = COV_META[s.status];
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

// ═══════════════════════ ÖLÜ STOK GÖRÜNÜMÜ ═══════════════════════
// Ağ geneli ürün satırı tıklanınca firma kırılımı açılır. Kaynak: parametresiz
// /api/stock yanıtındaki products (groupDeadStock).
interface DSFirm { retailer: string; sku_name: string; stock: number; velocity: number; coverage: number | null; }
interface DSProduct {
  product_key: string; barkod: string | null; name: string;
  total_stock: number; total_velocity: number; coverage: number | null;
  never_sold: boolean; max_firm_coverage: number | null; firms: DSFirm[];
}
type SortKey = "name" | "barkod" | "stock" | "velocity" | "coverage" | "firms";

const fmtDeadCov = (c: number | null, neverSold: boolean) =>
  neverSold ? "∞ satmıyor" : c == null ? "—" : c.toFixed(0) + " hf";
const fmtVel = (n: number) => (Math.round(n * 10) / 10).toLocaleString("tr-TR");
const covColor = (c: number | null, neverSold: boolean) =>
  neverSold ? "#ff5555" : c == null ? "#7d927d" : c > 120 ? "#ff5555" : c > 60 ? "#f8b00b" : "#1FF80B";

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

function DeadStockView({ products, loading }: { products: DSProduct[]; loading: boolean }) {
  const [q, setQ] = useState("");
  const [retailer, setRetailer] = useState(""); // "" = ağ geneli (tüm firmalar birleşik)
  const [minWeeks, setMinWeeks] = useState(60);
  const [includeNeverSold, setIncludeNeverSold] = useState(true);
  const [open, setOpen] = useState<string | null>(null);
  const [sortKey, setSortKey] = useState<SortKey>("coverage");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");

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
    }).filter(Boolean) as { p: DSProduct; stock: number; velocity: number; coverage: number | null; neverSold: boolean; firmName: string }[];

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
  // Seçili kapsamda (firma/ağ) stoklu ürün sayısı — "X / Y" sayacının paydası.
  const scopeCount = useMemo(() => {
    if (!retailer) return products.filter((p) => p.total_stock > 0).length;
    return products.filter((p) => (p.firms.find((f) => f.retailer === retailer)?.stock ?? 0) > 0).length;
  }, [products, retailer]);

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
    <div className="space-y-5">
      <div className="flex items-end justify-between flex-wrap gap-4">
        <p className="text-txt-dim mono text-sm">
          Stok ÷ haftalık satış hızı &gt; {minWeeks} hafta · {retailer || "tüm firmalar birleşik"} · hiç satmayan = ∞ · ürün satırına tıkla → firma kırılımı
        </p>
        <button onClick={exportCsv} disabled={shown.length === 0}
          className="mono text-xs px-4 py-2 rounded-lg border border-line text-txt-dim hover:border-neon hover:text-neon transition-colors disabled:opacity-40 disabled:hover:border-line disabled:hover:text-txt-dim disabled:cursor-not-allowed">
          ⬇ CSV
        </button>
      </div>

      {/* Özet */}
      <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
        <div className="card p-5">
          <div className="mono text-[10px] text-txt-dim tracking-wider">ÖLÜ STOK ÜRÜNÜ</div>
          <div className="text-3xl font-bold mono mt-1 neon-text">
            {fmtInt(shown.length)}
            <span className="text-sm text-txt-dim"> / {fmtInt(scopeCount)}</span>
          </div>
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
          <div className="text-center mono text-sm text-txt-dim py-6">
            {scopeCount > 0 ? (
              <>Bu filtrede ölü stok yok. <button onClick={() => { setQ(""); setMinWeeks(0); setIncludeNeverSold(true); }} className="text-neon hover:underline">Filtreyi gevşet</button> ({fmtInt(scopeCount)} stoklu ürün var).</>
            ) : (
              "Bu kapsamda stoklu ürün yok."
            )}
          </div>
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
                      <td className="text-right mono font-bold" style={{ color: cc }}>{fmtDeadCov(r.coverage, r.neverSold)}</td>
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
                                    <span className="w-20 shrink-0 text-right font-bold" style={{ color: covColor(f.coverage, fns) }}>{fmtDeadCov(f.coverage, fns)}</span>
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
