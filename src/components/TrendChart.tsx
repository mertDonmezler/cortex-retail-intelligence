"use client";

// HAFTALIK TREND — firma bazında net ciro / adet çizgileri.
//
// Bu bileşen ana sayfada AÇIK duruyor (çekmecede değil). Kapalı bir çekmecede
// dururken fark edilmeyen üç sorunu, açık hale gelince düzeltmek gerekti:
//
// 1) SUNUM MODU SIZINTISI. DemoMask yalnız HTML yaprak düğümlerini maskeliyor;
//    recharts'ın eksen ve ipucu etiketleri SVG <text>. Yani sunum modunda
//    grafiğin Y ekseni "₺680k" yazmaya devam ediyordu. Artık sunum modunda
//    eksen ve ipucu rakamları gizleniyor (çizgilerin şekli kalıyor — mesaj
//    "ciro şu kadar" değil "eğilim böyle" oluyor).
// 2) connectNulls KALDIRILDI. Rapor göndermeyen haftayı düz çizgiyle köprülemek,
//    olmayan veriyi varmış gibi çiziyor. Bu sistemde "0 ile veri yok"un
//    karıştırılması daha önce yanlış alarm üretti; grafikte de aynı kural:
//    eksik hafta BOŞLUK olarak görünür.
// 3) PENCERE SINIRI KALDIRILDI. Bir süre son 16 hafta çizildi ("x eksenine
//    sığmıyor" gerekçesiyle); ama veri 40 haftaya (1 Ara 2025 → 31 Ağu 2026)
//    uzanıyor ve grafiğin işi tam olarak o uzun eğilimi göstermek. Sığdırma
//    sorunu veriyi kırpmakla değil ekseni seyrelterek çözülür (recharts
//    `interval="preserveStartEnd"` + `minTickGap`: etiketler seyrekleşir,
//    NOKTALAR hepsi çizilir). `haftalar` prop'u yine var — 0/undefined "tümü"
//    demek; bir çağıran isterse pencere verebilir.
//
// KOHORT NOTU: burada sabit kohort GEREKMİYOR, çünkü her çizgi tek bir firmanın
// kendi serisi — firma eklenmesi/çıkması toplamı şişirmiyor. (Ağ TOPLAMI çizen
// bir grafikte kohort şart olurdu.)
import { useMemo, useState } from "react";
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend,
} from "recharts";
import { WeeklySummary, RETAILERS, fmtDate, fmtInt, fmtMoney, RETAILER_COLORS } from "@/lib/format";
import { useDemoMode } from "@/components/DemoMask";

const COLORS = RETAILER_COLORS;

// TÜRETİLMİŞ HAFTA İŞARETİ. Aylık dosyadan türetilmiş (satışı tahmin) bir hafta
// grafikte gerçek haftayla aynı görünüyordu. İçi boş nokta + ipucunda "türetildi"
// notu: veri saklanmıyor, ne olduğu söyleniyor.
type Derived = { retailer: string; week_start: string; note?: string };

