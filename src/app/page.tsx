"use client";

// ═══════════════════════════════════════════════════════════════════════════
// CORTEX ANA SAYFA — YÖNETİCİ ÖZETİ
//
// Bu sayfa bir gösterge panosu DEĞİL, bir hüküm ve onun gerekçesidir: en tepede
// haftanın tek net cirosu ve bu haftanın tek fiili durur; altındaki her bant ya
// o fiili gerekçelendirir ya sıradaki fiili sıraya koyar. Ölçüm gösterip karar
// üretmeyen her şey çekmeceye indi.
//
// NEDEN YENİDEN YAZILDI (ölçüm, 1280x720):
//   önce → 3.382 px (4,7 ekran) · 18 blok · 23 kart · ekranda 152 sayı
// Dağınıklığın kaynağı bilgi eksikliği değil TEKRARdı: ağ payı barı manşetin
// kopyasıydı, yıldız/dikkat şeridi firma tablosunun kopyasıydı, ısı haritası
// (her satır kendi maksimumuna normalize olduğu için kanallar arası kıyası
// matematiksel olarak geçersizdi) trendin kopyasıydı.
//
// BANT DÜZENİ
//   0 KOMUTA ŞERİDİ  — kapsam sözleşmesi (hangi hafta, kim eksik)
//   1 MANŞET + HÜKÜM — tek sayı + bu haftanın tek fiili
//   2 DURUM          — 4 kart, her biri kendi eşiğiyle
//   3 KANALLAR       — kanal başına tazelik + adet/TL WoW (KanalSeridi.tsx)
//   4 TREND          — firma bazında haftalık seri (TrendChart.tsx)
//   5 YAPILACAKLAR   — TEYİT / SEVK / ÇEK (Kararlar.tsx)
//   6 ÇEKMECELER     — firma tablosu · geçmiş · nakit & veri güveni
//
// 3-4-5 SIRASI KULLANICI TERCİHİ: önce "kim ne yaptı" (kanallar), sonra "zaman
// içinde ne oldu" (trend), en sonda "ne yapacağım" (yapılacaklar). Fiil listesi
// bağlamın ÜSTÜNDE dururken, okunan ilk şey gerekçesiz bir emir listesiydi.
//
// PARA KURALI: AKIŞ = NET, DURAN STOK = BRÜT PSF. Duran stok asla net'e
// çevrilmez (COGS hiçbir uçta yok). /api/dashboard, /api/overview, /api/cashflow
// ZATEN net döner — istemcide netFactor İKİNCİ KEZ uygulanmaz.
// ═══════════════════════════════════════════════════════════════════════════

import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import {
  WeeklySummary, Freshness, RETAILERS, colorOf,
  fmtInt, fmtMoney, fmtCompact, fmtDate,
} from "@/lib/format";

// Yüzde büyüklüğü — İŞARETSİZ. Yön zaten ▲/▼ ile veriliyor; format.ts'teki
// fmtPct pozitif değere "+" eklediği için Math.abs ile birlikte "▼ +4,1%" gibi
// kendi kendini yalanlayan bir ifade üretiyordu (ölçümde yakalandı).
const buyukluk = (n: number) => `${Math.abs(n).toFixed(1).replace(".", ",")}%`;
import { StatCard } from "@/components/Controls";
import { Kararlar } from "@/components/Kararlar";
import { TrendChart } from "@/components/TrendChart";
import { KanalSeridi } from "@/components/KanalSeridi";
import { MonthlySummary } from "@/components/MonthlySummary";
import { CashCalendar } from "@/components/CashCalendar";import { MailButton } from "@/components/MailButton";
import { fetchJson } from "@/lib/fetchJson";
import { sonTamamlanmisHafta, gecikmeHaftasi } from "@/lib/compute";
import { kanalOzeti, kanalAdi, type KanalOzet } from "@/lib/kanal";
import { SURE, bekleme, useKareEtkisi, azaltilmisHareket } from "@/lib/hareket";
import { mesgulMu } from "@/lib/mesgul";
import { useAsistanBaglami } from "@/lib/asistan-baglam";

// Fiil rozeti renkleri /yonlendirme'deki ACT ile birebir (tek doğruluk kaynağı orası).
const FIIL: Record<string, { c: string; baslik: string }> = {
  "TEYİT": { c: "#c084fc", baslik: "STOK TEYİDİ AL" },
  SEVK: { c: "#1FF80B", baslik: "SEVK ET" },
  "ÇEK": { c: "#f8b00b", baslik: "RAFTAN ÇEK" },
  DENGE: { c: "#7d927d", baslik: "EŞİĞİ AŞAN YOK" },
};
// Hüküm karesinde Kararlar'daki aynı fiilin grup başlığı da aynı renkte söner
// (hüküm ile gerekçesi tek karede bağlanır). DENGE'nin grubu yok → yankı yok.
const YANKI: Record<string, "teyit" | "sevk" | "cek" | undefined> = { "TEYİT": "teyit", SEVK: "sevk", "ÇEK": "cek" };

