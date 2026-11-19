"use client";

import { useEffect, useMemo, useState } from "react";
import { RETAILERS, fmtInt, fmtMoney, fmtDate } from "@/lib/format";
import { fetchJson } from "@/lib/fetchJson";
import { SURE, bekleme } from "@/lib/hareket";
import { parseProductMeta } from "@/lib/compute";
import {
  SortableTh,
  SearchBox,
  MultiChips,
  useSort,
  CsvBtn,
  StatCard,
  type SortDir,
} from "@/components/Controls";

// Durum kimliği: API'nin ürettiği status değerleriyle birebir. "yeterli" de
// listede gelebildiği için (reorderPriority yalnız minAvg altını eler) dördünü de tanımlıyoruz.
type Status = "tükendi" | "acil" | "izle" | "yeterli";
const STATUS: Record<Status, { label: string; cls: string }> = {
  "tükendi": { label: "Tükendi", cls: "text-red-300 bg-red-500/15 border-red-500/40" },
  "acil": { label: "Acil", cls: "text-orange-300 bg-orange-500/15 border-orange-500/40" },
  "izle": { label: "İzle", cls: "text-yellow-300 bg-yellow-500/10 border-yellow-500/30" },
  // "Yeterli" DEĞİL "Düşük öncelik": bu ekran YAKIN tükenmeyi ölçüyor (<1 hf acil,
  // <2 hf izle). 3,7 haftalık stok burada acil değildir, ama /stok'un sipariş
  // eşiğine (<8 hf) göre hâlâ "az stok"tur. Eski "Yeterli" ifadesi mutlak bir
  // yeterlilik iddiası gibi okunuyor ve iki ekran aynı ürün için ZIT KELİME
  // söylüyordu (ölçüm: 21 satır / 22.366 adet). Eşikler bilinçli olarak farklı
  // kaldı — biri yakın risk, diğeri ikmal politikası; değişen yalnız ifade.
  "yeterli": { label: "Düşük öncelik", cls: "text-txt-dim bg-white/5 border-line" },
};
const STATUS_ORDER: Status[] = ["tükendi", "acil", "izle", "yeterli"];

// Sunucudan gelen satır (compute.ts ReorderRow ile aynı şekil) + istemcide
// türetilen marka/takım/tip alanları. parseProductMeta sku_name'den çözer.
type Item = {
  sku_name: string;
  barkod: string | null;
  avg_sales: number;
  ewma?: number;                       // üstel ağırlıklı hız (yeni haftalar baskın)
  trend?: "up" | "down" | "flat";      // EWMA / düz ort. — ivme sinyali
  last_sales: number;
  stock_qty: number;
  sales_value: number;
  cover: number | null;
  cover_ewma?: number | null;
  weeks_used: number;
  status: Status;
};

// İvme oku: EWMA düz ortalamanın ±%15 dışındaysa ürün hızlanıyor/yavaşlıyor demektir.
// Ok, "Haftalık Ort." hücresinde durur — hover başlığı EWMA hızını ve EWMA'ya göre
// kaç hafta yeteceğini gösterir (ivmelenen üründe düz kapsamdan daha gerçekçi).
function TrendArrow({ r }: { r: Item }) {
  if (!r.trend || r.trend === "flat") return null;
  const up = r.trend === "up";
  return (
    <span
      className={`ml-1 ${up ? "text-neon" : "text-red-400"}`}
      title={`${up ? "Hızlanıyor" : "Yavaşlıyor"} — EWMA hız ${r.ewma ?? "?"}/hf` +
        (r.cover_ewma != null ? ` · bu hıza göre stok ${r.cover_ewma} hf yeter` : "")}
    >
      {up ? "↗" : "↘"}
    </span>
  );
}
type Enriched = Item & { brand: string; team: string; type: string };

