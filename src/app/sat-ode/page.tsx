"use client";

import { Fragment, useEffect, useMemo, useState } from "react";
import { motion } from "framer-motion";
import { fmtInt, fmtMoney, fmtDate, colorOf, RETAILER_COLORS } from "@/lib/format";
import { AnimatedNumber } from "@/components/AnimatedNumber";
import { SearchBox, MultiChips, SegTabs, SortableTh, useSort, CsvBtn } from "@/components/Controls";
import { fetchJson } from "@/lib/fetchJson";

const col = (r: string) => RETAILER_COLORS[r] ?? "#7d927d";

const MONTH_TR = ["", "Oca", "Şub", "Mar", "Nis", "May", "Haz", "Tem", "Ağu", "Eyl", "Eki", "Kas", "Ara"];
const fmtMonth = (ym: string) => { const [y, m] = ym.split("-"); return `${MONTH_TR[Number(m)]} ${y}`; };
const monthKey = (iso: string | null) => (iso && iso.length >= 7 ? iso.slice(0, 7) : null);

const COVERAGE: Record<string, { label: string; color: string }> = {
  ok: { label: "tam veri", color: "#1FF80B" },
  partial: { label: "kısmi veri", color: "#f8b00b" },
  none: { label: "satış verisi yok", color: "#7d927d" },
};

// Fatura gezgini durum filtresi.
type StatusId = "all" | "overdue" | "upcoming";

// Tek faturanın gezgin tablosunda kullanılan düz biçimi (kanal + grup alanları + türetilenler).
// `type` (interface değil) — CsvBtn'in `T extends Record<string, unknown>` kısıtıyla uyumlu olsun.
type FlatInvoice = {
  retailer: string;
  invoice_no: string;
  invoice_date: string;
  due_date: string | null;
  qty: number;
  net: number;
  total: number;
  lineCount: number;
  products: string;       // arama + CSV için birleşik kalem adları
  dueMonth: string | null;
  overdue: boolean;
};

