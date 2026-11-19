"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend,
} from "recharts";
import { fmtInt, fmtMoney, fmtPct, fmtDate, fmtHafta, colorOf, RETAILER_COLORS } from "@/lib/format";
import { parseProductMeta, sonTamamlanmisHafta, gecikmeHaftasi, GECIKME_ROZET } from "@/lib/compute";
import { fetchJson } from "@/lib/fetchJson";
import { bekleme } from "@/lib/hareket";
import { GecenYilUrun } from "@/components/GecenYilUrun";
import { useAsistanBaglami } from "@/lib/asistan-baglam";
import { aile } from "@/lib/urun-ailesi";
import { SortableTh, SearchBox, MultiChips, SegTabs, useSort, CsvBtn, StatCard } from "@/components/Controls";

const COLORS = RETAILER_COLORS;

// Metrik: adet & stok her ürün-firmada var; ciro yalnız ciro-veren firmalarda.
type Metric = "qty" | "val" | "stock";
// Hafta penceresi (son N hafta) — "0" = tümü.
type RangeId = "8" | "13" | "26" | "0";

// API totals satırı (pivotProduct çıktısı). series ise haftalık YALNIZ adet taşır.
// last_week: O FİRMANIN bu ürünü en son raporladığı hafta — ağın son haftası
// değil. Stok kolonu bu tarihin fotoğrafıdır; tabloda yazılmazsa 5 hafta önceki
// bir stok bugünkülerle aynı sütunda, aynı yaşta sanılıyor.
interface TotalRow {
  retailer: string; total_qty: number; total_val: number;
  last_stock: number; last_week: string | null;
}
// Tabloyu sıralamak için pay% ve veri yaşı ile zenginleştirilmiş satır.
interface TotalRowX extends TotalRow { share: number; gecikmeHf: number; bayat: boolean }

const METRIC_TABS: { id: Metric; label: string }[] = [
  { id: "qty", label: "Adet" },
  { id: "val", label: "Ciro" },
  { id: "stock", label: "Stok" },
];
const RANGE_TABS: { id: RangeId; label: string }[] = [
  { id: "8", label: "8 hf" },
  { id: "13", label: "13 hf" },
  { id: "26", label: "26 hf" },
  { id: "0", label: "Tümü" },
];

// Metriğe göre totals alanını seç (ciro/stok kart & bar & sıralama için).
const metricVal = (t: TotalRow, m: Metric): number =>
  m === "val" ? t.total_val : m === "stock" ? t.last_stock : t.total_qty;
const metricFmt = (n: number, m: Metric): string => (m === "val" ? fmtMoney(n) : fmtInt(n));
const metricNoun = (m: Metric): string => (m === "val" ? "ciro" : m === "stock" ? "stok" : "adet");

