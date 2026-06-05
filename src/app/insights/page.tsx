"use client";

import { useEffect, useMemo, useState } from "react";
import { motion } from "framer-motion";
import { fetchJson } from "@/lib/fetchJson";
import { SearchBox, MultiChips, SegTabs, CsvBtn, StatCard } from "@/components/Controls";
import { colorOf } from "@/lib/format";

interface Insight {
  severity: "critical" | "warning" | "positive" | "info";
  retailer: string;
  title: string;
  detail: string;
  metric?: string;
}

type Severity = Insight["severity"];

const SEV: Record<Severity, { label: string; color: string; bg: string; icon: string; rank: number }> = {
  critical: { label: "KRİTİK", color: "#ff3b3b", bg: "rgba(255,59,59,0.08)", icon: "⚠", rank: 0 },
  warning:  { label: "UYARI",  color: "#f8b00b", bg: "rgba(248,176,11,0.08)", icon: "▼", rank: 1 },
  positive: { label: "POZİTİF", color: "#1FF80B", bg: "rgba(31,248,11,0.08)", icon: "▲", rank: 2 },
  info:     { label: "BİLGİ",  color: "#0bd1f8", bg: "rgba(11,209,248,0.08)", icon: "◈", rank: 3 },
};

const SEV_ORDER = ["critical", "warning", "positive", "info"] as const;

// Sıralama modları — hepsi istemci tarafı, çekilen veriyi yeniden düzenler.
type SortMode = "severity" | "retailer" | "title";
const SORT_TABS: { id: SortMode; label: string }[] = [
  { id: "severity", label: "Önem" },
  { id: "retailer", label: "Firma" },
  { id: "title", label: "Başlık" },
];

