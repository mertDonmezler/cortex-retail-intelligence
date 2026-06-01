"use client";

import { useEffect, useState } from "react";
import { motion } from "framer-motion";

interface Insight {
  severity: "critical" | "warning" | "positive" | "info";
  retailer: string;
  title: string;
  detail: string;
  metric?: string;
}

const SEV = {
  critical: { label: "KRİTİK", color: "#ff3b3b", bg: "rgba(255,59,59,0.08)", icon: "⚠" },
  warning:  { label: "UYARI",  color: "#f8b00b", bg: "rgba(248,176,11,0.08)", icon: "▼" },
  positive: { label: "POZİTİF", color: "#1FF80B", bg: "rgba(31,248,11,0.08)", icon: "▲" },
  info:     { label: "BİLGİ",  color: "#0bd1f8", bg: "rgba(11,209,248,0.08)", icon: "◈" },
};

export default function InsightsPage() {
  const [insights, setInsights] = useState<Insight[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [filter, setFilter] = useState<string>("all");

  useEffect(() => {
    fetch("/api/insights")
      .then(async (r) => {
        const d = await r.json().catch(() => ({}));
        if (!r.ok || d?.error) throw new Error(d?.error || ("Sunucu hatası " + r.status));
        return d;
      })
      .then((d) => setInsights(d?.insights ?? []))
      .catch((e) => {
        setErr(e.message);
        // Render'ın çökmemesi için güvenli boş default
        setInsights([]);
      })
      .finally(() => setLoading(false));
  }, []);

  const safeInsights = insights ?? [];
  const filtered = filter === "all" ? safeInsights : safeInsights.filter((i) => i.severity === filter);
  const counts = {
    critical: safeInsights.filter((i) => i.severity === "critical").length,
    warning: safeInsights.filter((i) => i.severity === "warning").length,
    positive: safeInsights.filter((i) => i.severity === "positive").length,
    info: safeInsights.filter((i) => i.severity === "info").length,
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">
          Intelligence <span className="neon-text">Akışı</span>
        </h1>
        <p className="text-txt-dim mono text-sm mt-1">
          Otomatik üretilen sinyaller — momentum, anomali, stockout riski, tahmin
        </p>
      </div>

      {/* Özet sayaçlar */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        {(["critical", "warning", "positive", "info"] as const).map((s) => (
          <button
            key={s}
            onClick={() => setFilter(filter === s ? "all" : s)}
            className="card p-4 text-left transition-transform hover:scale-[1.02]"
            style={{ borderColor: filter === s ? SEV[s].color : undefined }}
          >
            <div className="mono text-xs" style={{ color: SEV[s].color }}>
              {SEV[s].icon} {SEV[s].label}
            </div>
            <div className="text-3xl font-bold mono mt-1">{counts[s]}</div>
          </button>
        ))}
      </div>

      {/* Hata kartı — gerçek arızayı "veri yok" gibi göstermemek için ayrı */}
      {err && (
        <div className="card p-4 border-red-500/40 text-red-400 mono text-sm">
          Veri alınamadı: {err}
        </div>
      )}

      {loading ? (
        <div className="space-y-3">
          {[...Array(5)].map((_, i) => (
            <div key={i} className="card p-5 animate-pulse h-20" />
          ))}
        </div>
      ) : err ? null : filtered.length === 0 ? (
        <div className="card p-10 text-center text-txt-dim mono">
          {safeInsights.length === 0 ? "Henüz yeterli veri yok — birkaç hafta yükleyince sinyaller belirir." : "Bu kategoride sinyal yok."}
        </div>
      ) : (
        <div className="space-y-3">
          {filtered.map((ins, i) => {
            const sev = SEV[ins.severity];
            return (
              <motion.div
                key={i}
                initial={{ opacity: 0, y: 12 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: i * 0.04, duration: 0.3 }}
                className="card p-5 flex items-start gap-4"
                style={{ background: sev.bg }}
              >
                <div className="mono text-lg shrink-0" style={{ color: sev.color }}>
                  {sev.icon}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="mono text-[10px] px-2 py-0.5 rounded"
                      style={{ color: sev.color, background: sev.bg, border: `1px solid ${sev.color}40` }}>
                      {ins.retailer}
                    </span>
                    <span className="font-semibold">{ins.title}</span>
                  </div>
                  <p className="text-txt-dim text-sm mt-1">{ins.detail}</p>
                </div>
                {ins.metric && (
                  <div className="mono text-sm font-bold shrink-0" style={{ color: sev.color }}>
                    {ins.metric}
                  </div>
                )}
              </motion.div>
            );
          })}
        </div>
      )}
    </div>
  );
}
