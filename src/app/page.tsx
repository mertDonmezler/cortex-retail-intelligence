"use client";

import { useEffect, useMemo, useState } from "react";
import { motion } from "framer-motion";
import { WeeklySummary, Freshness, RETAILERS, RETAILER_COLORS, colorOf, fmtInt, fmtMoney, fmtDate, fmtDateTime, fmtPct } from "@/lib/format";
import { RetailerCard } from "@/components/RetailerCard";
import { TrendChart } from "@/components/TrendChart";
import { KpiHero } from "@/components/KpiHero";
import { Heatmap } from "@/components/Heatmap";
import { MultiChips, SegTabs } from "@/components/Controls";
import { HealthBanner } from "@/components/HealthBanner";
import { fetchJson } from "@/lib/fetchJson";

export default function DashboardPage() {
  const [summary, setSummary] = useState<WeeklySummary[]>([]);
  const [freshness, setFreshness] = useState<Freshness[]>([]);
  const [insights, setInsights] = useState<any[]>([]);
  const [overview, setOverview] = useState<any>(null); // Yönetici özeti: best/worst (Özet sayfasından taşındı)
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [week, setWeek] = useState<string>("");
  const [wowMetric, setWowMetric] = useState<"value" | "qty">("value"); // WoW bazı — varsayılan ciro
  // İSTEMCİ TARAFI: hangi perakendecilerin görüneceği (varsayılan hepsi açık → mevcut davranış korunur).
  // Bu seçim hem kartları hem Ağ Payı barını hem de Ağ KPI delta rozetlerini süzer.
  const [visible, setVisible] = useState<string[]>(RETAILERS);
  const [freshSort, setFreshSort] = useState<"taze" | "eski" | "hafta" | "ad">("taze"); // Veri tazeliği sıralaması

  useEffect(() => {
    Promise.all([
      // Ana veri (fetchJson: !ok / d.error → throw eder, render'i çökertmez)
      fetchJson("/api/dashboard"),
      // Insights ikincil: hatada boş diziye düş, ana akışı bozma
      fetchJson("/api/insights").catch(() => ({ insights: [] })),
    ])
      .then(([d, ins]) => {
        const sum = (d?.summary ?? []) as WeeklySummary[];
        setSummary(sum);
        setFreshness((d?.freshness ?? []) as Freshness[]);
        setInsights(ins?.insights ?? []);
        const weeks = [...new Set(sum.map((s) => s.week_start))].sort();
        if (weeks.length) setWeek(weeks[weeks.length - 1] as string);
      })
      .catch((e) => {
        // Gerçek arızayı gizleme: hatayı göster, state'leri güvenli boş default'a çek
        setErr(e.message);
        setSummary([]);
        setFreshness([]);
        setInsights([]);
      })
      .finally(() => setLoading(false));
  }, []);

  // Yönetici özeti (best/worst) — seçili haftaya göre; ikincil veri, hatada ana akışı bozma.
  useEffect(() => {
    fetchJson(week ? `/api/overview?week=${encodeURIComponent(week)}` : "/api/overview")
      .then((d) => setOverview(d))
      .catch(() => setOverview(null));
  }, [week]);

  const weeks = useMemo(
    () => [...new Set(summary.map((s) => s.week_start))].sort().reverse(),
    [summary]
  );

  // En güncel hafta (tüm ağda) — tazelik sağlık rozetinde "kaç hafta geride" hesabı için referans.
  const latestWeek = weeks[0] ?? null;
  const visibleSet = useMemo(() => new Set(visible), [visible]);

  // Ağ payı: seçili haftada her görünür perakendecinin net ciro (TL) payı.
  // sales_value null olabilir → 0 say. Pay yalnız görünür perakendeciler toplamına göre normalize edilir
  // ki kart filtresiyle bar tutarlı kalsın ("bu seçimde kimin payı ne").
  const shareRows = useMemo(() => {
    const wk = summary.filter((s) => s.week_start === week && visibleSet.has(s.retailer));
    const rows = wk.map((s) => ({
      retailer: s.retailer,
      value: Number(s.sales_value ?? 0),
      qty: Number(s.sales_qty),
    }));
    const total = rows.reduce((a, r) => a + r.value, 0);
    return rows
      .map((r) => ({ ...r, share: total > 0 ? (r.value / total) * 100 : 0 }))
      .sort((a, b) => b.value - a.value);
  }, [summary, week, visibleSet]);

  // Ağ KPI delta: seçili hafta vs. önceki hafta (yalnız görünür perakendeciler).
  // Önceki hafta = weeks dizisinde (azalan) seçili haftanın bir sonrası.
  const kpiDelta = useMemo(() => {
    const prevWeek = (() => {
      const i = weeks.indexOf(week);
      return i >= 0 && i + 1 < weeks.length ? weeks[i + 1] : null;
    })();
    const agg = (wk: string | null) => {
      if (!wk) return null;
      const rows = summary.filter((s) => s.week_start === wk && visibleSet.has(s.retailer));
      if (!rows.length) return null;
      const qty = rows.reduce((a, s) => a + Number(s.sales_qty), 0);
      const val = rows.reduce((a, s) => a + Number(s.sales_value ?? 0), 0);
      const stock = rows.reduce((a, s) => a + Number(s.stock_qty), 0);
      const st = qty + stock > 0 ? (qty / (qty + stock)) * 100 : 0;
      return { qty, val, st };
    };
    return { cur: agg(week), prev: agg(prevWeek), prevWeek };
  }, [summary, week, weeks, visibleSet]);

  if (loading) return <Loading />;
  if (err) return <ErrorBox msg={err} />;
  if (!summary.length) return <Empty />;

  // Sinyaller de görünür perakendeci filtresine uyar (kartlar/ağ payı/KPI ile tutarlı).
  // Önce kritik+uyarı eşiğine süz, sonra seçili perakendecilere daralt.
  const alertInsights = insights.filter(
    (i) => (i.severity === "critical" || i.severity === "warning") && visibleSet.has(i.retailer)
  );
  const topInsights = alertInsights.slice(0, 3);

  return (
    <div className="space-y-8">
      <motion.div
        initial={{ opacity: 0, y: -8 }} animate={{ opacity: 1, y: 0 }}
        className="flex flex-wrap items-end justify-between gap-4"
      >
        <div>
          <h1 className="text-3xl font-bold tracking-tight">
            Perakende <span className="neon-text">Dashboard</span>
          </h1>
          <p className="text-txt-dim mono text-sm mt-1">
            Mythos Cards · çok-perakendeci · ciro = net kazanç (çalışma marjı + KDV düşülmüş)
          </p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <div className="flex gap-1 mono text-xs">
            <button onClick={() => setWowMetric("value")}
              className={`px-3 py-1.5 rounded ${wowMetric === "value" ? "bg-neon/15 text-neon" : "text-txt-dim"}`}>WoW: Ciro</button>
            <button onClick={() => setWowMetric("qty")}
              className={`px-3 py-1.5 rounded ${wowMetric === "qty" ? "bg-neon/15 text-neon" : "text-txt-dim"}`}>Adet</button>
          </div>
          <select
            value={week}
            onChange={(e) => setWeek(e.target.value)}
            className="card mono text-sm px-4 py-2 bg-ink-2 outline-none focus:border-neon"
          >
            {weeks.map((w) => (
              <option key={w} value={w} className="bg-ink-2">{fmtDate(w)}</option>
            ))}
          </select>
          <a
            href={`/api/export?week=${encodeURIComponent(week)}`}
            className="mono text-xs px-4 py-2 rounded-lg bg-neon text-ink font-bold hover:bg-neon-dim transition-colors"
          >
            ⬇ Excel rapor indir
          </a>
        </div>
      </motion.div>

      {/* Veri Sağlığı bekçisi — sorun varsa açılır kart, sağlıklıysa ince satır (yeni sayfa yok). */}
      <HealthBanner />

      {/* İSTEMCİ TARAFI: perakendeci görünürlük filtresi — kartları, ağ payını ve KPI deltalarını süzer. */}
      <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: 0.04 }}
        className="flex flex-wrap items-center justify-between gap-3">
        <MultiChips
          label="Perakendeciler:"
          options={RETAILERS}
          selected={visible}
          onToggle={(r) => setVisible((v) => (v.includes(r) ? v.filter((x) => x !== r) : [...v, r]))}
          onAll={() => setVisible(RETAILERS)}
          onNone={() => setVisible([])}
          colorOf={colorOf}
        />
        <span className="mono text-[11px] text-txt-dim shrink-0">
          {visible.length} / {RETAILERS.length} görünür
        </span>
      </motion.div>

      <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.05 }}>
        <KpiHero summary={summary} week={week} />
      </motion.div>

      {/* İSTEMCİ TARAFI: seçili hafta vs. önceki hafta — görünür perakendeciler için ağ KPI delta rozetleri. */}
      <KpiDeltaStrip delta={kpiDelta} visibleCount={visible.length} />

      {/* İSTEMCİ TARAFI: Ağ payı — seçili haftada her görünür perakendecinin net ciro payı (yatay bar). */}
      <NetworkShare rows={shareRows} week={week} />

      {(overview?.best || overview?.worst) && (
        <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.08 }}
          className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {overview?.best && (
            <div className="card p-5 border-l-4" style={{ borderLeftColor: "#1FF80B" }}>
              <div className="mono text-xs text-txt-dim">HAFTANIN YILDIZI ▲</div>
              <div className="text-xl font-bold mt-1" style={{ color: RETAILER_COLORS[overview.best.retailer] }}>{overview.best.retailer}</div>
              <div className="mono text-sm text-neon">{fmtPct(overview.best.wow)} haftalık büyüme</div>
            </div>
          )}
          {overview?.worst && (
            <div className="card p-5 border-l-4" style={{ borderLeftColor: "#ff5555" }}>
              <div className="mono text-xs text-txt-dim">DİKKAT ÇEKEN ▼</div>
              <div className="text-xl font-bold mt-1" style={{ color: RETAILER_COLORS[overview.worst.retailer] }}>{overview.worst.retailer}</div>
              <div className="mono text-sm text-red-400">{fmtPct(overview.worst.wow)} haftalık değişim</div>
            </div>
          )}
        </motion.div>
      )}

      {topInsights.length > 0 && (
        <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: 0.1 }}
          className="card p-5 border-l-4" style={{ borderLeftColor: "#ff3b3b" }}>
          <div className="flex items-center justify-between mb-3">
            <div className="mono text-xs text-txt-dim tracking-wider">
              DİKKAT GEREKTİREN SİNYALLER
              <span className="ml-2 text-txt-dim/70">{topInsights.length} / {alertInsights.length}</span>
            </div>
            <a href="/insights" className="mono text-xs neon-text">tümü &rarr;</a>
          </div>
          <div className="space-y-2">
            {topInsights.map((ins, i) => {
              // Kritik kırmızı, uyarı amber — rozet rengi gerçek önem derecesini yansıtsın.
              const sc = ins.severity === "critical" ? "#ff3b3b" : "#f8b00b";
              return (
                <div key={i} className="flex items-center gap-3 text-sm">
                  <span className="mono text-[10px] px-2 py-0.5 rounded shrink-0"
                    style={{ color: sc, border: `1px solid ${sc}40`, background: sc + "14" }}>{ins.retailer}</span>
                  <span className="flex-1 truncate" title={ins.detail || ins.title}>{ins.title}</span>
                  {ins.metric && <span className="mono text-xs text-txt-dim shrink-0">{ins.metric}</span>}
                </div>
              );
            })}
          </div>
        </motion.div>
      )}

      <FreshnessStrip freshness={freshness} latestWeek={latestWeek} sort={freshSort} onSort={setFreshSort} />

      <div>
        <div className="flex items-baseline justify-between mb-3">
          <h2 className="font-bold text-lg">Perakendeci Kartları</h2>
          <span className="mono text-xs text-txt-dim">
            {visible.length} / {RETAILERS.length}
          </span>
        </div>
        {visible.length === 0 ? (
          <div className="card p-8 text-center text-txt-dim mono text-sm">
            Tüm perakendeciler gizli — yukarıdan <span className="neon-text">tümü</span> ile geri aç.
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-3 lg:grid-cols-5 gap-4">
            {RETAILERS.filter((r) => visibleSet.has(r)).map((r, i) => (
              <motion.div key={r}
                initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }}
                transition={{ delay: 0.15 + i * 0.05 }}>
                <RetailerCard retailer={r} week={week} summary={summary} wowMetric={wowMetric} />
              </motion.div>
            ))}
          </div>
        )}
      </div>

      <TrendChart summary={summary} />
      <Heatmap summary={summary} />
    </div>
  );
}