// KISMİ HAFTA EŞİĞİ.
//
// VARSAYILAN HAFTA HER ZAMAN EN YENİDİR — bu bilinçli bir tercih: panele bakan
// kişi en tazesini görmek istiyor ve sistemin haftayı kendi kafasına göre geriye
// alması, "neden dünkü veriyi görüyorum" sorusunu doğuruyor.
//
// Bunun bedeli şu: firmalar aynı gün rapor göndermediği için en yeni hafta bir-iki
// firmalık olabiliyor ve manşetteki mutlak rakam ağ toplamı sanılabiliyor. Ölçülen:
// 2026-08-31 haftasında yalnız Huppaluppo vardı, manşet ₺18.488 yazıyordu; bir
// hafta öncesi ₺1.017.529 (4 firma). Etikette "1/5 firma" yazılı olması yetmiyor —
// göz önce büyük sayıya gidiyor, etiketi sonra okuyor.
//
// Çözüm haftayı değiştirmek DEĞİL, rakamın kendisini işaretlemek: kısmi haftada
// manşet neon yeşil yerine amber basılır, yanında KISMİ rozeti ve "ağ toplamı
// değil" notu durur. Sayı doğru; yalnız ne olduğu açıkça söylenir.
//
// Eşik: son 8 haftada görülen en yüksek firma sayısının yarısı (taban 2). Bugünkü
// veriyle tipik sayı 4 → eşik 2 → 1 firmalık hafta kısmi sayılır, 4 firmalık sayılmaz.
function kismiEsik(sum: WeeklySummary[]): number {
  const haftalar = [...new Set(sum.map((s) => s.week_start))].sort().slice(-8);
  if (!haftalar.length) return 2;
  const enYuksek = Math.max(...haftalar.map((w) => sum.filter((x) => x.week_start === w).length), 0);
  return Math.max(2, Math.ceil(enYuksek / 2));
}

