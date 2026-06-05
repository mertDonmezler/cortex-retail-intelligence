"use client";

import { useEffect, useMemo, useState } from "react";
import { motion } from "framer-motion";
import { RETAILERS, fmtInt, fmtPct, fmtDate, colorOf } from "@/lib/format";
import { parseProductMeta } from "@/lib/compute";
import { fetchJson } from "@/lib/fetchJson";
import {
  SortableTh,
  SearchBox,
  MultiChips,
  SegTabs,
  RangeMin,
  useSort,
  StatCard,
  CsvBtn,
} from "@/components/Controls";

type View = "gainers" | "losers" | "newSkus" | "lostSkus";
type CatDim = "type" | "team" | "brand";

// API satırı (comparePeriods → PeriodCompare). Sayfanın ZATEN çektiği veri.
// CsvBtn'in `Record<string, unknown>` kısıtını sağlamak için index imzası eklenir.
type Row = {
  sku_name: string;
  retailer: string;
  a_qty: number;
  b_qty: number;
  delta: number;
  delta_pct: number | null;
  [k: string]: unknown;
};

export default function ComparePage() {
  const [retailer, setRetailer] = useState("DR");
  const [weeks, setWeeks] = useState<string[]>([]);
  const [weekA, setWeekA] = useState("");
  const [weekB, setWeekB] = useState("");
  const [data, setData] = useState<any>(null);
  const [loading, setLoading] = useState(false);
  const [view, setView] = useState<View>("gainers");
  const [err, setErr] = useState("");

  // İstemci-tarafı analiz kontrolleri (hepsi ZATEN çekilen veri üzerinde çalışır)
  const [search, setSearch] = useState("");
  const [minAbs, setMinAbs] = useState(0); // min |değişim|
  const [catDim, setCatDim] = useState<CatDim>("type");
  const [cats, setCats] = useState<string[]>([]); // seçili kategoriler (boş = tümü)

  // Hafta listesini yükle
  useEffect(() => {
    // Yarış koşulu guard'ı: hızlı perakendeci değişiminde eski yanıt yeniyi ezmesin.
    let active = true;
    setErr("");
    fetchJson(`/api/compare?retailer=${encodeURIComponent(retailer)}`)
      .then((d) => {
        if (!active) return;
        const w = d.weeks ?? [];
        setWeeks(w);
        if (w.length >= 2) { setWeekB(w[0]); setWeekA(w[1]); }
        else { setWeekA(""); setWeekB(""); setData(null); }
      })
      .catch((e) => {
        if (!active) return;
        // Hata: hafta listesini güvenli boş default'a çek ki render çökmesin
        setErr(e.message);
        setWeeks([]); setWeekA(""); setWeekB(""); setData(null);
      });
    return () => { active = false; };
  }, [retailer]);

  // Karşılaştır
  useEffect(() => {
    if (!weekA || !weekB || weekA === weekB) { setData(null); return; }
    // Yarış koşulu guard'ı: hızlı hafta değişiminde eski yanıt yeniyi ezmesin.
    let active = true;
    setLoading(true);
    setErr("");
    setData(null); // Perakendeci/hafta değişince eski veri ekranda kalmasın
    fetchJson(`/api/compare?retailer=${encodeURIComponent(retailer)}&a=${weekA}&b=${weekB}`)
      .then((d) => { if (active) setData(d); })
      .catch((e) => {
        if (!active) return;
        // Hata: karşılaştırma verisini güvenli boş default'a çek
        setErr(e.message);
        setData(null);
      })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [retailer, weekA, weekB]);

  // Perakendeci/hafta değişince istemci filtreleri kullanıcıyı şaşırtmasın diye sıfırlanır.
  useEffect(() => { setSearch(""); setMinAbs(0); setCats([]); }, [retailer, weekA, weekB, view]);

  // Üst özet: TÜM veri üzerinden (filtreden bağımsız) liste boyları.
  const counts = {
    gainers: (data?.gainers as Row[] | undefined)?.length ?? 0,
    losers: (data?.losers as Row[] | undefined)?.length ?? 0,
    newSkus: (data?.newSkus as Row[] | undefined)?.length ?? 0,
    lostSkus: (data?.lostSkus as Row[] | undefined)?.length ?? 0,
  };

  // Aktif görünümün ham satırları (API'nin döndürdüğü hâliyle).
  const baseRows = (data?.[view] as Row[] | undefined) ?? [];

  // Aktif görünümde mevcut kategori değerleri (chip seçenekleri) — seçilen boyuta göre.
  const catOptions = useMemo(() => {
    const set = new Set<string>();
    for (const r of baseRows) set.add(parseProductMeta(r?.sku_name ?? "")[catDim]);
    return [...set].sort((a, b) => a.localeCompare(b, "tr"));
  }, [baseRows, catDim]);

  // İstemci-tarafı filtre: ürün arama + min |değişim| + kategori.
  const filtered = useMemo(() => {
    const q = search.trim().toLocaleLowerCase("tr");
    const catSet = new Set(cats);
    return baseRows.filter((r) => {
      const name = r?.sku_name ?? "";
      if (q && !name.toLocaleLowerCase("tr").includes(q)) return false;
      if (Math.abs(r?.delta ?? 0) < minAbs) return false;
      if (catSet.size > 0 && !catSet.has(parseProductMeta(name)[catDim])) return false;
      return true;
    });
  }, [baseRows, search, minAbs, cats, catDim]);

  // Kolon sıralama (önceki/şimdi/değişim/%); varsayılan |değişim| büyük → üstte değil,
  // API zaten delta'ya göre sıralı geldiği için başlangıçta sırasız (API sırası korunur).
  const { sorted, sortKey, dir, toggle } = useSort<Row>(filtered);

  // Görünen (filtreli) satırların özeti — A/B toplamı ve net fark. Bu, üstteki
  // adet kartlarından farklı olarak SADECE ekranda görünen kayıtları yansıtır.
  const viewSummary = useMemo(() => {
    let sumA = 0, sumB = 0;
    for (const r of filtered) { sumA += r?.a_qty ?? 0; sumB += r?.b_qty ?? 0; }
    return { count: filtered.length, sumA, sumB, net: sumB - sumA };
  }, [filtered]);

  // Filtreli görünümün seçili boyuttaki (tip/takım/marka) kırılımı — net farka
  // göre. Değişimin hangi kategoride yoğunlaştığını küçük çubuklarla gösterir.
  const catBreakdown = useMemo(() => {
    const m = new Map<string, { a: number; b: number; n: number }>();
    for (const r of filtered) {
      const k = parseProductMeta(r?.sku_name ?? "")[catDim];
      const e = m.get(k) ?? { a: 0, b: 0, n: 0 };
      e.a += r?.a_qty ?? 0; e.b += r?.b_qty ?? 0; e.n += 1;
      m.set(k, e);
    }
    return [...m.entries()]
      .map(([key, e]) => ({ key, a: e.a, b: e.b, net: e.b - e.a, n: e.n }))
      .sort((x, y) => Math.abs(y.net) - Math.abs(x.net));
  }, [filtered, catDim]);

  // Aktif istemci-filtre sayısı (arama + min |değişim| + kategori seçimi).
  const activeFilters = (search.trim() ? 1 : 0) + (minAbs > 0 ? 1 : 0) + cats.length;
  const clearFilters = () => { setSearch(""); setMinAbs(0); setCats([]); };

  const views: { id: View; label: string }[] = [
    { id: "gainers", label: `📈 Artanlar (${counts.gainers})` },
    { id: "losers", label: `📉 Azalanlar (${counts.losers})` },
    { id: "newSkus", label: `✨ Yeni Çıkanlar (${counts.newSkus})` },
    { id: "lostSkus", label: `⊘ Kaybolanlar (${counts.lostSkus})` },
  ];

  const catDims: { id: CatDim; label: string }[] = [
    { id: "type", label: "Ürün Tipi" },
    { id: "team", label: "Takım" },
    { id: "brand", label: "Marka" },
  ];

  const ready = !err && weeks.length >= 2 && weekA !== weekB;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">Dönem <span className="neon-text">Karşılaştırma</span></h1>
        <p className="text-txt-dim mono text-sm mt-1">İki haftayı SKU bazında yan yana karşılaştır</p>
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
          <label className="mono text-xs text-txt-dim block mb-1">Baz hafta (A)</label>
          <select value={weekA} onChange={(e) => setWeekA(e.target.value)}
            className="card mono text-sm px-3 py-2 bg-ink-2 outline-none focus:border-neon">
            {weeks.map((w) => <option key={w} value={w} className="bg-ink-2">{fmtDate(w)}</option>)}
          </select>
        </div>
        <div className="mono text-txt-dim pb-2">→</div>
        <div>
          <label className="mono text-xs text-txt-dim block mb-1">Karşılaştırılan (B)</label>
          <select value={weekB} onChange={(e) => setWeekB(e.target.value)}
            className="card mono text-sm px-3 py-2 bg-ink-2 outline-none focus:border-neon">
            {weeks.map((w) => <option key={w} value={w} className="bg-ink-2">{fmtDate(w)}</option>)}
          </select>
        </div>
        {ready && data && (
          <div className="ml-auto self-end">
            <CsvBtn
              filename={`cortex-karsilastirma-${view}`}
              rows={sorted}
              cols={[
                { key: "sku_name", label: "Ürün" }, { key: "retailer", label: "Perakendeci" },
                { key: "a_qty", label: "A" }, { key: "b_qty", label: "B" },
                { key: "delta", label: "Fark" }, { key: "delta_pct", label: "Fark %" },
              ]}
            />
          </div>
        )}
      </div>

      {err && <div className="card p-4 border-red-500/40 text-red-400 mono text-sm">Veri alınamadı: {err}</div>}

      {err ? null : weeks.length < 2 ? (
        <div className="card p-10 text-center mono text-txt-dim">{retailer} için karşılaştırma yapacak en az 2 hafta yok.</div>
      ) : weekA === weekB ? (
        <div className="card p-10 text-center mono text-txt-dim">Farklı iki hafta seç.</div>
      ) : (
        <>
          {/* Üst özet — TÜM veri üzerinden adetler (filtreden bağımsız) */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <StatCard label="ARTAN SKU" value={fmtInt(counts.gainers)} color="#1FF80B" sub={`${fmtDate(weekA)} → ${fmtDate(weekB)}`} />
            <StatCard label="AZALAN SKU" value={fmtInt(counts.losers)} color="#f87171" sub="satış geriledi" />
            <StatCard label="YENİ ÇIKAN" value={fmtInt(counts.newSkus)} color="#0bd1f8" sub="B'de var, A'da yok" />
            <StatCard label="KAYBOLAN" value={fmtInt(counts.lostSkus)} color="#f8b00b" sub="A'da var, B'de yok" />
          </div>

          <SegTabs tabs={views} active={view} onChange={setView} />

          {loading ? (
            <div className="card p-10 text-center mono text-txt-dim animate-pulse">Yükleniyor…</div>
          ) : (
            <>
              {/* İstemci-tarafı analiz kontrolleri */}
              <div className="card p-4 space-y-3">
                <div className="flex flex-wrap items-center gap-4">
                  <div className="flex-1 min-w-48">
                    <SearchBox value={search} onChange={setSearch} placeholder="🔍 ürün ara…" />
                  </div>
                  <RangeMin label="min |değişim|" value={minAbs} onChange={setMinAbs} suffix="adet" step={5} />
                  {activeFilters > 0 && (
                    <button
                      type="button"
                      onClick={clearFilters}
                      className="mono text-[11px] text-txt-dim hover:text-neon transition-colors"
                    >
                      ✕ filtreleri temizle ({activeFilters})
                    </button>
                  )}
                </div>
                <div className="flex flex-wrap items-center gap-3">
                  <SegTabs
                    tabs={catDims}
                    active={catDim}
                    onChange={(d) => { setCatDim(d); setCats([]); }}
                  />
                  <div className="flex-1 min-w-48">
                    <MultiChips
                      label="kategori:"
                      options={catOptions}
                      selected={cats}
                      onToggle={(c) => setCats((prev) => prev.includes(c) ? prev.filter((x) => x !== c) : [...prev, c])}
                      onAll={() => setCats(catOptions)}
                      onNone={() => setCats([])}
                    />
                  </div>
                </div>
              </div>

              {/* Kategori kırılımı — filtreli görünümün net farkı, seçili boyuta göre */}
              <div className="card p-6">
                <div className="flex items-center justify-between mb-3 flex-wrap gap-2">
                  <h2 className="mono text-sm text-txt-dim">
                    {catDims.find((d) => d.id === catDim)?.label} kırılımı · net fark
                  </h2>
                  <span className="mono text-xs text-txt-dim">{fmtInt(catBreakdown.length)} kategori</span>
                </div>
                {catBreakdown.length === 0 ? (
                  <div className="mono text-sm text-txt-dim text-center py-4">
                    {baseRows.length === 0 ? "Bu görünümde değişim yok" : "Filtreye uyan kategori yok"}
                  </div>
                ) : (
                  <CompareBars items={catBreakdown} />
                )}
              </div>

              <div className="card p-6 overflow-x-auto">
                <div className="flex items-center justify-between mb-3 flex-wrap gap-x-4 gap-y-2">
                  <div className="mono text-xs text-txt-dim">
                    {fmtInt(sorted.length)} / {fmtInt(baseRows.length)} kayıt
                    {sorted.length !== baseRows.length ? " (filtreli)" : ""}
                  </div>
                  {viewSummary.count > 0 && (
                    <div className="mono text-xs text-txt-dim flex items-center gap-3 flex-wrap">
                      <span>Σ {fmtDate(weekA)}: <span className="text-txt">{fmtInt(viewSummary.sumA)}</span></span>
                      <span>Σ {fmtDate(weekB)}: <span className="text-txt">{fmtInt(viewSummary.sumB)}</span></span>
                      <span>
                        net fark:{" "}
                        <span className={viewSummary.net >= 0 ? "text-neon" : "text-red-400"}>
                          {viewSummary.net >= 0 ? "+" : ""}{fmtInt(viewSummary.net)}
                        </span>
                      </span>
                    </div>
                  )}
                </div>
                <table>
                  <thead>
                    <tr>
                      <th>Ürün</th>
                      <th>Perakendeci</th>
                      <SortableTh label={fmtDate(weekA)} sortKey="a_qty" active={sortKey === "a_qty"} dir={dir} onClick={toggle} align="right" />
                      <SortableTh label={fmtDate(weekB)} sortKey="b_qty" active={sortKey === "b_qty"} dir={dir} onClick={toggle} align="right" />
                      <SortableTh label="Fark" sortKey="delta" active={sortKey === "delta"} dir={dir} onClick={toggle} align="right" />
                      <SortableTh label="%" sortKey="delta_pct" active={sortKey === "delta_pct"} dir={dir} onClick={toggle} align="right" />
                    </tr>
                  </thead>
                  <tbody>
                    {sorted.map((r, i) => (
                      <motion.tr key={`${r.retailer}|${r.sku_name}|${i}`} initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: Math.min(i, 20) * 0.02 }}>
                        <td className="max-w-xs truncate" title={r?.sku_name}>{r?.sku_name ?? "—"}</td>
                        <td className="mono text-xs" style={{ color: colorOf(r?.retailer ?? "") }}>{r?.retailer ?? "—"}</td>
                        <td className="mono text-right">{fmtInt(r?.a_qty ?? 0)}</td>
                        <td className="mono text-right">{fmtInt(r?.b_qty ?? 0)}</td>
                        <td className={`mono text-right ${(r?.delta ?? 0) >= 0 ? "text-neon" : "text-red-400"}`}>{(r?.delta ?? 0) >= 0 ? "+" : ""}{fmtInt(r?.delta ?? 0)}</td>
                        <td className={`mono text-right ${(r?.delta_pct ?? 0) >= 0 ? "text-neon" : "text-red-400"}`}>{r?.delta_pct != null ? fmtPct(r.delta_pct) : "yeni"}</td>
                      </motion.tr>
                    ))}
                  </tbody>
                </table>
                {sorted.length === 0 && (
                  <div className="mono text-sm text-txt-dim text-center py-6">
                    {baseRows.length === 0
                      ? "Bu kategoride değişim yok"
                      : "Filtreye uyan kayıt yok — arama / min değişim / kategori filtrelerini gevşet"}
                  </div>
                )}
              </div>
            </>
          )}
        </>
      )}
    </div>
  );
}

