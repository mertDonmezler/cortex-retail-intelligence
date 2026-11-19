"use client";

// CORTEX ASİSTANI — her ekranda sağ altta. CORTEX'in kendisi: logosuna basılır,
// sohbet açılır. Arkada analist (lib/zeka) veriyi yalnız okuyarak akıl yürütür.
//
// HAREKET: buton CORTEX logosudur; analist çalışırken mevcut bekleme sinyaliyle
// (html[data-mesgul] → logo tarar) kendiliğinden tarar — yeni animasyon yok.
// Panel KanalDetay gibi sağdan girer (.cx-panel), kapanış anlıktır.
//
// CANLI AKIŞ: cevap NDJSON akışıyla gelir (api/zeka akis:true). Beklerken
// analistin baktığı her veri bir satır olarak düşer, son cevap yazıldıkça
// görünür; "Durdur" bağlantıyı keser, sunucu o turda durur.
//
// MASADA PARA: sohbet boşken, model çağırmadan (ücretsiz) motorun önerilerinin
// TL karşılığı gösterilir; en büyük kalemlere basınca CORTEX'e doğrulatılır.
//
// SÜREKLİLİK: bileşen kabukta yaşar; sayfa değişince sohbet kaybolmaz. Sayfa
// yenilenirse sessionStorage'dan geri gelir (yalnız bu sekmede, bu tarayıcıda).
// Sunum modunda (?demo) gizlenir: cevaplardaki rakamlar maskelenmez.
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { usePathname } from "next/navigation";
import { fetchJson } from "@/lib/fetchJson";
import { basla } from "@/lib/mesgul";
import { fmtCompact, fmtDateTime, fmtInt } from "@/lib/format";
import { retailerFromSlug, kanalAdi } from "@/lib/kanal";
import { useBaglamOku } from "@/lib/asistan-baglam";
import { useDemoMode } from "@/components/DemoMask";
import { CortexLogo } from "@/components/CortexLogo";

type Arac = { ad: string; girdi: unknown; hata?: string };
// Kredi kontrolü: oturum başına 10 dakikada 10 soru (sunucu: lib/zeka/kota.ts).
type Kota = {
  limit: number;
  kalan: number;
  sifirlanmaSn: number;
  buAyUsd?: number | null;
};
type Cevap = {
  cevap: string;
  araclar: Arac[];
  model: string;
  tur: number;
  sureMs: number;
  durum: string;
  kullanim: { maliyetUsd: number };
  kota?: Kota;
  id?: number | null;
  hizliTur?: number;
  kayitli?: { ts: string; maliyetUsd: number; aracSayisi: number };
};
type Kayit = {
  rol: "user" | "assistant";
  metin: string;
  meta?: Cevap;
  not?: boolean;
  puan?: 1 | -1;
};
// Akış sırasında: ara notlar ve araç adımları geldiği sırayla; taslak = yazılmakta olan metin.
type Adim =
  { tip: "not"; metin: string } | { tip: "arac"; ad: string; girdi: unknown };
type Canli = { adimlar: Adim[]; taslak: string; bas: number };
type ParaOzeti = {
  kapsam: "ag" | "kanal" | "urun";
  dar?: "kanal" | "urun";
  toplam: {
    kayipSatisRiski8hf: { kalem: number; net: number };
    bagliSermaye: { kalem: number; psf: number; net: number };
    transfer: { kalem: number; hedefteNet: number };
  };
  kayipSatisRiski: {
    firma: string;
    ad: string;
    sekizHaftadaKacacakNet: number;
  }[];
  bagliSermaye: {
    firma: string;
    ad: string;
    aksiyon: string;
    netKarsiligi: number;
  }[];
  transfer: {
    kaynak: string;
    hedef: string;
    ad: string;
    hedefeAdet: number;
    hedefteNetDeger: number;
  }[];
};

const SAKLA = "cortex-asistan-sohbet";

