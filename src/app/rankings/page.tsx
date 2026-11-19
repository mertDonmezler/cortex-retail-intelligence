"use client";

import { useEffect, useMemo, useState } from "react";
import { fmtInt, fmtMoney, fmtPct, fmtDate, RETAILER_COLORS, colorOf } from "@/lib/format";
import { fetchJson } from "@/lib/fetchJson";
import { bekleme } from "@/lib/hareket";
import { parseProductMeta, sonTamamlanmisHafta } from "@/lib/compute";
import {
  SortableTh,
  SearchBox,
  MultiChips,
  SegTabs,
  RangeMin,
  StatCard,
  CsvBtn,
  useSort,
} from "@/components/Controls";
import { Info } from "@/components/Info";

// Bu sayfanın listeleri KESİLMİŞ alt kümelerdir; KPI'lar ağ toplamı değildir.
const SUBSET_HELP =
  "Bu kart yalnızca ekrandaki listenin toplamıdır — ağın hafta toplamı değil. " +
  "Liste kısaltılmış: 'En çok satan' ilk 20, 'Yükselen/Düşen' ilk 15 ürün. " +
  "Alt satırdaki yüzde, bu toplamın ağın hafta genelindeki net kazancına oranıdır. " +
  "Ağın tamamı için Kontrol Paneli'ne bakın.";

const COLORS = RETAILER_COLORS;

type Tab = "top" | "risers" | "fallers" | "categories";
type CatDim = "brand" | "team" | "type";

// API'nin döndüğü ranked satır şekli (compute.ts → RankedSku). Sayfa ZATEN bunu
// çekiyor; aşağıdaki tüm filtre/sıralama bu mevcut veri üzerinde, istemci tarafında.
interface Row {
  sku_name: string;
  retailers: string[];
  barkod: string | null;
  sales_qty: number;
  sales_value: number;
  stock_qty: number;
  prev_qty: number;
  prev_val: number;
  growth: number | null;
}
// Filtre/sıralama için ürün meta (marka/takım/tip) ile zenginleştirilmiş satır.
type EnrichedRow = Row & { brand: string; team: string; type: string };

interface CatRow { key: string; sales_qty: number; sales_value: number; sku_count: number }

const CAT_DIMS: { id: CatDim; label: string }[] = [
  { id: "team", label: "Takım" },
  { id: "brand", label: "Marka" },
  { id: "type", label: "Ürün Tipi" },
];
const catLabel = (d: CatDim) => (d === "team" ? "Takım" : d === "brand" ? "Marka" : "Tip");

