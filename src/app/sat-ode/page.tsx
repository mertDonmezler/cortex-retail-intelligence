"use client";

import { useEffect, useState } from "react";
import { motion } from "framer-motion";
import { fmtInt, fmtMoney, fmtDate, RETAILER_COLORS } from "@/lib/format";
import { AnimatedNumber } from "@/components/AnimatedNumber";
import { fetchJson } from "@/lib/fetchJson";

const col = (r: string) => RETAILER_COLORS[r] ?? "#7d927d";

const MONTH_TR = ["", "Oca", "Şub", "Mar", "Nis", "May", "Haz", "Tem", "Ağu", "Eyl", "Eki", "Kas", "Ara"];
const fmtMonth = (ym: string) => { const [y, m] = ym.split("-"); return `${MONTH_TR[Number(m)]} ${y}`; };

const COVERAGE: Record<string, { label: string; color: string }> = {
  ok: { label: "tam veri", color: "#1FF80B" },
  partial: { label: "kısmi veri", color: "#f8b00b" },
  none: { label: "satış verisi yok", color: "#7d927d" },
};

export default function SatOdePage() {
  const [data, setData] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);

  useEffect(() => {
    fetchJson("/api/consignment")
      .then((d) => { setData(d); setErr(null); })
      .catch((e) => { setErr(e.message); setData(null); })
      .finally(() => setLoading(false));
  }, []);

  if (loading) return <div className="card p-10 text-center mono text-txt-dim animate-pulse">Yükleniyor…</div>;
  if (err) return <div className="card p-4 border-red-500/40 text-red-400 mono text-sm">Veri alınamadı: {err}</div>;
  if (!data || data.empty) return (
    <div className="card p-10 text-center">
      <div className="font-semibold">Henüz sat-öde verisi yok</div>
      <div className="text-txt-dim mono text-sm mt-2">seed/satode/ altına fatura Excel'ini koyup <span className="neon-text">npm run seed:satode</span> çalıştır.</div>
    </div>
  );

  const k = data.kpis;
  const rec: any[] = data.reconcile ?? [];
  const ss = data.salesSchedule ?? { buckets: [], collectedTotal: 0, upcomingTotal: 0 };
  const ag = data.aging ?? {};

  // Ağ toplamları — iade riski/sell-through yalnız "tam veri" kanallardan.
  const soldTotal = rec.reduce((a, r) => a + (r.soldNet || 0), 0);
  const okCh = rec.filter((r) => r.coverage === "ok");
  const riskTotal = okCh.reduce((a, r) => a + (r.returnRiskNet || 0), 0);
  const okSevk = okCh.reduce((a, r) => a + r.sevkNet, 0);
  const okSold = okCh.reduce((a, r) => a + r.soldNet, 0);
  const netPct = okSevk > 0 ? (okSold / okSevk) * 100 : null;
  const gapChannels = rec.filter((r) => r.coverage === "none").map((r) => r.retailer);

  const maxSched = Math.max(1, ...ss.buckets.map((b: any) => b.net));
  const agingTotal = Math.max(1, (ag.overdue || 0) + (ag.due0_30 || 0) + (ag.due31_60 || 0) + (ag.due61_90 || 0) + (ag.due90plus || 0));
  const agSegs = [
    { label: "vadesi geçti", val: ag.overdue, color: "#ff5555" },
    { label: "0–30 gün", val: ag.due0_30, color: "#f8b00b" },
    { label: "31–60 gün", val: ag.due31_60, color: "#1FF80B" },
    { label: "61–90 gün", val: ag.due61_90, color: "#0bd1f8" },
    { label: "90+ gün", val: ag.due90plus, color: "#9b6bff" },
  ].filter((s) => s.val > 0);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">Sat-Öde <span className="neon-text">Konsinye</span></h1>
        <p className="text-txt-dim mono text-sm mt-1">
          Sevk → satış → tahsilat. Tahsilat = <span className="text-txt">satılan kadar</span>; satılmayan iade.
          {k.invoiceRange && <> Fatura {fmtDate(k.invoiceRange[0])} – {fmtDate(k.invoiceRange[1])} · </>}{k.invoiceCount} fatura · {k.channelCount} kanal
        </p>
      </div>

      {/* KPI'lar */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <div className="card p-5">
          <div className="mono text-[10px] text-txt-dim tracking-wider">SEVK (GÖNDERİLEN)</div>
          <div className="text-3xl font-bold mono mt-1"><AnimatedNumber value={k.totalGross} format={(x) => fmtMoney(x)} /></div>
          <div className="mono text-[10px] text-txt-dim mt-1">net {fmtMoney(k.totalNet)} · KDV dahil</div>
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
              {rec.map((c) => {
                const isOpen = open === c.retailer;
                const inv = data.invoices?.[c.retailer] ?? [];
                const cov = COVERAGE[c.coverage] ?? COVERAGE.none;
                return (
                  <>
                    <tr key={c.retailer} className="cursor-pointer" onClick={() => setOpen(isOpen ? null : c.retailer)}>
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
                  </>
                );
              })}
            </tbody>
          </table>
        </div>
        {gapChannels.length > 0 && (
          <div className="mono text-[11px] text-txt-dim mt-3">
            <span style={{ color: "#f8b00b" }}>⚠</span> {gapChannels.join(", ")}: CORTEX satış verisi sevk döneminden sonra başlıyor → mutabakat için Oca–Nis sell-through gerekli (eksik veri ≠ satılmadı).
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