const ARAC_ADI: Record<string, string> = {
  veri_durumu: "veri durumu",
  hafta_ozeti: "hafta özeti",
  en_cok_satanlar: "ürün sıralaması",
  urun_ara: "ürün arama",
  urun_serisi: "ürün serisi",
  aile_serisi: "aile serisi",
  gecen_yil: "geçen yıl",
  stok_kapsami: "stok kapsamı",
  yonlendirme_onerileri: "yönlendirme",
  nakit_durumu: "nakit",
  para_firsatlari: "para fırsatları",
};
// "aile serisi · Pre-Season · Toyzz" — limit gibi teknik girdiler yazılmaz.
function aracEtiketi(ad: string, girdi: unknown): string {
  const ozellikler =
    girdi && typeof girdi === "object"
      ? Object.entries(girdi as Record<string, unknown>)
          .filter(
            ([k, v]) =>
              k !== "limit" && k !== "hafta_sayisi" && v !== "" && v != null,
          )
          .map(([, v]) => String(v))
      : [];
  return [ARAC_ADI[ad] ?? ad, ...ozellikler].join(" · ");
}

// Yol → ekran adı. Kanal sayfası /kanal/<slug>.
function ekranAdi(yol: string): string {
  if (yol === "/") return "Dashboard";
  const k = yol.match(/^\/kanal\/([^/]+)/);
  if (k) {
    const r = retailerFromSlug(decodeURIComponent(k[1]));
    return `${r ? kanalAdi(r) : decodeURIComponent(k[1])} kanal sayfası`;
  }
  const ad: Record<string, string> = {
    "/insights": "Intelligence",
    "/product": "Ürün karşılaştırma",
    "/stok": "Stok Merkezi",
    "/yonlendirme": "Yönlendirme",
    "/stock-alerts": "Sipariş önceliği",
    "/stores": "Mağazalar",
    "/sku": "SKU",
    "/eslesme": "Eşleşme",
    "/upload": "Veri yükleme",
  };
  return ad[yol] ?? yol;
}

function ornekler(yol: string, baglam: Record<string, string>): string[] {
  if ((yol === "/product" && baglam["ürün"]) || baglam["açık ürün"])
    return [
      "Bu ürünle para kazandıracak bir hamle var mı?",
      "Bu ürün hangi kanalda tükeniyor, kaç TL kaçar?",
      "Bu ürün geçen yılla kıyasla nasıl?",
    ];
  if (yol.startsWith("/kanal/"))
    return [
      "Bu kanalda en çok para kazandıracak 3 aksiyon?",
      "Bu kanalda rafı bitmek üzere olan ne var?",
      "Bu kanalda paramız nerede bağlı duruyor?",
    ];
  if (yol === "/stok" || yol === "/yonlendirme")
    return [
      "Motorun önerilerini TL etkisine göre sırala",
      "Motorun hangi önerisine katılmıyorsun?",
      "Bağlı sermayeyi nasıl çalıştırırız?",
    ];
  return [
    "Bu hafta en çok para kazandıracak 3 aksiyon ne?",
    "Hangi hızlı ürünün rafı bitiyor, kaç TL kaçar?",
    "Paramız rafta nerede bağlı duruyor?",
  ];
}

const mmss = (sn: number) =>
  `${Math.floor(sn / 60)}:${String(sn % 60).padStart(2, "0")}`;
const UYARI = { color: "#f8b00b" };

