"use client";

// ── KANAL DETAY PANELİ — kanal tablosunda satıra tıklayınca açılır ──
//
// Üç soruyu tek ekranda cevaplar:
//   1) Bu ürün zaman içinde ne yaptı?   → haftalık satış + stok grafiği
//   2) Motor ne diyor ve NEDEN?          → karar rozeti + tam gerekçe
//   3) Diğer firmalarda durumu ne?       → firma karşılaştırma tablosu
//
// VERİ KAYNAĞI BÖLÜNMÜŞ, ÇÜNKÜ İKİSİ ZATEN ELDE: ürünün kendi serisi ve motor
// kararı tabloyu besleyen yanıtlardan geliyor (prop olarak); yalnız "diğer
// firmalar" için ağ isteği atılıyor ve o da panel AÇILDIĞINDA. Böylece 233
// satırlık tabloda gezinirken boşuna istek yapılmıyor.
import { useEffect, useMemo, useState } from "react";
import {
  ComposedChart, Bar, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
} from "recharts";
import { fetchJson } from "@/lib/fetchJson";
import { fmtInt, fmtMoney, fmtDate, fmtHafta, colorOf } from "@/lib/format";
import { kanalAdi } from "@/lib/kanal";
import { bekleme } from "@/lib/hareket";

export type DetaySku = {
  sku_name: string; barkod: string | null; psf: number | null;
  psfKaynak: "rapor" | "ciro" | "fiyat-listesi" | null;
  seri: Record<string, { qty: number; value: number | null; stock: number }>;
  qty: number; prevQty: number; stock: number; hiz: number; kapsam: number | null;
  brut: number | null; net: number | null; degisim: number | null;
  ilkHafta: string; satanHafta: number; kapali?: true;
};
type Rota = { action: string; qty?: number; reason?: string; dest?: { retailer: string } | null };
type Disarida = {
  retailer: string; dataWeek: string; gecikmeHf: number;
  // Firmanın KENDİ son raporunun yaşı — ürününkinden farklı olabilir.
  firmaGecikmeHf?: number; firmaDataWeek?: string | null;
  qty: number; stock: number;
};
type FirmaSatir = {
  retailer: string; kendisi: boolean; gecikmeHf: number; bayat: boolean; sku_name: string; dataWeek: string;
  qty: number; prevQty: number; stock: number; hiz: number; kapsam: number | null;
  brut: number | null; net: number | null; seri: { w: string; qty: number; stock: number }[];
};
type Detay = {
  barkod: string | null; barkodKaynak: "kendi" | "alias" | null;
  // Tablodaki "güncel" kelimesinin çapası. Uç zaten hesaplayıp gönderiyor;
  // panelin kendi başına takvim haftası bilgisi yok (kanal sayfasındaki
  // "takvim 07 Eyl 2026" rozeti buraya girmiyor).
  takvimHaftasi?: string | null;
  firmalar: FirmaSatir[]; disarida?: Disarida[]; not: string | null;
};

const KARAR_RENK: Record<string, string> = {
  LIKIDASYON: "#ff5555", DEPO: "#f8b00b", TRANSFER: "#5ab0ff", ASKIDA: "#b088ff",
  ERIT: "#ff9f43", SEVK: "#1FF80B", İZLE: "#7d927d",
};
const KARAR_AD: Record<string, string> = { LIKIDASYON: "LİKİDASYON", İZLE: "İZLE" };
const fmt1 = (n: number | null | undefined) =>
  n == null ? "—" : n.toLocaleString("tr-TR", { minimumFractionDigits: 1, maximumFractionDigits: 1 });

