"use client";

// Aylık Özet — dashboard'ın zaten çektiği haftalık veriden istemcide türetilir
// (yeni API/fetch YOK). Üç kural:
//  1) HAFTA→AY: hafta, günlerinin çoğunun düştüğü aya yazılır (ISO Perşembe
//     kuralı: hafta başı + 3 gün). Böylece ay toplamları haftalık rakamlarla
//     birebir mutabık kalır — kesirli hafta/çift sayım olmaz.
//  2) STOK TOPLANMAZ: anlık değerdir → ay sonu stoğu, her firmanın o ay içindeki
//     SON haftasının stoğu toplanarak bulunur.
//  3) TAMLIK: beklenen firma-hafta ile gelen kayıt kıyaslanır; eksikse ay "kısmi"
//     işaretlenir — eksik veriyi düşüş sanmayı önler. Beklenen sayılırken firma
//     ancak KENDİ İLK HAFTASINDAN sonra beklenir (Armağan Mayıs'ta, Huppaluppo
//     sonradan katıldı; yoksa eski aylar haksız yere "kısmi" görünürdü).
import { useMemo } from "react";
import { WeeklySummary, colorOf, fmtInt, fmtMoney } from "@/lib/format";
import { Info } from "./Info";

const AY = ["", "Ocak", "Şubat", "Mart", "Nisan", "Mayıs", "Haziran",
  "Temmuz", "Ağustos", "Eylül", "Ekim", "Kasım", "Aralık"];

