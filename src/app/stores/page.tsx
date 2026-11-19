"use client";

import { Fragment, useEffect, useMemo, useState } from "react";
import { RETAILERS, fmtInt, fmtMoney, fmtDate, colorOf } from "@/lib/format";
import {
  SortableTh,
  SearchBox,
  MultiChips,
  RangeMin,
  CsvBtn,
  StatCard,
  useSort,
} from "@/components/Controls";
import { fetchJson } from "@/lib/fetchJson";
import { bekleme } from "@/lib/hareket";
import { izle } from "@/lib/mesgul";

// Mağaza-bazlı veri yalnızca bazı perakendecilerde var ve zamanla değişir
// (şu an Armağan canlı; DR 30 Mart'a kadar veriyordu, sonra formatı mağaza
// kırılımını bıraktı). Bu yüzden default retailer hardcode DEĞİL: sayfa açılışta
// /api/stores keşfiyle en güncel store verisine sahip perakendeciyi seçer.

interface StoreRow {
  store: string;
  sales_qty: number;
  sales_value: number;
  stock_qty: number;
  sku_count: number;
}

// Şube adının ilk kelimesi/ön eki → şehir/grup. "İSTANBUL CEVAHİR" → "İSTANBUL".
// Çoğu zincir mağaza adı şehir/bölge ile başladığı için bu kırılım pratik bir
// coğrafi/grup süzgeci verir; tek kelimelik adlar kendi grubunu oluşturur.
function storeGroup(store: string): string {
  const s = String(store ?? "").trim();
  if (!s) return "—";
  const first = s.split(/[\s/_\-]+/)[0];
  return (first || s).toLocaleUpperCase("tr-TR");
}

