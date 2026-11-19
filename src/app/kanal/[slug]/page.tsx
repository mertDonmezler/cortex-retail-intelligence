"use client";

// ── KANAL EKRANI — bir firmanın tüm ürünleri tek tabloda ──
//
// Tasarım kararı (kullanıcı seçimi): SOLDA SABİT ÖZET, SAĞDA AÇILIR HAFTALAR.
// Tam pivot (41 hafta doğrudan kolon) reddedildi çünkü ekran okunmaz hale
// geliyor; "son 2 hafta" ise geçmişi tamamen saklıyor. Orta yol: özet kolonlar
// her zaman görünür, "haftaları aç" ile tüm geçmiş sağa doğru açılır.
//
// CİRO İKİ KOLON: brüt PSF (firmayla mutabakat için) + net karşılık (şirket içi
// karar için). Sistemin kuralı net = PSF × (1 − marj%) ÷ 1,20; çarpan API'den
// geliyor, burada ikinci kez uygulanmaz.
//
// KARAR kolonu /api/routing'den geliyor ve sku_name ile eşleşiyor. Motor
// mantığı burada TEKRARLANMAZ — tek kaynak yönlendirme ucudur.
//
// YAPIŞKANLIK ŞART: 41 hafta açılınca tablo ~5.100 px oluyor. Başlık satırı ve
// ilk iki kolon (# + ürün) sabitlenmeseydi sağa kaydıran kullanıcı hangi ürüne
// baktığını kaybederdi. Bu yüzden tablo `border-separate` kullanıyor —
// `border-collapse: collapse` ile position:sticky kenarlıkları kaybediyor.
import { useEffect, useMemo, useState } from "react";
import { bekleme } from "@/lib/hareket";
import { useParams } from "next/navigation";
import Link from "next/link";
import { fetchJson } from "@/lib/fetchJson";
import { fmtInt, fmtMoney, fmtDate, colorOf } from "@/lib/format";
import { useSort, SearchBox, CsvBtn, SegTabs, type SortDir } from "@/components/Controls";
import { KANALLAR, kanalAdi, retailerFromSlug, slugOf, degisimYuzde } from "@/lib/kanal";
import { KanalDetay } from "@/components/KanalDetay";
import { useAsistanBaglami } from "@/lib/asistan-baglam";

type Sku = {
  sku_name: string; barkod: string | null; psf: number | null;
  psfKaynak: "rapor" | "ciro" | "fiyat-listesi" | null;
  seri: Record<string, { qty: number; value: number | null; stock: number }>;
  qty: number; prevQty: number; stock: number; prevStock: number;
  brut: number | null; net: number | null; hiz: number; kapsam: number | null;
  degisim: number | null; ilkHafta: string; satanHafta: number; kapali?: true;
};
type Yanit = {
  retailer: string; haftalar: string[];
  veri: { dataWeek: string; prevWeek: string | null; takvimHaftasi: string; gecikmeHf: number; hizPencere: number; netCarpan: number } | null;
  toplam: { kalem: number; buHafta: number; satan: number; stoklu: number; olu: number; psfYok: number; qty: number; prevQty: number; stock: number; brut: number; net: number; stokBrut: number } | null;
  skus: Sku[];
};
type Rota = { sku_name: string; action: string; qty?: number; reason?: string; dest?: { retailer: string } | null };

const KARAR_RENK: Record<string, string> = {
  LIKIDASYON: "#ff5555", DEPO: "#f8b00b", TRANSFER: "#5ab0ff", ASKIDA: "#b088ff",
  ERIT: "#ff9f43", SEVK: "#1FF80B", İZLE: "#7d927d",
};
const KARAR_AD: Record<string, string> = { LIKIDASYON: "LİKİDASYON", İZLE: "İZLE" };

// Yapışkan hücrelerin ARKASI opak olmalı, yoksa altından kayan satırlar görünür.
// Renkler .card gradyanının uçlarıyla aynı (globals.css): #0f150f / #0c110c.
const THBG = "bg-[#0f150f]";
const TDBG = "bg-[#0c110c]";
const TFBG = "bg-[#0f150f] border-t border-line";
// İlk kolonun genişliği — ürün kolonunun sol yapışması buna dayanıyor.
const SOL2 = "left-[44px]";

