"use client";

import { useEffect, useMemo, useState, type ReactNode } from "react";
import { motion } from "framer-motion";
import { WeeklySummary, Freshness, RETAILERS, RETAILER_COLORS, colorOf, fmtInt, fmtMoney, fmtDate, fmtDateTime, fmtPct } from "@/lib/format";
import { RetailerCard } from "@/components/RetailerCard";
import { TrendChart } from "@/components/TrendChart";
import { KpiHero } from "@/components/KpiHero";
import { Heatmap } from "@/components/Heatmap";
import { MultiChips, SegTabs } from "@/components/Controls";
import { HealthBanner } from "@/components/HealthBanner";
import { ActionPanel } from "@/components/ActionPanel";
import { CashCalendar } from "@/components/CashCalendar";
import { MailButton } from "@/components/MailButton";
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
        // Açılış haftası = son TAM hafta (5 firmanın da veri gönderdiği en yeni
        // hafta). En güncel hafta çoğu gün kısmidir (2-3 firma) ve dashboard'ı
        // yanıltıcı toplamlar + anlamsız deltalarla açıyordu. Kısmi haftalar
        // dropdown'dan hâlâ seçilebilir — o zaman KISMİ rozeti uyarır.
        const weeks = [...new Set(sum.map((s) => s.week_start))].sort();
        const firmCount = (w: string) => new Set(sum.filter((s) => s.week_start === w).map((s) => s.retailer)).size;
        const full = [...weeks].reverse().find((w) => firmCount(w) >= RETAILERS.length);
        if (weeks.length) setWeek((full ?? weeks[weeks.length - 1]) as string);
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

  // (Eski "Ağ KPI" delta şeridi kaldırıldı — aynı sayıları KPI kartlarının
  // altında ikinci kez basıyordu ve kohort gözetmeden karışık-firma kıyası
  // yapıyordu. Deltalar artık KpiHero içinde, aynı-firma kohortuyla.)

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
          <MailButton week={week} />
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

      <SectionTitle label="DURUM" />

      <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.05 }}>
        <KpiHero summary={summary} week={week} visible={visible} />
      </motion.div>

      {/* İSTEMCİ TARAFI: Ağ payı — seçili haftada her görünür perakendecinin net ciro payı (yatay bar). */}
      <NetworkShare rows={shareRows} week={week} />

      {/* Yıldız/Dikkat — tek ince satır (iki koca kart yer israfıydı). Sunucu tarafı
          anlamlılık kapısından geçer: ciro tabanı + ≥2 karşılaştırılabilir firma;
          aynı firma iki rolde olamaz (kısmi haftalarda ikisi de Huppaluppo çıkıyordu). */}
      {overview?.best && overview?.worst && overview.best.retailer !== overview.worst.retailer && (
        <div className="card px-4 py-3 flex items-center gap-4 flex-wrap mono text-sm">
          <span className="text-[10px] text-txt-dim tracking-wider">HAFTANIN YILDIZI / DİKKAT</span>
          <span>
            ▲ <span className="font-bold" style={{ color: RETAILER_COLORS[overview.best.retailer] }}>{overview.best.retailer}</span>{" "}
            <span className="text-neon">{fmtPct(overview.best.wow)}</span>
          </span>
          <span>
            ▼ <span className="font-bold" style={{ color: RETAILER_COLORS[overview.worst.retailer] }}>{overview.worst.retailer}</span>{" "}
            <span className="text-red-400">{fmtPct(overview.worst.wow)}</span>
          </span>
          <span className="text-[10px] text-txt-dim">ciro WoW · kendi geçen haftasına göre</span>
        </div>
      )}

      <SectionTitle label="KARAR MERKEZİ" />

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

      {/* Aksiyon Zekâsı — /api/routing üstünden haftalık yapılacaklar (SEVK + ÇEK). */}
      <ActionPanel />

      {/* Nakit Takvimi — satış verisi + kanal vadesinden tahsilat projeksiyonu.
          (Sat-Öde sayfası kaldırıldı; bu bileşen faturaya değil weekly_summary'ye
          dayandığı için satış-stok kapsamında kaldı ve dashboard'a taşındı.) */}
      <CashCalendar />

      <SectionTitle label="DETAY" />

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

      {/* Tazelik en altta ve katlı — "kim geride" bilgisini Veri Sağlığı zaten
          özetliyor; buradaki ayrıntı (hafta sayısı/son import) isteyene açılır. */}
      <Collapse title="Veri Tazeliği · firma bazında ayrıntı">
        <FreshnessStrip freshness={freshness} latestWeek={latestWeek} sort={freshSort} onSort={setFreshSort} />
      </Collapse>
    </div>
  );
}

// İnce bölüm ayracı — dashboard'ı DURUM → KARAR MERKEZİ → DETAY bölgelerine
// ayırır; göz akışına hiyerarşi verir, kutu kalabalığını böler.
function SectionTitle({ label }: { label: string }) {
  return (
    <div className="flex items-center gap-3 pt-2 select-none">
      <span className="mono text-[10px] tracking-[0.3em] text-txt-dim/70">{label}</span>
      <span className="flex-1 h-px bg-line/60" />
    </div>
  );
}

// Katlanabilir bölüm — ağır/ikincil blokları varsayılan kapalı tutar.
function Collapse({ title, children }: { title: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="card overflow-hidden">
      <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open}
        className="w-full flex items-center justify-between gap-3 px-4 py-3 text-left hover:bg-neon/5 transition-colors">
        <span className="mono text-xs tracking-wider text-txt-dim">{title}</span>
        <span className="mono text-xs text-txt-dim shrink-0">{open ? "▾ gizle" : "▸ aç"}</span>
      </button>
      {open && <div className="border-t border-line/60 p-4">{children}</div>}
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
    <div>
      <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
        <div className="mono text-xs text-txt-dim uppercase tracking-wider">
          son hafta / hafta sayısı / son import
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
