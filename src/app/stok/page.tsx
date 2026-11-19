"use client";

import { Fragment, useEffect, useMemo, useState } from "react";
import { fmtInt, fmtMoney, RETAILERS, RETAILER_COLORS, colorOf, fmtHafta, fmtDate } from "@/lib/format";
import { fetchJson } from "@/lib/fetchJson";
import { bekleme } from "@/lib/hareket";
import { izle } from "@/lib/mesgul";
import { kanalAdi } from "@/lib/kanal";
import { useAsistanBaglami } from "@/lib/asistan-baglam";
import { parseProductMeta, COVERAGE_LOW, COVERAGE_HIGH, COVERAGE_LABELS, DEAD_STOCK_MIN_WEEKS, DEAD_STOCK_HIGH_WEEKS, VELOCITY_WEEKS, GECIKME_ROZET } from "@/lib/compute";
import {
  SortableTh, MultiChips, RangeMin, SegTabs, SearchBox, StatCard, CsvBtn, useSort,
  type SortDir,
} from "@/components/Controls";

// Durum etiketleri EŞİK SABİTLERİNDEN türer (compute.ts tek kaynak); daha önce
// "<8 hf" / ">30 hf" gibi ifadeler UI'da elle yazılıydı ve eşik değişince kayıyordu.
const STATUS: Record<string, { label: string; cls: string; color: string }> = {
  kritik: { label: "Az stok", cls: "text-red-300 bg-red-500/15 border-red-500/40", color: "#ff5555" },
  fazla: { label: "Fazla stok", cls: "text-yellow-300 bg-yellow-500/10 border-yellow-500/30", color: "#f8b00b" },
  saglikli: { label: "Sağlıklı", cls: "text-neon bg-neon/10 border-neon/30", color: "#1FF80B" },
};
const COLORS = RETAILER_COLORS;
const col = colorOf;

// Tek sayı biçimleyici — önce aynı gövde `fmtAvg` ve `fmtVel` adıyla iki kez vardı.
const fmt1 = (n: number) => (Math.round(n * 10) / 10).toLocaleString("tr-TR");

// ÜRÜN FİRMANIN RAPORUNDAN DÜŞMÜŞ rozeti. Stoğu kalıntıdır; manşet toplamlarına
// ve durum sayımlarına GİRMEZ.
//
// METİN DEĞİŞTİ: eskiden "⚠ bayat · listeden düştü" yazıyordu ve aynı ekranda
// "bayat" kelimesi İKİ FARKLI şeyi anlatıyordu — (a) ürünün firmanın raporundan
// düşmesi, (b) firmanın haftalardır rapor göndermemesi. İkisi zıt aksiyon
// gerektiriyor: ilki "bu stok gerçekten var mı" sorusu, ikincisi "rapor gönder".
function StaleBadge({ lastSeen, windowWeeks }: { lastSeen?: string | null; windowWeeks: number }) {
  const when = lastSeen ? `son görülme ${lastSeen}` : `${windowWeeks}+ hafta önce`;
  return (
    <span
      className="mono text-[10px] px-2 py-0.5 rounded border whitespace-nowrap text-txt-dim border-line bg-ink-2"
      title={`Bu ürün firmanın güncel haftalık raporunda yok (${when}). Stoğu listeden düşmüş sayılır; toplamlara eklenmez.`}
    >
      FİRMA RAPORUNDA YOK
    </span>
  );
}

// KAPANDI rozeti: satıştan çekilmiş / tasfiye edilmiş kalem (kapali-urunler.ts).
// Satır listede KALIR — geçmişi silmiyoruz — ama hiçbir sayıma ve karara girmez.
const KAPALI_METIN: Record<string, string> = {
  tasfiye: "tasfiye",
  "satistan-cekildi": "satıştan çekildi",
  "iade-alindi": "iade alındı",
};
function KapaliBadge({ neden, tarih }: { neden?: string | null; tarih?: string | null }) {
  const ad = (neden && KAPALI_METIN[neden]) || "kapandı";
  return (
    <span
      className="mono text-[10px] px-2 py-0.5 rounded border whitespace-nowrap"
      style={{ color: "#7d927d", borderColor: "#7d927d40" }}
      title="Bu kalem satıştan çekildi; geçmiş verisi duruyor ama karar ve sayımlara girmiyor."
    >
      KAPANDI · {ad}{tarih ? ` ${tarih}` : ""}
    </span>
  );
}