// Tazelik sağlığı: en güncel ağ haftasına göre perakendecinin kaç hafta geride olduğu.
// 0 hafta → güncel (taze), 1 hafta → hafif gecikme, ≥2 hafta → eski; veri yoksa ayrı durum.
type Health = { key: "taze" | "gecikme" | "eski" | "yok"; label: string; color: string; lag: number };
function freshHealth(lastWeek: string | null, latestWeek: string | null): Health {
  if (!lastWeek) return { key: "yok", label: "veri yok", color: "#7d927d", lag: Infinity };
  if (!latestWeek) return { key: "taze", label: "güncel", color: "#1FF80B", lag: 0 };
  // Hafta başları ISO tarih (YYYY-MM-DD) → 7 günlük adımlarla fark.
  const ms = new Date(latestWeek).getTime() - new Date(lastWeek).getTime();
  const lag = Math.max(0, Math.round(ms / (7 * 86400000)));
  if (lag <= 0) return { key: "taze", label: "güncel", color: "#1FF80B", lag: 0 };
  if (lag === 1) return { key: "gecikme", label: "1 hf geride", color: "#f8b00b", lag };
  return { key: "eski", label: `${lag} hf geride`, color: "#ff5555", lag };
}

function FreshnessStrip({
  freshness, latestWeek, sort, onSort,
}: {
  freshness: Freshness[];
  latestWeek: string | null;
  sort: "taze" | "eski" | "hafta" | "ad";
  onSort: (s: "taze" | "eski" | "hafta" | "ad") => void;
}) {
  const byRetailer = new Map(freshness.map((f) => [f.retailer, f]));
  // Her perakendeci için sağlığı önceden hesapla, sonra seçilen ölçüte göre sırala.
  const rows = RETAILERS.map((r) => {
    const f = byRetailer.get(r);
    return { retailer: r, f, h: freshHealth(f?.last_week ?? null, latestWeek) };
  });
  const sorted = [...rows].sort((a, b) => {
    if (sort === "ad") return a.retailer.localeCompare(b.retailer, "tr");
    if (sort === "hafta") return (b.f?.week_count ?? 0) - (a.f?.week_count ?? 0);
    // taze: en güncel üstte (lag artan) · eski: en bayat üstte (lag azalan)
    const d = a.h.lag - b.h.lag;
    return sort === "taze" ? d : -d;
  });

  return (
    <div className="card p-4">
      <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
        <div className="mono text-xs text-txt-dim uppercase tracking-wider">
          Veri Tazeliği · son hafta / hafta sayısı / son import
        </div>
        <SegTabs
          tabs={[
            { id: "taze", label: "En taze" },
            { id: "eski", label: "En eski" },
            { id: "hafta", label: "Hafta" },
            { id: "ad", label: "A→Z" },
          ] as const}
          active={sort}
          onChange={onSort}
        />
      </div>
      <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
        {sorted.map(({ retailer, f, h }) => (
          <div key={retailer} className="border-l-2 pl-3" style={{ borderColor: colorOf(retailer) }}>
            <div className="flex items-center justify-between gap-1">
              <div className="font-semibold text-sm truncate">{retailer}</div>
              <span
                className="mono text-[9px] px-1.5 py-0.5 rounded shrink-0"
                style={{ color: h.color, border: `1px solid ${h.color}40`, background: h.color + "14" }}
                title="En güncel ağ haftasına göre gecikme"
              >
                {h.label}
              </span>
            </div>
            <div className="mono text-xs text-txt-dim mt-1">
              {f?.last_week ? fmtDate(f.last_week) : "veri yok"}
            </div>
            <div className="mono text-xs text-txt-dim">{f?.week_count ?? 0} hafta</div>
            <div className="mono text-[10px] text-txt-dim mt-1">
              {f?.last_import ? fmtDateTime(f.last_import) : "-"}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// İSTEMCİ TARAFI: seçili hafta vs. önceki hafta — görünür perakendecilerin ağ toplamı + delta rozeti.
function KpiDeltaStrip({
  delta, visibleCount,
}: {
  delta: { cur: { qty: number; val: number; st: number } | null; prev: { qty: number; val: number; st: number } | null; prevWeek: string | null };
  visibleCount: number;
}) {
  const { cur, prev, prevWeek } = delta;
  if (visibleCount === 0) {
    return (
      <div className="card p-4 text-center text-txt-dim mono text-xs">
        Ağ KPI: perakendeci seçili değil.
      </div>
    );
  }
  if (!cur) {
    return (
      <div className="card p-4 text-center text-txt-dim mono text-xs">
        Seçili hafta için ağ KPI verisi yok.
      </div>
    );
  }
  // Yüzde delta (önceki hafta yoksa null → "—"). Puan farkı sell-through için kullanılır.
  const pct = (c: number, p: number | undefined) => (p != null && p > 0 ? ((c - p) / p) * 100 : null);
  const items = [
    { label: "AĞ CİROSU", value: fmtMoney(cur.val), d: pct(cur.val, prev?.val), color: "#d8e8d8" },
    { label: "AĞ SATIŞ", value: `${fmtInt(cur.qty)} adet`, d: pct(cur.qty, prev?.qty), color: "#1FF80B" },
    {
      label: "SELL-THROUGH",
      value: cur.st.toFixed(1) + "%",
      d: prev ? cur.st - prev.st : null, // puan farkı (yüzde değil)
      pts: true,
      color: "#f8b00b",
    },
  ];
  return (
    <div className="card p-4">
      <div className="mono text-[10px] text-txt-dim tracking-wider mb-3 uppercase">
        Ağ KPI · seçili hafta vs. {prevWeek ? fmtDate(prevWeek) : "önceki hafta yok"} · {visibleCount} perakendeci
      </div>
      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        {items.map((it) => {
          const up = it.d != null && it.d >= 0;
          const c = it.d == null ? "#7d927d" : up ? "#1FF80B" : "#ff5555";
          const txt =
            it.d == null
              ? "—"
              : it.pts
              ? `${up ? "+" : ""}${it.d.toFixed(1)} pt`
              : fmtPct(it.d);
          return (
            <div key={it.label} className="flex items-center justify-between gap-2">
              <div>
                <div className="mono text-[10px] text-txt-dim tracking-wider">{it.label}</div>
                <div className="text-xl font-bold mono mt-0.5" style={{ color: it.color }}>{it.value}</div>
              </div>
              <span
                className="mono text-xs px-2 py-1 rounded shrink-0"
                style={{ color: c, border: `1px solid ${c}40`, background: c + "14" }}
                title="Önceki haftaya göre değişim"
              >
                {it.d != null && it.d >= 0 ? "▲" : it.d != null ? "▼" : ""} {txt}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// İSTEMCİ TARAFI: Ağ payı — görünür perakendecilerin seçili haftadaki net ciro payı (yatay bar).
function NetworkShare({
  rows, week,
}: {
  rows: { retailer: string; value: number; qty: number; share: number }[];
  week: string;
}) {
  const total = rows.reduce((a, r) => a + r.value, 0);
  return (
    <div className="card p-4">
      <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
        <div className="mono text-[10px] text-txt-dim tracking-wider uppercase">
          Ağ Payı · net ciro · {fmtDate(week)}
        </div>
        <span className="mono text-[11px] text-txt-dim">
          {rows.length} perakendeci · {fmtMoney(total)}
        </span>
      </div>
      {rows.length === 0 || total <= 0 ? (
        <div className="text-txt-dim mono text-xs py-2">
          {rows.length === 0 ? "Görünür perakendeci yok." : "Bu hafta için ciro verisi yok."}
        </div>
      ) : (
        <div className="space-y-2">
          {rows.map((r) => {
            const c = colorOf(r.retailer);
            return (
              <div key={r.retailer} className="flex items-center gap-3">
                <div className="w-24 shrink-0 mono text-xs truncate" style={{ color: c }} title={r.retailer}>
                  {r.retailer}
                </div>
                <div className="flex-1 h-3 rounded-full bg-ink-2 overflow-hidden border border-line">
                  <div
                    className="h-full rounded-full transition-all"
                    style={{ width: `${Math.max(2, r.share)}%`, background: c }}
                  />
                </div>
                <div className="w-28 shrink-0 text-right mono text-xs">
                  <span style={{ color: c }}>{r.share.toFixed(1)}%</span>
                  <span className="text-txt-dim ml-1">{fmtMoney(r.value)}</span>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function Loading() {
  return (
    <div className="space-y-6">
      <div className="h-10 w-64 card animate-pulse" />
      <div className="grid grid-cols-3 md:grid-cols-6 gap-3">
        {[...Array(6)].map((_, i) => <div key={i} className="card h-20 animate-pulse" />)}
      </div>
      <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
        {[...Array(5)].map((_, i) => <div key={i} className="card h-48 animate-pulse" />)}
      </div>
    </div>
  );
}
function ErrorBox({ msg }: { msg: string }) {
  return (
    <div className="card p-6 border-red-500/40">
      <div className="text-red-400 mono text-sm">Hata: {msg}</div>
      <div className="text-txt-dim text-sm mt-2">Supabase bağlantısını ve .env değerlerini kontrol et.</div>
    </div>
  );
}
function Empty() {
  return (
    <div className="card p-10 text-center">
      <div className="text-2xl mb-2">[ ]</div>
      <div className="font-semibold">Henüz veri yok</div>
      <p className="text-txt-dim text-sm mt-2">
        <a href="/upload" className="neon-text">Veri Yükle</a> sayfasından ilk haftayı içe aktar.
      </p>
    </div>
  );
}
