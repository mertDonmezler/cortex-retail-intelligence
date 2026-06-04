"use client";

import { useEffect, useState } from "react";
import { motion } from "framer-motion";
import { fmtInt, fmtMoney, fmtPct, fmtDate, RETAILER_COLORS } from "@/lib/format";
import { AnimatedNumber } from "@/components/AnimatedNumber";
import { fetchJson } from "@/lib/fetchJson";

const COLORS = RETAILER_COLORS;
const STATUS = {
  up: { icon: "▲", color: "#1FF80B" }, down: { icon: "▼", color: "#ff5555" },
  flat: { icon: "■", color: "#7d927d" }, nodata: { icon: "·", color: "#7d927d" },
};

export default function OverviewPage() {
  const [data, setData] = useState<any>(null);
  const [weeks, setWeeks] = useState<string[]>([]);
  const [week, setWeek] = useState<string>(""); // "" = en güncel hafta
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    setLoading(true);
    fetchJson(week ? `/api/overview?week=${encodeURIComponent(week)}` : "/api/overview")
      .then((d) => { setData(d); setWeeks(d?.weeks ?? []); setErr(null); })
      .catch((e) => { setErr(e.message); setData(null); /* render çökmesin diye güvenli boş default */ })
      .finally(() => setLoading(false));
  }, [week]);

  if (loading && !data) return <div className="card p-10 text-center mono text-txt-dim animate-pulse">Yükleniyor…</div>;
  if (err) return <div className="card p-4 border-red-500/40 text-red-400 mono text-sm">Veri alınamadı: {err}</div>;
  if (!data || !data.latest_week) return (
    <div className="card p-10 text-center"><div className="font-semibold">Henüz veri yok</div>
      <a href="/upload" className="neon-text mono text-sm mt-2 inline-block">Veri yükle →</a></div>
  );

  // Kısmi/başarısız yanıt render'ı çökertmesin diye güvenli boş default'lar
  const n = data?.network ?? {};
  const retailers: any[] = data?.retailers ?? [];

  return (
    <div className="space-y-6">
      <div className="flex items-end justify-between flex-wrap gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Yönetici <span className="neon-text">Özeti</span></h1>
          <p className="text-txt-dim mono text-sm mt-1">Tüm ağ bir bakışta · hafta {fmtDate(data.latest_week)} · ciro = net kazanç (çalışma marjı + KDV düşülmüş)</p>
        </div>
        <div className="flex items-center gap-2">
          <select
            value={week || data.latest_week || ""}
            onChange={(e) => setWeek(e.target.value)}
            className="card mono text-sm px-4 py-2 bg-ink-2 outline-none focus:border-neon"
          >
            {weeks.map((w) => (
              <option key={w} value={w} className="bg-ink-2">{fmtDate(w)}</option>
            ))}
          </select>
          <a
            href={`/api/export?week=${encodeURIComponent(week || data.latest_week || "")}`}
            className="mono text-xs px-4 py-2 rounded-lg bg-neon text-ink font-bold hover:bg-neon-dim transition-colors"
          >
            ⬇ Excel rapor indir
          </a>
        </div>
      </div>

      {/* Ağ KPI'ları */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <BigKpi label="AĞ SATIŞI" value={n?.sales_qty ?? 0} suffix="adet" wow={n?.wow_qty} glow />
        <BigKpi label="AĞ CİROSU" value={n?.sales_value ?? 0} money wow={n?.wow_value} />
        <BigKpi label="TOPLAM STOK" value={n?.stock_qty ?? 0} suffix="adet" />
        <BigKpi label="AKTİF SKU" value={n?.sku_count ?? 0} suffix="ürün" />
      </div>

      {/* Best / Worst */}
      {(data.best || data.worst) && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {data.best && (
            <div className="card p-5 border-l-4" style={{ borderLeftColor: "#1FF80B" }}>
              <div className="mono text-xs text-txt-dim">HAFTANIN YILDIZI ▲</div>
              <div className="text-xl font-bold mt-1" style={{ color: COLORS[data.best.retailer] }}>{data.best.retailer}</div>
              <div className="mono text-sm text-neon">{fmtPct(data.best.wow)} haftalık büyüme</div>
            </div>
          )}
          {data.worst && (
            <div className="card p-5 border-l-4" style={{ borderLeftColor: "#ff5555" }}>
              <div className="mono text-xs text-txt-dim">DİKKAT GEREKEN ▼</div>
              <div className="text-xl font-bold mt-1" style={{ color: COLORS[data.worst.retailer] }}>{data.worst.retailer}</div>
              <div className="mono text-sm text-red-400">{fmtPct(data.worst.wow)} haftalık değişim</div>
            </div>
          )}
        </div>
      )}

      {/* Perakendeci tablosu + pay barları */}
      <div className="card p-6">
        <h2 className="font-bold mb-4">Perakendeci Performansı & Pazar Payı</h2>
        {retailers.length === 0 ? (
          <div className="mono text-sm text-txt-dim">Perakendeci verisi bulunamadı.</div>
        ) : (
        <div className="space-y-3">
          {retailers.map((r: any, i: number) => {
            const share = Number(r?.share ?? 0);
            // Büyüme rengi: veri yoksa soluk, artı yeşil, eksi kırmızı
            const wowCls = (w: number | null) => (w == null ? "text-txt-dim" : w >= 0 ? "text-neon" : "text-red-400");
            if (!r?.has_data) {
              return (
                <div key={r?.retailer ?? i} className="flex items-center gap-4 opacity-60">
                  <div className="w-20 shrink-0 font-semibold" style={{ color: COLORS[r?.retailer] }}>{r?.retailer ?? "—"}</div>
                  <div className="flex-1 mono text-sm text-txt-dim">— bu hafta veri yok —</div>
                </div>
              );
            }
            return (
              <motion.div key={r?.retailer ?? i} initial={{ opacity: 0, x: -8 }} animate={{ opacity: 1, x: 0 }}
                transition={{ delay: i * 0.05 }} className="flex items-center gap-3">
                <div className="w-20 shrink-0 font-semibold" style={{ color: COLORS[r?.retailer] }}>{r?.retailer ?? "—"}</div>
                <div className="flex-1 min-w-0">
                  <div className="h-7 rounded-lg bg-ink-3 overflow-hidden relative">
                    <motion.div className="h-full rounded-lg flex items-center px-3"
                      style={{ background: `${COLORS[r?.retailer] ?? "#7d927d"}30` }}
                      initial={{ width: 0 }} animate={{ width: `${share}%` }} transition={{ delay: i * 0.05 + 0.1, duration: 0.6 }}>
                      <span className="mono text-xs whitespace-nowrap">{fmtInt(r?.sales_qty ?? 0)} adet · %{share.toFixed(1)}</span>
                    </motion.div>
                  </div>
                </div>
                <div className="w-28 shrink-0 text-right">
                  <div className="mono text-sm font-bold neon-text">{fmtMoney(r?.sales_value)}</div>
                  <div className="mono text-[10px] text-txt-dim">TL gelir</div>
                </div>
                <div className="w-24 shrink-0 text-right mono text-xs leading-tight">
                  <div className={wowCls(r?.wow)}>adet {fmtPct(r?.wow)}</div>
                  <div className={wowCls(r?.value_wow)}>TL {fmtPct(r?.value_wow)}</div>
                </div>
              </motion.div>
            );
          })}
        </div>
        )}
      </div>

      <div className="flex gap-3 flex-wrap">
        <a href="/insights" className="card px-5 py-3 hover:border-neon transition-colors mono text-sm">→ Intelligence sinyalleri</a>
        <a href="/rankings" className="card px-5 py-3 hover:border-neon transition-colors mono text-sm">→ Global sıralamalar</a>
        <a href="/compare" className="card px-5 py-3 hover:border-neon transition-colors mono text-sm">→ Dönem karşılaştırma</a>
        <a href="/stores" className="card px-5 py-3 hover:border-neon transition-colors mono text-sm">→ Mağaza zekası</a>
      </div>
    </div>
  );
}

function BigKpi({ label, value, suffix, money, wow, glow }: {
  label: string; value: number; suffix?: string; money?: boolean; wow?: number | null; glow?: boolean;
}) {
  return (
    <div className={`card p-5 ${glow ? "neon-glow" : ""}`}>
      <div className="mono text-[10px] text-txt-dim tracking-wider">{label}</div>
      <div className="text-3xl font-bold mono mt-1 neon-text">
        <AnimatedNumber value={value} format={money ? (x) => fmtMoney(x) : undefined} />
      </div>
      <div className="flex items-center justify-between mt-1">
        {suffix && <span className="mono text-[10px] text-txt-dim">{suffix}</span>}
        {wow != null && <span className={`mono text-xs ${wow >= 0 ? "text-neon" : "text-red-400"}`}>{fmtPct(wow)} WoW</span>}
      </div>
    </div>
  );
}