const fmt1 = (n: number | null | undefined) =>
  n == null ? "—" : n.toLocaleString("tr-TR", { minimumFractionDigits: 1, maximumFractionDigits: 1 });

type Filtre = "hepsi" | "satan" | "stoklu" | "olu";

/** Yapışkan <th> içinde kullanılabilen sıralama etiketi (SortableTh kendi <th>'ini
 *  bastığı için burada kullanılamıyor; davranış birebir aynı). */
function SortLabel({
  label, k, sortKey, dir, onClick, align,
}: { label: string; k: string; sortKey: string | null; dir: SortDir; onClick: (key: string) => void; align?: "right" }) {
  const aktif = sortKey === k;
  return (
    <button type="button" onClick={() => onClick(k)}
      className={`w-full select-none whitespace-nowrap uppercase tracking-wider ${align === "right" ? "text-right" : "text-left"} ${aktif ? "text-neon" : "text-txt-dim hover:text-txt"}`}>
      {label} <span className="opacity-60">{aktif ? (dir === "asc" ? "▲" : "▼") : "↕"}</span>
    </button>
  );
}

export default function KanalPage() {
  const params = useParams();
  const slug = String(params?.slug ?? "");
  const retailer = retailerFromSlug(slug);

  const [d, setD] = useState<Yanit | null>(null);
  const [rotalar, setRotalar] = useState<Map<string, Rota>>(new Map());
  const [err, setErr] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [filtre, setFiltre] = useState<Filtre>("hepsi");
  const [haftalarAcik, setHaftalarAcik] = useState(false);
  // Açık detay paneli — SKU ADI ile tutuluyor, nesne ile değil: sıralama ya da
  // filtre değişince aynı ürünün satırı yer değiştirir, ad sabit kalır.
  const [acikSku, setAcikSku] = useState<string | null>(null);
  // Karar motoru yanıtı geldi mi? Gelene kadar Karar kolonundaki "—" bir hüküm
  // değil beklemedir (soluk basılır); gelince "—" = motor karar vermedi.
  // Kanal değişince sıfırlanır: önceki kanalın kararları, aynı ürün adı yeni
  // kanalda da varsa, yanıt gelene kadar yanlış satırda görünebiliyordu.
  const [rotaGeldi, setRotaGeldi] = useState(false);

  // Asistan: kanal yoldan bilinir; burada veri haftası ve açık ürün eklenir
  // ("bu ürün" detay panelindeki ürünü kasteder).
  const acikBarkod = acikSku ? d?.skus.find((s) => s.sku_name === acikSku)?.barkod ?? "" : "";
  useAsistanBaglami(retailer ? {
    ...(d?.veri ? { "veri haftası": d.veri.dataWeek } : {}),
    ...(acikSku ? { "açık ürün": acikSku, barkod: acikBarkod } : {}),
  } : null);

  useEffect(() => {
    if (!retailer) return;
    let iptal = false;
    setD(null); setErr(null);
    setRotalar(new Map()); setRotaGeldi(false);
    fetchJson<Yanit>(`/api/kanal?retailer=${encodeURIComponent(retailer)}`)
      .then((x) => { if (!iptal) setD(x); })
      .catch((e) => { if (!iptal) setErr(String(e?.message ?? e)); });
    // Karar kolonu — yönlendirme motorundan. Hata yutulur: karar kolonu
    // olmadan da tablo çalışır, tüm sayfayı düşürmesi anlamsız olur.
    //
    // `slim=1` KULLANILMAZ: o kip ana sayfanın "bugün yapılacaklar" kartları
    // için kısaltılmış bir SEÇKİ döndürüyor (ölçüldü: 610 rotanın 24'ü, Toyzz'da
    // 162 yerine 9). Tam liste gerekiyor; yanıt sunucuda memoize edildiği için
    // maliyeti tek seferlik.
    // MOD ADI GEÇERLİ OLMALI: geçerli kümede `dengeli` yok (koruma|denge|agresif).
    // Sunucu bilinmeyen modu sessizce denge gibi hesaplıyordu, yani sayı doğruydu
    // ama ÖNBELLEK ANAHTARI ana sayfanınkiyle tutmuyor ve 977 satırlık motor her
    // açılışta baştan çalışıyordu.
    fetchJson<{ routes: (Rota & { retailer: string })[] }>("/api/routing?mode=denge")
      .then((r) => {
        if (iptal) return;
        const m = new Map<string, Rota>();
        for (const x of r.routes ?? []) if (x.retailer === retailer) m.set(x.sku_name, x);
        setRotalar(m);
        setRotaGeldi(true);
      })
      .catch(() => { if (iptal) return; setRotalar(new Map()); setRotaGeldi(true); });
    return () => { iptal = true; };
  }, [retailer]);

  const satirlar = useMemo(() => {
    if (!d) return [];
    const ara = q.trim().toLocaleLowerCase("tr");
    return d.skus.filter((s) => {
      if (filtre === "satan" && s.qty <= 0) return false;
      if (filtre === "stoklu" && s.stock <= 0) return false;
      if (filtre === "olu" && !(s.qty === 0 && s.stock === 0)) return false;
      if (!ara) return true;
      return s.sku_name.toLocaleLowerCase("tr").includes(ara) || (s.barkod ?? "").includes(ara);
    });
  }, [d, q, filtre]);

  // VARSAYILAN SIRA = BU HAFTAKİ ADET (kullanıcı tercihi). Ciro değil: ekranı
  // açan ilk soru "bu hafta ne sattı"; pahalı ama az satan kalemin başa gelmesi
  // tabloyu ilk bakışta yanıltıyordu.
  const { sorted, sortKey, dir, toggle } = useSort<Sku>(satirlar, "qty", "desc");

  // GÖRÜNEN satırların toplamı — filtre/arama değişince değişir.
  const gorunen = useMemo(() => {
    const qty = sorted.reduce((a, s) => a + s.qty, 0);
    const prevQty = sorted.reduce((a, s) => a + s.prevQty, 0);
    return {
      qty, prevQty,
      stock: sorted.reduce((a, s) => a + s.stock, 0),
      brut: sorted.reduce((a, s) => a + (s.brut ?? 0), 0),
      net: sorted.reduce((a, s) => a + (s.net ?? 0), 0),
      degisim: degisimYuzde(qty, prevQty),
    };
  }, [sorted]);

  // Açılır hafta kolonları YENİ→ESKİ: en taze hafta sola gelsin, kullanıcı
  // sağa kaydırmadan son haftaları görsün. (Erken dönüşten önce: hook sırası.)
  const haftalar = d?.haftalar ?? [];
  const haftaKolon = useMemo(() => [...haftalar].reverse(), [haftalar]);

  if (!retailer) {
    return (
      <div className="card p-6 mono text-sm">
        Bilinmeyen kanal: <span className="text-red-400">{slug}</span>
        <div className="mt-3 flex gap-2 flex-wrap">
          {KANALLAR.map((r) => (
            <Link key={r} href={`/kanal/${slugOf(r)}`} className="mono text-xs px-3 py-1.5 rounded border border-line hover:border-neon hover:text-neon">
              {kanalAdi(r)}
            </Link>
          ))}
        </div>
      </div>
    );
  }

  const veri = d?.veri, T = d?.toplam;

  const csvRows = sorted.map((s) => ({
    urun: s.sku_name, barkod: s.barkod ?? "", psf: s.psf ?? "",
    bu_hafta: s.qty, gecen_hafta: s.prevQty, degisim_yuzde: s.degisim == null ? "" : Math.round(s.degisim),
    hiz: s.hiz, stok: s.stock, kapsam_hafta: s.kapsam ?? "",
    brut_psf: s.brut == null ? "" : Math.round(s.brut), net: s.net == null ? "" : Math.round(s.net),
    karar: rotalar.get(s.sku_name)?.action ?? "",
  }));

  const SAYISAL: [string, string][] = [
    ["PSF", "psf"], ["Bu hafta", "qty"], ["Geçen hf", "prevQty"], ["Δ%", "degisim"],
    [`Hız ${veri?.hizPencere ?? 4}hf`, "hiz"], ["Stok", "stock"], ["Kapsam", "kapsam"],
    ["Brüt PSF", "brut"], ["Net", "net"],
  ];

  return (
    <div className="space-y-4">
      {/* ── Kanal şeridi: firmalar arası tek tık geçiş ── */}
      <div className="flex items-center gap-2 flex-wrap">
        {KANALLAR.map((r) => {
          const aktif = r === retailer;
          return (
            <Link key={r} href={`/kanal/${slugOf(r)}`}
              className={`mono text-xs px-3 py-1.5 rounded-lg border hover:transition-colors ${aktif ? "" : "text-txt-dim border-line hover:text-neon hover:border-neon/50"}`}
              style={aktif ? { borderColor: colorOf(r), background: `${colorOf(r)}18`, color: colorOf(r) } : undefined}>
              {kanalAdi(r)}
            </Link>
          );
        })}
      </div>

      {err && <div className="card p-4 border-red-500/40 text-red-400 mono text-sm">Veri alınamadı: {err}</div>}
      {!d && !err && <div className="card card-flat p-10 text-center mono text-txt-dim">Yükleniyor…</div>}
      {/* UÇ BOŞ DÖNERSE SESSİZ KALMA. `veri: null` geldiğinde ne yükleniyor, ne
          hata, ne açıklama basılıyordu; ekranda yalnız kanal çipleri kalıyordu. */}
      {d && !veri && !err && (
        <div className="card p-10 text-center mono text-sm text-txt-dim">
          Bu kanal için kayıt bulunamadı — veri hiç yüklenmemiş ya da özet görünümü
          yenilenmemiş olabilir.{" "}
          <a href="/upload" className="neon-text rounded focus:outline-none focus-visible:ring-1 focus-visible:ring-neon">
            Yükleme sayfası →
          </a>
        </div>
      )}

      {d && veri && T && (
        <>
          {/* ── Başlık + veri yaşı ── */}
          <div className="card p-4 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-2">
            <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 min-w-0">
              <h1 className="text-lg font-bold" style={{ color: colorOf(retailer) }}>{kanalAdi(retailer)}</h1>
              <span className="mono text-xs text-txt-dim">
                {/* Sayfadaki HER rakamın dayandığı hafta. Takvim haftasıysa
                    "güncel hafta" yazar — tarihi ayrıca basmak gereksiz, zaten
                    gecikme rozeti yokken tarih tek başına haber değil. Geride
                    kalan kanalda gerçek tarih kalır ("03 Ağu 2026 haftası").
                    Önceki hafta HER ZAMAN tarihiyle: o kıyasın karşı ucu. */}
                {veri.dataWeek === veri.takvimHaftasi ? "güncel hafta" : `${fmtDate(veri.dataWeek)} haftası`}
                {veri.prevWeek ? ` · önceki ${fmtDate(veri.prevWeek)}` : ""}
              </span>
              {veri.gecikmeHf > 0 && (
                <span className="mono text-[11px] px-2 py-0.5 rounded" style={{ color: "#f8b00b", border: "1px solid #f8b00b40" }}>
                  {veri.gecikmeHf} HF ESKİ VERİ · takvim {fmtDate(veri.takvimHaftasi)}
                </span>
              )}
              <span className="mono text-[11px] text-txt-dim">{haftalar.length} hafta geçmiş</span>
            </div>
            <div className="flex items-center gap-2">
              <button type="button" onClick={() => setHaftalarAcik((v) => !v)}
                className={`mono text-xs px-3 py-2 rounded-lg border hover:transition-colors ${haftalarAcik ? "border-neon text-neon" : "border-line text-txt-dim hover:border-neon hover:text-neon"}`}>
                {haftalarAcik ? "◀ haftaları kapat" : `▶ haftaları aç (${haftalar.length})`}
              </button>
              <CsvBtn filename={`${slugOf(retailer)}-${veri.dataWeek}.csv`} rows={csvRows}
                cols={[
                  { key: "urun", label: "Ürün" }, { key: "barkod", label: "Barkod" }, { key: "psf", label: "PSF" },
                  { key: "bu_hafta", label: "Bu hafta" }, { key: "gecen_hafta", label: "Geçen hafta" },
                  { key: "degisim_yuzde", label: "Değişim %" }, { key: "hiz", label: `Hız (${veri.hizPencere} hf)` },
                  { key: "stok", label: "Stok" }, { key: "kapsam_hafta", label: "Kapsam (hf)" },
                  { key: "brut_psf", label: "Brüt PSF" }, { key: "net", label: "Net" }, { key: "karar", label: "Karar" },
                ]} />
            </div>
          </div>

          {/* ── Özet şerit (HER ZAMAN firmanın tamamı — filtreden etkilenmez) ── */}
          <div className="grid grid-cols-2 md:grid-cols-6 gap-2">
            {[
              { l: "KALEM", v: fmtInt(T.buHafta), s: `${T.satan} satan · ${T.olu} ölü${T.kalem > T.buHafta ? ` · +${T.kalem - T.buHafta} eski` : ""}` },
              { l: "BU HAFTA ADET", v: fmtInt(T.qty), s: `geçen ${fmtInt(T.prevQty)}` },
              { l: "BRÜT PSF", v: fmtMoney(T.brut), s: "raf fiyatı" },
              { l: "NET KARŞILIK", v: fmtMoney(T.net), s: `×${veri.netCarpan}` },
              { l: "RAFTA STOK", v: fmtInt(T.stock), s: fmtMoney(T.stokBrut) + " PSF" },
              { l: "PSF YOK", v: fmtInt(T.psfYok), s: T.psfYok ? "ciro üretilemez" : "tamam" },
            ].map((k) => (
              <div key={k.l} className="card card-flat p-3">
                <div className="mono text-[10px] text-txt-dim tracking-wider">{k.l}</div>
                <div className="mono text-base tabular-nums mt-0.5">{k.v}</div>
                <div className="mono text-[10px] text-txt-dim truncate">{k.s}</div>
              </div>
            ))}
          </div>

          {/* ── Filtre + arama ── */}
          <div className="card p-3 flex flex-wrap items-center gap-3">
            <SegTabs<Filtre> active={filtre} onChange={setFiltre}
              tabs={[
                { id: "hepsi", label: `Hepsi (${T.kalem})` },
                { id: "satan", label: `Satan (${T.satan})` },
                { id: "stoklu", label: `Stoklu (${T.stoklu})` },
                { id: "olu", label: `Ölü (${T.olu})` },
              ]} />
            <SearchBox value={q} onChange={setQ} placeholder="Ürün adı veya barkod…" className="flex-1 min-w-[220px]" />
            <span className="mono text-xs text-txt-dim whitespace-nowrap">{sorted.length} satır</span>
          </div>

          {/* ── TABLO ── */}
          <div className="card p-0 overflow-hidden">
            <div className="overflow-auto max-h-[calc(100vh-140px)]">
              <table className="w-full text-sm border-separate border-spacing-0" {...bekleme(!rotaGeldi)}>
                <thead>
                  <tr>
                    <th className={`text-left sticky top-0 left-0 z-30 ${THBG}`}>#</th>
                    <th className={`sticky top-0 ${SOL2} z-30 ${THBG}`}>
                      <SortLabel label="Ürün" k="sku_name" sortKey={sortKey} dir={dir} onClick={toggle} />
                    </th>
                    <th className={`text-left sticky top-0 z-20 ${THBG}`}>Barkod</th>
                    {SAYISAL.map(([lab, k]) => (
                      <th key={k} className={`text-right sticky top-0 z-20 ${THBG}`}>
                        <SortLabel label={lab} k={k} sortKey={sortKey} dir={dir} onClick={toggle} align="right" />
                      </th>
                    ))}
                    <th className={`text-left sticky top-0 z-20 ${THBG}`}><span className="cx-soluk-alt">Karar</span></th>
                    {haftalarAcik && haftaKolon.map((w) => (
                      <th key={w} className={`text-right whitespace-nowrap text-[10px] sticky top-0 z-20 ${THBG}`}>
                        <div>{fmtDate(w)}</div>
                        <div className="text-[9px] opacity-70 normal-case">satış / stok</div>
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {sorted.map((s, i) => {
                    const rota = rotalar.get(s.sku_name);
                    const up = s.degisim != null && s.degisim >= 0;
                    return (
                      <tr key={s.sku_name}
                        onClick={() => setAcikSku(s.sku_name)}
                        className={`cursor-pointer ${s.kapali ? "opacity-50" : ""} ${acikSku === s.sku_name ? "bg-neon/5" : "cx-iz"}`}
                        title="Detay için tıkla">
                        <td className={`mono text-txt-dim text-[11px] sticky left-0 z-10 ${TDBG}`}>{i + 1}</td>
                        <td className={`max-w-[360px] truncate sticky ${SOL2} z-10 ${TDBG}`} title={s.sku_name}>
                          {s.sku_name}
                          {s.kapali && <span className="mono text-[10px] ml-2" style={{ color: "#ff5555" }}>KAPALI</span>}
                        </td>
                        <td className="mono text-[11px] text-txt-dim">{s.barkod ?? "—"}</td>
                        <td className="mono text-right tabular-nums">
                          {s.psf == null ? <span className="text-txt-dim">—</span> : fmtInt(Math.round(s.psf))}
                          {s.psf != null && s.psfKaynak !== "rapor" && (
                            <span title={s.psfKaynak === "ciro" ? "Birim fiyat cirodan türetildi" : "Barkodlu fiyat listesinden"}
                              className="mono text-[10px] ml-1" style={{ color: "#f8b00b" }}>~</span>
                          )}
                        </td>
                        <td className="mono text-right tabular-nums font-bold">{fmtInt(s.qty)}</td>
                        <td className="mono text-right tabular-nums text-txt-dim">{fmtInt(s.prevQty)}</td>
                        <td className="mono text-right tabular-nums text-[11px]"
                          style={{ color: s.degisim == null ? "#7d927d" : up ? "#1FF80B" : "#ff5555" }}>
                          {s.degisim == null ? "—" : `${up ? "+" : ""}${Math.round(s.degisim)}%`}
                        </td>
                        <td className="mono text-right tabular-nums text-txt-dim">{fmt1(s.hiz)}</td>
                        <td className="mono text-right tabular-nums">{fmtInt(s.stock)}</td>
                        {/* KAPSAM RENGİ /stok ile aynı dil: <2 hf kritik (raf boşalıyor),
                            >26 hf fazla (para bağlı), arası sağlıklı. */}
                        <td className="mono text-right tabular-nums text-[11px]"
                          style={{ color: s.kapsam == null ? undefined : s.kapsam < 2 ? "#ff5555" : s.kapsam > 26 ? "#f8b00b" : "#1FF80B" }}>
                          {s.kapsam == null ? <span className="text-txt-dim">—</span> : `${fmt1(s.kapsam)} hf`}
                        </td>
                        <td className="mono text-right tabular-nums">{s.brut == null ? "—" : fmtMoney(s.brut)}</td>
                        <td className="mono text-right tabular-nums" style={{ color: "#1FF80B" }}>{s.net == null ? "—" : fmtMoney(s.net)}</td>
                        <td className="whitespace-nowrap">
                          {rota ? (
                            <span className="mono text-[10px] px-1.5 py-0.5 rounded"
                              title={[rota.reason, rota.dest ? `→ ${kanalAdi(rota.dest.retailer)}` : null].filter(Boolean).join(" · ")}
                              style={{ color: KARAR_RENK[rota.action] ?? "#7d927d", border: `1px solid ${KARAR_RENK[rota.action] ?? "#7d927d"}40` }}>
                              {KARAR_AD[rota.action] ?? rota.action}
                            </span>
                          ) : <span className="mono text-[10px] text-txt-dim cx-soluk-alt">—</span>}
                        </td>
                        {haftalarAcik && haftaKolon.map((w) => {
                          const k = s.seri[w];
                          // İKİ SATIR: üstte SATIŞ, altta STOK. Yan yana yazmak kolonu
                          // iki katına çıkarıyordu; alt alta yazınca 41 hafta aynı
                          // genişlikte kalıyor ve göz tek sütunda ikisini de okuyor.
                          return (
                            <td key={w} className="text-right whitespace-nowrap align-top"
                              title={k ? `${fmtDate(w)} · ${k.qty} adet satış · ${k.stock} adet stok` : `${fmtDate(w)} · katalogda yok`}>
                              {k ? (
                                <>
                                  <div className="mono tabular-nums text-[11px]">
                                    {k.qty === 0 ? <span className="text-txt-dim">0</span> : fmtInt(k.qty)}
                                  </div>
                                  <div className="mono tabular-nums text-[10px] text-txt-dim">{fmtInt(k.stock)}</div>
                                </>
                              ) : <span className="mono text-[11px] text-txt-dim">·</span>}
                            </td>
                          );
                        })}
                      </tr>
                    );
                  })}
                </tbody>
                {/* ALT TOPLAM — GÖRÜNEN satırların toplamı; filtre ve arama uygulanınca
                    değişir. Üstteki özet kartları her zaman firmanın tamamını gösterir,
                    bu satır ise ekranda ne varsa onu. İkisi bilerek farklı. */}
                <tfoot>
                  <tr>
                    <td className={`sticky left-0 bottom-0 z-20 ${TFBG}`} />
                    <td className={`mono text-[11px] sticky ${SOL2} bottom-0 z-20 ${TFBG}`}>GÖRÜNEN {sorted.length} SATIR</td>
                    <td className={`sticky bottom-0 z-10 ${TFBG}`} />
                    <td className={`sticky bottom-0 z-10 ${TFBG}`} />
                    <td className={`mono text-right tabular-nums font-bold sticky bottom-0 z-10 ${TFBG}`}>{fmtInt(gorunen.qty)}</td>
                    <td className={`mono text-right tabular-nums text-txt-dim sticky bottom-0 z-10 ${TFBG}`}>{fmtInt(gorunen.prevQty)}</td>
                    <td className={`mono text-right tabular-nums text-[11px] sticky bottom-0 z-10 ${TFBG}`}
                      style={{ color: gorunen.degisim == null ? "#7d927d" : gorunen.degisim >= 0 ? "#1FF80B" : "#ff5555" }}>
                      {gorunen.degisim == null ? "—" : `${gorunen.degisim >= 0 ? "+" : ""}${Math.round(gorunen.degisim)}%`}
                    </td>
                    <td className={`sticky bottom-0 z-10 ${TFBG}`} />
                    <td className={`mono text-right tabular-nums sticky bottom-0 z-10 ${TFBG}`}>{fmtInt(gorunen.stock)}</td>
                    <td className={`sticky bottom-0 z-10 ${TFBG}`} />
                    <td className={`mono text-right tabular-nums font-bold sticky bottom-0 z-10 ${TFBG}`}>{fmtMoney(gorunen.brut)}</td>
                    <td className={`mono text-right tabular-nums font-bold sticky bottom-0 z-10 ${TFBG}`} style={{ color: "#1FF80B" }}>{fmtMoney(gorunen.net)}</td>
                    <td className={`sticky bottom-0 z-10 ${TFBG}`} />
                    {haftalarAcik && haftaKolon.map((w) => (
                      <td key={w} className={`text-right whitespace-nowrap align-top sticky bottom-0 z-10 ${TFBG}`}>
                        <div className="mono tabular-nums text-[11px]">{fmtInt(sorted.reduce((a, s) => a + (s.seri[w]?.qty ?? 0), 0))}</div>
                        <div className="mono tabular-nums text-[10px] text-txt-dim">{fmtInt(sorted.reduce((a, s) => a + (s.seri[w]?.stock ?? 0), 0))}</div>
                      </td>
                    ))}
                  </tr>
                </tfoot>
              </table>
            </div>
          </div>

          <p className="mono text-[10px] text-txt-dim">
            Hız = son {veri.hizPencere} raporlanan haftanın ortalaması; payda ürünün rafta olduğu hafta sayısıdır.
            Kapsam = stok ÷ hız; 2 haftanın altı kırmızı (raf boşalıyor), 26 haftanın üstü sarı (para bağlı).
            Brüt PSF firmanın raf fiyatı; net = brüt × {veri.netCarpan} (kanal marjı ve KDV düşülmüş).
            PSF yanındaki ~ işareti fiyatın rapordan değil cirodan ya da fiyat listesinden türetildiğini gösterir.
            Satıra tıklayınca o ürünün haftalık grafiği, motorun tam gerekçesi ve diğer firmalardaki durumu açılır.
            Hafta kolonlarında üstteki sayı SATIŞ, alttaki STOK; nokta (·) o hafta ürünün katalogda olmadığını,
            0 ise raftaydı ama satmadığını gösterir. Alt satır ekranda görünen satırların toplamıdır.
          </p>
          {/* ── DETAY PANELİ ── */}
          <KanalDetay
            retailer={retailer}
            sku={acikSku ? (d.skus.find((x) => x.sku_name === acikSku) ?? null) : null}
            haftalar={haftalar}
            rota={acikSku ? rotalar.get(acikSku) : undefined}
            netCarpan={veri.netCarpan}
            onClose={() => setAcikSku(null)}
            rotaBekliyor={!rotaGeldi}
          />
        </>
      )}
    </div>
  );
}
