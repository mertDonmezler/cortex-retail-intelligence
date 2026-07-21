"use client";

import { useEffect, useState } from "react";

interface Issue { id: string; severity: "high" | "med" | "low" | "info"; label: string; count: number; hint: string; examples?: string[] }
interface Health { score: number; latestWeek: string | null; retailers: { total: number; stale: number }; issues: Issue[] }

const SEV = {
  high: { c: "#ff5555", t: "KRİTİK" },
  med: { c: "#f8b00b", t: "ORTA" },
  low: { c: "#7d927d", t: "DÜŞÜK" },
  info: { c: "#0bd1f8", t: "BİLGİ" },
} as const;

// Veri Sağlığı bekçisi — dashboard üstünde. Sağlıklıysa ince tek satır; sorun
// varsa puan + açılabilir sorun listesi. Yeni sayfa YOK; minimal ve kendiliğinden çeker.
export function HealthBanner() {
  const [h, setH] = useState<Health | null>(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    fetch("/api/health")
      .then((r) => (r.ok ? r.json() : null))
      // Otomatik AÇILMAZ: kronik sorunlar (ör. bilinen fiyatsız kalemler) her gün
      // sayfanın tepesini kaplıyordu. Özet satırı puan+rozetlerle zaten uyarır;
      // detay isteyen tıklar.
      .then((d) => { if (d && !d.error) setH(d); })
      .catch(() => {});
  }, []);

  if (!h) return null;
  const issues = h.issues ?? [];
  const real = issues.filter((i) => i.severity !== "info");
  const scoreColor = h.score >= 90 ? "#1FF80B" : h.score >= 70 ? "#f8b00b" : "#ff5555";

  // Tertemiz: yalnız ince bir onay satırı.
  if (real.length === 0 && issues.length === 0) {
    return (
      <div className="mono text-[11px] text-txt-dim flex items-center gap-2">
        <span style={{ color: "#1FF80B" }}>●</span> Veri sağlıklı · {h.retailers.total} firma{h.latestWeek ? ` · son hafta ${h.latestWeek}` : ""}
      </div>
    );
  }

  return (
    <div className="card overflow-hidden">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="w-full flex items-center justify-between gap-3 px-4 py-3 text-left hover:bg-neon/5 transition-colors"
        aria-expanded={open}
      >
        <div className="flex items-center gap-3 flex-wrap">
          <span className="mono text-xs tracking-wider text-txt-dim">VERİ SAĞLIĞI</span>
          <span className="mono text-lg font-bold" style={{ color: scoreColor }}>{h.score}<span className="text-xs text-txt-dim">/100</span></span>
          <span className="mono text-xs text-txt-dim">
            {real.length > 0 ? `${real.length} sorun` : "küçük not"}
            {issues.length > real.length ? ` · ${issues.length - real.length} bilgi` : ""}
          </span>
          {/* sorun rozetleri (özet) */}
          <span className="flex gap-1">
            {issues.slice(0, 5).map((i) => (
              <span key={i.id} className="mono text-[10px] px-1.5 py-0.5 rounded" style={{ color: SEV[i.severity].c, background: SEV[i.severity].c + "1a" }}>
                {i.count}
              </span>
            ))}
          </span>
        </div>
        <span className="mono text-xs text-txt-dim shrink-0">{open ? "▾ gizle" : "▸ incele"}</span>
      </button>

      {open && (
        <div className="border-t border-line/60 divide-y divide-line/40">
          {issues.map((i) => (
            <div key={i.id} className="px-4 py-2.5 flex items-start gap-3">
              <span className="mono text-[9px] px-1.5 py-0.5 rounded mt-0.5 shrink-0" style={{ color: SEV[i.severity].c, background: SEV[i.severity].c + "1a" }}>{SEV[i.severity].t}</span>
              <div className="min-w-0 flex-1">
                <div className="text-sm">
                  <span className="font-bold mono" style={{ color: SEV[i.severity].c }}>{i.count}</span>{" "}
                  <span className="text-txt">{i.label}</span>
                </div>
                <div className="mono text-[11px] text-txt-dim mt-0.5">{i.hint}</div>
                {i.examples && i.examples.length > 0 && (
                  <ul className="mono text-[10px] text-txt-dim/80 mt-1 space-y-0.5">
                    {i.examples.map((ex, k) => <li key={k} className="truncate">↳ {ex}</li>)}
                  </ul>
                )}
                {i.id === "toyzz_ean" && (
                  <a href="/eslesme" className="mono text-[11px] neon-text hover:underline mt-1 inline-block">→ /eslesme'de onayla</a>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