export default function AnaSayfa() {
  // ── Faz 1: haftadan bağımsız ana veri ──
  const [summary, setSummary] = useState<WeeklySummary[]>([]);
  const [freshness, setFreshness] = useState<Freshness[]>([]);
  const [cash, setCash] = useState<any>(null);
  // Türetilmiş (sentetik) haftalar — trend ve aylık özette işaretlenir.
  const [derived, setDerived] = useState<{ retailer: string; week_start: string; note: string }[]>([]);
  const [yukleniyor, setYukleniyor] = useState(true);
  const [hata, setHata] = useState<string | null>(null);

  // ── Haftaya bağlı veri ──
  const [week, setWeek] = useState<string>("");
  // CORTEX asistanı "bu hafta" dendiğinde seçili haftayı bilsin.
  useAsistanBaglami(week ? { "seçili hafta": week } : null);
  const [ov, setOv] = useState<any>(null);
  const [ovHata, setOvHata] = useState(false);
  const [rapor, setRapor] = useState<any>(null);
  // Her yanıtın HANGİ HAFTAYA ait olduğu. Seçici yeni haftayı gösterirken
  // manşet eski haftanın rakamını tam parlaklıkta basıyordu (sessiz bir yalan);
  // damga farklıysa o okuma soluk basılır. Render'da türetilir, effect'le değil.
  const [ovHafta, setOvHafta] = useState("");
  const [raporHafta, setRaporHafta] = useState("");
  const [healthHafta, setHealthHafta] = useState("");

  // ── Faz 2: karar motoru (ağır) ──
  const [rt, setRt] = useState<{ routes: any[]; summary: any } | null>(null);
  const [rtHata, setRtHata] = useState(false);
  const [health, setHealth] = useState<any>(null);
  // İMZA ANI — hükmün geldiği kare. Yalnız "KARAR MOTORU ÇALIŞIYOR…" gerçekten
  // görünür bir süre (≥ 600 ms) beklettiyse oynar; sıcak önbellekten hızlı
  // dönen yanıt sahnelenmiş bir "karar anı" üretmez. Sayfa mount'u başına bir kez.
  const bekleBasi = useRef<number | null>(null);
  const [hukumAtesi, setHukumAtesi] = useState(false);

  // Faz 1. weeks listesi BURADAN türetilir; /api/overview.weeks kullanılmaz çünkü
  // overview'un kendisi ?week= istiyor ve açılışta week boş → tavuk-yumurta.
  useEffect(() => {
    Promise.all([
      fetchJson("/api/dashboard"),
      fetchJson("/api/cashflow").catch(() => null),
    ])
      .then(([d, c]) => {
        const sum = (d?.summary ?? []) as WeeklySummary[];
        setSummary(sum);
        setFreshness((d?.freshness ?? []) as Freshness[]);
        setDerived(d?.derived ?? []);
        setCash(c);
        // Varsayılan HER ZAMAN en yeni hafta (bkz. kismiEsik açıklaması).
        const ws = [...new Set(sum.map((s) => s.week_start))].sort();
        if (ws.length) setWeek(ws[ws.length - 1] as string);
      })
      .catch((e) => { setHata(e.message); setSummary([]); setFreshness([]); })
      .finally(() => setYukleniyor(false));
  }, []);

  // Faz 2 — bir kez. Hafta değişince YENİDEN ÇEKİLMEZ: karar motoru her firmanın
  // kendi son raporuna bakar (hafta seçiminden bağımsız) ve 4 sn sürüyor.
  useEffect(() => {
    let iptal = false;
    fetchJson("/api/routing?mode=denge&slim=1")
      .then((x) => {
        if (iptal) return;
        setRt({ routes: x?.routes ?? [], summary: x?.summary ?? {} });
        setHukumAtesi(bekleBasi.current != null && performance.now() - bekleBasi.current >= SURE.imzaEsigi);
      })
      .catch(() => { if (!iptal) setRtHata(true); });
    return () => { iptal = true; };
  }, []);

  // Haftaya bağlı iki uç. Hafta değiştiğinde YALNIZ bunlar yenilenir.
  useEffect(() => {
    if (!week) return;
    // Hızlı ardışık seçimde geç dönen eski yanıt yenisini ezmesin.
    const w = week;
    let iptal = false;
    setOvHata(false);
    fetchJson(`/api/overview?week=${encodeURIComponent(w)}`)
      .then((x) => { if (iptal) return; setOv(x); setOvHafta(w); })
      .catch(() => { if (iptal) return; setOv(null); setOvHata(true); setOvHafta(w); });
    fetchJson(`/api/weekly-report?week=${encodeURIComponent(w)}`)
      .then((x) => { if (iptal) return; setRapor(x); setRaporHafta(w); })
      .catch(() => { if (iptal) return; setRapor(null); setRaporHafta(w); });
    // SAĞLIK UCU DA HAFTAYA BAĞLI ÇEKİLİR.
    // Skor haftadan bağımsız, ama `nullValueWeek` (manşetin altındaki "fiyatsız
    // N satır" uyarısı) SEÇİLİ HAFTAYA ait olmak zorunda. Uç bu parametreyi
    // destekliyordu; istemci hiç göndermiyordu ve alan kalıcı olarak ağın en
    // yeni haftasına sabitleniyordu. Ölçülen sonuç: 2026-08-31'de o hafta 0
    // fiyatsız satır olduğu için `rows > 0` kapısı hiç açılmıyor ve uyarı
    // HANGİ HAFTA SEÇİLİRSE SEÇİLSİN görünmüyordu — 24 Ağustos'ta gerçekte 25
    // fiyatsız satır varken bile. Uç kendi içinde hafta başına önbellekli.
    fetchJson(`/api/health?week=${encodeURIComponent(w)}`)
      .then((x) => { if (iptal) return; setHealth(x); setHealthHafta(w); })
      .catch(() => { if (iptal) return; setHealth(null); setHealthHafta(w); });
    return () => { iptal = true; };
  }, [week]);

  // Geçersiz okuma: ekrandaki yanıt seçili haftaya ait değil. İlk açılışta
  // (veri yok) soluma olmaz; sabit iskelet/metin kalır.
  const ovBekliyor = ov != null && ovHafta !== week;
  const raporBekliyor = rapor != null && raporHafta !== week;
  const healthBekliyor = health != null && healthHafta !== week;

  // Beklemenin görünür başladığı an: iskelet bitmiş, hüküm yuvası
  // "KARAR MOTORU ÇALIŞIYOR…" basıyor. Boyamadan önce ölçülür.
  const bekliyorGorunur = !yukleniyor && !hata && summary.length > 0 && !rt && !rtHata;
  useKareEtkisi(() => {
    if (bekliyorGorunur && bekleBasi.current == null) bekleBasi.current = performance.now();
  }, [bekliyorGorunur]);

  // Logo ateşi: tarama durur, beş kanal okundu. Başka istek hâlâ sürüyorsa
  // (ekran henüz kesin değil) atlanır; yalnız rozet ve yankı oynar.
  useKareEtkisi(() => {
    if (!hukumAtesi || mesgulMu() || azaltilmisHareket()) return;
    const h = document.documentElement;
    h.setAttribute("data-ates", "");
    const t = setTimeout(() => h.removeAttribute("data-ates"), SURE.sonum + 40);
    return () => { clearTimeout(t); h.removeAttribute("data-ates"); };
  }, [hukumAtesi]);

  const weeks = useMemo(
    () => [...new Set(summary.map((s) => s.week_start))].sort().reverse(),
    [summary]
  );
  const guncelHafta = weeks[0] ?? null;
  const gecmisSecili = !!week && !!guncelHafta && week !== guncelHafta;
  const esik = useMemo(() => kismiEsik(summary), [summary]);

  // ── İKİ AYRI GECİKME HARİTASI — ZORUNLU ──
  //
  // gecikmeKarar: TAKVİME çapalı, hafta seçicisinden BAĞIMSIZ. Rozetler, askı ve
  //   BANT 0 bunu okur. Kaynağı öncelikle karar motorunun kendi yanıtı (tek
  //   kaynak kuralı: aynı sayı iki yerden hesaplanırsa bir gün ayrışır); motor
  //   gelene kadar freshness'tan AYNI saf fonksiyonla türetilir.
  // gecikmeHafta: SEÇİLİ HAFTAYA göre. Manşetin EKSİK satırı ve firma tablosu
  //   bunu okur. (Kanal şeridi kendi referansını seçer — bkz. `referans`.)
  //
  // Eskiden tek harita vardı ve `guncelHafta` tabanlıydı: 10 Ağustos seçilince
  // Nezih "4 hf geride" yazıyordu, doğrusu 1. Tek haritayı seçili haftaya
  // çevirmek ise karar rozetlerini bozardı (routing hafta-bağımsız çekiliyor).
  const takvimHaftasi = useMemo(() => sonTamamlanmisHafta(new Date()), []);
  const gecikmeKarar = useMemo(() => {
    const m: Record<string, number> = {};
    const byRet = rt?.summary?.veri?.byRetailer as any[] | undefined;
    if (byRet?.length) {
      for (const r of byRet) m[r.retailer] = r.kararGecikmeHf ?? r.gecikmeHf ?? 0;
      return m;
    }
    for (const f of freshness) m[f.retailer] = gecikmeHaftasi(f.last_week, takvimHaftasi);
    return m;
  }, [rt, freshness, takvimHaftasi]);
  const gecikmeHafta = useMemo(() => {
    const m: Record<string, number> = {};
    if (!week) return m;
    for (const f of freshness) m[f.retailer] = gecikmeHaftasi(f.last_week, week);
    return m;
  }, [freshness, week]);

  // ── KANAL ŞERİDİ VERİSİ ──
  //
  // REFERANS HAFTA İKİ YÜZLÜ, bilerek: en yeni hafta seçiliyken gecikme TAKVİME
  // göre ölçülür (bugün 07 Eyl, Nezih 03 Ağu → 5 hafta geride). Geçmiş bir hafta
  // seçiliyken o haftaya göre ölçülür; yoksa Ağustos'a bakan kullanıcıya herkesin
  // "geride" olduğu söylenirdi ve bu hem yanlış hem kullanılamaz olurdu.
  const referans = gecmisSecili && week ? week : takvimHaftasi;
  const ozetler = useMemo<KanalOzet[]>(
    () => RETAILERS.map((r) => kanalOzeti(summary as any, r, week, referans)),
    [summary, week, referans]
  );

  // Seçili haftanın satırları (manşet yedeği ve kohort trendi için).
  const haftaSatir = useMemo(
    () => summary.filter((s) => s.week_start === week),
    [summary, week]
  );

  // MANŞET. Birincil kaynak /api/overview (tek delta tanımı orada). Overview
  // düşerse sayı dashboard'dan basılır ama DELTA GÖSTERİLMEZ — ham hafta kıyası
  // kohort tutarsızlığı yüzünden yanlış alarm üretiyor (ör. 4 firma → 2 firma
  // geçişinde "ciro yarılandı").
  const net = ov?.network?.sales_value ?? haftaSatir.reduce((a, s) => a + (s.sales_value ?? 0), 0);
  const adet = ov?.network?.sales_qty ?? haftaSatir.reduce((a, s) => a + (s.sales_qty ?? 0), 0);
  const firmaSayisi = ov?.network?.retailer_count ?? haftaSatir.length;
  const wowVal = ov?.network?.wow_value ?? null;
  const wowQty = ov?.network?.wow_qty ?? null;
  // KISMİ HAFTA: bu haftada raporlayan firma sayısı eşiğin altında. Sayı yanlış
  // değil — ama ağ toplamı DEĞİL, ve manşet boyutundaki bir rakam öyle okunuyor.
  const kismi = firmaSayisi > 0 && firmaSayisi < esik;

  // ── HÜKÜM MERDİVENİ ──
  // Sıra tesadüfi değil: teyit edilmemiş stok üzerinde alınan her karar (çek /
  // likide et) yanlış olabilir, o yüzden TEYİT her şeyin önünde. Sonra raf
  // boşalması (kaybedilen satış geri gelmez), sonra bağlı sermaye.
  // NOT: veri sağlığı skoru merdivende KULLANILMIYOR — mevcut ceza katsayılarıyla
  // ulaşılabilecek en düşük skor eşiğin üstünde kalıyor, yani o basamak ölü koddu.
  const s = rt?.summary ?? {};
  const teyitN = s?.teyit?.n ?? 0;
  const sevkN = s?.sevkKritik?.n ?? s?.sevk?.n ?? 0;
  const cekN = s?.cek?.n ?? ((s?.depo?.n ?? 0) + (s?.transfer?.n ?? 0) + (s?.likidasyon?.n ?? 0));
  const cekPsf = s?.cek?.psf ?? s?.frozenFreed ?? 0;
  const fiil = teyitN > 0 ? "TEYİT" : sevkN > 0 ? "SEVK" : cekN > 0 ? "ÇEK" : "DENGE";

  if (yukleniyor) return <Iskelet />;
  if (hata) return <HataKutusu msg={hata} />;
  if (!summary.length) return <Bos />;

  return (
    // layout.tsx'in py-8 dolgusu 12 sayfanın hepsini sarıyor; oraya dokunmadan
    // (diğer sayfalar görsel olarak değişmesin) burada bir miktar geri alınıyor.
    <div className="space-y-4 -mt-2">

      {/* ══ BANT 0 — KOMUTA ŞERİDİ. Sayfadaki her sayının hangi haftaya ait
          olduğunu tek yerde sabitler. Firma çipleri BİLİNÇLİ olarak kaldırıldı:
          13 bloktan yalnız 5'ini süzüyordu, kalanı sessizce tüm ağı gösteriyordu
          — sessiz kapsam çelişkisinin ana kaynağıydı. Filtre isteyen /stok,
          /yonlendirme, /compare, /rankings sayfalarında zaten var. ══ */}
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
        <div className="flex items-baseline gap-2 min-w-0">
          <h1 className="text-lg font-bold tracking-tight shrink-0">Yönetici Özeti</h1>
          <span className="mono text-[11px] text-txt-dim truncate cx-soluk" {...bekleme(raporBekliyor)}>
            {rapor?.range ?? fmtDate(week)}
          </span>
          {gecmisSecili && (
            <span className="mono text-[11px] px-1.5 py-0.5 rounded shrink-0"
              style={{ color: "#f8b00b", border: "1px solid #f8b00b40" }}>
              GEÇMİŞ HAFTA
            </span>
          )}
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <select value={week} onChange={(e) => setWeek(e.target.value)}
            className="bg-ink-2 border border-line rounded px-2 py-1 mono text-[11px] focus:outline-none focus-visible:ring-1 focus-visible:ring-neon">
            {weeks.map((w) => <option key={w} value={w}>{fmtDate(w)}</option>)}
          </select>
          <MailButton week={week} ozet={rt?.summary} />
          <a href={`/api/export?week=${encodeURIComponent(week)}`}
            className="mono text-[11px] text-txt-dim hover:text-neon rounded px-1 focus:outline-none focus-visible:ring-1 focus-visible:ring-neon">
            <span className="sm:hidden">⬇</span><span className="hidden sm:inline">⬇ Excel</span>
          </a>
        </div>
      </div>

      {/* ══ BANT 1 — MANŞET + HÜKÜM + FİRMA KIRILIMI ══ */}
      <div className="card card-flat p-4 space-y-3">
      <div className="grid grid-cols-1 lg:grid-cols-[1fr_auto_1.05fr] gap-4">
        {/* SOL: manşet */}
        <div className="min-w-0">
          <div className="flex flex-wrap items-baseline gap-x-2">
            <span className="mono text-[11px] text-txt-dim tracking-wider">NET CİRO</span>
            <span className="mono text-[11px] text-txt-dim cx-soluk" {...bekleme(raporBekliyor)}>{rapor?.range ?? fmtDate(week)}</span>
            <span className="mono text-[11px] text-txt-dim cx-soluk" {...bekleme(ovBekliyor)}>{firmaSayisi}/5 firma</span>
          </div>
          <div className="flex flex-wrap items-baseline gap-x-3 mt-0.5 cx-soluk" {...bekleme(ovBekliyor)}>
            {/* Kısmi haftada manşet NEON BASILMAZ. Neon bu sayfada "ağın manşeti"
                anlamına geliyor; bir firmalık bir rakamı aynı vurguyla basmak,
                doğru sayıyı yanlış cümleye çevirir. */}
            <span className={`text-3xl font-bold mono tabular-nums ${kismi ? "" : "neon-text"}`}
              style={kismi ? { color: "#f8b00b" } : undefined}>{fmtMoney(net)}</span>
            {kismi && (
              <span className="mono text-[11px] px-1.5 py-0.5 rounded shrink-0"
                style={{ color: "#f8b00b", border: "1px solid #f8b00b40", background: "#f8b00b14" }}>
                KISMİ
              </span>
            )}
            {wowVal == null ? (
              <span className="mono text-[11px] text-txt-dim">
                {ovHata ? "kohort deltası alınamadı" : "—"}
              </span>
            ) : (
              /* KISMİ HAFTADA OK NÖTR GRİ. Ölçülen hata: 31 Ağustos haftasında
                 yalnız Huppaluppo var ve ok "▲ %16,5" YEŞİL basılıyordu — oysa ağ
                 cirosu ₺1.017.529'dan ₺18.488'e inmiş görünüyor. Yüzde firmanın
                 kendi kıyası olduğu için sayı doğru, ama yeşil ok ağın büyüdüğünü
                 söyleyen bir işaret ve o yanlış. */
              <span className="mono text-sm tabular-nums"
                style={{ color: kismi ? "#7d927d" : wowVal >= 0 ? "#1FF80B" : "#ff5555" }}>
                {wowVal >= 0 ? "▲" : "▼"} {buyukluk(wowVal)}
              </span>
            )}
          </div>
          <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 cx-soluk" {...bekleme(ovBekliyor)}>
            <span className="mono text-[11px] text-txt-dim">aynı {firmaSayisi} firma ile</span>
            <span className="mono text-[11px] text-txt-dim tabular-nums">{fmtInt(adet)} adet</span>
            {wowQty != null && (
              <span className="mono text-[11px] tabular-nums"
                style={{ color: kismi ? "#7d927d" : wowQty >= 0 ? "#7d927d" : "#f8b00b" }}>
                {wowQty >= 0 ? "▲" : "▼"} {buyukluk(wowQty)}
              </span>
            )}
          </div>
          {/* Ölçüm boşluğu: fiyatı olmayan satırların cirosu 0 kalıyor, yani manşet
              OLDUĞUNDAN AZ. TL yazılmaz (birim fiyat bilinmiyor, uydurmak olur);
              adet manşetin adediyle kıyaslanabilir. Tıklanınca eşleştirme sayfası. */}
          {health?.nullValueWeek?.rows > 0 && (
            <a href="/eslesme" {...bekleme(healthBekliyor)}
              className="mt-1 inline-flex flex-wrap gap-x-2 rounded focus:outline-none focus-visible:ring-1 focus-visible:ring-neon cx-soluk">
              <span className="mono text-[11px] text-txt-dim">fiyatsız</span>
              <span className="mono text-[11px] tabular-nums" style={{ color: "#f8b00b" }}>
                {fmtInt(health.nullValueWeek.rows)} satır
              </span>
              <span className="mono text-[11px] tabular-nums text-txt-dim">
                {fmtInt(health.nullValueWeek.qty)} adet
              </span>
            </a>
          )}
          {/* Kısmi haftada tek cümlelik uyarı. "1/5 firma" etiketi zaten var ama
              etiket okunmadan sayı okunuyor; bu satır rakamın NE OLMADIĞINI söyler. */}
          {kismi && (
            <div className="mt-1 mono text-[11px] cx-soluk" {...bekleme(ovBekliyor)} style={{ color: "#f8b00b" }}>
              Bu ağ toplamı değil — {5 - firmaSayisi} firma bu haftayı henüz raporlamadı.
            </div>
          )}
          {/* Kim eksik, kaç hafta geride — kapsam yüzdesi BASILMAZ (eksik firma
              kümesine göre oynayan bir oran güven satırında çürür). */}
          {rapor?.missing?.length > 0 && (
            <div className="mt-1 flex flex-wrap gap-x-2 cx-soluk" {...bekleme(raporBekliyor)}>
              <span className="mono text-[11px]" style={{ color: "#f8b00b" }}>EKSİK:</span>
              {rapor.missing.map((r: string) => (
                <span key={r} className="mono text-[11px] text-txt-dim">
                  {/* SEÇİLİ HAFTAYA göre gecikme (takvime göre değil): geçmiş bir
                      hafta seçildiğinde "4 hf geride" yazmak yanlıştı. */}
                  {r} {gecikmeHafta[r] != null && gecikmeHafta[r] < 99 ? `${gecikmeHafta[r]} hf` : ""}
                </span>
              ))}
            </div>
          )}
        </div>

        <div className="hidden lg:block w-px bg-line" />

        {/* SAĞ: hüküm. Hafta seçicisinden BAĞIMSIZ (routing her firmanın kendi son
            raporuna bakar) — bu yüzden rozet şart, yoksa tek kartın sol yarısı
            geçmişi sağ yarısı bugünü gösterir ve hiçbir işaret olmaz. */}
        <div className="min-w-0 border-t lg:border-t-0 border-line pt-3 lg:pt-0">
          <div className="flex items-baseline justify-between gap-2">
            <span className="mono text-[11px] text-txt-dim tracking-wider">BU HAFTA</span>
            <span className="mono text-[11px] text-txt-dim">her zaman güncel</span>
          </div>
          {!rt && !rtHata ? (
            <div className="mono text-xs text-txt-dim mt-1">KARAR MOTORU ÇALIŞIYOR…</div>
          ) : rtHata ? (
            <div className="mt-1">
              <div className="mono text-xs text-amber-400">KARAR MOTORU YANIT VERMEDİ</div>
              <a href="/yonlendirme" className="mono text-[11px] neon-text">yönlendirmeye git &rarr;</a>
            </div>
          ) : (
            <>
              <div className={`mt-1 inline-block mono text-sm font-bold px-2 py-0.5 rounded${hukumAtesi ? " cx-hukum" : ""}`}
                style={{
                  color: FIIL[fiil].c, border: `1px solid ${FIIL[fiil].c}55`, background: FIIL[fiil].c + "14",
                  "--cx-hale": FIIL[fiil].c + "99", "--cx-dolgu": FIIL[fiil].c + "38",
                } as CSSProperties}>
                {FIIL[fiil].baslik}
              </div>
              <div className="mt-1.5 space-y-0.5">
                {fiil === "TEYİT" && (
                  <>
                    <div className="flex flex-wrap gap-x-2">
                      <span className="mono text-sm tabular-nums">{fmtInt(teyitN)} kalem</span>
                      <span className="mono text-sm tabular-nums text-txt-dim">{fmtInt(s?.teyit?.qty ?? 0)} adet</span>
                    </div>
                    <div className="flex flex-wrap gap-x-2">
                      <span className="mono text-[11px] tabular-nums text-txt-dim">{fmtCompact(s?.teyit?.psf ?? 0)}</span>
                      <span className="mono text-[11px] text-txt-dim">raf değeri</span>
                    </div>
                    {s?.teyit?.enEskiHf > 0 && (
                      <div className="mono text-[11px] text-txt-dim">
                        en eskisi {fmtInt(s.teyit.enEskiHf)} haftadır raporda yok
                      </div>
                    )}
                  </>
                )}
                {fiil === "SEVK" && (
                  <>
                    <div className="flex flex-wrap gap-x-2">
                      <span className="mono text-sm tabular-nums">{fmtInt(sevkN)} kalem</span>
                      <span className="mono text-sm tabular-nums text-txt-dim">{fmtInt(s?.sevkKritik?.qty ?? 0)} adet</span>
                    </div>
                    <div className="mono text-[11px] text-txt-dim">raf boşalıyor</div>
                  </>
                )}
                {fiil === "ÇEK" && (
                  <div className="flex flex-wrap gap-x-2">
                    <span className="mono text-sm tabular-nums">{fmtInt(cekN)} kalem</span>
                    <span className="mono text-sm tabular-nums text-txt-dim">{fmtCompact(cekPsf)}</span>
                  </div>
                )}
                {/* Sıradaki fiiller — her sayı ayrı yaprak (sunum modu 48 karakter sınırı) */}
                <div className="flex flex-wrap gap-x-2 pt-0.5">
                  <span className="mono text-[11px] text-txt-dim">sonra:</span>
                  {fiil !== "SEVK" && sevkN > 0 && (
                    <>
                      <span className="mono text-[11px]" style={{ color: FIIL.SEVK.c }}>SEVK</span>
                      <span className="mono text-[11px] tabular-nums text-txt-dim">{fmtInt(sevkN)} kalem</span>
                    </>
                  )}
                  {fiil !== "ÇEK" && cekN > 0 && (
                    <>
                      <span className="mono text-[11px]" style={{ color: FIIL["ÇEK"].c }}>ÇEK</span>
                      {/* Tutar BİLİNÇLİ olarak yazılmıyor: BANT 2'nin "BAĞLI RAF DEĞERİ"
                          kartı aynı sayıyı gösteriyor. Ölçümde aynı dizge iki kez
                          basılıyordu (₺33,7 mn x2) — tekrar, dağınıklığın kaynağı. */}
                      <span className="mono text-[11px] tabular-nums text-txt-dim">{fmtInt(cekN)} kalem</span>
                    </>
                  )}
                </div>
              </div>
            </>
          )}
        </div>
      </div>

      </div>

      {/* ══ BANT 2 — DURUM. Dört kart, her biri KENDİ EŞİĞİYLE. Eşiksiz sayı
          "iyi mi kötü mü" sorusunu cevaplamıyordu (eski KPI şeridinin asıl
          kusuru buydu, sayı azlığı değil). Kartlar hafta seçicisinden bağımsız:
          her firmanın kendi son raporu. ══ */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <StatCard dense label="RAF KAPSAMI"
          value={s?.kapsam?.hafta != null ? `${fmtInt(s.kapsam.hafta)} hf` : "—"}
          sub={s?.kapsam?.hafta != null
            ? `motor eşiği ${s?.kapsam?.esik ?? 8} hf · bayat hariç`
            : "karar motoru bekleniyor"} />
        <StatCard dense label="BAĞLI RAF DEĞERİ"
          value={cekPsf > 0 ? fmtCompact(cekPsf) : "—"}
          chip={{ label: "PSF", color: "#f8b00b" }}
          sub={cekN > 0 ? `${fmtInt(cekN)} kalem · net karşılığı YOK` : "karar motoru bekleniyor"} />
        <StatCard dense label="SAHADA ALACAK"
          value={cash?.receivable?.total != null ? fmtCompact(cash.receivable.total) : "—"}
          chip={{ label: "NET", color: "#1FF80B" }}
          sub="satılmış malın vadesi gelmemiş karşılığı" />
        <StatCard dense label="VERİ SAĞLIĞI"
          value={health?.score != null ? `${health.score}/100` : "—"}
          color={health?.score != null && health.score < 60 ? "#f8b00b" : undefined}
          sub={health?.issues?.length ? `${health.issues.length} sorun · çekmecede ayrıntı` : "—"} />
      </div>

      {/* ══ BANT 3 — KANALLAR ══ */}
      <KanalSeridi ozetler={ozetler} referansHafta={referans} takvimHaftasi={takvimHaftasi}
        notlar={<VeriNotlari veri={rt?.summary?.veri} />} />

      {/* ══ BANT 4 — HAFTALIK TREND (açık, çekmecede değil) ══
          Buraya önce sabit-kohortlu tek çizgili bir sparkline konmuştu; kullanıcı
          firma bazında çizgileri olan gerçek grafiği istedi. İkisini birlikte
          bırakmak iki "trend" bloğu demekti — bu sayfanın kurulma nedeni olan
          tekrarı geri getirirdi, o yüzden sparkline kaldırıldı.
          Kohort makinesi de gitti: her çizgi tek firmanın kendi serisi olduğu için
          firma eklenip çıkması toplamı şişirmiyor, eksik hafta boşluk olarak
          görünüyor (bkz. TrendChart içindeki not). */}
      <TrendChart summary={summary} derived={derived} />

      {/* ══ BANT 5 — YAPILACAKLAR. Şeridin ve grafiğin ALTINDA: fiil listesi
          okunmadan önce hangi kanalın güncel olduğu ve trendin nereye gittiği
          görülsün. ══ */}
      <Kararlar d={rt} hata={rtHata} gecikme={gecikmeKarar} takvimHaftasi={takvimHaftasi}
        yanki={hukumAtesi ? YANKI[fiil] : undefined} />

      {/* ══ BANT 6 — ÇEKMECELER. Collapse kapalıyken çocuğu HİÇ mount etmiyor,
          yani buradaki ağır bileşenler (recharts) ilk boyamaya girmiyor. ══ */}
      <div className="space-y-2">
        <Cekmece baslik="Firma tablosu · ciro, stok, gecikme">
          {/* Seçili haftaya göre gecikme — WoW bandıyla aynı harita (§ iki harita). */}
          <FirmaTablosu summary={haftaSatir} gecikme={gecikmeHafta} guncelHafta={guncelHafta} />
        </Cekmece>
        <Cekmece baslik="Aylık özet · tüm geçmiş">
          <MonthlySummary summary={summary} visible={RETAILERS} derived={derived} />
        </Cekmece>
        <Cekmece baslik="Nakit takvimi ve veri güveni">
          <div className="space-y-6">
            <CashCalendar />
            <VeriGuveni health={health} />
          </div>
        </Cekmece>
      </div>
    </div>
  );
}

// ═══════════════════════ VERİ NOTLARI ═══════════════════════
// Kanal şeridinin altına düşen iki kayıt. Şeridin kartları "kim güncel" sorusunu
// cevaplıyor; bu notlar o gecikmenin BEDELİNİ yazıyor.
//
// ASKI KAYDI KÜTLE TAŞIR: "karar üretilmiyor" cümlesi tek başına sessizlik
// demek — kaç kalem / kaç adet / kaç TL değerlendirilemediği yazılmadan
// "sorun yok" diye okunur. İstenecek haftalar motorda hafta serisinden
// türetiliyor (elle yazılmıyor); veriyi alma döngüsünü kapatan tek şey bu.
function VeriNotlari({ veri }: { veri: any }) {
  const rows: any[] = veri?.byRetailer ?? [];
  const askidakiler = rows.filter((r) => (r.askida?.n ?? 0) > 0);
  const kapali = veri?.kapali;
  if (!askidakiler.length && !(kapali?.atlanan > 0) && !kapali?.geriDonen?.length) return null;
  return (
    <div className="space-y-1 pt-0.5">
      {askidakiler.map((r) => (
        <div key={r.retailer} className="flex flex-wrap items-baseline gap-x-2"
          style={{ borderLeft: "2px solid #f8b00b", paddingLeft: 8 }}>
          <span className="mono text-[11px]" style={{ color: "#f8b00b" }}>{r.durum?.toUpperCase() ?? "ASKIDA"}</span>
          <span className="mono text-[11px]" style={{ color: colorOf(r.retailer) }}>{kanalAdi(r.retailer)}</span>
          <span className="mono text-[11px] tabular-nums text-txt-dim">{fmtInt(r.askida.n)} kalem</span>
          <span className="mono text-[11px] tabular-nums text-txt-dim">{fmtInt(r.askida.qty)} adet</span>
          <span className="mono text-[11px] tabular-nums text-txt-dim">{fmtCompact(r.askida.psf)}</span>
          <span className="mono text-[11px] text-txt-dim">değerlendirilemiyor</span>
          {r.eksikHaftalar?.length > 0 && (
            <span className="mono text-[11px] text-txt-dim">
              istenecek: {r.eksikHaftalar.map((w: string) => fmtDate(w)).join(", ")}
            </span>
          )}
          <a href="/upload" className="mono text-[11px] neon-text rounded focus:outline-none focus-visible:ring-1 focus-visible:ring-neon">
            yükle →
          </a>
        </div>
      ))}
      {kapali?.atlanan > 0 && (
        <div className="mono text-[11px] text-txt-dim">
          Kapalı (tasfiye edilmiş) {fmtInt(kapali.atlanan)} kalem · {fmtInt(kapali.stok)} adet karar üretmiyor.
        </div>
      )}
      {kapali?.geriDonen?.length > 0 && (
        <div className="mono text-[11px]" style={{ color: "#f8b00b" }}>
          Kapalı sayılan {kapali.geriDonen.length} kalem raporda yeniden göründü — kayıt gözden geçirilmeli.
        </div>
      )}
    </div>
  );
}

// ═══════════════════════ ÇEKMECE ═══════════════════════
// Kapalıyken çocuk HİÇ mount edilmez (ilk boyamaya ağırlık bindirmesin).
function Cekmece({ baslik, children }: { baslik: string; children: ReactNode }) {
  const [acik, setAcik] = useState(false);
  return (
    <div className="card overflow-hidden">
      <button type="button" onClick={() => setAcik((o) => !o)} aria-expanded={acik}
        className="w-full flex items-center justify-between gap-3 px-3 py-2.5 text-left hover:bg-neon/5 hover:transition-colors rounded focus:outline-none focus-visible:ring-1 focus-visible:ring-neon">
        <span className="mono text-[11px] tracking-wider text-txt-dim">{baslik}</span>
        <span className="mono text-[11px] text-txt-dim shrink-0">{acik ? "▾ gizle" : "▸ aç"}</span>
      </button>
      {acik && <div className="border-t border-line/60 p-3">{children}</div>}
    </div>
  );
}

// Firma tablosu — eski 5 kartın yerine. Rapor göndermeyen firmanın hücresi `0`
// DEĞİL `—` ve satırı işaretli; sıfır yazmak "sattı ama tutmadı" gibi okunuyor.
function FirmaTablosu({
  summary, gecikme, guncelHafta,
}: { summary: WeeklySummary[]; gecikme: Record<string, number>; guncelHafta: string | null }) {
  const byR = new Map(summary.map((s) => [s.retailer, s]));
  return (
    <div className="overflow-x-auto">
      <table>
        <thead>
          <tr>
            <th>Firma</th><th className="text-right">Net ciro</th><th className="text-right">Adet</th>
            <th className="text-right">Stok</th><th className="text-right">SKU</th><th>Durum</th>
          </tr>
        </thead>
        <tbody>
          {RETAILERS.map((r) => {
            const s = byR.get(r);
            const hf = gecikme[r] ?? 0;
            const yok = !s;
            return (
              <tr key={r} style={yok ? { background: "#f8b00b0d" } : undefined}>
                <td className="mono text-xs" style={{ color: colorOf(r) }}>{r}</td>
                <td className="text-right mono text-xs tabular-nums">{yok ? "—" : fmtMoney(s!.sales_value ?? 0)}</td>
                <td className="text-right mono text-xs tabular-nums">{yok ? "—" : fmtInt(s!.sales_qty)}</td>
                <td className="text-right mono text-xs tabular-nums">{yok ? "—" : fmtInt(s!.stock_qty)}</td>
                <td className="text-right mono text-xs tabular-nums">{yok ? "—" : fmtInt(s!.sku_count)}</td>
                {/* DURUM ÖNCE `yok`'u OKUR. gecikmeHaftasi negatif farkı 0'a kırpıyor
                    (compute.ts), yani seçili haftada satırı OLMAYAN ama son raporu o
                    haftadan SONRA olan firmada hf=0 çıkıyordu: hücreler "—" iken durum
                    yeşil "güncel" yazıyordu — satırın kendisiyle çelişen tek hücre. */}
                <td className="mono text-[11px]">
                  {yok ? <span style={{ color: "#f8b00b" }}>bu haftayı göndermemiş</span>
                    : hf >= 99 ? <span className="text-txt-dim">veri yok</span>
                    : hf >= 1 ? <span style={{ color: "#f8b00b" }}>{hf} hf geride</span>
                    : <span className="text-neon">güncel</span>}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {guncelHafta && (
        <p className="mono text-[11px] text-txt-dim mt-2">
          Gecikme, SEÇİLİ haftaya göre: firmanın son rapor haftası ile bu tablonun haftası
          arasındaki fark. Takvime göre güncellik için yukarıdaki KANALLAR şeridine bak
          (ağın en yeni haftası: {fmtDate(guncelHafta)}).
        </p>
      )}
    </div>
  );
}

function VeriGuveni({ health }: { health: any }) {
  if (!health) return <div className="mono text-xs text-txt-dim">Veri sağlığı okunamadı.</div>;
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-baseline gap-x-2">
        <span className="mono text-[11px] text-txt-dim tracking-wider">VERİ SAĞLIĞI</span>
        <span className="mono text-sm tabular-nums">{health.score}/100</span>
      </div>
      <div className="space-y-1">
        {(health.issues ?? []).map((i: any) => (
          <div key={i.id} className="flex flex-wrap items-baseline gap-x-2">
            <span className="mono text-[11px]"
              style={{ color: i.severity === "high" ? "#ff5555" : i.severity === "med" ? "#f8b00b" : "#7d927d" }}>
              {i.label}
            </span>
            <span className="mono text-[11px] tabular-nums text-txt-dim">{fmtInt(i.count)}</span>
            {i.hint && <span className="mono text-[11px] text-txt-dim">{i.hint}</span>}
          </div>
        ))}
      </div>
    </div>
  );
}

// ═══════════════════════ DURUMLAR ═══════════════════════
function Iskelet() {
  return (
    <div className="space-y-4 -mt-2">
      <div className="h-7 w-48 card card-flat" />
      <div className="card card-flat h-32" />
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        {[...Array(4)].map((_, i) => <div key={i} className="card card-flat h-20" />)}
      </div>
      <div className="card card-flat h-40" />
    </div>
  );
}
function HataKutusu({ msg }: { msg: string }) {
  return (
    <div className="card p-6 border-red-500/40">
      <div className="text-red-400 mono text-sm">Hata: {msg}</div>
      <div className="text-txt-dim text-sm mt-2">Supabase bağlantısını ve .env değerlerini kontrol et.</div>
    </div>
  );
}
function Bos() {
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
