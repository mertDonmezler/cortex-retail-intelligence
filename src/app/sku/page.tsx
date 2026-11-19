"use client";

import { useEffect, useMemo, useState } from "react";
import { RETAILERS, fmtInt, fmtMoney, fmtDate, colorOf } from "@/lib/format";
import { parseProductMeta } from "@/lib/compute";
import {
  SortableTh, SearchBox, MultiChips, RangeMin, CsvBtn, StatCard, useSort,
} from "@/components/Controls";
import { Info } from "@/components/Info";
import { fetchJson } from "@/lib/fetchJson";
import { bekleme } from "@/lib/hareket";

// Birim değer kolonlarının ne OLDUĞUNU tek yerden anlatan açıklamalar. Eski
// "Ort. Fiyat" etiketi yanıltıcıydı: gösterilen sayı net kazançtan türetiliyor,
// yani raf fiyatı değil bize kalan birim (₺99,99 raflı ürün ekranda ₺41,66).
const NET_UNIT_HELP =
  "Raf fiyatı DEĞİL: net kazanç ÷ satılan adet. Kanal marjı ve KDV düşüldükten " +
  "sonra bir adetten bize kalan tutar. Yanındaki 'Brüt PSF' kolonu raf tarafını gösterir.";
const GROSS_UNIT_HELP =
  "Brüt birim (PSF): perakendecinin bildirdiği satış tutarı ÷ adet — raf fiyatı " +
  "tarafı. Bize kalan kısım için 'Ort. Net Birim' kolonuna bakın.";

// SKU satırı: API'nin (sku-detail) zaten döndürdüğü şekil. Burada ek alan
// (brand/team/type) yalnızca İSTEMCİDE türetilir; yeni veri çekilmez.
// `type` (interface değil) → CsvBtn'in Record<string, unknown> kısıtını karşılar.
type SkuRow = {
  sku_name: string;
  sales_qty: number;
  sales_value: number;
  stock_qty: number;
  avg_net_unit: number | null;   // net kazanç / adet (bize kalan)
  avg_gross_unit: number | null; // brüt PSF / adet (raf tarafı)
};
// İsim ayrıştırmasıyla zenginleştirilmiş satır (filtre/sıralama/CSV bunu kullanır).
type SkuRowMeta = SkuRow & {
  brand: string;
  team: string;
  type: string;
};