// Kategori net-fark çubukları — pozitif (artış) neon yeşil, negatif (azalış) kırmızı.
// Genişlik |net| / en yüksek |net| oranında; rankings'teki CategoryBars ile aynı stil.
function CompareBars({ items }: { items: { key: string; a: number; b: number; net: number; n: number }[] }) {
  const max = Math.max(...items.map((i) => Math.abs(i.net)), 1);
  return (
    <div className="space-y-2">
      {items.map((it, i) => {
        const up = it.net >= 0;
        return (
          <motion.div key={it.key} initial={{ opacity: 0, x: -8 }} animate={{ opacity: 1, x: 0 }} transition={{ delay: Math.min(i * 0.03, 0.4) }}>
            <div className="flex justify-between text-sm mb-1">
              <span className="font-medium">{it.key}</span>
              <span className="mono text-txt-dim">
                {it.n} SKU ·{" "}
                <span className={up ? "text-neon" : "text-red-400"}>{up ? "+" : ""}{fmtInt(it.net)}</span>
              </span>
            </div>
            <div className="h-2.5 rounded-full bg-ink-3 overflow-hidden">
              <motion.div
                className={`h-full rounded-full ${up ? "bg-neon" : "bg-red-400"}`}
                initial={{ width: 0 }}
                animate={{ width: `${(Math.abs(it.net) / max) * 100}%` }}
                transition={{ delay: Math.min(i * 0.03, 0.4) + 0.1, duration: 0.5 }}
              />
            </div>
          </motion.div>
        );
      })}
    </div>
  );
}