export default function SatOdePage() {
  const [data, setData] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);

  // ── İstemci-tarafı filtre durumu (sayfanın zaten çektiği veri üzerinde) ──
  const [chans, setChans] = useState<string[] | null>(null); // null = "henüz dokunulmadı" → tümü
  const [q, setQ] = useState("");
  const [month, setMonth] = useState<string>("all");         // vade ayı (YYYY-MM) | "all"
  const [status, setStatus] = useState<StatusId>("all");

  useEffect(() => {
    fetchJson("/api/consignment")
      .then((d) => { setData(d); setErr(null); })
      .catch((e) => { setErr(e.message); setData(null); })
      .finally(() => setLoading(false));
  }, []);

  // Tüm fatura kayıtlarını kanal etiketiyle tek listeye düzleştir (data hazırsa).
  const allInvoices: FlatInvoice[] = useMemo(() => {
    const inv = data?.invoices as Record<string, any[]> | undefined;
    const today: string = data?.today ?? "";
    if (!inv) return [];
    const out: FlatInvoice[] = [];
    for (const [retailer, groups] of Object.entries(inv)) {
      for (const g of groups) {
        const products = (g.lines ?? [])
          .map((l: any) => l.product_name || l.stock_code || "")
          .filter(Boolean)
          .join(" · ");
        out.push({
          retailer,
          invoice_no: g.invoice_no || "",
          invoice_date: g.invoice_date,
          due_date: g.due_date ?? null,
          qty: g.qty,
          net: g.net,
          total: g.total,
          lineCount: g.lines?.length ?? 0,
          products,
          dueMonth: monthKey(g.due_date),
          overdue: !!(g.due_date && today && g.due_date < today),
        });
      }
    }
    return out;
  }, [data]);

  // Vade ayı sekmeleri — yalnız gerçekten veride bulunan aylar.
  const monthOptions = useMemo(() => {
    const s = new Set<string>();
    for (const f of allInvoices) if (f.dueMonth) s.add(f.dueMonth);
    return [...s].sort();
  }, [allInvoices]);

  // Çekirdek hesaplar (filtreden BAĞIMSIZ; mevcut KPI/şema korunur) ────────────
  const rec: any[] = data?.reconcile ?? [];
  const ss = data?.salesSchedule ?? { buckets: [], collectedTotal: 0, upcomingTotal: 0 };
  const ag = data?.aging ?? {};

  // Seçili kanallar — null iken tümü (chip'e dokununca daralır).
  const allChanNames = useMemo(() => rec.map((r) => r.retailer as string), [rec]);
  const selChans = chans ?? allChanNames;
  const selSet = useMemo(() => new Set(selChans), [selChans]);

  // Mutabakat tablosu seçili kanallara göre süzülür (mevcut drill aynen korunur).
  const recView = useMemo(() => rec.filter((c) => selSet.has(c.retailer)), [rec, selSet]);

  // Seçime duyarlı ağ özeti — eski global mantıkla aynı, sadece kanal kümesi süzülü.
  const soldTotal = recView.reduce((a, r) => a + (r.soldNet || 0), 0);
  const okCh = recView.filter((r) => r.coverage === "ok");
  const riskTotal = okCh.reduce((a, r) => a + (r.returnRiskNet || 0), 0);
  const okSevk = okCh.reduce((a, r) => a + r.sevkNet, 0);
  const okSold = okCh.reduce((a, r) => a + r.soldNet, 0);
  const netPct = okSevk > 0 ? (okSold / okSevk) * 100 : null;
  const gapChannels = recView.filter((r) => r.coverage === "none").map((r) => r.retailer);

  // KPI kartları sevk/gelecek tahsilat — kanal süzgecine duyarlı (reconcile tabanlı).
  const sevkNetSel = recView.reduce((a, r) => a + (r.sevkNet || 0), 0);
  const sevkGrossSel = recView.reduce((a, r) => a + (r.sevkGross || 0), 0);
  const chanFiltered = chans != null && selChans.length !== allChanNames.length;

  // Fatura gezgini: kanal + durum + ay + arama süzgeçleri.
  const invFiltered = useMemo(() => {
    const needle = q.trim().toLocaleLowerCase("tr");
    return allInvoices.filter((f) => {
      if (!selSet.has(f.retailer)) return false;
      if (status === "overdue" && !f.overdue) return false;
      if (status === "upcoming" && (f.overdue || !f.due_date)) return false;
      if (month !== "all" && f.dueMonth !== month) return false;
      if (needle) {
        const hay = `${f.invoice_no} ${f.retailer} ${f.products}`.toLocaleLowerCase("tr");
        if (!hay.includes(needle)) return false;
      }
      return true;
    });
  }, [allInvoices, selSet, status, month, q]);

  const { sorted: invSorted, sortKey, dir, toggle } = useSort<FlatInvoice>(invFiltered, "invoice_date", "desc");

  const invTotalSum = invSorted.reduce((a, f) => a + f.total, 0);
  const invQtySum = invSorted.reduce((a, f) => a + f.qty, 0);

  // Durum dağılımı — yalnız kanal süzgecine duyarlı (durum sekmesinin kendisinden bağımsız),
  // böylece "vadesi geçti / yaklaşan" sayıları seçilen sekmeden etkilenmeden gösterilir.
  const statusCounts = useMemo(() => {
    let overdue = 0, upcoming = 0;
    for (const f of allInvoices) {
      if (!selSet.has(f.retailer)) continue;
      if (f.overdue) overdue++;
      else if (f.due_date) upcoming++;
    }
    return { overdue, upcoming };
  }, [allInvoices, selSet]);

  if (loading) return <div className="card p-10 text-center mono text-txt-dim animate-pulse">Yükleniyor…</div>;
  if (err) return <div className="card p-4 border-red-500/40 text-red-400 mono text-sm">Veri alınamadı: {err}</div>;
  if (!data || data.empty) return (
    <div className="card p-10 text-center">
      <div className="font-semibold">Henüz sat-öde verisi yok</div>
      <div className="text-txt-dim mono text-sm mt-2">seed/satode/ altına fatura Excel'ini koyup <span className="neon-text">npm run seed:satode</span> çalıştır.</div>
    </div>
  );

  const k = data.kpis;

  const maxSched = Math.max(1, ...ss.buckets.map((b: any) => b.net));
  const agingTotal = Math.max(1, (ag.overdue || 0) + (ag.due0_30 || 0) + (ag.due31_60 || 0) + (ag.due61_90 || 0) + (ag.due90plus || 0));
  const agSegs = [
    { label: "vadesi geçti", val: ag.overdue, color: "#ff5555" },
    { label: "0–30 gün", val: ag.due0_30, color: "#f8b00b" },
    { label: "31–60 gün", val: ag.due31_60, color: "#1FF80B" },
    { label: "61–90 gün", val: ag.due61_90, color: "#0bd1f8" },
    { label: "90+ gün", val: ag.due90plus, color: "#9b6bff" },
  ].filter((s) => s.val > 0);

  // CSV başlıkları — fatura gezgini dışa aktarımı.
  const invCols = [
    { key: "retailer" as const, label: "Kanal" },
    { key: "invoice_no" as const, label: "Fatura No" },
    { key: "invoice_date" as const, label: "Fatura Tarihi" },
    { key: "due_date" as const, label: "Vade" },
    { key: "qty" as const, label: "Adet" },
    { key: "net" as const, label: "Net" },
    { key: "total" as const, label: "Toplam (KDV dahil)" },
    { key: "lineCount" as const, label: "Kalem" },
    { key: "products" as const, label: "Ürünler" },
  ];

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">Sat-Öde <span className="neon-text">Konsinye</span></h1>
        <p className="text-txt-dim mono text-sm mt-1">
          Sevk → satış → tahsilat. Tahsilat = <span className="text-txt">satılan kadar</span>; satılmayan iade.
          {k.invoiceRange && <> Fatura {fmtDate(k.invoiceRange[0])} – {fmtDate(k.invoiceRange[1])} · </>}{k.invoiceCount} fatura · {k.channelCount} kanal
        </p>
      </div>

      {/* Kanal filtresi — tüm yüzeyleri (KPI + mutabakat + fatura gezgini) süzer */}
      <div className="card p-4">
        <div className="flex items-center justify-between flex-wrap gap-2">
          <MultiChips
            label="Kanallar:"
            options={allChanNames}
            selected={selChans}
            colorOf={(o) => colorOf(o)}
            onToggle={(o) =>
              setChans((prev) => {
                const base = prev ?? allChanNames;
                const next = base.includes(o) ? base.filter((x) => x !== o) : [...base, o];
                return next;
              })
            }
            onAll={() => setChans(allChanNames)}
            onNone={() => setChans([])}
          />
          <span className="mono text-[11px] text-txt-dim">
            {selChans.length} / {allChanNames.length} kanal
            {chanFiltered && <span className="text-neon"> · süzülü</span>}
          </span>
        </div>
        {selChans.length === 0 && (
          <div className="mono text-[11px] mt-2" style={{ color: "#f8b00b" }}>Hiç kanal seçili değil — tüm tablolar boş. Bir kanal seç ya da “tümü”.</div>
        )}
      </div>

      {/* KPI'lar — seçili kanal kümesine duyarlı */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <div className="card p-5">
          <div className="mono text-[10px] text-txt-dim tracking-wider">SEVK (GÖNDERİLEN){chanFiltered && <span className="text-neon"> ·seçili</span>}</div>
          <div className="text-3xl font-bold mono mt-1"><AnimatedNumber value={chanFiltered ? sevkGrossSel : k.totalGross} format={(x) => fmtMoney(x)} /></div>
          <div className="mono text-[10px] text-txt-dim mt-1">net {fmtMoney(chanFiltered ? sevkNetSel : k.totalNet)} · KDV dahil</div>
        </div>
        <div className="card p-5 neon-glow">
          <div className="mono text-[10px] text-txt-dim tracking-wider">SATILDI = TAHSİL EDİLEBİLİR</div>
          <div className="text-3xl font-bold mono mt-1 neon-text"><AnimatedNumber value={soldTotal} format={(x) => fmtMoney(x)} /></div>
          <div className="mono text-[10px] text-txt-dim mt-1">net kazanç · CORTEX kayıtlı satış</div>
        </div>
        <div className="card p-5">
          <div className="mono text-[10px] text-txt-dim tracking-wider">İADE RİSKİ (SATILMAYAN)</div>
          <div className="text-3xl font-bold mono mt-1" style={{ color: "#ff5555" }}><AnimatedNumber value={riskTotal} format={(x) => fmtMoney(x)} /></div>
          <div className="mono text-[10px] text-txt-dim mt-1">yalnız tam-veri kanallar · net</div>
        </div>
        <div className="card p-5">
          <div className="mono text-[10px] text-txt-dim tracking-wider">GELECEK TAHSİLAT</div>
          <div className="text-3xl font-bold mono mt-1" style={{ color: "#0bd1f8" }}><AnimatedNumber value={ss.upcomingTotal} format={(x) => fmtMoney(x)} /></div>
          <div className="mono text-[10px] text-txt-dim mt-1">tahsil edildi: {fmtMoney(ss.collectedTotal)}</div>
        </div>
      </div>

      {/* Kanal mutabakatı — ana tablo */}
      <div className="card p-6">
        <div className="flex items-baseline justify-between flex-wrap gap-2 mb-1">
          <h2 className="font-bold">Kanal Mutabakatı</h2>
          {netPct != null && <span className="mono text-xs text-txt-dim">tam-veri kanallarda sell-through <span className="neon-text font-bold">%{netPct.toFixed(0)}</span></span>}
        </div>
        <p className="mono text-xs text-txt-dim mb-4">Satıra tıkla → fatura kırılımı. Satılan = CORTEX net kazanç (sevkle aynı taban). İade riski yalnız satış verisi sevk dönemini kapsayan kanallarda hesaplanır.</p>
        <div className="overflow-x-auto">
          <table>
            <thead>
              <tr>
                <th>Kanal</th><th className="text-right">Sevk adet</th><th className="text-right">Sevk (net)</th>
                <th className="text-right">Satıldı (net)</th><th className="text-right">Sell-through</th>
                <th className="text-right">İade riski</th><th>Durum</th><th></th>
              </tr>
            </thead>
            <tbody>
              {recView.map((c) => {
                const isOpen = open === c.retailer;
                const inv = data.invoices?.[c.retailer] ?? [];
                const cov = COVERAGE[c.coverage] ?? COVERAGE.none;
                return (
                  <Fragment key={c.retailer}>
                    <tr className="cursor-pointer" onClick={() => setOpen(isOpen ? null : c.retailer)}>
                      <td>
                        <span className="inline-block w-2.5 h-2.5 rounded-full mr-2" style={{ background: col(c.retailer) }} />
                        <span className="font-semibold" style={{ color: col(c.retailer) }}>{c.retailer}</span>
                        {c.vadeDays != null && <span className="text-txt-dim text-[11px] ml-2">{c.vadeDays}g vade</span>}
                      </td>
                      <td className="text-right mono text-txt-dim">{fmtInt(c.qty)}</td>
                      <td className="text-right mono">{fmtMoney(c.sevkNet)}</td>
                      <td className="text-right mono neon-text font-bold">{fmtMoney(c.soldNet)}</td>
                      <td className="text-right mono">{c.sellThroughPct != null ? `%${c.sellThroughPct.toFixed(0)}` : "—"}</td>
                      <td className="text-right mono" style={{ color: c.returnRiskNet ? "#ff5555" : "#7d927d" }}>
                        {c.returnRiskNet != null ? fmtMoney(c.returnRiskNet) : "—"}
                      </td>
                      <td><span className="mono text-[10px] px-2 py-0.5 rounded" style={{ color: cov.color, background: `${cov.color}1a` }}>{cov.label}</span></td>
                      <td className="text-right mono text-txt-dim">{isOpen ? "▾" : "▸"}</td>
                    </tr>
                    {isOpen && (
                      <tr key={c.retailer + "-d"}>
                        <td colSpan={8} className="!p-0">
                          <div className="bg-ink-2/50 px-4 py-3">
                            {c.coverage === "none" && (
                              <div className="mono text-[11px] mb-2" style={{ color: "#f8b00b" }}>
                                ⚠ CORTEX satış verisi ({c.sellFirst ? fmtDate(c.sellFirst) : "—"}'dan) sevk dönemini ({fmtDate(c.sevkFirst)}–{fmtDate(c.sevkLast)}) kapsamıyor → iade riski hesaplanamadı. Eski satış verisini yükleyince açılır.
                              </div>
                            )}
                            <div className="mono text-[11px] text-txt-dim mb-2">{inv.length} fatura · yeni → eski</div>
                            <div className="max-h-80 overflow-y-auto space-y-1">
                              {inv.map((g: any) => {
                                const overdue = g.due_date && g.due_date < data.today;
                                return (
                                  <div key={g.invoice_no + g.invoice_date} className="flex items-center gap-3 text-[12px] mono py-1 border-b border-line/40">
                                    <span className="w-24 shrink-0">{g.invoice_no || "—"}</span>
                                    <span className="w-20 shrink-0 text-txt-dim">{fmtDate(g.invoice_date)}</span>
                                    <span className="w-24 shrink-0" style={{ color: overdue ? "#ff5555" : "#7d927d" }}>vade {fmtDate(g.due_date)}</span>
                                    <span className="w-16 shrink-0 text-right">{fmtInt(g.qty)} ad</span>
                                    <span className="flex-1 text-right font-bold">{fmtMoney(g.total)}</span>
                                    <span className="w-20 shrink-0 text-right text-txt-dim">{g.lines?.length} kalem</span>
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
        {recView.length === 0 && (
          <div className="mono text-sm text-txt-dim text-center py-6">Seçili kanal yok — yukarıdan kanal seç.</div>
        )}
        {gapChannels.length > 0 && (
          <div className="mono text-[11px] text-txt-dim mt-3">
            <span style={{ color: "#f8b00b" }}>⚠</span> {gapChannels.join(", ")}: CORTEX satış verisi sevk döneminden sonra başlıyor → mutabakat için Oca–Nis sell-through gerekli (eksik veri ≠ satılmadı).
          </div>
        )}
      </div>

      {/* Fatura Gezgini — ara / kanal / ay / durum süzgeci + sıralama + CSV */}
      <div className="card p-6">
        <div className="flex items-baseline justify-between flex-wrap gap-2 mb-1">
          <h2 className="font-bold">Fatura Gezgini</h2>
          <span className="mono text-xs text-txt-dim">
            {fmtInt(invSorted.length)} / {fmtInt(allInvoices.length)} fatura
            {invSorted.length > 0 && <> · {fmtInt(invQtySum)} ad · <span className="text-txt font-bold">{fmtMoney(invTotalSum)}</span> KDV dahil</>}
          </span>
        </div>
        <p className="mono text-xs text-txt-dim mb-4">Kestiğimiz toptan faturalar (Sat Öde). Fatura no, kanal ya da ürün adıyla ara; vade ayına ve durumuna göre süz; başlığa tıklayıp sırala.</p>

        <div className="flex flex-col gap-3 mb-4">
          <div className="flex items-center gap-3 flex-wrap">
            <SearchBox value={q} onChange={setQ} placeholder="Fatura no, kanal veya ürün ara…" className="w-full sm:w-80" />
            <div className="ml-auto"><CsvBtn filename="cortex-sat-ode-faturalar" rows={invSorted} cols={invCols} /></div>
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            <span className="mono text-xs text-txt-dim mr-1">Durum:</span>
            <SegTabs<StatusId>
              tabs={[
                { id: "all", label: "tümü" },
                { id: "overdue", label: `vadesi geçti (${fmtInt(statusCounts.overdue)})` },
                { id: "upcoming", label: `yaklaşan (${fmtInt(statusCounts.upcoming)})` },
              ]}
              active={status}
              onChange={setStatus}
            />
          </div>
          {monthOptions.length > 1 && (
            <div className="flex items-center gap-2 flex-wrap">
              <span className="mono text-xs text-txt-dim mr-1">Vade ayı:</span>
              <SegTabs<string>
                tabs={[{ id: "all", label: "tümü" }, ...monthOptions.map((m) => ({ id: m, label: fmtMonth(m) }))]}
                active={month}
                onChange={setMonth}
              />
            </div>
          )}
        </div>

        <div className="overflow-x-auto">
          <table>
            <thead>
              <tr>
                <th>Kanal</th>
                <th>Fatura No</th>
                <SortableTh label="Fatura tarihi" sortKey="invoice_date" active={sortKey === "invoice_date"} dir={dir} onClick={toggle} />
                <SortableTh label="Vade" sortKey="due_date" active={sortKey === "due_date"} dir={dir} onClick={toggle} />
                <SortableTh label="Adet" sortKey="qty" active={sortKey === "qty"} dir={dir} onClick={toggle} align="right" />
                <SortableTh label="Toplam" sortKey="total" active={sortKey === "total"} dir={dir} onClick={toggle} align="right" />
                <th className="text-right">Kalem</th>
              </tr>
            </thead>
            <tbody>
              {invSorted.map((f, i) => (
                <tr key={f.retailer + f.invoice_no + f.invoice_date + i}>
                  <td>
                    <span className="inline-block w-2 h-2 rounded-full mr-2" style={{ background: col(f.retailer) }} />
                    <span className="font-semibold" style={{ color: col(f.retailer) }}>{f.retailer}</span>
                  </td>
                  <td className="mono text-xs max-w-[12rem] truncate" title={f.invoice_no + (f.products ? " · " + f.products : "")}>{f.invoice_no || "—"}</td>
                  <td className="mono text-txt-dim">{fmtDate(f.invoice_date)}</td>
                  <td className="mono" style={{ color: f.overdue ? "#ff5555" : "#7d927d" }}>{fmtDate(f.due_date)}</td>
                  <td className="text-right mono text-txt-dim">{fmtInt(f.qty)}</td>
                  <td className="text-right mono font-bold">{fmtMoney(f.total)}</td>
                  <td className="text-right mono text-txt-dim">{f.lineCount}</td>
                </tr>
              ))}
            </tbody>
            {invSorted.length > 0 && (
              <tfoot>
                <tr className="border-t border-line">
                  <td colSpan={4} className="mono text-[11px] text-txt-dim uppercase tracking-wider">
                    {fmtInt(invSorted.length)} fatura toplamı
                  </td>
                  <td className="text-right mono font-bold">{fmtInt(invQtySum)}</td>
                  <td className="text-right mono font-bold">{fmtMoney(invTotalSum)}</td>
                  <td></td>
                </tr>
              </tfoot>
            )}
          </table>
        </div>
        {invSorted.length === 0 && (
          <div className="mono text-sm text-txt-dim text-center py-6">
            {allInvoices.length === 0
              ? "Fatura verisi yok."
              : "Seçili süzgeçlerle eşleşen fatura yok — aramayı temizle ya da filtreleri gevşet."}
          </div>
        )}
      </div>

      {/* Satışa dayalı tahsilat takvimi */}
      <div className="card p-6">
        <h2 className="font-bold mb-1">Tahsilat Takvimi <span className="text-txt-dim font-normal mono text-xs">· satışa dayalı</span></h2>
        <p className="mono text-xs text-txt-dim mb-4">Gerçek tahsilat = satış haftası + kanal vadesi (net kazanç). Faturanın nominal vadesi değil, fiili satışa göre.</p>
        {ss.buckets.length === 0 ? (
          <div className="mono text-sm text-txt-dim">Satış verisi yok.</div>
        ) : (
          <div className="space-y-2">
            {ss.buckets.map((b: any, i: number) => (
              <motion.div key={b.month} initial={{ opacity: 0, x: -8 }} animate={{ opacity: 1, x: 0 }} transition={{ delay: i * 0.03 }}
                className="flex items-center gap-3">
                <div className="w-20 shrink-0 mono text-xs text-txt-dim">{fmtMonth(b.month)}</div>
                <div className="flex-1 min-w-0">
                  <div className="h-7 rounded-lg bg-ink-3 overflow-hidden flex">
                    {Object.entries(b.byRetailer).sort((a: any, z: any) => z[1] - a[1]).map(([ret, v]: any) => (
                      <div key={ret} className="h-full" title={`${ret}: ${fmtMoney(v)}`}
                        style={{ width: `${(v / maxSched) * 100}%`, background: `${col(ret)}55` }} />
                    ))}
                  </div>
                </div>
                <div className="w-28 shrink-0 text-right mono text-sm font-bold">{fmtMoney(b.net)}</div>
                <div className="w-16 shrink-0 text-right mono text-[10px]" style={{ color: b.status === "collected" ? "#7d927d" : "#0bd1f8" }}>
                  {b.status === "collected" ? "tahsil" : "gelecek"}
                </div>
              </motion.div>
            ))}
          </div>
        )}
      </div>

      {/* Sevk nominal vade dağılımı (ikincil) */}
      {agSegs.length > 0 && (
        <div className="card p-6">
          <h2 className="font-bold mb-1">Sevk Nominal Vade Dağılımı</h2>
          <p className="mono text-xs text-txt-dim mb-4">Faturadaki vade tarihlerine göre (bugüne = {fmtDate(data.today)}). Gerçek tahsilat satışa bağlı; bu yalnız fatura vade yapısını gösterir · KDV dahil.</p>
          <div className="h-8 rounded-lg overflow-hidden flex bg-ink-3">
            {agSegs.map((s, i) => (
              <motion.div key={s.label} initial={{ width: 0 }} animate={{ width: `${(s.val / agingTotal) * 100}%` }}
                transition={{ delay: i * 0.06, duration: 0.6 }} style={{ background: `${s.color}40` }}
                className="h-full border-r border-ink" title={`${s.label}: ${fmtMoney(s.val)}`} />
            ))}
          </div>
          <div className="flex flex-wrap gap-x-5 gap-y-1 mt-3">
            {agSegs.map((s) => (
              <div key={s.label} className="flex items-center gap-2 mono text-xs">
                <span className="inline-block w-3 h-3 rounded-sm" style={{ background: s.color }} />
                <span className="text-txt-dim">{s.label}</span><span className="font-bold">{fmtMoney(s.val)}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Dürüstlük notu */}
      <div className="card p-5 border-l-4" style={{ borderLeftColor: "#f8b00b" }}>
        <div className="mono text-xs text-txt-dim leading-relaxed">
          <span className="text-txt font-bold">Yöntem:</span> Sevk = kestiğimiz toptan fatura (Sat Öde). Satılan = CORTEX haftalık sell-through'un net kazancı — konsinyede <span className="text-txt">sattıkları kadar ödenir</span>, bu yüzden satılan = tahsil edilebilir. İkisi de aynı net tabanda (marj + KDV düşülmüş). Sat Öde'de barkod olmadığından eşleştirme <span className="text-txt">kanal-değer</span> düzeyindedir, SKU değil. İade riski yalnız satış verisi sevk dönemini kapsayan kanallarda hesaplanır; kapsamayanlarda eksik veri "satılmadı" sayılmaz.
        </div>
      </div>
    </div>
  );
}