// Eski toggle ile yeni kolon-sıralaması aynı anda iki ayrı sıralama isteyemez.
// Bu yüzden bir "sıralama modu" var: "akilli" = mevcut Aciliyet/En az stok/En çok
// satan davranışı (KORUNDU); "manuel" = kolon başlıklarına tıklayarak (SortableTh).
type SmartSort = "aciliyet" | "stok" | "satis";

export default function StockPage() {
  const [retailer, setRetailer] = useState(RETAILERS[0]);
  const [minSales, setMinSales] = useState(10);
  const [smartSort, setSmartSort] = useState<SmartSort>("aciliyet");
  const [data, setData] = useState<any>(null);
  // Min satış girdisi 300 ms susunca isteğe dönüşür: her tuşta bir istek ve
  // sayfanın çöküp yeniden dolması yerine tek istek.
  const [minSalesIstek, setMinSalesIstek] = useState(minSales);
  const [veriAnahtari, setVeriAnahtari] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // ── istemci tarafı analiz state'i (hepsi ZATEN çekilmiş veri üzerinde) ──
  const [search, setSearch] = useState("");
  const [brandSel, setBrandSel] = useState<string[]>([]);
  const [teamSel, setTeamSel] = useState<string[]>([]);
  const [typeSel, setTypeSel] = useState<string[]>([]);
  const [statusSel, setStatusSel] = useState<Status[]>([]);
  // sıralama: "smart" = eski toggle, "manual" = kolon başlığı
  const [sortMode, setSortMode] = useState<"smart" | "manual">("smart");

  useEffect(() => {
    const t = setTimeout(() => setMinSalesIstek(minSales), SURE.debounce);
    return () => clearTimeout(t);
  }, [minSales]);

  useEffect(() => {
    let iptal = false;
    const k = `${retailer}|${minSalesIstek}`;
    setLoading(true);
    setErr(null);
    fetchJson(`/api/stock-alerts?retailer=${encodeURIComponent(retailer)}&minSales=${minSalesIstek}`)
      .then((d) => { if (iptal) return; setData(d); setVeriAnahtari(k); })
      .catch((e) => { if (iptal) return; setErr(e.message); setData(null); setVeriAnahtari(null); })
      .finally(() => { if (!iptal) setLoading(false); });
    return () => { iptal = true; };
  }, [retailer, minSalesIstek]);
  // Ekrandaki okuma girilen eşiğe ait değilse (yazarken de) soluk: eski
  // perakendecinin ya da eski eşiğin sayıları güncel sanılmasın.
  const bekliyor = data != null && veriAnahtari !== `${retailer}|${minSales}`;

  // Perakendeci/eşik değişince filtre seçimlerini sıfırla — eski seçim yeni
  // veri kümesinde boş liste üretip kullanıcıyı şaşırtmasın.
  useEffect(() => {
    setSearch(""); setBrandSel([]); setTeamSel([]); setTypeSel([]); setStatusSel([]);
  }, [retailer, minSales]);

  // Ham satırları marka/takım/tip ile zenginleştir (yalnız sku_name'den, istemcide).
  const enriched = useMemo<Enriched[]>(() => {
    return ((data?.items ?? []) as Item[]).map((r) => {
      const meta = parseProductMeta(r.sku_name);
      return { ...r, brand: meta.brand, team: meta.team, type: meta.type };
    });
  }, [data]);

  // Filtre chip seçenekleri — yalnızca bu veri kümesinde gerçekten var olanlar,
  // satış hacmine göre kabaca azalan sırada (en alakalı chip'ler solda).
  const brandOpts = useMemo(() => dimOptions(enriched, "brand"), [enriched]);
  const teamOpts = useMemo(() => dimOptions(enriched, "team"), [enriched]);
  const typeOpts = useMemo(() => dimOptions(enriched, "type"), [enriched]);
  // Durum chip'leri: sadece veride mevcut olan durumlar, kanonik aciliyet sırasında.
  const statusOpts = useMemo(() => {
    const present = new Set(enriched.map((r) => r.status));
    return STATUS_ORDER.filter((s) => present.has(s));
  }, [enriched]);

  // ── Filtreleme: arama + marka + takım + tip + durum (hepsi VE mantığı) ──
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    const bs = new Set(brandSel), ts = new Set(teamSel), ys = new Set(typeSel), ss = new Set(statusSel);
    return enriched.filter((r) => {
      if (q && !(`${r.sku_name} ${r.barkod ?? ""}`.toLowerCase().includes(q))) return false;
      if (bs.size && !bs.has(r.brand)) return false;
      if (ts.size && !ts.has(r.team)) return false;
      if (ys.size && !ys.has(r.type)) return false;
      if (ss.size && !ss.has(r.status)) return false;
      return true;
    });
  }, [enriched, search, brandSel, teamSel, typeSel, statusSel]);

  // ── Manuel sıralama (kolon başlığı) — useSort generic kancası ──
  const { sorted: manualSorted, sortKey, dir, toggle } = useSort<Enriched>(filtered, undefined, "desc");

  // Manuel kolon sıralaması açılınca onu kullan; aksi halde mevcut akıllı toggle
  // davranışını AYNEN uygula (API zaten aciliyet sıralı gönderir).
  const items = useMemo(() => {
    if (sortMode === "manual" && sortKey) return manualSorted;
    const arr = [...filtered];
    if (smartSort === "stok") arr.sort((a, b) => a.stock_qty - b.stock_qty || b.avg_sales - a.avg_sales);
    else if (smartSort === "satis") arr.sort((a, b) => b.avg_sales - a.avg_sales);
    // "aciliyet" → filtered, API'nin kapsam-artan sırasını korur (stabil filter)
    return arr;
  }, [sortMode, sortKey, manualSorted, filtered, smartSort]);

  // Bir kolon başlığına tıklanınca otomatik olarak manuel moda geç.
  function onSortClick(key: string) {
    setSortMode("manual");
    toggle(key);
  }
  // Akıllı toggle'a dönülünce manuel sıralamayı bırak.
  function onSmart(k: SmartSort) {
    setSmartSort(k);
    setSortMode("smart");
  }

  // Filtrelenmiş kümenin canlı özeti (rozetler bunu yansıtır → filtreyle tutarlı).
  const liveCounts = useMemo(() => {
    const c = { tukendi: 0, acil: 0, izle: 0, yeterli: 0 };
    for (const r of filtered) {
      if (r.status === "tükendi") c.tukendi++;
      else if (r.status === "acil") c.acil++;
      else if (r.status === "izle") c.izle++;
      else c.yeterli++;
    }
    return c;
  }, [filtered]);

  const weeksUsed = data?.weeksUsed ?? 4;
  const totalRows = enriched.length;
  const anyFilter = !!(search.trim() || brandSel.length || teamSel.length || typeSel.length || statusSel.length);

  function clearFilters() {
    setSearch(""); setBrandSel([]); setTeamSel([]); setTypeSel([]); setStatusSel([]);
  }

  // CSV: ekranda görünen (filtre+sıralama uygulanmış) satırları indir.
  const csvRows = useMemo(
    () => items.map((r) => ({
      urun: r.sku_name, barkod: r.barkod ?? "",
      marka: r.brand, takim: r.team, tip: r.type,
      ort: r.avg_sales, son: r.last_sales, stok: r.stock_qty,
      kapsam: r.cover ?? "", ciro: Math.round(r.sales_value),
      durum: STATUS[r.status]?.label ?? r.status,
    })),
    [items]
  );
  const csvCols = [
    { key: "urun", label: "Ürün" }, { key: "barkod", label: "Barkod" },
    { key: "marka", label: "Marka" }, { key: "takim", label: "Takım" }, { key: "tip", label: "Tip" },
    { key: "ort", label: `Haftalık Ort (${weeksUsed}hf)` }, { key: "son", label: "Son Hafta" },
    { key: "stok", label: "Stok" }, { key: "kapsam", label: "Kaç Hafta Yeter" },
    { key: "ciro", label: "Ciro (TL)" }, { key: "durum", label: "Durum" },
  ] as const;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">
          Sipariş <span className="neon-text">Önceliği</span>
        </h1>
        <p className="text-txt-dim text-sm mt-1">
          Son <span className="text-txt mono">{weeksUsed}</span> haftanın <span className="text-txt">haftalık ortalama</span> satışı
          {" "}<span className="text-txt mono">≥ {minSales}</span> olan ürünler, mevcut stoğun kaç hafta yeteceğine göre — en acil üstte.
          Düşük-stok listesi değil; <span className="text-txt">satıp tükenen</span> ürünler.
        </p>
      </div>

      {/* Kontroller */}
      <div className="card p-4 flex flex-wrap items-end gap-4">
        <div>
          <label className="mono text-xs text-txt-dim block mb-1">Perakendeci</label>
          <select value={retailer} onChange={(e) => setRetailer(e.target.value)}
            className="card mono text-sm px-3 py-2 bg-ink-2 outline-none focus:border-neon">
            {RETAILERS.map((r) => <option key={r} className="bg-ink-2">{r}</option>)}
          </select>
        </div>
        <div>
          <label className="mono text-xs text-txt-dim block mb-1">Min. haftalık ort. satış (≥)</label>
          <input type="number" min={1} value={minSales} onChange={(e) => setMinSales(Math.max(1, +e.target.value))}
            className="card mono text-sm px-3 py-2 bg-ink-2 outline-none focus:border-neon w-24" />
        </div>
        <div>
          <label className="mono text-xs text-txt-dim block mb-1">Sırala</label>
          <div className="flex gap-1 mono text-xs" role="group" aria-label="Sıralama">
            {([["aciliyet", "Aciliyet"], ["stok", "En az stok"], ["satis", "En çok satan"]] as const).map(([k, l]) => {
              const on = sortMode === "smart" && smartSort === k;
              return (
                <button key={k} type="button" onClick={() => onSmart(k)} aria-pressed={on}
                  className={`px-3 py-2 rounded hover:transition-colors ${on ? "bg-neon/15 text-neon" : "text-txt-dim hover:text-txt"}`}>{l}</button>
              );
            })}
          </div>
        </div>
        <div className="flex-1 min-w-48">
          <label className="mono text-xs text-txt-dim block mb-1">Ürün / barkod ara</label>
          <SearchBox value={search} onChange={setSearch} placeholder="🔍 ürün adı veya barkod…" />
        </div>
        {data?.latest && (
          <div className="mono text-xs text-txt-dim ml-auto flex items-center gap-3">
            <span>son hafta: <span className="text-txt">{fmtDate(data.latest)}</span></span>
            <CsvBtn filename={`siparis-onceligi-${retailer}-${data?.latest ?? ""}`} rows={csvRows} cols={csvCols as any} label="⬇ CSV indir" />
          </div>
        )}
      </div>

      {/* İstemci tarafı filtreler — yalnız ZATEN çekilmiş veri üzerinde çalışır.
          Yeniden-çekim sırasında soluklaştır: eski verinin filtreleri güncelmiş gibi görünmesin. */}
      {data && totalRows > 0 && (
        <div className={`card p-4 space-y-3 cx-soluk ${bekliyor ? "pointer-events-none" : ""}`} {...bekleme(bekliyor)}>
          <div className="flex items-center justify-between flex-wrap gap-2">
            <span className="mono text-xs text-txt-dim">Filtreler</span>
            <div className="mono text-[11px] text-txt-dim flex items-center gap-3">
              <span>
                <span className={anyFilter ? "text-neon" : "text-txt"}>{filtered.length}</span> / {totalRows} ürün
              </span>
              {anyFilter && (
                <button onClick={clearFilters} className="text-txt-dim hover:text-neon hover:transition-colors">temizle</button>
              )}
            </div>
          </div>
          {statusOpts.length > 0 && (
            <MultiChips
              label="Durum:"
              options={statusOpts}
              selected={statusSel}
              onToggle={(s) => setStatusSel((p) => toggleArr(p, s))}
              onAll={() => setStatusSel([...statusOpts])}
              onNone={() => setStatusSel([])}
              colorOf={statusColor}
            />
          )}
          {teamOpts.length > 1 && (
            <MultiChips
              label="Takım:"
              options={teamOpts}
              selected={teamSel}
              onToggle={(t) => setTeamSel((p) => toggleArr(p, t))}
              onAll={() => setTeamSel([...teamOpts])}
              onNone={() => setTeamSel([])}
            />
          )}
          {brandOpts.length > 1 && (
            <MultiChips
              label="Marka:"
              options={brandOpts}
              selected={brandSel}
              onToggle={(b) => setBrandSel((p) => toggleArr(p, b))}
              onAll={() => setBrandSel([...brandOpts])}
              onNone={() => setBrandSel([])}
            />
          )}
          {typeOpts.length > 1 && (
            <MultiChips
              label="Tip:"
              options={typeOpts}
              selected={typeSel}
              onToggle={(t) => setTypeSel((p) => toggleArr(p, t))}
              onAll={() => setTypeSel([...typeOpts])}
              onNone={() => setTypeSel([])}
            />
          )}
        </div>
      )}

      {/* Özet rozetleri — filtrelenmiş kümeyi yansıtır. Yeniden-çekim sırasında
          soluklaştır ki eski perakendecinin sayıları güncel sanılmasın. */}
      {data && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3 cx-soluk" {...bekleme(bekliyor)}>
          {/* Hız tanımı + ivme oku lejantı — tabloyu okumadan önce tek satırda ne-nedir. */}
          <div className="col-span-2 md:col-span-4 mono text-[11px] text-txt-dim">
            Hız = son {data?.weeksUsed ?? 4} haftanın <span className="text-txt">haftalık ortalama</span> satışı ·
            <span className="text-neon"> ↗</span>/<span className="text-red-400">↘</span> = EWMA ivme
            (son haftalar baskın; ürün ortalamadan ±%15 hızlı/yavaşsa görünür — oka gel, EWMA hızı ve gerçekçi stok ömrünü gösterir).
          </div>
          <StatCard label="TÜKENDİ (satıyor, stok 0)" value={fmtInt(liveCounts.tukendi)} color="#fca5a5" />
          <StatCard label="ACİL (< 1 hafta yeter)" value={fmtInt(liveCounts.acil)} color="#fdba74" />
          <StatCard label="İZLE (1–2 hafta)" value={fmtInt(liveCounts.izle)} color="#fde047" />
          <StatCard label="DÜŞÜK ÖNCELİK (≥ 2 hafta)" value={fmtInt(liveCounts.yeterli)} sub="yakın tükenme riski yok — ikmal kararı için Stok Merkezi" />
        </div>
      )}

      {err && <div className="card p-4 border-red-500/40 text-red-400 mono text-sm">Veri alınamadı: {err}</div>}

      {loading && !data ? (
        <div className="mono text-txt-dim py-10 text-center">Yükleniyor…</div>
      ) : err || !data ? null : (
        <div className="card p-6 cx-soluk" {...bekleme(bekliyor)}>
          <div className="flex items-center justify-between mb-3 flex-wrap gap-2">
            <h2 className="font-bold">
              Sipariş listesi
              {sortMode === "manual" && sortKey && (
                <span className="mono text-[11px] text-txt-dim ml-2 font-normal">· kolon sıralı</span>
              )}
            </h2>
            <span className="mono text-xs text-txt-dim">
              {items.length}
              {anyFilter && <span className="text-txt-dim"> / {totalRows}</span>} ürün
            </span>
          </div>
          {items.length ? (
            <div className="overflow-x-auto">
              <table>
                <thead>
                  <tr>
                    <th>#</th><th>Ürün</th>
                    <SortableTh label="Haftalık Ort." sortKey="avg_sales" active={sortMode === "manual" && sortKey === "avg_sales"} dir={dir as SortDir} onClick={onSortClick} align="right" />
                    <SortableTh label="Son Hafta" sortKey="last_sales" active={sortMode === "manual" && sortKey === "last_sales"} dir={dir as SortDir} onClick={onSortClick} align="right" />
                    <SortableTh label="Stok" sortKey="stock_qty" active={sortMode === "manual" && sortKey === "stock_qty"} dir={dir as SortDir} onClick={onSortClick} align="right" />
                    <SortableTh label="Kaç Hafta Yeter" sortKey="cover" active={sortMode === "manual" && sortKey === "cover"} dir={dir as SortDir} onClick={onSortClick} align="right" />
                    <SortableTh label="Ciro (TL)" sortKey="sales_value" active={sortMode === "manual" && sortKey === "sales_value"} dir={dir as SortDir} onClick={onSortClick} align="right" />
                    <th>Durum</th>
                  </tr>
                </thead>
                <tbody>
                  {items.map((r, i) => {
                    const st = STATUS[r.status] ?? STATUS["yeterli"];
                    return (
                      <tr key={`${r.sku_name}-${i}`}>
                        <td className="mono text-txt-dim">{i + 1}</td>
                        <td className="max-w-[340px] truncate" title={(r.barkod ? r.barkod + " · " : "") + r.sku_name}>
                          {r.sku_name}
                          <span className="mono text-[10px] text-txt-dim ml-2">
                            {r.team !== "Genel" ? r.team : ""}{r.team !== "Genel" && r.type !== "Diğer" ? " · " : ""}{r.type !== "Diğer" ? r.type : ""}
                          </span>
                        </td>
                        <td className="mono text-right">{fmtInt(r.avg_sales)}<TrendArrow r={r} /></td>
                        <td className="mono text-right text-txt-dim">{fmtInt(r.last_sales)}</td>
                        <td className="mono text-right">{fmtInt(r.stock_qty)}</td>
                        <td className="mono text-right">{r.cover == null ? "—" : `${r.cover} hf`}</td>
                        <td className="mono text-right text-txt-dim">{fmtMoney(r.sales_value)}</td>
                        <td>
                          <span className={`mono text-[10px] px-2 py-0.5 rounded border ${st.cls}`}>{st.label}</span>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          ) : anyFilter ? (
            <div className="mono text-sm text-txt-dim">
              Seçili filtrelere uyan ürün yok.{" "}
              <button onClick={clearFilters} className="text-neon hover:underline">Filtreleri temizle</button>
            </div>
          ) : (
            <div className="mono text-sm text-txt-dim">
              Bu eşikte (≥ {minSales}) ürün yok. Eşiği düşürmeyi dene.
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── Yardımcılar (saf, istemci tarafı) ──

// Bir diziye değer ekle/çıkar (immutable toggle).
function toggleArr<T>(arr: T[], v: T): T[] {
  return arr.includes(v) ? arr.filter((x) => x !== v) : [...arr, v];
}

// Bir boyutun (brand|team|type) bu veri kümesindeki seçeneklerini satış hacmine
// göre kabaca azalan sırada döndür (en alakalı chip solda).
function dimOptions(rows: Enriched[], dim: "brand" | "team" | "type"): string[] {
  const w = new Map<string, number>();
  for (const r of rows) w.set(r[dim], (w.get(r[dim]) ?? 0) + r.avg_sales);
  return [...w.entries()].sort((a, b) => b[1] - a[1]).map(([k]) => k);
}

// Durum chip'i için renk (seçiliyken MultiChips bu rengi kullanır).
function statusColor(s: Status): string {
  return s === "tükendi" ? "#f87171" : s === "acil" ? "#fb923c" : s === "izle" ? "#facc15" : "#7d927d";
}