export function TrendChart({
  summary, haftalar = 0, derived = [],
}: { summary: WeeklySummary[]; haftalar?: number; derived?: Derived[] }) {
  const [metric, setMetric] = useState<"qty" | "value">("value"); // varsayılan TL
  const demo = useDemoMode();
  const derivedSet = useMemo(() => new Set(derived.map((d) => d.retailer + "|" + d.week_start)), [derived]);

  const { data, kacHafta } = useMemo(() => {
    const tum = [...new Set(summary.map((s) => s.week_start))].sort();
    // haftalar > 0 ise pencere, değilse TÜM geçmiş.
    const son = haftalar > 0 ? tum.slice(-haftalar) : tum;
    const data = son.map((w) => {
      // `_w`: ham hafta — nokta çizerken türetilmiş olup olmadığını bulmak için.
      const row: Record<string, number | string> = { week: fmtDate(w), _w: w };
      for (const r of RETAILERS) {
        const rec = summary.find((s) => s.week_start === w && s.retailer === r);
        // Kayıt yoksa alan HİÇ yazılmaz → recharts o noktada boşluk bırakır.
        // 0 yazmak "sattı ama tutmadı" gibi okunur, yanlış olur.
        // TL MODUNDA CIRO BILINMIYORSA ALAN HIC YAZILMAZ. Ustteki kural yalniz
        // "kayit yok" halini koruyordu; kayit var + sales_value null oldugunda
        // `?? 0` devreye girip cizgiyi tabana indiriyordu - yani "o hafta ciro
        // sifirdi" diye okunuyordu, oysa dogrusu "olculemedi".
        if (rec && (metric === "qty" || rec.sales_value != null)) {
          row[r] = metric === "qty" ? Number(rec.sales_qty) : Number(rec.sales_value);
        }
      }
      return row;
    });
    return { data, kacHafta: son.length };
  }, [summary, metric, haftalar]);

  if (data.length < 2) {
    return (
      <div className="card card-flat p-3">
        <div className="mono text-xs text-txt-dim">Trend için en az 2 hafta verisi gerekli.</div>
      </div>
    );
  }

  return (
    <div className="card card-flat p-3">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 mb-2">
        <div className="flex flex-wrap items-baseline gap-x-2 min-w-0">
          <h2 className="mono text-[11px] text-txt-dim tracking-wider">
            HAFTALIK TREND · {kacHafta} HAFTA (TÜM GEÇMİŞ)
          </h2>
          <span className="mono text-[11px] text-txt-dim">
            {metric === "value" ? "net kazanç" : "adet"} · firma bazında
          </span>
          {/* Eksik hafta köprülenmiyor; kullanıcı boşluğu görünce nedenini bilsin. */}
          <span className="mono text-[11px] text-txt-dim">
            çizgideki boşluk = o hafta rapor gelmedi
          </span>
          {derivedSet.size > 0 && (
            <span className="mono text-[11px]" style={{ color: "#f8b00b" }}>
              içi boş nokta = türetilmiş hafta (aylık dosyadan tahmin)
            </span>
          )}
        </div>
        <div className="flex gap-1 mono text-[11px] shrink-0">
          <button type="button" onClick={() => setMetric("value")}
            className={`px-2 py-0.5 rounded focus:outline-none focus-visible:ring-1 focus-visible:ring-neon ${metric === "value" ? "bg-neon/15 text-neon" : "text-txt-dim hover:text-txt"}`}>
            TL
          </button>
          <button type="button" onClick={() => setMetric("qty")}
            className={`px-2 py-0.5 rounded focus:outline-none focus-visible:ring-1 focus-visible:ring-neon ${metric === "qty" ? "bg-neon/15 text-neon" : "text-txt-dim hover:text-txt"}`}>
            Adet
          </button>
        </div>
      </div>
      <ResponsiveContainer width="100%" height={300}>
        <LineChart data={data} margin={{ top: 6, right: 12, bottom: 4, left: 4 }}>
          <CartesianGrid stroke="#1f2a1f" strokeDasharray="3 3" />
          {/* 40 hafta: etiketler seyreltilir (minTickGap), noktalar tam çizilir. */}
          <XAxis dataKey="week" stroke="#7d927d" fontSize={11} tickMargin={6}
            interval="preserveStartEnd" minTickGap={28} />
          <YAxis stroke="#7d927d" fontSize={11} width={demo ? 28 : 60}
            // SUNUM MODU: rakam yerine nokta. SVG <text> olduğu için DemoMask
            // bunu maskeleyemiyor, o yüzden kaynağında gizleniyor.
            tickFormatter={(v) =>
              demo ? "•••" : (metric === "value" ? "₺" : "") + (v >= 1000 ? `${(v / 1000).toFixed(0)}k` : `${v}`)
            } />
          <Tooltip isAnimationActive={false}
            contentStyle={{ background: "#0f150f", border: "1px solid #1f2a1f", borderRadius: 10, fontSize: 12 }}
            labelStyle={{ color: "#d8e8d8" }}
            formatter={(v: any, name: any, item: any) => {
              const base = demo ? "•••" : metric === "value" ? fmtMoney(Number(v)) : fmtInt(Number(v));
              const w = item?.payload?._w as string | undefined;
              return w && derivedSet.has(String(name) + "|" + w) ? `${base} · türetildi (tahmin)` : base;
            }} />
          <Legend wrapperStyle={{ fontSize: 11 }} />
          {RETAILERS.map((r) => (
            <Line key={r} type="monotone" dataKey={r} stroke={COLORS[r]}
              strokeWidth={2} connectNulls={false}
              // ÇİZİM ANİMASYONU KAPALI. recharts noktaları ancak çizgi animasyonu
              // bitince basar (renderDots: isAnimationActive && !finished → null);
              // 40 hafta × 5 çizgide 1,5 sn'lik çizim, türetilmiş-hafta işaretini
              // ve tüm noktaları geciktiriyor, metrik her değiştiğinde yeniden
              // oynuyor. Bu bir okuma yüzeyi, açılış ekranı değil.
              isAnimationActive={false}
              // Nokta: türetilmiş haftada içi boş ve büyük; gerçek haftada dolu.
              dot={(p: any) => {
                if (p.value == null) return <g key={`${r}-${p.index}`} />;
                const turetildi = derivedSet.has(r + "|" + p.payload?._w);
                return turetildi
                  ? <circle key={`${r}-${p.index}`} cx={p.cx} cy={p.cy} r={4} fill="#0a0e0a" stroke={COLORS[r]} strokeWidth={1.5} />
                  : <circle key={`${r}-${p.index}`} cx={p.cx} cy={p.cy} r={2} fill={COLORS[r]} />;
              }} />
          ))}
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
