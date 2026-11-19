"use client";

// ÜRÜN · GEÇEN YIL AYNI HAFTA — seçili ürünün son 5 haftası, geçen yılın aynı
// ISO haftalarıyla. Karşılık: aynı barkod; yoksa (sezonluk ürün yeni barkodla
// geldiyse) aynı firma + aile + takım + bir önceki sezon (/api/gecen-yil).
import { useEffect, useState } from "react";
import { fetchJson } from "@/lib/fetchJson";
import { colorOf, fmtInt } from "@/lib/format";
import { kanalAdi } from "@/lib/kanal";
import { Info } from "@/components/Info";

type Nokta = { adet: number; stok: number } | null;
type Veri = {
  week: string; gyHafta: string;
  haftalar: { bu: string; gy: string }[];
  kanallar: { retailer: string; ad: string; karsilik: { tur: "ayni" | "sezon"; adlar: string[] } | null; seri: { bu: Nokta; gy: Nokta }[] }[];
};

const YESIL = "#1FF80B", KIRMIZI = "#ff5555", NOTR = "#7d927d";
// Satış da stok da 0 = ürün henüz rafta değil (lansman öncesi). "▼ 100%" yazmak
// yanlış okutur: satış düşmedi, ürün yoktu.
const raftaYok = (n: Nokta) => !!n && n.adet === 0 && n.stok === 0;
const hucre = (n: Nokta) => (!n ? "—" : raftaYok(n) ? "rafta yok" : fmtInt(n.adet));
const gunAy = (d: string) => new Date(d + "T00:00:00Z").toLocaleDateString("tr-TR", { day: "2-digit", month: "short", timeZone: "UTC" });

function Delta({ bu, gy }: { bu: number | null | undefined; gy: number | null | undefined }) {
  if (bu == null || gy == null) return <span style={{ color: NOTR }}>—</span>;
  if (gy === 0) return <span style={{ color: bu > 0 ? YESIL : NOTR }}>{bu > 0 ? "yeni" : "—"}</span>;
  const p = (bu / gy - 1) * 100;
  return <span style={{ color: p >= 0 ? YESIL : KIRMIZI }}>{p >= 0 ? "▲" : "▼"} {Math.abs(p).toFixed(0)}%</span>;
}

export function GecenYilUrun({ barkod, week }: { barkod: string; week: string }) {
  const [v, setV] = useState<Veri | null>(null);
  const [hata, setHata] = useState(false);

  useEffect(() => {
    if (!barkod || !week) return;
    let iptal = false;
    setV(null); setHata(false);
    fetchJson<Veri>(`/api/gecen-yil?week=${week}&barkod=${encodeURIComponent(barkod)}`)
      .then((d) => { if (!iptal) setV(d); })
      .catch(() => { if (!iptal) setHata(true); });
    return () => { iptal = true; };
  }, [barkod, week]);

  if (hata) return <div className="card p-4 mono text-xs" style={{ color: "#f8b00b" }}>Geçen yıl kıyası alınamadı.</div>;
  if (!v) return <div className="card card-flat p-4 mono text-xs text-txt-dim">Geçen yıl kıyası hazırlanıyor…</div>;
  const eslesen = v.kanallar.filter((k) => k.karsilik);
  if (!eslesen.length) {
    return (
      <div className="card card-flat p-4 mono text-xs text-txt-dim">
        Geçen yıl aynı hafta · bu ürünün (ya da önceki sezonunun) geçen yıla ait verisi yok.
      </div>
    );
  }

  return (
    <div className="card p-5">
      <h3 className="font-bold mb-3">
        Geçen yıl aynı hafta
        <span className="mono text-xs text-txt-dim font-normal ml-2">son 5 hafta ↔ geçen yılın aynı haftaları</span>
        <Info text={"Geçen yılın aynı ISO haftası (52 hafta önce). Karşılık: aynı barkod; sezonluk ürün yeni barkodla geldiyse aynı firma, aile ve takımın bir önceki sezonu (ör. Pre-Season 26/27 ↔ 25/26). — = o hafta firmanın raporu yok."} />
      </h3>
      <div className="space-y-4">
        {v.kanallar.map((k) => {
          if (!k.karsilik) {
            return (
              <div key={k.retailer} className="mono text-xs text-txt-dim">
                <span style={{ color: colorOf(k.retailer) }}>{kanalAdi(k.retailer)}</span> · geçen yıl karşılığı bulunamadı
              </div>
            );
          }
          // Özet: iki yılda da raporu olan en son hafta.
          const son = [...k.seri].reverse().find((s) => s.bu && s.gy);
          return (
            <div key={k.retailer}>
              <div className="flex items-baseline justify-between flex-wrap gap-2 mb-1">
                <div className="mono text-xs">
                  <span className="font-bold" style={{ color: colorOf(k.retailer) }}>{kanalAdi(k.retailer)}</span>
                  <span className="text-txt-dim">
                    {" · "}{k.karsilik.tur === "ayni" ? "aynı barkod" : "önceki sezon"}: {k.karsilik.adlar.join(" / ")}
                  </span>
                </div>
                {son && (
                  <div className="mono text-xs tabular-nums">
                    son hafta {fmtInt(son.bu!.adet)} <span className="text-txt-dim">· geçen yıl {fmtInt(son.gy!.adet)}</span>{" "}
                    <Delta bu={son.bu!.adet} gy={son.gy!.adet} />
                    <span className="text-txt-dim"> · stok {fmtInt(son.bu!.stok)} ↔ {fmtInt(son.gy!.stok)}</span>
                  </div>
                )}
              </div>
              <div className="overflow-x-auto">
                <table className="w-full mono text-xs tabular-nums">
                  <thead>
                    <tr className="text-[11px] text-txt-dim">
                      <th className="text-left font-normal py-1">SATIŞ</th>
                      {v.haftalar.map((h) => (
                        <th key={h.bu} className="text-right font-normal">{gunAy(h.bu)}<span className="opacity-60"> / {gunAy(h.gy)}</span></th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    <tr><td className="py-0.5">bu yıl</td>{k.seri.map((s, i) => <td key={i} className={`text-right ${raftaYok(s.bu) ? "text-txt-dim" : ""}`}>{hucre(s.bu)}</td>)}</tr>
                    <tr className="text-txt-dim"><td className="py-0.5">geçen yıl</td>{k.seri.map((s, i) => <td key={i} className="text-right">{hucre(s.gy)}</td>)}</tr>
                    <tr><td className="py-0.5 text-txt-dim">Δ</td>{k.seri.map((s, i) => (
                      <td key={i} className="text-right">
                        {raftaYok(s.bu) || raftaYok(s.gy) ? <span style={{ color: NOTR }}>—</span> : <Delta bu={s.bu?.adet} gy={s.gy?.adet} />}
                      </td>
                    ))}</tr>
                  </tbody>
                </table>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