export default function ProductPage() {
  const [q, setQ] = useState("");
  const [results, setResults] = useState<any[]>([]);
  const [selected, setSelected] = useState<any>(null);
  const [searching, setSearching] = useState(false);
  const [err, setErr] = useState("");
  // Barkod taraması özeti: kaç barkod arandı, hangileri hiçbir ürüne denk gelmedi.
  const [tarama, setTarama] = useState<{ barkodlar: string[]; bulunamayan: string[]; atlanan: string[]; toplam: number; kesildi: boolean } | null>(null);
  // Otomatik seçimde "bu ürün zaten açık mı?" kontrolü için güncel seçim (effect
  // closure'ı eski `selected`ı görür; ref her zaman günceldir).
  const seciliBarkod = useRef<string | null>(null);

  // ── İstemci-tarafı görünüm durumu (seçili ürünün ZATEN çekilmiş verisi üzerinde) ──
  const [metric, setMetric] = useState<Metric>("qty");
  const [range, setRange] = useState<RangeId>("0");
  const [visible, setVisible] = useState<string[]>([]); // grafikte/tabloda görünecek perakendeciler

  // Debounced arama. Ürün adı, barkod ya da virgülle ayrılmış birden çok barkod
  // (bkz. lib/urun-arama.ts). Yazarken geç dönen eski yanıt yenisini ezmesin.
  useEffect(() => {
    // setSearching(false) şart: yoldaki istek iptal edildiği için kendi finally'si
    // göstergeyi kapatmaz, "aranıyor…" takılı kalırdı.
    if (q.trim().length < 2) { setResults([]); setTarama(null); setErr(""); setSearching(false); return; }
    let iptal = false;
    setSearching(true);
    setErr("");
    const t = setTimeout(() => {
      fetchJson(`/api/product?q=${encodeURIComponent(q)}`)
        .then((d) => {
          if (iptal) return;
          const res = d.results ?? [];
          setResults(res);
          setTarama({
            barkodlar: d.barkodlar ?? [], bulunamayan: d.bulunamayan ?? [], atlanan: d.atlanan ?? [],
            toplam: d.toplam ?? res.length, kesildi: !!d.kesildi,
          });
          // Tek bir TAM barkod yazıldı ve tek ürüne denk geldiyse karşılaştırmayı
          // doğrudan aç: barkod okutan/yapıştıran kişi listeden seçmek zorunda kalmasın.
          const bk = d.barkodlar?.length === 1 ? d.barkodlar[0] : null;
          // Zaten açık olan ürün yeniden açılmaz (görünüm ayarları sıfırlanmasın).
          if (bk && bk.length >= 8 && res.length === 1 && res[0].barkod === bk && seciliBarkod.current !== bk) { seciliBarkod.current = bk; selectProduct(bk); }
        })
        .catch((e) => { if (iptal) return; setErr(e.message); setResults([]); setTarama(null); })
        .finally(() => { if (!iptal) setSearching(false); });
    }, 300);
    return () => { iptal = true; clearTimeout(t); };
  }, [q]);

  // İstek yarışı: iki sonuca hızlı ardışık tıklanınca son tıklanan kazanır.
  // `istenen` beklenen barkod — tıklanan satırın altında statik çizgi, eski
  // ürün bloğu soluk (eski ürün yeni ürün sanılmasın).
  const istekNo = useRef(0);
  const [istenen, setIstenen] = useState<string | null>(null);
  function selectProduct(barkod: string) {
    const no = ++istekNo.current;
    setErr("");
    setIstenen(barkod);
    fetchJson(`/api/product?barkod=${encodeURIComponent(barkod)}`)
      .then((d) => { if (no !== istekNo.current) return; setSelected(d); setRange("0"); }) // yeni ürün → pencereyi sıfırla
      .catch((e) => { if (no !== istekNo.current) return; setErr(e.message); setSelected(null); })
      .finally(() => { if (no === istekNo.current) setIstenen(null); });
  }

  // Seçili ürünün perakendecileri (kaynak liste). Ürün değişince görünürlüğü tümüne sıfırla.
  const allRetailers: string[] = useMemo(
    () => (selected?.retailers ?? []) as string[],
    [selected]
  );
  useEffect(() => { setVisible(allRetailers); }, [allRetailers]);
  useEffect(() => { seciliBarkod.current = selected?.barkod ?? null; }, [selected]);
  // CORTEX asistanı "bu ürün" dendiğinde hangisi olduğunu bilsin.
  useAsistanBaglami(selected ? { "ürün": selected.name, barkod: selected.barkod ?? "" } : null);

  // Etkin görünür perakendeciler (kaynakla kesişim; sıra kaynaktaki gibi).
  const shown = useMemo(
    () => allRetailers.filter((r) => visible.includes(r)),
    [allRetailers, visible]
  );

  // Tam haftalık seri (API). Her satır: { week, [retailer]: qty }.
  const fullSeries: any[] = useMemo(() => selected?.series ?? [], [selected]);

  // Hafta penceresi: son N hafta (seri tarih sıralı geldiği için sondan dilim).
  const series = useMemo(() => {
    const n = Number(range);
    return n > 0 ? fullSeries.slice(-n) : fullSeries;
  }, [fullSeries, range]);

  const windowed = Number(range) > 0 && series.length < fullSeries.length;

  // Pencere içindeki adet toplamı (series'te haftalık adet OLDUĞU için yeniden hesaplanabilir).
  // Ciro/stok haftalık kırılımı seride YOK → onlar daima tam-aralık (API totals).
  const windowQty = useMemo(() => {
    const m = new Map<string, number>();
    for (const row of series) {
      for (const ret of allRetailers) m.set(ret, (m.get(ret) ?? 0) + (Number(row[ret]) || 0));
    }
    return m;
  }, [series, allRetailers]);

  // Tablo/bar satırları: görünür perakendeciler + seçili metrik + pay%.
  // adet metriği pencereye duyarlı; ciro/stok tam-aralık (API totals).
  const apiTotals: TotalRow[] = useMemo(() => (selected?.totals ?? []) as TotalRow[], [selected]);
  const takvimHaftasi = useMemo(() => sonTamamlanmisHafta(new Date()), []);
  const rows: TotalRowX[] = useMemo(() => {
    const base = apiTotals
      .filter((t) => shown.includes(t.retailer))
      .map((t) => ({
        ...t,
        total_qty: windowed ? (windowQty.get(t.retailer) ?? 0) : t.total_qty,
      }));
    const denom = base.reduce((a, t) => a + metricVal(t, metric), 0);
    // VERİ YAŞI SATIRIN PARÇASI. Firmalar aynı gün rapor göndermiyor; stok kolonu
    // her firmanın KENDİ son haftasının fotoğrafı. Yaş satırda taşınmazsa 5 hafta
    // önceki bir stok bugünkülerle aynı sütunda, aynı yaşta okunuyor.
    return base.map((t) => {
      const gecikmeHf = gecikmeHaftasi(t.last_week, takvimHaftasi);
      return {
        ...t,
        share: denom > 0 ? (metricVal(t, metric) / denom) * 100 : 0,
        gecikmeHf,
        bayat: gecikmeHf >= GECIKME_ROZET,
      };
    });
  }, [apiTotals, shown, windowed, windowQty, metric, takvimHaftasi]);

  const { sorted, sortKey, dir, toggle } = useSort<TotalRowX>(rows, sortKeyFor(metric), "desc");

  // Metrik değişince tablo sıralaması o metriğin sütununa kaysın (üstte hep "en çok"
  // görünür). Yalnızca sıralama bir metrik sütunundaysa devreye girer; kullanıcı
  // Perakendeci/Pay% gibi başka bir kolona göre sıraladıysa tercihi ezilmez.
  const prevMetric = useRef<Metric>(metric);
  useEffect(() => {
    if (prevMetric.current === metric) return;
    prevMetric.current = metric;
    const target = sortKeyFor(metric);
    const onMetricCol = sortKey === "total_qty" || sortKey === "total_val" || sortKey === "last_stock";
    if (onMetricCol && sortKey !== target) toggle(target); // farklı key → o sütunda azalan başlar
    // toggle/sortKey kasıtlı dışarıda: yalnız metric değişiminde tetikle, döngü olmasın.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [metric]);

  // Bar karşılaştırması (sıralı satırlar üzerinden, metrik değeri ile).
  const maxMetric = Math.max(1, ...sorted.map((t) => metricVal(t, metric)));

  // Ürün meta (isimden) — küçük kimlik rozetleri için.
  const meta = selected ? parseProductMeta(selected.name) : null;

  // KPI: görünür perakendecilerin toplamı (seçili metrik) + kaç firmada satılıyor.
  const kpiTotal = sorted.reduce((a, t) => a + metricVal(t, metric), 0);

  const csvRows = sorted.map((t) => ({
    retailer: t.retailer,
    adet: Math.round(t.total_qty),
    ciro: Math.round(t.total_val),
    stok: Math.round(t.last_stock),
    // Stok sütunu bu tarihin fotoğrafı — CSV'ye de gider, yoksa dosya
    // ekrandan daha az şey söyler ve dışarıda yanlış kıyaslanır.
    son_veri: t.last_week ?? "",
    gecikme_hf: t.gecikmeHf >= 99 ? "" : t.gecikmeHf,
    pay_pct: Math.round(t.share * 10) / 10,
  }));
  // Karşılaştırmaya giren ama verisi eski olan firmalar.
  const bayatlar = sorted.filter((t) => t.bayat && t.last_week);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">
          Ürün <span className="neon-text">Karşılaştırma</span>
        </h1>
        <p className="text-txt-dim mono text-sm mt-1">
          Bir ürünün tüm perakendecilerdeki performansı — barkod bazlı cross-retailer
        </p>
      </div>

      <div className="card p-4">
        <SearchBox
          value={q}
          onChange={setQ}
          placeholder="ürün adı ya da barkod · birden çok barkod için virgülle ayır"
        />
        {searching && <div className="mono text-xs text-txt-dim mt-2">aranıyor…</div>}
        {err && (
          <div className="card p-4 mt-3 border-red-500/40 text-red-400 mono text-sm">
            Veri alınamadı: {err}
          </div>
        )}
        {!err && !searching && q.trim().length >= 2 && results.length === 0 && (
          <div className="mono text-xs text-txt-dim mt-2">Sonuç bulunamadı.</div>
        )}
        {/* Çoklu barkod taraması: kaç barkod arandı, hangileri sistemde yok. */}
        {!err && tarama && (tarama.barkodlar.length > 1 || tarama.bulunamayan.length > 0 || tarama.atlanan.length > 0) && (
          <div className="mono text-[11px] mt-2 flex flex-wrap gap-x-2 gap-y-0.5">
            <span className="text-txt-dim">{tarama.barkodlar.length} barkod tarandı</span>
            {tarama.bulunamayan.length > 0 && (
              <>
                <span style={{ color: "#f8b00b" }}>bulunamadı:</span>
                {tarama.bulunamayan.slice(0, 20).map((b) => <span key={b} className="text-txt-dim">{b}</span>)}
                {tarama.bulunamayan.length > 20 && <span className="text-txt-dim">+{tarama.bulunamayan.length - 20} barkod daha</span>}
              </>
            )}
            {tarama.atlanan.length > 0 && (
              <span style={{ color: "#f8b00b" }}>
                · sınır {tarama.barkodlar.length} barkod: son {tarama.atlanan.length} barkod taranmadı, ayrı arayın
              </span>
            )}
          </div>
        )}
        {results.length > 0 && (
          <>
            <div className="mono text-[11px] text-txt-dim mt-3 mb-1">
              {results.length} ürün bulundu
              {tarama?.kesildi && ` · ${tarama.toplam} eşleşmeden ilk ${results.length}; aramayı daraltın`}
            </div>
            <div className="space-y-1 max-h-64 overflow-y-auto">
              {results.map((r) => (
                <button
                  key={r.barkod}
                  onClick={() => selectProduct(r.barkod)}
                  {...bekleme(istenen === r.barkod)}
                  className="relative cx-hedef w-full text-left px-3 py-2 rounded-lg hover:bg-neon/5 hover:transition-colors flex items-center justify-between gap-3"
                >
                  <span className="min-w-0 flex flex-col">
                    <span className="text-sm truncate">{r.name}</span>
                    <span className="mono text-[10px] text-txt-dim">{r.barkod}</span>
                  </span>
                  <span className="flex flex-wrap justify-end gap-1 shrink-0 max-w-[55%]">
                    {(r.retailers ?? []).map((ret: string) => (
                      <span key={ret} className="mono text-[10px] px-1.5 py-0.5 rounded"
                        style={{ color: colorOf(ret), border: `1px solid ${colorOf(ret)}40` }}>
                        {ret}
                      </span>
                    ))}
                  </span>
                </button>
              ))}
            </div>
          </>
        )}
      </div>

      {selected && (
        <div className="cx-soluk space-y-6" {...bekleme(istenen != null)}>
          <div className="card p-5">
            <div className="mono text-xs text-txt-dim">BARKOD {selected.barkod}</div>
            <h2 className="text-xl font-bold mt-1">{selected.name}</h2>
            {meta && (
              <div className="flex gap-1.5 flex-wrap mt-2">
                {[meta.brand, meta.team, meta.type].map((m, i) => (
                  <span key={i} className="mono text-[10px] px-2 py-0.5 rounded-full border border-line text-txt-dim">
                    {m}
                  </span>
                ))}
              </div>
            )}
          </div>

          {/* ── Görünüm kontrolleri: metrik · hafta aralığı · perakendeci seçimi ── */}
          <div className="card p-4 space-y-3">
            <div className="flex items-center justify-between flex-wrap gap-3">
              <label className="mono text-xs text-txt-dim flex items-center gap-2">
                Metrik
                <SegTabs<Metric> tabs={METRIC_TABS} active={metric} onChange={setMetric} />
              </label>
              <label className="mono text-xs text-txt-dim flex items-center gap-2">
                Hafta aralığı
                <SegTabs<RangeId> tabs={RANGE_TABS} active={range} onChange={setRange} />
              </label>
            </div>
            {allRetailers.length > 0 && (
              <MultiChips
                label="Perakendeci:"
                options={allRetailers}
                selected={shown}
                onToggle={(ret) =>
                  setVisible((v) => (v.includes(ret) ? v.filter((x) => x !== ret) : [...v, ret]))
                }
                onAll={() => setVisible(allRetailers)}
                onNone={() => setVisible([])}
                colorOf={colorOf}
              />
            )}
          </div>

          {/* ── KPI özeti (görünür perakendeci + seçili metrik) ── */}
          <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
            {/* STOK "TÜM DÖNEM" DEĞİLDİR. Adet ve ciro bir dönemin toplamı; stok
                ise her firmanın KENDİ son haftasındaki fotoğrafının toplamı. Aynı
                alt etiketi kullanmak stoğu da birikmiş bir toplam gibi okutuyordu.
                Firmaların tarihleri ayrışıyorsa bu da açıkça yazılır. */}
            <StatCard
              label={`TOPLAM ${metricNoun(metric).toUpperCase()}`}
              value={metricFmt(kpiTotal, metric)}
              color={metric === "stock" && bayatlar.length > 0 ? "#f8b00b" : undefined}
              sub={
                metric === "stock"
                  ? (bayatlar.length > 0
                    ? `farklı tarihli fotoğraflar · ${bayatlar.length} firma geride`
                    : "her firmanın son fotoğrafı")
                  : windowed && metric === "qty" ? `son ${series.length} hafta` : "tüm dönem"
              }
            />
            <StatCard
              label="GÖRÜNÜR FIRMA"
              value={`${shown.length} / ${allRetailers.length}`}
              sub="perakendeci"
            />
            <StatCard
              label="HAFTA"
              value={fmtInt(series.length)}
              sub={windowed ? `${fullSeries.length} haftadan` : "kayıtlı"}
            />
          </div>

          {/* ── Geçen yıl aynı hafta: YALNIZ Pre-Season (kullanıcı kararı —
              diğer ürünlerde yıl kıyası istenmiyor). Çapa = ürünün en yeni
              raporlu haftası. ── */}
          {selected?.barkod && apiTotals.length > 0 && aile(selected.name) === "Pre-Season" && (
            <GecenYilUrun barkod={selected.barkod}
              week={apiTotals.reduce((m, t) => (t.last_week && t.last_week > m ? t.last_week : m), "")} />
          )}

          {/* ── Perakendeci toplamları (sıralanabilir + bar + pay%) ── */}
          <div className="card p-5">
            <div className="flex items-center justify-between flex-wrap gap-3 mb-3">
              <h3 className="font-bold">
                Perakendeci Toplamları
                <span className="mono text-xs text-txt-dim font-normal ml-2">{sorted.length} / {allRetailers.length}</span>
              </h3>
              <CsvBtn
                filename={`cortex-urun-${selected.barkod}`}
                rows={csvRows}
                cols={[
                  { key: "retailer", label: "Perakendeci" },
                  { key: "adet", label: "Adet" },
                  { key: "ciro", label: "Ciro" },
                  { key: "stok", label: "Stok" },
                  { key: "son_veri", label: "Son veri" },
                  { key: "gecikme_hf", label: "Gecikme (hf)" },
                  { key: "pay_pct", label: "Pay %" },
                ]}
              />
            </div>
            {(metric === "val" || metric === "stock") && windowed && (
              <div className="mono text-[11px] text-amber-400/70 mb-2">
                Not: ciro ve stok haftalık kırılımı veride yok; bu sütunlar tüm dönemi gösterir (hafta aralığı yalnız adedi etkiler).
              </div>
            )}
            {sorted.length === 0 ? (
              <div className="mono text-sm text-txt-dim text-center py-6">
                Seçili perakendeci yok — yukarıdan en az bir firma seçin.
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table>
                  <thead>
                    <tr>
                      <SortableTh label="Perakendeci" sortKey="retailer" active={sortKey === "retailer"} dir={dir} onClick={toggle} />
                      <SortableTh label="Adet" sortKey="total_qty" active={sortKey === "total_qty"} dir={dir} onClick={toggle} align="right" />
                      <SortableTh label="Ciro" sortKey="total_val" active={sortKey === "total_val"} dir={dir} onClick={toggle} align="right" />
                      <SortableTh label="Stok" sortKey="last_stock" active={sortKey === "last_stock"} dir={dir} onClick={toggle} align="right" />
                      <SortableTh label="Son veri" sortKey="last_week" active={sortKey === "last_week"} dir={dir} onClick={toggle} />
                      <SortableTh label={`Pay % (${metricNoun(metric)})`} sortKey="share" active={sortKey === "share"} dir={dir} onClick={toggle} align="right" />
                      <th className="text-left">{metricNoun(metric)} dağılımı</th>
                    </tr>
                  </thead>
                  <tbody>
                    {sorted.map((t) => {
                      const c = colorOf(t.retailer);
                      return (
                        <tr key={t.retailer}>
                          <td>
                            <span className="font-semibold" style={{ color: c }}>{t.retailer}</span>
                          </td>
                          <td className="mono text-right">{fmtInt(t.total_qty)}</td>
                          <td className="mono text-right">{t.total_val > 0 ? fmtMoney(t.total_val) : "—"}</td>
                          <td className="mono text-right text-txt-dim">{fmtInt(t.last_stock)}</td>
                          {/* SON VERİ — stok kolonunun tarihi. Takvim haftasında
                              "güncel"; her sapma gerçek tarihini gösterir. Bayat
                              firma ayrıca amber ve kaç hafta geride yazar.
                              CSV'de tarih HAM ISO olarak kalır (bkz. csvRows) —
                              dosya dışarıda okunacak, "güncel" orada anlamsız. */}
                          <td className="mono text-[11px]" style={t.bayat ? { color: "#f8b00b" } : undefined}>
                            {fmtHafta(t.last_week, takvimHaftasi)}
                            {t.bayat && t.gecikmeHf < 99 && ` · ${t.gecikmeHf} hf`}
                          </td>
                          <td className="mono text-right">{fmtPct(t.share)}</td>
                          <td className="w-40">
                            <div className="h-2 rounded-full bg-ink-3 overflow-hidden">
                              <div className="h-full rounded-full"
                                style={{ width: `${(metricVal(t, metric) / maxMetric) * 100}%`, background: c }} />
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
                {/* BAYAT VERİ NOTU. Adet ve ciro kolonları GEÇMİŞ TOPLAMIDIR —
                    eski veri onları bozmaz. Stok ise FOTOĞRAF: farklı tarihli iki
                    fotoğrafı aynı sütunda toplamak ve pay% çıkarmak, olmayan bir
                    "bugün" üretir. O yüzden uyarı stok metriğinde daha serttir. */}
                {bayatlar.length > 0 && (
                  <div className="mt-2 mono text-[11px]" style={{ color: "#f8b00b" }}>
                    {/* CUMLE FIRMAYI SUCLAMAZ. Olculen sey pivotProduct'in
                        last_week'i, yani URUNUN o firmadaki son satiri; firmanin
                        raporu bugun gelmis olsa da urun listeden cikmis olabilir.
                        Hesap bilincli (ortak son hafta kullanilinca stogun %40'i
                        ekrandan kayboluyordu), duzeltilen yalnizca ifade. */}
                    {bayatlar.map((t) => `${t.retailer} bu üründe ${t.gecikmeHf} hf eski (son satır ${fmtDate(t.last_week!)})`).join(" · ")}
                    {metric === "stock"
                      ? " — stok ve pay% farklı tarihli fotoğrafları karşılaştırıyor, bugünkü tablo değil."
                      : " — firma raporu güncel olsa bile ürün o tarihten sonra listelenmemiş olabilir; adet/ciro geçmiş toplamıdır, stok kolonu bu tarihin fotoğrafıdır."}
                  </div>
                )}
              </div>
            )}
          </div>

          {/* ── Cross-retailer zaman serisi (haftalık adet) ── */}
          <div className="card p-6">
            <div className="flex items-center justify-between flex-wrap gap-2 mb-4">
              <h3 className="font-bold">Haftalık Satış — Perakendeci Karşılaştırması</h3>
              <span className="mono text-[11px] text-txt-dim">
                haftalık adet · {windowed ? `son ${series.length} hafta` : "tüm dönem"}
              </span>
            </div>
            {shown.length === 0 ? (
              <div className="mono text-sm text-txt-dim text-center py-10">
                Grafik için en az bir perakendeci seçin.
              </div>
            ) : series.length === 0 ? (
              <div className="mono text-sm text-txt-dim text-center py-10">Bu aralıkta veri yok.</div>
            ) : (
              <ResponsiveContainer width="100%" height={340}>
                <LineChart data={series} margin={{ top: 8, right: 16, bottom: 8, left: 8 }}>
                  <CartesianGrid stroke="#1f2a1f" strokeDasharray="3 3" />
                  <XAxis dataKey="week" stroke="#7d927d" fontSize={11}
                    tickFormatter={(w) => fmtDate(w)} tickMargin={8} />
                  <YAxis stroke="#7d927d" fontSize={11} width={48} />
                  <Tooltip isAnimationActive={false}
                    contentStyle={{ background: "#0f150f", border: "1px solid #1f2a1f", borderRadius: 10, fontSize: 12 }}
                    labelFormatter={(w) => fmtDate(w as string)}
                  />
                  <Legend wrapperStyle={{ fontSize: 12 }} />
                  {shown.map((ret) => (
                    <Line key={ret} type="monotone" dataKey={ret} stroke={colorOf(ret)}
                      strokeWidth={2} dot={{ r: 2 }} connectNulls isAnimationActive={false} />
                  ))}
                </LineChart>
              </ResponsiveContainer>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// Metrik değişince tablonun varsayılan sıralama anahtarı o metriğe geçsin.
function sortKeyFor(m: Metric): keyof TotalRowX & string {
  return m === "val" ? "total_val" : m === "stock" ? "last_stock" : "total_qty";
}