export default function RankingsPage() {
  const [data, setData] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [weeks, setWeeks] = useState<string[]>([]);
  // "güncel hafta" ifadesinin çapası — takvime bağlı, hafta seçicisinden bağımsız.
  const takvimHaftasi = useMemo(() => sonTamamlanmisHafta(new Date()), []);
  const [week, setWeek] = useState<string>(""); // "" = en güncel hafta
  const [tab, setTab] = useState<Tab>("top");
  const [catDim, setCatDim] = useState<CatDim>("team");
  const [metric, setMetric] = useState<"value" | "qty">("value"); // büyüme bazı — varsayılan ciro

  // ───────── İSTEMCİ-TARAFI filtre state'i (çekilen veri üzerinde çalışır) ─────────
  const [search, setSearch] = useState("");
  const [selRetailers, setSelRetailers] = useState<string[]>([]); // [] = filtre yok (tümü)
  const [selBrands, setSelBrands] = useState<string[]>([]);
  const [selTeams, setSelTeams] = useState<string[]>([]);
  const [selTypes, setSelTypes] = useState<string[]>([]);
  const [minSales, setMinSales] = useState(0);
  const [catSearch, setCatSearch] = useState("");

  // Ekrandaki listenin hafta|metrik anahtarı — hafta ya da metrik değişince
  // eski liste yerinde soluk durur, sayfa boşalıp yeniden dolmaz.
  const [veriAnahtari, setVeriAnahtari] = useState<string | null>(null);
  useEffect(() => {
    let iptal = false;
    const k = `${week}|${metric}`;
    setLoading(true);
    const params = new URLSearchParams();
    if (week) params.set("week", week);
    params.set("metric", metric);
    fetchJson(`/api/rankings?${params.toString()}`)
      .then((d) => { if (iptal) return; setData(d); setWeeks(d?.weeks ?? []); setVeriAnahtari(k); setErr(null); })
      .catch((e) => { if (iptal) return; setErr(e.message); setData(null); setVeriAnahtari(null); }) // hatada veriyi sıfırla; render güvenli default'lara düşer
      .finally(() => { if (!iptal) setLoading(false); });
    return () => { iptal = true; };
  }, [week, metric]);
  const bekliyor = data != null && veriAnahtari !== `${week}|${metric}`;

  const tabs: { id: Tab; label: string }[] = [
    { id: "top", label: "🏆 En Çok Satan" },
    { id: "risers", label: "📈 Yükselenler" },
    { id: "fallers", label: "📉 Düşenler" },
    { id: "categories", label: "🗂 Kategoriler" },
  ];
  const isList = tab !== "categories";

  // Aktif sekmenin ham satırları (top/risers/fallers) — ürün meta ile zenginleştir.
  const baseRows: EnrichedRow[] = useMemo(() => {
    if (!isList) return [];
    const raw: Row[] = data?.[tab] ?? [];
    return raw.map((r) => ({ ...r, ...parseProductMeta(r.sku_name) }));
  }, [data, tab, isList]);

  // Çekilen tüm satırlardan seçenek havuzları (sekme bağımsız — tutarlı chip'ler).
  const { retailerOpts, brandOpts, teamOpts, typeOpts } = useMemo(() => {
    const rs = new Set<string>(), bs = new Set<string>(), ts = new Set<string>(), tps = new Set<string>();
    for (const key of ["top", "risers", "fallers"] as const) {
      for (const r of (data?.[key] ?? []) as Row[]) {
        for (const rt of r.retailers ?? []) rs.add(rt);
        const m = parseProductMeta(r.sku_name);
        bs.add(m.brand); ts.add(m.team); tps.add(m.type);
      }
    }
    const sortTr = (a: string, b: string) => a.localeCompare(b, "tr");
    return {
      retailerOpts: [...rs].sort(sortTr),
      brandOpts: [...bs].sort(sortTr),
      teamOpts: [...ts].sort(sortTr),
      typeOpts: [...tps].sort(sortTr),
    };
  }, [data]);

  // Filtre uygula (boş seçim = "tümü"). Arama ürün adı + barkod üzerinde.
  const filtered: EnrichedRow[] = useMemo(() => {
    const q = search.trim().toLocaleLowerCase("tr-TR");
    const retSet = new Set(selRetailers), brSet = new Set(selBrands), tmSet = new Set(selTeams), tpSet = new Set(selTypes);
    return baseRows.filter((r) => {
      if (retSet.size && !(r.retailers ?? []).some((rt) => retSet.has(rt))) return false;
      if (brSet.size && !brSet.has(r.brand)) return false;
      if (tmSet.size && !tmSet.has(r.team)) return false;
      if (tpSet.size && !tpSet.has(r.type)) return false;
      if (r.sales_qty < minSales) return false;
      if (q) {
        const hay = (r.sku_name + " " + (r.barkod ?? "")).toLocaleLowerCase("tr-TR");
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [baseRows, search, selRetailers, selBrands, selTeams, selTypes, minSales]);

  // Kolon sıralama — varsayılan satışa göre azalan (mevcut davranışla aynı).
  const { sorted, sortKey, dir, toggle } = useSort<EnrichedRow>(filtered, "sales_qty", "desc");

  const activeFilters =
    selRetailers.length + selBrands.length + selTeams.length + selTypes.length + (minSales > 0 ? 1 : 0) + (search.trim() ? 1 : 0);
  function clearFilters() {
    setSelRetailers([]); setSelBrands([]); setSelTeams([]); setSelTypes([]); setMinSales(0); setSearch("");
  }

  // ───────── Kategoriler sekmesi (server'da firma genelinde toplanmış) ─────────
  const catRows: CatRow[] = useMemo(() => {
    const arr: CatRow[] = data?.categories?.[catDim] ?? [];
    const q = catSearch.trim().toLocaleLowerCase("tr-TR");
    return q ? arr.filter((c) => c.key.toLocaleLowerCase("tr-TR").includes(q)) : arr;
  }, [data, catDim, catSearch]);
  const { sorted: catSorted, sortKey: catKey, dir: catDir, toggle: catToggle } = useSort<CatRow>(catRows, "sales_qty", "desc");
  const totalCats: number = (data?.categories?.[catDim] ?? []).length;

  // CSV kolonları — indirme her zaman EKRANDA GÖRÜNEN (filtreli+sıralı) satırlar üzerinden.
  const listCsvRows = useMemo(
    () => sorted.map((r) => ({
      sku_name: r.sku_name, barkod: r.barkod ?? "", firmalar: (r.retailers ?? []).join(", "),
      marka: r.brand, takim: r.team, tip: r.type,
      sales_qty: r.sales_qty, stock_qty: r.stock_qty, prev_qty: r.prev_qty,
      growth: r.growth == null ? "" : Math.round(r.growth * 10) / 10, sales_value: Math.round(r.sales_value),
    })),
    [sorted]
  );
  const listCsvCols = [
    { key: "sku_name" as const, label: "Ürün" }, { key: "barkod" as const, label: "Barkod" },
    { key: "firmalar" as const, label: "Firmalar" }, { key: "marka" as const, label: "Marka" },
    { key: "takim" as const, label: "Takım" }, { key: "tip" as const, label: "Tip" },
    { key: "sales_qty" as const, label: "Satış" }, { key: "stock_qty" as const, label: "Stok" },
    { key: "prev_qty" as const, label: "Önceki" }, { key: "growth" as const, label: "Büyüme %" },
    { key: "sales_value" as const, label: "TL" },
  ];
  const catCsvRows = useMemo(
    () => catSorted.map((c) => ({ key: c.key, sales_qty: c.sales_qty, sales_value: Math.round(c.sales_value), sku_count: c.sku_count })),
    [catSorted]
  );
  const catCsvCols = [
    { key: "key" as const, label: catLabel(catDim) }, { key: "sales_qty" as const, label: "Satış" },
    { key: "sales_value" as const, label: "TL" }, { key: "sku_count" as const, label: "SKU" },
  ];

  // Görünen satırların özeti (KPI kartları).
  const summary = useMemo(() => {
    const qty = sorted.reduce((a, r) => a + r.sales_qty, 0);
    const val = sorted.reduce((a, r) => a + r.sales_value, 0);
    const stock = sorted.reduce((a, r) => a + r.stock_qty, 0);
    return { qty, val, stock };
  }, [sorted]);

  // ── AĞ TOPLAMI (ek fetch YOK) ──
  // Bu sayfadaki listeler alt kümedir: "top" = en çok satan İLK 20, risers/fallers
  // = ilk 15. Dolayısıyla KPI'daki tutar ağ toplamı DEĞİL; öyle sanılırsa ciro
  // yarıya yakın yanlış okunur (ölçüm: 2026-07-27'de ₺631.179 = ağ netinin %49,7'si).
  // Ağ toplamı zaten elimizde: `categories` kırılımı TÜM hafta satırları üzerinden
  // hesaplanıyor, yani herhangi bir boyutun (brand) toplamı = ağın hafta toplamı.
  const network = useMemo(() => {
    const cats: CatRow[] = data?.categories?.brand ?? [];
    if (!cats.length) return null;
    return {
      qty: cats.reduce((a, c) => a + (c.sales_qty ?? 0), 0),
      val: cats.reduce((a, c) => a + (c.sales_value ?? 0), 0),
    };
  }, [data]);
  // Payı yalnızca anlamlıysa göster. fmtPct kullanılmaz: o büyüme için "+" ekler.
  const shareTxt = (part: number, total: number | undefined) =>
    total && total > 0 && part > 0
      ? `ağın %${((part / total) * 100).toFixed(1).replace(".", ",")}'i`
      : null;

  return (
    <div className="space-y-6">
      <div className="flex items-end justify-between flex-wrap gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Global <span className="neon-text">Sıralamalar</span></h1>
          {/* "TÜM PERAKENDECİLER" ARTIK KOŞULLU. Bu sayfa tek bir haftanın
              kesiti; o hafta rapor göndermeyen firma tabloda hiç görünmüyor ve
              ekran "o firmada satan ürün yok" gibi okunuyordu. Kaç firmanın
              gerçekten bu haftada olduğu yazılır, eksik olan adıyla söylenir. */}
          <p className="text-txt-dim mono text-sm mt-1">
            {data?.kapsam
              ? `${data.kapsam.firmalar.length}/${data.kapsam.toplam} perakendeci · cross-retailer`
              : "Tüm perakendeciler · cross-retailer"}
            {data?.week ? (data.week === takvimHaftasi ? " · güncel hafta" : ` · hafta ${fmtDate(data.week)}`) : ""}
            {" · "}<span className="text-txt-dim/80">listeler kısaltılmış (en çok satan 20 · hareket eden 15)</span>
          </p>
          {data?.kapsam?.eksik?.length > 0 && (
            <p className="mono text-[11px] mt-1" style={{ color: "#f8b00b" }}>
              Bu haftada yok:{" "}
              {data.kapsam.eksik.map((e: any) =>
                `${e.retailer}${e.sonVeri ? ` (son veri ${fmtDate(e.sonVeri)})` : " (hiç veri yok)"}`
              ).join(" · ")}
              {" — listede görünmemeleri satış yapmadıkları anlamına gelmez."}
            </p>
          )}
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <div className="flex gap-1 mono text-xs" role="group" aria-label="Büyüme metriği">
            <button type="button" onClick={() => setMetric("value")} aria-pressed={metric === "value"}
              className={`px-3 py-1.5 rounded hover:transition-colors ${metric === "value" ? "bg-neon/15 text-neon" : "text-txt-dim hover:text-txt"}`}>Büyüme: Ciro</button>
            <button type="button" onClick={() => setMetric("qty")} aria-pressed={metric === "qty"}
              className={`px-3 py-1.5 rounded hover:transition-colors ${metric === "qty" ? "bg-neon/15 text-neon" : "text-txt-dim hover:text-txt"}`}>Adet</button>
          </div>
          <select
            value={week || data?.week || ""}
            onChange={(e) => setWeek(e.target.value)}
            aria-label="Hafta seç"
            disabled={weeks.length === 0}
            className="card mono text-sm px-4 py-2 bg-ink-2 outline-none focus:border-neon disabled:opacity-40"
          >
            {weeks.length === 0 && <option value="">—</option>}
            {weeks.map((w) => (
              <option key={w} value={w} className="bg-ink-2">{fmtDate(w)}</option>
            ))}
          </select>
          {isList ? (
            <CsvBtn filename={`cortex-${tab}`} rows={listCsvRows} cols={listCsvCols} label="⬇ CSV indir" />
          ) : (
            <CsvBtn filename={`cortex-kategori-${catDim}`} rows={catCsvRows} cols={catCsvCols} label="⬇ CSV indir" />
          )}
        </div>
      </div>

      <SegTabs<Tab> tabs={tabs} active={tab} onChange={setTab} />

      {err && (
        <div className="card p-4 border-red-500/40 text-red-400 mono text-sm">Veri alınamadı: {err}</div>
      )}

      {loading && !data ? (
        <div className="card card-flat p-10 text-center mono text-txt-dim">Yükleniyor…</div>
      ) : err ? null : !data ? null : tab === "categories" ? (
        <div className="space-y-5 cx-soluk" {...bekleme(bekliyor)}>
          <div className="card p-4 space-y-3">
            <div className="flex items-center justify-between gap-3 flex-wrap">
              <SegTabs<CatDim> tabs={CAT_DIMS} active={catDim} onChange={setCatDim} />
              <span className="mono text-xs text-txt-dim">{catSorted.length} / {totalCats}</span>
            </div>
            <SearchBox value={catSearch} onChange={setCatSearch} placeholder="🔍 kategori ara…" className="w-full sm:w-72" />
          </div>

          <div className="card p-6">
            <CategoryBars items={catSorted} />
          </div>

          <div className="card p-6 overflow-x-auto">
            {catSorted.length === 0 ? (
              <div className="mono text-sm text-txt-dim text-center py-6">
                {totalCats === 0 ? "Veri yok" : "Aramaya uyan kategori yok"}
              </div>
            ) : (
              <table>
                <thead>
                  <tr>
                    <th>#</th>
                    <SortableTh label={catLabel(catDim)} sortKey="key" active={catKey === "key"} dir={catDir} onClick={catToggle} />
                    <SortableTh label="Satış" sortKey="sales_qty" active={catKey === "sales_qty"} dir={catDir} onClick={catToggle} align="right" />
                    <SortableTh label="TL" sortKey="sales_value" active={catKey === "sales_value"} dir={catDir} onClick={catToggle} align="right" />
                    <SortableTh label="SKU" sortKey="sku_count" active={catKey === "sku_count"} dir={catDir} onClick={catToggle} align="right" />
                  </tr>
                </thead>
                <tbody>
                  {catSorted.map((c, i) => (
                    <tr key={c.key}>
                      <td className="mono text-txt-dim">{i + 1}</td>
                      <td className="font-medium">{c.key}</td>
                      <td className="mono text-right">{fmtInt(c.sales_qty)}</td>
                      <td className="mono text-right">{c.sales_value > 0 ? fmtMoney(c.sales_value) : "—"}</td>
                      <td className="mono text-right text-txt-dim">{fmtInt(c.sku_count)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>
      ) : (
        <div className="space-y-5 cx-soluk" {...bekleme(bekliyor)}>
          {/* KPI — GÖRÜNEN satırların toplamı. Bu bir alt kümedir (top 20 / mover 15);
              ağ toplamı sanılmasın diye etiketler "listedeki N ürün" der ve yanına
              ağ payı yazılır (ağ toplamı `categories`'ten, ek fetch olmadan). */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <StatCard label="LİSTEDEKİ ÜRÜN" value={fmtInt(sorted.length)} sub={`${baseRows.length} içinden`} />
            <StatCard
              label="LİSTENİN SATIŞI"
              value={fmtInt(summary.qty)}
              sub={shareTxt(summary.qty, network?.qty) ?? "adet"}
            />
            <StatCard
              label={<>LİSTENİN NET KAZANCI<Info text={SUBSET_HELP} /></>}
              value={summary.val > 0 ? fmtMoney(summary.val) : "—"}
              sub={shareTxt(summary.val, network?.val) ?? "ağ toplamı DEĞİL"}
            />
            <StatCard label="LİSTENİN STOĞU" value={fmtInt(summary.stock)} sub="adet" />
          </div>

          {/* Filtre paneli — hepsi istemci tarafı, çekilen veri üzerinde */}
          <div className="card p-4 space-y-3">
            <div className="flex items-center gap-3 flex-wrap">
              <SearchBox value={search} onChange={setSearch} placeholder="🔍 ürün adı / barkod…" className="flex-1 min-w-[220px]" />
              <RangeMin label="min satış" value={minSales} onChange={setMinSales} suffix="adet" step={10} />
              {activeFilters > 0 && (
                <button onClick={clearFilters} className="mono text-[11px] text-txt-dim hover:text-neon hover:transition-colors">
                  ✕ filtreleri temizle ({activeFilters})
                </button>
              )}
            </div>
            <MultiChips
              label="Firmalar:"
              options={retailerOpts}
              selected={selRetailers}
              onToggle={(o) => setSelRetailers((p) => (p.includes(o) ? p.filter((x) => x !== o) : [...p, o]))}
              onAll={() => setSelRetailers(retailerOpts)}
              onNone={() => setSelRetailers([])}
              colorOf={colorOf}
            />
            {brandOpts.length > 1 && (
              <MultiChips
                label="Marka:"
                options={brandOpts}
                selected={selBrands}
                onToggle={(o) => setSelBrands((p) => (p.includes(o) ? p.filter((x) => x !== o) : [...p, o]))}
                onAll={() => setSelBrands(brandOpts)}
                onNone={() => setSelBrands([])}
              />
            )}
            {teamOpts.length > 1 && (
              <MultiChips
                label="Takım:"
                options={teamOpts}
                selected={selTeams}
                onToggle={(o) => setSelTeams((p) => (p.includes(o) ? p.filter((x) => x !== o) : [...p, o]))}
                onAll={() => setSelTeams(teamOpts)}
                onNone={() => setSelTeams([])}
              />
            )}
            {typeOpts.length > 1 && (
              <MultiChips
                label="Tip:"
                options={typeOpts}
                selected={selTypes}
                onToggle={(o) => setSelTypes((p) => (p.includes(o) ? p.filter((x) => x !== o) : [...p, o]))}
                onAll={() => setSelTypes(typeOpts)}
                onNone={() => setSelTypes([])}
              />
            )}
          </div>

          <div className="card p-6 overflow-x-auto">
            <div className="flex items-center justify-between mb-3">
              {/* Başlık listenin KESİLMİŞ olduğunu söylesin — "tüm ürünler" sanılmasın. */}
              <h2 className="font-bold">
                {tab === "top" ? "En çok satan ilk 20 ürün" : tab === "risers" ? "En çok yükselen 15 ürün" : "En çok düşen 15 ürün"}
              </h2>
              <span className="mono text-xs text-txt-dim">{sorted.length} / {baseRows.length} ürün</span>
            </div>
            {sorted.length === 0 ? (
              <div className="mono text-sm text-txt-dim text-center py-6">
                {baseRows.length === 0
                  ? (tab === "top" ? "Veri yok" : "Karşılaştırma için en az 2 hafta gerekli")
                  : "Bu filtreyle eşleşen ürün yok."}
              </div>
            ) : (
              <table>
                <thead>
                  <tr>
                    <th>#</th>
                    <SortableTh label="Ürün" sortKey="sku_name" active={sortKey === "sku_name"} dir={dir} onClick={toggle} />
                    <th>Firmalar</th>
                    <SortableTh label="Satış" sortKey="sales_qty" active={sortKey === "sales_qty"} dir={dir} onClick={toggle} align="right" />
                    <SortableTh label="Stok" sortKey="stock_qty" active={sortKey === "stock_qty"} dir={dir} onClick={toggle} align="right" />
                    {tab !== "top" && <>
                      <SortableTh label="Önceki" sortKey="prev_qty" active={sortKey === "prev_qty"} dir={dir} onClick={toggle} align="right" />
                      <SortableTh label="Büyüme" sortKey="growth" active={sortKey === "growth"} dir={dir} onClick={toggle} align="right" />
                    </>}
                    <SortableTh label="TL" sortKey="sales_value" active={sortKey === "sales_value"} dir={dir} onClick={toggle} align="right" />
                  </tr>
                </thead>
                <tbody>
                  {sorted.map((r, i) => (
                    <tr key={(r.barkod ?? r.sku_name) + i}>
                      <td className="mono text-txt-dim">{i + 1}</td>
                      <td className="max-w-xs truncate" title={(r.barkod ? r.barkod + " · " : "") + r.sku_name}>{r.sku_name}</td>
                      <td>
                        <div className="flex gap-1 flex-wrap">
                          {(r.retailers ?? []).map((rt: string) => (
                            <span key={rt} className="mono text-[10px] px-1.5 py-0.5 rounded" style={{ color: COLORS[rt] ?? "#7d927d", border: `1px solid ${COLORS[rt] ?? "#7d927d"}40` }}>{rt}</span>
                          ))}
                        </div>
                      </td>
                      <td className="mono text-right">{fmtInt(r.sales_qty)}</td>
                      <td className="mono text-right text-txt-dim">{fmtInt(r.stock_qty)}</td>
                      {tab !== "top" && <>
                        <td className="mono text-right text-txt-dim">{fmtInt(r.prev_qty)}</td>
                        <td className={`mono text-right ${(r.growth ?? 0) >= 0 ? "text-neon" : "text-red-400"}`}>{fmtPct(r.growth)}</td>
                      </>}
                      <td className="mono text-right">{r.sales_value > 0 ? fmtMoney(r.sales_value) : "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function CategoryBars({ items }: { items: CatRow[] }) {
  if (!items?.length) return <div className="mono text-sm text-txt-dim">Veri yok</div>;
  const max = Math.max(...items.map((i) => i.sales_qty), 1);
  return (
    <div className="space-y-2">
      {items.map((it, i) => (
        <div key={it.key}>
          <div className="flex justify-between text-sm mb-1">
            <span className="font-medium">{it.key}</span>
            <span className="mono text-txt-dim">{fmtInt(it.sales_qty)} adet · {it.sku_count} SKU{it.sales_value > 0 ? ` · ${fmtMoney(it.sales_value)}` : ""}</span>
          </div>
          <div className="h-2.5 rounded-full bg-ink-3 overflow-hidden">
            <div className="h-full rounded-full bg-neon" style={{ width: `${(it.sales_qty / max) * 100}%` }} />
          </div>
        </div>
      ))}
    </div>
  );
}