export default function StoresPage() {
  const [retailer, setRetailer] = useState(""); // keşif tamamlanınca dolar
  const [storeRetailers, setStoreRetailers] = useState<{ retailer: string; week: string; stale?: boolean; weeksBehind?: number }[]>([]);
  // Mağaza kırılımı ağın güncel haftasının gerisinde kalan firmalar. Sessiz
  // kalınamaz: D&R son mağaza verisini 30.03.2026'da göndermiş ve o tarihten beri
  // yalnız toplam gönderiyor — bu ekranda D&R satışının %48,7'si görünmüyor ama
  // ekran boş/eski veriyi normal veri gibi gösteriyordu.
  const [gap, setGap] = useState<{ retailer: string; week: string; weeksBehind: number }[]>([]);
  const [ownGap, setOwnGap] = useState<{ week: string; weeksBehind: number } | null>(null);
  const [week, setWeek] = useState<string>("");
  const [weeks, setWeeks] = useState<string[]>([]);
  const [stores, setStores] = useState<StoreRow[]>([]);
  const [storeLevel, setStoreLevel] = useState(true);
  const [loading, setLoading] = useState(true); // açılışta keşif beklenirken
  // İlk yanıt geldi mi — sonrasında yeniden çekim sırasında eski içerik soluk
  // durur, sayfa "Yükleniyor…"a çökmez.
  const [yuklendi, setYuklendi] = useState(false);
  const [err, setErr] = useState<string>("");
  const [search, setSearch] = useState("");
  const [minSales, setMinSales] = useState(0);
  const [groups, setGroups] = useState<string[]>([]); // seçili şehir/grup süzgeci ([]=tümü)
  const [openStore, setOpenStore] = useState<string | null>(null);
  const [detail, setDetail] = useState<Record<string, any[]>>({});
  const [detLoading, setDetLoading] = useState<string | null>(null);

  async function openStoreDetail(store: string) {
    if (openStore === store) { setOpenStore(null); return; }
    setOpenStore(store);
    if (detail[store] || !week) return;
    setDetLoading(store);
    try {
      const r = await izle(fetch(`/api/store-detail?retailer=${encodeURIComponent(retailer)}&week=${encodeURIComponent(week)}&store=${encodeURIComponent(store)}`));
      const d = await r.json().catch(() => ({}));
      setDetail((p) => ({ ...p, [store]: d.skus ?? [] }));
    } catch { setDetail((p) => ({ ...p, [store]: [] })); }
    finally { setDetLoading(null); }
  }

  // Açılış keşfi (bir kez): mağaza verisi olan perakendecileri + en güncelini bul.
  useEffect(() => {
    fetchJson(`/api/stores`)
      .then((d) => {
        if (d?.discovery) {
          setStoreRetailers(d.retailers ?? []);
          setGap(
            (d.retailers ?? [])
              .filter((r: any) => r.stale)
              .map((r: any) => ({ retailer: r.retailer, week: r.week, weeksBehind: r.weeksBehind ?? 0 }))
          );
          setRetailer((cur) => cur || d.default || "Armağan");
        } else {
          setRetailer((cur) => cur || "Armağan");
        }
      })
      .catch(() => setRetailer((cur) => cur || "Armağan"));
  }, []);

  useEffect(() => {
    if (!retailer) return; // keşif retailer'ı belirleyene kadar bekle (loading=true kalır)
    // Firma değişince hafta da sıfırlanıyor → iki istek; geç dönen eskisi yenisini ezmesin.
    let iptal = false;
    setLoading(true);
    setErr("");
    setOpenStore(null);
    setDetail({});
    const q = week ? `&week=${week}` : "";
    fetchJson(`/api/stores?retailer=${encodeURIComponent(retailer)}${q}`)
      .then((d) => {
        if (iptal) return;
        setYuklendi(true);
        setStores(d.stores ?? []);
        setWeeks(d.weeks ?? []);
        setStoreLevel(d.storeLevel ?? true);
        setOwnGap(d.stale ? { week: d.latestStoreWeek, weeksBehind: d.weeksBehind ?? 0 } : null);
        if (d.week && !week) setWeek(d.week);
      })
      .catch((e) => {
        if (iptal) return;
        setYuklendi(true);
        // Hata durumunda state'leri güvenli boş default'a çek; storeLevel'i true tut
        // ki render "mağaza-bazlı veri yok" yerine gerçek hatayı göstersin.
        setErr(e.message);
        setStores([]);
        setWeeks([]);
        setStoreLevel(true);
      })
      .finally(() => { if (!iptal) setLoading(false); });
    return () => { iptal = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [retailer, week]);

  useEffect(() => { setWeek(""); }, [retailer]);
  // Perakendeci/hafta değişince istemci-tarafı süzgeçleri sıfırla (eski grup
  // seçimi yeni veride anlamsız olabilir).
  useEffect(() => { setGroups([]); setMinSales(0); setSearch(""); }, [retailer, week]);

  const rows: StoreRow[] = stores ?? [];
  const hasValue = rows.some((s) => (s?.sales_value ?? 0) > 0);

  // Mevcut veriden çıkan şehir/grup seçenekleri (satışa göre azalan, sabit sıra).
  const groupOptions = useMemo(() => {
    const m = new Map<string, number>();
    for (const s of rows) {
      const g = storeGroup(s?.store ?? "");
      m.set(g, (m.get(g) ?? 0) + (s?.sales_qty ?? 0));
    }
    return [...m.entries()].sort((a, b) => b[1] - a[1]).map(([g]) => g);
  }, [rows]);

  // Süzgeç zinciri: arama → min satış → şehir/grup. (Sıralama en sonda.)
  const q = search.trim().toLocaleLowerCase("tr-TR");
  const groupSet = new Set(groups);
  const filtered = useMemo(() => rows.filter((s) => {
    const store = String(s?.store ?? "");
    if (q && !store.toLocaleLowerCase("tr-TR").includes(q)) return false;
    if ((s?.sales_qty ?? 0) < minSales) return false;
    if (groupSet.size > 0 && !groupSet.has(storeGroup(store))) return false;
    return true;
  }), [rows, q, minSales, groups]);

  const { sorted, sortKey, dir, toggle } = useSort<StoreRow>(filtered, "sales_qty", "desc");

  // KPI'lar görünür (süzülmüş) sete göre — süzgeç varken anlam korunur.
  const totalQty = filtered.reduce((a, s) => a + (s?.sales_qty ?? 0), 0);
  const totalVal = filtered.reduce((a, s) => a + (s?.sales_value ?? 0), 0);
  const totalStock = filtered.reduce((a, s) => a + (s?.stock_qty ?? 0), 0);
  // AD BILINCLI: bu toplam AGIN degil, YALNIZ SECILI PERAKENDECININ magaza
  // toplami. Sayfa tek bir /api/stores?retailer=X cagrisiyla besleniyor; ag
  // toplami hicbir yerden cekilmiyor. Eski ad (`netQty`) ve "agin %X'i" cumlesi
  // birlikte olcusuz bir oran uretiyordu (Toyzz + Istanbul -> "agin %38'i",
  // gercek ag payi ~%12).
  const retailerQty = rows.reduce((a, s) => a + (s?.sales_qty ?? 0), 0);
  const filterActive = filtered.length !== rows.length;
  // Aktif istemci-tarafı süzgeç sayısı (arama + min satış + şehir/grup seçimi).
  const activeFilters = (q ? 1 : 0) + (minSales > 0 ? 1 : 0) + groups.length;
  const clearFilters = () => { setSearch(""); setMinSales(0); setGroups([]); };
  // Satis payi bari BU PERAKENDECININ magaza maksimumuna gore (suzgecten bagimsiz
  // sabit olcek). "Tum ag" degil: sayfa tek firmanin satirlariyla besleniyor.
  const maxQty = Math.max(...rows.map((s) => s?.sales_qty ?? 0), 1);

  const csvCols = [
    { key: "store" as const, label: "Mağaza" },
    { key: "group" as const, label: "Şehir/Grup" },
    { key: "sales_qty" as const, label: "Satış" },
    { key: "sales_value" as const, label: "Ciro (net TL)" },
    { key: "stock_qty" as const, label: "Stok" },
    { key: "sku_count" as const, label: "SKU" },
  ];
  // Görünür + sıralı seti, türetilmiş grup kolonuyla dışa aktar.
  const csvRows = sorted.map((s) => ({
    store: s.store,
    group: storeGroup(s.store),
    sales_qty: s.sales_qty,
    sales_value: s.sales_value,
    stock_qty: s.stock_qty,
    sku_count: s.sku_count,
  }));

  return (
    <div className="space-y-6">
      <div className="flex items-end justify-between flex-wrap gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Mağaza <span className="neon-text">Zekası</span></h1>
          <p className="text-txt-dim mono text-sm mt-1">Şube bazlı satış & stok performansı</p>
        </div>
        <CsvBtn
          filename={`cortex-magaza-${retailer}-${week || "tum"}`}
          rows={csvRows}
          cols={csvCols}
          label="⬇ CSV indir"
        />
      </div>

      {/* MAĞAZA VERİSİ KESİLEN FİRMALAR. Metin firma adı ve tarihten OTOMATİK
          türer — yeni bir firma da kesse aynı uyarı kendiliğinden çıkar. Seçili
          firmanın kendi boşluğu ayrıca vurgulanır (ekrandaki sayılar eksik). */}
      {(gap.length > 0 || ownGap) && (
        <div className="card p-3 border-amber-500/40 bg-amber-500/[0.06]">
          <div className="mono text-[11px] tracking-wider text-amber-400 mb-1">⚠ EKSİK MAĞAZA VERİSİ</div>
          {ownGap && (
            <p className="mono text-xs text-amber-200/90">
              {retailer} mağaza kırılımı <b>{fmtDate(ownGap.week)}</b> haftasından beri gelmiyor
              ({ownGap.weeksBehind} hafta geride) — firma yalnız toplam gönderiyor, bu ekrandaki
              {" "}{retailer} sayıları <b>eksiktir</b>. Ağ toplamları etkilenmez.
            </p>
          )}
          {gap.filter((g) => g.retailer !== retailer).length > 0 && (
            <p className="mono text-[11px] text-txt-dim mt-1">
              Diğer geride kalanlar:{" "}
              {gap.filter((g) => g.retailer !== retailer)
                .map((g) => `${g.retailer} (${fmtDate(g.week)}, ${g.weeksBehind} hf)`)
                .join(" · ")}
            </p>
          )}
        </div>
      )}

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
          <SearchBox value={search} onChange={setSearch} placeholder="🔍 şube adı…" />
        </div>
        <div>
          <label className="mono text-xs text-txt-dim block mb-1">Eşik</label>
          <div className="h-[38px] flex items-center">
            <RangeMin label="min satış" value={minSales} onChange={setMinSales} suffix="adet" step={10} />
          </div>
        </div>
        {activeFilters > 0 && (
          <div className="h-[38px] flex items-center">
            <button
              type="button"
              onClick={clearFilters}
              className="mono text-[11px] text-txt-dim hover:text-neon hover:transition-colors"
            >
              ✕ filtreleri temizle ({activeFilters})
            </button>
          </div>
        )}
      </div>

      {/* Şehir/şube-grubu süzgeci — yalnızca >1 grup varken anlamlı */}
      {yuklendi && !err && storeLevel && groupOptions.length > 1 && (
        <div className="card p-3 cx-soluk" {...bekleme(loading)}>
          <MultiChips
            label="Şehir/grup:"
            options={groupOptions}
            selected={groups}
            onToggle={(g) =>
              setGroups((p) => (p.includes(g) ? p.filter((x) => x !== g) : [...p, g]))
            }
            onAll={() => setGroups([])}
            onNone={() => setGroups([...groupOptions])}
          />
        </div>
      )}

      <div className="cx-soluk space-y-6" {...bekleme(loading && yuklendi)}>
      {loading && !yuklendi ? (
        <div className="card card-flat p-10 text-center mono text-txt-dim">Yükleniyor…</div>
      ) : err ? (
        <div className="card p-4 border-red-500/40 text-red-400 mono text-sm">Veri alınamadı: {err}</div>
      ) : !storeLevel ? (
        <div className="card p-10 text-center">
          <div className="font-semibold">{retailer} mağaza-bazlı veri göndermiyor</div>
          <p className="text-txt-dim text-sm mt-2 mono">
            Bu perakendeci agrega (mağaza kırılımı olmayan) veri sağlıyor.
            {storeRetailers.length > 0
              ? ` Mağaza kırılımı olan: ${storeRetailers.map((s) => s.retailer).join(", ")}.`
              : ""}
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
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <StatCard
              label="MAĞAZA"
              value={fmtInt(filtered.length)}
              sub={filterActive ? `${rows.length} mağazadan süzüldü` : "tümü"}
            />
            <StatCard
              label="TOPLAM SATIŞ"
              value={fmtInt(totalQty)}
              color="#e8ffe8"
              sub={filterActive && retailerQty > 0
                ? `${retailer} mağazalarının %${((totalQty / retailerQty) * 100).toFixed(0)}'i`
                : "adet"}
            />
            <StatCard
              label="TOPLAM CİRO (NET)"
              value={totalVal > 0 ? fmtMoney(totalVal) : "—"}
              color={colorOf(retailer)}
              sub={!hasValue ? "bu perakendeci ciro göndermiyor" : "net kazanç"}
            />
            <StatCard
              label="TOPLAM STOK"
              value={fmtInt(totalStock)}
              sub="adet"
            />
          </div>

          <div className="card p-6 overflow-x-auto">
            <table>
              <thead>
                <tr>
                  <th>#</th>
                  <SortableTh label="Mağaza" sortKey="store" active={sortKey === "store"} dir={dir} onClick={toggle} />
                  <SortableTh label="Satış" sortKey="sales_qty" active={sortKey === "sales_qty"} dir={dir} onClick={toggle} align="right" />
                  <th>Pay</th>
                  <SortableTh label="Ciro (net)" sortKey="sales_value" active={sortKey === "sales_value"} dir={dir} onClick={toggle} align="right" />
                  <SortableTh label="Stok" sortKey="stock_qty" active={sortKey === "stock_qty"} dir={dir} onClick={toggle} align="right" />
                  <SortableTh label="SKU" sortKey="sku_count" active={sortKey === "sku_count"} dir={dir} onClick={toggle} align="right" />
                </tr>
              </thead>
              <tbody>
                {sorted.length === 0 ? (
                  <tr>
                    <td colSpan={7} className="text-center mono text-txt-dim py-8">
                      Süzgeçlere uyan mağaza yok. Aramayı, min satışı veya şehir/grup seçimini gevşet.
                    </td>
                  </tr>
                ) : sorted.map((s, i) => {
                  const store = s?.store ?? "—";
                  const isOpen = openStore === store;
                  const skus = detail[store];
                  return (
                    <Fragment key={store + i}>
                      <tr
                        onClick={() => openStoreDetail(store)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter" || e.key === " ") { e.preventDefault(); openStoreDetail(store); }
                        }}
                        role="button"
                        tabIndex={0}
                        aria-expanded={isOpen}
                        title={isOpen ? "kapat" : "ürün kırılımını aç"}
                        className="cursor-pointer hover:bg-neon/5 focus:outline-none focus:bg-neon/10"
                      >
                        <td className="mono text-txt-dim">{i + 1}</td>
                        <td className="font-medium">{isOpen ? "▼ " : "▶ "}{store}</td>
                        <td className="mono text-right">{fmtInt(s?.sales_qty ?? 0)}</td>
                        <td className="w-32">
                          <div className="h-1.5 rounded-full bg-ink-3 overflow-hidden">
                            <div className="h-full bg-neon rounded-full" style={{ width: `${((s?.sales_qty ?? 0) / maxQty) * 100}%` }} />
                          </div>
                        </td>
                        <td className="mono text-right">{(s?.sales_value ?? 0) > 0 ? fmtMoney(s.sales_value) : "—"}</td>
                        <td className="mono text-right">{fmtInt(s?.stock_qty ?? 0)}</td>
                        <td className="mono text-right text-txt-dim">{s?.sku_count ?? 0}</td>
                      </tr>
                      {isOpen && (
                        <tr>
                          <td colSpan={7} className="bg-ink-2/40">
                            {detLoading === store ? (
                              <div className="mono text-xs text-txt-dim p-3">Yükleniyor…</div>
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
                                        <td className="max-w-[360px] truncate" title={(k.barkod ? k.barkod + " · " : "") + k.sku_name}>{k.sku_name}</td>
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
            <div className="mono text-xs text-txt-dim mt-3">
              {fmtInt(sorted.length)} / {fmtInt(rows.length)} mağaza
              {filterActive ? " (süzüldü)" : ""}
            </div>
          </div>
        </>
      )}
      </div>
    </div>
  );
}