// Analistin sade metni: paragraflar, "- " / "1. " listeleri (girintili = alt madde), **kalın**.
function Metin({ metin }: { metin: string }) {
  const satir = (s: string, k: number): ReactNode =>
    s.split(/(\*\*[^*]+\*\*)/g).map((p, i) =>
      p.startsWith("**") && p.endsWith("**") ? (
        <strong key={`${k}-${i}`} className="text-txt">
          {p.slice(2, -2)}
        </strong>
      ) : (
        <span key={`${k}-${i}`}>{p}</span>
      ),
    );
  const bloklar: ReactNode[] = [];
  let liste: {
    tip: "ul" | "ol";
    ogeler: { metin: string; alt: boolean }[];
  } | null = null;
  const bosalt = () => {
    if (!liste) return;
    const L = liste;
    const ogeler = L.ogeler.map((o, i) => (
      <li key={i} className={o.alt ? "ml-5 list-[circle]" : undefined}>
        {satir(o.metin, i)}
      </li>
    ));
    bloklar.push(
      L.tip === "ul" ? (
        <ul key={bloklar.length} className="list-disc pl-5 space-y-1">
          {ogeler}
        </ul>
      ) : (
        <ol key={bloklar.length} className="list-decimal pl-5 space-y-1">
          {ogeler}
        </ol>
      ),
    );
    liste = null;
  };
  metin.split("\n").forEach((ham, i) => {
    const s = ham.trimEnd();
    const ul = s.match(/^(\s*)[-*•]\s+(.*)$/),
      ol = s.match(/^(\s*)\d+[.)]\s+(.*)$/);
    if (ul || ol) {
      const m = (ul ?? ol)!;
      const alt = m[1].length >= 2 && !!liste;
      const tip = alt ? liste!.tip : ul ? "ul" : "ol";
      if (!liste || liste.tip !== tip) {
        bosalt();
        liste = { tip, ogeler: [] };
      }
      liste.ogeler.push({ metin: m[2], alt });
      return;
    }
    bosalt();
    if (s.trim())
      bloklar.push(<p key={`p${i}`}>{satir(s.replace(/^#+\s*/, ""), i)}</p>);
  });
  bosalt();
  return <div className="space-y-2 leading-relaxed">{bloklar}</div>;
}

// NDJSON akışını satır satır çözer.
async function akisOku(r: Response, olay: (o: any) => void) {
  const okuyucu = r.body!.getReader();
  const coz = new TextDecoder();
  let tampon = "";
  for (;;) {
    const { done, value } = await okuyucu.read();
    if (done) break;
    tampon += coz.decode(value, { stream: true });
    let i: number;
    while ((i = tampon.indexOf("\n")) >= 0) {
      const satir = tampon.slice(0, i).trim();
      tampon = tampon.slice(i + 1);
      if (satir) olay(JSON.parse(satir));
    }
  }
  if (tampon.trim()) olay(JSON.parse(tampon));
}

// Kart etiketinde kısa ad: Toyzz'ın "ASP-MYT-KART " öneki ve sondaki koli içi
// adedi ("15D.") düşer. CORTEX'e giden soruda tam ad kalır (aramada o kullanılır).
const kisaAd = (s: string) =>
  s.replace(/^ASP-MYT-KART\s+/i, "").replace(/\s+\d+D\.?$/i, "");

// Sohbet boşken: motorun önerilerinin TL karşılığı (model yok, ücretsiz).
function MasadaPara({
  para,
  sor,
}: {
  para: ParaOzeti;
  sor: (soru: string) => void;
}) {
  const t = para.toplam;
  const kapsamAdi =
    para.kapsam === "urun"
      ? "bu ürün"
      : para.kapsam === "kanal"
        ? "bu kanal"
        : "ağ geneli";
  const kalemler: { etiket: string; soru: string }[] = [
    ...para.kayipSatisRiski.slice(0, 2).map((x) => ({
      etiket: `${x.firma} · ${kisaAd(x.ad)} — rafı bitiyor, ~${fmtCompact(x.sekizHaftadaKacacakNet)} kaçar`,
      soru: `"${x.ad}" (${x.firma}) rafı bitiyor; motor 8 haftada ~${fmtCompact(x.sekizHaftadaKacacakNet)} net kaçacağını hesaplıyor. Güncel hızla doğrula: ne kadar sevk edelim, kaç TL kazanırız?`,
    })),
    ...para.transfer.slice(0, 1).map((x) => ({
      etiket: `${x.kaynak} → ${x.hedef} · ${kisaAd(x.ad)} — ${fmtInt(x.hedefeAdet)} adet, ~${fmtCompact(x.hedefteNetDeger)}`,
      soru: `"${x.ad}" için ${x.kaynak} → ${x.hedef} ${fmtInt(x.hedefeAdet)} adet transfer önerisi var (~${fmtCompact(x.hedefteNetDeger)} net). Mantıklı mı, gerçekte kaç TL getirir?`,
    })),
    ...para.bagliSermaye.slice(0, 1).map((x) => ({
      etiket: `${x.firma} · ${kisaAd(x.ad)} — ~${fmtCompact(x.netKarsiligi)} bağlı`,
      soru: `"${x.ad}" (${x.firma}) için ~${fmtCompact(x.netKarsiligi)} net sermaye rafta bağlı (motor: ${x.aksiyon}). Bu malı nasıl paraya çeviririz?`,
    })),
  ];
  return (
    <section className="rounded-lg border border-line bg-ink/60 p-3 space-y-2.5">
      <div className="flex justify-between gap-2 mono text-[10px] uppercase tracking-wider text-txt-dim">
        <span>Masada para · {kapsamAdi}</span>
        <span title="Yönlendirme motorunun önerilerinin net kazanç karşılığı; model çağrısı yok.">
          motor · ücretsiz
        </span>
      </div>
      {para.dar && (
        <p className="mono text-[10px] text-txt-dim">
          {para.dar === "urun" ? "Bu ürün" : "Bu kanal"} için motorun TL'lik
          önerisi yok; {kapsamAdi} gösteriliyor.
        </p>
      )}
      <dl className="grid grid-cols-[1fr_auto] gap-x-3 gap-y-1 text-xs">
        <dt className="text-txt-dim">Kaçacak satış (8 hafta)</dt>
        <dd className="mono text-right">
          <span className="text-txt">
            {fmtCompact(t.kayipSatisRiski8hf.net)}
          </span>{" "}
          <span className="text-txt-dim">
            · {t.kayipSatisRiski8hf.kalem} kalem
          </span>
        </dd>
        <dt className="text-txt-dim">Transfer fırsatı</dt>
        <dd className="mono text-right">
          <span className="text-txt">{fmtCompact(t.transfer.hedefteNet)}</span>{" "}
          <span className="text-txt-dim">· {t.transfer.kalem} öneri</span>
        </dd>
        <dt className="text-txt-dim">Rafta bağlı sermaye</dt>
        <dd className="mono text-right">
          <span className="text-txt">{fmtCompact(t.bagliSermaye.net)}</span>{" "}
          <span className="text-txt-dim">· {t.bagliSermaye.kalem} kalem</span>
        </dd>
      </dl>
      {kalemler.length > 0 && (
        <div className="space-y-1">
          <div className="mono text-[10px] text-txt-dim">
            En büyük kalemler — basınca CORTEX doğrular:
          </div>
          {kalemler.map((k) => (
            <button
              key={k.etiket}
              type="button"
              onClick={() => sor(k.soru)}
              className="block w-full text-left mono text-[11px] px-2 py-1.5 rounded border border-line text-txt-dim hover:border-neon/40 hover:text-txt"
            >
              {k.etiket}
            </button>
          ))}
        </div>
      )}
    </section>
  );
}

export function Asistan() {
  const yol = usePathname() ?? "/";
  const sayfaBaglami = useBaglamOku();
  const demo = useDemoMode();
  const [durum, setDurum] = useState<{ hazir: boolean; model: string } | null>(
    null,
  );
  const [kota, setKota] = useState<Kota | null>(null);
  const [geriSayim, setGeriSayim] = useState(0);
  const [acik, setAcik] = useState(false);
  const [kayitlar, setKayitlar] = useState<Kayit[]>([]);
  const [soru, setSoru] = useState("");
  const [canli, setCanli] = useState<Canli | null>(null);
  const [gecenSn, setGecenSn] = useState(0);
  const [hata, setHata] = useState<string | null>(null);
  const [para, setPara] = useState<{
    anahtar: string;
    d: ParaOzeti | null;
  } | null>(null);
  const [kopyalanan, setKopyalanan] = useState<number | null>(null);
  const sonRef = useRef<HTMLDivElement>(null);
  const girdiRef = useRef<HTMLTextAreaElement>(null);
  const iptalRef = useRef<AbortController | null>(null);
  const calisiyor = canli !== null;

  // Ekran bağlamı: sayfa adı + sayfanın bildirdiği seçimler. Soruyla birlikte gider.
  const ekran = useMemo(() => {
    const parcalar = [
      ekranAdi(yol),
      ...Object.entries(sayfaBaglami)
        .filter(([, v]) => v)
        .map(([k, v]) => `${k}: ${v}`),
    ];
    return parcalar.join(" · ");
  }, [yol, sayfaBaglami]);

  // Masada para kartının kapsamı: kanal sayfasında o kanal, ürün seçiliyse o ürün.
  const paraAnahtari = useMemo(() => {
    const k = yol.match(/^\/kanal\/([^/]+)/);
    const kanal = k ? retailerFromSlug(decodeURIComponent(k[1])) : null;
    const q = new URLSearchParams();
    if (kanal) q.set("kanal", kanal);
    if (sayfaBaglami.barkod) q.set("barkod", sayfaBaglami.barkod);
    return q.toString();
  }, [yol, sayfaBaglami]);

  const kotaYenile = () =>
    fetchJson<{ hazir: boolean; model: string; kota: Kota | null }>("/api/zeka")
      .then((d) => {
        setDurum(d);
        setKota(d.kota);
        setGeriSayim(d.kota?.sifirlanmaSn ?? 0);
      })
      .catch(() => setDurum({ hazir: false, model: "" }));

  useEffect(() => {
    kotaYenile();
    try {
      const s = sessionStorage.getItem(SAKLA);
      if (s) setKayitlar(JSON.parse(s));
    } catch {
      /* depolama yok */
    }
  }, []);
  // Sınır dolduysa geri say; süre bitince sunucudan güncel hakkı al.
  useEffect(() => {
    if (geriSayim <= 0) return;
    const t = setTimeout(
      () => (geriSayim === 1 ? kotaYenile() : setGeriSayim(geriSayim - 1)),
      1000,
    );
    return () => clearTimeout(t);
  }, [geriSayim]);
  const kilitli = !!kota && kota.kalan <= 0 && geriSayim > 0;
  useEffect(() => {
    try {
      sessionStorage.setItem(SAKLA, JSON.stringify(kayitlar.slice(-30)));
    } catch {
      /* depolama yok */
    }
  }, [kayitlar]);
  useEffect(() => {
    if (!acik) return;
    const f = (e: KeyboardEvent) => {
      if (e.key === "Escape") setAcik(false);
    };
    window.addEventListener("keydown", f);
    girdiRef.current?.focus();
    return () => window.removeEventListener("keydown", f);
  }, [acik]);
  useEffect(() => {
    if (acik) sonRef.current?.scrollIntoView({ block: "nearest" });
  }, [kayitlar, canli, acik]);
  // Beklerken geçen süre (saniye): akışta yeni bir şey düşmese de canlı olduğu görünsün.
  useEffect(() => {
    if (!canli) return;
    setGecenSn(0);
    const t = setInterval(
      () => setGecenSn(Math.round((Date.now() - canli.bas) / 1000)),
      1000,
    );
    return () => clearInterval(t);
  }, [canli?.bas]); // eslint-disable-line react-hooks/exhaustive-deps
  // Masada para: panel açık ve sohbet boşken, kapsam değiştikçe bir kez.
  useEffect(() => {
    if (!acik || kayitlar.length > 0 || para?.anahtar === paraAnahtari) return;
    setPara({ anahtar: paraAnahtari, d: null });
    fetchJson<ParaOzeti>(
      `/api/zeka/para${paraAnahtari ? `?${paraAnahtari}` : ""}`,
    )
      .then((d) =>
        setPara((p) =>
          p?.anahtar === paraAnahtari ? { anahtar: paraAnahtari, d } : p,
        ),
      )
      .catch(() => {
        /* kart görünmez; asistan çalışmaya devam eder */
      });
  }, [acik, kayitlar.length, paraAnahtari]); // eslint-disable-line react-hooks/exhaustive-deps

  async function gonder(
    metin: string,
    secenek: { not?: boolean; yenile?: boolean } = {},
  ) {
    const not = !!secenek.not;
    if (calisiyor || kilitli || (!not && !metin.trim())) return;
    setHata(null);
    const gecmis = kayitlar
      .filter((k) => !k.not)
      .map((k) => ({ rol: k.rol, metin: k.metin }));
    const etiket = not
      ? secenek.yenile
        ? "Haftalık notu yeniden yaz"
        : "Haftalık analist notunu yaz"
      : metin.trim();
    setKayitlar((k) => [...k, { rol: "user", metin: etiket, not }]);
    setSoru("");
    setCanli({ adimlar: [], taslak: "", bas: Date.now() });
    const ac = new AbortController();
    iptalRef.current = ac;
    const bitir = basla(); // başlıktaki ve butondaki logo bekleme boyunca tarar
    const sonuc: { son?: Cevap; hata?: string } = {};
    try {
      const r = await fetch("/api/zeka", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: ac.signal,
        body: JSON.stringify(
          not
            ? { not: true, yenile: !!secenek.yenile, akis: true }
            : { soru: metin.trim(), gecmis, ekran, akis: true },
        ),
      });
      if (!(r.headers.get("content-type") ?? "").includes("ndjson")) {
        // Akış açılmadı: kota dolu, kayıtlı not ya da hata — düz JSON.
        const d = await r.json().catch(() => ({}) as any);
        if (!r.ok || d?.error)
          throw new Error(d?.error || "Sunucu hatası " + r.status);
        sonuc.son = d;
      } else {
        await akisOku(r, (o) => {
          if (o.t === "metin")
            setCanli((c) => c && { ...c, taslak: c.taslak + o.d });
          else if (o.t === "tur")
            setCanli(
              (c) =>
                c && {
                  ...c,
                  taslak: "",
                  adimlar: c.taslak.trim()
                    ? [...c.adimlar, { tip: "not", metin: c.taslak.trim() }]
                    : c.adimlar,
                },
            );
          else if (o.t === "arac")
            setCanli(
              (c) =>
                c && {
                  ...c,
                  adimlar: [
                    ...c.adimlar,
                    { tip: "arac", ad: o.ad, girdi: o.girdi },
                  ],
                },
            );
          else if (o.t === "basla" && o.kota)
            setKota((k) => ({ ...o.kota, buAyUsd: k?.buAyUsd ?? null }));
          else if (o.t === "son") sonuc.son = o;
          else if (o.t === "hata") sonuc.hata = o.error;
        });
        if (!sonuc.son)
          throw new Error(sonuc.hata ?? "Bağlantı koptu; cevap tamamlanmadı.");
      }
      const d = sonuc.son!;
      setKayitlar((k) => [
        ...k,
        { rol: "assistant", metin: d.cevap, meta: d, not },
      ]);
      if (d.kota) {
        setKota(d.kota);
        setGeriSayim(d.kota.sifirlanmaSn);
      }
    } catch (e: any) {
      const durdu = ac.signal.aborted;
      setHata(
        durdu
          ? "Durduruldu. Soru hakkından bir tane düştü."
          : (e?.message ?? "CORTEX yanıt vermedi."),
      );
      setKayitlar((k) => k.slice(0, -1));
      if (!not) setSoru(metin);
      kotaYenile(); // sınır mı doldu, kaç saniye kaldı — sunucudan öğren
    } finally {
      bitir();
      iptalRef.current = null;
      setCanli(null);
    }
  }

  function puanla(i: number, puan: 1 | -1) {
    const k = kayitlar[i];
    const id = k?.meta?.id;
    if (!id) return;
    const yeni = k.puan === puan ? null : puan;
    setKayitlar((ks) =>
      ks.map((x, j) => (j === i ? { ...x, puan: yeni ?? undefined } : x)),
    );
    fetch("/api/zeka", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, puan: yeni }),
    }).catch(() => {
      /* geri bildirim kaybolursa sohbet etkilenmez */
    });
  }

  function kopyala(i: number, metin: string) {
    navigator.clipboard
      ?.writeText(metin)
      .then(() => {
        setKopyalanan(i);
        setTimeout(() => setKopyalanan((x) => (x === i ? null : x)), 1500);
      })
      .catch(() => {
        /* pano izni yok */
      });
  }

  if (!durum?.hazir || demo) return null;

  if (!acik) {
    return (
      <button
        type="button"
        onClick={() => setAcik(true)}
        aria-label="CORTEX'e sor"
        title="CORTEX'e sor"
        className="fixed bottom-5 right-5 z-40 w-14 h-14 rounded-full bg-ink-2 border border-neon/40 hover:border-neon shadow-lg shadow-black/50 flex items-center justify-center"
      >
        <CortexLogo boyut={30} />
        {(kayitlar.length > 0 || calisiyor) && (
          <span
            className="absolute top-1 right-1 w-2.5 h-2.5 rounded-full bg-neon"
            aria-hidden
          />
        )}
      </button>
    );
  }

  return (
    <aside
      role="dialog"
      aria-label="CORTEX asistanı"
      className="fixed z-50 inset-0 md:inset-auto md:bottom-5 md:right-5 md:w-[460px] md:h-[min(760px,calc(100vh-6rem))] flex flex-col bg-ink-2 border border-line md:rounded-xl shadow-2xl shadow-black/60 cx-panel"
    >
      <header className="flex items-center gap-2 px-4 py-3 border-b border-line">
        <CortexLogo boyut={24} className="shrink-0" />
        <div className="leading-tight min-w-0">
          <div className="font-bold tracking-[0.15em] neon-text text-sm">
            CORTEX
          </div>
          <div className="mono text-[10px] text-txt-dim truncate" title={ekran}>
            {ekran}
          </div>
        </div>
        <div className="ml-auto flex items-center gap-1.5 shrink-0">
          <button
            type="button"
            disabled={calisiyor || kilitli}
            onClick={() => gonder("", { not: true })}
            title="Aynı veriyle yazılmış not varsa kayıttan gelir (ücretsiz)"
            className="mono text-[11px] px-2 py-1 rounded border border-line text-txt-dim hover:border-neon/40 hover:text-txt disabled:opacity-40"
          >
            Haftalık not
          </button>
          {kayitlar.length > 0 && (
            <button
              type="button"
              disabled={calisiyor}
              onClick={() => {
                setKayitlar([]);
                setHata(null);
              }}
              className="mono text-[11px] px-2 py-1 rounded border border-line text-txt-dim hover:text-txt disabled:opacity-40"
            >
              Temizle
            </button>
          )}
          <button
            type="button"
            onClick={() => setAcik(false)}
            aria-label="Kapat"
            className="mono text-lg leading-none px-2 py-0.5 text-txt-dim hover:text-txt"
          >
            ×
          </button>
        </div>
      </header>

      <div className="flex-1 overflow-y-auto px-4 py-3 space-y-4 text-sm">
        {kayitlar.length === 0 && !calisiyor && (
          <div className="space-y-3">
            <p className="text-txt-dim">
              Veriye bakarak düşünürüm: satış, stok, geçen yıl, kanallar,
              motorun önerileri. Her önerinin TL karşılığını söylerim; rakamları
              kendim çekerim.
            </p>
            {para?.d && <MasadaPara para={para.d} sor={(s) => gonder(s)} />}
            <div className="flex flex-wrap gap-2">
              {ornekler(yol, sayfaBaglami).map((o) => (
                <button
                  key={o}
                  type="button"
                  onClick={() => gonder(o)}
                  className="mono text-xs px-3 py-1.5 rounded-full border border-line text-txt-dim hover:border-neon/40 hover:text-txt text-left"
                >
                  {o}
                </button>
              ))}
            </div>
          </div>
        )}
        {kayitlar.map((k, i) =>
          k.rol === "user" ? (
            <div key={i} className="flex justify-end">
              <div className="max-w-[88%] rounded-lg bg-neon/10 border border-neon/20 px-3 py-2">
                {k.metin}
              </div>
            </div>
          ) : (
            <div key={i}>
              {k.meta?.kayitli && (
                <div className="mb-2 flex items-center justify-between gap-2 mono text-[10px] text-txt-dim border border-line rounded px-2 py-1">
                  <span>
                    Kayıtlı not · {fmtDateTime(k.meta.kayitli.ts)} · aynı veri,
                    ücretsiz
                  </span>
                  <button
                    type="button"
                    disabled={calisiyor || kilitli}
                    onClick={() => gonder("", { not: true, yenile: true })}
                    className="underline hover:text-txt disabled:opacity-40"
                  >
                    yeniden yaz
                  </button>
                </div>
              )}
              <Metin metin={k.metin} />
              {k.meta && (
                <div className="mt-2 flex flex-wrap items-start justify-between gap-x-3 gap-y-1 mono text-[11px] text-txt-dim">
                  <details className="min-w-0">
                    <summary className="cursor-pointer select-none">
                      {k.meta.kayitli
                        ? `${k.meta.kayitli.aracSayisi} veri sorgusu · yazılırken ~$${k.meta.kayitli.maliyetUsd.toFixed(3)}`
                        : `${k.meta.araclar.length} veri sorgusu · ${(k.meta.sureMs / 1000).toFixed(0)} sn${k.meta.hizliTur ? " · hızlı mod" : ""} · ~$${k.meta.kullanim.maliyetUsd.toFixed(3)}`}
                      {k.meta.durum !== "tamam" ? ` · ${k.meta.durum}` : ""}
                    </summary>
                    <ul className="mt-1 space-y-0.5 pl-3">
                      {k.meta.araclar.map((a, j) => (
                        <li key={j} style={a.hata ? UYARI : undefined}>
                          {aracEtiketi(a.ad, a.girdi)}
                          {a.hata ? ` — ${a.hata}` : ""}
                        </li>
                      ))}
                    </ul>
                  </details>
                  <div className="flex items-center gap-2 shrink-0">
                    <button
                      type="button"
                      onClick={() => kopyala(i, k.metin)}
                      className="hover:text-txt"
                    >
                      {kopyalanan === i ? "kopyalandı" : "kopyala"}
                    </button>
                    {/* Geri bildirim yalnız kayda geçen cevaplarda (zeka_kullanim tablosu varsa id gelir). */}
                    {k.meta.id && !k.meta.kayitli && (
                      <>
                        <button
                          type="button"
                          onClick={() => puanla(i, 1)}
                          aria-pressed={k.puan === 1}
                          title="Bu cevap işe yaradı"
                          className={
                            k.puan === 1 ? "text-neon" : "hover:text-txt"
                          }
                        >
                          işe yaradı
                        </button>
                        <button
                          type="button"
                          onClick={() => puanla(i, -1)}
                          aria-pressed={k.puan === -1}
                          title="Bu cevapta yanlış var"
                          className={k.puan === -1 ? "" : "hover:text-txt"}
                          style={k.puan === -1 ? UYARI : undefined}
                        >
                          yanlış
                        </button>
                      </>
                    )}
                  </div>
                </div>
              )}
            </div>
          ),
        )}
        {canli && (
          <div className="space-y-2">
            {canli.adimlar.length > 0 && (
              <ul className="mono text-[11px] text-txt-dim space-y-0.5 border-l border-line pl-3">
                {canli.adimlar.map((a, j) =>
                  a.tip === "not" ? (
                    <li key={j} className="italic">
                      {a.metin}
                    </li>
                  ) : (
                    <li key={j}>→ {aracEtiketi(a.ad, a.girdi)}</li>
                  ),
                )}
              </ul>
            )}
            {canli.taslak ? (
              <Metin metin={canli.taslak} />
            ) : (
              <div className="mono text-xs text-txt-dim">
                {canli.adimlar.length
                  ? "CORTEX veriyi tartıyor…"
                  : "CORTEX veriye bakıyor…"}{" "}
                {gecenSn > 0 ? `${gecenSn} sn` : ""}
              </div>
            )}
          </div>
        )}
        {hata && (
          <div className="mono text-xs" style={UYARI}>
            {hata}
          </div>
        )}
        <div ref={sonRef} />
      </div>

      <div className="border-t border-line p-3 space-y-1.5">
        <form
          className="flex gap-2 items-end"
          onSubmit={(e) => {
            e.preventDefault();
            gonder(soru);
          }}
        >
          <textarea
            ref={girdiRef}
            value={soru}
            onChange={(e) => setSoru(e.target.value)}
            rows={2}
            maxLength={2000}
            disabled={kilitli}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                gonder(soru);
              }
            }}
            placeholder={
              kilitli
                ? `Sınır doldu — ${mmss(geriSayim)} sonra tekrar`
                : "CORTEX'e sor…"
            }
            className="flex-1 card mono text-sm px-3 py-2 bg-ink outline-none focus:border-neon resize-none disabled:opacity-50"
          />
          {calisiyor ? (
            <button
              type="button"
              onClick={() => iptalRef.current?.abort()}
              className="mono text-sm px-4 py-2 rounded-lg border border-line text-txt-dim hover:text-txt"
            >
              Durdur
            </button>
          ) : (
            <button
              type="submit"
              disabled={kilitli || !soru.trim()}
              className="mono text-sm px-4 py-2 rounded-lg border border-neon text-neon bg-neon/10 disabled:opacity-40"
            >
              Sor
            </button>
          )}
        </form>
        {kota && (
          <div className="mono text-[10px] text-txt-dim flex justify-between gap-2">
            <span style={kota.kalan <= 2 ? UYARI : undefined}>
              {kilitli
                ? `10 dakikada ${kota.limit} soru sınırı doldu · ${mmss(geriSayim)} sonra açılır`
                : `10 dakikada ${kota.kalan}/${kota.limit} soru hakkın kaldı`}
            </span>
            {kota.buAyUsd != null && (
              <span>bu ay ~${kota.buAyUsd.toFixed(2)}</span>
            )}
          </div>
        )}
      </div>
    </aside>
  );
}