export default function SkuPage() {
  const [retailer, setRetailer] = useState(RETAILERS[0]);
  const [week, setWeek] = useState<string>("");
  const [weeks, setWeeks] = useState<string[]>([]);
  const [skus, setSkus] = useState<SkuRow[]>([]);
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState("");

  // İstemci-tarafı filtreler (hepsi mevcut veri üzerinde çalışır).
  const [brands, setBrands] = useState<string[]>([]);
  const [teams, setTeams] = useState<string[]>([]);
  const [types, setTypes] = useState<string[]>([]);
  const [minSales, setMinSales] = useState(0);

  // Veri çekme akışı KORUNDU: aynı endpoint, aynı state'ler. Tek ekleme: yarış
  // koşulunu önlemek için `active` bayrağı (hızlı perakendeci/hafta değişiminde
  // eski yanıtın yeni veriyi ezmesini engeller).
  useEffect(() => {
    setLoading(true);
    setErr("");
    const q = week ? `&week=${week}` : "";
    let active = true;
    fetchJson(`/api/sku-detail?retailer=${encodeURIComponent(retailer)}${q}`)
      .then((d: any) => {
        if (!active) return;
        setSkus((d?.skus ?? []) as SkuRow[]);
        setWeeks(d?.weeks ?? []);
        if (d?.week && !week) setWeek(d.week);
      })
      .catch((e: any) => {
        if (!active) return;
        // hata: state'leri güvenli boş default'a çek ki render çökmesin
        setErr(e?.message ?? "Bilinmeyen hata");
        setSkus([]);
      })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [retailer, week]);

  // perakendeci değişince haftayı sıfırla
  useEffect(() => { setWeek(""); }, [retailer]);

  // Veri değişince ürün adından marka/takım/tip türet (tek geçiş, memoize).
  const enriched: SkuRowMeta[] = useMemo(
    () =>
      (skus ?? []).map((s) => {
        const m = parseProductMeta(s?.sku_name ?? "");
        return { ...s, brand: m.brand, team: m.team, type: m.type };
      }),
    [skus]
  );

  // Filtre seçenekleri: yalnızca bu veride GERÇEKTEN bulunan değerler, satışa göre.
  const brandOpts = useMemo(() => distinctByVolume(enriched, "brand"), [enriched]);
  const teamOpts = useMemo(() => distinctByVolume(enriched, "team"), [enriched]);
  const typeOpts = useMemo(() => distinctByVolume(enriched, "type"), [enriched]);

  // Veri seti değişince geçersiz kalan seçimleri ayıkla (örn. perakendeci/hafta
  // değişti, eski marka artık yok). Boş = "tümü" anlamına gelir.
  useEffect(() => { setBrands((p) => p.filter((b) => brandOpts.includes(b))); }, [brandOpts]);
  useEffect(() => { setTeams((p) => p.filter((t) => teamOpts.includes(t))); }, [teamOpts]);
  useEffect(() => { setTypes((p) => p.filter((t) => typeOpts.includes(t))); }, [typeOpts]);

  // Arama + chip filtreleri + min satış — hepsi istemcide, sıralı uygulanır.
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    const bSet = new Set(brands), tSet = new Set(teams), pSet = new Set(types);
    return enriched.filter((s) => {
      if (q && !(s.sku_name ?? "").toLowerCase().includes(q)) return false;
      if (bSet.size && !bSet.has(s.brand)) return false;
      if (tSet.size && !tSet.has(s.team)) return false;
      if (pSet.size && !pSet.has(s.type)) return false;
      if ((s.sales_qty ?? 0) < minSales) return false;
      return true;
    });
  }, [enriched, search, brands, teams, types, minSales]);

  // Kolon sıralama (satış / ciro / stok / ort. fiyat / ürün). Varsayılan: satış ↓.
  const { sorted, sortKey, dir, toggle } = useSort<SkuRowMeta>(filtered, "sales_qty", "desc");

  // Filtrelenmiş küme üzerinden KPI'lar (görünen neyse onun özeti).
  const totals = useMemo(() => {
    let qty = 0, val = 0, stock = 0;
    for (const s of filtered) { qty += s.sales_qty ?? 0; val += s.sales_value ?? 0; stock += s.stock_qty ?? 0; }
    return { qty, val, stock, count: filtered.length };
  }, [filtered]);

  const activeFilters = brands.length + teams.length + types.length + (minSales > 0 ? 1 : 0);
  const rc = colorOf(retailer);

  return (
    <div className="space-y-6">
      <div className="flex items-end justify-between flex-wrap gap-4">
        <h1 className="text-3xl font-bold tracking-tight">
          SKU <span className="neon-text">Detay</span>
        </h1>
        <CsvBtn
          filename={`cortex-sku-${retailer}-${week || "guncel"}`}
          rows={sorted}
          cols={[
            { key: "sku_name", label: "Ürün" },
            { key: "brand", label: "Marka" },
            { key: "team", label: "Takım" },
            { key: "type", label: "Tip" },
            { key: "sales_qty", label: "Satış" },
            { key: "sales_value", label: "NetKazanç TL" },
            { key: "stock_qty", label: "Stok" },
            { key: "avg_net_unit", label: "Ort.NetBirim TL" },
            { key: "avg_gross_unit", label: "Ort.BrütPSF TL" },
          ]}
          label="⬇ CSV indir"
        />
      </div>

      {/* Seçiciler — KORUNDU (perakendeci + hafta) + stilli arama kutusu. */}
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
          <SearchBox value={search} onChange={setSearch} placeholder="🔍 ürün adı…" />
        </div>
        <RangeMin label="min satış" value={minSales} onChange={setMinSales} suffix="adet" step={5} />
      </div>

      {/* Marka / Takım / Tip chip filtreleri — yalnızca veride bulunan değerler. */}
      {!err && enriched.length > 0 && (
        <div className="card p-4 space-y-3 cx-soluk" {...bekleme(loading)}>
          {brandOpts.length > 1 && (
            <MultiChips label="Marka:" options={brandOpts} selected={brands}
              onToggle={(o) => toggleIn(setBrands, o)}
              onNone={brands.length ? () => setBrands([]) : undefined} />
          )}
          {teamOpts.length > 1 && (
            <MultiChips label="Takım:" options={teamOpts} selected={teams}
              onToggle={(o) => toggleIn(setTeams, o)}
              onNone={teams.length ? () => setTeams([]) : undefined} />
          )}
          {typeOpts.length > 1 && (
            <MultiChips label="Tip:" options={typeOpts} selected={types}
              onToggle={(o) => toggleIn(setTypes, o)}
              onNone={types.length ? () => setTypes([]) : undefined} />
          )}
          {activeFilters > 0 && (
            <button type="button"
              onClick={() => { setBrands([]); setTeams([]); setTypes([]); setMinSales(0); }}
              className="mono text-[11px] text-txt-dim hover:text-neon hover:transition-colors">
              ✕ filtreleri temizle ({activeFilters})
            </button>
          )}
        </div>
      )}

      {/* Filtrelenen kümenin KPI özeti. */}
      {!err && enriched.length > 0 && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4 cx-soluk" {...bekleme(loading)}>
          <StatCard label="GÖRÜNEN SKU" value={fmtInt(totals.count)}
            sub={`/ ${fmtInt(enriched.length)} toplam`} color={rc} />
          <StatCard label="TOPLAM SATIŞ" value={fmtInt(totals.qty)} sub="adet" />
          {/* "CİRO" değil: gösterilen tutar marj + KDV düşülmüş NET kazanç. */}
          <StatCard label="NET KAZANÇ" value={fmtMoney(totals.val)} sub="marj+KDV düşülmüş" />
          <StatCard label="TOPLAM STOK" value={fmtInt(totals.stock)} sub="adet" />
        </div>
      )}

      {err && (
        <div className="card p-4 border-red-500/40 text-red-400 mono text-sm">
          Veri alınamadı: {err}
        </div>
      )}

      <div className="card p-6 cx-soluk" {...bekleme(loading && enriched.length > 0)}>
        {loading && enriched.length === 0 ? (
          <div className="mono text-txt-dim py-6 text-center">Yükleniyor…</div>
        ) : err ? (
          <div className="mono text-txt-dim py-6 text-center">Sunucu hatası nedeniyle veri gösterilemiyor.</div>
        ) : enriched.length === 0 ? (
          <div className="mono text-txt-dim py-6 text-center">Bu perakendeci/hafta için kayıt bulunamadı.</div>
        ) : sorted.length === 0 ? (
          <div className="mono text-txt-dim py-6 text-center">
            Filtrelere uyan SKU yok. Arama/filtre koşullarını gevşetmeyi deneyin.
          </div>
        ) : (
          <>
            <div className="overflow-x-auto">
              <table>
                <thead>
                  <tr>
                    <SortableTh label="Ürün" sortKey="sku_name" active={sortKey === "sku_name"} dir={dir} onClick={toggle} />
                    <SortableTh label="Marka" sortKey="brand" active={sortKey === "brand"} dir={dir} onClick={toggle} />
                    <SortableTh label="Tip" sortKey="type" active={sortKey === "type"} dir={dir} onClick={toggle} />
                    <SortableTh label="Satış" sortKey="sales_qty" active={sortKey === "sales_qty"} dir={dir} onClick={toggle} align="right" />
                    <SortableTh label="Net TL" sortKey="sales_value" active={sortKey === "sales_value"} dir={dir} onClick={toggle} align="right" />
                    <SortableTh label="Stok" sortKey="stock_qty" active={sortKey === "stock_qty"} dir={dir} onClick={toggle} align="right" />
                    {/* Etiket dürüstlüğü: bu kolon raf fiyatı değil, birim NET kazanç.
                        Açıklama `label` içine gömülü ⓘ ile verilir (SortableTh
                        ReactNode kabul ediyor → paylaşılan bileşene dokunmak gerekmez). */}
                    <SortableTh label={<>Ort. Net Birim<Info text={NET_UNIT_HELP} /></>}
                      sortKey="avg_net_unit" active={sortKey === "avg_net_unit"} dir={dir} onClick={toggle} align="right" />
                    <SortableTh label={<>Ort. Brüt PSF<Info text={GROSS_UNIT_HELP} /></>}
                      sortKey="avg_gross_unit" active={sortKey === "avg_gross_unit"} dir={dir} onClick={toggle} align="right" />
                  </tr>
                </thead>
                <tbody>
                  {sorted.map((s, i) => (
                    <tr key={s.sku_name + i}>
                      <td>{s?.sku_name ?? "—"}</td>
                      <td className="mono text-txt-dim">{s.brand}</td>
                      <td className="mono text-txt-dim">{s.type}</td>
                      <td className="mono text-right">{fmtInt(s?.sales_qty ?? 0)}</td>
                      <td className="mono text-right">{(s?.sales_value ?? 0) > 0 ? fmtMoney(s.sales_value) : "—"}</td>
                      <td className="mono text-right">{fmtInt(s?.stock_qty ?? 0)}</td>
                      <td className="mono text-right">{s?.avg_net_unit ? fmtMoney(s.avg_net_unit) : "—"}</td>
                      <td className="mono text-right text-txt-dim">{s?.avg_gross_unit ? fmtMoney(s.avg_gross_unit) : "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="mono text-xs text-txt-dim mt-3">
              {fmtInt(sorted.length)} / {fmtInt(enriched.length)} SKU
              {activeFilters > 0 ? " (filtreli)" : ""}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

// ── İstemci-tarafı küçük yardımcılar (paylaşılan dosyalara dokunmadan) ──

// Bir boyutun (brand/team/type) veride bulunan değerlerini SATIŞ HACMİNE göre
// sıralı, benzersiz liste olarak döndür — chip sırası "en çok satan önce".
function distinctByVolume(rows: SkuRowMeta[], dim: "brand" | "team" | "type"): string[] {
  const m = new Map<string, number>();
  for (const r of rows) {
    const k = r[dim];
    m.set(k, (m.get(k) ?? 0) + (r.sales_qty ?? 0));
  }
  return [...m.entries()].sort((a, b) => b[1] - a[1]).map(([k]) => k);
}

// Bir string'i çoklu-seçim diziye ekle/çıkar (immutable toggle).
function toggleIn(set: React.Dispatch<React.SetStateAction<string[]>>, opt: string): void {
  set((prev) => (prev.includes(opt) ? prev.filter((x) => x !== opt) : [...prev, opt]));
}