export default function InsightsPage() {
  const [insights, setInsights] = useState<Insight[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  // ── İstemci tarafı kontrol durumu ──
  const [sevSel, setSevSel] = useState<Severity[]>([...SEV_ORDER]); // çoklu severity filtresi
  const [retSel, setRetSel] = useState<string[]>([]);               // çoklu firma filtresi (boş = hepsi gizli)
  const [retInit, setRetInit] = useState(false);                    // firma listesi ilk veride dolduruldu mu
  const [q, setQ] = useState("");                                   // başlık/detay/firma araması
  const [sort, setSort] = useState<SortMode>("severity");
  const [grouped, setGrouped] = useState(true);                     // severity'e göre grupla görünümü

  useEffect(() => {
    fetchJson("/api/insights")
      .then((d) => setInsights(d?.insights ?? []))
      .catch((e) => {
        setErr(e.message);
        // Render'ın çökmemesi için güvenli boş default
        setInsights([]);
      })
      .finally(() => setLoading(false));
  }, []);

  const safeInsights = useMemo(() => insights ?? [], [insights]);

  // Veride görünen firmalar (kanonik sıraya yakın, ama veriye göre) — filtre chip'leri için.
  const retailers = useMemo(() => {
    const seen = new Set<string>();
    for (const i of safeInsights) if (i.retailer) seen.add(i.retailer);
    return [...seen].sort((a, b) => a.localeCompare(b, "tr"));
  }, [safeInsights]);

  // Veri ilk geldiğinde tüm firmaları seçili başlat (kullanıcı sonra daraltır).
  useEffect(() => {
    if (!retInit && retailers.length > 0) {
      setRetSel(retailers);
      setRetInit(true);
    }
  }, [retailers, retInit]);

  // Severity bazlı toplam sayaçlar (filtreden bağımsız — üst StatCard'lar ve chip rozetleri).
  const counts = useMemo(() => {
    const c: Record<Severity, number> = { critical: 0, warning: 0, positive: 0, info: 0 };
    for (const i of safeInsights) c[i.severity] = (c[i.severity] ?? 0) + 1;
    return c;
  }, [safeInsights]);

  // ── Filtre + arama + sıralama hep birlikte (istemci tarafı) ──
  const filtered = useMemo(() => {
    const sevSet = new Set(sevSel);
    const retSet = new Set(retSel);
    const needle = q.trim().toLocaleLowerCase("tr");
    const out = safeInsights.filter((i) => {
      if (!sevSet.has(i.severity)) return false;
      if (!retSet.has(i.retailer)) return false;
      if (needle) {
        const hay = `${i.retailer} ${i.title} ${i.detail} ${i.metric ?? ""}`.toLocaleLowerCase("tr");
        if (!hay.includes(needle)) return false;
      }
      return true;
    });
    const by = (a: Insight, b: Insight) => {
      if (sort === "severity") {
        const d = SEV[a.severity].rank - SEV[b.severity].rank;
        if (d !== 0) return d;
        return a.retailer.localeCompare(b.retailer, "tr");
      }
      if (sort === "retailer") {
        const d = a.retailer.localeCompare(b.retailer, "tr");
        if (d !== 0) return d;
        return SEV[a.severity].rank - SEV[b.severity].rank;
      }
      return a.title.localeCompare(b.title, "tr");
    };
    return [...out].sort(by);
  }, [safeInsights, sevSel, retSel, q, sort]);

  // Severity'e göre grupla + her grupta (filtrelenmiş) sayaç.
  const groups = useMemo(() => {
    return SEV_ORDER.map((s) => ({
      sev: s,
      items: filtered.filter((i) => i.severity === s),
    })).filter((g) => g.items.length > 0);
  }, [filtered]);

  // Görünen sinyallerin firma bazlı dağılımı — hangi firmada sinyal yoğunlaşıyor?
  // Her firma için severity kırılımı (kritik/uyarı/pozitif/bilgi) + toplam, çoktan aza sıralı.
  const byRetailer = useMemo(() => {
    const m = new Map<string, { total: number; sev: Record<Severity, number> }>();
    for (const i of filtered) {
      let e = m.get(i.retailer);
      if (!e) {
        e = { total: 0, sev: { critical: 0, warning: 0, positive: 0, info: 0 } };
        m.set(i.retailer, e);
      }
      e.total += 1;
      e.sev[i.severity] += 1;
    }
    return [...m.entries()]
      .map(([retailer, v]) => ({ retailer, ...v }))
      .sort((a, b) => b.total - a.total || a.retailer.localeCompare(b.retailer, "tr"));
  }, [filtered]);
  const maxRetTotal = useMemo(
    () => byRetailer.reduce((mx, r) => Math.max(mx, r.total), 0),
    [byRetailer]
  );

  // Aktif filtre kombinasyonu varsayılandan saptı mı (sıfırla butonu için).
  const dirty =
    q.trim() !== "" ||
    sevSel.length !== SEV_ORDER.length ||
    (retailers.length > 0 && retSel.length !== retailers.length);

  function resetFilters() {
    setQ("");
    setSevSel([...SEV_ORDER]);
    setRetSel(retailers);
  }

  // Üst StatCard'a tıklayınca o severity'e hızlı odak (tekse tüme dön, değilse yalnız onu seç).
  function focusSeverity(s: Severity) {
    setSevSel((cur) => (cur.length === 1 && cur[0] === s ? [...SEV_ORDER] : [s]));
  }

  // CSV: yalnızca o an görünen (filtrelenmiş + sıralı) sinyaller.
  const csvRows = useMemo(
    () =>
      filtered.map((i) => ({
        onem: SEV[i.severity].label,
        firma: i.retailer,
        baslik: i.title,
        detay: i.detail,
        metrik: i.metric ?? "",
      })),
    [filtered]
  );

  return (
    <div className="space-y-6">
      <div className="flex items-end justify-between flex-wrap gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">
            Intelligence <span className="neon-text">Akışı</span>
          </h1>
          <p className="text-txt-dim mono text-sm mt-1">
            Otomatik üretilen sinyaller — momentum, anomali, stockout riski, tahmin
          </p>
        </div>
        <CsvBtn
          filename="cortex-insights"
          rows={csvRows}
          cols={[
            { key: "onem", label: "Önem" },
            { key: "firma", label: "Firma" },
            { key: "baslik", label: "Başlık" },
            { key: "detay", label: "Detay" },
            { key: "metrik", label: "Metrik" },
          ]}
        />
      </div>

      {/* Özet sayaçlar — değer = toplam, alt satır = o an görünen sayı; tıkla → o önem
          düzeyine odaklan. Sinyali olmayan düzey pasif (tıklanamaz). */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        {SEV_ORDER.map((s) => {
          const onlyThis = sevSel.length === 1 && sevSel[0] === s;
          const total = counts[s];
          const shown = filtered.reduce((a, i) => a + (i.severity === s ? 1 : 0), 0);
          const empty = total === 0;
          return (
            <button
              key={s}
              type="button"
              onClick={() => focusSeverity(s)}
              disabled={empty}
              aria-pressed={onlyThis}
              className="text-left transition-transform enabled:hover:scale-[1.02] rounded-2xl disabled:opacity-45 disabled:cursor-not-allowed"
              style={{ outline: onlyThis ? `1px solid ${SEV[s].color}` : "none", outlineOffset: 2 }}
              title={
                empty
                  ? `${SEV[s].label.toLowerCase()} sinyal yok`
                  : onlyThis
                  ? "Tüm önem düzeylerine dön"
                  : `Yalnızca ${SEV[s].label.toLowerCase()} sinyalleri`
              }
            >
              <StatCard
                label={`${SEV[s].icon} ${SEV[s].label}`}
                value={total}
                color={SEV[s].color}
                sub={empty ? "sinyal yok" : shown === total ? `${total} sinyal` : `${shown} görünür · ${total} toplam`}
              />
            </button>
          );
        })}
      </div>

      {/* Hata kartı — gerçek arızayı "veri yok" gibi göstermemek için ayrı */}
      {err && (
        <div className="card p-4 border-red-500/40 text-red-400 mono text-sm">
          Veri alınamadı: {err}
        </div>
      )}

      {/* ── Kontrol çubuğu: arama + severity/firma çoklu-filtre + sıralama + görünüm ── */}
      {!loading && !err && safeInsights.length > 0 && (
        <div className="card p-4 space-y-3">
          <div className="flex items-center gap-3 flex-wrap">
            <SearchBox
              value={q}
              onChange={setQ}
              placeholder="Sinyal ara — başlık, detay, firma…"
              className="w-full sm:w-72"
            />
            <div className="flex items-center gap-2 flex-wrap ml-auto">
              <span className="mono text-xs text-txt-dim">Sırala:</span>
              <SegTabs tabs={SORT_TABS} active={sort} onChange={setSort} />
              <button
                type="button"
                onClick={() => setGrouped((g) => !g)}
                className={`mono text-xs px-3 py-2 rounded-lg border transition-colors ${
                  grouped
                    ? "border-neon/60 text-neon bg-neon/10"
                    : "border-line text-txt-dim hover:border-neon hover:text-neon"
                }`}
                title="Sinyalleri önem düzeyine göre gruplandır"
              >
                {grouped ? "▣ Gruplu" : "▤ Düz liste"}
              </button>
            </div>
          </div>

          <MultiChips
            label="Önem:"
            options={SEV_ORDER}
            selected={sevSel}
            onToggle={(s) =>
              setSevSel((cur) => (cur.includes(s) ? cur.filter((x) => x !== s) : [...cur, s]))
            }
            onAll={() => setSevSel([...SEV_ORDER])}
            onNone={() => setSevSel([])}
            colorOf={(s) => SEV[s].color}
          />

          {retailers.length > 0 && (
            <MultiChips
              label="Firma:"
              options={retailers}
              selected={retSel}
              onToggle={(r) =>
                setRetSel((cur) => (cur.includes(r) ? cur.filter((x) => x !== r) : [...cur, r]))
              }
              onAll={() => setRetSel(retailers)}
              onNone={() => setRetSel([])}
              colorOf={(r) => colorOf(r)}
            />
          )}

          <div className="flex items-center justify-between gap-3 flex-wrap pt-1">
            <span className="mono text-xs text-txt-dim">
              {filtered.length} / {safeInsights.length} sinyal
            </span>
            {dirty && (
              <button
                type="button"
                onClick={resetFilters}
                className="mono text-[11px] text-txt-dim hover:text-neon transition-colors"
              >
                ✕ filtreleri sıfırla
              </button>
            )}
          </div>
        </div>
      )}

      {/* Firma sinyal dağılımı — görünen sinyaller hangi firmada yoğunlaşıyor?
          Her bar severity'e göre renk kırılımlı; çubuğa tıkla → o firmaya odaklan. */}
      {!loading && !err && safeInsights.length > 0 && filtered.length > 0 && byRetailer.length > 1 && (
        <div className="card p-5 space-y-3">
          <div className="flex items-center justify-between gap-3 flex-wrap">
            <h2 className="font-bold text-sm">
              Firma <span className="neon-text">dağılımı</span>
            </h2>
            <span className="mono text-xs text-txt-dim">
              {byRetailer.length} firma · {filtered.length} sinyal
            </span>
          </div>
          <div className="space-y-2.5">
            {byRetailer.map((r, idx) => {
              const onlyThis = retSel.length === 1 && retSel[0] === r.retailer;
              return (
                <motion.button
                  key={r.retailer}
                  type="button"
                  onClick={() =>
                    setRetSel((cur) => (cur.length === 1 && cur[0] === r.retailer ? retailers : [r.retailer]))
                  }
                  initial={{ opacity: 0, x: -8 }}
                  animate={{ opacity: 1, x: 0 }}
                  transition={{ delay: Math.min(idx * 0.03, 0.3) }}
                  aria-pressed={onlyThis}
                  className="block w-full text-left group"
                  title={onlyThis ? "Tüm firmalara dön" : `Yalnızca ${r.retailer} sinyalleri`}
                >
                  <div className="flex items-center justify-between text-sm mb-1">
                    <span className="font-medium flex items-center gap-2">
                      <span
                        className="inline-block w-2 h-2 rounded-full shrink-0"
                        style={{ background: colorOf(r.retailer) }}
                      />
                      <span className={onlyThis ? "neon-text" : "group-hover:text-neon transition-colors"}>
                        {r.retailer}
                      </span>
                    </span>
                    <span className="mono text-xs text-txt-dim">{r.total} sinyal</span>
                  </div>
                  <div className="h-2.5 rounded-full bg-ink-3 overflow-hidden flex">
                    {SEV_ORDER.map((s) =>
                      r.sev[s] > 0 ? (
                        <motion.div
                          key={s}
                          className="h-full first:rounded-l-full last:rounded-r-full"
                          style={{ background: SEV[s].color }}
                          initial={{ width: 0 }}
                          animate={{ width: `${(r.sev[s] / maxRetTotal) * 100}%` }}
                          transition={{ delay: Math.min(idx * 0.03, 0.3) + 0.1, duration: 0.5 }}
                          title={`${SEV[s].label}: ${r.sev[s]}`}
                        />
                      ) : null
                    )}
                  </div>
                </motion.button>
              );
            })}
          </div>
        </div>
      )}

      {loading ? (
        <div className="space-y-3">
          {[...Array(5)].map((_, i) => (
            <div key={i} className="card p-5 animate-pulse h-20" />
          ))}
        </div>
      ) : err ? null : safeInsights.length === 0 ? (
        <div className="card p-10 text-center text-txt-dim mono">
          Henüz yeterli veri yok — birkaç hafta yükleyince sinyaller belirir.
        </div>
      ) : filtered.length === 0 ? (
        <div className="card p-10 text-center text-txt-dim mono space-y-2">
          <div>Bu filtrelerle eşleşen sinyal yok.</div>
          {dirty && (
            <button
              type="button"
              onClick={resetFilters}
              className="mono text-xs text-neon hover:underline"
            >
              ✕ filtreleri sıfırla
            </button>
          )}
        </div>
      ) : grouped ? (
        <div className="space-y-6">
          {groups.map((g) => (
            <div key={g.sev} className="space-y-3">
              <div className="flex items-center gap-2">
                <span className="mono text-sm font-bold" style={{ color: SEV[g.sev].color }}>
                  {SEV[g.sev].icon} {SEV[g.sev].label}
                </span>
                <span
                  className="mono text-[10px] px-2 py-0.5 rounded-full"
                  style={{ color: SEV[g.sev].color, border: `1px solid ${SEV[g.sev].color}40` }}
                >
                  {g.items.length}
                </span>
                <div className="flex-1 h-px" style={{ background: `${SEV[g.sev].color}26` }} />
              </div>
              <div className="space-y-3">
                {g.items.map((ins, i) => (
                  <InsightCard key={`${g.sev}-${i}`} ins={ins} i={i} />
                ))}
              </div>
            </div>
          ))}
        </div>
      ) : (
        <div className="space-y-3">
          {filtered.map((ins, i) => (
            <InsightCard key={i} ins={ins} i={i} />
          ))}
        </div>
      )}
    </div>
  );
}

// ── Tek sinyal kartı — orijinal görsel kalıp korunarak ayrıştırıldı ──
function InsightCard({ ins, i }: { ins: Insight; i: number }) {
  const sev = SEV[ins.severity];
  return (
    <motion.div
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: Math.min(i, 12) * 0.04, duration: 0.3 }}
      className="card p-5 flex items-start gap-4"
      style={{ background: sev.bg }}
    >
      <div className="mono text-lg shrink-0" style={{ color: sev.color }}>
        {sev.icon}
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <span
            className="mono text-[10px] px-2 py-0.5 rounded"
            style={{ color: sev.color, background: sev.bg, border: `1px solid ${sev.color}40` }}
          >
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
}