type StatusTab = "kritik" | "fazla" | "saglikli" | "all";
type View = "durum" | "sure" | "olu";
const VIEW_ADI: Record<View, string> = { durum: "stok durumu", sure: "stok süresi", olu: "ölü stok" };
// Durum tablosunda sıralanabilir sayısal kolonlar (alan adları item üzerinde birebir).
type DurumSortKey = "avg_weekly" | "last_stock" | "coverage" | "stock_value";

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
  // Asistan: hangi görünüme ve hangi filtreye bakıldığı.
  useAsistanBaglami({
    "görünüm": VIEW_ADI[view],
    ...(view === "durum" ? {
      sekme: status === "all" ? "hepsi" : STATUS[status]?.label ?? status,
      ...(firms.length && firms.length < allFirms.length ? { firmalar: firms.map(kanalAdi).join(", ") } : {}),
      ...(search.trim() ? { arama: search.trim() } : {}),
    } : {}),
  });
  const velWeeks: number = data?.velocity_weeks ?? VELOCITY_WEEKS;
  const winWeeks: number = data?.window_weeks ?? 12;

  // Her satıra ürün kimliğini (brand/team/type) bir kez ekle — chip seçenekleri ve filtre buradan.
  const enriched = useMemo(
    () =>
      (data?.items ?? []).map((i: any) => {
        const m = parseProductMeta(String(i.sku_name ?? ""));
        return { ...i, _brand: m.brand, _team: m.team, _type: m.type };
      }),
    [data]
  );

  // Firma bazında AŞIRI STOK (fazla) PSF değeri toplamı — "ne kadar ₺ takılı".
  // BAYAT satırlar HARİÇ: raporlardan düşmüş ürünün stoğu gerçek değil.
  const overstockValue = useMemo(() => {
    const m: Record<string, number> = {};
    for (const i of enriched as any[]) {
      if (i.status === "fazla" && !i.stale) m[i.retailer] = (m[i.retailer] || 0) + (i.stock_value || 0);
    }
    return m;
  }, [enriched]);

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

  // Durum sayımları BAYATSIZ (API'nin counts'u ile aynı mantık).
  const counts = useMemo(() => {
    const sel = enriched.filter((i: any) => firms.includes(i.retailer) && !i.stale);
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
      // Bayatlar en sona: listede kalırlar ama aksiyon sırasını kirletmezler.
      if (!!a.stale !== !!b.stale) return a.stale ? 1 : -1;
      if (a.status !== b.status) return ord[a.status] - ord[b.status];
      return a.status === "kritik"
        ? (a.coverage ?? 0) - (b.coverage ?? 0)
        : (b.coverage ?? 1e9) - (a.coverage ?? 1e9);
    });
  }, [enriched, firms, status, brands, teams, types, covMin, covMax, search, sortKey, sortDir]);

  // MANŞET: görünen listenin PSF stok değeri — BAYAT satırlar hariç (yoksa toplam
  // gerçeğin üstünde kalır). Bayatların toplamı ayrı küçük satırda gösterilir.
  const shownLive = useMemo(() => (items as any[]).filter((i) => !i.stale), [items]);
  const shownStale = useMemo(() => (items as any[]).filter((i) => i.stale), [items]);
  const itemsValue = useMemo(() => shownLive.reduce((a, i) => a + (i.stock_value || 0), 0), [shownLive]);
  const staleValue = useMemo(() => shownStale.reduce((a, i) => a + (i.stock_value || 0), 0), [shownStale]);
  const staleUnits = useMemo(() => shownStale.reduce((a, i) => a + (i.last_stock || 0), 0), [shownStale]);

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

  const durumCsvRows = useMemo(
    () =>
      (items as any[]).map((r) => ({
        firma: r.retailer, urun: r.sku_name, barkod: r.barkod ?? "",
        haftalik_hiz: fmt1(r.avg_weekly), stok: r.last_stock,
        stok_degeri_psf: r.stock_value ?? 0,
        kac_hafta: r.coverage == null ? "" : fmt1(r.coverage),
        durum: STATUS[r.status]?.label ?? r.status,
        bayat: r.kapali ? "KAPANDI" : r.stale ? "FIRMA RAPORUNDA YOK" : "",
        son_gorulme: r.stale ? (r.last_seen ?? `${winWeeks}+ hf önce`) : "",
        veri_haftasi: r.dataWeek ?? "",
        tahmini_stok: r.drenaj ? r.stokYaslandirilmis ?? "" : "",
      })),
    [items, winWeeks]
  );

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
          <CsvBtn
            filename="cortex-stok-durumu"
            rows={durumCsvRows}
            cols={[
              { key: "firma", label: "Firma" }, { key: "urun", label: "Ürün" }, { key: "barkod", label: "Barkod" },
              { key: "haftalik_hiz", label: `Haftalık Hız (son ${velWeeks} hf)` }, { key: "stok", label: "Stok" },
              { key: "stok_degeri_psf", label: "Stok Değeri (PSF)" },
              { key: "kac_hafta", label: "Kaç Hafta Yeter" }, { key: "durum", label: "Durum" },
              { key: "bayat", label: "Kapsam dışı" }, { key: "son_gorulme", label: "Son Görülme" },
              { key: "veri_haftasi", label: "Veri haftası" }, { key: "tahmini_stok", label: "Tahmini stok" },
            ]}
            label="⬇ CSV indir"
          />
        )}
      </div>

      {/* Görünüm sekmeleri */}
      <div className="flex gap-1 flex-wrap border-b border-line">
        {viewTabs.map((t) => (
          <button key={t.id} onClick={() => setView(t.id)}
            className={`mono text-sm px-4 py-2 -mb-px border-b-2 hover:transition-colors ${view === t.id ? "border-neon text-neon" : "border-transparent text-txt-dim hover:text-txt"}`}>
            {t.label}
          </button>
        ))}
      </div>

      {err && <div className="card p-4 border-red-500/40 text-red-400 mono text-sm">Veri alınamadı: {err}</div>}

      {/* ═════════ 1) STOK DURUMU ═════════ */}
      {view === "durum" && (
        <>
          {/* Hız/kapsam ölçütü ve bayat uyarısı — kullanıcı neyi gördüğünü bilsin. */}
          <p className="text-txt-dim mono text-xs">
            Kapsam = stok ÷ <span className="text-txt">son {velWeeks} haftalık</span> satış hızı ·
            &lt;{COVERAGE_LOW} hf sipariş, &gt;{COVERAGE_HIGH} hf kampanya
            {data?.stale?.n ? (
              <> · <span style={{ color: "#f8b00b" }}>{data.stale.n} kalem firma raporunda yok</span> ({fmtInt(data.stale.stock)} adet) toplamlardan çıkarıldı</>
            ) : null}
            {data?.kapali?.n ? (
              <> · <span className="text-txt-dim">{data.kapali.n} kapalı kalem</span> ({fmtInt(data.kapali.stock)} adet) listede ama sayımlarda değil</>
            ) : null}
          </p>

          {/* VERİ YAŞI BANDI — hangi firmanın stoğu kaç haftalık.
              "Tahmini" kolonu bu gecikmeden türüyor; kolonu açıklamayan bir
              tahmin, kaynağı belirsiz bir sayıdan farksız olur. */}
          {data?.veri?.byRetailer?.length > 0 && (
            <div className="card p-3">
              <div className="mono text-[10px] tracking-wider text-txt-dim mb-1">
                STOK VERİSİNİN YAŞI · karar haftası {data.veri.takvimHaftasi}
              </div>
              <div className="flex flex-wrap gap-x-4 gap-y-1">
                {data.veri.byRetailer.map((r: any) => (
                  <span key={r.retailer} className="mono text-[11px]">
                    <span style={{ color: COLORS[r.retailer] ?? "#7d927d" }}>{r.retailer}</span>{" "}
                    <span className="text-txt-dim">{r.dataWeek ?? "veri yok"}</span>
                    {r.gecikmeHf >= 2 && (
                      <span style={{ color: "#f8b00b" }}> · {r.gecikmeHf} hf geride</span>
                    )}
                  </span>
                ))}
              </div>
              <div className="mono text-[10px] text-txt-dim mt-1">
                Durum etiketleri ve sayımlar RAPORLANAN stokla hesaplanır; &quot;tahmini&quot; kolonu
                yalnız bilgi amaçlıdır (raporlanan stok − hız × gecikme).
              </div>
            </div>
          )}

          {/* AŞIRI STOK (fazla) PSF değeri — firma başına bağlı tutar; tıkla → o firmayı+fazlayı süz */}
          {Object.keys(overstockValue).length > 0 && (
            <div className="space-y-2">
              <div className="mono text-[11px] text-txt-dim tracking-wider">AŞIRI STOK DEĞERİ (PSF) · firma başına bağlı tutar · tıkla → süz</div>
              <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
                {Object.entries(overstockValue).sort((a, b) => b[1] - a[1]).map(([f, v]) => {
                  const on = firms.length === 1 && firms[0] === f && status === "fazla";
                  return (
                    <button key={f} onClick={() => { setFirms([f]); setStatus("fazla"); }}
                      className="card p-4 text-left hover:border-neon/50"
                      style={on ? { borderColor: "#f8b00b80", background: "#f8b00b12" } : undefined}
                      title={`${f} aşırı stok toplamı — tıkla: bu firma + fazla stok`}>
                      <div className="mono text-[10px] tracking-wider" style={{ color: colorOf(f) }}>{f.toUpperCase()}</div>
                      <div className="text-xl font-bold mono mt-1" style={{ color: "#f8b00b" }}>{fmtMoney(v)}</div>
                    </button>
                  );
                })}
              </div>
            </div>
          )}
          <div className="card p-4 space-y-3">
            <MultiChips label="Firmalar:" options={allFirms} selected={firms}
              onToggle={toggleFirm} colorOf={(f) => COLORS[f] ?? "#1FF80B"}
              onAll={() => setFirms(allFirms)} onNone={() => setFirms([])} />
            <div className="flex items-center gap-2 flex-wrap">
              <SegTabs tabs={statusTabs} active={status} onChange={setStatus} />
              <div className="flex-1 min-w-48">
                <SearchBox value={search} onChange={setSearch} placeholder="ürün / barkod…" />
              </div>
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
                    className="mono text-[11px] text-txt-dim hover:text-neon hover:transition-colors">
                    ✕ filtreyi temizle
                  </button>
                )}
              </div>
            </div>
          </div>

          {loading ? (
            <div className="card card-flat p-10 text-center mono text-txt-dim">Yükleniyor…</div>
          ) : err || !data ? null : (
            <div className="card p-6">
              <div className="flex items-center justify-between mb-3 flex-wrap gap-2">
                <h2 className="font-bold">{status === "kritik" ? "Az stok (sipariş gerekebilir)" : status === "fazla" ? "Fazla stok (kampanya)" : status === "saglikli" ? "Sağlıklı" : "Tüm stok durumu"}</h2>
                <span className="mono text-xs text-txt-dim">
                  {durumFiltered ? `${items.length} / ${scopeTotal}` : `${items.length}`} kalem · <span style={{ color: "#f8b00b" }}>{fmtMoney(itemsValue)} PSF</span>
                </span>
              </div>
              {/* Bayatların toplamı AYRI satırda — manşetten çıkarıldığı görünür olsun. */}
              {shownStale.length > 0 && (
                <div className="mono text-[11px] text-txt-dim mb-3 pb-2 border-b border-line/60">
                  ⚠ bunun dışında <span className="text-txt">{shownStale.length} kalem firmanın raporunda yok</span> ({fmtInt(staleUnits)} adet ·{" "}
                  {fmtMoney(staleValue)} PSF) listede en altta gösteriliyor — güncel raporlarda olmadığı için toplama eklenmedi.
                </div>
              )}
              {items.length ? (
                <div className="overflow-x-auto">
                  <table>
                    <thead>
                      <tr>
                        <th>#</th><th>Firma</th><th>Ürün</th>
                        <SortableTh label={`Hız (son ${velWeeks} hf)`} sortKey="avg_weekly" align="right"
                          active={sortKey === "avg_weekly"} dir={sortDir} onClick={toggleDurumSort} />
                        <SortableTh label="Stok" sortKey="last_stock" align="right"
                          active={sortKey === "last_stock"} dir={sortDir} onClick={toggleDurumSort} />
                        <th className="text-right">Tahmini</th>
                        <SortableTh label="Stok Değeri (PSF)" sortKey="stock_value" align="right"
                          active={sortKey === "stock_value"} dir={sortDir} onClick={toggleDurumSort} />
                        <SortableTh label="Kaç Hafta Yeter" sortKey="coverage" align="right"
                          active={sortKey === "coverage"} dir={sortDir} onClick={toggleDurumSort} />
                        <th>Durum</th>
                      </tr>
                    </thead>
                    <tbody>
                      {items.map((r: any, i: number) => {
                        const st = STATUS[r.status] ?? STATUS.saglikli;
                        return (
                          <tr key={i} className={r.stale ? "opacity-60" : undefined}>
                            <td className="mono text-txt-dim">{i + 1}</td>
                            <td>
                              <span className="mono text-[10px] px-1.5 py-0.5 rounded" style={{ color: COLORS[r.retailer] ?? "#7d927d", border: `1px solid ${COLORS[r.retailer] ?? "#7d927d"}40` }}>{r.retailer}</span>
                            </td>
                            <td className="max-w-[340px] truncate" title={(r.barkod ? r.barkod + " · " : "") + r.sku_name}>{r.sku_name}</td>
                            <td className="mono text-right">{fmt1(r.avg_weekly)}</td>
                            <td className="mono text-right">{fmtInt(r.last_stock)}</td>
                            {/* TAHMİNİ = raporlanan − hız×gecikme. /yonlendirme ile
                                AYNI değer (aynı saf fonksiyon, aynı ağ dalı).
                                Erimemiş satırda "—" yazılır; raporlanan sayıyı
                                tekrar basmak iki kolonu aynı yapardı. */}
                            <td className="mono text-right text-txt-dim text-[11px]">
                              {r.drenaj ? fmtInt(r.stokYaslandirilmis ?? 0) : "—"}
                            </td>
                            <td className="mono text-right" style={{ color: "#f8b00b" }}>{r.stock_value ? fmtMoney(r.stock_value) : "—"}</td>
                            <td className="mono text-right">{r.coverage == null ? "—" : `${fmt1(r.coverage)} hf`}</td>
                            <td>
                              {r.kapali
                                ? <KapaliBadge neden={r.kapaliNeden} tarih={r.kapaliTarih} />
                                : r.stale
                                  ? <StaleBadge lastSeen={r.last_seen} windowWeeks={winWeeks} />
                                  : <span className={`mono text-[10px] px-2 py-0.5 rounded border ${st.cls}`}>{st.label}</span>}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
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
      {view === "olu" && <DeadStockView products={data?.products ?? []} loading={loading} velWeeks={velWeeks} winWeeks={winWeeks} />}
    </div>
  );
}

// ═══════════════════════ STOK SÜRESİ (COVERAGE) GÖRÜNÜMÜ ═══════════════════════
// Kapsam: Firma geneli / Mağaza. Firma seçilince mağaza listesi /api/stores'tan
// gelir; mağaza seçilince o mağazanın anlık coverage'ı /api/stock?retailer&store
// üzerinden çekilir.
type CovStatus = "kritik" | "fazla" | "saglikli";
interface Sku {
  sku_name: string; avg_weekly: number; last_stock: number;
  coverage: number | null; status: CovStatus; stale?: boolean; last_seen?: string | null;
}

// Etiket ve renk EŞİK SABİTLERİNDEN türer (elle yazılmış "8"/"30" yok).
const COV_META: Record<CovStatus, { label: string; color: string }> = {
  kritik: { label: COVERAGE_LABELS.kritik, color: "#ff5555" },
  fazla: { label: COVERAGE_LABELS.fazla, color: "#f8b00b" },
  saglikli: { label: COVERAGE_LABELS.saglikli, color: "#1FF80B" },
};
const fmtCov = (c: number | null) => (c == null ? "satmıyor" : c.toFixed(1) + " hf");

function CoverageView() {
  const [retailer, setRetailer] = useState<string>(RETAILERS[3] ?? RETAILERS[0]); // Toyzz varsayılan
  const [store, setStore] = useState<string>(""); // "" = firma geneli
  const [stores, setStores] = useState<string[]>([]);
  const [data, setData] = useState<any>(null);
  // Ekrandaki verinin firma|mağaza anahtarı. Eskiden yalnız kartlar
  // soluklaşıyordu; eski firmanın satırları tam parlaklıkta kalıyordu.
  const [veriAnahtari, setVeriAnahtari] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [filter, setFilter] = useState<"all" | CovStatus | "bayat">("all");

  // Mağaza listesi (store-level perakendeciler için)
  useEffect(() => {
    let iptal = false;
    setStore("");
    izle(fetch(`/api/stores?retailer=${encodeURIComponent(retailer)}`))
      .then((r) => r.json()).then((d) => {
        if (iptal) return;
        setStores(d?.storeLevel && Array.isArray(d?.stores) ? d.stores.map((s: any) => s.store) : []);
      }).catch(() => { if (!iptal) setStores([]); });
    return () => { iptal = true; };
  }, [retailer]);

  // Coverage verisi (firma geneli veya mağaza özelinde)
  const anahtar = `${retailer}|${store}`;
  useEffect(() => {
    // Firma değişince mağaza da sıfırlandığı için iki istek çıkıyor; geç dönen
    // eskisi yenisini ezmesin.
    let iptal = false;
    const k = `${retailer}|${store}`;
    setLoading(true);
    const url = `/api/stock?retailer=${encodeURIComponent(retailer)}${store ? `&store=${encodeURIComponent(store)}` : ""}`;
    fetchJson(url)
      .then((d) => { if (iptal) return; setData(d); setVeriAnahtari(k); setErr(null); })
      .catch((e) => { if (iptal) return; setErr(e.message); setData(null); setVeriAnahtari(null); })
      .finally(() => { if (!iptal) setLoading(false); });
    return () => { iptal = true; };
  }, [retailer, store]);
  const bekliyor = data != null && veriAnahtari !== anahtar;

  const skus: Sku[] = data?.skus ?? [];
  const velWeeks: number = data?.velocity_weeks ?? VELOCITY_WEEKS;
  const winWeeks: number = data?.window_weeks ?? 12;
  const shown =
    filter === "all" ? skus
      : filter === "bayat" ? skus.filter((s) => s.stale)
        : skus.filter((s) => s.status === filter && !s.stale);

  const csvRows = useMemo(
    () =>
      shown.map((s) => ({
        sku: s.sku_name, haftalik_hiz: fmt1(s.avg_weekly),
        stok: s.last_stock, coverage_hafta: s.coverage == null ? "" : fmt1(s.coverage),
        durum: s.stale ? "BAYAT (listeden düştü)" : COV_META[s.status].label,
        son_gorulme: s.stale ? (s.last_seen ?? `${winWeeks}+ hf önce`) : "",
      })),
    [shown, winWeeks]
  );

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
        <CsvBtn
          filename={`cortex-stok-suresi-${retailer}${store ? "-" + store : ""}`}
          rows={csvRows}
          cols={[
            { key: "sku", label: "Ürün" }, { key: "haftalik_hiz", label: `Haftalık Hız (son ${velWeeks} hf)` },
            { key: "stok", label: "Stok" }, { key: "coverage_hafta", label: "Coverage (hafta)" },
            { key: "durum", label: "Durum" }, { key: "son_gorulme", label: "Son Görülme" },
          ]}
        />
      </div>

      {/* VERI YASI BANDI. Uc `veri: { takvimHaftasi, dataWeek, gecikmeHf }` zaten
          gonderiyordu, ekran hic okumuyordu: Nezih secildiginde 5 hafta eski stok
          fotografi tarihsiz ve uyarisiz kapsam hesabina giriyordu. */}
      {data?.veri?.dataWeek && (
        <p className="mono text-xs" style={data.veri.gecikmeHf >= GECIKME_ROZET ? { color: "#f8b00b" } : undefined}>
          Stok verisi {fmtHafta(data.veri.dataWeek, data.veri.takvimHaftasi)} haftasından
          {data.veri.gecikmeHf > 0 ? ` · ${data.veri.gecikmeHf} hf geride` : ""}
          {" · "}karar haftası {fmtDate(data.veri.takvimHaftasi)}
        </p>
      )}

      <p className="text-txt-dim mono text-xs">
        Stok ÷ son {velWeeks} haftalık satış hızı · &lt;{COVERAGE_LOW} hafta sipariş, &gt;{COVERAGE_HIGH} hafta kampanya
        {store ? ` · mağaza: ${store}` : " · firma geneli"}
        {data?.summary?.bayat ? ` · ${data.summary.bayat} bayat kalem sayımlardan çıkarıldı` : ""}
      </p>

      {err && <div className="card p-4 border-red-500/40 text-red-400 mono text-sm">Veri alınamadı: {err}</div>}

      {/* Özet kartları (tıkla → filtrele) — yeni kapsam yüklenirken eski sayılar soluk */}
      <div className="grid grid-cols-2 md:grid-cols-5 gap-3 cx-soluk" {...bekleme(bekliyor)}>
        <SummaryCard label="TÜM SKU" value={data?.summary?.toplam ?? 0} active={filter === "all"} onClick={() => setFilter("all")} color="#7d927d" />
        <SummaryCard label="AZ STOK · SİPARİŞ" value={data?.summary?.kritik ?? 0} active={filter === "kritik"} onClick={() => setFilter("kritik")} color="#ff5555" />
        <SummaryCard label="SAĞLIKLI" value={data?.summary?.saglikli ?? 0} active={filter === "saglikli"} onClick={() => setFilter("saglikli")} color="#1FF80B" />
        <SummaryCard label="FAZLA · KAMPANYA" value={data?.summary?.fazla ?? 0} active={filter === "fazla"} onClick={() => setFilter("fazla")} color="#f8b00b" />
        <SummaryCard
          label={`BAYAT · ${fmtInt(data?.summary?.bayat_stok ?? 0)} ADET`}
          value={data?.summary?.bayat ?? 0} active={filter === "bayat"} onClick={() => setFilter("bayat")} color="#7d927d" />
      </div>

      <div className="card p-6 cx-soluk" {...bekleme(bekliyor)}>
        <div className="flex items-center justify-between mb-3">
          <h2 className="font-bold">
            {filter === "all" ? "Tüm SKU" : filter === "bayat" ? "Bayat · güncel raporda yok" : COV_META[filter].label}
          </h2>
          <span className="mono text-xs text-txt-dim">
            {filter === "all" ? `${fmtInt(shown.length)}` : `${fmtInt(shown.length)} / ${fmtInt(skus.length)}`} SKU
          </span>
        </div>
        {loading && !data ? (
          <div className="text-center mono text-txt-dim py-6">Yükleniyor…</div>
        ) : shown.length === 0 ? (
          <div className="text-center mono text-sm text-txt-dim py-6">
            {skus.length === 0 ? "Bu seçim için veri yok." : (
              <>Bu filtrede SKU yok. <button onClick={() => setFilter("all")} className="text-neon hover:underline">Tümünü göster</button> ({fmtInt(skus.length)} SKU var).</>
            )}
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table>
              <thead>
                <tr>
                  <th>Ürün</th><th>Hız (son {velWeeks} hf)</th><th>Stok</th><th>Coverage</th><th>Durum</th>
                </tr>
              </thead>
              <tbody>
                {shown.slice(0, 500).map((s, i) => {
                  const m = COV_META[s.status];
                  return (
                    <tr key={s.sku_name + i}
                      className={s.stale ? "opacity-60" : undefined}>
                      <td className="max-w-md truncate" title={s.sku_name}>{s.sku_name}</td>
                      <td className="mono">{fmt1(s.avg_weekly)}</td>
                      <td className="mono">{fmtInt(s.last_stock)}</td>
                      <td className="mono font-bold" style={{ color: s.stale ? "#7d927d" : m.color }}>{fmtCov(s.coverage)}</td>
                      <td>
                        {s.stale ? <StaleBadge lastSeen={s.last_seen} windowWeeks={winWeeks} /> : (
                          <span className="mono text-xs px-2 py-0.5 rounded whitespace-nowrap"
                            style={{ color: m.color, border: `1px solid ${m.color}40` }}>{m.label}</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        {shown.length > 500 && (
          <div className="mono text-[11px] text-txt-dim mt-3">İlk 500 gösteriliyor ({shown.length} toplam). Tümü için CSV indir.</div>
        )}
      </div>
    </div>
  );
}

// Tıklanabilir KPI kartı — StatCard salt-görüntü olduğu için (onClick/aktif kenar
// yok) filtre kartlarında bu yerel sürüm korunur.
function SummaryCard({ label, value, active, onClick, color }: {
  label: string; value: number; active: boolean; onClick: () => void; color: string;
}) {
  return (
    <button onClick={onClick}
      className={`card p-4 text-left ${active ? "border-neon" : "hover:border-line"}`}
      style={active ? { borderColor: color } : undefined}>
      <div className="mono text-[10px] text-txt-dim tracking-wider">{label}</div>
      <div className="text-2xl font-bold mono mt-1" style={{ color }}>{value.toLocaleString("tr-TR")}</div>
    </button>
  );
}

// ═══════════════════════ ÖLÜ STOK GÖRÜNÜMÜ ═══════════════════════
// Ağ geneli ürün satırı tıklanınca firma kırılımı açılır. Kaynak: parametresiz
// /api/stock yanıtındaki products (groupDeadStock).
interface DSFirm {
  retailer: string; sku_name?: string; stock: number; velocity: number;
  coverage: number | null; stale?: boolean;
}
interface DSProduct {
  product_key: string; barkod: string | null; name: string;
  total_stock: number; total_velocity: number; coverage: number | null;
  never_sold: boolean; stale?: boolean; stale_stock?: number; firms: DSFirm[];
}

const fmtDeadCov = (c: number | null, neverSold: boolean) =>
  neverSold ? "∞ satmıyor" : c == null ? "—" : c.toFixed(0) + " hf";
// Renk eşikleri compute.ts sabitlerinden — daha önce 120/60 sihirli sayı olarak gömülüydü.
const covColor = (c: number | null, neverSold: boolean) =>
  neverSold ? "#ff5555" : c == null ? "#7d927d"
    : c > DEAD_STOCK_HIGH_WEEKS ? "#ff5555" : c > DEAD_STOCK_MIN_WEEKS ? "#f8b00b" : "#1FF80B";

// ∞ (hiç satmayan) için sıralama sentineli: Infinity kullanılamaz — paylaşılan
// useSort'un karşılaştırıcısı a-b döndürüyor ve Infinity-Infinity = NaN sıralamayı
// bozar. MAX_SAFE_INTEGER ile iki ∞ eşit sayılır, giriş sırası (stok azalan) korunur.
const COV_SENTINEL = Number.MAX_SAFE_INTEGER;

function DeadStockView({ products, loading, velWeeks, winWeeks }: {
  products: DSProduct[]; loading: boolean; velWeeks: number; winWeeks: number;
}) {
  const [q, setQ] = useState("");
  const [retailer, setRetailer] = useState(""); // "" = ağ geneli (tüm firmalar birleşik)
  const [minWeeks, setMinWeeks] = useState(DEAD_STOCK_MIN_WEEKS);
  const [includeNeverSold, setIncludeNeverSold] = useState(true);
  const [open, setOpen] = useState<string | null>(null);

  // Seçili firmaya / ağa göre her ürün için gösterilecek değerler + filtre.
  // Satır DÜZLEŞTİRİLİR (name/barkod/cov_sort üstte) → paylaşılan useSort doğrudan
  // çalışır; eskiden buradaki yerel SortTh + switch/case ile ikinci bir sıralama
  // sistemi vardı.
  const rows = useMemo(() => {
    const term = q.trim().toLocaleLowerCase("tr-TR");
    const mapped = products.map((p) => {
      let stock: number, velocity: number, coverage: number | null, neverSold: boolean, firmName: string, stale: boolean;
      if (retailer) {
        const f = p.firms.find((x) => x.retailer === retailer);
        if (!f) return null;
        stock = f.stock; velocity = f.velocity; coverage = f.coverage;
        neverSold = f.coverage == null && f.stock > 0;
        firmName = f.sku_name ?? p.name; // firma adı ürün adıyla aynıysa yanıtta tekrar edilmiyor
        stale = !!f.stale;
      } else {
        stock = p.total_stock; velocity = p.total_velocity; coverage = p.coverage;
        neverSold = p.never_sold; firmName = p.name; stale = !!p.stale;
      }
      return {
        p, stock, velocity, coverage, neverSold, firmName, stale,
        name: p.name, barkod: p.barkod ?? "", firms_count: p.firms.length,
        cov_sort: neverSold ? COV_SENTINEL : coverage ?? -1,
      };
    }).filter(Boolean) as {
      p: DSProduct; stock: number; velocity: number; coverage: number | null; neverSold: boolean;
      firmName: string; stale: boolean; name: string; barkod: string; firms_count: number; cov_sort: number;
    }[];

    return mapped
      .filter((r) => {
        if (r.stock <= 0) return false;
        const passCov = r.neverSold ? includeNeverSold : (r.coverage != null && r.coverage >= minWeeks);
        if (!passCov) return false;
        if (term) {
          const hay = (r.p.name + " " + r.firmName + " " + (r.p.barkod ?? "")).toLocaleLowerCase("tr-TR");
          if (!hay.includes(term)) return false;
        }
        return true;
      })
      // Ön sıralama: eşitlikte (iki ∞) stok azalan kalsın — Array.sort kararlı.
      .sort((a, b) => b.stock - a.stock);
  }, [products, q, retailer, minWeeks, includeNeverSold]);

  const { sorted: shown, sortKey, dir, toggle } = useSort(rows, "cov_sort", "desc");

  const totalUnits = shown.reduce((a, r) => a + r.stock, 0);
  const staleUnits = shown.reduce((a, r) => a + (r.stale ? r.stock : 0), 0);
  // Seçili kapsamda (firma/ağ) stoklu ürün sayısı — "X / Y" sayacının paydası.
  const scopeCount = useMemo(() => {
    if (!retailer) return products.filter((p) => p.total_stock > 0).length;
    return products.filter((p) => (p.firms.find((f) => f.retailer === retailer)?.stock ?? 0) > 0).length;
  }, [products, retailer]);

  const csvRows = useMemo(
    () =>
      shown.map((r) => ({
        urun: r.p.name, barkod: r.p.barkod ?? "", kapsam: retailer || "ağ geneli",
        stok: Math.round(r.stock), hiz: fmt1(r.velocity),
        coverage_hf: r.neverSold ? "∞" : r.coverage == null ? "" : String(Math.round(r.coverage)),
        firma_sayisi: r.p.firms.length,
        bayat: r.stale ? "BAYAT" : "",
      })),
    [shown, retailer]
  );

  return (
    <div className="space-y-5">
      <div className="flex items-end justify-between flex-wrap gap-4">
        <p className="text-txt-dim mono text-sm">
          Stok ÷ son {velWeeks} haftalık hız &gt; {minWeeks} hafta · {retailer || "tüm firmalar birleşik"} · hiç satmayan = ∞ · ürün satırına tıkla → firma kırılımı
        </p>
        <CsvBtn
          filename={`cortex-olu-stok${retailer ? "-" + retailer : ""}`}
          rows={csvRows}
          cols={[
            { key: "urun", label: "Ürün" }, { key: "barkod", label: "Barkod" }, { key: "kapsam", label: "Kapsam" },
            { key: "stok", label: "Stok" }, { key: "hiz", label: `Haftalık Hız (son ${velWeeks} hf)` },
            { key: "coverage_hf", label: "Coverage (hf)" }, { key: "firma_sayisi", label: "Firma Sayısı" },
            { key: "bayat", label: "Bayat" },
          ]}
        />
      </div>

      {/* Özet */}
      <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
        <StatCard label="ÖLÜ STOK ÜRÜNÜ" value={<>{fmtInt(shown.length)}<span className="text-sm text-txt-dim"> / {fmtInt(scopeCount)}</span></>} />
        <StatCard label="TAKILI STOK" value={<>{fmtInt(totalUnits)} <span className="text-sm text-txt-dim">adet</span></>} color="#ff5555"
          sub={staleUnits > 0 ? `${fmtInt(staleUnits)} adedi bayat (güncel raporda yok)` : undefined} />
        <StatCard label="EŞİK" value={<>&gt; {minWeeks} hafta</>} color="#e7ffe7"
          sub={includeNeverSold ? "+ hiç satmayan" : undefined} />
      </div>

      {/* Filtreler */}
      <div className="card p-4 flex flex-wrap items-center gap-3">
        <div className="flex-1 min-w-[200px]">
          <SearchBox value={q} onChange={setQ} placeholder="Ürün adı / barkod ara…" />
        </div>
        <select value={retailer} onChange={(e) => setRetailer(e.target.value)}
          className="mono text-sm px-3 py-2 rounded-lg bg-ink-2 border border-line outline-none focus:border-neon">
          <option value="" className="bg-ink-2">Tüm firmalar (ağ)</option>
          {RETAILERS.map((r) => <option key={r} value={r} className="bg-ink-2">{r}</option>)}
        </select>
        <RangeMin label="min hafta" value={minWeeks} onChange={setMinWeeks} step={10} />
        <label className="mono text-xs text-txt-dim flex items-center gap-2 cursor-pointer select-none">
          <input type="checkbox" checked={includeNeverSold} onChange={(e) => setIncludeNeverSold(e.target.checked)} className="accent-neon" />
          hiç satmayanları dahil et
        </label>
      </div>

      <div className="card p-6">
        {loading ? (
          <div className="text-center mono text-txt-dim py-6">Yükleniyor…</div>
        ) : shown.length === 0 ? (
          <div className="text-center mono text-sm text-txt-dim py-6">
            {scopeCount > 0 ? (
              <>Bu filtrede ölü stok yok. <button onClick={() => { setQ(""); setMinWeeks(0); setIncludeNeverSold(true); }} className="text-neon hover:underline">Filtreyi gevşet</button> ({fmtInt(scopeCount)} stoklu ürün var).</>
            ) : (
              "Bu kapsamda stoklu ürün yok."
            )}
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table>
              <thead>
                <tr>
                  <SortableTh label="Ürün" sortKey="name" active={sortKey === "name"} dir={dir} onClick={toggle} />
                  <SortableTh label="Barkod" sortKey="barkod" active={sortKey === "barkod"} dir={dir} onClick={toggle} />
                  <SortableTh label="Stok" sortKey="stock" align="right" active={sortKey === "stock"} dir={dir} onClick={toggle} />
                  <SortableTh label={`Hız (son ${velWeeks} hf)`} sortKey="velocity" align="right" active={sortKey === "velocity"} dir={dir} onClick={toggle} />
                  <SortableTh label="Coverage" sortKey="cov_sort" align="right" active={sortKey === "cov_sort"} dir={dir} onClick={toggle} />
                  <SortableTh label="Firma" sortKey="firms_count" align="center" active={sortKey === "firms_count"} dir={dir} onClick={toggle} />
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {shown.slice(0, 600).map((r, i) => {
                  const isOpen = open === r.p.product_key;
                  const cc = covColor(r.coverage, r.neverSold);
                  return (
                    <Fragment key={r.p.product_key}>
                      <tr
                        className="cursor-pointer" onClick={() => setOpen(isOpen ? null : r.p.product_key)}>
                        <td className="max-w-sm truncate" title={r.p.name}>
                          {r.p.name}
                          {r.stale && <span className="ml-2 align-middle"><StaleBadge lastSeen={null} windowWeeks={winWeeks} /></span>}
                        </td>
                        <td className="mono text-[11px] text-txt-dim">{r.p.barkod ?? "—"}</td>
                        <td className="text-right mono font-bold">{fmtInt(r.stock)}</td>
                        <td className="text-right mono">{fmt1(r.velocity)}</td>
                        <td className="text-right mono font-bold" style={{ color: cc }}>{fmtDeadCov(r.coverage, r.neverSold)}</td>
                        <td className="text-center">
                          <div className="flex justify-center gap-1">
                            {r.p.firms.map((f) => <span key={f.retailer} className="inline-block w-2 h-2 rounded-full" title={f.retailer} style={{ background: col(f.retailer) }} />)}
                          </div>
                        </td>
                        <td className="text-right mono text-txt-dim">{isOpen ? "▾" : "▸"}</td>
                      </tr>
                      {isOpen && (
                        <tr key={r.p.product_key + "-d"}>
                          <td colSpan={7} className="!p-0">
                            <div className="bg-ink-2/50 px-4 py-3">
                              <div className="mono text-[11px] text-txt-dim mb-2">{r.p.firms.length} firmada · firma içi stok / hız / coverage</div>
                              <div className="space-y-1">
                                {r.p.firms.map((f) => {
                                  const fns = f.coverage == null && f.stock > 0;
                                  return (
                                    <div key={f.retailer} className={`flex items-center gap-3 text-[12px] mono py-1 border-b border-line/40 ${f.stale ? "opacity-60" : ""}`}>
                                      <span className="w-24 shrink-0 font-semibold flex items-center gap-2" style={{ color: col(f.retailer) }}>
                                        <span className="inline-block w-2 h-2 rounded-full" style={{ background: col(f.retailer) }} />{f.retailer}
                                      </span>
                                      <span className="flex-1 truncate text-txt-dim" title={f.sku_name ?? r.p.name}>
                                        {f.sku_name ?? r.p.name}{f.stale ? " · ⚠ bayat" : ""}
                                      </span>
                                      <span className="w-24 shrink-0 text-right">{fmtInt(f.stock)} adet</span>
                                      <span className="w-24 shrink-0 text-right text-txt-dim">{fmt1(f.velocity)}/hf</span>
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
          </div>
        )}
        {shown.length > 600 && <div className="mono text-[11px] text-txt-dim mt-3">İlk 600 gösteriliyor ({shown.length} toplam). Tümü için CSV indir.</div>}
      </div>
    </div>
  );
}