// Haftanın ait olduğu ay = hafta başı + 3 gün (Perşembe) — günlerin çoğunluğu.
function monthOf(weekStart: string): string {
  const d = new Date(weekStart + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + 3);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

interface Row {
  key: string;
  label: string;
  net: number;
  qty: number;
  stock: number;
  weeks: number;
  have: number;
  expect: number;
  byRetailer: Record<string, number>;
}

export function MonthlySummary({
  summary, visible, months = 6,
}: {
  summary: WeeklySummary[];
  visible: string[];
  months?: number;
}) {
  const rows = useMemo<Row[]>(() => {
    const vis = new Set(visible);
    const src = summary.filter((s) => vis.has(s.retailer));
    if (!src.length) return [];

    // Firmanın ağa katıldığı ilk hafta — o tarihten ÖNCEKİ aylarda beklenmez.
    const firstWeek = new Map<string, string>();
    for (const s of src) {
      const f = firstWeek.get(s.retailer);
      if (!f || s.week_start < f) firstWeek.set(s.retailer, s.week_start);
    }

    // ay → { hafta seti, firma-hafta kayıtları }
    const acc = new Map<string, { weeks: Set<string>; recs: WeeklySummary[] }>();
    for (const s of src) {
      const k = monthOf(s.week_start);
      const e = acc.get(k) ?? { weeks: new Set<string>(), recs: [] };
      e.weeks.add(s.week_start);
      e.recs.push(s);
      acc.set(k, e);
    }

    const out: Row[] = [];
    for (const [key, e] of acc) {
      let net = 0, qty = 0;
      const byRetailer: Record<string, number> = {};
      // firma başına o ayın SON haftası (stok anlık değer olduğu için)
      const lastWeekOf = new Map<string, WeeklySummary>();
      for (const s of e.recs) {
        // /api/dashboard değerleri ZATEN net (marj+KDV düşülmüş) döner — burada
        // ikinci kez netFactor uygulanmaz, yoksa ciro iki kez kırpılır.
        const n = Number(s.sales_value ?? 0);
        net += n; qty += Number(s.sales_qty);
        byRetailer[s.retailer] = (byRetailer[s.retailer] ?? 0) + n;
        const prev = lastWeekOf.get(s.retailer);
        if (!prev || s.week_start > prev.week_start) lastWeekOf.set(s.retailer, s);
      }
      const stock = [...lastWeekOf.values()].reduce((a, s) => a + Number(s.stock_qty), 0);
      const [y, m] = key.split("-").map(Number);
      // Beklenen firma-hafta: her hafta için, o hafta itibarıyla ağda olan firmalar.
      let expect = 0;
      for (const w of e.weeks) {
        for (const [ret, fw] of firstWeek) if (vis.has(ret) && fw <= w) expect++;
      }
      out.push({
        key, label: `${AY[m]} ${y}`, net, qty, stock,
        weeks: e.weeks.size, have: e.recs.length, expect, byRetailer,
      });
    }
    out.sort((a, b) => (a.key < b.key ? 1 : -1)); // yeni → eski
    return out.slice(0, months);
  }, [summary, visible, months]);

  if (rows.length === 0) return null;
  const maxNet = Math.max(...rows.map((r) => r.net), 1);

  return (
    <div className="card p-5">
      <div className="flex items-center justify-between flex-wrap gap-2 mb-4">
        <h2 className="font-bold">
          Aylık Özet
          <span className="mono text-xs text-txt-dim font-normal ml-2">net kazanç · son {rows.length} ay</span>
          <Info text={"Hafta, günlerinin çoğunun düştüğü aya yazılır (ör. 29 Haz-5 Tem → Temmuz), böylece ay toplamları haftalık rakamlarla birebir tutar. Stok toplanmaz: ay sonu = her firmanın o aydaki son haftası. Bir ayda tüm firma-hafta verisi gelmemişse ay 'kısmi' işaretlenir — eksik veri düşüş gibi okunmasın."} />
        </h2>
        <span className="mono text-[11px] text-txt-dim">Δ = önceki aya göre</span>
      </div>

      <div className="space-y-2.5">
        {rows.map((r, i) => {
          const prev = rows[i + 1]; // liste yeni→eski
          const d = prev && prev.net > 0 ? ((r.net - prev.net) / prev.net) * 100 : null;
          const partial = r.have < r.expect;
          const up = d != null && d >= 0;
          return (
            <div key={r.key} className="grid grid-cols-[104px_1fr_auto] items-center gap-3">
              <div className="min-w-0">
                <div className="mono text-xs truncate">{r.label}</div>
                <div className="mono text-[10px] text-txt-dim">
                  {r.weeks} hafta
                  {partial && (
                    <span title={`${r.have}/${r.expect} firma-hafta verisi geldi`} style={{ color: "#f8b00b" }}>
                      {" "}· kısmi
                    </span>
                  )}
                </div>
              </div>

              {/* kanal renkli yığılı bar — en büyük aya göre ölçekli */}
              <div className="h-5 rounded bg-ink-3 overflow-hidden flex" title={`${fmtMoney(r.net)} · ${fmtInt(r.qty)} adet`}>
                {Object.entries(r.byRetailer)
                  .sort((a, b) => b[1] - a[1])
                  .map(([ret, v]) => (
                    <div key={ret} title={`${ret}: ${fmtMoney(v)}`}
                      className="h-full first:rounded-l last:rounded-r"
                      style={{ width: `${(v / maxNet) * 100}%`, background: colorOf(ret), opacity: 0.85 }} />
                  ))}
              </div>

              <div className="text-right">
                <div className="mono text-sm tabular-nums">{fmtMoney(r.net)}</div>
                <div className="mono text-[10px] text-txt-dim tabular-nums">
                  {fmtInt(r.qty)} ad
                  {d != null && (
                    <span style={{ color: up ? "#1FF80B" : "#ff5555" }}>
                      {" "}{up ? "▲" : "▼"} {up ? "+" : ""}{d.toFixed(0)}%
                    </span>
                  )}
                </div>
              </div>
            </div>
          );
        })}
      </div>

      <p className="mono text-[10px] text-txt-dim mt-3">
        Hafta, günlerinin çoğunun düştüğü aya yazılır; stok ay sonu anlık değeridir.
      </p>
    </div>
  );
}
