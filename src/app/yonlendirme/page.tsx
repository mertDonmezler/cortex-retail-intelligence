"use client";

import { Suspense, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import { fmtInt, fmtMoney, fmtDate, colorOf, fmtHafta } from "@/lib/format";
import { fetchJson } from "@/lib/fetchJson";
import {
  SortableTh,
  SearchBox,
  MultiChips,
  RangeMin,
  useSort,
  CsvBtn,
} from "@/components/Controls";
import { Info } from "@/components/Info";
import { bekleme } from "@/lib/hareket";
import { kanalAdi } from "@/lib/kanal";
import { useAsistanBaglami } from "@/lib/asistan-baglam";
import {
  siparisKontrol,
  tabloMetni,
  HUKUM_AD,
  type Hukum,
  type MotorSatiri,
} from "@/lib/siparis-kontrol";

type Target = { retailer: string; qty: number; vel: number } | null;
type Route = {
  action:
    | "LIKIDASYON"
    | "TRANSFER"
    | "DEPO"
    | "SEVK"
    | "TEYİT"
    | "İZLE"
    | "ERIT"
    | "ASKIDA"
    | "DAĞIT";
  stale?: boolean;
  last_seen?: string | null;
  retailer: string;
  sku_name: string;
  barkod: string;
  season: string;
  abc: string;
  xyz: string;
  stock: number;
  velocity: number;
  coverage: number | null;
  target: number;
  psf: number;
  qty: number;
  dest?: Target;
  toDepot: number;
  value: number;
  reason: string;
  noPrice?: boolean;
  // ── VERİ YAŞI VE KAPI ALANLARI ──
  // `stock` RAPORLANAN değerdir ve öyle kalır (tabloda ve CSV'de birincil).
  // `stokYaslandirilmis` tahmindir; ekranda ikincil, soluk ve etiketli durur.
  dataWeek?: string | null;
  gecikmeHf?: number;
  drenaj?: number;
  stokYaslandirilmis?: number;
  qtyHam?: number;
  valueHam?: number;
  sevkUst?: number;
  askidaFiil?: string | null;
  kapi?: "tam" | "kismi" | "erit" | null;
  geriBirakilan?: number;
  eritRaf?: number;
  eritNet?: number;
  // ── RAF VARLIĞI VE ETKİ (2026-10-29) ──
  talep?: number;
  magaza?: number | null;
  rafEsik?: number;
  rafMagazaBasi?: number | null;
  rafPayi?: number | null;
  etki8?: number;
  kayipHf?: number;
  sonTarih?: string | null;
  eritTur?: "eski" | "fazla";
  // ÖZ-DENETİM: kararın dayandığı veri şüpheliyse motorun işaretleri (routing).
  uyari?: string[];
  transferGelen?: number;
  [k: string]: unknown;
};

// BU HAFTA maddesi (summary.buHafta) — motor sıralayıp birleştirip gönderiyor.
type Is = {
  sira: number;
  fiil: "GÖNDER" | "AKTAR";
  retailer: string;
  kaynak: string | null;
  sku_name: string;
  barkod: string;
  qty: number;
  aktarAdet?: number;
  etki8: number;
  kayipHf: number | null;
  sonTarih: string | null;
  buHaftaMi: boolean;
  rafMagazaBasi: number | null;
  rafPayi: number | null;
  coverage: number | null;
  depoNotu: boolean;
  uyari?: string[];
  gerekce: string;
};
type Siparis = {
  retailer: string;
  n: number;
  qty: number;
  etki8: number;
  satirlar: {
    sku_name: string;
    barkod: string;
    qty: number;
    etki8: number;
    sonTarih: string | null;
  }[];
};

const ACT: Record<string, { label: string; c: string }> = {
  LIKIDASYON: { label: "LİKİDE ET", c: "#ff5555" },
  TRANSFER: { label: "ÇEK → VER", c: "#0bd1f8" },
  DEPO: { label: "ÇEK → DEPO", c: "#f8b00b" },
  SEVK: { label: "SEVK ET", c: "#1FF80B" },
  // TEYİT: firmanın güncel raporunda görünmeyen stok. Karar üretilmez, çünkü
  // stoğun gerçekten orada olduğu belirsiz — önce firmaya teyit ettirilir.
  TEYİT: { label: "STOK TEYİDİ", c: "#c084fc" },
  İZLE: { label: "İZLE", c: "#7d927d" },
  // ERİT: eski sezon etiketi taşıyor ama hâlâ satıyor (kanıt kapısı). Karar
  // "indirim yok, satarak erit" — bu yüzden adet 0 ve sermaye serbest kalmaz.
  // 2026-10-29'dan beri güncel üründe de: hedefin üstü ama 26 hf içinde satarak eriyor.
  ERIT: { label: "SATARAK ERİT (çekme, sevk yok)", c: "#7d927d" },
  // ASKIDA: firmanın verisi geri alınamaz karar için fazla eski. Satır listeden
  // SİLİNMEZ, çünkü sessizlik "sorun yok" diye okunur.
  ASKIDA: { label: "ASKIDA — önce rapor", c: "#f8b00b" },
  // DAĞIT: D&R'ın aynı haftaki deposu ihtiyacı karşılıyor — sevk değil, D&R
  // kendi deposundan mağazalara dağıtsın (routing depoOf, supabase/kanal-depo.sql).
  DAĞIT: { label: "DAĞIT (D&R deposundan)", c: "#0bd1f8" },
};
const SEASON_C: Record<string, string> = {
  ESKİ: "#ff5555",
  "25/26": "#1FF80B",
  TREND: "#0bd1f8",
  DİĞER: "#7d927d",
};
// Sipariş kontrolü hükümleri — renkler ACT paletinden (yeni hex yok).
const HUKUM_RENK: Record<Hukum, string> = {
  MANTIKLI: "#1FF80B",
  AZ: "#0bd1f8",
  FAZLA: "#f8b00b",
  COK_FAZLA: "#ff5555",
  ESKI_SEZON: "#c084fc",
  SATIS_YOK: "#7d927d",
  BULUNAMADI: "#7d927d",
};
const MODES = [
  { id: "koruma", label: "Korumacı" },
  { id: "denge", label: "Dengeli" },
  { id: "agresif", label: "Agresif" },
];

// ─── Derin bağlantı (?a= ve ?mode=) ──────────────────────────────────────────
// Ana sayfanın "tümü →" linkleri bu sayfaya filtre AÇIK gelir. Değerleri elle
// yazılmış bir URL'den de okuyabilmemiz gerekiyor, çünkü ACT anahtarları Türkçe
// karakterli (TEYİT, İZLE): encodeURIComponent bunları %C4%B0 diye taşıyor
// (useSearchParams zaten çözüyor), ama insan eli "TEYIT"/"teyit" yazabiliyor,
// bazı kaynaklar da "İ"yi NFD ile "I + birleşen nokta" olarak gönderiyor.
// Bu yüzden değeri karşılaştırmadan önce katlıyoruz.
function foldKey(s: string): string {
  return s
    .trim()
    .normalize("NFKD") // "İ" → "I" + birleşen nokta (U+0307)
    .toUpperCase() // noktasız "ı" da bu adımda "I" oluyor
    .replace(/[^A-Z0-9]/g, ""); // birleşen işaretler ve ayraçlar düşer
}

// SANAL "cek" KOVASI. Ana sayfanın "ÇEK — para rafta bağlı" grubu üç aksiyonu
// birlikte sayıyor (DEPO + TRANSFER + LIKIDASYON = 576 kalem). Bu kovanın
// karşılığı olan tek bir filtre YOKTU: ?a=DEPO 327, ?a=LIKIDASYON 239 veriyor,
// ?a=all ise 615 (üstüne SEVK/TEYİT/İZLE biniyor). Yani ana sayfada "576 kalem"
// okuyan kişi hangi linke basarsa bassın başka bir sayı görüyordu — tam olarak
// bu sistemde kapatmaya çalıştığımız "aynı metrik, farklı ekran" hatası.
const CEK_ACTIONS = ["DEPO", "TRANSFER", "LIKIDASYON"];

// Kabul edilen ?a= değerleri: all + cek (sanal) + ACT anahtarlarının hepsi.
const ACTION_BY_URL: Record<string, string> = Object.fromEntries(
  ["all", "cek", "uyarili", ...Object.keys(ACT)].map((k) => [foldKey(k), k]),
);

// Bilinmeyen değer SESSİZCE "all"a düşer — bozuk bir bağlantı yüzünden
// yöneticiye hata ekranı göstermek, filtresiz tam listeden daha kötü.
function readAction(raw: string | null): string {
  if (!raw) return "all";
  return ACTION_BY_URL[foldKey(raw)] ?? "all";
}

// Kabul edilen ?mode= değerleri: koruma | denge | agresif; aksi → "denge".
// Mod, ana sayfanın hangi senaryonun sayılarını gösterdiğini taşır: MODE_MULT
// hedef kapsamı çarptığı için kalem sayıları modla birlikte değişiyor. Yanlış
// modda açmak, ana sayfada okunan "çek: N kalem"i sessizce başka bir N yapar.
function readMode(raw: string | null): string {
  const v = (raw ?? "").trim().toLowerCase();
  return MODES.some((m) => m.id === v) ? v : "denge";
}

// useSearchParams() bir Suspense sınırı gerektiriyor: sarmalayıcı olmadan
// Next 14 prerender'ı "useSearchParams() should be wrapped in a suspense
// boundary" ile build'i kırıyor (aynı kalıp src/app/giris/page.tsx'te var).
export default function YonlendirmePage() {
  return (
    <Suspense fallback={null}>
      <YonlendirmeInner />
    </Suspense>
  );
}

function YonlendirmeInner() {
  const params = useSearchParams();
  // Lazy initializer: parametreler YALNIZ ilk yüklemede okunur. Böylece
  // kullanıcının sayfa içinde yaptığı filtre/mod seçimi ezilmiyor.
  const [mode, setMode] = useState(() => readMode(params.get("mode")));
  const [data, setData] = useState<any>(null);
  // Ekrandaki verinin HANGİ MODA ait olduğu. Motor ~4 sn hesaplarken tutarlar
  // önceki senaryonun; damga farklıysa soluk basılır (render'da türetilir).
  const [veriModu, setVeriModu] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [action, setAction] = useState<string>(() =>
    readAction(params.get("a")),
  );
  const [firms, setFirms] = useState<string[]>([]);
  const [q, setQ] = useState("");
  const [minVal, setMinVal] = useState(0);

  // Asistan: ekrandaki mod ve filtre (analistin aracı motoru "denge" modunda okur).
  useAsistanBaglami({
    mod: MODES.find((m) => m.id === mode)?.label ?? mode,
    aksiyon:
      action === "all"
        ? "hepsi"
        : action === "cek"
          ? "çek (depo+transfer+likidasyon)"
          : (ACT[action]?.label ?? action),
    ...(firms.length ? { firmalar: firms.map(kanalAdi).join(", ") } : {}),
    ...(q.trim() ? { arama: q.trim() } : {}),
  });

  useEffect(() => {
    // Hızlı mod değişiminde son seçilen mod kazanır; geç dönen eski yanıt yok sayılır.
    let iptal = false;
    const m = mode;
    setLoading(true);
    fetchJson(`/api/routing?mode=${m}`)
      .then((d) => {
        if (iptal) return;
        setData(d);
        setVeriModu(m);
        setErr(null);
      })
      .catch((e) => {
        if (iptal) return;
        setErr(e.message);
        setData(null);
        setVeriModu(null);
      })
      .finally(() => {
        if (!iptal) setLoading(false);
      });
    return () => {
      iptal = true;
    };
  }, [mode]);
  const bekliyor = data != null && veriModu !== mode;

  const routes: Route[] = data?.routes ?? [];
  const sm = data?.summary;
  const firmOpts = useMemo(
    () =>
      [...new Set(routes.map((r) => r.retailer))].sort((a, b) =>
        a.localeCompare(b, "tr"),
      ),
    [routes],
  );

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return routes.filter((r) => {
      if (action === "cek") {
        if (!CEK_ACTIONS.includes(r.action)) return false;
      } else if (action === "uyarili") {
        // Öz-denetimin işaretlediği satırlar (sanal kova, ACT'ta yok).
        if (!r.uyari?.length) return false;
      } else if (action !== "all" && r.action !== action) return false;
      if (firms.length && !firms.includes(r.retailer)) return false;
      if (minVal > 0 && (r.value || 0) < minVal) return false;
      if (
        needle &&
        !`${r.sku_name} ${r.barkod} ${r.dest?.retailer ?? ""}`
          .toLowerCase()
          .includes(needle)
      )
        return false;
      return true;
    });
  }, [routes, action, firms, minVal, q]);

  const { sorted, sortKey, dir, toggle } = useSort<Route>(
    filtered,
    "value",
    "desc",
  );
  const shownVal = useMemo(
    () => sorted.reduce((s, r) => s + (r.value || 0), 0),
    [sorted],
  );

  // "SERBEST KALACAK SERMAYE" MANŞETİ KALDIRILDI (2026-10-29). Konsinyede malı
  // depoya çekmek nakit yaratmıyor; ölçüldü: o manşetin arkasındaki çek
  // önerileri uygulansaydı ince raf yüzünden haftada ~137 bin TL net satış
  // kaybedilecekti. Sayfanın başında artık yapılacak işler duruyor.
  const buHafta: Is[] = sm?.buHafta ?? [];
  const siparis: Siparis[] = sm?.siparisOnerisi ?? [];
  const sevkYapma: {
    retailer: string;
    satirlar: {
      sku_name: string;
      barkod: string;
      stock: number;
      coverage: number | null;
    }[];
  }[] = sm?.sevkYapma ?? [];
  const [kopyalanan, setKopyalanan] = useState<string | null>(null);
  const kopyala = (s: Siparis) => {
    const metin = [
      `${kanalAdi(s.retailer)} — sipariş önerisi (${fmtInt(s.qty)} adet)`,
      ...s.satirlar.map(
        (l) =>
          `${l.sku_name}${l.barkod ? ` (${l.barkod})` : ""}: ${fmtInt(l.qty)} adet`,
      ),
    ].join("\n");
    navigator.clipboard
      ?.writeText(metin)
      .then(() => setKopyalanan(s.retailer))
      .catch(() => setKopyalanan(null));
  };

  // ── SİPARİŞ KONTROLÜ (lib/siparis-kontrol.ts) ──
  // Kanaldan gelen sipariş, ekrandaki motor satırlarıyla (seçili senaryo) satır
  // satır kıyaslanır; ek istek yok. Senaryo/veri değişince sonuç silinir, yoksa
  // eski senaryonun hükmü yeni senaryonun ekranında kalırdı.
  const [skFirma, setSkFirma] = useState("DR");
  const [skMetin, setSkMetin] = useState("");
  const [skSonuc, setSkSonuc] = useState<ReturnType<
    typeof siparisKontrol
  > | null>(null);
  const [skDosya, setSkDosya] = useState<string | null>(null);
  const skCalistir = (metin: string) =>
    setSkSonuc(
      siparisKontrol(
        metin,
        skFirma,
        // Kanalın TÜM ürünleri (aksiyonsuzlar dahil); eski yanıtta yoksa routes.
        (data?.urunler ?? routes) as unknown as MotorSatiri[],
        sm?.raf?.ufukHf ?? 26,
      ),
    );
  // EXCEL DOSYASI: D&R siparişi SAP'tan .xlsx geliyor. Hücreler HAM değerle okunur
  // (biçimli metinde EAN "8.68482E+12" görünüp kayboluyordu; bkz. tabloMetni).
  // SheetJS yalnız dosya seçilince yüklenir — sayfa açılışını ağırlaştırmaz.
  const dosyaOku = async (f: File) => {
    try {
      const XLSX = await import("xlsx");
      const wb = XLSX.read(await f.arrayBuffer(), { type: "array" });
      const rows = XLSX.utils.sheet_to_json<unknown[]>(
        wb.Sheets[wb.SheetNames[0]],
        {
          header: 1,
          raw: true,
          defval: "",
        },
      );
      const metin = tabloMetni(rows);
      setSkMetin(metin);
      setSkDosya(f.name);
      skCalistir(metin);
    } catch {
      setSkDosya(`${f.name} okunamadı`);
    }
  };
  useEffect(() => setSkSonuc(null), [data, skFirma]);
  const skCsv = useMemo(
    () =>
      (skSonuc?.sonuclar ?? []).map((x) => ({
        siparis_satiri: x.satir.ad || x.satir.barkod || "",
        eslesen_urun: x.motor?.sku_name ?? "",
        barkod: x.motor?.barkod ?? x.satir.barkod ?? "",
        siparis_adet: x.satir.adet,
        oneri_adet: x.oneri ?? "",
        hukum: HUKUM_AD[x.hukum],
        gerekce: x.gerekce,
      })),
    [skSonuc],
  );
  const skCols = [
    { key: "siparis_satiri" as const, label: "Sipariş satırı" },
    { key: "eslesen_urun" as const, label: "CORTEX ürünü" },
    { key: "barkod" as const, label: "Barkod" },
    { key: "siparis_adet" as const, label: "Sipariş" },
    { key: "oneri_adet" as const, label: "Öneri" },
    { key: "hukum" as const, label: "Hüküm" },
    { key: "gerekce" as const, label: "Gerekçe" },
  ];

  // CSV — `stok` KOLONU RAPORLANAN DEĞERİ TAŞIMAYA DEVAM EDER.
  // Dışa aktarılan belge tedarikçiyle konuşulurken açılıyor; hiçbir tedarikçi
  // raporunda bulunmayan bir sayı "Stok" başlığıyla çıkmamalı. Tahmin ayrı
  // kolonda ve adı açıkça "Tahmini stok".
  const csvRows = useMemo(
    () =>
      sorted.map((r) => ({
        aksiyon: ACT[r.action]?.label ?? r.action,
        firma: r.retailer,
        urun: r.sku_name,
        barkod: r.barkod,
        segment: `${r.abc}${r.xyz}`,
        sezon: r.season,
        veri_haftasi: r.dataWeek ?? "",
        gecikme_hf: r.gecikmeHf ?? "",
        stok: r.stock,
        tahmini_stok: r.drenaj ? (r.stokYaslandirilmis ?? "") : "",
        dusulen_adet: r.drenaj ?? 0,
        hiz_hf: r.velocity,
        kapsam_hf: r.coverage ?? "",
        hedef_hf: r.target,
        raporlanan_cek: r.qtyHam ?? r.qty,
        cek_sevk: r.qty,
        sevk_ust_sinir: r.sevkUst ?? "",
        hedef: r.dest
          ? `${r.dest.retailer} (${r.dest.qty})`
          : r.action === "DEPO"
            ? "DEPO"
            : r.action === "LIKIDASYON"
              ? "LİKİDE"
              : "",
        depoya: r.toDepot,
        psf_deger: r.value,
        psf_deger_ham: r.valueHam ?? r.value,
        kapi: r.kapi ?? "",
        askida_fiil: r.askidaFiil ?? "",
        sebep: r.reason,
        raf_magaza_basi: r.rafMagazaBasi ?? "",
        magaza: r.magaza ?? "",
        etki_8hf_net: r.etki8 ?? "",
        son_tarih: r.sonTarih ?? "",
        uyari: (r.uyari ?? []).join(" | "),
      })),
    [sorted],
  );
  const csvCols = [
    { key: "aksiyon" as const, label: "Aksiyon" },
    { key: "firma" as const, label: "Firma" },
    { key: "urun" as const, label: "Ürün" },
    { key: "barkod" as const, label: "Barkod" },
    { key: "segment" as const, label: "Segment(ABC-XYZ)" },
    { key: "sezon" as const, label: "Sezon" },
    { key: "veri_haftasi" as const, label: "Veri haftası" },
    { key: "gecikme_hf" as const, label: "Gecikme(hf)" },
    { key: "stok" as const, label: "Stok (raporlanan)" },
    { key: "tahmini_stok" as const, label: "Tahmini stok" },
    { key: "dusulen_adet" as const, label: "Düşülen adet" },
    { key: "hiz_hf" as const, label: "Hız/hf" },
    { key: "kapsam_hf" as const, label: "Kapsam(hf)" },
    { key: "hedef_hf" as const, label: "Hedef(hf)" },
    { key: "raporlanan_cek" as const, label: "Çek (raporlanan)" },
    { key: "cek_sevk" as const, label: "Çek/Sevk (düzeltilmiş)" },
    { key: "sevk_ust_sinir" as const, label: "Sevk üst sınır" },
    { key: "hedef" as const, label: "Nereye" },
    { key: "depoya" as const, label: "Depoya" },
    { key: "psf_deger" as const, label: "PSF Değeri" },
    { key: "psf_deger_ham" as const, label: "PSF Değeri (kırpma öncesi)" },
    { key: "kapi" as const, label: "Kanıt kapısı" },
    { key: "askida_fiil" as const, label: "Askıdaki fiil" },
    { key: "sebep" as const, label: "Sebep" },
    {
      key: "raf_magaza_basi" as const,
      label: "Raf (taşıyan mağaza başı adet)",
    },
    { key: "magaza" as const, label: "Taşıması gereken mağaza" },
    { key: "etki_8hf_net" as const, label: "Etki 8 hf (NET TL)" },
    { key: "son_tarih" as const, label: "Son tarih" },
    { key: "uyari" as const, label: "Öz-denetim uyarısı" },
  ];

  // NOT: bu üç kartın tutarı BRÜT PSF (API öyle döndürüyor) → alt satırda açıkça
  // "brüt PSF" yazıyor, aksi halde net kazançla karıştırılıyor.
  // TEYİT KARTI: `sm?.teyit` nesnesi HER ZAMAN truthy olduğu için kart, kova
  // boşaldıktan sonra sonsuza kadar "₺0 · 0 kalem" gösteriyordu — bu projenin
  // kendi kuralına aykırı ("0 kalem yazmak bir karar sayfasının en yanıltıcı boş
  // durumudur"). Kova boşsa kart, o kalemlerin NEREYE gittiğini söylüyor.
  const kapaliBilgi = sm?.veri?.kapali;
  const teyitBos = (sm?.teyit?.n ?? 0) === 0;
  const cards = [
    {
      id: "ASKIDA",
      label: "ASKIDA (veri eski)",
      val: sm?.veri?.askida ? fmtMoney(sm.veri.askida.psf) : "",
      sub: sm?.veri?.askida
        ? `${sm.veri.askida.n} kalem · ${fmtInt(sm.veri.askida.qty)} adet`
        : "",
      c: "#f8b00b",
    },
    {
      id: "LIKIDASYON",
      label: "LİKİDE ET (eski sezon)",
      val: sm ? fmtMoney(sm.likidasyon.psf) : "",
      sub: sm ? `${sm.likidasyon.n} kalem · brüt PSF` : "",
      c: "#ff5555",
    },
    {
      id: "ERIT",
      label: "SATARAK ERİT (çekme, sevk yok)",
      val: sm?.erit ? fmtMoney(sm.erit.rafPsf) : "",
      sub: sm?.erit
        ? `${sm.erit.n} kalem · haftalık ${fmtMoney(sm.erit.haftalikNet)} net akış`
        : "",
      c: "#7d927d",
    },
    {
      id: "TRANSFER",
      label: "ÇEK → VER (transfer)",
      val: sm ? fmtMoney(sm.transfer.psf) : "",
      sub: sm ? `${sm.transfer.n} kalem · brüt PSF` : "",
      c: "#0bd1f8",
    },
    {
      id: "DEPO",
      label: "ÇEK → DEPO (ölü/fazla)",
      val: sm ? fmtMoney(sm.depo.psf) : "",
      sub: sm ? `${sm.depo.n} kalem · brüt PSF` : "",
      c: "#f8b00b",
    },
    {
      id: "SEVK",
      label: "SEVK ET (hedef altı)",
      val: sm ? `${sm.sevk.n}` : "",
      sub: sm?.veri?.sevkUst
        ? `ürün · üst sınır ${fmtInt(sm.veri.sevkUst.qty)} ad`
        : "ürün",
      c: "#1FF80B",
    },
    {
      id: "TEYİT",
      label: teyitBos
        ? "STOK TEYİDİ (bekleyen yok)"
        : "STOK TEYİDİ (raporda yok)",
      val: teyitBos
        ? kapaliBilgi
          ? `${kapaliBilgi.atlanan} kapalı`
          : "0"
        : fmtMoney(sm.teyit.psf),
      sub: teyitBos
        ? kapaliBilgi
          ? `tasfiye edildi · ${fmtInt(kapaliBilgi.stok)} adet karar üretmiyor`
          : "bekleyen teyit yok"
        : `${sm.teyit.n} kalem · ${fmtInt(sm.teyit.qty)} adet · brüt PSF`,
      c: "#c084fc",
    },
    {
      id: "İZLE",
      label: "İZLE (yeni / hedefe indi / talep düştü)",
      val: sm ? `${sm.izle.n}` : "",
      sub: "ürün",
      c: "#7d927d",
    },
  ];

  return (
    <div className="space-y-6">
      <div className="flex items-end justify-between flex-wrap gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">
            Stok <span className="neon-text">Yönlendirme</span>
          </h1>
          <p className="text-txt-dim mono text-sm mt-1">
            Raf varlığı + segment kapsamı · önce bu haftanın işleri, sonra kanal
            başına sipariş, en altta tam liste
            {" · "}
            <span className="text-txt-dim/80">
              etkiler NET, kalem tutarları brüt PSF
            </span>
          </p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <span className="mono text-xs text-txt-dim">Agresiflik:</span>
          {MODES.map((m) => (
            <button
              key={m.id}
              onClick={() => setMode(m.id)}
              title={
                m.id === "koruma"
                  ? "Hedef kapsam ×1.3 (az çek)"
                  : m.id === "agresif"
                    ? "Hedef kapsam ×0.7 (çok çek)"
                    : "Hedef kapsam ×1.0"
              }
              className={`mono text-xs px-3 py-1.5 rounded ${mode === m.id ? "bg-neon/15 text-neon" : "text-txt-dim hover:text-txt border border-line"}`}
            >
              {m.label}
            </button>
          ))}
        </div>
      </div>

      {err && (
        <div className="card p-4 border-red-500/40 text-red-400 mono text-sm">
          Veri alınamadı: {err}
        </div>
      )}

      {sm && (
        <div
          className="card p-4 border-l-4 cx-soluk"
          {...bekleme(bekliyor)}
          style={{ borderLeftColor: "#1FF80B" }}
        >
          <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
            <h2
              className="mono text-xs tracking-wider"
              style={{ color: "#1FF80B" }}
            >
              BU HAFTA YAPILACAKLAR
            </h2>
            <div className="flex flex-wrap items-baseline gap-x-2 mono text-[11px] text-txt-dim">
              <span>{sm.modeLabel}</span>
              {buHafta.length > 0 && <span>· 8 haftada</span>}
              {buHafta.length > 0 && (
                <span className="tabular-nums" style={{ color: "#1FF80B" }}>
                  ~{fmtMoney(sm.raf?.buHaftaEtki8 ?? 0)}
                </span>
              )}
              {buHafta.length > 0 && <span>net satış</span>}
            </div>
          </div>
          {buHafta.length === 0 ? (
            <div className="mono text-sm text-txt-dim mt-2">
              Son tarihi bu hafta ya da gelecek hafta olan iş yok — kanal başına
              sipariş önerisi aşağıda.
            </div>
          ) : (
            <ol className="mt-3 space-y-2.5">
              {buHafta.map((b) => {
                const fiilRenk = b.fiil === "GÖNDER" ? "#1FF80B" : "#0bd1f8"; // AKTAR ve DAĞIT camgöbeği
                const hemen =
                  b.sonTarih != null &&
                  sm?.veri?.asOf != null &&
                  b.sonTarih <= sm.veri.asOf;
                return (
                  <li key={b.sira} className="flex gap-3 min-w-0">
                    <span className="mono text-sm text-txt-dim tabular-nums w-5 shrink-0 text-right">
                      {b.sira}.
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                        <span
                          className="mono text-xs font-bold px-1.5 py-0.5 rounded"
                          style={{
                            color: fiilRenk,
                            background: fiilRenk + "1a",
                          }}
                        >
                          {b.fiil}
                        </span>
                        <span
                          className="mono text-sm"
                          style={{ color: colorOf(b.retailer) }}
                        >
                          {kanalAdi(b.retailer)}
                        </span>
                        <span className="mono text-sm font-bold tabular-nums">
                          {fmtInt(b.qty)} adet
                        </span>
                        <span className="text-sm min-w-0 truncate">
                          {b.sku_name}
                        </span>
                      </div>
                      <div className="flex flex-wrap items-baseline gap-x-2 mono text-[11px] text-txt-dim mt-0.5">
                        <span>{b.gerekce}</span>
                        {(b.uyari?.length ?? 0) > 0 && (
                          <span
                            style={{ color: "#f8b00b" }}
                            title={b.uyari!.join("\n")}
                          >
                            · ⚠ {b.uyari![0].split(" — ")[0]}
                          </span>
                        )}
                        <span>·</span>
                        <span style={{ color: hemen ? "#ff5555" : "#f8b00b" }}>
                          {hemen ? "hemen" : `en geç ${fmtDate(b.sonTarih!)}`}
                        </span>
                        <span>·</span>
                        <span className="tabular-nums">
                          8 hf'de ~{fmtMoney(b.etki8)} net
                        </span>
                      </div>
                    </div>
                  </li>
                );
              })}
            </ol>
          )}
          <div className="mono text-[10px] text-txt-dim mt-3 border-t border-line/60 pt-2 space-y-0.5">
            {/* D&R notu bir kez: her D&R maddesinin altında tekrarlanınca okunmuyordu. */}
            {buHafta.some((b) => b.depoNotu) && (
              <div>
                D&amp;R maddeleri: D&amp;R deposu bu hafta için CORTEX&apos;te
                yok — depoda mal varsa önce mağazalara dağıtılması yeter, sevk
                gerekmez.
              </div>
            )}
            {sm.kanalDepo?.haftasi && (
              <div>
                D&amp;R deposu {fmtDate(sm.kanalDepo.haftasi)} haftasının raporundan
                ({fmtInt(sm.kanalDepo.kalem)} ürün): ihtiyacın depoda olan kısmı
                &quot;DAĞIT&quot;, kalanı sevk.
              </div>
            )}
            {(sm.denetim?.uyarili ?? 0) > 0 && (
              <div>
                Öz-denetim: {fmtInt(sm.denetim.uyarili)}/
                {fmtInt(sm.denetim.satir)} kararda veri uyarısı (
                {Object.entries(sm.denetim.turler as Record<string, number>)
                  .map(([t, n]) => `${t} ${n}`)
                  .join(", ")}
                ) — tabloda ⚠ ile işaretli; &quot;Uyarılı&quot; süzgeciyle
                listelenir.
              </div>
            )}
            <div>
              Sıra: önce son tarihi bu hafta olanlar, sonra 8 haftalık net etki.
              Raf eşiği: ürünü taşıması gereken mağaza başına{" "}
              {sm.raf?.asgari ?? 4} adet (ölçüm: bu eşiğin altında satış hızla
              düşüyor). Mağaza sayısı yalnız D&amp;R ve Armağan için biliniyor;
              diğer kanallarda hafta kapsamı kullanılıyor.
            </div>
          </div>
        </div>
      )}

      {siparis.length > 0 && (
        <div className="card p-4 cx-soluk" {...bekleme(bekliyor)}>
          <div className="mono text-[10px] tracking-wider text-txt-dim mb-2">
            KANAL BAŞINA SİPARİŞ ÖNERİSİ · alıcıya gidecek liste
          </div>
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            {siparis.map((s) => (
              <div key={s.retailer} className="min-w-0">
                <div className="flex flex-wrap items-baseline gap-x-2 mb-1">
                  <span
                    className="mono text-sm"
                    style={{ color: colorOf(s.retailer) }}
                  >
                    {kanalAdi(s.retailer)}
                  </span>
                  <span className="mono text-[11px] text-txt-dim tabular-nums">
                    {fmtInt(s.n)} kalem · {fmtInt(s.qty)} adet
                  </span>
                  {s.etki8 > 0 && (
                    <span className="mono text-[11px] text-txt-dim tabular-nums">
                      · 8 hf'de ~{fmtMoney(s.etki8)} net
                    </span>
                  )}
                  <button
                    onClick={() => kopyala(s)}
                    className="mono text-[11px] px-2 py-0.5 rounded border border-line text-txt-dim hover:text-txt"
                  >
                    {kopyalanan === s.retailer ? "kopyalandı" : "kopyala"}
                  </button>
                </div>
                <table className="w-full">
                  <tbody>
                    {s.satirlar.map((l, i) => (
                      <tr key={i} className="border-b border-line/40">
                        <td
                          className="text-sm max-w-[260px] truncate"
                          title={
                            l.barkod
                              ? `${l.barkod} · ${l.sku_name}`
                              : l.sku_name
                          }
                        >
                          {l.sku_name}
                        </td>
                        <td className="mono text-right font-bold tabular-nums">
                          {fmtInt(l.qty)}
                        </td>
                        <td className="mono text-right text-[11px] text-txt-dim tabular-nums">
                          {l.etki8 > 0 ? fmtMoney(l.etki8) : "—"}
                        </td>
                        <td className="mono text-right text-[11px] text-txt-dim whitespace-nowrap">
                          {l.sonTarih ? fmtDate(l.sonTarih) : ""}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ))}
          </div>
          {sevkYapma.length > 0 && (
            <details className="mt-3 border-t border-line/60 pt-2">
              <summary className="mono text-[11px] text-txt-dim cursor-pointer">
                Sipariş gelirse azaltılacaklar — {sm.raf?.ufukHf ?? 26} haftadan
                fazla stoğu olan satan ürünler
              </summary>
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 mt-2">
                {sevkYapma.map((k) => (
                  <div key={k.retailer} className="min-w-0">
                    <div
                      className="mono text-[11px] mb-1"
                      style={{ color: colorOf(k.retailer) }}
                    >
                      {kanalAdi(k.retailer)}
                    </div>
                    {k.satirlar.map((l, i) => (
                      <div
                        key={i}
                        className="flex items-baseline gap-2 text-sm min-w-0"
                      >
                        <span className="truncate min-w-0 flex-1">
                          {l.sku_name}
                        </span>
                        <span className="mono text-[11px] text-txt-dim tabular-nums shrink-0">
                          {fmtInt(l.stock)} stok
                        </span>
                        <span
                          className="mono text-[11px] tabular-nums shrink-0"
                          style={{ color: "#ff5555" }}
                        >
                          {l.coverage} hf
                        </span>
                      </div>
                    ))}
                  </div>
                ))}
              </div>
            </details>
          )}
        </div>
      )}

      {/* ── SİPARİŞ KONTROLÜ ── */}
      {sm && (
        <div className="card p-4 cx-soluk" {...bekleme(bekliyor)}>
          <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 mb-2">
            <div className="mono text-[10px] tracking-wider text-txt-dim">
              SİPARİŞ KONTROLÜ · gelen siparişi yapıştır, motor satır satır
              değerlendirsin
            </div>
            <span className="mono text-[11px] text-txt-dim">
              {sm.modeLabel}
            </span>
          </div>
          <div className="flex flex-wrap gap-1 mb-2">
            {firmOpts.map((f) => (
              <button
                key={f}
                onClick={() => setSkFirma(f)}
                className={`mono text-xs px-3 py-1 rounded ${skFirma === f ? "bg-neon/15 text-neon" : "text-txt-dim hover:text-txt border border-line"}`}
              >
                {kanalAdi(f)}
              </button>
            ))}
          </div>
          <textarea
            value={skMetin}
            onChange={(e) => setSkMetin(e.target.value)}
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => {
              const f = e.dataTransfer.files?.[0];
              if (f) {
                e.preventDefault();
                dosyaOku(f);
              }
            }}
            rows={5}
            placeholder={
              "Sipariş Excel dosyasını buraya sürükle ya da aşağıdan seç; veya tabloyu kopyalayıp yapıştır (başlık satırıyla), ya da her satıra:\n8685185015531 Toz Pembe 218\nMythos Manifest Hileli Kartları 200"
            }
            className="w-full bg-ink-2 border border-line rounded p-2 mono text-xs text-txt"
          />
          <div className="flex flex-wrap items-center gap-2 mt-1">
            <label className="mono text-[11px] px-2 py-0.5 rounded border border-line text-txt-dim hover:text-txt cursor-pointer">
              Excel dosyası seç
              <input
                type="file"
                accept=".xlsx,.xls,.csv"
                className="hidden"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) dosyaOku(f);
                  e.target.value = "";
                }}
              />
            </label>
            {skDosya && (
              <span className="mono text-[11px] text-txt-dim">{skDosya}</span>
            )}
          </div>
          <div className="flex flex-wrap items-center gap-3 mt-2">
            <button
              onClick={() => skCalistir(skMetin)}
              disabled={!skMetin.trim() || bekliyor}
              className="mono text-xs px-3 py-1.5 rounded bg-neon/15 text-neon disabled:opacity-40"
            >
              Kontrol et
            </button>
            {skSonuc && (
              <>
                <span className="mono text-[11px] text-txt-dim tabular-nums">
                  {fmtInt(skSonuc.ozet.satir)} satır · sipariş{" "}
                  {fmtInt(skSonuc.ozet.siparisAdet)} adet · motorun önerisi{" "}
                  {fmtInt(skSonuc.ozet.oneriAdet)} adet
                </span>
                <CsvBtn
                  filename={`cortex-siparis-kontrol-${skFirma}`}
                  rows={skCsv}
                  cols={skCols}
                />
              </>
            )}
          </div>
          {skSonuc && skSonuc.sonuclar.length === 0 && (
            <div className="mono text-[11px] text-amber-400 mt-2">
              Satır okunamadı: her satırda bir adet (sayı) ve barkod ya da ürün
              adı olmalı.
            </div>
          )}
          {skSonuc && skSonuc.sonuclar.length > 0 && (
            <div className="mt-3 overflow-x-auto">
              <div className="flex flex-wrap gap-x-3 gap-y-1 mb-2">
                {(Object.keys(HUKUM_AD) as Hukum[])
                  .filter((h) => skSonuc.ozet.sayim[h] > 0)
                  .map((h) => (
                    <span
                      key={h}
                      className="mono text-[11px]"
                      style={{ color: HUKUM_RENK[h] }}
                    >
                      {HUKUM_AD[h]} {skSonuc.ozet.sayim[h]}
                    </span>
                  ))}
              </div>
              <table className="w-full">
                <thead>
                  <tr>
                    <th className="text-left">Sipariş satırı → CORTEX ürünü</th>
                    <th className="text-right">Sipariş</th>
                    <th className="text-right">Öneri</th>
                    <th className="text-left">Hüküm</th>
                    <th className="text-left">Gerekçe</th>
                  </tr>
                </thead>
                <tbody>
                  {skSonuc.sonuclar.map((x, i) => (
                    <tr key={i} className="border-b border-line/40 align-top">
                      <td className="text-sm max-w-[260px]">
                        <div className="truncate" title={x.satir.ham}>
                          {x.satir.ad || x.satir.barkod}
                        </div>
                        {x.motor && x.motor.sku_name !== x.satir.ad && (
                          <div className="mono text-[10px] text-txt-dim truncate">
                            → {x.motor.sku_name}
                          </div>
                        )}
                      </td>
                      <td className="mono text-right tabular-nums">
                        {fmtInt(x.satir.adet)}
                      </td>
                      <td className="mono text-right tabular-nums font-bold">
                        {x.oneri == null ? "—" : fmtInt(x.oneri)}
                      </td>
                      <td>
                        <span
                          className="mono text-[10px] px-2 py-0.5 rounded whitespace-nowrap"
                          style={{
                            color: HUKUM_RENK[x.hukum],
                            background: HUKUM_RENK[x.hukum] + "1a",
                          }}
                        >
                          {HUKUM_AD[x.hukum]}
                        </span>
                      </td>
                      <td className="mono text-[11px] text-txt-dim">
                        {x.gerekce}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {skFirma === "DR" && (
                <div className="mono text-[10px] text-txt-dim mt-2">
                  {sm.kanalDepo?.haftasi
                    ? `D&R deposu ${fmtDate(sm.kanalDepo.haftasi)} haftasının raporundan stoğa eklendi (mağaza + depo).`
                    : "D&R deposu bu hafta için CORTEX'te yok; hesap mağaza stoğuyla yapılır. Depoda mal varsa gerçek ihtiyaç daha azdır."}
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* ── VERİ DURUMU BANDI ── */}
      {sm?.veri?.byRetailer?.length > 0 && (
        <div className="card p-4 space-y-1.5 cx-soluk" {...bekleme(bekliyor)}>
          <div className="mono text-[10px] tracking-wider text-txt-dim">
            VERİ DURUMU · karar haftası {fmtDate(sm.veri.takvimHaftasi)}
          </div>
          {sm.veri.byRetailer.map((r: any) => (
            <div
              key={r.retailer}
              className="flex flex-wrap items-baseline gap-x-2 mono text-[11px]"
            >
              <span style={{ color: colorOf(r.retailer) }}>{r.retailer}</span>
              {/* TARİH YALNIZ SAPMADA. Sağdaki durum span'i gecikme 0 iken zaten
                   "güncel" yazıyordu; tarihi de basmak aynı şeyi iki kez söylemekti
                   ("Toyzz 07 Eyl 2026 güncel"). Geride kalan kanalda tarih kalır —
                   "3 hafta geride" tek başına hangi haftadan geldiğini söylemez. */}
              {r.gecikmeHf !== 0 && (
                <span className="text-txt-dim">
                  {r.dataWeek ? fmtDate(r.dataWeek) : "veri yok"}
                </span>
              )}
              <span style={{ color: r.gecikmeHf >= 2 ? "#f8b00b" : "#7d927d" }}>
                {r.gecikmeHf === 0
                  ? "güncel"
                  : `${r.gecikmeHf} hafta geride · ${r.durum}`}
              </span>
              {r.askida?.n > 0 && (
                <span className="text-txt-dim">
                  · {fmtInt(r.askida.n)} kalem / {fmtInt(r.askida.qty)} adet /{" "}
                  {fmtMoney(r.askida.psf)} askıda
                </span>
              )}
              {r.kirpma?.n > 0 && (
                <span className="text-txt-dim">
                  · {fmtInt(r.kirpma.n)} satırda adet kırpıldı (
                  {fmtInt(r.kirpma.qty)} adet)
                </span>
              )}
              {r.eksikHaftalar?.length > 0 && (
                <span className="text-txt-dim">
                  · istenecek:{" "}
                  {r.eksikHaftalar.map((w: string) => fmtDate(w)).join(", ")}
                </span>
              )}
            </div>
          ))}
          <div className="mono text-[10px] text-txt-dim">
            Normal kadans 1 haftadır; 1 haftalık gecikme uyarı değildir — çek
            adetleri ölçülen erimeyle kırpılır. SEVK ve TEYİT hiçbir kademede
            bastırılmaz.
          </div>
        </div>
      )}

      {/* ── KANIT KAPISI BANDI (gecikmeden BAĞIMSIZ, her firma) ── */}
      {sm?.likidasyonKapisi &&
        (sm.likidasyonKapisi.erit.n > 0 || sm.likidasyonKapisi.kismi.n > 0) && (
          <div
            className="card p-4 border-l-4 cx-soluk"
            {...bekleme(bekliyor)}
            style={{ borderLeftColor: "#7d927d" }}
          >
            <div className="mono text-[10px] tracking-wider text-txt-dim">
              KANIT KAPISI · eski sezon ≠ satmıyor
            </div>
            <div className="mono text-[11px] mt-1 space-y-0.5">
              <div>
                {fmtInt(
                  sm.likidasyonKapisi.erit.n + sm.likidasyonKapisi.kismi.n,
                )}{" "}
                eski-sezon kalemi hâlâ satıyor (≥1 ad/hf) ve markdown'a
                yazılmıştı.
              </div>
              <div className="text-txt-dim">
                {fmtInt(sm.likidasyonKapisi.erit.eritN)} kalem tasfiyeden
                çıkarıldı (satarak erit)
                {sm.likidasyonKapisi.erit.sevkeDonenN > 0 &&
                  ` · ${fmtInt(sm.likidasyonKapisi.erit.sevkeDonenN)} kalem sevke döndü (raf 2 hf altına inmiş)`}
                {" · "}
                {fmtInt(sm.likidasyonKapisi.kismi.n)} kalemde raftan{" "}
                {fmtInt(sm.likidasyonKapisi.kismi.geriBirakilanQty)} adet geri
                bırakıldı
              </div>
              <div className="text-txt-dim">
                Korunan raf değeri{" "}
                {fmtMoney(
                  sm.likidasyonKapisi.erit.rafPsf +
                    sm.likidasyonKapisi.kismi.geriBirakilanPsf,
                )}{" "}
                brüt
                {" · "}üzerindeki haftalık net akış{" "}
                {fmtMoney(sm.likidasyonKapisi.erit.haftalikNet)}
              </div>
            </div>
          </div>
        )}

      <div
        className="grid grid-cols-2 md:grid-cols-4 gap-3 cx-soluk"
        {...bekleme(bekliyor)}
      >
        {cards.map((c) => {
          const on = action === c.id;
          return (
            <button
              key={c.id}
              onClick={() => setAction(on ? "all" : c.id)}
              className="card p-4 text-left hover:border-neon/50"
              style={
                on
                  ? { borderColor: c.c + "80", background: c.c + "12" }
                  : undefined
              }
            >
              <div className="mono text-[10px] tracking-wider text-txt-dim">
                {c.label}
              </div>
              <div
                className="text-lg font-bold mono mt-1"
                style={{ color: c.c }}
              >
                {c.val}
                <span className="text-[10px] text-txt-dim ml-1">{c.sub}</span>
              </div>
            </button>
          );
        })}
      </div>

      <div className="card p-4 space-y-3">
        <div className="flex items-center gap-3 flex-wrap">
          <div className="flex gap-1 flex-wrap">
            {[
              "all",
              "cek",
              "ASKIDA",
              "LIKIDASYON",
              "ERIT",
              "TRANSFER",
              "DEPO",
              "SEVK",
              "DAĞIT",
              "TEYİT",
              "İZLE",
              "uyarili",
            ].map((a) => (
              <button
                key={a}
                onClick={() => setAction(a)}
                className={`mono text-xs px-3 py-1.5 rounded ${action === a ? "bg-neon/15 text-neon" : "text-txt-dim hover:text-txt"}`}
              >
                {a === "all"
                  ? "Tümü"
                  : a === "cek"
                    ? "ÇEK (hepsi)"
                    : a === "uyarili"
                      ? `⚠ Uyarılı${sm?.denetim?.uyarili ? ` (${sm.denetim.uyarili})` : ""}`
                      : (ACT[a]?.label ?? a)}
              </button>
            ))}
          </div>
          <SearchBox
            value={q}
            onChange={setQ}
            placeholder="Ürün / barkod / hedef…"
            className="flex-1 min-w-[200px]"
          />
          <RangeMin
            label="Min PSF"
            value={minVal}
            onChange={setMinVal}
            suffix="₺"
            step={5000}
            min={0}
          />
        </div>
        {firmOpts.length > 1 && (
          <MultiChips
            label="Firma:"
            options={firmOpts}
            selected={firms}
            onToggle={(f) =>
              setFirms((p) =>
                p.includes(f) ? p.filter((x) => x !== f) : [...p, f],
              )
            }
            onAll={() => setFirms([...firmOpts])}
            onNone={() => setFirms([])}
            colorOf={colorOf}
          />
        )}
        <div className="mono text-[11px] text-txt-dim">
          Hedef stok = asgari raf (taşıması gereken mağaza ×{" "}
          {sm?.raf?.asgari ?? 4} adet) ile segment kapsamının (A-X 8hf · A-Z 6hf
          · C 2-4hf) büyüğü. Altına inerse sevk; {sm?.raf?.ufukHf ?? 26} haftayı
          aşan kısım çekilir (transfer yalnız başka kanalda ihtiyaç varsa),
          aradaki stok satarak erir. Eski sezon→kanıt kapısı (satıyorsa erit,
          satmıyorsa likide).
        </div>
      </div>

      <div className="card p-6 overflow-x-auto cx-soluk" {...bekleme(bekliyor)}>
        <div className="flex items-center justify-between gap-3 flex-wrap mb-3">
          <h2 className="font-bold">
            {action === "all"
              ? "Tüm yönlendirmeler"
              : action === "cek"
                ? "ÇEK — depo + transfer + likidasyon"
                : action === "uyarili"
                  ? "Öz-denetimin işaretlediği kararlar (veri şüpheli)"
                  : ACT[action]?.label}
          </h2>
          <div className="flex items-center gap-3">
            <span className="mono text-xs text-txt-dim">
              {sorted.length} kalem
              {shownVal > 0 ? ` · ${fmtMoney(shownVal)} PSF` : ""}
            </span>
            <CsvBtn
              filename={`cortex-yonlendirme-${mode}-${action}`}
              rows={bekliyor ? [] : csvRows}
              cols={csvCols}
            />
          </div>
        </div>
        {!data && loading ? (
          <div className="mono text-txt-dim py-6 text-center">
            Hesaplanıyor…
          </div>
        ) : sorted.length === 0 ? (
          <div className="mono text-sm text-txt-dim py-6 text-center">
            Bu seçimde yönlendirme yok.
          </div>
        ) : (
          <table className="w-full">
            <thead>
              <tr>
                <th className="text-left">Aksiyon</th>
                <th className="text-left">Firma</th>
                <th className="text-left">Ürün</th>
                <th className="text-center">Segment</th>
                <th className="text-center">Sezon</th>
                <th className="text-left">Veri</th>
                <SortableTh
                  label="Stok"
                  sortKey="stock"
                  align="right"
                  active={sortKey === "stock"}
                  dir={dir}
                  onClick={toggle}
                />
                <SortableTh
                  label="Hız/hf"
                  sortKey="velocity"
                  align="right"
                  active={sortKey === "velocity"}
                  dir={dir}
                  onClick={toggle}
                />
                <th className="text-right">Kapsam/Hedef</th>
                <SortableTh
                  label="Raf/mğz"
                  sortKey="rafMagazaBasi"
                  align="right"
                  active={sortKey === "rafMagazaBasi"}
                  dir={dir}
                  onClick={toggle}
                />
                <SortableTh
                  label="Çek/Sevk"
                  sortKey="qty"
                  align="right"
                  active={sortKey === "qty"}
                  dir={dir}
                  onClick={toggle}
                />
                <th className="text-left">Nereye</th>
                <SortableTh
                  label="PSF Değeri"
                  sortKey="value"
                  align="right"
                  active={sortKey === "value"}
                  dir={dir}
                  onClick={toggle}
                />
                <SortableTh
                  label="Etki 8hf"
                  sortKey="etki8"
                  align="right"
                  active={sortKey === "etki8"}
                  dir={dir}
                  onClick={toggle}
                />
              </tr>
            </thead>
            <tbody>
              {/* KAPAK 1000: eski 600'lük kapak, `value` = 0 olan satırları
                  (SEVK + İZLE + ASKIDA + ERİT = 75 satır) listenin dibine
                  yığdıktan sonra son 4 satırı hiç render etmiyordu — yani sayfa
                  başındaki bant "17 kalem askıda" derken tablo onların bir
                  kısmını göstermeyebiliyordu. Toplam rota 604. */}
              {sorted.slice(0, 1000).map((r, i) => {
                const a = ACT[r.action] ?? ACT["İZLE"];
                const over = r.coverage != null && r.coverage > r.target;
                return (
                  <tr
                    key={i}
                    className="border-b border-line/40"
                    title={r.reason}
                  >
                    <td>
                      <span
                        className="mono text-[10px] px-2 py-0.5 rounded whitespace-nowrap"
                        style={{ color: a.c, background: a.c + "1a" }}
                      >
                        {a.label}
                      </span>
                      {(r.uyari?.length ?? 0) > 0 && (
                        <span
                          className="mono text-[11px] ml-1"
                          style={{ color: "#f8b00b" }}
                          title={r.uyari!.join("\n")}
                        >
                          ⚠
                        </span>
                      )}
                    </td>
                    <td>
                      <span
                        className="mono text-[10px]"
                        style={{ color: colorOf(r.retailer) }}
                      >
                        {r.retailer}
                      </span>
                    </td>
                    <td
                      className="max-w-[300px] truncate"
                      title={
                        (r.barkod ? r.barkod + " · " : "") +
                        r.sku_name +
                        " — " +
                        r.reason
                      }
                    >
                      {r.sku_name}
                    </td>
                    <td className="text-center mono text-[10px]">
                      <span className="px-1 py-0.5 rounded bg-ink-2">
                        {r.abc}·{r.xyz}
                      </span>
                    </td>
                    <td className="text-center">
                      <span
                        className="mono text-[9px] px-1.5 py-0.5 rounded"
                        style={{ color: SEASON_C[r.season] ?? "#7d927d" }}
                      >
                        {r.season}
                      </span>
                    </td>
                    {/* VERİ HAFTASI — her satırda. Eskiden 612 önerinin 612'si
                        tarihsizdi: "233 adet çek" yazıyordu ve bu sayının kaç
                        hafta önceki bir rapordan çıktığı hiçbir yerde yoktu. */}
                    <td className="mono text-[10px] whitespace-nowrap">
                      <span className="text-txt-dim">
                        {fmtHafta(r.dataWeek, sm?.veri?.takvimHaftasi)}
                      </span>
                      {(r.gecikmeHf ?? 0) >= 2 && (
                        <span style={{ color: "#f8b00b" }}>
                          {" "}
                          · {r.gecikmeHf} hf
                        </span>
                      )}
                    </td>
                    <td className="mono text-right">
                      {fmtInt(r.stock)}
                      {/* TAHMİNİ STOK İKİNCİL VE ETİKETLİ. Raporlanan sayı birincil
                          kalır; tedarikçi raporuyla çelişen bir sayıyı asıl sayı
                          gibi göstermek yönetici güvenini bir kez ve kalıcı olarak
                          kaybettirir. */}
                      {(r.drenaj ?? 0) > 0 && (
                        <div className="text-[10px] text-txt-dim">
                          ~{fmtInt(r.stokYaslandirilmis ?? 0)} tahmini
                        </div>
                      )}
                    </td>
                    <td className="mono text-right">{r.velocity}</td>
                    <td
                      className="mono text-right text-[11px]"
                      style={{ color: over ? "#ff5555" : "#7d927d" }}
                    >
                      {r.coverage == null ? "∞" : r.coverage} / {r.target} hf
                    </td>
                    {/* RAF: taşıması gereken mağaza başına stok; eşiğin altı kırmızı. Mağaza
                        verisi olmayan kanalda boş (Toyzz/Nezih/Huppaluppo). */}
                    <td
                      className="mono text-right text-[11px]"
                      title={
                        r.magaza
                          ? `~${r.magaza} mağaza · eşik ${sm?.raf?.asgari ?? 4} adet/mağaza`
                          : "mağaza sayısı bilinmiyor"
                      }
                      style={{
                        color:
                          r.rafMagazaBasi != null &&
                          r.rafMagazaBasi < (sm?.raf?.asgari ?? 4)
                            ? "#ff5555"
                            : "#7d927d",
                      }}
                    >
                      {r.rafMagazaBasi != null ? r.rafMagazaBasi : "—"}
                    </td>
                    <td className="mono text-right font-bold">
                      {r.qty ? fmtInt(r.qty) : "—"}
                      {/* ASKIDA satirinda qty 0'dir AMA sebebi kirpma degil aski;
                          "raporlanan 126 - N tahmini satis" yazmak yanlis gerekce
                          gosterirdi. Kirpma aciklamasi yalniz uretilen kararlarda. */}
                      {r.action !== "ASKIDA" &&
                        r.qtyHam != null &&
                        r.qtyHam > r.qty && (
                          <div className="text-[10px] text-txt-dim font-normal">
                            raporlanan {fmtInt(r.qtyHam)} −{" "}
                            {fmtInt(r.drenaj ?? 0)} tahmini satış
                          </div>
                        )}
                      {r.action === "SEVK" && (r.sevkUst ?? 0) > r.qty && (
                        <div
                          className="text-[10px] text-txt-dim font-normal"
                          title="Bu sayı tahmindir; sipariş raporlanan adet üzerinden verilir."
                        >
                          yaşlandırmayla üst sınır {fmtInt(r.sevkUst!)}
                        </div>
                      )}
                    </td>
                    <td className="mono text-[11px]">
                      {r.action === "TRANSFER" && r.dest ? (
                        <span>
                          <span style={{ color: colorOf(r.dest.retailer) }}>
                            → {r.dest.retailer}
                          </span>{" "}
                          {fmtInt(r.dest.qty)}
                          {r.toDepot > 0 ? (
                            <span className="text-txt-dim">
                              {" "}
                              +depo {fmtInt(r.toDepot)}
                            </span>
                          ) : (
                            ""
                          )}
                        </span>
                      ) : r.action === "LIKIDASYON" ? (
                        <span style={{ color: "#ff5555" }}>
                          → markdown/likide
                        </span>
                      ) : r.action === "DEPO" ? (
                        <span style={{ color: "#f8b00b" }}>→ depo</span>
                      ) : r.action === "SEVK" ? (
                        <span style={{ color: "#1FF80B" }}>
                          depodan sevk
                          {(r.dagit as number) > 0
                            ? ` + D&R deposundan ${fmtInt(r.dagit as number)}`
                            : ""}
                        </span>
                      ) : r.action === "DAĞIT" ? (
                        <span style={{ color: "#0bd1f8" }}>
                          D&amp;R deposundan mağazalara
                        </span>
                      ) : r.action === "ERIT" ? (
                        <span style={{ color: "#7d927d" }}>rafta kalsın</span>
                      ) : r.action === "ASKIDA" ? (
                        <span style={{ color: "#f8b00b" }}>
                          {r.askidaFiil === "LIKIDASYON" ? "tasfiye" : "çekme"}{" "}
                          beklemede
                        </span>
                      ) : (
                        <span className="text-txt-dim">bekle</span>
                      )}
                    </td>
                    <td
                      className="mono text-right"
                      style={{ color: r.value ? "#f8b00b" : "#7d927d" }}
                    >
                      {r.value ? (
                        fmtMoney(r.value)
                      ) : r.noPrice ? (
                        <span
                          className="text-[10px]"
                          title="Fiyat yok — adetle karar"
                        >
                          fiyat yok
                        </span>
                      ) : /* ASKIDA/ERİT satırında `value` bilinçli olarak 0 (sermaye
                             serbest kalmıyor). Büyüklük yine görünmeli, yoksa askı
                             "değersiz" sanılır. */
                      (r.valueHam ?? 0) > 0 ? (
                        <span className="text-[10px] text-txt-dim">
                          askıda {fmtMoney(r.valueHam!)}
                        </span>
                      ) : (r.eritRaf ?? 0) > 0 ? (
                        <span className="text-[10px] text-txt-dim">
                          rafta {fmtMoney(r.eritRaf!)}
                        </span>
                      ) : (
                        "—"
                      )}
                    </td>
                    {/* ETKİ: aksiyonun 8 haftada kazandırdığı (+) ya da kaybettirdiği (−) NET satış. */}
                    <td
                      className="mono text-right text-[11px] tabular-nums"
                      style={{
                        color:
                          (r.etki8 ?? 0) > 0
                            ? "#1FF80B"
                            : (r.etki8 ?? 0) < 0
                              ? "#ff5555"
                              : "#7d927d",
                      }}
                    >
                      {r.etki8 ? fmtMoney(r.etki8) : "—"}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
        {sorted.length > 1000 && (
          <div className="mono text-[11px] text-txt-dim mt-3">
            İlk 1000 gösteriliyor ({sorted.length} toplam). Tümü için CSV indir.
          </div>
        )}
      </div>
    </div>
  );
}
