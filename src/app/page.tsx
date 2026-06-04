"use client";

import { useEffect, useMemo, useState } from "react";
import { motion } from "framer-motion";
import { WeeklySummary, Freshness, RETAILERS, fmtDate, fmtDateTime } from "@/lib/format";
import { RetailerCard } from "@/components/RetailerCard";
import { TrendChart } from "@/components/TrendChart";
import { KpiHero } from "@/components/KpiHero";
import { Heatmap } from "@/components/Heatmap";

export default function DashboardPage() {
  const [summary, setSummary] = useState<WeeklySummary[]>([]);
  const [freshness, setFreshness] = useState<Freshness[]>([]);
  const [insights, setInsights] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [week, setWeek] = useState<string>("");
  const [wowMetric, setWowMetric] = useState<"value" | "qty">("value"); // WoW bazı — varsayılan ciro

  useEffect(() => {
    Promise.all([
      // Ana veri: 500 / JSON-olmayan yanit render'i cokertmesin diye r.ok + d.error kontrolu
      fetch("/api/dashboard").then(async (r) => {
        const d = await r.json().catch(() => ({}));
        if (!r.ok || d?.error) throw new Error(d?.error || ("Sunucu hatasi " + r.status));
        return d;
      }),
      // Insights ikincil: hatada bos diziye dus, ana akisi bozma
      fetch("/api/insights")
        .then(async (r) => {
          const d = await r.json().catch(() => ({}));
          if (!r.ok || d?.error) throw new Error(d?.error || ("Sunucu hatasi " + r.status));
          return d;
        })
        .catch(() => ({ insights: [] })),
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

  const weeks = useMemo(
    () => [...new Set(summary.map((s) => s.week_start))].sort().reverse(),
    [summary]
  );

  if (loading) return <Loading />;
  if (err) return <ErrorBox msg={err} />;
  if (!summary.length) return <Empty />;

  const topInsights = insights
    .filter((i) => i.severity === "critical" || i.severity === "warning")
    .slice(0, 3);

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
        </div>
      </motion.div>

      <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.05 }}>
        <KpiHero summary={summary} week={week} />
      </motion.div>

      {topInsights.length > 0 && (
        <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: 0.1 }}
          className="card p-5 border-l-4" style={{ borderLeftColor: "#ff3b3b" }}>
          <div className="flex items-center justify-between mb-3">
            <div className="mono text-xs text-txt-dim tracking-wider">DİKKAT GEREKTİREN SİNYALLER</div>
            <a href="/insights" className="mono text-xs neon-text">tümü &rarr;</a>
          </div>
          <div className="space-y-2">
            {topInsights.map((ins, i) => (
              <div key={i} className="flex items-center gap-3 text-sm">
                <span className="mono text-[10px] px-2 py-0.5 rounded shrink-0"
                  style={{ color: "#f8b00b", border: "1px solid #f8b00b40" }}>{ins.retailer}</span>
                <span className="flex-1 truncate">{ins.title}</span>
                {ins.metric && <span className="mono text-xs text-txt-dim shrink-0">{ins.metric}</span>}
              </div>
            ))}
          </div>
        </motion.div>
      )}

      <FreshnessStrip freshness={freshness} />

      <div>
        <h2 className="font-bold mb-3 text-lg">Perakendeci Kartları</h2>
        <div className="grid grid-cols-1 md:grid-cols-3 lg:grid-cols-5 gap-4">
          {RETAILERS.map((r, i) => (
            <motion.div key={r}
              initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.15 + i * 0.05 }}>
              <RetailerCard retailer={r} week={week} summary={summary} wowMetric={wowMetric} />
            </motion.div>
          ))}
        </div>
      </div>

      <TrendChart summary={summary} />
      <Heatmap summary={summary} />
    </div>
  );
}

function FreshnessStrip({ freshness }: { freshness: Freshness[] }) {
  const byRetailer = new Map(freshness.map((f) => [f.retailer, f]));
  return (
    <div className="card p-4">
      <div className="mono text-xs text-txt-dim mb-3 uppercase tracking-wider">
        Veri Tazeliği · son hafta / hafta sayısı / son import
      </div>
      <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
        {RETAILERS.map((r) => {
          const f = byRetailer.get(r);
          return (
            <div key={r} className="border-l-2 border-line pl-3">
              <div className="font-semibold text-sm">{r}</div>
              <div className="mono text-xs text-txt-dim mt-1">
                {f?.last_week ? fmtDate(f.last_week) : "veri yok"}
              </div>
              <div className="mono text-xs text-txt-dim">{f?.week_count ?? 0} hafta</div>
              <div className="mono text-[10px] text-txt-dim mt-1">
                {f?.last_import ? fmtDateTime(f.last_import) : "-"}
              </div>
            </div>
          );
        })}
      </div>
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