export function KanalDetay({
  retailer, sku, haftalar, rota, netCarpan, onClose, rotaBekliyor,
}: {
  retailer: string; sku: DetaySku | null; haftalar: string[];
  rota: Rota | undefined; netCarpan: number; onClose: () => void;
  // Karar motoru henüz yanıt vermedi: "aksiyon üretmedi" cümlesi kesin bir
  // hüküm gibi durmasın, soluk basılsın.
  rotaBekliyor?: boolean;
}) {
  const [d, setD] = useState<Detay | null>(null);
  const [err, setErr] = useState<string | null>(null);

  // ESC ile kapanır — panel klavyeyle de yönetilebilsin.
  useEffect(() => {
    const f = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", f);
    return () => window.removeEventListener("keydown", f);
  }, [onClose]);

  // İSTEK YARIŞI KAPALI. Uç 3-4 Supabase sorgusu yapıyor; tabloda hızlı satır
  // değiştirildiğinde önceki ürünün yanıtı sonra dönüp YENİ ürünün paneline
  // yazılabiliyordu (ekranda A ürünü, tabloda B ürününün firmaları).
  useEffect(() => {
    if (!sku) return;
    let iptal = false;
    setD(null); setErr(null);
    fetchJson<Detay>(`/api/kanal-detay?retailer=${encodeURIComponent(retailer)}&sku=${encodeURIComponent(sku.sku_name)}`)
      .then((x) => { if (!iptal) setD(x); })
      .catch((e) => { if (!iptal) setErr(String(e?.message ?? e)); });
    return () => { iptal = true; };
  }, [retailer, sku?.sku_name]);

  // Grafik verisi: TÜM haftalar. Ürünün katalogda olmadığı hafta ATLANMAZ ama
  // değer yazılmaz (null) → çizgide boşluk kalır, 0 ile karıştırılmaz.
  const grafik = useMemo(() => {
    if (!sku) return [];
    return haftalar.map((w) => {
      const k = sku.seri[w];
      return { hafta: fmtDate(w), satis: k ? k.qty : null, stok: k ? k.stock : null };
    });
  }, [sku, haftalar]);

  if (!sku) return null;
  const up = sku.degisim != null && sku.degisim >= 0;

  return (
    <>
      {/* Arka plan — tıklayınca kapanır. Panel tablodaki satıra bağlı, sağ
          kenardan gelen bir katman: açılışta 180 ms kayar; açıkken başka satıra
          geçmek bileşeni yeniden mount etmediği için yeniden oynamaz. Kapanış
          anlıktır (exit animasyonu yok). */}
      <div className="fixed inset-0 bg-black/60 z-40 cx-ortu" onClick={onClose} aria-hidden />
      <aside className="fixed right-0 top-0 h-full w-full md:w-[620px] z-50 bg-ink-2 border-l border-line overflow-y-auto cx-panel"
        role="dialog" aria-label="Ürün detayı">
        <div className="p-4 space-y-4">
          {/* ── Başlık ── */}
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="mono text-[10px] tracking-wider" style={{ color: colorOf(retailer) }}>
                {kanalAdi(retailer)}
                {sku.kapali && <span className="ml-2" style={{ color: "#ff5555" }}>KAPALI · tasfiye edildi</span>}
              </div>
              <h2 className="font-bold text-base leading-snug mt-0.5">{sku.sku_name}</h2>
              <div className="mono text-[11px] text-txt-dim mt-1">
                {sku.barkod ? `barkod ${sku.barkod}` : "barkod yok"}
                {sku.psf != null && ` · PSF ${fmtInt(Math.round(sku.psf))} ₺`}
                {sku.psf != null && sku.psfKaynak !== "rapor" && (
                  <span style={{ color: "#f8b00b" }}> ~{sku.psfKaynak === "ciro" ? "cirodan" : "fiyat listesinden"}</span>
                )}
              </div>
            </div>
            <button type="button" onClick={onClose}
              className="mono text-xs px-3 py-1.5 rounded-lg border border-line text-txt-dim hover:border-neon hover:text-neon shrink-0">
              ✕ kapat
            </button>
          </div>

          {/* ── Hızlı sayılar ── */}
          <div className="grid grid-cols-3 gap-2">
            {[
              { l: "BU HAFTA", v: fmtInt(sku.qty), s: `geçen ${fmtInt(sku.prevQty)}` },
              { l: "DEĞİŞİM", v: sku.degisim == null ? "—" : `${up ? "+" : ""}${Math.round(sku.degisim)}%`, s: "adet", c: sku.degisim == null ? undefined : up ? "#1FF80B" : "#ff5555" },
              { l: "HIZ", v: fmt1(sku.hiz), s: "adet/hafta" },
              { l: "STOK", v: fmtInt(sku.stock), s: sku.kapsam == null ? "kapsam yok" : `${fmt1(sku.kapsam)} hafta yeter` },
              { l: "BRÜT PSF", v: sku.brut == null ? "—" : fmtMoney(sku.brut), s: "bu hafta" },
              { l: "NET", v: sku.net == null ? "—" : fmtMoney(sku.net), s: `×${netCarpan}`, c: "#1FF80B" },
            ].map((k) => (
              <div key={k.l} className="card card-flat p-2.5">
                <div className="mono text-[9px] text-txt-dim tracking-wider">{k.l}</div>
                <div className="mono text-sm tabular-nums mt-0.5" style={k.c ? { color: k.c } : undefined}>{k.v}</div>
                <div className="mono text-[9px] text-txt-dim truncate">{k.s}</div>
              </div>
            ))}
          </div>

          {/* ── Haftalık grafik ── */}
          <div className="card card-flat p-3">
            <div className="mono text-[11px] text-txt-dim tracking-wider mb-2">
              HAFTALIK SATIŞ VE STOK · {haftalar.length} hafta
              <span className="ml-2 normal-case">
                ilk görüldüğü hafta {fmtDate(sku.ilkHafta)} · {sku.satanHafta} hafta satış yaptı
              </span>
            </div>
            <ResponsiveContainer width="100%" height={200}>
              <ComposedChart data={grafik} margin={{ top: 4, right: 4, bottom: 0, left: 0 }}>
                <CartesianGrid stroke="#1f2a1f" strokeDasharray="3 3" />
                <XAxis dataKey="hafta" stroke="#7d927d" fontSize={10} interval="preserveStartEnd" minTickGap={34} tickMargin={4} />
                <YAxis yAxisId="l" stroke="#7d927d" fontSize={10} width={40} />
                <YAxis yAxisId="r" orientation="right" stroke="#3d5a3d" fontSize={10} width={44}
                  tickFormatter={(v) => (v >= 1000 ? `${Math.round(v / 1000)}k` : `${v}`)} />
                <Tooltip isAnimationActive={false}
                  contentStyle={{ background: "#0f150f", border: "1px solid #1f2a1f", borderRadius: 10, fontSize: 12 }}
                  labelStyle={{ color: "#d8e8d8" }}
                  formatter={(v: any, n: any) => [v == null ? "veri yok" : fmtInt(Number(v)), n === "satis" ? "satış" : "stok"]} />
                {/* Animasyon KAPALI — TrendChart'ta ölçülen sorun: recharts noktaları
                    ve çubukları animasyon bitene kadar basmıyor; bu bir okuma yüzeyi. */}
                <Bar yAxisId="l" dataKey="satis" fill={colorOf(retailer)} isAnimationActive={false} />
                <Line yAxisId="r" type="monotone" dataKey="stok" stroke="#f8b00b" strokeWidth={1.5}
                  dot={false} connectNulls={false} isAnimationActive={false} />
              </ComposedChart>
            </ResponsiveContainer>
            <div className="mono text-[10px] text-txt-dim mt-1">
              çubuk = haftalık satış (sol eksen) · sarı çizgi = hafta sonu stok (sağ eksen) · boşluk = o hafta katalogda yok
            </div>
          </div>

          {/* ── Motorun kararı ── */}
          <div className="card card-flat p-3">
            <div className="mono text-[11px] text-txt-dim tracking-wider mb-2">MOTORUN KARARI</div>
            {rota ? (
              <>
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="mono text-xs px-2 py-1 rounded"
                    style={{ color: KARAR_RENK[rota.action] ?? "#7d927d", border: `1px solid ${KARAR_RENK[rota.action] ?? "#7d927d"}40` }}>
                    {KARAR_AD[rota.action] ?? rota.action}
                  </span>
                  {rota.qty != null && rota.qty > 0 && (
                    <span className="mono text-xs">{fmtInt(rota.qty)} adet</span>
                  )}
                  {rota.dest && (
                    <span className="mono text-xs" style={{ color: colorOf(rota.dest.retailer) }}>
                      → {kanalAdi(rota.dest.retailer)}
                    </span>
                  )}
                </div>
                {rota.reason && <p className="mono text-xs text-txt-dim mt-2 leading-relaxed">{rota.reason}</p>}
              </>
            ) : (
              <p className="mono text-xs text-txt-dim cx-soluk" {...bekleme(!!rotaBekliyor)}>
                Bu kalem için motor bir aksiyon üretmedi — hedef kapsam içinde ya da karar verecek veri yok.
              </p>
            )}
          </div>

          {/* ── Diğer firmalar ── */}
          <div className="card card-flat p-3">
            <div className="mono text-[11px] text-txt-dim tracking-wider mb-2">DİĞER FİRMALARDA</div>
            {err && <p className="mono text-xs text-red-400">Alınamadı: {err}</p>}
            {!d && !err && <p className="mono text-xs text-txt-dim">Aranıyor…</p>}
            {d?.not && <p className="mono text-xs" style={{ color: "#f8b00b" }}>{d.not}</p>}
            {d && !d.not && (
              <>
                <div className="mono text-[10px] text-txt-dim mb-2">
                  barkod {d.barkod}
                  {d.barkodKaynak === "alias" && " · eşleşme /eslesme sayfasında onaylanmış"}
                </div>
                {/* "YALNIZ BURADA" ancak GERÇEKTEN başka firma yoksa yazılır.
                    Eski koşul `disarida`yı görmüyordu: ürün Toyzz ve Nezih'te
                    varsa panel önce "yalnız Toyzz'da listeleniyor" diyor, iki
                    satır altında "Nezih 5 hafta geride" notunu basıyordu. */}
                {d.firmalar.length <= 1 && !d.disarida?.length ? (
                  <p className="mono text-xs text-txt-dim">Bu ürün yalnız {kanalAdi(retailer)}'da listeleniyor.</p>
                ) : d.firmalar.length <= 1 ? (
                  <p className="mono text-xs text-txt-dim">
                    Bu ürünü listeleyen diğer firmaların verisi güncel değil — aşağıya bak.
                  </p>
                ) : (
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead>
                        <tr>
                          <th>Firma</th>
                          <th className="text-right">Bu hf</th>
                          <th className="text-right">Hız</th>
                          <th className="text-right">Stok</th>
                          <th className="text-right">Kapsam</th>
                          {/* Başlıkta ÇAPA. Hücrelerde "güncel" yazabilmek için
                              o kelimenin hangi tarih olduğunun panelde bir kez
                              söylenmesi şart — yoksa üstteki grafiğin ekseniyle
                              tablo arasındaki bağ kopar. */}
                          <th className="text-right whitespace-nowrap">
                            Veri
                            {d.takvimHaftasi && (
                              <span className="mono text-[9px] font-normal text-txt-dim ml-1">
                                güncel = {fmtDate(d.takvimHaftasi)}
                              </span>
                            )}
                          </th>
                        </tr>
                      </thead>
                      <tbody>
                        {d.firmalar.map((f) => (
                          <tr key={f.retailer} className={f.kendisi ? "" : "opacity-90"}>
                            <td className="whitespace-nowrap">
                              <span className="mono text-[11px]" style={{ color: colorOf(f.retailer) }}>
                                {kanalAdi(f.retailer)}
                              </span>
                              {f.kendisi && <span className="mono text-[9px] text-txt-dim ml-1">(bu ekran)</span>}
                            </td>
                            <td className="mono text-right tabular-nums">{fmtInt(f.qty)}</td>
                            <td className="mono text-right tabular-nums text-txt-dim">{fmt1(f.hiz)}</td>
                            <td className="mono text-right tabular-nums">{fmtInt(f.stock)}</td>
                            <td className="mono text-right tabular-nums text-[11px]"
                              style={{ color: f.kapsam == null ? undefined : f.kapsam < 2 ? "#ff5555" : f.kapsam > 26 ? "#f8b00b" : "#1FF80B" }}>
                              {f.kapsam == null ? "—" : `${fmt1(f.kapsam)} hf`}
                            </td>
                            <td className="mono text-right text-[10px] text-txt-dim whitespace-nowrap">
                              {fmtHafta(f.dataWeek, d.takvimHaftasi)}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                    {/* Dipnot KOŞULLU: uçta bilinçli bir istisna var — ekranın kendi
                        firması bayat olsa da tabloda kalıyor. Koşulsuz cümle
                        /kanal/nezih'te düpedüz yanlıştı. */}
                    <div className="mono text-[10px] text-txt-dim mt-2">
                      {d.firmalar.find((f) => f.kendisi)?.bayat
                        ? `Bu ekranın firması ${d.firmalar.find((f) => f.kendisi)!.gecikmeHf} hafta geride; satırı kıyas için değil referans için duruyor. Diğerlerinden yalnız verisi 2 haftadan taze olanlar tabloda.`
                        : "Diğer firmalardan yalnız verisi 2 haftadan taze olanlar tabloda."}
                      {" "}Bir firmada kapsam kısa (kırmızı) diğerinde uzunsa (sarı) transfer fırsatı olabilir.
                    </div>
                  </div>
                )}
                {/* BAYAT FİRMALAR — karşılaştırmaya alınmadı, ama sessizce yok
                    sayılmadı. "Bu firmada yok" ile "bu firmanın verisi eski"
                    farklı şeyler; ikisi karışırsa yanlış transfer kararı çıkar. */}
                {!!d.disarida?.length && (
                  <div className="mt-3 pt-2 border-t border-line">
                    {d.disarida.map((x) => (
                      /* İKİ FARKLI SEBEP, İKİ FARKLI CÜMLE. Ölçülen şey ürünün o
                         firmada son göründüğü hafta; firmanın raporu güncel olduğu
                         halde ürün listeden çıkmış olabilir. Tek cümle kullanmak
                         güncel raporlayan firmayı haksız yere "geride" diye
                         suçluyordu. */
                      <div key={x.retailer} className="mono text-[11px]" style={{ color: "#f8b00b" }}>
                        ⚠ {kanalAdi(x.retailer)}
                        {x.firmaGecikmeHf != null && x.firmaGecikmeHf < 2
                          ? ` raporu güncel ama bu ürünü ${fmtDate(x.dataWeek)}'ten beri listelemiyor (${x.gecikmeHf} hafta), karşılaştırmaya alınmadı.`
                          : ` ${x.gecikmeHf} hafta geride, karşılaştırmaya alınmadı. Son veri ${fmtDate(x.dataWeek)}.`}
                        {" "}O tarihte {fmtInt(x.qty)} adet satış, {fmtInt(x.stock)} adet stok.
                      </div>
                    ))}
                    <div className="mono text-[10px] text-txt-dim mt-1">
                      Bu rakamlar bugünkülerle aynı ana ait değil; karar için firmadan güncel rapor gerekir.
                    </div>
                  </div>
                )}
              </>
            )}
          </div>
        </div>
      </aside>
    </>
  );
}
